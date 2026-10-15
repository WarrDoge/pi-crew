import assert from "node:assert/strict";
import test from "node:test";
import {
	clearAllTaskUsage,
	getRunUsage,
	getTaskUsage,
	MAX_TRACKED_TASK_USAGE,
	trackTaskUsage,
} from "../../../../src/runtime/usage-tracker.ts";

test("trackTaskUsage accumulates usage for same taskId", () => {
	clearAllTaskUsage();
	trackTaskUsage("task-1", { input: 10, output: 20, cacheWrite: 5 });
	trackTaskUsage("task-1", { input: 5, output: 10, cacheWrite: 3 });
	const usage = getTaskUsage("task-1");
	assert.equal(usage.input, 15);
	assert.equal(usage.output, 30);
	assert.equal(usage.cacheWrite, 8);
});

test("getTaskUsage returns zeros when no usage tracked", () => {
	clearAllTaskUsage();
	const usage = getTaskUsage("nonexistent-task");
	assert.equal(usage.input, 0);
	assert.equal(usage.output, 0);
	assert.equal(usage.cacheWrite, 0);
	// P1: the two new ledger fields default to 0 as well.
	assert.equal(usage.cacheRead, 0);
	assert.equal(usage.cost, 0);
});

test("getRunUsage aliases getTaskUsage", () => {
	clearAllTaskUsage();
	trackTaskUsage("task-2", { input: 100, output: 50, cacheWrite: 25 });
	assert.deepEqual(getRunUsage("task-2"), getTaskUsage("task-2"));
});

test("clearAllTaskUsage resets all tracked data", () => {
	clearAllTaskUsage();
	trackTaskUsage("task-a", { input: 1 });
	trackTaskUsage("task-b", { output: 2 });
	clearAllTaskUsage();
	// P1: LifetimeUsage now carries 5 fields — empty snapshots include cacheRead/cost = 0.
	assert.deepEqual(getTaskUsage("task-a"), {
		input: 0,
		output: 0,
		cacheWrite: 0,
		cacheRead: 0,
		cost: 0,
	});
	assert.deepEqual(getTaskUsage("task-b"), {
		input: 0,
		output: 0,
		cacheWrite: 0,
		cacheRead: 0,
		cost: 0,
	});
});

test("concurrent tracking does not lose increments (simulate rapid sequential calls)", () => {
	clearAllTaskUsage();
	const taskId = "rapid-task";
	for (let i = 0; i < 1000; i++) {
		trackTaskUsage(taskId, { input: 1, output: 1, cacheWrite: 1 });
	}
	const usage = getTaskUsage(taskId);
	assert.equal(usage.input, 1000);
	assert.equal(usage.output, 1000);
	assert.equal(usage.cacheWrite, 1000);
});

test("taskUsageMap is FIFO-capped at MAX_TRACKED_TASK_USAGE (DR-02 C2)", () => {
	clearAllTaskUsage();
	const total = Math.floor(MAX_TRACKED_TASK_USAGE * 1.5); // 7_500 = 1.5x cap
	for (let i = 0; i < total; i++) trackTaskUsage(`cap-${i}`, { input: 1, output: 2 });
	assert.equal(getTaskUsage("cap-0").input, 0, "oldest entry must be evicted (FIFO)");
	const firstKept = total - MAX_TRACKED_TASK_USAGE;
	assert.equal(getTaskUsage(`cap-${firstKept - 1}`).input, 0, "exactly the first (total-cap) entries must be evicted");
	assert.equal(getTaskUsage(`cap-${firstKept}`).input, 1, "first kept entry survives");
	assert.equal(getTaskUsage(`cap-${total - 1}`).output, 2, "newest entry survives");
	// clear semantics unchanged by the cap.
	clearAllTaskUsage();
	assert.equal(getTaskUsage(`cap-${total - 1}`).input, 0, "clearAllTrackedTaskUsage must still wipe everything");
});

test("FIFO order is first-INSERTED, not last-touched (Map.set keeps insertion order) (DR-02 C2)", () => {
	clearAllTaskUsage();
	trackTaskUsage("old-task", { input: 1 });
	// Re-track the old task after churn — Map.set on an EXISTING key does not
	// move it to the back, so it stays first in FIFO order.
	for (let i = 0; i < 100; i++) trackTaskUsage(`churn-a-${i}`, { input: 1 });
	trackTaskUsage("old-task", { input: 1 });
	const total = Math.floor(MAX_TRACKED_TASK_USAGE * 1.5);
	for (let i = 0; i < total; i++) trackTaskUsage(`churn-b-${i}`, { input: 1 });
	assert.equal(getTaskUsage("old-task").input, 0, "first-inserted task is evicted even when re-tracked later");
	assert.ok(getTaskUsage(`churn-b-${total - 1}`).input >= 1, "newest churn entry survives");
	clearAllTaskUsage();
});
