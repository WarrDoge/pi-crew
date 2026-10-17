/**
 * Wave-4 Run C consolidated unit tests (2026-10-17).
 *
 * Covers the pure-logic halves of the batch:
 * - R3-M-B4 detectPeriod2Oscillation (A,B,A,B fires)
 * - R2-L-B7 generic prune digest fallback (edit tool result carries content)
 * - R2-M-B4 spawnedRunIds cap + remove() bounded
 * - R2-M-B6 missed-cron one-time skipped event on reload (add)
 * - R2-L-B6 BatchBarrier tombstone: markNotified frees, late markTerminal no re-notify
 * - R9-F3 delegate.completed ok:true counts as observable work
 * - R9-OPS2 stale socket sweep (old removed, fresh + current kept)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createPrunedNotice } from "../../../src/runtime/compaction/tool-output-pruner.ts";
import { delegateCompletedTaskIdsFromEvents, evaluateRunEffectiveness } from "../../../src/runtime/effectiveness.ts";
import { detectOscillation, detectPeriod2Oscillation } from "../../../src/runtime/goal-workflow/goal-loop-runner.ts";
import { BatchBarrier } from "../../../src/runtime/scheduling/batch-barrier.ts";
import { CrewScheduler } from "../../../src/runtime/scheduling/scheduler.ts";
import { sweepStaleSocketFiles } from "../../../src/state/coordination/process-lock.ts";

test("R3-M-B4: period-2 A,B,A,B oscillation fires", () => {
	const a = { reason: "the build fails because module X cannot be resolved from the test tree" };
	const b = { reason: "the build fails because module Y cannot be resolved from the test tree" };
	const c = { reason: "the tests pass locally but the CI runner times out during setup" };
	// A,B,A,B — pairwise window-3 misses it, lag-2 catches it.
	assert.equal(detectOscillation([a, b, a, b]), false, "pre-fix pairwise detector misses period-2 (documented gap)");
	assert.equal(detectPeriod2Oscillation([a, b, a, b]), true, "period-2 detector fires");
	assert.equal(detectPeriod2Oscillation([a, b, a]), false, "needs window+1 verdicts (4 by default)");
	assert.equal(detectPeriod2Oscillation([a, b, c, b]), false, "broken alternation does not fire");
	assert.equal(detectPeriod2Oscillation([a, a, a, a]), true, "constant tail still fires (degenerate period-2)");
});

test("R2-L-B7: edit tool pruned output carries a generic content digest", () => {
	const entry = {
		toolName: "edit",
		content: "line one\nline two\nline three\nline four\nline five",
		isError: false,
	} as Parameters<typeof createPrunedNotice>[1];
	const notice = createPrunedNotice(120, entry);
	assert.match(notice, /\[Output pruned — 120 tokens; /);
	assert.match(notice, /head=line one/, "generic digest carries a content signal (exact length is token-cap-bounded)");
	// Short content: all lines inline, still a content signal (not bare generic).
	const short = createPrunedNotice(10, { ...entry, content: "only line" });
	assert.match(short, /1 line\(s\)/);
});

test("R2-M-B4: spawnedRunIds capped at 50; remove() cancel surface bounded", () => {
	const cancelled: string[] = [];
	const scheduler = new CrewScheduler();
	scheduler.start({
		emit: () => undefined,
		executor: () => "agent-1",
		finalizer: () => undefined,
		runCancelFn: (runId) => {
			cancelled.push(runId);
		},
	});
	scheduler.add({
		id: "job-1",
		name: "job-1",
		description: "",
		schedule: "*/5 * * * *",
		scheduleType: "cron",
		subagentType: "explorer",
		prompt: "p",
		enabled: true,
		createdAt: new Date().toISOString(),
		runCount: 0,
	});
	for (let i = 0; i < 60; i++) scheduler.recordSpawnedRun("job-1", `run-${i}`);
	const job = scheduler.list().find((j) => j.id === "job-1");
	assert.equal(job?.spawnedRunIds?.length, 50, "spawnedRunIds bounded at 50");
	assert.equal(job?.spawnedRunIds?.[0], "run-10", "oldest entries pruned, newest kept");
	assert.equal(job?.spawnedRunIds?.[49], "run-59");
	// remove() only ever sees the capped recent window — historical runs
	// (run-0..run-9) are NOT cancelled.
	scheduler.remove("job-1");
	assert.ok(!cancelled.includes("run-0"), "historical (beyond cap) run not cancelled");
	assert.ok(cancelled.includes("run-59"), "recent run still cancelled");
});

test("R2-M-B6: reloaded cron job with stale nextRun emits one skipped event", () => {
	const events: Array<{ type: string; reason?: string }> = [];
	const now = new Date("2026-10-17T12:00:00Z");
	const scheduler = new CrewScheduler({ now: () => now });
	scheduler.start({ emit: (e) => events.push(e as { type: string; reason?: string }), executor: () => "a", finalizer: () => undefined });
	scheduler.add({
		id: "job-missed",
		name: "missed",
		description: "",
		schedule: "0 * * * *", // hourly
		scheduleType: "cron",
		subagentType: "explorer",
		prompt: "p",
		enabled: true,
		createdAt: "2026-10-16T00:00:00Z",
		runCount: 0,
		nextRun: "2026-10-17T06:00:00.000Z", // 6h stale → 6 missed hourly occurrences
	});
	const skipped = events.filter((e) => e.type === "skipped");
	assert.equal(skipped.length, 1, "exactly one skipped event on reload");
	assert.match(skipped[0]?.reason ?? "", /missed 6 occurrence\(s\) while host down/);
});

test("R2-L-B6: BatchBarrier markNotified frees members; late markTerminal never re-notifies", () => {
	const barrier = new BatchBarrier();
	barrier.register("b1", "a1", { description: "one" });
	barrier.register("b1", "a2", { description: "two" });
	const snap1 = barrier.markTerminal("b1", { id: "a1", status: "completed" });
	const snap2 = barrier.markTerminal("b1", { id: "a2", status: "completed" });
	assert.equal(snap2.allDone, true);
	assert.equal(snap2.notified, false);
	barrier.markNotified("b1");
	assert.equal(barrier.alreadyNotified("b1"), true, "tombstone keeps alreadyNotified true after dispose-on-notify");
	// Late member completing AFTER the consolidated notify must NOT resurrect
	// a re-notifiable batch.
	const late = barrier.markTerminal("b1", { id: "a3", status: "completed" });
	assert.equal(late.notified, true, "late member sees notified=true → caller will not re-notify");
	// A late register into a tombstoned batch is a no-op.
	barrier.register("b1", "a4");
	const after = barrier.markTerminal("b1", { id: "a4", status: "completed" });
	assert.equal(after.notified, true);
});

test("R9-F3: delegate.completed ok:true task counts as observable work", () => {
	const delegateTask = {
		id: "gc-1",
		runId: "r1",
		role: "explorer",
		agent: "delegate",
		title: "delegate: x",
		status: "completed",
		cwd: "/tmp",
		dependsOn: [],
	} as Parameters<typeof evaluateRunEffectiveness>[0]["tasks"][number];
	const events = [
		{ type: "delegate.completed", data: { subId: "gc-1", ok: true } },
		{ type: "delegate.completed", data: { subId: "gc-2", ok: false } },
	];
	const ids = delegateCompletedTaskIdsFromEvents(events);
	assert.equal(ids.has("gc-1"), true);
	assert.equal(ids.has("gc-2"), false, "ok:false completions do not count");
	const summary = evaluateRunEffectiveness({
		tasks: [delegateTask],
		executeWorkers: true,
		delegateCompleted: ids,
	});
	assert.deepEqual(summary.noObservedWorkTaskIds, [], "delegate-completed task not flagged");
	// Without the guard the same task IS flagged (regression pin of the gap).
	const without = evaluateRunEffectiveness({ tasks: [delegateTask], executeWorkers: true });
	assert.deepEqual(without.noObservedWorkTaskIds, ["gc-1"]);
});

test("R9-OPS2: stale socket sweep removes old pi-crew/pc sockets, keeps fresh + current", {
	skip: process.platform === "win32",
}, async (t) => {
	// Windows has no unix domain sockets — the sweep is a structural no-op there
	// (skip); where listen/utimes on a socket file is refused, skip rather than
	// crash (the product fn itself is best-effort throughout).
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wave4-sock-sweep-"));
	const old = path.join(dir, "pc-stale-old.sock");
	const fresh = path.join(dir, "pi-crew-fresh.sock");
	const current = path.join(dir, "pi-crew-current.sock");
	const notASocket = path.join(dir, "pc-regular-old.sock");
	let server: net.Server | undefined;
	try {
		server = await new Promise<net.Server>((resolve, reject) => {
			const s = net.createServer((socket) => socket.end());
			s.once("error", reject);
			s.listen(old, () => {
				s.unref();
				resolve(s);
			});
		});
	} catch {
		fs.rmSync(dir, { recursive: true, force: true });
		t.skip(`unix socket listen unavailable on ${process.platform}`);
		return;
	}
	// fresh/current/notASocket as regular files: still assert "kept/untouched"
	// (the sweep skips non-sockets at the isSocket gate — same observable).
	fs.writeFileSync(fresh, "");
	fs.writeFileSync(current, "");
	fs.writeFileSync(notASocket, "");
	const now = Date.now();
	try {
		// Backdate via a tiny epoch value: this host's /tmp FS clamps modern
		// ms-scale utimes on socket files to a garbage future mtime (observed
		// in-probe); epoch+1s is accepted verbatim — age > 24h with real `now`.
		fs.utimesSync(old, 1000, 1000);
	} catch {
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
		t.skip(`utimes on socket file refused on ${process.platform}`);
		return;
	}
	fs.utimesSync(notASocket, 1000, 1000);
	try {
		const removed = sweepStaleSocketFiles({ tmpDir: dir, now, excludePath: current });
		assert.equal(removed, 1, "exactly the stale socket removed");
		assert.equal(fs.existsSync(old), false, "old socket unlinked");
		assert.equal(fs.existsSync(fresh), true, "fresh entry kept");
		assert.equal(fs.existsSync(current), true, "excluded current entry kept");
		assert.equal(fs.existsSync(notASocket), true, "regular file never touched");
	} finally {
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
