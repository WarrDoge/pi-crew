/**
 * R39-M3 (fix-wave 6, EP3) — orphan reaper unit pin.
 *
 * Pins the conservative safety model: a recorded worker pid is reaped ONLY when
 * it is alive, not self/ancestor, and inside the authoritative orphan set. All
 * IO is injected so no real process is ever signalled.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { collectWorkerPidEvidence, reapOrphanWorkers, reapRecordedWorkerOrphans } from "../../../../src/runtime/process/orphan-reaper.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";

function task(overrides: Partial<TeamTaskState> & { id: string; status: TeamTaskState["status"] }): TeamTaskState {
	return {
		runId: "run-x",
		role: "executor",
		agent: "executor",
		title: "t",
		dependsOn: [],
		cwd: "/tmp",
		...overrides,
	} as TeamTaskState;
}

test("collectWorkerPidEvidence: only in-flight tasks with a recorded pid, deduped", () => {
	const tasks = [
		task({ id: "t1", status: "running", heartbeat: { pid: 4242 } as TeamTaskState["heartbeat"] }),
		task({ id: "t2", status: "running", heartbeat: { pid: 4242 } as TeamTaskState["heartbeat"] }), // dup pid
		task({ id: "t3", status: "waiting", checkpoint: { childPid: 5151 } as TeamTaskState["checkpoint"] }),
		task({ id: "t4", status: "running" }), // no pid recorded
		task({ id: "t5", status: "completed", heartbeat: { pid: 6262 } as TeamTaskState["heartbeat"] }), // terminal
		task({ id: "t6", status: "running", heartbeat: { pid: 1 } as TeamTaskState["heartbeat"] }), // init
	];
	const evidence = collectWorkerPidEvidence(tasks);
	assert.deepEqual(evidence, [
		{ taskId: "t1", pid: 4242 },
		{ taskId: "t3", pid: 5151 },
	]);
});

test("reapOrphanWorkers: SIGTERMs alive, allowed, unprotected pids; skips the rest", () => {
	const killed: Array<{ pid: number; signal: string }> = [];
	const result = reapOrphanWorkers(
		[
			{ taskId: "a", pid: 1000 },
			{ taskId: "b", pid: 2000 },
			{ taskId: "c", pid: 3000 },
			{ taskId: "self", pid: process.pid },
			{ taskId: "init", pid: 1 },
		],
		{
			isAlive: (pid) => pid !== 2000, // 2000 is already dead
			kill: (pid, signal) => {
				killed.push({ pid, signal: String(signal) });
			},
			protectedPids: new Set([process.pid]),
			allowedPids: new Set([1000, 2000, 3000]), // authoritative orphan set
		},
	);

	assert.deepEqual(result.reaped, [1000, 3000]);
	assert.deepEqual(killed, [
		{ pid: 1000, signal: "SIGTERM" },
		{ pid: 3000, signal: "SIGTERM" },
	]);
	assert.ok(result.skipped.some((s) => s.pid === 2000 && s.reason === "already-dead"));
	assert.ok(result.skipped.some((s) => s.pid === process.pid && s.reason === "protected-self-or-ancestor"));
	assert.ok(result.skipped.some((s) => s.pid === 1 && s.reason === "invalid-or-init-pid"));
});

test("reapOrphanWorkers: a pid outside the authoritative orphan set is NEVER killed", () => {
	const killed: number[] = [];
	const result = reapOrphanWorkers([{ taskId: "a", pid: 7777 }], {
		isAlive: () => true,
		kill: (pid) => killed.push(pid),
		allowedPids: new Set([8888]),
	});
	assert.deepEqual(result.reaped, []);
	assert.deepEqual(killed, []);
	assert.deepEqual(result.skipped, [{ pid: 7777, reason: "not-an-authoritative-orphan" }]);
});

test("reapOrphanWorkers: dry-run reports candidates without killing", () => {
	const killed: number[] = [];
	const result = reapOrphanWorkers([{ taskId: "a", pid: 1234 }], {
		isAlive: () => true,
		kill: (pid) => killed.push(pid),
		dryRun: true,
	});
	assert.deepEqual(result.reaped, []);
	assert.deepEqual(result.candidates, [1234]);
	assert.deepEqual(killed, []);
});

test("reapRecordedWorkerOrphans: no recorded pid → no-op", () => {
	const result = reapRecordedWorkerOrphans([task({ id: "t1", status: "running" })]);
	assert.deepEqual(result.reaped, []);
	assert.deepEqual(result.candidates, []);
});
