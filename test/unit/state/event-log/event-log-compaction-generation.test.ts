/**
 * EP4 (R32-M1 ≡ R4-N1/FS10) regression pin: event-log COMPACTION must bump the
 * `.gen` generation sidecar, exactly like rotation does.
 *
 * Without the fix, `applyCompactionUnlocked` rewrites the live log
 * (atomicWriteFile → temp+rename → NEW inode, prefix dropped) but leaves the
 * generation unchanged. A byte-offset cursor reader that echoes the
 * pre-compaction `generation` (readEventsCursor's cache-key, cursor.ts:765)
 * therefore still matches the live sidecar, resumes from its OLD byte offset —
 * which now points into the MIDDLE of the rewritten file — and silently skips
 * the kept-window head it never delivered (the reviewer repro: 999/1000 events
 * lost, no signal). The `shrank` fallback does not cover this case: it only
 * fires when the file is SHORTER than the caller's offset.
 *
 * Pins:
 *  1. compaction → `.gen` +1 (and +1 again on the next compaction);
 *  2. a stale generation echo makes the reader re-read from offset 0 and
 *     deliver the kept-window head (no silent skip);
 *  3. the bumped generation is stable between reads (one bump per rewrite —
 *     the very next incremental read does NOT reset again);
 *  4. no-op compaction (originalCount <= compactToCount) leaves the generation
 *     stable (regression: append-only / no-compaction path unchanged).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readEventsCursor } from "../../../../src/state/event-log/event-log.ts";
import { compactEventLog, currentGeneration, generationPath } from "../../../../src/state/event-log/event-log-rotation.ts";
import { cleanupStateRoot } from "../../../helpers/rm-retry.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-compact-gen-"));
}

/** One event line — identical byte length for every seq (keeps offset math exact). */
function eventLine(seq: number): string {
	return `${JSON.stringify({
		time: new Date(Date.parse("2025-01-01T00:00:00.000Z") + seq * 1000).toISOString(),
		type: "tick",
		runId: "r1",
		taskId: `t${seq}`,
		metadata: { seq, provenance: "test" },
	})}\n`;
}

/** Append `count` events with sequential seq numbers starting at `fromSeq`. */
function appendEvents(filePath: string, fromSeq: number, count: number): void {
	let lines = "";
	for (let i = 0; i < count; i++) lines += eventLine(fromSeq + i);
	fs.appendFileSync(filePath, lines, "utf-8");
}

/** Insert exactly `count` seqs so the caller can assert an exact delivered set. */
function seqsOf(events: readonly { metadata?: { seq?: number } }[]): number[] {
	return events.map((event) => event.metadata?.seq ?? -1);
}

describe("EP4 compaction generation bump", () => {
	it("bumps the .gen sidecar on every compaction that truncates events", async () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		try {
			appendEvents(filePath, 1, 5);
			assert.equal(currentGeneration(filePath), 0, "no sidecar before any compaction");

			const first = compactEventLog(filePath, { compactToCount: 2 });
			assert.ok(first, "compaction ran (5 events > compactToCount 2)");
			assert.equal(first.eventsRemoved, 3, "3 events truncated away");
			assert.equal(currentGeneration(filePath), 1, "compaction bumps the generation");
			assert.ok(fs.existsSync(generationPath(filePath)), "compaction creates the .gen sidecar");

			// A second truncating compaction bumps again (monotonic).
			appendEvents(filePath, 6, 3);
			const second = compactEventLog(filePath, { compactToCount: 2 });
			assert.ok(second, "second compaction ran (5 events > 2)");
			assert.equal(currentGeneration(filePath), 2, "second compaction bumps again");
		} finally {
			await cleanupStateRoot(dir, filePath);
		}
	});

	it("stale generation echo re-reads from 0 — kept-window head is never silently skipped", async () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		try {
			appendEvents(filePath, 1, 5);
			const lineBytes = Buffer.byteLength(eventLine(1), "utf-8");

			// Client pages the pre-compaction file and captures a mid-file anchor.
			const before = readEventsCursor(filePath, { fromByteOffset: 0, sinceSeq: 0 });
			assert.equal(before.events.length, 5);
			assert.equal(before.generation, 0, "generation 0 before any rewrite");
			assert.equal(before.nextByteOffset, 5 * lineBytes, "anchor at end of the 5-event file");

			// Compact to the last 2 events (seq 4,5): the live file is rewritten.
			const result = compactEventLog(filePath, { compactToCount: 2 });
			assert.ok(result, "compaction ran");
			assert.equal(currentGeneration(filePath), 1, "compaction bumped the generation");

			// The client resumes from an offset that is now INSIDE the rewritten
			// file (one line in) while echoing the PRE-compaction generation.
			// Without the bump, the stale echo matches the live sidecar → the
			// reader reads from `lineBytes` and never delivers seq 4.
			const stale = readEventsCursor(filePath, {
				fromByteOffset: lineBytes,
				sinceSeq: 0,
				generation: before.generation,
			});
			assert.equal(stale.generation, 1, "reader observes the post-compaction generation");
			assert.deepEqual(seqsOf(stale.events), [4, 5], "kept-window head (seq 4) is NOT skipped — full fresh re-read");
			assert.equal(stale.nextByteOffset, fs.statSync(filePath).size, "cursor advanced to end of the rewritten file");
		} finally {
			await cleanupStateRoot(dir, filePath);
		}
	});

	it("bumps once per rewrite — the next incremental read does not reset again", async () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		try {
			appendEvents(filePath, 1, 5);
			compactEventLog(filePath, { compactToCount: 2 });
			assert.equal(currentGeneration(filePath), 1);

			// Fresh read after the compaction establishes the new anchor + echo.
			const fresh = readEventsCursor(filePath, { fromByteOffset: 0, sinceSeq: 0, generation: 0 });
			assert.equal(fresh.generation, 1);
			assert.deepEqual(seqsOf(fresh.events), [4, 5]);

			// Append (no rewrite) → generation stays 1 → incremental read returns
			// ONLY the delta (no second reset, no duplicate re-delivery).
			appendEvents(filePath, 6, 2);
			const next = readEventsCursor(filePath, {
				fromByteOffset: fresh.nextByteOffset,
				sinceSeq: 5,
				generation: fresh.generation,
			});
			assert.equal(next.generation, 1, "generation unchanged when no rewrite");
			assert.deepEqual(seqsOf(next.events), [6, 7], "delta only — the compaction bump is not re-triggered");
		} finally {
			await cleanupStateRoot(dir, filePath);
		}
	});

	it("no-op compaction leaves the generation stable (regression: no-compaction path)", async () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		try {
			// Below the threshold: prepareCompaction returns undefined → no write, no bump.
			appendEvents(filePath, 1, 3);
			const noop = compactEventLog(filePath, { compactToCount: 10 });
			assert.equal(noop, undefined, "nothing to compact");
			assert.equal(currentGeneration(filePath), 0, "generation stays 0 for a no-op compaction");
			assert.equal(fs.existsSync(generationPath(filePath)), false, "no sidecar written by a no-op");

			// Missing file is also a no-op.
			const missing = compactEventLog(path.join(dir, "absent.jsonl"), { compactToCount: 1 });
			assert.equal(missing, undefined);
			assert.equal(currentGeneration(path.join(dir, "absent.jsonl")), 0);

			// Append-only growth never bumps the generation either.
			appendEvents(filePath, 4, 5);
			const read = readEventsCursor(filePath, { fromByteOffset: 0 });
			assert.equal(read.generation, 0, "plain appends keep the generation stable");
			assert.equal(read.events.length, 8);
		} finally {
			await cleanupStateRoot(dir, filePath);
		}
	});
});
