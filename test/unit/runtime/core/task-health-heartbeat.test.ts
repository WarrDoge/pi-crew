/**
 * DR-04 W5 / L-6 (2026-10-16).
 *
 * `computeRunHealth` counted stalled tasks from `stalledSince` — a field with
 * no writer, so running-but-stuck tasks were never scored. Tasks already
 * carry `heartbeat.lastSeenAt`; stall is now derived from its age for RUNNING
 * tasks (no new writer). `stalledSince` remains as a legacy fallback.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { computeRunHealth } from "../../../../src/runtime/task-health.ts";

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

test("L-6: running task with stale heartbeat counts as stalled", () => {
	const health = computeRunHealth({
		runId: "r-stale",
		tasks: [
			{ id: "t1", status: "completed" },
			{ id: "t2", status: "running", heartbeat: { lastSeenAt: minutesAgo(10) } }, // > 5min threshold
		],
		createdAt: minutesAgo(30),
	});
	assert.ok(
		health.penalties.some((p) => p.reason === "stalled-tasks"),
		"stale heartbeat on a running task must score the stalled penalty",
	);
});

test("L-6: running task with fresh heartbeat is not stalled", () => {
	const health = computeRunHealth({
		runId: "r-fresh",
		tasks: [
			{ id: "t1", status: "running", heartbeat: { lastSeenAt: minutesAgo(1) } },
			{ id: "t2", status: "running", heartbeat: { lastSeenAt: minutesAgo(2) } },
		],
		createdAt: minutesAgo(30),
	});
	assert.equal(
		health.penalties.some((p) => p.reason === "stalled-tasks"),
		false,
		"fresh heartbeats must not count as stalled",
	);
});

test("L-6: non-running task with ancient heartbeat is not stalled (status gate)", () => {
	const health = computeRunHealth({
		runId: "r-done",
		tasks: [{ id: "t1", status: "completed", heartbeat: { lastSeenAt: minutesAgo(120) } }],
		createdAt: minutesAgo(180),
	});
	assert.equal(
		health.penalties.some((p) => p.reason === "stalled-tasks"),
		false,
		"terminal tasks cannot stall",
	);
});

test("L-6: legacy stalledSince fallback still scores running tasks without heartbeat", () => {
	const health = computeRunHealth({
		runId: "r-legacy",
		tasks: [{ id: "t1", status: "running", stalledSince: Date.now() - 600_000 }],
		createdAt: minutesAgo(30),
	});
	assert.ok(
		health.penalties.some((p) => p.reason === "stalled-tasks"),
		"legacy stalledSince path preserved",
	);
});
