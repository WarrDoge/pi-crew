/**
 * M3-2 (R47-3/V4, fix-wave 6) — the verifier `PASS:` / `FAIL:` verdict is a
 * REAL consumer.
 *
 * Finding (R47-3 / V4): the only consumer of the verdict was
 * `output-validator.ts` (`^(PASS:|FAIL:)` OR'd with MARKDOWN_STRUCTURED) —
 * a format-PRESENCE check that accepts either verdict and only drops the task
 * to `activityState: "needs_attention"`. The terminal status in
 * `post-execution.ts` came from `error`/`noYield` alone, so a verifier that
 * answered "FAIL: <red tests>" finished `completed` and the run could close out
 * green on it. Zero semantic consumers existed.
 *
 * Rules pinned here (all fail-closed):
 *  1. FAIL verdict → task FAILED (error marker + exitCode bump + last model
 *     attempt success:false), never completed.
 *  2. PASS verdict → task completed AND counted as verified (evidence
 *     satisfied, note stamped).
 *  3. No verdict line → task still completes (a reporting miss is not a
 *     verification failure) but is NOT verified: observedGreenLevel "none",
 *     satisfied false ⇒ policy-engine blocks green_unsatisfied instead of the
 *     run closing green.
 *  4. Markdown-decorated verdicts ("**PASS:**", "- FAIL:") count; the colon is
 *     required and a mid-prose mention does not.
 *  5. Non-verifier roles are untouched (the contract is verifier-only).
 *  6. The deterministic gate-skip path (diagnostics.verifyGate/synthetic, gate
 *     summary as stdout) is NOT judged by the verdict consumer.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { createStartupEvidence } from "../../../../src/runtime/heartbeat/worker-startup.ts";
import { evaluateCrewPolicy } from "../../../../src/runtime/policy-engine.ts";
import { permissionForRole } from "../../../../src/runtime/role-permission.ts";
import { buildTaskPacket } from "../../../../src/runtime/task-packet.ts";
import {
	extractVerifierVerdict,
	finalizeTaskResult,
	type TaskExecutionResult,
} from "../../../../src/runtime/task-runner/post-execution.ts";
import type { TaskExecutionContext } from "../../../../src/runtime/task-runner/pre-execution.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowStep } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

// ─── Fixtures ───────────────────────────────────────────────────────

const team: TeamConfig = {
	name: "r47v4",
	description: "verifier verdict consumer",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

const agent: AgentConfig = {
	name: "worker",
	description: "regression worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

/** verify:true → requiredGreenLevel "targeted" (defaultVerificationContract),
 *  so an unverified verifier task is observable through the policy engine. */
const verifierStep: WorkflowStep = { id: "v", role: "verifier", task: "Verify the work", verify: true, source: "builtin" };
const executorStep: WorkflowStep = { id: "e", role: "executor", task: "Do the task", verify: true, source: "builtin" };

function makeFixture(step: WorkflowStep) {
	const cwd = createTrackedTempDir("pi-crew-r47v4-");
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	const created = createRunManifest({
		cwd,
		team,
		workflow: { name: "w", description: "r47v4", source: "builtin", filePath: "builtin", steps: [step] },
		goal: "R47-3 verdict consumer",
	});
	return { cwd, created };
}

function buildCtx(
	cwd: string,
	created: { manifest: TeamRunManifest; tasks: TeamTaskState[] },
	step: WorkflowStep,
	diagnostics?: Record<string, unknown>,
): TaskExecutionContext {
	const manifest = created.manifest;
	const baseTask = created.tasks[0]!;
	assert.ok(baseTask, "fixture must create the workflow task");
	const packet = buildTaskPacket({ manifest, step, taskId: baseTask.id, cwd, worktreePath: undefined });
	const now = new Date();
	const stubArtifact = (kind: ArtifactDescriptor["kind"], rel: string): ArtifactDescriptor => ({
		kind,
		path: path.join(manifest.artifactsRoot, rel),
		createdAt: now.toISOString(),
		producer: baseTask.id,
		retention: "run",
	});
	const task: TeamTaskState = {
		...baseTask,
		role: step.role,
		taskPacket: packet,
		...(diagnostics ? { diagnostics } : {}),
	};
	return {
		input: {
			manifest,
			tasks: created.tasks,
			task,
			step,
			agent,
			executeWorkers: true,
			workspaceId: cwd,
		},
		manifest,
		task,
		tasks: created.tasks.map((t) => (t.id === baseTask.id ? task : t)),
		runtimeKind: "child-process",
		workspace: { cwd },
		worktree: undefined,
		streamBridge: undefined,
		taskPacket: packet,
		dependencyContextText: undefined,
		permissionMode: permissionForRole(step.role),
		skillBlock: undefined,
		skillNames: undefined,
		skillPaths: undefined,
		prompt: "regression prompt",
		promptArtifact: stubArtifact("prompt", `prompts/${baseTask.id}.md`),
		inputsArtifact: stubArtifact("metadata", `metadata/${baseTask.id}.inputs.json`),
		skillArtifact: undefined,
		coordinationArtifact: stubArtifact("metadata", `metadata/${baseTask.id}.coordination-bridge.md`),
		collectYieldEvents: false,
		collectedJsonEvents: undefined,
		startupEvidence: createStartupEvidence({
			command: "pi",
			startedAt: now,
			finishedAt: now,
			promptSentAt: now,
			promptAccepted: true,
			exitCode: 0,
		}),
	};
}

function makeExecResult(manifest: TeamRunManifest, taskId: string, content: string): TaskExecutionResult {
	const rel = `results/${taskId}.txt`;
	const abs = path.join(manifest.artifactsRoot, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, "utf-8");
	return {
		resultArtifact: {
			kind: "result",
			path: abs,
			createdAt: new Date().toISOString(),
			producer: taskId,
			retention: "run",
			sizeBytes: Buffer.byteLength(content),
		},
		logArtifact: undefined,
		transcriptArtifact: undefined,
		exitCode: 0,
		error: undefined,
		modelAttempts: [{ model: "test/model", success: true, exitCode: 0 }],
		parsedOutput: { jsonEvents: 0, textEvents: [], finalText: content },
		finalStdout: content,
		resultSource: "finalText",
		transcriptPath: undefined,
		terminalEvidence: [],
		startupEvidence: createStartupEvidence({
			command: "pi",
			startedAt: new Date(),
			finishedAt: new Date(),
			promptSentAt: new Date(),
			promptAccepted: true,
			exitCode: 0,
		}),
	};
}

async function run(
	step: WorkflowStep,
	content: string,
	diagnostics?: Record<string, unknown>,
): Promise<{ task: TeamTaskState; manifest: TeamRunManifest }> {
	const { cwd, created } = makeFixture(step);
	const ctx = buildCtx(cwd, created, step, diagnostics);
	const taskId = created.tasks[0]!.id;
	const result = await finalizeTaskResult(ctx, makeExecResult(created.manifest, taskId, content));
	const task = result.tasks.find((x) => x.id === taskId)!;
	return { task, manifest: result.manifest };
}

// ─── extractVerifierVerdict unit pins ───────────────────────────────

describe("extractVerifierVerdict — contract reading", () => {
	it("reads PASS / FAIL verdict lines, tolerating markdown decoration", () => {
		assert.equal(extractVerifierVerdict("PASS: tests green — npm test 44/44"), "pass");
		assert.equal(extractVerifierVerdict("FAIL: tests red — expected 0, got 3"), "fail");
		assert.equal(extractVerifierVerdict("**PASS:** all acceptance ids covered"), "pass");
		assert.equal(extractVerifierVerdict("- FAIL: build broken"), "fail");
		assert.equal(extractVerifierVerdict("> PASS: ok"), "pass");
	});

	it("accepts the bare-prose verdicts the child-process prompts ask for (T7 live finding), still ignoring mid-line mentions", () => {
		// Wave-6 T7 live probe: a FAILED-gate run blocked as green_unsatisfied /
		// observed=none because the verifier followed its prose prompt ("Give PASS
		// or FAIL with evidence") and wrote a bare/decorated verdict. These MUST
		// be consumed.
		assert.equal(extractVerifierVerdict("PASS"), "pass");
		assert.equal(extractVerifierVerdict("FAIL"), "fail");
		assert.equal(extractVerifierVerdict("**PASS**"), "pass");
		assert.equal(extractVerifierVerdict("PASS — tests green, 44/44"), "pass");
		assert.equal(extractVerifierVerdict("FAIL. typecheck exits 1"), "fail");
		assert.equal(extractVerifierVerdict("PASS (cached run 2026-10-19)"), "pass");
		assert.equal(extractVerifierVerdict("## VERIFICATION: PASS|FAIL"), "none");
		// Still NOT verdicts: mid-line mentions and word continuations.
		assert.equal(extractVerifierVerdict("The verifier said PASS"), "none");
		assert.equal(extractVerifierVerdict("PASSED all checks"), "none");
		assert.equal(extractVerifierVerdict("PASSing rate is high"), "none");
		assert.equal(extractVerifierVerdict("note: the executor wrote FAIL: earlier"), "none");
		assert.equal(extractVerifierVerdict(""), "none");
		assert.equal(extractVerifierVerdict(undefined), "none");
	});

	it("a FAIL line wins over a PASS line (contradictory verdict is not a pass)", () => {
		assert.equal(extractVerifierVerdict("PASS: looks fine\nFAIL: but tests are red"), "fail");
	});

	it("scans sources in priority order — a later source decides only when earlier ones are silent", () => {
		assert.equal(extractVerifierVerdict(undefined, "PASS: from parsed finalText"), "pass");
		assert.equal(extractVerifierVerdict("", "FAIL: from stdout"), "fail");
	});
});

// ─── finalizeTaskResult integration pins ────────────────────────────

describe("finalizeTaskResult — M3-2 FAIL verdict fails the task", () => {
	it("verifier answering FAIL → status failed, exitCode bumped, last attempt success:false", async () => {
		const { task } = await run(verifierStep, "FAIL: typecheck errors at src/a.ts:3 — expected 0, got 2");
		assert.equal(task.status, "failed", `status=${task.status} error=${task.error ?? ""}`);
		assert.match(task.error ?? "", /verifier-verdict-fail/);
		assert.match(task.error ?? "", /FAIL: typecheck errors/);
		assert.equal(task.exitCode, 1);
		assert.equal(task.modelAttempts?.at(-1)?.success, false, "the failing attempt must be marked unsuccessful");
		assert.equal(task.verification?.satisfied, false, "a FAILing verifier can never be verified");
	});

	it("policy engine escalates the failed verifier task (not a green closeout)", async () => {
		const { task, manifest } = await run(verifierStep, "FAIL: build broken");
		const decisions = evaluateCrewPolicy({ manifest, tasks: [task] });
		assert.ok(
			decisions.some((d) => d.reason === "task_failed" || d.reason === "green_unsatisfied"),
			`expected failure handling, got: ${JSON.stringify(decisions)}`,
		);
		assert.ok(!decisions.some((d) => d.reason === "run_complete"), "run must not close out green");
	});
});

describe("finalizeTaskResult — M3-2 PASS verdict is consumed as verified", () => {
	it("verifier answering PASS → completed + evidence satisfied with the verdict note", async () => {
		const { task } = await run(verifierStep, "PASS: acceptance ids A1/A2 covered — npm test 44/44 green");
		assert.equal(task.status, "completed", `error=${task.error ?? ""}`);
		const evidence = task.verification!;
		assert.equal(evidence.satisfied, true);
		assert.match(evidence.notes ?? "", /verifier verdict: PASS/);
	});

	it("markdown-decorated PASS (**PASS:**) counts too", async () => {
		const { task } = await run(verifierStep, "**PASS:** re-ran the suite, 44/44 green, diff matches the packet");
		assert.equal(task.status, "completed");
		assert.match(task.verification?.notes ?? "", /verifier verdict: PASS/);
	});
});

describe("finalizeTaskResult — M3-2 missing verdict is NOT verified (and not a failure)", () => {
	it("verifier report without a PASS:/FAIL: line → completed but unverified, policy blocks green", async () => {
		const { task, manifest } = await run(verifierStep, "## Handoff\n\n### Goal\nVerified the work by re-running the suite.");
		assert.equal(task.status, "completed", "a reporting miss is not a verification failure");
		const evidence = task.verification!;
		assert.equal(evidence.satisfied, false, "self-attested evidence requires an explicit PASS");
		assert.equal(evidence.observedGreenLevel, "none");
		assert.match(evidence.notes ?? "", /not verified: verifier output carries no PASS:\/FAIL: verdict line/);

		const decisions = evaluateCrewPolicy({ manifest, tasks: [task] });
		assert.ok(
			decisions.some((d) => d.action === "block" && d.reason === "green_unsatisfied"),
			`expected green_unsatisfied block, got: ${JSON.stringify(decisions)}`,
		);
		assert.ok(!decisions.some((d) => d.reason === "run_complete"), "run must not close out green on an unverified verifier");
	});
});

describe("finalizeTaskResult — M3-2 scope guards", () => {
	it("non-verifier role output containing FAIL: is untouched", async () => {
		const { task } = await run(executorStep, "FAIL: this string is just evidence the executor quoted");
		assert.equal(task.status, "completed", `error=${task.error ?? ""}`);
		assert.equal(task.verification?.satisfied, true, "executor evidence logic is unchanged");
	});

	it("deterministic gate-skip path (synthetic + verifyGate diagnostics) is not judged by the verdict consumer", async () => {
		const gateSummary = "verify_gate: PASS (skip reason: deterministic_pass)\n- typecheck: exit 0";
		const { task } = await run(verifierStep, gateSummary, {
			verifyGate: { verdict: "PASS", reason: "deterministic_pass", evidenceLines: ["typecheck: exit 0"] },
			synthetic: true,
		});
		assert.equal(task.status, "completed", `error=${task.error ?? ""}`);
		assert.equal(task.verification?.satisfied, true, "the deterministic gate already verified — no LLM verdict to read");
		assert.ok(!(task.verification?.notes ?? "").includes("not verified"), "gate-skip evidence must not be downgraded");
	});
});
