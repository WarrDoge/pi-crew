/**
 * P1 — usage-tracker 2-tier (U16 follow-up) unit tests.
 *
 * `LifetimeUsage` grows to 5 fields {input, output, cacheWrite, cacheRead,
 * cost} and the tracker round-trips all of them. `cost` is the D2 AGGREGATE
 * tier: always a NUMBER here — message-level cost OBJECTS must be pre-parsed
 * by the shared parser (`usageFromValue`, session-usage.ts) before reaching
 * `trackTaskUsage` (see usage-bridge.ts `trackUsageFromMessageEndEvent`).
 * Legacy deltas/states without the new fields must behave exactly as before.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { trackUsageFromMessageEndEvent } from "../../../src/runtime/live-session/usage-bridge.ts";
import {
	aggregateTrackedUsageForRun,
	clearAllTaskUsage,
	emptyLifetimeUsage,
	getTrackedTaskUsage,
	lifetimeUsageFromState,
	trackTaskUsage,
	usageStateFromLifetime,
} from "../../../src/runtime/usage-tracker.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";

test("emptyLifetimeUsage has all 5 ledger fields at 0", () => {
	assert.deepEqual(emptyLifetimeUsage(), { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
});

test("round-trip: multiple deltas incl. cacheRead + cost accumulate all 5 fields", () => {
	clearAllTaskUsage();
	trackTaskUsage("t1", { input: 10, output: 20, cacheWrite: 5, cacheRead: 100, cost: 0.5 });
	trackTaskUsage("t1", { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, cost: 0.25 });
	assert.deepEqual(getTrackedTaskUsage("t1"), { input: 11, output: 22, cacheWrite: 8, cacheRead: 104, cost: 0.75 });
});

test("usageStateFromLifetime keeps REAL cacheRead and cost (regression vs hard-coded 0)", () => {
	const state = usageStateFromLifetime({ input: 1, output: 2, cacheWrite: 3, cacheRead: 300, cost: 0.123 });
	assert.equal(state.input, 1);
	assert.equal(state.output, 2);
	assert.equal(state.cacheWrite, 3);
	assert.equal(state.cacheRead, 300, "cacheRead must survive the lifetime → state mapping (was hard-coded 0 pre-P1)");
	assert.equal(state.cost, 0.123, "cost must survive the lifetime → state mapping (was dropped pre-P1)");
});

test("lifetimeUsageFromState reads all 5 fields from UsageState", () => {
	assert.deepEqual(lifetimeUsageFromState({ input: 7, output: 8, cacheWrite: 9, cacheRead: 10, cost: 0.5 }), {
		input: 7,
		output: 8,
		cacheWrite: 9,
		cacheRead: 10,
		cost: 0.5,
	});
});

test("lifetimeUsageFromState defaults legacy states (no cacheRead/cost) to 0", () => {
	const legacy = lifetimeUsageFromState({ input: 7, output: 8, cacheWrite: 9 });
	assert.equal(legacy.cacheRead, 0);
	assert.equal(legacy.cost, 0);
	assert.equal(lifetimeUsageFromState(undefined).cost, 0);
});

test("aggregateTrackedUsageForRun sums tracked + task.usage incl. cacheRead/cost", () => {
	clearAllTaskUsage();
	trackTaskUsage("agg-a", { input: 10, output: 5, cacheWrite: 1, cacheRead: 50, cost: 0.25 });
	const manifest = { runId: "r-agg" } as unknown as TeamRunManifest;
	const tasks = [
		{ id: "agg-a", usage: { input: 1, output: 5, cacheWrite: 1, cacheRead: 2, cost: 0.5 } },
		{ id: "agg-b", usage: { input: 100, output: 100, cacheWrite: 10, cacheRead: 20, cost: 0.25 } },
	] as unknown as TeamTaskState[];
	const total = aggregateTrackedUsageForRun(manifest, tasks);
	assert.deepEqual(total, { input: 111, output: 110, cacheWrite: 12, cacheRead: 72, cost: 1 });
});

test("aggregateTrackedUsageForRun: task with NO usage still contributes tracked only", () => {
	clearAllTaskUsage();
	trackTaskUsage("agg-c", { input: 4, output: 4, cacheWrite: 4, cacheRead: 4, cost: 0.25 });
	const manifest = { runId: "r-agg2" } as unknown as TeamRunManifest;
	const tasks = [{ id: "agg-c" }, { id: "agg-d", usage: { input: 1 } }] as unknown as TeamTaskState[];
	assert.deepEqual(aggregateTrackedUsageForRun(manifest, tasks), {
		input: 5,
		output: 4,
		cacheWrite: 4,
		cacheRead: 4,
		cost: 0.25,
	});
});

test("legacy deltas without the new fields behave as before (cacheRead=0, cost=0)", () => {
	clearAllTaskUsage();
	trackTaskUsage("legacy", { input: 3, output: 4, cacheWrite: 5 });
	assert.deepEqual(getTrackedTaskUsage("legacy"), { input: 3, output: 4, cacheWrite: 5, cacheRead: 0, cost: 0 });
	const state = usageStateFromLifetime(getTrackedTaskUsage("legacy"));
	assert.equal(state.cacheRead, 0);
	assert.equal(state.cost, 0);
});

// ─── AC4 call-site coverage: usage-bridge feeds the tracker numeric cost ────

test("trackUsageFromMessageEndEvent (AC4): assistant message_end carries cacheRead + numeric cost (object total)", () => {
	clearAllTaskUsage();
	const event = {
		type: "message_end",
		message: {
			role: "assistant",
			usage: {
				input: 10,
				output: 5,
				cacheWrite: 2,
				cacheRead: 40,
				// Message-level cost OBJECT (@earendil-works/pi-ai Usage.cost) — the
				// bridge must land cost.total as a NUMBER in the tracker (D2 tier).
				cost: { input: 0.01, output: 0.02, cacheRead: 0.004, cacheWrite: 0.001, total: 0.035 },
			},
		},
	};
	trackUsageFromMessageEndEvent("bridge-1", event);
	assert.deepEqual(getTrackedTaskUsage("bridge-1"), {
		input: 10,
		output: 5,
		cacheWrite: 2,
		cacheRead: 40,
		cost: 0.035,
	});
});

test("trackUsageFromMessageEndEvent: non-assistant / non-message_end events contribute nothing", () => {
	clearAllTaskUsage();
	const usage = { input: 9, output: 9, cacheWrite: 9, cacheRead: 9, cost: 0.5 };
	trackUsageFromMessageEndEvent("bridge-2", { type: "message_end", message: { role: "user", usage } });
	trackUsageFromMessageEndEvent("bridge-2", { type: "turn_end", message: { role: "assistant", usage } });
	trackUsageFromMessageEndEvent("bridge-2", { type: "message_end", message: { role: "assistant" } });
	trackUsageFromMessageEndEvent("bridge-2", "not-an-object");
	assert.deepEqual(getTrackedTaskUsage("bridge-2"), emptyLifetimeUsage());
});
