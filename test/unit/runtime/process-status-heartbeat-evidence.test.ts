/**
 * Wave 15 (F1, GAP-0) — pure-logic tests for `hasFreshTaskHeartbeatEvidence`.
 *
 * The helper is the shared behavioral mirror of the watchdog's private
 * `hasFreshTaskHeartbeatEvidence` (foreground-watchdog.ts) and the
 * reconciler's `hasRecentActiveEvidence` (stale-reconciler.ts). Render call
 * sites OR it into their active-display / stale-label decisions (F2), so the
 * contract here must pin:
 *   - fresh heartbeat on ANY running/waiting task ⇒ true;
 *   - `heartbeat.alive === false` is an explicit dead mark — never evidence;
 *   - `agentProgress.lastActivityAt` is the fallback signal;
 *   - undefined / empty / all-terminal ⇒ false (fail-closed);
 *   - ttlMs override honored.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { hasFreshTaskHeartbeatEvidence } from "../../../src/runtime/process-status.ts";
import type { TeamTaskState, TeamTaskStatus } from "../../../src/state/types.ts";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const TTL_MS = 5 * 60 * 1000;

function makeTask(overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id: "task-01",
		runId: "run-01",
		role: "explorer",
		agent: "explorer",
		title: "explore",
		status: "running" as TeamTaskStatus,
		dependsOn: [],
		cwd: "/tmp/project",
		...overrides,
	};
}

test("h1: fresh heartbeat on a running task => true", () => {
	const tasks = [
		makeTask({
			status: "running",
			heartbeat: { workerId: "w1", lastSeenAt: new Date(NOW - 30_000).toISOString(), alive: true },
		}),
	];
	assert.equal(hasFreshTaskHeartbeatEvidence(tasks, NOW, TTL_MS), true);
});

test("h1: fresh heartbeat on a waiting task => true (waiting counts)", () => {
	const tasks = [
		makeTask({
			status: "waiting",
			heartbeat: { workerId: "w1", lastSeenAt: new Date(NOW - TTL_MS).toISOString() },
		}),
	];
	assert.equal(hasFreshTaskHeartbeatEvidence(tasks, NOW, TTL_MS), true);
});

test("h1: stale heartbeat (beyond ttl) => false", () => {
	const tasks = [
		makeTask({
			heartbeat: { workerId: "w1", lastSeenAt: new Date(NOW - TTL_MS - 1).toISOString(), alive: true },
		}),
	];
	assert.equal(hasFreshTaskHeartbeatEvidence(tasks, NOW, TTL_MS), false);
});

test("h1: heartbeat.alive === false vetoes even a fresh lastSeenAt", () => {
	const tasks = [
		makeTask({
			heartbeat: { workerId: "w1", lastSeenAt: new Date(NOW - 10_000).toISOString(), alive: false },
		}),
	];
	assert.equal(hasFreshTaskHeartbeatEvidence(tasks, NOW, TTL_MS), false);
});

test("h1: agentProgress.lastActivityAt fallback (no heartbeat) => true when fresh", () => {
	const tasks = [
		makeTask({
			heartbeat: undefined,
			agentProgress: { lastActivityAt: new Date(NOW - 60_000).toISOString() } as TeamTaskState["agentProgress"],
		}),
	];
	assert.equal(hasFreshTaskHeartbeatEvidence(tasks, NOW, TTL_MS), true);
});

test("h1: stale agentProgress fallback => false", () => {
	const tasks = [
		makeTask({
			agentProgress: { lastActivityAt: new Date(NOW - TTL_MS - 1).toISOString() } as TeamTaskState["agentProgress"],
		}),
	];
	assert.equal(hasFreshTaskHeartbeatEvidence(tasks, NOW, TTL_MS), false);
});

test("h1: undefined / empty / non-array => false (fail-closed)", () => {
	assert.equal(hasFreshTaskHeartbeatEvidence(undefined, NOW, TTL_MS), false);
	assert.equal(hasFreshTaskHeartbeatEvidence([], NOW, TTL_MS), false);
});

test("h1: terminal tasks with fresh heartbeat stamps are ignored", () => {
	for (const status of ["completed", "failed", "cancelled", "skipped"] as const) {
		const tasks = [
			makeTask({
				status,
				heartbeat: { workerId: "w1", lastSeenAt: new Date(NOW).toISOString(), alive: true },
			}),
		];
		assert.equal(hasFreshTaskHeartbeatEvidence(tasks, NOW, TTL_MS), false, `status=${status}`);
	}
});

test("h1: multi-task any-match (one fresh among many stale)", () => {
	const tasks = [
		makeTask({
			id: "task-stale",
			heartbeat: { workerId: "w1", lastSeenAt: new Date(NOW - TTL_MS - 60_000).toISOString() },
		}),
		makeTask({
			id: "task-fresh",
			status: "waiting",
			heartbeat: { workerId: "w2", lastSeenAt: new Date(NOW - 5_000).toISOString(), alive: true },
		}),
	];
	assert.equal(hasFreshTaskHeartbeatEvidence(tasks, NOW, TTL_MS), true);
});

test("h1: ttlMs override honored (tighter and looser)", () => {
	const tasks = [makeTask({ heartbeat: { workerId: "w1", lastSeenAt: new Date(NOW - 60_000).toISOString(), alive: true } })];
	assert.equal(hasFreshTaskHeartbeatEvidence(tasks, NOW, 30_000), false, "60s-old stamp is stale under a 30s ttl");
	assert.equal(hasFreshTaskHeartbeatEvidence(tasks, NOW, 120_000), true, "60s-old stamp is fresh under a 120s ttl");
});

test("h1: default ttl is AGENT_ACTIVITY_LIVENESS_MS (5 min)", () => {
	const tasks = [makeTask({ heartbeat: { workerId: "w1", lastSeenAt: new Date(NOW - 4 * 60 * 1000).toISOString(), alive: true } })];
	assert.equal(hasFreshTaskHeartbeatEvidence(tasks, NOW), true, "4 min < 5 min default");
	assert.equal(
		hasFreshTaskHeartbeatEvidence(
			[makeTask({ heartbeat: { workerId: "w1", lastSeenAt: new Date(NOW - 6 * 60 * 1000).toISOString(), alive: true } })],
			NOW,
		),
		false,
		"6 min > 5 min default",
	);
});
