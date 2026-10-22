/**
 * usage-reconcile.test.ts — W10-7 (v0.11.38) pin.
 *
 * pi-subagents lesson #14 (usage-reconciliation): every model attempt's own
 * usage is captured (ModelAttemptSummary.usage, populated per attempt in
 * child-executor) and post-execution reconciles the SUM against the final
 * run's usage — failed fallback attempts burned real tokens that task.usage
 * alone never shows. Observability note only, never a task failure.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ModelAttemptSummary } from "../../../../src/runtime/model/model-fallback.ts";
import { reconcileUsage } from "../../../../src/runtime/task-runner/post-execution.ts";
import type { ModelAttemptState, UsageState } from "../../../../src/state/types.ts";

function attempt(model: string, usage?: UsageState): ModelAttemptSummary {
	return { model, success: true, ...(usage ? { usage } : {}) };
}

describe("W10-7 reconcileUsage", () => {
	it("(1) single attempt → never reconciles", () => {
		assert.equal(reconcileUsage([attempt("m1", { cost: 1 })], { cost: 1 }), undefined);
	});

	it("(2) two attempts, task.usage shows only the FINAL run → gap surfaces", () => {
		const note = reconcileUsage([attempt("m1", { cost: 0.5 }), attempt("m2", { cost: 0.5 })], { cost: 0.5 });
		assert.ok(note);
		assert.equal(note.usageReconcile.attemptTotalCostUsd, 1);
		assert.equal(note.usageReconcile.finalRunCostUsd, 0.5);
		assert.ok(note.usageReconcile.deltaPct >= 49 && note.usageReconcile.deltaPct <= 51);
		assert.equal(note.usageReconcile.attemptsWithUsage, 2);
	});

	it("(3) attempts without usage numbers → undefined", () => {
		assert.equal(reconcileUsage([attempt("m1"), attempt("m2")], { cost: 1 }), undefined);
	});

	it("(4) within 5% → no note", () => {
		assert.equal(reconcileUsage([attempt("m1", { cost: 1 }), attempt("m2", { cost: 1 })], { cost: 1.98 }), undefined);
	});

	it("(5) FAILED attempt's cost counts (the whole point)", () => {
		const attempts: ModelAttemptSummary[] = [
			{ model: "m1", success: false, error: "x", usage: { cost: 2 } },
			attempt("m2", { cost: 1 }),
		];
		const note = reconcileUsage(attempts, { cost: 1 });
		assert.ok(note);
		assert.equal(note.usageReconcile.attemptTotalCostUsd, 3);
		assert.ok(note.usageReconcile.deltaPct > 60); // 3.0 vs 1.0 → ~66.7%
	});

	it("(6) no attempts / empty → undefined", () => {
		assert.equal(reconcileUsage(undefined, { cost: 1 }), undefined);
		assert.equal(reconcileUsage([], { cost: 1 }), undefined);
	});

	it("(7) ModelAttemptState carries usage (state-layer mirror)", () => {
		const state: ModelAttemptState = { model: "m", success: true, usage: { cost: 1 } };
		assert.equal(state.usage?.cost, 1);
	});
});
