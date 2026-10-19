/**
 * EP3 residual (wave-6 M4-R2) — the alive-reparented orphan must be reclaimable.
 *
 * A host SIGKILL reparents its worker to PID 1; the orphan keeps answering
 * kill(pid,0), so the pre-fix `isTaskHeartbeatStale` gate (`if (taskPid &&
 * pidAlive) return false`) pinned the task as healthy FOREVER and the reaper
 * never ran (runtime-proven: still burning a worker slot at +40 min). The gate
 * is now capped (ALIVE_PID_TRUST_CAP_MS = 30 min, mirroring process-status.ts
 * STALE_ACTIVE_RUN_MS): past the cap an alive pid is treated as a
 * recycled/reparented orphan, not a mid-turn worker.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileStaleRun } from "../../../src/runtime/stale-reconciler.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";

const baseManifest: TeamRunManifest = {
	schemaVersion: 1,
	runId: "run-reparent-1",
	cwd: "/tmp",
	team: "impl",
	goal: "test",
	status: "running",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	stateRoot: "/tmp",
	artifactsRoot: "/tmp",
	tasksPath: "/tmp/tasks.json",
	eventsPath: "/tmp/events.jsonl",
	workspaceMode: "single",
	artifacts: [],
};

const runningTask: TeamTaskState = {
	id: "task-1",
	runId: "run-reparent-1",
	role: "executor",
	agent: "test-agent",
	title: "Test task",
	status: "running",
	dependsOn: [],
	cwd: "/tmp",
};

describe("stale-reconciler — alive-reparented orphan (EP3 residual)", () => {
	it("reclaims a no-PID run whose running task has an ALIVE pid past the trust cap", () => {
		const now = Date.now();
		const fortyMinAgo = new Date(now - 40 * 60 * 1000).toISOString();
		const manifest: TeamRunManifest = { ...baseManifest, updatedAt: fortyMinAgo };
		const task: TeamTaskState = {
			...runningTask,
			// Alive pid (this process) + a heartbeat frozen 40 min ago = the
			// reparented-orphan shape: kill(pid,0) answers, but no real worker
			// progress. Pre-fix the alive gate returned "not stale" forever.
			heartbeat: { workerId: "task-1", lastSeenAt: fortyMinAgo, alive: true, pid: process.pid },
		};

		const result = reconcileStaleRun(manifest, [task], now);

		assert.equal(result.verdict, "no_status");
		assert.equal(result.repaired, true, "the reparented orphan must be reclaimed (was pinned healthy forever)");
		assert.equal(result.repairedTasks?.[0]?.status, "cancelled");
		assert.match(result.repairedTasks?.[0]?.error ?? "", /no_pid_heartbeat_stale/);
	});

	it("still preserves a live worker whose heartbeat is stale but WITHIN the cap (no over-trigger)", () => {
		const now = Date.now();
		const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
		const manifest: TeamRunManifest = { ...baseManifest, updatedAt: tenMinAgo };
		const task: TeamTaskState = {
			...runningTask,
			// Alive pid + 10-min-frozen heartbeat (< 30-min cap) = a plausible
			// slow LLM turn mid-run — must NOT be repaired (F1 part 2 contract).
			heartbeat: { workerId: "task-1", lastSeenAt: tenMinAgo, alive: true, pid: process.pid },
		};

		const result = reconcileStaleRun(manifest, [task], now);

		assert.equal(result.verdict, "no_status");
		assert.equal(result.repaired, false, "a fresh-alive pid within the trust cap must still be preserved");
	});
});
