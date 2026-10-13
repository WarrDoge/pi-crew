/**
 * U22 Phase 1: sticky poison-marker sidecar for events JSONL read paths.
 *
 * Classification contract (unified across parseJsonlEvents and readJsonlTail):
 * - TORN line   = the file's LAST line lacks a terminating "\n" (crash cut a
 *   mid-append write). Recoverable: skipped for THIS read only, reported via
 *   `tornTail` metadata, NEVER marked — the next append completes the line and
 *   it parses normally.
 * - POISON line = a COMPLETE line (newline-terminated or mid-file) whose
 *   JSON.parse fails. Sticky: an entry is appended to the sidecar
 *   `<eventsPath>.poison.jsonl` so later reads skip the line by byte offset
 *   WITHOUT re-parsing it (no unbounded re-parse work per poll).
 *
 * Sidecar entry: `{ lineIndex, byteOffset, reason, firstSeen }`.
 * - `byteOffset` (line-start byte offset) is the primary match key — it is
 *   stable because events.jsonl is append-only (rotation renames; it never
 *   rewrites in place).
 * - `lineIndex` (0-based index among complete lines, -1 = unknown, e.g.
 *   discovered by a tail-window read) drives the reset policy.
 *
 * Reset policy: a marker is STALE when the current file has fewer lines than
 * `lineIndex` (rotate/truncate/delete) or when `byteOffset >= fileSize`.
 * Stale markers are ignored on read and pruned the next time new markers are
 * written (the sidecar itself is never rewritten except for that pruning).
 *
 * Cap (last resort): more than POISON_MARKER_CAP active markers means the file
 * is effectively unparseable — the events file is quarantined with the
 * `quarantineCorruptFile` pattern (rename to `<name>.corrupt-<ts>`,
 * src/state/stores/manifest-io.ts:22-28) and reads return an empty/safe value
 * without throwing. The sidecar is removed with the file so a fresh log at the
 * same path does not inherit stale markers.
 *
 * All sidecar writes are best-effort: an IO failure is console.error'd and
 * NEVER propagated to the caller (a marker is an optimization — losing one
 * only means the poison line is re-parsed and fails again, then re-marks).
 */
import * as fs from "node:fs";
import type { JsonlParseFailure } from "../../utils/incremental-reader.ts";

export type PoisonFailure = JsonlParseFailure;

export interface PoisonMarkerEntry {
	/** 0-based index among the file's complete lines; -1 = unknown (tail read). */
	lineIndex: number;
	/** Byte offset of the line's first byte — the stable append-only match key. */
	byteOffset: number;
	/** JSON.parse failure message. */
	reason: string;
	/** ISO timestamp of first discovery. */
	firstSeen: string;
}

/** More active markers than this → the whole file is quarantined (last resort). */
export const POISON_MARKER_CAP = 1000;

/** Sidecar path for an events (or archive) JSONL file. */
export function poisonMarkerPath(eventsPath: string): string {
	return `${eventsPath}.poison.jsonl`;
}

/** Parse the sidecar; malformed entries are skipped, read failure → []. */
export function loadPoisonMarkers(eventsPath: string): PoisonMarkerEntry[] {
	let raw: string;
	try {
		raw = fs.readFileSync(poisonMarkerPath(eventsPath), "utf-8");
	} catch {
		return [];
	}
	const entries: PoisonMarkerEntry[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (parsed === null || typeof parsed !== "object") continue;
			const candidate = parsed as Partial<PoisonMarkerEntry>;
			if (typeof candidate.lineIndex !== "number" || !Number.isInteger(candidate.lineIndex)) continue;
			if (typeof candidate.byteOffset !== "number" || !Number.isInteger(candidate.byteOffset) || candidate.byteOffset < 0) {
				continue;
			}
			if (typeof candidate.reason !== "string" || typeof candidate.firstSeen !== "string") continue;
			entries.push({
				lineIndex: candidate.lineIndex,
				byteOffset: candidate.byteOffset,
				reason: candidate.reason,
				firstSeen: candidate.firstSeen,
			});
		} catch {
			/* skip corrupt marker line — markers are best-effort */
		}
	}
	return entries;
}

/** Reset policy: the marker's line no longer exists in the current file. */
function isStalePoisonMarker(entry: PoisonMarkerEntry, lineCount: number | undefined, fileSize: number): boolean {
	if (entry.lineIndex >= 0 && lineCount !== undefined && entry.lineIndex >= lineCount) return true;
	return entry.byteOffset >= fileSize;
}

export interface PoisonSkipPlan {
	/** Line-start byte offsets to skip WITHOUT re-parsing (active markers). */
	offsets: ReadonlySet<number>;
	/** Active (non-stale) marker count at load time. */
	activeCount: number;
}

const EMPTY_OFFSETS: ReadonlySet<number> = new Set<number>();

/** Consult the sidecar before parsing. Fast path: a missing sidecar (the
 *  overwhelming case — healthy logs never write markers) is one existsSync and
 *  touches no readFileSync, so hot poll paths stay byte-read free. */
export function planPoisonSkip(eventsPath: string, fileSize: number, lineCount: number | undefined): PoisonSkipPlan {
	if (!fs.existsSync(poisonMarkerPath(eventsPath))) {
		return { offsets: EMPTY_OFFSETS, activeCount: 0 };
	}
	const active = loadPoisonMarkers(eventsPath).filter((entry) => !isStalePoisonMarker(entry, lineCount, fileSize));
	const offsets = new Set<number>();
	for (const entry of active) offsets.add(entry.byteOffset);
	return { offsets, activeCount: active.length };
}

/**
 * Record newly discovered poison lines (and prune stale markers on write, per
 * the reset policy). Returns `true` when the active-marker count exceeded
 * POISON_MARKER_CAP — the caller MUST then treat the file as unparseable and
 * return an empty/safe result. The quarantine itself happens here (rename to
 * `<name>.corrupt-<ts>`; the file is preserved for diagnosis).
 */
export function commitPoisonFindings(
	eventsPath: string,
	fileSize: number,
	lineCount: number | undefined,
	failures: readonly PoisonFailure[],
): boolean {
	const sidecar = poisonMarkerPath(eventsPath);
	const existing = fs.existsSync(sidecar) ? loadPoisonMarkers(eventsPath) : [];
	const active = existing.filter((entry) => !isStalePoisonMarker(entry, lineCount, fileSize));
	if (active.length > POISON_MARKER_CAP) {
		quarantinePoisonedEventsFile(eventsPath);
		return true;
	}
	const activeOffsets = new Set<number>();
	for (const entry of active) activeOffsets.add(entry.byteOffset);
	const fresh: PoisonFailure[] = [];
	const seenOffsets = new Set<number>();
	for (const failure of failures) {
		if (activeOffsets.has(failure.byteOffset) || seenOffsets.has(failure.byteOffset)) continue;
		seenOffsets.add(failure.byteOffset);
		fresh.push(failure);
	}
	if (active.length + fresh.length > POISON_MARKER_CAP) {
		quarantinePoisonedEventsFile(eventsPath);
		return true;
	}
	if (fresh.length === 0) return false;
	const firstSeen = new Date().toISOString();
	const newEntries: PoisonMarkerEntry[] = fresh.map((failure) => ({
		lineIndex: failure.lineIndex,
		byteOffset: failure.byteOffset,
		reason: failure.reason,
		firstSeen,
	}));
	persistPoisonMarkers(sidecar, existing, active, newEntries);
	return false;
}

/** Best-effort write: plain fs append when nothing is stale (the common case),
 *  full rewrite only when the reset policy pruned stale entries. IO errors are
 *  logged and swallowed — marker writes must never fail the reader. */
function persistPoisonMarkers(
	sidecar: string,
	existing: readonly PoisonMarkerEntry[],
	active: readonly PoisonMarkerEntry[],
	newEntries: readonly PoisonMarkerEntry[],
): void {
	try {
		if (active.length === existing.length) {
			fs.appendFileSync(sidecar, `${newEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
		} else {
			const kept = [...active, ...newEntries];
			fs.writeFileSync(sidecar, kept.length > 0 ? `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "", "utf-8");
		}
	} catch (error) {
		console.error(`[poison-marker] best-effort sidecar write failed for ${sidecar} (reader unaffected):`, error);
	}
}

/** Last resort — quarantineCorruptFile pattern (manifest-io.ts:22-28): rename
 *  the events file to `<name>.corrupt-<ts>` (preserved for debugging) and drop
 *  the sidecar so a future log at the same path starts clean. Best-effort. */
function quarantinePoisonedEventsFile(eventsPath: string): void {
	const quarantinePath = `${eventsPath}.corrupt-${Date.now()}`;
	try {
		fs.renameSync(eventsPath, quarantinePath);
	} catch (error) {
		console.error(`[poison-marker] quarantine rename failed for ${eventsPath} (file left in place):`, error);
		return;
	}
	try {
		fs.rmSync(poisonMarkerPath(eventsPath), { force: true });
	} catch {
		/* best-effort */
	}
	console.error(
		`[poison-marker] active poison markers exceeded ${POISON_MARKER_CAP} — events file quarantined to ${quarantinePath} (last resort; reads return empty until a new log is written)`,
	);
}
