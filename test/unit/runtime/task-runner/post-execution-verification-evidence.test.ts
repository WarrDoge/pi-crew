/**
 * R4-5 + B4 (DR-02 wave 2, Cluster B) — verification evidence surfacing in
 * finalizeTaskResult (src/runtime/task-runner/post-execution.ts):
 *
 * R4-5 (surface, don't false-fail): the default verification contract for a
 * `verify: true` step is { requiredGreenLevel: "targeted", commands: [],
 * allowManualEvidence: true } (task-packet defaultVerificationContract —
 * UNTOUCHED). With zero commands, satisfaction can only come from
 * self-attestation, which silently reported "targeted/targeted" satisfied.
 * Fix under test: the evidence is stamped `decorative: true` (green-contract
 * createVerificationEvidence) and the notes gain
 * "self-attested (no verification commands configured)". The satisfied logic
 * is unchanged.
 *
 * B4 (fail-closed): when verification command EXECUTION throws, the old catch
 * kept the self-attested baseEvidence (satisfied=true). Fix under test: for
 * contracts with requiredGreenLevel ≠ "none" the evidence becomes
 * { satisfied: false, observedGreenLevel: "none", notes: "Verification
 * execution failed (fail-closed): ..." }; level "none" keeps baseEvidence
 * untouched.
 *
 * Injection seam: executeVerificationCommands → runPhaseGates → executeCommand
 * calls validateGateCommand BEFORE spawning, which THROWS on a raw-newline
 * command (VULN-3 hardening) — a deterministic, no-mock way to make execution
 * throw inside finalizeTaskResult.
 *
 * Strategy: call finalizeTaskResult DIRECTLY with a hand-built
 * TaskExecutionContext (pattern reused from post-execution-stderr-only.test.ts).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { createStartupEvidence } from "../../../../src/runtime/heartbeat/worker-startup.ts";
import { evaluateCrewPolicy } from "../../../../src/runtime/policy-engine.ts";
import { permissionForRole } from "../../../../src/runtime/role-permission.ts";
import { buildTaskPacket, defaultVerificationContract } from "../../../../src/runtime/task-packet.ts";
import { finalizeTaskResult, type TaskExecutionResult } from "../../../../src/runtime/task-runner/post-execution.ts";
import type { TaskExecutionContext } from "../../../../src/runtime/task-runner/pre-execution.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState, VerificationContract } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowStep } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

// ─── Fixtures ───────────────────────────────────────────────────────

const team: TeamConfig = {
	name: "r45b4",
	description: "verification evidence surfacing",
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

/** verify:true → defaultVerificationContract shape under test (R4-5). */
const verifyStep: WorkflowStep = { id: "s", role: "worker", task: "Do the task", verify: true, source: "builtin" };
const plainStep: WorkflowStep = { id: "s", role: "worker", task: "Do the task", source: "builtin" };

/** Raw-newline command — validateGateCommand (VULN-3) throws BEFORE spawn, so
 * executeVerificationCommands rejects deterministically inside the B4 catch. */
const INJECTION_COMMAND = "npm test\nrm -rf /tmp/pi-crew-b4-nope";

function makeFixture(step: WorkflowStep) {
	const cwd = createTrackedTempDir("pi-crew-r45b4-");
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	const created = createRunManifest({
		cwd,
		team,
		workflow: { name: "w", description: "r45b4", source: "builtin", filePath: "builtin", steps: [step] },
		goal: "R4-5 + B4 verification evidence",
	});
	return { cwd, created };
}

function buildCtx(
	cwd: string,
	created: { manifest: TeamRunManifest; tasks: TeamTaskState[] },
	step: WorkflowStep,
	verification?: VerificationContract,
): TaskExecutionContext {
	const manifest = created.manifest;
	const baseTask = created.tasks[0]!;
	assert.ok(baseTask, "fixture must create the workflow task");
	const packet = buildTaskPacket({ manifest, step, taskId: baseTask.id, cwd, worktreePath: undefined });
	const taskPacket = verification ? { ...packet, verification } : packet;
	const now = new Date();
	const stubArtifact = (kind: ArtifactDescriptor["kind"], rel: string): ArtifactDescriptor => ({
		kind,
		path: path.join(manifest.artifactsRoot, rel),
		createdAt: now.toISOString(),
		producer: baseTask.id,
		retention: "run",
	});
	return {
		input: {
			manifest,
			tasks: created.tasks,
			task: baseTask,
			step,
			agent,
			executeWorkers: true,
			workspaceId: cwd,
		},
		manifest,
		task: { ...baseTask, taskPacket },
		tasks: created.tasks.map((t) => (t.id === baseTask.id ? { ...t, taskPacket } : t)),
		runtimeKind: "child-process",
		workspace: { cwd },
		worktree: undefined,
		streamBridge: undefined,
		taskPacket,
		dependencyContextText: undefined,
		permissionMode: permissionForRole(baseTask.role),
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

function makeExecResult(manifest: TeamRunManifest, taskId: string): TaskExecutionResult {
	const content = "OK done.";
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

// ─── R4-5: decorative verify surfacing ──────────────────────────────

describe("finalizeTaskResult — R4-5 decorative verification surfacing", () => {
	it("verify:true step (default contract, zero commands) → evidence decorative:true + self-attested note, satisfied logic unchanged", async () => {
		const { cwd, created } = makeFixture(verifyStep);
		try {
			// Defaults pin: defaultVerificationContract UNTOUCHED by the fix.
			assert.deepEqual(defaultVerificationContract(verifyStep), {
				requiredGreenLevel: "targeted",
				commands: [],
				allowManualEvidence: true,
			});

			const ctx = buildCtx(cwd, created, verifyStep);
			const taskId = created.tasks[0]!.id;
			const result = await finalizeTaskResult(ctx, makeExecResult(created.manifest, taskId));
			const t = result.tasks.find((x) => x.id === taskId)!;
			assert.equal(t.status, "completed", `status=${t.status} error=${t.error ?? ""}`);

			const evidence = t.verification;
			assert.ok(evidence, "verification evidence must exist");
			assert.equal(evidence.decorative, true, "decorative flag must be stamped");
			assert.match(
				evidence.notes ?? "",
				/self-attested \(no verification commands configured\)/,
				"note must surface self-attestation",
			);
			// Satisfied logic UNCHANGED (surface, don't false-fail):
			assert.equal(evidence.satisfied, true);
			assert.equal(evidence.observedGreenLevel, "targeted");
			assert.equal(evidence.requiredGreenLevel, "targeted");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("step WITHOUT verify (level none, zero commands) → no decorative flag, no self-attested note", async () => {
		const { cwd, created } = makeFixture(plainStep);
		try {
			const ctx = buildCtx(cwd, created, plainStep);
			const taskId = created.tasks[0]!.id;
			const result = await finalizeTaskResult(ctx, makeExecResult(created.manifest, taskId));
			const t = result.tasks.find((x) => x.id === taskId)!;
			assert.equal(t.status, "completed");
			const evidence = t.verification!;
			assert.equal(evidence.decorative, undefined, "level none must not be flagged decorative");
			assert.ok(!(evidence.notes ?? "").includes("self-attested"), "no self-attested note for level none");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ─── B4: verification-exec catch must fail-closed ───────────────────

describe("finalizeTaskResult — B4 verification execution failure is fail-closed", () => {
	it("exec throw with targeted contract (commands present) → satisfied:false observed:none, fail-closed note", async () => {
		const { cwd, created } = makeFixture(plainStep);
		try {
			const contract: VerificationContract = {
				requiredGreenLevel: "targeted",
				commands: [INJECTION_COMMAND],
				allowManualEvidence: true,
			};
			const ctx = buildCtx(cwd, created, plainStep, contract);
			const taskId = created.tasks[0]!.id;
			const result = await finalizeTaskResult(ctx, makeExecResult(created.manifest, taskId));
			const t = result.tasks.find((x) => x.id === taskId)!;

			const evidence = t.verification!;
			// Fail-closed: the self-attested satisfied=true must NOT survive.
			assert.equal(evidence.satisfied, false, "verification throw must fail closed");
			assert.equal(evidence.observedGreenLevel, "none");
			assert.match(evidence.notes ?? "", /Verification execution failed \(fail-closed\)/);
			assert.match(evidence.notes ?? "", /raw newline/, "the underlying exec error message must be preserved");

			// Downstream effect: the policy engine now sees an unsatisfied green
			// contract on a completed task → blocking decision (fail-closed end
			// to end, without finalizeTaskResult itself flipping task status).
			const decisions = evaluateCrewPolicy({ manifest: created.manifest, tasks: [t] });
			assert.ok(
				decisions.some((d) => d.action === "block" && d.reason === "green_unsatisfied"),
				`expected green_unsatisfied block, got: ${JSON.stringify(decisions)}`,
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("exec throw with level-none contract → baseEvidence unchanged (nothing to gate)", async () => {
		const { cwd, created } = makeFixture(plainStep);
		try {
			const contract: VerificationContract = {
				requiredGreenLevel: "none",
				commands: [INJECTION_COMMAND],
				allowManualEvidence: true,
			};
			const ctx = buildCtx(cwd, created, plainStep, contract);
			const taskId = created.tasks[0]!.id;
			const result = await finalizeTaskResult(ctx, makeExecResult(created.manifest, taskId));
			const t = result.tasks.find((x) => x.id === taskId)!;

			const evidence = t.verification!;
			// Level none: catch leaves baseEvidence untouched — satisfied stays
			// true (none satisfies none) and the base note survives verbatim.
			assert.equal(evidence.satisfied, true);
			assert.equal(evidence.observedGreenLevel, "none");
			assert.equal(evidence.notes, "child-process worker finished without reporting a verification failure.");
			assert.ok(!(evidence.notes ?? "").includes("fail-closed"), "no fail-closed note for level none");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
