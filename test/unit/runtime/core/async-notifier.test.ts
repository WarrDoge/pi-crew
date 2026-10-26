import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	type AsyncNotifierState,
	failStillActiveTasks,
	markDeadAsyncRunIfNeeded,
	startAsyncRunNotifier,
	stopAsyncRunNotifier,
} from "../../../../src/extension/async-notifier.ts";
import { readCrewAgents, recordFromTask, saveCrewAgents } from "../../../../src/runtime/crew-agent-records.ts";
import { withRunLock } from "../../../../src/state/coordination/locks.ts";
import { appendEvent, readEvents } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { cleanupStateRoot } from "../../../helpers/rm-retry.ts";

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("async notifier reports pre-existing active runs that finish after notifier start", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifier-existing-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const notifications: Array<{ text: string; level?: string }> = [];
	const state: AsyncNotifierState = { seenFinishedRunIds: new Set() };
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "pre-existing",
		});
		saveRunManifest({ ...created.manifest, status: "running" }, { allowTerminalExit: true });
		startAsyncRunNotifier(
			{
				cwd,
				ui: {
					notify: (text: string, level?: string) => notifications.push({ text, level }),
				},
			} as never,
			state,
			10,
		);
		saveRunManifest({
			...created.manifest,
			status: "failed",
			summary: "finished after notifier start",
			updatedAt: new Date().toISOString(),
		});
		await wait(40);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.text, /failed/);
	} finally {
		stopAsyncRunNotifier(state);
		await cleanupStateRoot(cwd);
	}
});

/* Regression: auto-compaction can stop/restart the extension while an async run
 * is still active. The restarted notifier must not mark that active run as
 * already consumed, otherwise the completion follow-up is lost. */
test("async notifier reports run completed across session restart", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifier-restart-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const notifications: Array<{ text: string; level?: string }> = [];
	const state: AsyncNotifierState = { seenFinishedRunIds: new Set() };
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "compaction restart",
		});
		saveRunManifest({ ...created.manifest, status: "running" }, { allowTerminalExit: true });
		startAsyncRunNotifier(
			{
				cwd,
				ui: {
					notify: (text: string, level?: string) => notifications.push({ text, level }),
				},
			} as never,
			state,
			10,
		);
		stopAsyncRunNotifier(state);
		saveRunManifest({
			...created.manifest,
			status: "completed",
			updatedAt: new Date().toISOString(),
		});
		startAsyncRunNotifier(
			{
				cwd,
				ui: {
					notify: (text: string, level?: string) => notifications.push({ text, level }),
				},
			} as never,
			state,
			10,
		);
		await wait(40);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.text, /completed/);
	} finally {
		stopAsyncRunNotifier(state);
		await cleanupStateRoot(cwd);
	}
});

test("async notifier marks quiet dead background runner as failed", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifier-dead-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "dead async",
		});
		const oldTime = new Date(Date.now() - 60_000).toISOString();
		const manifest = {
			...created.manifest,
			status: "running" as const,
			updatedAt: oldTime,
			async: {
				pid: 999_999_999,
				logPath: path.join(created.manifest.stateRoot, "background.log"),
				spawnedAt: oldTime,
			},
		};
		saveRunManifest(manifest);
		appendEvent(manifest.eventsPath, {
			type: "async.started",
			runId: manifest.runId,
			data: { pid: manifest.async.pid },
		});
		const runningTasks = created.tasks.map((task) => ({
			...task,
			status: "running" as const,
			startedAt: oldTime,
		}));
		saveRunTasks(manifest, runningTasks);
		saveCrewAgents(
			manifest,
			runningTasks.map((task) => recordFromTask(manifest, task, "live-session")),
		);
		const marked = await markDeadAsyncRunIfNeeded(manifest, Date.now() + 60_000, 30_000);
		assert.ok(marked);
		assert.equal(marked.status, "failed");
		assert.equal(
			readEvents(marked.eventsPath).some((event) => event.type === "async.died"),
			true,
		);
		const repaired = loadRunManifestById(cwd, manifest.runId);
		assert.equal(repaired?.tasks[0]?.status, "failed");
		assert.equal(readCrewAgents(manifest)[0]?.status, "failed");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("async notifier suppresses notifications after generation becomes stale", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifier-stale-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const notifications: Array<{ text: string; level?: string }> = [];
	const state: AsyncNotifierState = { seenFinishedRunIds: new Set() };
	let currentGeneration = 1;
	try {
		startAsyncRunNotifier(
			{
				cwd,
				ui: {
					notify: (text: string, level?: string) => notifications.push({ text, level }),
				},
			} as never,
			state,
			10,
			{
				generation: 1,
				isCurrent: (generation) => generation === currentGeneration,
			},
		);
		currentGeneration = 2;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "stale run",
		});
		saveRunManifest({ ...created.manifest, status: "completed" });
		await wait(40);
		assert.equal(notifications.length, 0);
	} finally {
		stopAsyncRunNotifier(state);
		await cleanupStateRoot(cwd);
	}
});

test("async notifier still reports runs created after notifier start", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifier-new-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const notifications: Array<{ text: string; level?: string }> = [];
	const state: AsyncNotifierState = { seenFinishedRunIds: new Set() };
	try {
		startAsyncRunNotifier(
			{
				cwd,
				ui: {
					notify: (text: string, level?: string) => notifications.push({ text, level }),
				},
			} as never,
			state,
			10,
		);
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "new run",
		});
		saveRunManifest({ ...created.manifest, status: "completed" });
		await wait(40);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.text, /completed/);
		assert.equal(notifications[0]!.level, "info");
	} finally {
		stopAsyncRunNotifier(state);
		await cleanupStateRoot(cwd);
	}
});

/* Vector #11: the notifier must only toast runs owned by the CURRENT pi
 * session (plus ownerless/legacy runs). Runs owned by a different session must
 * be invisible — otherwise session B notifies about session A's completions. */
test("async notifier skips toasts for runs owned by another session", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifier-xsession-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const notifications: Array<{ text: string; level?: string }> = [];
	const state: AsyncNotifierState = { seenFinishedRunIds: new Set() };
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "other session" });
		// Run is owned by session-A, but this notifier runs as session-B.
		saveRunManifest({ ...created.manifest, status: "completed", ownerSessionId: "session-A" });
		startAsyncRunNotifier(
			{
				cwd,
				sessionManager: { getSessionId: () => "session-B" },
				ui: {
					notify: (text: string, level?: string) => notifications.push({ text, level }),
				},
			} as never,
			state,
			10,
		);
		await wait(40);
		assert.equal(notifications.length, 0, "must not toast another session's run");
	} finally {
		stopAsyncRunNotifier(state);
		await cleanupStateRoot(cwd);
	}
});

test("async notifier still toasts runs owned by the current session", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifier-samesession-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const notifications: Array<{ text: string; level?: string }> = [];
	const state: AsyncNotifierState = { seenFinishedRunIds: new Set() };
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "own session" });
		saveRunManifest({ ...created.manifest, status: "running", ownerSessionId: "session-B" }, { allowTerminalExit: true });
		startAsyncRunNotifier(
			{
				cwd,
				sessionManager: { getSessionId: () => "session-B" },
				ui: {
					notify: (text: string, level?: string) => notifications.push({ text, level }),
				},
			} as never,
			state,
			10,
		);
		saveRunManifest({
			...created.manifest,
			status: "completed",
			ownerSessionId: "session-B",
			updatedAt: new Date().toISOString(),
		});
		await wait(40);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.text, /completed/);
	} finally {
		stopAsyncRunNotifier(state);
		await cleanupStateRoot(cwd);
	}
});

// ── R4-7 (DR-02 Wave 2 Cluster C): async-died task sweep is a run-locked RMW ───

/** Dead-async-run fixture: quiet, running, with a dead runner pid. */
function deadAsyncRun(cwd: string, goal: string): ReturnType<typeof createRunManifest>["manifest"] {
	const created = createRunManifest({ cwd, team, workflow, goal });
	const oldTime = new Date(Date.now() - 60_000).toISOString();
	const manifest = {
		...created.manifest,
		status: "running" as const,
		updatedAt: oldTime,
		async: {
			pid: 999_999_999,
			logPath: path.join(created.manifest.stateRoot, "background.log"),
			spawnedAt: oldTime,
		},
	};
	saveRunManifest(manifest);
	appendEvent(manifest.eventsPath, {
		type: "async.started",
		runId: manifest.runId,
		data: { pid: manifest.async.pid },
	});
	return manifest;
}

test("R4-7 helper: failStillActiveTasks flips only running/queued/waiting tasks", () => {
	const failedAt = "2026-10-15T00:00:00.000Z";
	const message = "Background runner died unexpectedly";
	const make = (id: string, status: TeamTaskState["status"]): TeamTaskState => ({
		id,
		runId: "team_test",
		role: "worker",
		agent: "worker",
		title: id,
		status,
		dependsOn: [],
		cwd: "/tmp",
	});
	const result = failStillActiveTasks(
		[
			make("a", "running"),
			make("b", "queued"),
			make("c", "waiting"),
			make("d", "completed"),
			make("e", "cancelled"),
			make("f", "failed"),
		],
		failedAt,
		message,
	);
	const byId = new Map(result.map((task) => [task.id, task]));
	for (const id of ["a", "b", "c"]) {
		assert.equal(byId.get(id)?.status, "failed", `${id} must be flipped`);
		assert.equal(byId.get(id)?.finishedAt, failedAt);
		assert.equal(byId.get(id)?.error, message);
	}
	assert.deepEqual(byId.get("d"), make("d", "completed"), "terminal task untouched (object equality)");
	assert.deepEqual(byId.get("e"), make("e", "cancelled"), "terminal task untouched (object equality)");
	assert.deepEqual(byId.get("f"), make("f", "failed"), "already-failed task untouched (object equality)");
});

/** Minimal task fixture for the R4-7 sweep tests. */
function sweepTask(manifest: ReturnType<typeof createRunManifest>["manifest"], id: string, status: TeamTaskState["status"]): TeamTaskState {
	return {
		id,
		runId: manifest.runId,
		role: "planner",
		agent: "planner",
		title: id,
		status,
		dependsOn: [],
		cwd: manifest.cwd,
	};
}

test("R4-7: only tasks STILL active in the fresh locked read are flipped — completed tasks survive the dead-runner sweep", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifier-r47-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const manifest = deadAsyncRun(cwd, "r4-7 still-active guard");
		const completedAt = new Date(Date.now() - 30_000).toISOString();
		// A concurrent writer completed one task; the other is still running.
		saveRunTasks(manifest, [
			{ ...sweepTask(manifest, "done", "completed"), finishedAt: completedAt },
			sweepTask(manifest, "live", "running"),
		]);
		const marked = await markDeadAsyncRunIfNeeded(manifest, Date.now() + 60_000, 30_000);
		assert.ok(marked);
		assert.equal(marked.status, "failed");
		const repaired = loadRunManifestById(cwd, manifest.runId);
		const done = repaired?.tasks.find((task) => task.id === "done");
		assert.equal(done?.status, "completed", "task completed by a concurrent writer must NOT be overwritten with failed");
		assert.equal(done?.finishedAt, completedAt, "its finishedAt must survive verbatim");
		assert.equal(repaired?.tasks.find((task) => task.id === "live")?.status, "failed", "still-active task is swept");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("R4-7 re-entrance: the dead-runner sweep never self-deadlocks when the run lock is already held in the same async context", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifier-r47b-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const manifest = deadAsyncRun(cwd, "r4-7 re-entrance");
		saveRunTasks(manifest, [sweepTask(manifest, "swept", "running")]);
		// The notifier tick may fire while another withRunLock holder for the SAME
		// run is awaiting in this process — markDeadAsyncRunIfNeeded (and its
		// nested withRunLockSync in markActiveTasksAndAgentsFailed) must bypass
		// re-entrantly, not block/starve/throw-busy.
		const marked = await withRunLock(manifest, () => markDeadAsyncRunIfNeeded(manifest, Date.now() + 60_000, 30_000));
		assert.ok(marked);
		assert.equal(marked.status, "failed");
		const repaired = loadRunManifestById(cwd, manifest.runId);
		assert.equal(repaired?.tasks.find((task) => task.id === "swept")?.status, "failed");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("R4-7 wiring pin: markActiveTasksAndAgentsFailed is a withRunLockSync RMW with the fresh re-read inside the lock", () => {
	const src = fs.readFileSync(path.join(import.meta.dirname, "../../../../src/extension/async-notifier.ts"), "utf-8");
	const fnIdx = src.indexOf("function markActiveTasksAndAgentsFailed");
	assert.ok(fnIdx > -1, "markActiveTasksAndAgentsFailed must exist");
	const body = src.slice(fnIdx, src.indexOf("const agents = readCrewAgents(run)", fnIdx));
	const lockIdx = body.indexOf("withRunLockSync(run,");
	const loadIdx = body.indexOf("loadRunManifestById(run.cwd, run.runId)");
	const saveIdx = body.indexOf("saveRunTasks(fresh.manifest,");
	assert.ok(lockIdx > -1, "tasks sweep must be wrapped in withRunLockSync");
	assert.ok(loadIdx > lockIdx, "fresh re-read must happen INSIDE the lock");
	assert.ok(saveIdx > loadIdx, "save must operate on the freshly read array");
	assert.ok(!body.includes("// NOTE: no withRunLock"), "the old unlocked-RMW marker comment must be gone");
});
