import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TeamTaskState } from "../../src/state/types.ts";
import { aggregateUsage, aggregateUsageByRole, formatUsage } from "../../src/state/usage.ts";

function makeTask(usage?: Partial<Record<string, number>>, role = "agent"): TeamTaskState {
	return {
		id: "01_task",
		runId: "run-1",
		role,
		agent: "default",
		title: "Test task",
		status: "completed",
		dependsOn: [],
		cwd: "/tmp",
		usage: usage
			? {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					cost: usage.cost,
					turns: usage.turns,
				}
			: undefined,
	};
}

describe("aggregateUsageByRole", () => {
	it("sums cacheRead per-role across tasks (ledger 5-field consistency)", () => {
		const tasks = [
			makeTask({ input: 10, cacheRead: 100, cost: 0.2 }, "agent"),
			makeTask({ input: 20, cacheRead: 50, cost: 0.3 }, "agent"),
			makeTask({ input: 5, cacheRead: 7, cost: 0.1 }, "explorer"),
		];
		const byRole = aggregateUsageByRole(tasks);
		assert.equal(byRole.length, 2);
		const agent = byRole.find((r) => r.role === "agent");
		const explorer = byRole.find((r) => r.role === "explorer");
		assert.ok(agent);
		assert.ok(explorer);
		assert.equal(agent.cacheRead, 150);
		assert.equal(agent.input, 30);
		assert.equal(agent.cost, 0.5);
		assert.equal(agent.taskCount, 2);
		assert.equal(explorer.cacheRead, 7);
		assert.equal(explorer.taskCount, 1);
	});

	it("defaults cacheRead to 0 in the bucket when tasks have no usage", () => {
		const byRole = aggregateUsageByRole([makeTask(undefined, "agent")]);
		assert.equal(byRole.length, 1);
		assert.equal(byRole[0].cacheRead, 0);
		assert.equal(byRole[0].taskCount, 1);
	});
});

describe("aggregateUsage", () => {
	it("returns undefined for empty task list", () => {
		assert.equal(aggregateUsage([]), undefined);
	});

	it("returns undefined when no tasks have usage", () => {
		assert.equal(aggregateUsage([makeTask()]), undefined);
	});

	it("aggregates usage from multiple tasks", () => {
		const tasks = [
			makeTask({ input: 100, output: 50, cost: 0.5, turns: 3 }),
			makeTask({ input: 200, output: 80, cost: 1.0, turns: 5 }),
		];
		const agg = aggregateUsage(tasks);
		assert.ok(agg);
		assert.equal(agg.input, 300);
		assert.equal(agg.output, 130);
		assert.equal(agg.cost, 1.5);
		assert.equal(agg.turns, 8);
	});

	it("handles tasks with partial usage fields", () => {
		const tasks = [makeTask({ input: 10 }), makeTask({ output: 20 })];
		const agg = aggregateUsage(tasks);
		assert.ok(agg);
		assert.equal(agg.input, 10);
		assert.equal(agg.output, 20);
		assert.equal(agg.cacheRead, 0);
	});

	it("skips tasks without usage property", () => {
		const tasks = [makeTask(), makeTask({ input: 50 })];
		const agg = aggregateUsage(tasks);
		assert.ok(agg);
		assert.equal(agg.input, 50);
	});
});

describe("formatUsage", () => {
	it("returns '(none)' for undefined usage", () => {
		assert.equal(formatUsage(undefined), "(none)");
	});

	it("formats all available fields", () => {
		const result = formatUsage({
			input: 100,
			output: 50,
			cacheRead: 30,
			cacheWrite: 10,
			cost: 0.123456,
			turns: 5,
		});
		assert.ok(result.includes("input=100"));
		assert.ok(result.includes("output=50"));
		assert.ok(result.includes("cacheRead=30"));
		assert.ok(result.includes("cacheWrite=10"));
		assert.ok(result.includes("cost=0.123456"));
		assert.ok(result.includes("turns=5"));
	});

	it("omits fields that are undefined", () => {
		const result = formatUsage({ input: 100 });
		assert.ok(result.includes("input=100"));
		assert.ok(!result.includes("output="));
		assert.ok(!result.includes("cost="));
	});
});
