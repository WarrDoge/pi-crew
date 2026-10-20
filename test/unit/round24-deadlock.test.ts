/**
 * Round 24 (BUG 1): re-entrant event-log lock deadlock regression.
 *
 * appendEventInsideLock runs INSIDE withEventLogLockSync. It used to call the
 * PUBLIC compactEventLog/rotateEventLog, which themselves acquire the SAME
 * mkdir lock. The mkdir lock is NOT re-entrant (same-PID owner is never
 * treated as stale), so the inner acquire spun to the 5s timeout, threw
 * eventLogLockTimeout, and was silently caught — meaning compaction/rotation
 * NEVER ran from the sync append path → unbounded log growth → events
 * silently dropped past 50MB.
 *
 * Fix: split compactEventLog/rotateEventLog into prepare + apply(+rotate)
 * unlocked cores; appendEventInsideLock calls the unlocked cores directly.
 *
 * This test verifies:
 *  (a) compaction runs to completion when invoked inside the lock (no timeout);
 *  (b) the unlocked apply path actually compacts;
 *  (c) the public locked variants still work standalone.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { withEventLogLockSync } from "../../src/state/event-log/event-log.ts";
import {
	applyCompactionUnlocked,
	compactEventLog,
	prepareCompaction,
	rotateEventLog,
	rotateEventLogUnlocked,
} from "../../src/state/event-log/event-log-rotation.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-r24-deadlock-"));
}

/**
 * W7-B3 (flake hardening): time a trivial fs round-trip in the SAME directory
 * (a DIFFERENT file — hence a different lock) to measure current I/O load.
 * The perf bounds below scale with this control instead of assuming an idle
 * runner, while staying capped below the ~5s lock-timeout deadlock signature.
 */
function timeControlFsOp(dir: string): number {
	const controlPath = path.join(dir, "w7b3-control.txt");
	const start = Date.now();
	fs.writeFileSync(controlPath, "x".repeat(64 * 1024));
	fs.readFileSync(controlPath, "utf-8");
	return Math.max(1, Date.now() - start);
}

function writeEvents(filePath: string, count: number): void {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		const ts = new Date(Date.parse("2025-01-01T00:00:00.000Z") + i * 1000).toISOString();
		lines.push(
			JSON.stringify({
				time: ts,
				type: "tick",
				runId: "r1",
				metadata: { seq: i + 1, provenance: "test" },
			}),
		);
	}
	fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

describe("Round 24 BUG 1: re-entrant lock deadlock on compaction/rotation", () => {
	it("applyCompactionUnlocked compacts the log (the unlocked core works)", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 100);
		try {
			const prepared = prepareCompaction(filePath, {
				compactToCount: 10,
			});
			assert.ok(prepared, "prepareCompaction should produce a plan for 100 events (compactToCount=10)");
			const result = applyCompactionUnlocked(filePath, prepared!);
			assert.ok(result, "compaction should produce a result");
			assert.ok(result!.eventsRemoved > 0, "events should be removed");
			// File should now have FEWER lines (compacted down to compactToCount).
			const remaining = fs.readFileSync(filePath, "utf-8").trim().split("\n").length;
			assert.ok(remaining < 100, `expected compaction, got ${remaining} lines`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("compaction runs to completion WHEN INVOKED INSIDE THE LOCK (no deadlock/timeout)", () => {
		// This is the exact regression: previously this would spin for 5s then
		// throw eventLogLockTimeout (caught + ignored), leaving the log un-compacted.
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 100);
		try {
			const start = Date.now();
			// Simulate appendEventInsideLock: we hold the lock, then compact via the
			// unlocked core (the fix). This must complete FAST and actually compact.
			// W7-B3 (flake hardening 2026-10-20): a fixed 2s wall-clock bound tripped
			// under CI load (observed 3912ms on healthy rotation). The real deadlock
			// signature is the ~5s lock-timeout spin, so the bound adapts to a
			// same-dir control fs-op and stays strictly under 5s.
			const controlMs = timeControlFsOp(dir);
			const bound = Math.min(4_900, Math.max(2_000, controlMs * 25));
			const result = withEventLogLockSync(filePath, () => {
				const prepared = prepareCompaction(filePath, {
					compactToCount: 10,
				});
				return prepared ? applyCompactionUnlocked(filePath, prepared) : undefined;
			});
			const elapsed = Date.now() - start;
			assert.ok(
				elapsed < bound,
				`in-lock compaction should be fast, took ${elapsed}ms (bound ${bound}ms, control ${controlMs}ms — deadlock regression?)`,
			);
			assert.ok(result && result.eventsRemoved > 0, `compaction should have run inside the lock, got ${JSON.stringify(result)}`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rotation runs to completion WHEN INVOKED INSIDE THE LOCK (no deadlock/timeout)", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 50);
		try {
			const start = Date.now();
			// W7-B3: adaptive bound — see the compaction test above.
			const controlMs = timeControlFsOp(dir);
			const bound = Math.min(4_900, Math.max(2_000, controlMs * 25));
			const result = withEventLogLockSync(filePath, () => rotateEventLogUnlocked(filePath));
			const elapsed = Date.now() - start;
			assert.ok(elapsed < bound, `in-lock rotation should be fast, took ${elapsed}ms (bound ${bound}ms, control ${controlMs}ms)`);
			assert.equal(result, true, "rotation should succeed inside the lock");
			// Original file truncated to empty; archive created.
			assert.equal(fs.readFileSync(filePath, "utf-8"), "", "original truncated");
			assert.ok(
				fs.readdirSync(dir).some((f) => f.endsWith(".archive.jsonl")),
				"archive created",
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("public locked compactEventLog still works standalone (regression)", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 100);
		try {
			const result = compactEventLog(filePath, { compactToCount: 10 });
			assert.ok(result && result.eventsRemoved > 0, "locked compactEventLog still compacts");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("public locked rotateEventLog still works standalone (regression)", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "events.jsonl");
		writeEvents(filePath, 30);
		try {
			assert.equal(rotateEventLog(filePath), true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
