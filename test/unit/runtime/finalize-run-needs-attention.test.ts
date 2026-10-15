/**
 * R4-4 (DR-02 wave 2, Cluster B): `needs_attention` is a TERMINAL-without-
 * result task status (surface-lost / no-yield paths in post-execution) and the
 * scheduler counts it as done (task-graph-scheduler counts
 * completed|skipped|needs_attention), so a run whose task never submitted a
 * result used to finalize GREEN with "Team workflow completed." and ZERO
 * needs_attention handling anywhere in finalize-run.
 *
 * Fix under test (detection-first, NO status flip):
 *  - finalize-run.ts: the run still goes "completed", but the summary states
 *    "Team workflow completed with N task(s) needing attention (no result
 *    submitted)."
 *  - policy-engine.ts: a NON-blocking notify decision (reason
 *    task_needs_attention) listing the task ids lands in
 *    manifest.policyDecisions (and thus the policy-decisions.json artifact +
 *    run summary "## Policy decisions" section).
 *
 * Strategy: call finalizeRun DIRECTLY via the R15-1 test export with a
 * hand-built SchedulerContext (unit isolation — no scheduler loop, no child
 * workers; manifest fixture reuses the createRunManifest pattern from
 * post-execution-stderr-only.test.ts).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

import type { AgentConfig } from "../../../src/agents/agent-config.ts";
import { __test__finalizeRun } from "../../../src/runtime/finalize-run.ts";
import type { SchedulerContext } from "../../../src/runtime/scheduler-context.ts";
import { buildTaskGraphIndex } from "../../../src/runtime/scheduling/task-graph-scheduler.ts";
import { createResultArtifactReadCache } from "../../../src/runtime/task-output-context.ts";
import { createWorkflowStateMachine } from "../../../src/runtime/workflow-state.ts";
import { createRunManifest } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir } from "../../fixtures/test-tempdir.ts";

// ─── Fixtures ───────────────────────────────────────────────────────

const team: TeamConfig = {
	name: "r44fin",
	description: "R4-4 needs_attention finalize surfacing",
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

const workflow: WorkflowConfig = {
	name: "w",
	description: "two-step workflow",
	source: "builtin",
	filePath: "builtin",
	steps: [
		{ id: "s1", role: "worker", task: "Do the work", source: "builtin" },
		{ id: "s2", role: "worker", task: "Do more work", source: "builtin" },
	],
};

function makeFixture() {
	const cwd = createTrackedTempDir("pi-crew-r44-fin-");
	fs.mkdirSync(`${cwd}/.crew`, { recursive: true });
	fs.writeFileSync(`${cwd}/package.json`, "{}", "utf-8");
	const created = createRunManifest({ cwd, team, workflow, goal: "R4-4 needs_attention finalize surfacing" });
	return { cwd, created };
}

/** Terminalise fixture tasks with the requested statuses (no taskPacket → the
 * policy green check is skipped; statuses are the only input under test). */
function withStatuses(
	created: { manifest: TeamRunManifest; tasks: TeamTaskState[] },
	statuses: TeamTaskState["status"][],
): TeamTaskState[] {
	return created.tasks.map((task, index) => ({
		...task,
		status: statuses[index] ?? task.status,
		finishedAt: new Date().toISOString(),
		// Observable worker activity so the effectiveness guard stays "ok" for
		// completed tasks (a successful model attempt counts, see
		// taskHasObservableWorkerActivity).
		...(statuses[index] === "completed" ? { modelAttempts: [{ model: "test/model", success: true, exitCode: 0 }] } : {}),
	}));
}

function buildCtx(
	created: { manifest: TeamRunManifest; tasks: TeamTaskState[] },
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
): SchedulerContext {
	return {
		input: {
			manifest,
			tasks,
			team,
			workflow,
			agents: [agent],
			executeWorkers: true,
			workspaceId: manifest.cwd,
		},
		workflow,
		manifest,
		tasks,
		queueIndex: buildTaskGraphIndex(tasks),
		wfMachine: createWorkflowStateMachine([]),
		pendingUnits: new Map(),
		dispatchedTaskIds: new Set(),
		runController: new AbortController(),
		runtimeKind: "child-process",
		adaptivePlanInjected: false,
		adaptivePlanMissing: false,
		settledMerge: null,
		resultReadCache: createResultArtifactReadCache(),
	};
}

/** The scheduler loop always moves the manifest to "running" before finalize —
 * queued→completed is not a valid transition (E004), so mirror the real flow. */
function runningManifest(created: { manifest: TeamRunManifest }): TeamRunManifest {
	return { ...created.manifest, status: "running" };
}

function needsAttentionNotify(manifest: TeamRunManifest) {
	return (manifest.policyDecisions ?? []).filter((item) => item.action === "notify" && item.reason === "task_needs_attention");
}

// ─── Tests ──────────────────────────────────────────────────────────

test("R4-4 (a): run with a needs_attention task → still completed, surfaced summary + non-blocking notify", async () => {
	const { cwd, created } = makeFixture();
	try {
		const tasks = withStatuses(created, ["needs_attention", "completed"]);
		const ctx = buildCtx(created, runningManifest(created), tasks);
		const result = await __test__finalizeRun(ctx);

		// Detection-first: status stays "completed" — NO status flip, NO block.
		assert.equal(result.manifest.status, "completed");
		assert.equal(result.manifest.summary, "Team workflow completed with 1 task(s) needing attention (no result submitted).");

		// The policy engine surfaced the id in a NON-blocking notify decision.
		const notify = needsAttentionNotify(result.manifest);
		assert.equal(notify.length, 1, `exactly one task_needs_attention notify, got: ${JSON.stringify(result.manifest.policyDecisions)}`);
		assert.match(notify[0]!.message, /needs_attention/);
		assert.ok(notify[0]!.message.includes(tasks[0]!.id), "notify message lists the needs_attention task id");
		assert.ok(!notify[0]!.message.includes(tasks[1]!.id), "completed task id is NOT listed");

		// Non-blocking: no block/escalate decision fired for the run.
		assert.ok(
			!(result.manifest.policyDecisions ?? []).some((item) => item.action === "block" || item.action === "escalate"),
			"needs_attention must not block or escalate the run",
		);

		// The notify block is durable: policy-decisions.json artifact carries it.
		const policyArtifact = (result.manifest.artifacts ?? []).find((artifact) => artifact.path.endsWith("policy-decisions.json"));
		assert.ok(policyArtifact, "policy-decisions.json artifact exists");
		assert.ok(fs.readFileSync(policyArtifact.path, "utf8").includes("task_needs_attention"));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("R4-4 (b): all-green run → unchanged summary, no notify block", async () => {
	const { cwd, created } = makeFixture();
	try {
		const tasks = withStatuses(created, ["completed", "completed"]);
		const ctx = buildCtx(created, runningManifest(created), tasks);
		const result = await __test__finalizeRun(ctx);

		assert.equal(result.manifest.status, "completed");
		assert.equal(result.manifest.summary, "Team workflow completed.");
		assert.equal(needsAttentionNotify(result.manifest).length, 0, "no task_needs_attention notify on an all-green run");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("R4-4 (c): mixed run counts only needs_attention tasks in the summary", async () => {
	const { cwd, created } = makeFixture();
	try {
		const tasks = withStatuses(created, ["needs_attention", "needs_attention"]);
		const ctx = buildCtx(created, runningManifest(created), tasks);
		const result = await __test__finalizeRun(ctx);

		assert.equal(result.manifest.status, "completed");
		assert.equal(result.manifest.summary, "Team workflow completed with 2 task(s) needing attention (no result submitted).");
		const notify = needsAttentionNotify(result.manifest);
		assert.equal(notify.length, 1);
		assert.match(notify[0]!.message, /2 task\(s\)/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
