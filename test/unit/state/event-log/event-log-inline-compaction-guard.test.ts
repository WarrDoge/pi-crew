/**
 * R7-2 (DR-04, 2026-10-16) — inline compaction append-guard + tail-merge.
 *
 * Bug: the 5 INLINE compaction sites in event-log.ts (async overflow
 * :~656, async rotation-tick :~764, batch overflow :~883, sync overflow
 * :~1084, sync rotation-tick :~1180) called `prepareCompaction` +
 * `applyCompactionUnlocked` bare — no `.alock` (so the inode-replacing write
 * could interleave with an async-family append parked between `open()` and
 * `appendFile()` → its fd kept pointing at the renamed-away inode → silent
 * loss) and no `readTailSince` splice (so sync-family bytes appended between
 * the prepare-read and the write were clobbered).
 *
 * Fix: `applyCompactionAppendGuarded(eventsPath, prepared, { holdsAppendLock })`
 * (event-log-rotation.ts) — ALWAYS tail-merges; acquires `.alock` (nested
 * inside a caller-held `.mkdirlock`, R4-2 lock order) unless the caller
 * already holds `.alock` (async family — the lock is NOT re-entrant).
 *
 * These tests pin:
 *  (a) sync-family inline compaction (appendEvent rotation-tick) waits for
 *      `.alock` instead of renaming under a parked mid-gap async appender —
 *      the event is NOT lost (R4-2 repro pattern, real appendEvent path);
 *  (b) the tail-merge rescues sync-family bytes appended between the
 *      prepare-read and the guarded apply — with AND without the flag
 *      (US-001 deterministic by-hand window);
 *  (c) the deadlock-aware wiring at the real call sites: the async-family
 *      sites pass `holdsAppendLock: true` (no re-acquire → fast, compacts);
 *      a wrong default-acquire self-times-out (5s) and skips/rotates → RED;
 *  (d) the batch path (:883) threads the caller's family — the async flush
 *      (flushOneEventLogBuffer → withEventLogLockAsync) compacts under its
 *      own `.alock` without re-acquiring.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	appendEvent,
	appendEventAsync,
	appendEventBuffered,
	flushEventLogBuffer,
	tickAppendCounter,
	withEventLogLockAsync,
} from "../../../../src/state/event-log/event-log.ts";
import { applyCompactionAppendGuarded, prepareCompaction } from "../../../../src/state/event-log/event-log-rotation.ts";

function tmpEventsPath(prefix: string): { dir: string; eventsPath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return { dir, eventsPath: path.join(dir, "events.jsonl") };
}

function makeLine(seq: number, message: string): string {
	return (
		JSON.stringify({
			time: new Date(Date.parse("2026-01-01T00:00:00.000Z") + seq * 1000).toISOString(),
			type: "task.progress",
			runId: "r7-w2-test",
			message,
			metadata: { seq, provenance: "test" },
		}) + "\n"
	);
}

/** Seed `count` events of ~`lineBytes` bytes each (tops up the message with a filler). */
function seedEvents(eventsPath: string, count: number, lineBytes: number): void {
	const filler = "x".repeat(Math.max(0, lineBytes - 200));
	const parts: string[] = [];
	for (let i = 1; i <= count; i++) parts.push(makeLine(i, `seed-${i}-${filler}`).trimEnd());
	fs.writeFileSync(eventsPath, parts.join("\n") + "\n", "utf-8");
}

function readLines(eventsPath: string): string[] {
	return fs
		.readFileSync(eventsPath, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0);
}

function assertValidJsonl(lines: string[]): void {
	for (const line of lines) {
		assert.doesNotThrow(() => JSON.parse(line), `valid JSONL: ${line.slice(0, 80)}`);
	}
}

function assertNoLockLeaks(eventsPath: string): void {
	assert.ok(!fs.existsSync(`${eventsPath}.alock`), ".alock must be released");
	assert.ok(!fs.existsSync(`${eventsPath}.mkdirlock`), ".mkdirlock must be released");
}

// ---------------------------------------------------------------------------
// (b) tail-merge — deterministic prepare→append→guarded-apply window (US-001
// pattern). A sync-family appender never holds `.alock`, so it can land in
// the window regardless of which family runs the guarded apply.
// ---------------------------------------------------------------------------

test("R7-2(b): holdsAppendLock:true tail-merges sync-family bytes appended after prepare (no re-acquire)", async () => {
	const { dir, eventsPath } = tmpEventsPath("r72-holds-");
	try {
		seedEvents(eventsPath, 500, 220);
		const prepared = prepareCompaction(eventsPath, { maxFileSizeBytes: 1, compactToCount: 50 });
		assert.ok(prepared, "fixture must be over the compaction threshold");

		// A sync-family appender lands two events after the prepare-read.
		fs.appendFileSync(eventsPath, makeLine(5001, "late-r72-holds-1") + makeLine(5002, "late-r72-holds-2"), "utf-8");

		// The async-family site applies WITHOUT re-acquiring `.alock`.
		const result = applyCompactionAppendGuarded(eventsPath, prepared, { holdsAppendLock: true });
		assert.ok(result, "guarded apply must produce a result");

		const content = fs.readFileSync(eventsPath, "utf-8");
		assert.ok(content.includes("late-r72-holds-1"), "late byte 1 must survive via the tail-merge");
		assert.ok(content.includes("late-r72-holds-2"), "late byte 2 must survive via the tail-merge");
		const lines = readLines(eventsPath);
		assertValidJsonl(lines);
		assert.ok(lines.length <= 52, `kept window + spliced tail expected, got ${lines.length}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("R7-2(b): default (acquire .alock) also tail-merges bytes appended after prepare", () => {
	const { dir, eventsPath } = tmpEventsPath("r72-acquire-");
	try {
		seedEvents(eventsPath, 500, 220);
		const prepared = prepareCompaction(eventsPath, { maxFileSizeBytes: 1, compactToCount: 50 });
		assert.ok(prepared);

		// Async-family appenders only need `.alock` — they can complete inside
		// the prepare→apply window while a sync-family caller holds `.mkdirlock`.
		fs.appendFileSync(eventsPath, makeLine(5003, "late-r72-acquire"), "utf-8");

		const result = applyCompactionAppendGuarded(eventsPath, prepared);
		assert.ok(result);

		const content = fs.readFileSync(eventsPath, "utf-8");
		assert.ok(content.includes("late-r72-acquire"), "late byte must survive via the tail-merge");
		const lines = readLines(eventsPath);
		assertValidJsonl(lines);
		assert.ok(lines.length <= 51, `kept window + spliced tail expected, got ${lines.length}`);
		assertNoLockLeaks(eventsPath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("R7-2(c): holdsAppendLock:true does NOT re-acquire while .alock is genuinely held (no self-timeout)", async () => {
	const { dir, eventsPath } = tmpEventsPath("r72-flag-");
	try {
		seedEvents(eventsPath, 500, 220);
		const prepared = prepareCompaction(eventsPath, { maxFileSizeBytes: 1, compactToCount: 50 });
		assert.ok(prepared);

		// Park an async-family holder on `.alock` — the exact state at the
		// async inline sites. A guarded apply that (wrongly) re-acquires would
		// sleepSync-starve the holder → 5s lock-timeout throw.
		let releaseGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const holder = withEventLogLockAsync(eventsPath, async () => {
			await gate;
		});
		const alockDir = `${eventsPath}.alock`;
		await new Promise<void>((resolve) => {
			const poll = () => {
				if (fs.existsSync(alockDir)) resolve();
				else setTimeout(poll, 5);
			};
			poll();
		});

		const start = Date.now();
		let result: ReturnType<typeof applyCompactionAppendGuarded>;
		let threw = false;
		try {
			result = applyCompactionAppendGuarded(eventsPath, prepared, { holdsAppendLock: true });
		} catch {
			threw = true;
		}
		assert.equal(threw, false, "must not re-acquire .alock when the caller declares it held");
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 4000, `tail-merge-only apply must be fast, took ${elapsed}ms`);
		assert.ok(result, "guarded apply must produce a result");
		assert.ok(fs.existsSync(alockDir), "the parked holder's .alock must be untouched");

		releaseGate();
		await holder;
		assertNoLockLeaks(eventsPath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// (a) sync-family inline compaction vs a parked mid-gap async appender — the
// REAL appendEvent path (rotation-tick site). Pre-fix the rename interleaved
// with the open→appendFile gap and orphaned the appender's fd (event lost).
// Post-fix the site waits (bounded 5s) for `.alock`, times out, SKIPS the
// compaction, and both events land on the still-current inode.
// ---------------------------------------------------------------------------

test("R7-2(a): appendEvent rotation-tick compaction does not orphan a parked mid-gap async append", async () => {
	const { dir, eventsPath } = tmpEventsPath("r72-syncsite-");
	try {
		// > 4 MiB and > 1000 events so needsRotation + prepareCompaction fire on
		// the default config; pre-advance the counter so appendEvent's own tick
		// crosses the 100-boundary and reaches the inline compaction site.
		seedEvents(eventsPath, 30_000, 160);
		assert.ok(fs.statSync(eventsPath).size > 4 * 1024 * 1024, "fixture must trip needsRotation");
		tickAppendCounter(eventsPath, 99);

		// Park the async appender in the R4-2 gap: fd open on the current
		// inode, appendFile pending.
		let releaseGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		let fdOpen = false;
		const holder = withEventLogLockAsync(eventsPath, async () => {
			const fd = await fs.promises.open(eventsPath, "a");
			fdOpen = true;
			await gate;
			await fd.appendFile(makeLine(99_001, "late-r72-async-appender"), "utf-8");
			await fd.close();
		});
		const alockDir = `${eventsPath}.alock`;
		await new Promise<void>((resolve) => {
			const poll = () => {
				if (fs.existsSync(alockDir) && fdOpen) resolve();
				else setTimeout(poll, 5);
			};
			poll();
		});
		const sizeBefore = fs.statSync(eventsPath).size;

		// The sync append's inline compaction must not rename under the parked
		// fd: it waits for `.alock`, hits the bounded timeout, skips compaction
		// (logged), and the append itself proceeds on the CURRENT inode.
		const start = Date.now();
		const ev = appendEvent(eventsPath, { type: "task.progress", runId: "r7-w2-test", message: "late-r72-sync-appender" });
		const elapsed = Date.now() - start;
		assert.ok(elapsed >= 4000, `the site must WAIT for .alock before giving up, took ${elapsed}ms`);
		assert.notEqual(ev.metadata?.skippedDueToSize, true, "the sync append must be persisted");

		// Complete the parked append on the still-current inode.
		releaseGate();
		await holder;

		const lines = readLines(eventsPath);
		assertValidJsonl(lines);
		assert.ok(
			lines.some((l) => l.includes("late-r72-sync-appender")),
			"the sync event must survive",
		);
		assert.ok(
			lines.some((l) => l.includes("late-r72-async-appender")),
			"the parked async event must NOT be lost",
		);
		assert.equal(lines.length, 30_002, `no compaction may run under the parked fd (file untouched), got ${lines.length} lines`);
		assert.equal(fs.statSync(eventsPath).size > sizeBefore, true, "both appends landed on the current inode");
		assertNoLockLeaks(eventsPath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// (c) wiring: the ASYNC-family inline sites must pass holdsAppendLock:true —
// re-acquiring our own `.alock` self-times-out (5s) and skips/rotates. Each
// test discriminates on elapsed time AND the compacted/rotated file state.
// ---------------------------------------------------------------------------

test("R7-2(c): appendEventAsync rotation-tick compacts fast (no .alock re-acquire)", async () => {
	const { dir, eventsPath } = tmpEventsPath("r72-asynctick-");
	try {
		seedEvents(eventsPath, 30_000, 160);
		tickAppendCounter(eventsPath, 99);

		const start = Date.now();
		const ev = await appendEventAsync(eventsPath, {
			type: "task.progress",
			runId: "r7-w2-test",
			message: "late-r72-async-tick",
		});
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 4000, `inline compaction must not self-timeout on .alock, took ${elapsed}ms`);
		assert.notEqual(ev.metadata?.skippedDueToSize, true);

		const lines = readLines(eventsPath);
		assertValidJsonl(lines);
		assert.ok(
			lines.some((l) => l.includes("late-r72-async-tick")),
			"the appended event must survive (kept window)",
		);
		assert.equal(lines.length, 1000, `compaction must have run (kept window), got ${lines.length} lines`);
		assertNoLockLeaks(eventsPath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("R7-2(c): appendEventAsync overflow site compacts a >50MiB log without re-acquiring .alock", async () => {
	const { dir, eventsPath } = tmpEventsPath("r72-asyncover-");
	try {
		// > 50 MiB total (trips MAX_EVENTS_BYTES) while the kept window (1000
		// lines) stays under it, so compaction — not rotation — resolves it.
		seedEvents(eventsPath, 1200, 48_200);
		assert.ok(fs.statSync(eventsPath).size > 50 * 1024 * 1024, "fixture must trip MAX_EVENTS_BYTES");

		const start = Date.now();
		const ev = await appendEventAsync(eventsPath, {
			type: "task.progress",
			runId: "r7-w2-test",
			message: "late-r72-async-overflow",
		});
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 4000, `overflow compaction must not self-timeout on .alock, took ${elapsed}ms`);
		assert.notEqual(ev.metadata?.skippedDueToSize, true, "compaction must bring the file under the limit");

		const lines = readLines(eventsPath);
		assertValidJsonl(lines);
		assert.ok(
			lines.some((l) => l.includes("late-r72-async-overflow")),
			"the appended event must survive",
		);
		assert.equal(lines.length, 1001, `kept window + the append, got ${lines.length} lines`);
		// A wrong default-acquire skips compaction → still >50MiB → rotation →
		// an archive appears. Compaction alone must leave no archive.
		assert.deepEqual(
			fs.readdirSync(dir).filter((n) => n.endsWith(".archive.jsonl")),
			[],
			"no rotation archive — compaction handled the overflow",
		);
		assertNoLockLeaks(eventsPath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("R7-2(d): buffered async flush compacts a >50MiB log under its own .alock (batch site wiring)", async () => {
	const { dir, eventsPath } = tmpEventsPath("r72-batchasync-");
	try {
		seedEvents(eventsPath, 1200, 48_200);
		assert.ok(fs.statSync(eventsPath).size > 50 * 1024 * 1024, "fixture must trip MAX_EVENTS_BYTES");

		// Queue non-terminal events; bufferMs long enough that only the manual
		// flush below drains the queue (flushOneEventLogBuffer → .alock held).
		const pending = [1, 2, 3].map((i) =>
			appendEventBuffered(eventsPath, { type: "task.progress", runId: "r7-w2-test", message: `late-r72-batch-${i}` }, 60_000),
		);
		const start = Date.now();
		await flushEventLogBuffer();
		const elapsed = Date.now() - start;
		const events = await Promise.all(pending);
		assert.ok(elapsed < 4000, `batch overflow compaction must not self-timeout on .alock, took ${elapsed}ms`);
		for (const e of events) assert.notEqual(e.metadata?.skippedDueToSize, true);

		const lines = readLines(eventsPath);
		assertValidJsonl(lines);
		for (let i = 1; i <= 3; i++) {
			assert.ok(
				lines.some((l) => l.includes(`late-r72-batch-${i}`)),
				`buffered event ${i} must survive`,
			);
		}
		assert.equal(lines.length, 1003, `kept window + the batch, got ${lines.length} lines`);
		assert.deepEqual(
			fs.readdirSync(dir).filter((n) => n.endsWith(".archive.jsonl")),
			[],
			"no rotation archive — compaction handled the overflow",
		);
		assertNoLockLeaks(eventsPath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
