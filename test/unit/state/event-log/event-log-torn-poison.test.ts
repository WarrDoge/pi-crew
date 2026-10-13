/**
 * U22 Phase 1: torn/poison/rotation handling for events.jsonl read paths.
 *
 * Unified classification (parseJsonlEvents AND readJsonlTail/readJsonlSince —
 * the full-read, wide-tail, cached-watermark and byte-offset paths must agree):
 * - TORN tail  = last line lacks "\n" (crash cut) → recoverable: skipped this
 *   read, tornTail=true in metadata, NEVER marked.
 * - POISON line = complete line whose JSON.parse fails → sticky: recorded in
 *   the `<eventsPath>.poison.jsonl` sidecar ({lineIndex, byteOffset, reason,
 *   firstSeen}); later reads skip the line by byte offset WITHOUT re-parsing.
 * - Reset policy: markers whose lineIndex >= current line count (rotate/
 *   truncate) are ignored and pruned on the next marker write.
 * - Cap 1000 active markers → the file is quarantined (rename
 *   `<name>.corrupt-<ts>`, quarantineCorruptFile pattern) and reads return an
 *   empty/safe value without throwing (last resort).
 * - Rotation tail-drain: a byte-offset cursor that finds the live file SHORTER
 *   than its offset drains the archive TAILS first, then re-reads the live
 *   file from 0 — no event skipped or duplicated between archive-tail and
 *   live-head (seq dedupe).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	clearEventsCursorTailCache,
	readEventsCursor,
	readEventsWithIntegrity,
	type TeamEvent,
} from "../../../../src/state/event-log/event-log.ts";
import { generationPath } from "../../../../src/state/event-log/event-log-rotation.ts";
import { loadPoisonMarkers, poisonMarkerPath } from "../../../../src/state/event-log/poison-marker.ts";

const POISON_LINE = '{"this is not valid json"\n';

function eventLine(seq: number, message = "m"): string {
	return `${JSON.stringify({
		time: "2026-10-13T00:00:00.000Z",
		type: "task.progress",
		runId: "r1",
		taskId: `t${seq}`,
		message,
		metadata: { seq, provenance: "test" },
	})}\n`;
}

/** Torn fragment: a valid JSON prefix cut mid-line (no trailing newline). */
const TORN_FRAGMENT = '{"time":"2026-10-13T00:00:00.000Z","type":"task.progress","runId":"r1","taskId":"t4","mess';

function seqs(events: TeamEvent[]): number[] {
	return events.map((event) => event.metadata?.seq ?? -1);
}

function tmpDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	// The watermark cache is module-global and keyed by path; unique tmpdirs
	// already isolate tests, but clear anyway so path reuse cannot leak state.
	clearEventsCursorTailCache();
	return dir;
}

// --- AC 1: torn tail is recoverable and never marked -------------------------

test("torn tail: lines before the cut parse, tornTail=true, no marker written", () => {
	const dir = tmpDir("pi-crew-torn-");
	try {
		const eventsPath = path.join(dir, "events.jsonl");
		fs.writeFileSync(eventsPath, `${eventLine(1)}${eventLine(2)}${TORN_FRAGMENT}`, "utf-8");

		const { events, integrity } = readEventsWithIntegrity(eventsPath);
		assert.deepEqual(seqs(events), [1, 2], "events before the cut must parse");
		assert.equal(integrity.tornTail, true, "torn tail must be reported");
		assert.equal(integrity.parseFailures, 0, "the torn fragment is not poison — no parse failure");
		assert.equal(integrity.poisonSkipped, 0);
		assert.equal(integrity.quarantined, false);
		assert.equal(fs.existsSync(poisonMarkerPath(eventsPath)), false, "torn tails are NEVER marked");

		// Recovery: the next append completes the line — it parses, tornTail clears.
		fs.appendFileSync(eventsPath, 'age":"done","metadata":{"seq":4,"provenance":"test"}}\n', "utf-8");
		const recovered = readEventsWithIntegrity(eventsPath);
		assert.deepEqual(seqs(recovered.events), [1, 2, 4], "completed line must now parse");
		assert.equal(recovered.integrity.tornTail, false, "no torn tail once the line completes");
		assert.equal(fs.existsSync(poisonMarkerPath(eventsPath)), false, "still no marker");

		// The cursor's wide path classifies identically.
		const cursor = readEventsCursor(eventsPath, {});
		assert.deepEqual(seqs(cursor.events), [1, 2, 4]);
		assert.equal(cursor.tornTail, false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// --- AC 2: poison is sticky and surrounding events survive in order ---------

test("poison: mid-file corrupt line is skipped + marked; second read skips via marker without re-parsing", () => {
	const dir = tmpDir("pi-crew-poison-");
	try {
		const eventsPath = path.join(dir, "events.jsonl");
		fs.writeFileSync(eventsPath, `${eventLine(1)}${POISON_LINE}${eventLine(3)}`, "utf-8");
		const poisonByteOffset = Buffer.byteLength(eventLine(1), "utf-8");

		// First read: poison discovered (parse failure) + marker recorded.
		const first = readEventsWithIntegrity(eventsPath);
		assert.deepEqual(seqs(first.events), [1, 3], "valid events around the poison line survive, in seq order");
		assert.equal(first.integrity.tornTail, false);
		assert.equal(first.integrity.parseFailures, 1, "poison line failed JSON.parse once");
		assert.equal(first.integrity.poisonSkipped, 0);
		assert.ok(fs.existsSync(poisonMarkerPath(eventsPath)), "sidecar marker must exist");

		const markers = loadPoisonMarkers(eventsPath);
		assert.equal(markers.length, 1);
		assert.equal(markers[0]?.lineIndex, 1, "poison is complete line #1 (0-based)");
		assert.equal(markers[0]?.byteOffset, poisonByteOffset, "marker stores the line-start byte offset");
		assert.equal(typeof markers[0]?.reason, "string");
		assert.ok((markers[0]?.reason.length ?? 0) > 0, "reason carries the parse error");
		assert.ok(!Number.isNaN(Date.parse(markers[0]?.firstSeen ?? "")), "firstSeen is a parseable timestamp");

		// Second read: the marker skips the line DIRECTLY — no new parse failure,
		// and the same events come back in the same order.
		const second = readEventsWithIntegrity(eventsPath);
		assert.deepEqual(seqs(second.events), [1, 3], "same events, same order");
		assert.equal(second.integrity.parseFailures, 0, "marked line must NOT be re-parsed");
		assert.equal(second.integrity.poisonSkipped, 1, "one line skipped via the marker");
		assert.equal(loadPoisonMarkers(eventsPath).length, 1, "no duplicate marker entries");

		// The last line being corrupt (but newline-TERMINATED) is poison, not torn.
		const eventsPath2 = path.join(dir, "events2.jsonl");
		fs.writeFileSync(eventsPath2, `${eventLine(1)}${POISON_LINE}`, "utf-8");
		const lastLinePoison = readEventsWithIntegrity(eventsPath2);
		assert.deepEqual(seqs(lastLinePoison.events), [1]);
		assert.equal(lastLinePoison.integrity.tornTail, false, "terminated corrupt line is NOT torn");
		assert.equal(lastLinePoison.integrity.parseFailures, 1, "terminated corrupt line IS poison");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// --- AC 3: the two read paths classify the same corrupt file identically ----

test("unified: readEvents and readEventsCursor agree on events AND torn/poison classification", () => {
	const dir = tmpDir("pi-crew-unified-");
	try {
		const eventsPath = path.join(dir, "events.jsonl");
		fs.writeFileSync(eventsPath, `${eventLine(1)}${POISON_LINE}${eventLine(3)}${TORN_FRAGMENT}`, "utf-8");

		// Prime the marker with one readEvents pass, then take steady-state reads.
		readEventsWithIntegrity(eventsPath);

		const full = readEventsWithIntegrity(eventsPath);
		const wide = readEventsCursor(eventsPath, {});
		const cached = readEventsCursor(eventsPath, { sinceSeq: 1, limit: 10 });

		assert.deepEqual(wide.events, full.events, "wide tail path must return the same events as the full parse");
		assert.deepEqual(
			cached.events,
			full.events.filter((event) => (event.metadata?.seq ?? 0) > 1),
			"cached watermark path (sinceSeq+limit) agrees on its slice",
		);
		assert.equal(wide.tornTail, full.integrity.tornTail, "same torn classification");
		assert.equal(cached.tornTail, full.integrity.tornTail);
		assert.equal(wide.poisonSkipped, full.integrity.poisonSkipped, "same poison classification");
		assert.equal(cached.poisonSkipped, full.integrity.poisonSkipped);
		assert.equal(wide.parseFailures, 0, "marker already recorded — no re-parse on either path");
		assert.equal(cached.parseFailures, 0);
		assert.equal(full.integrity.parseFailures, 0);
		assert.deepEqual(seqs(full.events), [1, 3]);
		assert.equal(full.integrity.tornTail, true);
		assert.equal(full.integrity.poisonSkipped, 1);

		// The byte-offset path classifies identically too (read from 0).
		const bytePath = readEventsCursor(eventsPath, { fromByteOffset: 0 });
		assert.deepEqual(bytePath.events, full.events);
		assert.equal(bytePath.tornTail, true);
		assert.equal(bytePath.poisonSkipped, 1);
		assert.equal(bytePath.parseFailures, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// --- AC 4: marker reset policy (rotate/truncate makes markers stale) --------

test("marker reset: file shorter than the marker's lineIndex → marker ignored and pruned on next write", () => {
	const dir = tmpDir("pi-crew-marker-reset-");
	try {
		const eventsPath = path.join(dir, "events.jsonl");
		// 5 SHORT lines; the last complete line (index 4) is poison. The marker's
		// byteOffset stays BELOW the replacement file's size, so only the
		// lineIndex policy can retire it.
		fs.writeFileSync(eventsPath, [eventLine(1), eventLine(2), eventLine(3), eventLine(4), POISON_LINE].join(""), "utf-8");
		const stale = readEventsWithIntegrity(eventsPath);
		assert.equal(stale.integrity.parseFailures, 1);
		const staleMarkers = loadPoisonMarkers(eventsPath);
		assert.equal(staleMarkers.length, 1);
		assert.equal(staleMarkers[0]?.lineIndex, 4);
		const staleByteOffset = staleMarkers[0]?.byteOffset ?? 0;

		// Truncate-and-replace with 2 LONG clean lines: lineCount 2 <= marker
		// lineIndex 4 (stale), but byteOffset < new file size (not byte-stale).
		const longMessage = "x".repeat(300);
		const replacement = eventLine(11, longMessage) + eventLine(12, longMessage);
		assert.ok(
			Buffer.byteLength(replacement, "utf-8") > staleByteOffset,
			"precondition: replacement is byte-longer than the stale offset",
		);
		fs.writeFileSync(eventsPath, replacement, "utf-8");

		const after = readEventsWithIntegrity(eventsPath);
		assert.deepEqual(seqs(after.events), [11, 12], "stale marker must be ignored — both lines parse");
		assert.equal(after.integrity.poisonSkipped, 0);
		assert.equal(after.integrity.parseFailures, 0);
		assert.equal(loadPoisonMarkers(eventsPath).length, 1, "stale marker pruned only on the next marker WRITE");

		// A new poison discovery prunes the stale entry while recording the new one.
		fs.appendFileSync(eventsPath, POISON_LINE, "utf-8");
		const marked = readEventsWithIntegrity(eventsPath);
		assert.equal(marked.integrity.parseFailures, 1);
		const pruned = loadPoisonMarkers(eventsPath);
		assert.equal(pruned.length, 1, "stale entry pruned on write");
		assert.equal(pruned[0]?.lineIndex, 2, "only the NEW poison line is marked");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// --- AC 5: cap 1000 — boundary respected, exceeded files are quarantined ----

test("cap: 1000 markers tolerated; the 1001st poisons the file into quarantine (safe empty, no throw)", () => {
	const dir = tmpDir("pi-crew-poison-cap-");
	try {
		const eventsPath = path.join(dir, "events.jsonl");
		const poisonCount = 1000;
		const content = `${eventLine(1)}${POISON_LINE.repeat(poisonCount)}${eventLine(2)}`;
		fs.writeFileSync(eventsPath, content, "utf-8");

		// Exactly at the cap: file still readable, valid events survive.
		const atCap = readEventsWithIntegrity(eventsPath);
		assert.equal(atCap.integrity.quarantined, false, "1000 active markers is AT the cap, not over it");
		assert.deepEqual(seqs(atCap.events), [1, 2]);
		assert.equal(loadPoisonMarkers(eventsPath).length, poisonCount);

		// One more poison line tips the file over: quarantined + safe empty.
		fs.appendFileSync(eventsPath, POISON_LINE, "utf-8");
		const overCap = readEventsWithIntegrity(eventsPath);
		assert.equal(overCap.integrity.quarantined, true, "1001 active markers → quarantine (last resort)");
		assert.deepEqual(overCap.events, [], "quarantined read returns the safe empty value");
		assert.equal(fs.existsSync(eventsPath), false, "events file renamed away");
		assert.equal(fs.existsSync(poisonMarkerPath(eventsPath)), false, "sidecar removed with the file");
		const quarantined = fs.readdirSync(dir).filter((entry) => entry.startsWith("events.jsonl.corrupt-"));
		assert.equal(quarantined.length, 1, "file preserved as <name>.corrupt-<ts> for diagnosis");

		// Subsequent reads stay safe and never throw.
		const again = readEventsWithIntegrity(eventsPath);
		assert.deepEqual(again.events, []);
		assert.equal(again.integrity.quarantined, false);
		const cursorAgain = readEventsCursor(eventsPath, {});
		assert.deepEqual(cursorAgain.events, []);

		// A fresh log at the same path starts clean (no inherited markers).
		fs.writeFileSync(eventsPath, eventLine(1), "utf-8");
		const fresh = readEventsWithIntegrity(eventsPath);
		assert.deepEqual(seqs(fresh.events), [1]);
		assert.equal(fresh.integrity.poisonSkipped, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// --- AC 6: rotation tail-drain (byte cursor crossing a rotation) -------------

test("rotation drain: stale byte offset drains archive tail then re-reads live head — no skip, no dup", () => {
	const dir = tmpDir("pi-crew-rotation-drain-");
	try {
		const eventsPath = path.join(dir, "events.jsonl");
		// Pre-rotation archive: e8, POISON, e9, e10 (poison in the archive gets
		// the same sticky treatment via its own sidecar).
		const archivePath = path.join(dir, "events.jsonl.1697000000000.archive.jsonl");
		fs.writeFileSync(archivePath, `${eventLine(8)}${POISON_LINE}${eventLine(9)}${eventLine(10)}`, "utf-8");
		// Post-rotation live file: overlaps e10 (rotation boundary duplicate).
		fs.writeFileSync(eventsPath, `${eventLine(10)}${eventLine(11)}${eventLine(12)}`, "utf-8");
		const liveSize = fs.statSync(eventsPath).size;

		// Caller holds a byte offset from the PRE-rotation (much larger) file and
		// never tracked generation: the shrank signal must drain the archive tail
		// BEFORE resetting to 0 — archive seq 8..10 + live 10..12 deduped by seq.
		const shrankRead = readEventsCursor(eventsPath, { fromByteOffset: liveSize + 10_000, sinceSeq: 7 });
		assert.deepEqual(seqs(shrankRead.events), [8, 9, 10, 11, 12], "archive tail drained, live head re-read, e10 not duplicated");
		assert.equal(shrankRead.total, 5);
		assert.equal(shrankRead.nextSeq, 12);
		assert.equal(shrankRead.nextByteOffset, liveSize, "cursor resumes at the new live file's end");
		assert.equal(shrankRead.tornTail, false);
		assert.ok(fs.existsSync(poisonMarkerPath(archivePath)), "archive poison line got its own sticky marker");
		assert.equal(loadPoisonMarkers(archivePath).length, 1);

		// Generation-echo variant (R-03): a mismatched generation drains the same
		// way even when the offset happens to still be within the new file.
		fs.writeFileSync(generationPath(eventsPath), "5", "utf-8");
		const genRead = readEventsCursor(eventsPath, { fromByteOffset: 10, sinceSeq: 7, generation: 4 });
		assert.deepEqual(seqs(genRead.events), [8, 9, 10, 11, 12], "generation mismatch resets + drains identically");
		assert.equal(genRead.generation, 5);
		assert.equal(genRead.nextByteOffset, liveSize);

		// A cursor ALREADY past the rotation (fresh offset, matching generation)
		// reads forward normally without re-delivering the archive.
		const forwardRead = readEventsCursor(eventsPath, { fromByteOffset: 0, sinceSeq: 11, generation: 5 });
		assert.deepEqual(seqs(forwardRead.events), [12]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// --- AC 7: regression — clean files behave exactly like the old parser -------

test("regression: clean file (shuffled seqs, blanks, multi-byte UTF-8) is bit-for-bit the legacy parse", () => {
	const dir = tmpDir("pi-crew-clean-regression-");
	try {
		const eventsPath = path.join(dir, "events.jsonl");
		const message = "tiến trình kiểm thử đa dạng 🎯 — ổn định";
		// Shuffled seq order + blank lines: readEvents must dedupe/sort exactly
		// like before; blank lines are neither events nor poison.
		fs.writeFileSync(
			eventsPath,
			[eventLine(3, message), "\n", eventLine(1, message), "   \n", eventLine(2, message)].join(""),
			"utf-8",
		);
		// Ground truth = the legacy parser's exact semantics on a VALID file:
		// split lines, trim, JSON.parse each non-blank line, then EITHER order —
		// readEvents returns the seq-SORTED view (its historical contract), the
		// cursor default path returns the FILE-order view (its historical
		// contract). Both orders are pinned below.
		const fileOrder = fs
			.readFileSync(eventsPath, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as TeamEvent);
		const groundTruth = [...fileOrder].sort((a, b) => (a.metadata?.seq ?? 0) - (b.metadata?.seq ?? 0));

		const { events, integrity } = readEventsWithIntegrity(eventsPath);
		assert.deepEqual(events, groundTruth, "readEvents output must equal the legacy parse bit-for-bit");
		assert.deepEqual(seqs(events), [1, 2, 3]);
		assert.equal(integrity.tornTail, false);
		assert.equal(integrity.poisonSkipped, 0);
		assert.equal(integrity.parseFailures, 0);
		assert.equal(integrity.quarantined, false);
		assert.equal(fs.existsSync(poisonMarkerPath(eventsPath)), false, "blank/whitespace lines are never poison — no sidecar");

		const cursor = readEventsCursor(eventsPath, {});
		assert.deepEqual(cursor.events, fileOrder, "cursor default path keeps its historical FILE-order semantics on clean files");
		assert.deepEqual(seqs(cursor.events), [3, 1, 2]);
		assert.equal(cursor.tornTail, false);
		assert.equal(cursor.poisonSkipped, 0);

		// Pinned behavior change (intended by U22 Phase 1): a torn tail line that
		// HAPPENS to be valid JSON is held back (torn) instead of parsed — both
		// paths agree. The legacy parser would have returned seq 4 here.
		fs.appendFileSync(eventsPath, eventLine(4).trimEnd(), "utf-8");
		const torn = readEventsWithIntegrity(eventsPath);
		assert.deepEqual(seqs(torn.events), [1, 2, 3], "torn-but-valid tail is held back, not parsed");
		assert.equal(torn.integrity.tornTail, true);
		const tornCursor = readEventsCursor(eventsPath, {});
		assert.deepEqual(seqs(tornCursor.events), [3, 1, 2]);
		assert.equal(tornCursor.tornTail, true);
		assert.equal(fs.existsSync(poisonMarkerPath(eventsPath)), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
