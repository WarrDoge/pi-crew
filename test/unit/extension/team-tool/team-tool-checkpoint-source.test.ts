/**
 * R7-8 (DR-04 round-7): status checkpoint source-of-truth.
 *
 * `checkpointTask` (task-runner/state-helpers.ts) writes the checkpoint into
 * the TASK RECORD (tasks.json) — the FileCheckpointStore is no longer the
 * production writer. The `checkpoint` status action must therefore surface
 * `task.checkpoint` as PRIMARY (source: task-record) and only fall back to
 * the checkpoint store when the task record carries no checkpoint, reporting
 * which source answered.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handleStatusDomain } from "../../../../src/extension/team-tool/dispatch/status.ts";
import type { PiTeamsToolResult } from "../../../../src/extension/tool-result.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { FileCheckpointStore } from "../../../../src/runtime/recovery/checkpoint.ts";
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";
import { createRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "worker", agent: "worker" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "s1", role: "worker", task: "Do {goal}" }],
};

function makeCtx(cwd: string): TeamContext {
	return { cwd };
}

interface CheckpointDetails {
	details?: {
		data?: {
			source?: string;
			checkpoint?: { phase?: string; childPid?: number; step?: number };
		};
	};
}

/** Fixture run whose first task carries a task-record checkpoint (production shape). */
function createRunWithTaskCheckpoint(cwd: string): { runId: string; taskId: string } {
	const created = createRunManifest({ cwd, team, workflow, goal: "checkpoint source fixture" });
	const first = created.tasks[0] as TeamTaskState;
	const task: TeamTaskState = {
		...first,
		status: "running",
		checkpoint: {
			phase: "child-spawned",
			updatedAt: "2026-10-16T01:02:03.000Z",
			childPid: 4242,
		},
	};
	saveRunTasks(
		created.manifest,
		created.tasks.map((t) => (t.id === first.id ? task : t)),
	);
	return { runId: created.manifest.runId, taskId: first.id };
}

async function callCheckpoint(
	params: TeamToolParamsValue,
	ctx: TeamContext,
): Promise<{ text: string; data: CheckpointDetails["details"] }> {
	const res: PiTeamsToolResult & CheckpointDetails = await handleStatusDomain(params, ctx);
	return { text: textFromToolResult(res), data: res.details };
}

test("R7-8: checkpoint reads task.checkpoint from tasks.json as PRIMARY and reports the source", async () => {
	const cwd = createTrackedTempDir("pi-crew-ckpt-source-");
	try {
		const { runId, taskId } = createRunWithTaskCheckpoint(cwd);
		const { text, data } = await callCheckpoint({ action: "checkpoint", runId, taskId }, makeCtx(cwd));
		assert.match(text, /source: task\.checkpoint in tasks\.json/, "output must name the task-record source");
		assert.match(text, /phase=child-spawned/, "task-record checkpoint phase must surface");
		assert.match(text, /childPid=4242/, "task-record checkpoint childPid must surface");
		assert.equal(data?.data?.source, "task-record");
		assert.equal(data?.data?.checkpoint?.phase, "child-spawned");
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("R7-8: no task.checkpoint → falls back to FileCheckpointStore and reports that source", async () => {
	const cwd = createTrackedTempDir("pi-crew-ckpt-fallback-");
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "checkpoint fallback fixture" });
		saveRunTasks(created.manifest, created.tasks); // task record WITHOUT checkpoint
		const taskId = (created.tasks[0] as TeamTaskState).id;
		new FileCheckpointStore(created.manifest.stateRoot).save({
			runId: created.manifest.runId,
			taskId,
			step: 3,
			context: "ctx",
			progress: "half",
			savedAt: Date.parse("2026-10-16T00:00:00.000Z"),
			agentId: "worker",
		});
		const { text, data } = await callCheckpoint({ action: "checkpoint", runId: created.manifest.runId, taskId }, makeCtx(cwd));
		assert.match(text, /source: checkpoint store/, "fallback output must name the store source");
		assert.match(text, /step=3/, "store checkpoint step must surface");
		assert.equal(data?.data?.source, "checkpoint-store");
		assert.equal(data?.data?.checkpoint?.step, 3);
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("R7-8: task-record checkpoint WINS over a same-task checkpoint-store file", async () => {
	const cwd = createTrackedTempDir("pi-crew-ckpt-priority-");
	try {
		const { runId, taskId } = createRunWithTaskCheckpoint(cwd);
		// A stale store file for the same task must NOT shadow the task record.
		const stateRoot = `${cwd}/.crew/state/runs/${runId}`;
		assert.ok(fs.existsSync(stateRoot), "run state dir exists");
		new FileCheckpointStore(stateRoot).save({
			runId,
			taskId,
			step: 99,
			context: "stale",
			progress: "stale",
			savedAt: Date.now(),
			agentId: "worker",
		});
		const { text } = await callCheckpoint({ action: "checkpoint", runId, taskId }, makeCtx(cwd));
		assert.match(text, /source: task\.checkpoint in tasks\.json/, "task record is PRIMARY even with a store file present");
		assert.doesNotMatch(text, /step=99/);
	} finally {
		removeTrackedTempDir(cwd);
	}
});
