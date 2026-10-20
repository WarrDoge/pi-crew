/**
 * Unit tests for ChainRunner.
 * @see src/runtime/chain-runner.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	ChainRunner,
	type ChainSpec,
	type ChainTaskRunner,
	createChainRunner,
	parseChainString,
} from "../../../src/runtime/chain-runner.ts";
import { HandoffManager, type TaskPacket, type TaskResult } from "../../../src/runtime/handoff-manager.ts";

// Test helpers
function createTaskResult(overrides: Partial<TaskResult> = {}): TaskResult {
	return {
		outcome: "success",
		usage: { totalTokens: 1000 },
		duration: 1000,
		iterations: 1,
		toolsUsed: [],
		blockers: [],
		nextSteps: [],
		filesCreated: [],
		filesModified: [],
		filesDeleted: [],
		decisions: [],
		...overrides,
	};
}

function createMockTaskRunner(): ChainTaskRunner {
	let callCount = 0;
	return {
		runTask: async (packet: TaskPacket) => {
			callCount++;
			return createTaskResult({ outcome: "success" });
		},
	};
}

function createMockHandoffManager(): HandoffManager {
	return new HandoffManager();
}

// Mock HandoffManager that tracks calls
function createTrackingHandoffManager() {
	const calls: Array<{ packet: TaskPacket; result: TaskResult }> = [];
	const manager = {
		generateSummary: async (packet: TaskPacket, result: TaskResult) => {
			calls.push({ packet, result });
			return {
				taskId: packet.taskId,
				runId: packet.runId,
				timestamp: Date.now(),
				task: packet.goal,
				outcome: result.outcome,
				filesCreated: [],
				filesModified: [],
				filesDeleted: [],
				decisions: [],
				blockers: [],
				nextSteps: [],
				metrics: {
					tokensUsed: result.usage?.totalTokens ?? 0,
					duration: result.duration ?? 0,
					iterations: 1,
					toolsUsed: [],
				},
				contextSnapshot: "",
			};
		},
	} as unknown as HandoffManager;
	return { manager, calls };
}

// Parse chain tests
test("ChainRunner - parseChain handles simple team references", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@research -> @implement -> @review");

	assert.strictEqual(spec.steps.length, 3);
	assert.strictEqual(spec.steps[0].team, "research");
	assert.strictEqual(spec.steps[1].team, "implement");
	assert.strictEqual(spec.steps[2].team, "review");
});

test("ChainRunner - parseChain handles workflow references", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("workflow:build -> workflow:test");

	assert.strictEqual(spec.steps.length, 2);
	assert.strictEqual(spec.steps[0].workflow, "build");
	assert.strictEqual(spec.steps[1].workflow, "test");
});

test("ChainRunner - parseChain handles template references", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("template:planning -> template:execution");

	assert.strictEqual(spec.steps.length, 2);
	assert.strictEqual(spec.steps[0].template, "planning");
	assert.strictEqual(spec.steps[1].template, "execution");
});

test("ChainRunner - parseChain handles inline goals", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain('"Research AI trends" -> "Analyze findings"');

	assert.strictEqual(spec.steps.length, 2);
	assert.strictEqual(spec.steps[0].inlineGoal, "Research AI trends");
	assert.strictEqual(spec.steps[1].inlineGoal, "Analyze findings");
});

test("ChainRunner - parseChain handles inline goals containing arrow", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain('"Change A -> B" -> "Analyze result"');

	assert.strictEqual(spec.steps.length, 2);
	assert.strictEqual(spec.steps[0].inlineGoal, "Change A -> B");
	assert.strictEqual(spec.steps[1].inlineGoal, "Analyze result");
});

test("ChainRunner - parseChain extracts per-step model override", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 --model claude-opus-3 -> @step2");

	assert.strictEqual(spec.steps[0].model, "claude-opus-3");
	assert.strictEqual(spec.steps[1].model, undefined);
});

test("ChainRunner - parseChain handles team ref with arrow in inline goal", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain('@team "Convert X -> Y" -> @review');

	assert.strictEqual(spec.steps.length, 2);
	assert.strictEqual(spec.steps[0].team, "team");
	assert.strictEqual(spec.steps[0].inlineGoal, "Convert X -> Y");
	assert.strictEqual(spec.steps[1].team, "review");
});

test("ChainRunner - parseChain extracts per-step skill override", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@research --skill coding -> @implement");

	assert.strictEqual(spec.steps[0].skill, "coding");
	assert.strictEqual(spec.steps[1].skill, undefined);
});

test("ChainRunner - parseChain extracts thinking mode", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 --thinking deep -> @step2 --thinking fast");

	assert.strictEqual(spec.steps[0].thinking, "deep");
	assert.strictEqual(spec.steps[1].thinking, "fast");
});

test("ChainRunner - parseChain extracts timeout", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 --timeout 30 -> @step2");

	assert.strictEqual(spec.steps[0].timeout, 30000); // 30 seconds in ms
	assert.strictEqual(spec.steps[1].timeout, undefined);
});

test("ChainRunner - parseChain extracts global model", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 -> @step2 --global-model claude-sonnet-4");

	assert.strictEqual(spec.globalModel, "claude-sonnet-4");
	assert.strictEqual(spec.steps[0].model, undefined);
	assert.strictEqual(spec.steps[1].model, undefined);
});

test("ChainRunner - parseChain extracts global skill", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 --global-skill writing -> @step2");

	assert.strictEqual(spec.globalSkill, "writing");
});

test("ChainRunner - parseChain extracts continueOnError", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 -> @step2 --continue-on-error true");

	assert.strictEqual(spec.continueOnError, true);
});

test("ChainRunner - parseChain assigns names to steps", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@research -> @implement");

	assert.strictEqual(spec.steps[0].name, "@research");
	assert.strictEqual(spec.steps[1].name, "@implement");
});

test("ChainRunner - parseChain handles step with only overrides", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 --model opus --skill coding");

	assert.strictEqual(spec.steps.length, 1);
	assert.strictEqual(spec.steps[0].team, "step1");
	assert.strictEqual(spec.steps[0].model, "opus");
	assert.strictEqual(spec.steps[0].skill, "coding");
});

// Run chain tests
test("ChainRunner - runChain executes all steps sequentially", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);

	const spec = runner.parseChain("@step1 -> @step2 -> @step3");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps.length, 3);
	assert.strictEqual(result.success, true);
});

test("ChainRunner - runChain stops on failure by default", async () => {
	const { manager, calls } = createTrackingHandoffManager();

	let stepIndex = 0;
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			stepIndex++;
			if (stepIndex === 2) {
				return createTaskResult({ outcome: "failure" });
			}
			return createTaskResult();
		},
	};

	const runner = new ChainRunner(mockRunner, manager);
	const spec = runner.parseChain("@step1 -> @step2 -> @step3");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps.length, 2);
	assert.strictEqual(result.success, false);
	assert.strictEqual(result.steps[1].outcome, "failure");
});

test("ChainRunner - runChain continues on error when continueOnError is true", async () => {
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			return createTaskResult({ outcome: "failure" });
		},
	};
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);

	const spec = runner.parseChain("@step1 -> @step2 -> @step3");
	spec.continueOnError = true;

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps.length, 3);
	assert.strictEqual(result.success, false);
});

test("ChainRunner - runChain passes handoffs between steps", async () => {
	const { manager, calls } = createTrackingHandoffManager();

	const mockRunner = createMockTaskRunner();
	const runner = new ChainRunner(mockRunner, manager);
	const spec = runner.parseChain("@step1 -> @step2");

	const result = await runner.runChain(spec);

	// One handoff per step (for next step)
	assert.strictEqual(result.totalHandoffs.length, 2);
});

test("ChainRunner - runChain enriches context with chain history", async () => {
	const { manager } = createTrackingHandoffManager();

	const receivedPackets: TaskPacket[] = [];
	const mockRunner: ChainTaskRunner = {
		runTask: async (packet: TaskPacket) => {
			receivedPackets.push(packet);
			return createTaskResult();
		},
	};

	const runner = new ChainRunner(mockRunner, manager);
	const spec = runner.parseChain("@step1 -> @step2");

	await runner.runChain(spec);

	// Second step should have chain history
	assert.ok(receivedPackets[1].context?.__chainHistory);
});

test("ChainRunner - runChain calculates total duration", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@step1");

	const result = await runner.runChain(spec);

	assert.ok(result.totalDuration >= 0);
});

test("ChainRunner - runChain calculates total tokens", async () => {
	const { manager } = createTrackingHandoffManager();

	let callCount = 0;
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			callCount++;
			return createTaskResult({
				usage: { totalTokens: callCount * 1000 },
			});
		},
	};

	const runner = new ChainRunner(mockRunner, manager);
	const spec = runner.parseChain("@step1 -> @step2 -> @step3");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.totalTokens, 6000); // 1000 + 2000 + 3000
});

test("ChainRunner - runChain applies step overrides global config", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);

	const spec = runner.parseChain("@step1 --model opus -> @step2");
	spec.globalModel = "sonnet";

	// Step 1 should use opus, step 2 should use sonnet (global)
	// Since our mock doesn't check model, we just verify parsing worked
	assert.strictEqual(spec.steps[0].model, "opus");
	assert.strictEqual(spec.steps[1].model, undefined); // Inherits from global at runtime
});

test("ChainRunner - runChain handles single step", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@only-step");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps.length, 1);
	assert.strictEqual(result.success, true);
});

test("ChainRunner - runChain uses initial context", async () => {
	const { manager } = createTrackingHandoffManager();

	const receivedPackets: TaskPacket[] = [];
	const mockRunner: ChainTaskRunner = {
		runTask: async (packet: TaskPacket) => {
			receivedPackets.push(packet);
			return createTaskResult();
		},
	};

	const runner = new ChainRunner(mockRunner, manager);
	const spec = runner.parseChain("@step1");

	await runner.runChain(spec, { customKey: "customValue" });

	// Initial context should be passed
	assert.ok(receivedPackets[0].context);
});

// parseChainString utility tests
test("parseChainString parses simple chain", () => {
	const spec = parseChainString("@team1 -> @team2");

	assert.strictEqual(spec.steps.length, 2);
	assert.strictEqual(spec.steps[0].team, "team1");
});

test("parseChainString handles complex syntax", () => {
	const spec = parseChainString('"Goal 1" --model opus --timeout 60 -> "Goal 2" --global-model sonnet');

	assert.strictEqual(spec.steps.length, 2);
	assert.strictEqual(spec.steps[0].inlineGoal, "Goal 1");
	assert.strictEqual(spec.steps[0].model, "opus");
	assert.strictEqual(spec.steps[0].timeout, 60000);
	assert.strictEqual(spec.steps[1].inlineGoal, "Goal 2");
	assert.strictEqual(spec.globalModel, "sonnet");
});

test("parseChainString handles whitespace", () => {
	const spec = parseChainString("  @step1  ->  @step2  ");

	assert.strictEqual(spec.steps.length, 2);
	assert.strictEqual(spec.steps[0].name, "@step1");
});

// createChainRunner factory test
test("createChainRunner creates instance", () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = createChainRunner(mockRunner, handoffManager);

	assert.ok(runner instanceof ChainRunner);
});

// Error handling tests
test("ChainRunner - runChain handles runner errors", async () => {
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			throw new Error("Runner failed");
		},
	};
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@step1");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.success, false);
	assert.strictEqual(result.steps.length, 1);
	assert.strictEqual(result.steps[0].error, "Runner failed");
	assert.strictEqual(result.steps[0].outcome, "failure");
});

test("ChainRunner - runChain propagates error message", async () => {
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			throw new Error("Specific error message");
		},
	};
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@step1");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps[0].error, "Specific error message");
});

// Edge cases
test("ChainRunner - parseChain handles empty step gracefully", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@valid");

	assert.strictEqual(spec.steps.length, 1);
	assert.strictEqual(spec.steps[0].team, "valid");
});

test("ChainRunner - parseChain handles step with only flags", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("--model opus");

	assert.strictEqual(spec.steps.length, 1);
	assert.strictEqual(spec.steps[0].name, "--model");
});

test("ChainRunner - runChain handles undefined inlineGoal", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);

	const spec: ChainSpec = {
		steps: [{ name: "no-inline-goal" }],
	};

	const result = await runner.runChain(spec);

	assert.strictEqual(result.success, true);
	assert.strictEqual(result.steps[0].outcome, "success");
});

test("ChainRunner - runChain continues when step continueOnError is true", async () => {
	const mockRunner: ChainTaskRunner = {
		runTask: async () => createTaskResult({ outcome: "failure" }),
	};
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@step1 -> @step2");
	spec.steps[0].continueOnError = true;

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps.length, 2);
});

test("ChainRunner - runChain tracks step index correctly", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@a -> @b -> @c");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps[0].step, 1);
	assert.strictEqual(result.steps[1].step, 2);
	assert.strictEqual(result.steps[2].step, 3);
});

test("ChainRunner - runChain preserves step names in results", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@research -> @implementation");

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps[0].name, "@research");
	assert.strictEqual(result.steps[1].name, "@implementation");
});

test("ChainRunner - runChain handles step with both team and inlineGoal", async () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain('@team1 "with inline goal" -> @team2');

	// Last match wins - inlineGoal takes precedence
	assert.strictEqual(spec.steps[0].team, "team1");
	assert.strictEqual(spec.steps[0].inlineGoal, "with inline goal");
});

test("ChainRunner - parseChain normalizes thinking mode values", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step --thinking fast");

	assert.strictEqual(spec.steps[0].thinking, "fast");
});

test("ChainRunner - parseChain ignores invalid thinking mode", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step --thinking invalid");

	assert.strictEqual(spec.steps[0].thinking, undefined);
});

test("ChainRunner - runChain step result includes handoff", async () => {
	const { manager } = createTrackingHandoffManager();
	const mockRunner = createMockTaskRunner();
	const runner = new ChainRunner(mockRunner, manager);
	const spec = runner.parseChain("@step1");

	const result = await runner.runChain(spec);

	assert.ok(result.steps[0].handoff !== undefined);
	assert.strictEqual(result.steps[0].handoff?.taskId, "chain-step-0");
});

test("ChainRunner - runChain step result duration is positive", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec = runner.parseChain("@step1");

	const result = await runner.runChain(spec);

	assert.ok(result.steps[0].duration >= 0);
});

test("ChainRunner - runChain empty spec produces empty results", async () => {
	const mockRunner = createMockTaskRunner();
	const handoffManager = createMockHandoffManager();
	const runner = new ChainRunner(mockRunner, handoffManager);
	const spec: ChainSpec = { steps: [] };

	const result = await runner.runChain(spec);

	assert.strictEqual(result.steps.length, 0);
	// R14-C5: vacuous truth was part of the same false-green bug — a chain that
	// ran nothing did not succeed.
	assert.strictEqual(result.success, false);
});

// ── R14-C1 / R14-C5 pins (wave-6 M3-18) ────────────────────────────────

test("ChainRunner - R14-C1: parallel() members become sequential steps (not dropped)", async () => {
	const goals: string[] = [];
	const mockRunner: ChainTaskRunner = {
		runTask: async (packet: TaskPacket) => {
			goals.push(packet.goal);
			return createTaskResult();
		},
	};
	const runner = new ChainRunner(mockRunner, createMockHandoffManager());

	const spec = runner.parseChain("a -> parallel(b, c) -> d");
	assert.deepStrictEqual(
		spec.steps.map((s) => s.name),
		["a", "b", "c", "d"],
	);

	const result = await runner.runChain(spec);

	// Every member actually executed — previously the group collapsed into ONE step
	// literally named "parallel" and b/c never ran.
	assert.deepStrictEqual(goals, ["a", "b", "c", "d"]);
	assert.strictEqual(result.steps.length, 4);
	assert.strictEqual(result.success, true);
});

test("ChainRunner - R14-C1: nested parallel groups flatten in source order", async () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("a -> parallel(b, parallel(c, d)) -> e");

	assert.deepStrictEqual(
		spec.steps.map((s) => s.name),
		["a", "b", "c", "d", "e"],
	);
});

test("ChainRunner - R14-C1: @team refs survive inside parallel()", async () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@a -> parallel(@b, @c) -> @d");

	assert.deepStrictEqual(
		spec.steps.map((s) => s.team),
		["a", "b", "c", "d"],
	);
});

test("ChainRunner - R14-C1/C5: a failing parallel member is visible and fails the chain", async () => {
	// member index 2 ("c") comes back partial — the rest of the chain must stop and
	// the chain must NOT be reported as a success.
	let call = 0;
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			call++;
			return createTaskResult({ outcome: call === 3 ? "partial" : "success" });
		},
	};
	const runner = new ChainRunner(mockRunner, createMockHandoffManager());

	const result = await runner.runChain(runner.parseChain("a -> parallel(b, c) -> d"));

	assert.strictEqual(call, 3); // "d" not executed
	assert.strictEqual(result.steps.length, 3);
	assert.strictEqual(result.steps[2]?.name, "c");
	assert.strictEqual(result.steps[2]?.outcome, "partial");
	assert.strictEqual(result.success, false);
});

test("ChainRunner - R14-C5: early break on a partial outcome is NOT success (false-green)", async () => {
	let call = 0;
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			call++;
			return createTaskResult({ outcome: call === 2 ? "partial" : "success" });
		},
	};
	const runner = new ChainRunner(mockRunner, createMockHandoffManager());

	const result = await runner.runChain(runner.parseChain("a -> b -> c"));

	assert.strictEqual(call, 2); // "c" never ran (break on non-success)
	assert.strictEqual(result.steps.length, 2);
	assert.strictEqual(result.steps[1]?.outcome, "partial");
	// Pre-fix this was true ("Chain completed", status ok) with step 3 unexecuted.
	assert.strictEqual(result.success, false);
});

test("ChainRunner - parseChain handles trailing arrow", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const spec = runner.parseChain("@step1 -> @step2 ->");

	assert.strictEqual(spec.steps.length, 3); // Empty step created
});

// ─── v0.11.27 (R14-C1 tail): `:N` iterations, args, --with-context ────────

test("ChainRunner - v0.11.27: `:3` executes three sequential iterations, each visible", async () => {
	let call = 0;
	const names: string[] = [];
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			call++;
			return createTaskResult({ outputText: `out-${call}` });
		},
	};
	const runner = new ChainRunner(mockRunner, createMockHandoffManager());

	const spec = runner.parseChain("warmup -> polish:3");
	assert.equal(spec.steps[1]?.context?.loopCount, 3, "DSL path maps :3 to context.loopCount");

	const result = await runner.runChain(spec);
	void names;

	assert.equal(call, 4, "1 warmup + 3 polish iterations");
	assert.deepStrictEqual(
		result.steps.map((s) => s.name),
		["warmup", "polish", "polish#2", "polish#3"],
		"iterations >1 are suffixed #k so each stays visible",
	);
	assert.equal(result.success, true);
});

test("ChainRunner - v0.11.27: failure inside a loop breaks the chain (no unexecuted-iteration false-green)", async () => {
	let call = 0;
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			call++;
			return createTaskResult({ outcome: call === 2 ? "failure" : "success" });
		},
	};
	const runner = new ChainRunner(mockRunner, createMockHandoffManager());

	const result = await runner.runChain(runner.parseChain("polish:3"));

	assert.equal(call, 2, "iteration #3 never ran");
	assert.equal(result.steps.length, 2);
	assert.equal(result.steps[1]?.name, "polish#2");
	assert.equal(result.steps[1]?.outcome, "failure");
	assert.equal(result.success, false, "planned=3 executions, only 2 ran");
});

test("ChainRunner - v0.11.27: continueOnError runs remaining iterations despite a failure", async () => {
	let call = 0;
	const mockRunner: ChainTaskRunner = {
		runTask: async () => {
			call++;
			return createTaskResult({ outcome: call === 2 ? "failure" : "success" });
		},
	};
	const runner = new ChainRunner(mockRunner, createMockHandoffManager());

	const spec = runner.parseChain("polish:3");
	spec.continueOnError = true;
	const result = await runner.runChain(spec);

	assert.equal(call, 3, "all iterations ran");
	assert.equal(result.steps.length, 3);
	assert.equal(result.success, false, "the failed iteration still fails the chain");
});

test("ChainRunner - v0.11.27: DSL positional args append to the step goal", async () => {
	const goals: string[] = [];
	const mockRunner: ChainTaskRunner = {
		runTask: async (packet: TaskPacket) => {
			goals.push(packet.goal);
			return createTaskResult();
		},
	};
	const runner = new ChainRunner(mockRunner, createMockHandoffManager());

	// --with-context forces the DSL path; the quoted string is a positional arg.
	await runner.runChain(runner.parseChain('start -> work --with-context "final-report.md"'));

	assert.equal(goals[1], "work final-report.md", "args join the step goal");
	assert.equal(goals[0], "start");
});

test("ChainRunner - v0.11.27: --with-context passes the previous step's FULL output", async () => {
	const captured: Array<Record<string, unknown> | undefined> = [];
	let call = 0;
	const mockRunner: ChainTaskRunner = {
		runTask: async (packet: TaskPacket) => {
			call++;
			captured.push(packet.context);
			return createTaskResult({ outputText: call === 1 ? "FULL-PREV-OUTPUT" : "second" });
		},
	};
	const runner = new ChainRunner(mockRunner, createMockHandoffManager());

	await runner.runChain(runner.parseChain("produce -> consume --with-context"));
	assert.equal(captured[1]?.__chainPrevOutput, "FULL-PREV-OUTPUT", "full prev output forwarded");

	// Without the flag the key is absent (default path = handoff summaries only).
	const captured2: Array<Record<string, unknown> | undefined> = [];
	const mockRunner2: ChainTaskRunner = {
		runTask: async (packet: TaskPacket) => {
			captured2.push(packet.context);
			return createTaskResult({ outputText: "x".repeat(30) });
		},
	};
	const runner2 = new ChainRunner(mockRunner2, createMockHandoffManager());
	await runner2.runChain(runner2.parseChain("produce -> consume"));
	assert.equal(captured2[1]?.__chainPrevOutput, undefined, "no flag → no full-output channel");
});

test("ChainRunner - v0.11.27: --with-context caps the forwarded output at 20000 chars", async () => {
	const captured: Array<Record<string, unknown> | undefined> = [];
	let call = 0;
	const mockRunner: ChainTaskRunner = {
		runTask: async (packet: TaskPacket) => {
			call++;
			captured.push(packet.context);
			return createTaskResult({ outputText: call === 1 ? "x".repeat(25000) : "y" });
		},
	};
	const runner = new ChainRunner(mockRunner, createMockHandoffManager());
	await runner.runChain(runner.parseChain("produce -> consume --with-context"));
	const prevOutput = captured[1]?.__chainPrevOutput;
	assert.ok(typeof prevOutput === "string");
	assert.equal(prevOutput.length, 20000);
});

test("ChainRunner - v0.11.27 (R14-C2): --timeout parses as SECONDS 1..86400 into ms", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());

	const ok = runner.parseChain("a --timeout 90 -> b");
	assert.equal(ok.steps[0]?.timeout, 90000, "90 s → 90000 ms");

	const over = runner.parseChain("a --timeout 99999 -> b");
	assert.equal(over.steps[0]?.timeout, undefined, "over 1 day → dropped, not accepted as 1000-day ms");

	const day = runner.parseChain("a --timeout 86400 -> b");
	assert.equal(day.steps[0]?.timeout, 86400000, "boundary: exactly 1 day is valid");
});

test("ChainRunner - v0.11.27 (R14-C2): step timeout reaches the packet context as __chainStepTimeoutMs", async () => {
	const captured: Array<Record<string, unknown> | undefined> = [];
	const mockRunner: ChainTaskRunner = {
		runTask: async (packet: TaskPacket) => {
			captured.push(packet.context);
			return createTaskResult();
		},
	};
	const runner = new ChainRunner(mockRunner, createMockHandoffManager());
	await runner.runChain(runner.parseChain("a --timeout 120 -> b"));

	assert.equal(captured[0]?.__chainStepTimeoutMs, 120000, "consumed by chain-executor as runParams.timeoutMs");
	assert.equal(captured[1]?.__chainStepTimeoutMs, undefined, "step b has no timeout flag");
});

test("ChainRunner - v0.11.27 (probe-caught): QUOTED goal + `:2` routes to DSL (not silent fallback)", async () => {
	let call = 0;
	const names: string[] = [];
	const mockRunner: ChainTaskRunner = {
		runTask: async (packet: TaskPacket) => {
			call++;
			names.push(packet.goal);
			return createTaskResult();
		},
	};
	const runner = new ChainRunner(mockRunner, createMockHandoffManager());

	const spec = runner.parseChain('"Emit APPLE on line one" -> "Repeat it then append DONE":2 --with-context "final"');

	// The constructs must SURVIVE parsing (previously the quoted name made the
	// DSL parser throw and the simple splitter silently dropped them).
	assert.equal(spec.steps.length, 2);
	assert.equal(spec.steps[1]?.context?.loopCount, 2);
	assert.equal(spec.steps[1]?.context?.withContext, true);
	assert.deepEqual(spec.steps[1]?.context?.args, ["final"]);

	const result = await runner.runChain(spec);
	assert.equal(call, 3, "step 1 + TWO iterations of step 2");
	assert.deepStrictEqual(
		result.steps.map((s) => s.name),
		["Emit APPLE on line one", "Repeat it then append DONE", "Repeat it then append DONE#2"],
	);
	assert.equal(result.success, true);
	// args append to the goal on every iteration
	assert.match(names[1] ?? "", / final$/);
	assert.match(names[2] ?? "", / final$/);
});

test("ChainRunner - v0.11.27: time-like false positives still fall back safely", () => {
	const runner = new ChainRunner(createMockTaskRunner(), createMockHandoffManager());
	// `:30` matches the broadened gate, but the DSL parser throws on the stray
	// tokens and the simple splitter keeps the goal INTACT (one literal step).
	const spec = runner.parseChain("deploy the build at 10:30 sharp");
	assert.equal(spec.steps.length, 1);
	assert.ok(typeof spec.steps[0]?.inlineGoal === "string" || typeof spec.steps[0]?.name === "string", "goal text survives the fallback");
	assert.equal(spec.steps[0]?.context?.loopCount, undefined, "no loop swallowed the goal");
});
