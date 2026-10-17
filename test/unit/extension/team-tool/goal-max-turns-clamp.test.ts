/**
 * R3-SEC-1 rider (Wave-3): worker-supplied goal maxTurns is clamped to
 * LIMIT_CEILINGS.runtimeMaxTurns — a planted `maxTurns: 1e9` goal loop can no
 * longer spend unboundedly across turns (budgetTotal is separately guarded).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LIMIT_CEILINGS } from "../../../../src/config/config-validation.ts";
import { clampGoalMaxTurns } from "../../../../src/extension/team-tool/goal.ts";

test("clampGoalMaxTurns: 1e9 → ceiling", () => {
	assert.equal(clampGoalMaxTurns(1e9), LIMIT_CEILINGS.runtimeMaxTurns);
	assert.equal(clampGoalMaxTurns(Number.MAX_SAFE_INTEGER), LIMIT_CEILINGS.runtimeMaxTurns);
});

test("clampGoalMaxTurns: in-range + defaults", () => {
	assert.equal(clampGoalMaxTurns(5), 5);
	assert.equal(clampGoalMaxTurns(20), 20);
	assert.equal(clampGoalMaxTurns(LIMIT_CEILINGS.runtimeMaxTurns), LIMIT_CEILINGS.runtimeMaxTurns);
	assert.equal(clampGoalMaxTurns(undefined), 20, "default parity value");
	assert.equal(clampGoalMaxTurns(0), 20, "non-positive → default");
	assert.equal(clampGoalMaxTurns(-5), 20);
	assert.equal(clampGoalMaxTurns(Number.NaN), 20, "NaN → default");
});
