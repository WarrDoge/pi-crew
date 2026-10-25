/**
 * event-log-rotation-foreign-rotate.test.ts — R4-N1 (2026-10-17 wave-2a):
 * `readTailSince` treated "file smaller than snapshot offset" (a foreign
 * rotation replaced the live file) as proceed-no-splice, so the compaction
 * write phase OVERWROTE the new live file — post-rotation appends lost, stale
 * events resurrected, C2 reported SUCCESS. `size === offset` stays benign;
 * `size < offset` must ABORT the cycle and leave the live file untouched.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { applyCompactionAppendGuarded, prepareCompaction } from "../../../../src/state/event-log/event-log-rotation.ts";
import { cleanupStateRoot } from "../../../helpers/rm-retry.ts";

function makeEventsPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-r4n1-"));
	return path.join(dir, "events.jsonl");
}

function line(seq: number, message: string): string {
	return `${JSON.stringify({ type: "task.progress", runId: "r", taskId: "t", message, metadata: { seq } })}\n`;
}

test("R4-N1: foreign rotation (smaller file) aborts compaction — new appends survive", async () => {
	const eventsPath = makeEventsPath();
	try {
		// Build a log big enough that prepareCompaction keeps a tail window.
		for (let seq = 1; seq <= 1000; seq++) fs.appendFileSync(eventsPath, line(seq, `old-${seq}`));
		const prepared = prepareCompaction(eventsPath, { compactToCount: 10 });
		assert.ok(prepared, "prepare must succeed on the intact log");
		const originalSize = prepared.originalSize;

		// Foreign rotation: replace the live file with a FRESH, SMALLER file and
		// append post-rotation events to it.
		fs.writeFileSync(eventsPath, "");
		for (let seq = 2001; seq <= 2010; seq++) fs.appendFileSync(eventsPath, line(seq, `new-${seq}`));
		const newSize = fs.statSync(eventsPath).size;
		assert.ok(newSize < originalSize, "fixture: rotated file must be smaller than the snapshot offset");

		// Pre-fix: apply proceeded with no splice and clobbered the new file.
		assert.throws(
			() => applyCompactionAppendGuarded(eventsPath, prepared),
			/foreign-rotation/,
			"size < offset must abort the compaction cycle with a typed error",
		);
		const after = fs.readFileSync(eventsPath, "utf-8");
		assert.ok(after.includes("new-2010"), "post-rotation appends must survive (live file NOT clobbered)");
		assert.ok(!after.includes("old-"), "stale pre-rotation events must not be resurrected");
	} finally {
		await cleanupStateRoot(path.dirname(eventsPath), eventsPath);
	}
});

test("R4-N1: benign case size === offset (no appends) still compacts normally", async () => {
	const eventsPath = makeEventsPath();
	try {
		for (let seq = 1; seq <= 1000; seq++) fs.appendFileSync(eventsPath, line(seq, `old-${seq}`));
		const prepared = prepareCompaction(eventsPath, { compactToCount: 10 });
		assert.ok(prepared);
		const result = applyCompactionAppendGuarded(eventsPath, prepared);
		assert.ok(result, "no foreign rotation → compaction proceeds");
		assert.ok(fs.statSync(eventsPath).size < prepared.originalSize, "compaction shrank the log");
	} finally {
		await cleanupStateRoot(path.dirname(eventsPath), eventsPath);
	}
});
