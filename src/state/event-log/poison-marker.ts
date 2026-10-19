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
 * U22 fix round (marker lifetime is bound to the file INSTANCE): the reset
 * policy above only catches markers whose line/offset ran past the file's
 * CURRENT shape. Two rewriters create a file with the SAME path but NEW
 * content — rotation (rename → fresh file at the same path) and compaction
 * (atomicWriteFile rewrite) — and a marker whose lineIndex/byteOffset stays
 * below the new file's size would otherwise RESURRECT and silently skip a
 * healthy line once the file regrew past the old offsets. Fixed at every
 * layer, defense-in-depth:
 *   1. rotateEventLogUnlocked renames the sidecar ALONGSIDE the archive
 *      (`<eventsPath>.poison.jsonl` → `<archive>.poison.jsonl`) so markers
 *      travel with the exact bytes they describe; the fresh live file starts
 *      clean (event-log-rotation.ts).
 *   2. applyCompactionUnlocked DELETES the sidecar — the compacted file is
 *      new content; every old marker is meaningless (event-log-rotation.ts).
 *   3. The read paths RE-PARSE a marker-hit line before honoring the skip
 *      (parseJsonlWindow / readJsonlSince — the bytes are already in the
 *      buffer, zero extra IO): a marker whose line now PARSES is stale, the
 *      event is DELIVERED, and the offset is passed to commitPoisonFindings
 *      (staleMarkerOffsets) for immediate pruning. This self-heals any marker
 *      that still slips through (including a same-uid attacker planting a
 *      bogus marker) — no generation bookkeeping needed, so no `generation`
 *      field was added to the entry shape (design decision: the 1+2+4 layers
 *      already pin the marker lifetime to the file instance; a `.gen` bind
 *      would couple the sidecar to rotation internals for no extra coverage).
 *   4. sweepOldArchives also removes `<archive>.poison.jsonl` with its archive
 *      (same retention) so archived sidecars cannot accumulate forever.
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
import { bumpGenerationUnlocked } from "./event-log-rotation.ts";

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
 * the reset policy). `staleMarkerOffsets` (U22 fix round re-parse guard) are
 * marker-hit offsets whose line RE-PARSED successfully during this read —
 * those entries are pruned from the sidecar immediately (the marker no longer
 * describes reality), which also rewrites the sidecar when nothing else did.
 * Returns `true` when the active-marker count exceeded POISON_MARKER_CAP — the
 * caller MUST then treat the file as unparseable and return an empty/safe
 * result. The quarantine itself happens here (rename to `<name>.corrupt-<ts>`;
 * the file is preserved for diagnosis).
 */
export function commitPoisonFindings(
	eventsPath: string,
	fileSize: number,
	lineCount: number | undefined,
	failures: readonly PoisonFailure[],
	staleMarkerOffsets?: readonly number[],
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
	// U22 fix round: drop re-parse-recovered markers (their line parsed OK —
	// the byte offset no longer names poison) alongside the shape-stale ones.
	// Write gate: fresh failures (legacy) OR healed markers (new) trigger the
	// sidecar rewrite — a read with NEITHER keeps the sidecar untouched, so
	// shape-stale entries still prune lazily on the next marker write exactly
	// as before (pinned by the marker-reset regression test).
	let kept = active;
	if (staleMarkerOffsets !== undefined && staleMarkerOffsets.length > 0) {
		const healed = new Set(staleMarkerOffsets);
		kept = active.filter((entry) => !healed.has(entry.byteOffset));
	}
	if (fresh.length === 0 && (staleMarkerOffsets?.length ?? 0) === 0) return false;
	const firstSeen = new Date().toISOString();
	const newEntries: PoisonMarkerEntry[] = fresh.map((failure) => ({
		lineIndex: failure.lineIndex,
		byteOffset: failure.byteOffset,
		reason: failure.reason,
		firstSeen,
	}));
	persistPoisonMarkers(sidecar, existing, kept, newEntries);
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
 *  the sidecar so a future log at the same path starts clean. Best-effort.
 *  EP4/FS10 residual (wave-6 M4-R2): the rename is a file-instance change at
 *  the SAME path, so bump the generation sidecar (shared helper from M2-4 /
 *  event-log-rotation) — a byte-offset cursor holding the old generation then
 *  detects the change and resets instead of resuming past the (now absent)
 *  file's old offsets. */
function quarantinePoisonedEventsFile(eventsPath: string): void {
	const quarantinePath = `${eventsPath}.corrupt-${Date.now()}`;
	try {
		fs.renameSync(eventsPath, quarantinePath);
	} catch (error) {
		console.error(`[poison-marker] quarantine rename failed for ${eventsPath} (file left in place):`, error);
		return;
	}
	try {
		// EP4/FS10: bump .gen AFTER a successful rename so readers see the new
		// file instance. Upstream imported-by-us module (event-log-rotation)
		// already imports poisonMarkerPath from here — a cycle, but both sides
		// are hoisted function declarations, so the binding is live at call time.
		bumpGenerationUnlocked(eventsPath);
	} catch {
		/* best-effort: a failed gen bump must not fail the quarantine */
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
