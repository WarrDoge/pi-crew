/**
 * DR-02 WI-1 (R4-1 audit, 2026-10-15) — coalesced dispatch 429-empty-settle gate.
 *
 * Bug: runCoalescedTaskGroup called runWorker directly and never parsed the
 * pi-json event stream — a 429-exhausted worker (exit 0, NO stopReason error,
 * chain of EMPTY assistant message_end events ending agent_settled) passed the
 * legacy success gate (`exitCode === 0 && !error`), and rawFinalText kept the
 * early opening sentence from BEFORE the outage, so EVERY task in the group
 * was marked completed with garbage text (the coalesced variant of the DR-01
 * false-green that marked 7/7 tasks of run team_20261014082741 completed with
 * zero findings).
 *
 * The fix mirrors the DR-01 attemptErrorFor gate (child-executor.ts) and the
 * DWF ctx.agent() gate (dynamic-workflow-context.ts): parse the stdout event
 * stream per attempt and THROW when settledWithoutAnswer === true — the throw
 * engages the existing executeWithRetry machinery (transient 429 burns the
 * retry budget) and exhaustion fires onRetryGivenUp → the US-003 group
 * deadletter. The final throw lands in the dispatch catch: success=false and
 * every group task maps to "failed".
 *
 * Tests (public runCoalescedTaskGroup API via the in-process mock seam
 * PI_TEAMS_MOCK_CHILD_PI=json-429-empty-settle + PI_CREW_ALLOW_MOCK=1, no real
 * pi spawn — mirrors run-coalesced-deadletter-split.test.ts):
 *   1. 2-task read-only group + 429 fixture (single-shot) → success=false,
 *      BOTH tasks "failed" (none completed), rawOutput carries the DR-02
 *      message, the stale opening sentence never becomes a task result, no
 *      deadletter (single-shot ≠ exhaustion).
 *   2. Same fixture with retry enabled (fast policy, maxAttempts 2) → retry
 *      exhaustion → US-003 deadletter entry against the FIRST task naming the
 *      whole group, all tasks still failed.
 *   3. Healthy control (json-success fixture) → success=true, both tasks
 *      "completed" with per-task partition entries (broadcast split) — the
 *      healthy path is unchanged by the gate.
 *   4. Direct gate-semantics battery on __test__throwIfSettledWithoutAnswer:
 *      plain text / final-assistant-with-text / patch-only / hard-error /
 *      cancelled must NOT throw; only the empty-final-assistant shape throws
 *      (exact DR-02 message).
 *
 * Env notes: PI_CREW_DEPTH / PI_TEAMS_DEPTH scrubbed (this suite also runs
 * inside pi-crew worker shells where those are set — depth guard would refuse
 * the spawn otherwise).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import type { ChildPiRunResult } from "../../../../src/runtime/child-pi/child-pi.ts";
import { __test_resetCap, getWorkerCapCapacity } from "../../../../src/runtime/scheduling/global-worker-cap.ts";
import { __test__throwIfSettledWithoutAnswer, runCoalescedTaskGroup } from "../../../../src/runtime/scheduling/run-coalesced-task-group.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState, WorkerExitStatus } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const DR02_MESSAGE = "Model settled without a final answer (coalesced: empty final assistant message; upstream rate-limit/429 exhaustion)";

const team: TeamConfig = {
	name: "coalesced-429",
	description: "DR-02 WI-1 empty-settle test",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "analyst", agent: "analyst" }],
};

// 2 same-role (read-only "analyst") steps → createRunManifest yields 2 tasks →
// one coalesced group sharing ONE worker.
const workflow: WorkflowConfig = {
	name: "wf-dr02-wi1",
	description: "DR-02 WI-1 test",
	steps: [
		{ id: "s-one", role: "analyst", task: "Analyze one {goal}" },
		{ id: "s-two", role: "analyst", task: "Analyze two {goal}" },
	],
	source: "builtin",
	filePath: "builtin",
};

const agent: AgentConfig = {
	name: "analyst",
	description: "DR-02 WI-1 read-only analyst",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

const MOCK_ENV_KEYS = [
	"PI_TEAMS_MOCK_CHILD_PI",
	"PI_CREW_ALLOW_MOCK",
	"PI_TEAMS_PI_BIN",
	"PI_CREW_DEPTH",
	"PI_TEAMS_DEPTH",
	"npm_config_prefix",
] as const;

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-dr02-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function snapshotEnv(keys: readonly string[]): Record<string, string | undefined> {
	const snap: Record<string, string | undefined> = {};
	for (const k of keys) snap[k] = process.env[k];
	return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
	for (const [k, v] of Object.entries(snap)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

/** Arm the in-process mock seam and scrub the worker-shell depth/PI_BIN hazards. */
function armMock(mode: string): void {
	process.env.PI_TEAMS_MOCK_CHILD_PI = mode;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	delete process.env.PI_TEAMS_PI_BIN;
	delete process.env.npm_config_prefix;
	// Worker-shell gotcha: PI_CREW_DEPTH/PI_TEAMS_DEPTH are set when this
	// suite runs inside a pi-crew worker — scrub so the depth guard doesn't
	// refuse the spawn.
	delete process.env.PI_CREW_DEPTH;
	delete process.env.PI_TEAMS_DEPTH;
}

function readDeadletterJsonl(filePath: string): unknown[] {
	if (!fs.existsSync(filePath)) return [];
	return fs
		.readFileSync(filePath, "utf-8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as unknown);
}

/** Final per-task state as persisted on disk (tasksPath is a JSON array). */
function readSavedTasks(tasksPath: string): Array<Record<string, unknown>> {
	return JSON.parse(fs.readFileSync(tasksPath, "utf-8")) as Array<Record<string, unknown>>;
}

test("DR-02 WI-1: 429-empty-settle worker fails the whole group — no task completes (single-shot)", async () => {
	const envSnap = snapshotEnv(MOCK_ENV_KEYS);
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(4);
	const cwd = makeTmpCwd();
	try {
		armMock("json-429-empty-settle");
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "DR-02 WI-1 empty settle" });
		const taskIds = tasks.map((t) => t.id);
		assert.equal(taskIds.length, 2, "2 same-role steps must yield a 2-task group");

		const groupTasks: TeamTaskState[] = tasks.map((t) => ({ ...t, status: "queued" as const }));
		const result = await runCoalescedTaskGroup({
			manifest,
			tasks: [...groupTasks],
			groupTasks,
			step: workflow.steps![0]!,
			agent,
			executeWorkers: true,
			workspaceId: "ws-dr02-single",
			reliability: { autoRetry: false },
		});

		// The group must fail — NOT complete — on the empty-settle shape even
		// though the worker exited 0 with no error (the false-green pre-fix).
		assert.equal(result.success, false, "empty-settle dispatch must fail");
		assert.match(result.rawOutput, /Model settled without a final answer/);
		assert.match(result.rawOutput, /rate-limit\/429/);

		// Every task in the group is failed; none completed.
		for (const taskId of taskIds) {
			const task = result.tasks.find((t) => t.id === taskId)!;
			assert.equal(task.status, "failed", `task ${taskId} must be failed (got '${task.status}')`);
		}

		// Persisted terminal state agrees, and the stale pre-outage opening
		// sentence must NOT be any task's result (that was the false-green).
		const saved = readSavedTasks(manifest.tasksPath);
		for (const taskId of taskIds) {
			const savedTask = saved.find((t) => t.id === taskId)!;
			assert.equal(savedTask.status, "failed");
			const res = savedTask.result as { text: string } | undefined;
			assert.ok(res, `task ${taskId} must carry a result record`);
			assert.ok(!res!.text.includes("[MOCK] Starting work"), `task ${taskId} result must not be the stale opening sentence`);
		}

		// Single-shot (autoRetry:false) is NOT retry exhaustion → no deadletter.
		assert.equal(readDeadletterJsonl(path.join(manifest.stateRoot, "deadletter.jsonl")).length, 0);
	} finally {
		__test_resetCap(prevCap);
		restoreEnv(envSnap);
		await removeDirWithRetry(cwd);
	}
});

test("DR-02 WI-1: retry exhaustion → US-003 group deadletter + all tasks failed", async () => {
	const envSnap = snapshotEnv(MOCK_ENV_KEYS);
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(4);
	const cwd = makeTmpCwd();
	try {
		armMock("json-429-empty-settle");
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "DR-02 WI-1 retry exhaustion" });
		const taskIds = tasks.map((t) => t.id);
		const [firstId, secondId] = taskIds as [string, string];

		const groupTasks: TeamTaskState[] = tasks.map((t) => ({ ...t, status: "queued" as const }));
		const result = await runCoalescedTaskGroup({
			manifest,
			tasks: [...groupTasks],
			groupTasks,
			step: workflow.steps![0]!,
			agent,
			executeWorkers: true,
			workspaceId: "ws-dr02-retry",
			// Fast policy: 2 attempts, ~10ms backoff — proves the retry machinery
			// engages (the gate THROWS per attempt) without slowing the suite.
			reliability: {
				autoRetry: true,
				retryPolicy: { maxAttempts: 2, backoffMs: 10, jitterRatio: 0, exponentialFactor: 1 },
			},
		});

		assert.equal(result.success, false, "exhausted group must fail");
		assert.match(result.rawOutput, /Model settled without a final answer/);
		for (const taskId of taskIds) {
			const task = result.tasks.find((t) => t.id === taskId)!;
			assert.equal(task.status, "failed", `task ${taskId} must be failed after retry exhaustion`);
		}

		// US-003 granularity: ONE deadletter entry against the group's FIRST
		// task, naming the whole group, with the DR-02 message as lastError.
		const runLocal = readDeadletterJsonl(path.join(manifest.stateRoot, "deadletter.jsonl"));
		assert.equal(runLocal.length, 1, "exactly one deadletter entry for the group");
		const entry = runLocal[0] as { taskId: string; reason: string; attempts: number; lastError?: string };
		assert.equal(entry.taskId, firstId, "deadletter entry recorded against the first task (US-003 pattern)");
		assert.equal(entry.reason, "max-retries");
		assert.equal(entry.attempts, 2, "both retry attempts must have run (gate throws per attempt)");
		assert.ok(entry.lastError?.includes(secondId), "deadletter lastError must name the group");
		assert.ok(entry.lastError?.includes(DR02_MESSAGE), "deadletter lastError must carry the DR-02 message");
		// Project-level index (survives run pruning) mirrors the entry.
		const indexEntries = readDeadletterJsonl(path.join(cwd, ".crew", "state", "deadletter", `${manifest.runId}.jsonl`));
		assert.equal(indexEntries.length, 1);
		assert.equal((indexEntries[0] as { taskId: string }).taskId, firstId);
	} finally {
		__test_resetCap(prevCap);
		restoreEnv(envSnap);
		await removeDirWithRetry(cwd);
	}
});

test("DR-02 WI-1 healthy control: json-success → group completes with partitioned entries", async () => {
	const envSnap = snapshotEnv(MOCK_ENV_KEYS);
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(4);
	const cwd = makeTmpCwd();
	try {
		armMock("json-success");
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "DR-02 WI-1 healthy control" });
		const taskIds = tasks.map((t) => t.id);

		const groupTasks: TeamTaskState[] = tasks.map((t) => ({ ...t, status: "queued" as const }));
		const result = await runCoalescedTaskGroup({
			manifest,
			tasks: [...groupTasks],
			groupTasks,
			step: workflow.steps![0]!,
			agent,
			executeWorkers: true,
			workspaceId: "ws-dr02-healthy",
			reliability: { autoRetry: false },
		});

		// Healthy path unchanged by the gate: success, all tasks completed,
		// each with its own (non-empty) partition entry.
		assert.equal(result.success, true, "healthy dispatch must still succeed");
		const saved = readSavedTasks(manifest.tasksPath);
		for (const taskId of taskIds) {
			const task = result.tasks.find((t) => t.id === taskId)!;
			assert.equal(task.status, "completed", `task ${taskId} must be completed`);
			const savedTask = saved.find((t) => t.id === taskId)!;
			const res = savedTask.result as { text: string; strategy: string };
			assert.equal(res.strategy, "broadcast", "no delimiters in the fixture → broadcast split");
			assert.match(res.text, /\[MOCK\] JSON success/, "per-task entry must carry the worker text");
		}
		assert.equal(readDeadletterJsonl(path.join(manifest.stateRoot, "deadletter.jsonl")).length, 0);
	} finally {
		__test_resetCap(prevCap);
		restoreEnv(envSnap);
		await removeDirWithRetry(cwd);
	}
});

/** Minimal ChildPiRunResult factory for the direct gate battery. */
function fakeResult(overrides: Partial<ChildPiRunResult>): ChildPiRunResult {
	return { exitCode: 0, stdout: "", stderr: "", ...overrides };
}

const assistantTextEnd = (text: string) =>
	JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
const assistantEmptyEnd = JSON.stringify({
	type: "message_end",
	message: { role: "assistant", content: [], usage: { input: 0, output: 0 } },
});
const cancelledExitStatus: WorkerExitStatus = {
	exitCode: 0,
	cancelled: true,
	timedOut: false,
	killed: false,
	cleanupErrors: [],
	finalDrainMs: 0,
};

test("DR-02 WI-1 gate semantics: only the empty-final-assistant shape throws", () => {
	// Plain text (non-JSON) output — e.g. raw-final-text-only / prose workers.
	assert.doesNotThrow(() => __test__throwIfSettledWithoutAnswer(fakeResult({ stdout: "plain prose result, no JSON lines at all\n" })));
	// json-success shape: final event is message_end WITHOUT a message field →
	// settledWithoutAnswer stays undefined.
	assert.doesNotThrow(() =>
		__test__throwIfSettledWithoutAnswer(
			fakeResult({
				stdout: `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })}\n${JSON.stringify({ type: "message_end", usage: { input: 1, output: 1 } })}\n`,
			}),
		),
	);
	// Final assistant message_end WITH text → settled WITH an answer.
	assert.doesNotThrow(() => __test__throwIfSettledWithoutAnswer(fakeResult({ stdout: `${assistantTextEnd("the answer")}\n` })));
	// Empty final assistant message but a patch was produced — patch-only work
	// is real work (DR-01 parity).
	assert.doesNotThrow(() =>
		__test__throwIfSettledWithoutAnswer(
			fakeResult({
				stdout: `${JSON.stringify({
					type: "tool_result",
					content: [{ type: "text", text: "--- a/x\n+++ b/x\n@@ patch" }],
				})}\n${assistantEmptyEnd}\n`,
			}),
		),
	);
	// Hard error / cancelled results never reach the gate's verdict.
	assert.doesNotThrow(() => __test__throwIfSettledWithoutAnswer(fakeResult({ stdout: `${assistantEmptyEnd}\n`, error: "spawn failed" })));
	assert.doesNotThrow(() =>
		__test__throwIfSettledWithoutAnswer(fakeResult({ stdout: `${assistantEmptyEnd}\n`, exitStatus: cancelledExitStatus })),
	);
	// The 429-empty-settle shape (fixture stream): throws with the exact DR-02 message.
	assert.throws(
		() =>
			__test__throwIfSettledWithoutAnswer(
				fakeResult({
					stdout:
						[
							assistantTextEnd("[MOCK] Starting work for analyst"),
							JSON.stringify({
								type: "message_end",
								message: { role: "toolResult", content: [{ type: "text", text: "tool" }] },
							}),
							assistantEmptyEnd,
							assistantEmptyEnd,
							JSON.stringify({ type: "agent_settled" }),
						].join("\n") + "\n",
				}),
			),
		(err) => err instanceof Error && err.message === DR02_MESSAGE,
	);
});
