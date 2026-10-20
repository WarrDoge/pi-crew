/**
 * R4-2 (DR-02 Wave 2, 2026-10-15) — events.jsonl compaction race.
 *
 * Bug: async-family appends (withEventLogLockAsync → appendEventAsync) hold the
 * `.alock` lock dir ACROSS await gaps — notably between
 * `fs.promises.open(eventsPath, "a")` and `fd.appendFile(...)`. Compaction's
 * write phase (compactPreparedEventLog → applyCompactionUnlocked →
 * atomicWriteFile = temp+rename → NEW inode) ran under `.mkdirlock` only, so the
 * rename could interleave with that gap: the appender's fd kept pointing at the
 * OLD inode, which the rename orphaned → the append was silently lost (C2
 * recovery only re-splices events in the `kept` window).
 *
 * Fix (lead-decided, mutual exclusion — NOT archive-style): the compaction write
 * phase ADDITIONALLY acquires `.alock` in SYNC mode (withEventLogAppendLockSync
 * — mkdir O_EXCL on the same `${eventsPath}.alock` dir, pid file, mtime-stale
 * reclaim, bounded wait) BEFORE readTailSince/the rename, releasing it after the
 * C2 check. Lock order stays strictly `.mkdirlock` → `.alock`.
 *
 * These tests pin:
 *  (a) mutual exclusion between the sync compaction acquirer and the async
 *      family — in BOTH directions, including through the real compaction path
 *      (the R4-2 race reproduced deterministically: a parked mid-gap async
 *      append with an open fd must make compaction REFUSE to run);
 *  (b) stale-reclaim of an abandoned `.alock` (old mtime with/without pid file,
 *      dead pid) and the no-steal rule for fresh holders;
 *  (c) no lock-dir leaks through the public compactEventLog path.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { withEventLogAppendLockSync, withEventLogLockAsync } from "../../../../src/state/event-log/event-log.ts";
import { compactEventLog, compactPreparedEventLog, prepareCompaction } from "../../../../src/state/event-log/event-log-rotation.ts";

function tmpEventsPath(prefix: string): { dir: string; eventsPath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return { dir, eventsPath: path.join(dir, "events.jsonl") };
}

function seedEvents(eventsPath: string, count: number, startSeq = 1): void {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		lines.push(
			JSON.stringify({
				time: new Date(Date.parse("2026-01-01T00:00:00.000Z") + (startSeq + i) * 1000).toISOString(),
				type: "task.progress",
				runId: "r42-test",
				message: `seed-${startSeq + i}`,
				metadata: { seq: startSeq + i, provenance: "test" },
			}),
		);
	}
	fs.writeFileSync(eventsPath, lines.join("\n") + "\n", "utf-8");
}

function readJsonl(eventsPath: string): Array<Record<string, unknown>> {
	return fs
		.readFileSync(eventsPath, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Backdate a path's mtime so the stale-reclaim (staleMs) threshold fires. */
function backdateMtime(target: string, ageMs: number): void {
	const old = new Date(Date.now() - ageMs);
	fs.utimesSync(target, old, old);
}

/** A pid that is provably not a live process (kill(pid, 0) → ESRCH → "dead"). */
const DEAD_PID = 999_999_999;

test("R4-2: compaction refuses to run while an async-family append is mid-gap (open fd, append pending)", async () => {
	const { dir, eventsPath } = tmpEventsPath("r42-midgap-");
	try {
		seedEvents(eventsPath, 500);
		const prepared = prepareCompaction(eventsPath, { maxFileSizeBytes: 1, compactToCount: 50 });
		assert.ok(prepared, "fixture must be over the compaction threshold");
		const sizeBefore = fs.statSync(eventsPath).size;
		assert.equal(sizeBefore, prepared.originalSize);

		// Reproduce the async appender's await gap UNDER the async family's lock:
		// fd opened on the current inode, appendFile still pending.
		let releaseGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		let fdOpen = false;
		const holder = withEventLogLockAsync(eventsPath, async () => {
			const fd = await fs.promises.open(eventsPath, "a");
			fdOpen = true;
			await gate; // the await gap during which compaction must not rename
			await fd.appendFile(
				`${JSON.stringify({
					time: new Date().toISOString(),
					type: "task.progress",
					runId: "r42-test",
					message: "late-r42",
					metadata: { seq: 10_001, provenance: "test" },
				})}\n`,
				"utf-8",
			);
			await fd.close();
		});

		// Wait until the async holder actually holds `.alock` with the fd open.
		const alockDir = `${eventsPath}.alock`;
		await new Promise<void>((resolve) => {
			const poll = () => {
				if (fs.existsSync(alockDir) && fdOpen) resolve();
				else setTimeout(poll, 5);
			};
			poll();
		});

		// POST-FIX: compaction must REFUSE to rename under the open fd — bounded
		// wait, then a lock-timeout throw. (Pre-fix it renamed immediately and the
		// pending append landed on the orphaned inode → silent loss.)
		assert.throws(() => compactPreparedEventLog(eventsPath, prepared, { lock: { timeoutMs: 250, staleMs: 60_000 } }), /lock timeout/);

		// No steal: the timed-out acquirer left the holder's lock dir + pid file
		// intact, and the events file was NOT rewritten (still the original inode
		// content — the mid-gap fd remains valid).
		assert.ok(fs.existsSync(alockDir), "timed-out acquirer must not remove the holder's .alock");
		assert.ok(fs.existsSync(path.join(alockDir, "pid")), "holder's pid file must be intact");
		assert.equal(fs.statSync(eventsPath).size, sizeBefore, "events file must be untouched by the refused compaction");

		// Complete the append on the STILL-CURRENT inode, then compact cleanly.
		releaseGate();
		await holder;
		const result = compactPreparedEventLog(eventsPath, prepared);
		assert.ok(result, "compaction must succeed once the async append is done");

		const events = readJsonl(eventsPath);
		assert.ok(
			events.some((e) => (e.data ?? (e as { message?: string }).message) !== undefined && JSON.stringify(e).includes("late-r42")),
			"the mid-gap append must survive compaction (spliced tail or kept window)",
		);
		for (const e of events) {
			assert.equal(typeof (e.metadata as { seq?: number } | undefined)?.seq, "number", "valid JSONL with seq");
		}
		// No lock-dir leaks: both families released.
		assert.ok(!fs.existsSync(alockDir), ".alock must be released after compaction");
		assert.ok(!fs.existsSync(`${eventsPath}.mkdirlock`), ".mkdirlock must be released after compaction");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("R4-2(a): sync append-lock acquirer times out while the async family holds .alock, then succeeds after release", async () => {
	const { dir, eventsPath } = tmpEventsPath("r42-async-holds-");
	try {
		let releaseGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const holder = withEventLogLockAsync(eventsPath, async () => gate);
		const alockDir = `${eventsPath}.alock`;
		await new Promise<void>((resolve) => {
			const poll = () => {
				if (fs.existsSync(alockDir)) resolve();
				else setTimeout(poll, 5);
			};
			poll();
		});

		const start = Date.now();
		assert.throws(
			() => withEventLogAppendLockSync(eventsPath, () => "unreachable", { timeoutMs: 150, staleMs: 60_000 }),
			/lock timeout/,
		);
		const elapsed = Date.now() - start;
		// W7-B6: adaptive bound (control fs-op) — Windows load flakes.
		const controlMs = timeControlFsOpForLockTests(path.dirname(eventsPath));
		const bound = Math.min(4_900, Math.max(2_000, controlMs * 25));
		assert.ok(elapsed < bound, `bounded wait expected, took ${elapsed}ms (bound ${bound}ms, control ${controlMs}ms)`);
		assert.ok(fs.existsSync(alockDir), "holder's lock dir must survive the timed-out acquirer");

		releaseGate();
		await holder;
		// Uncontended now — acquires, runs, releases (pid-guarded).
		assert.equal(
			withEventLogAppendLockSync(eventsPath, () => 42),
			42,
		);
		assert.ok(!fs.existsSync(alockDir), "lock dir must be removed after a clean acquire/release");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("R4-2(a): async-family lock attempt cannot complete while the sync acquirer holds .alock", async () => {
	const { dir, eventsPath } = tmpEventsPath("r42-sync-holds-");
	try {
		let asyncSettled = false;
		let attempt!: Promise<string>;
		// The sync acquirer holds .alock across its (synchronous) critical
		// section; the async attempt started inside it cannot acquire until the
		// holder releases — the on-disk mutex is the same mkdir O_EXCL dir.
		withEventLogAppendLockSync(eventsPath, () => {
			attempt = withEventLogLockAsync(eventsPath, async () => "acquired", { timeoutMs: 10_000, staleMs: 60_000 });
			attempt.then(
				() => {
					asyncSettled = true;
				},
				() => {
					asyncSettled = true;
				},
			);
			// Block past several retry ticks while we still hold the lock.
			const deadline = Date.now() + 150;
			while (Date.now() < deadline) {
				/* spin — the async attempt is parked behind the held lock dir */
			}
			assert.equal(asyncSettled, false, "async attempt must not acquire while the sync holder owns .alock");
		});
		assert.equal(await attempt, "acquired", "async attempt completes after the sync holder releases");
		assert.ok(!fs.existsSync(`${eventsPath}.alock`), "no lock-dir leak");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("R4-2(b): stale .alock (old mtime + dead pid) is reclaimed by the sync acquirer", () => {
	const { dir, eventsPath } = tmpEventsPath("r42-stale-deadpid-");
	try {
		const alockDir = `${eventsPath}.alock`;
		fs.mkdirSync(alockDir);
		fs.writeFileSync(path.join(alockDir, "pid"), String(DEAD_PID), "utf-8");
		backdateMtime(alockDir, 30_000);

		const start = Date.now();
		assert.equal(
			withEventLogAppendLockSync(eventsPath, () => "ok", { timeoutMs: 5_000, staleMs: 1_000 }),
			"ok",
		);
		const elapsed = Date.now() - start;
		// Reclaim fires on the aged mtime long before the 5s timeout would.
		// W7-B6: adaptive bound — the stale-poll lands ≈staleMs (1s) after start;
		// the old fixed 2s was only a 2× margin on slow Windows runners.
		const controlMs = timeControlFsOpForLockTests(path.dirname(eventsPath));
		const bound = Math.min(4_900, Math.max(2_000, controlMs * 25));
		assert.ok(elapsed < bound, `stale reclaim must be prompt, took ${elapsed}ms (bound ${bound}ms, control ${controlMs}ms)`);
		assert.ok(!fs.existsSync(alockDir), "reclaimed lock dir must be released after fn");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("R4-2(b): stale .alock with no pid file (crash between mkdir and pid write) is reclaimed", () => {
	const { dir, eventsPath } = tmpEventsPath("r42-stale-nopid-");
	try {
		const alockDir = `${eventsPath}.alock`;
		fs.mkdirSync(alockDir);
		backdateMtime(alockDir, 30_000);

		assert.equal(
			withEventLogAppendLockSync(eventsPath, () => "ok", { timeoutMs: 5_000, staleMs: 1_000 }),
			"ok",
		);
		assert.ok(!fs.existsSync(alockDir), "reclaimed lock dir must be released after fn");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("R4-2(b): fresh .alock with a live pid is NOT stolen — bounded timeout throw instead", () => {
	const { dir, eventsPath } = tmpEventsPath("r42-fresh-livepid-");
	try {
		const alockDir = `${eventsPath}.alock`;
		fs.mkdirSync(alockDir);
		// Our own pid = provably alive holder.
		fs.writeFileSync(path.join(alockDir, "pid"), String(process.pid), "utf-8");

		assert.throws(
			() => withEventLogAppendLockSync(eventsPath, () => "unreachable", { timeoutMs: 150, staleMs: 60_000 }),
			/lock timeout/,
		);
		assert.ok(fs.existsSync(alockDir), "a fresh live holder's lock must never be stolen");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("R4-2(b): fresh .alock with a dead-but-not-stale pid is waited on, NOT stolen", () => {
	const { dir, eventsPath } = tmpEventsPath("r42-fresh-deadpid-");
	try {
		const alockDir = `${eventsPath}.alock`;
		fs.mkdirSync(alockDir);
		fs.writeFileSync(path.join(alockDir, "pid"), String(DEAD_PID), "utf-8");

		assert.throws(
			() => withEventLogAppendLockSync(eventsPath, () => "unreachable", { timeoutMs: 150, staleMs: 60_000 }),
			/lock timeout/,
		);
		// Dead pid alone must not trigger a steal — only the aged mtime does.
		assert.ok(fs.existsSync(alockDir), "dead-but-fresh holder's lock must not be stolen");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("R4-2(c): public compactEventLog compacts correctly and leaves no lock dirs behind", () => {
	const { dir, eventsPath } = tmpEventsPath("r42-public-compact-");
	try {
		seedEvents(eventsPath, 300);
		const result = compactEventLog(eventsPath, { maxFileSizeBytes: 1, compactToCount: 25 });
		assert.ok(result, "compaction must run on an over-threshold log");
		const events = readJsonl(eventsPath);
		assert.equal(events.length, 25, `kept window expected 25 events, got ${events.length}`);
		const seqs = events.map((e) => (e.metadata as { seq: number }).seq);
		assert.deepEqual(
			seqs,
			seqs.slice().sort((a, b) => a - b),
			"kept window must preserve order",
		);
		assert.equal(seqs[0], 276, "kept window must be the LAST compactToCount events");
		assert.ok(!fs.existsSync(`${eventsPath}.alock`), "no .alock leak");
		assert.ok(!fs.existsSync(`${eventsPath}.mkdirlock`), "no .mkdirlock leak");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * W7-B6 (flake hardening 2026-10-20): time a trivial fs round-trip in the same
 * parent directory (different file — different lock) to measure current I/O
 * load. Windows CI runners regularly stretch the lock-poll loops past the old
 * fixed 2s bounds (R7-2c/d load-flakes); bounds below scale with this control
 * while staying capped under the 5s lock timeout that would fail the test
 * anyway via its own (stricter) path.
 */
export function timeControlFsOpForLockTests(dir: string): number {
	const controlPath = path.join(dir, `w7b6-control-${process.pid}.txt`);
	const start = Date.now();
	fs.writeFileSync(controlPath, "x".repeat(64 * 1024));
	fs.readFileSync(controlPath, "utf-8");
	return Math.max(1, Date.now() - start);
}
