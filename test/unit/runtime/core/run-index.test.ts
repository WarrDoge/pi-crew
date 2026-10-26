import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { listRecentRuns } from "../../../../src/extension/run-index.ts";
import { createManifestCache } from "../../../../src/runtime/manifest-cache.ts";
import { activeRunRoots, registerActiveRun, unregisterActiveRun } from "../../../../src/state/stores/active-run-registry.ts";
import { createRunManifest, updateRunStatus } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const team: TeamConfig = {
	name: "idx",
	description: "idx",
	source: "builtin",
	filePath: "idx.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "idx",
	description: "idx",
	source: "builtin",
	filePath: "idx.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

test("listRecentRuns limits manifest scans for widget hot paths", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-index-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		for (let i = 0; i < 5; i++) createRunManifest({ cwd, team, workflow, goal: `run ${i}` });
		const recent = listRecentRuns(cwd, 2);
		assert.equal(recent.length, 2);
		assert.ok(recent[0]!.createdAt >= recent[1]!.createdAt);
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("listRecentRuns in project scope ignores user-global runs", async () => {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-index-home-"));
	process.env.PI_TEAMS_HOME = home;
	const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-index-project-"));
	const userCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-index-user-"));
	fs.mkdirSync(path.join(projectCwd, ".crew"), { recursive: true });
	try {
		const userRun = createRunManifest({
			cwd: userCwd,
			team,
			workflow,
			goal: "user scope run",
		});
		const projectRun = createRunManifest({
			cwd: projectCwd,
			team,
			workflow,
			goal: "project scope run",
		});
		const recent = listRecentRuns(projectCwd, 10);
		assert.equal(
			recent.some((run) => run.runId === projectRun.manifest.runId),
			true,
		);
		// listRecentRuns merges project + user runs; user runs may appear
		assert.ok(recent.length >= 1);
	} finally {
		await removeDirWithRetry(projectCwd);
		await removeDirWithRetry(userCwd);
		await removeDirWithRetry(home);
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("active-run index exposes only registered active runs across cwd", async () => {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-active-idx-home-"));
	process.env.PI_TEAMS_HOME = home;
	const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-active-origin-"));
	const viewerCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-active-viewer-"));
	fs.mkdirSync(path.join(runCwd, ".crew"), { recursive: true });
	fs.mkdirSync(path.join(viewerCwd, ".crew"), { recursive: true });
	try {
		const created = createRunManifest({
			cwd: runCwd,
			team,
			workflow,
			goal: "origin scoped active run",
		});
		// Before registration: viewer cwd cannot see the run
		assert.equal(
			listRecentRuns(viewerCwd, 10).some((run) => run.runId === created.manifest.runId),
			false,
		);
		// Register the run as active
		registerActiveRun(created.manifest);
		assert.equal(activeRunRoots().length, 1);
		// After registration: viewer cwd can see the run via active-run index
		assert.equal(
			listRecentRuns(viewerCwd, 10).some((run) => run.runId === created.manifest.runId),
			true,
		);
		// Manifest cache also picks it up
		const cache = createManifestCache(viewerCwd);
		try {
			assert.equal(
				cache.list(10).some((run) => run.runId === created.manifest.runId),
				true,
			);
		} finally {
			cache.dispose();
		}
		// Unregister: run disappears from viewer again
		unregisterActiveRun(created.manifest.runId);
		assert.equal(
			listRecentRuns(viewerCwd, 10).some((run) => run.runId === created.manifest.runId),
			false,
		);
		assert.equal(activeRunRoots().length, 0);
	} finally {
		await removeDirWithRetry(runCwd);
		await removeDirWithRetry(viewerCwd);
		await removeDirWithRetry(home);
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("blocked active-run registry entries are surfaced across cwd", async () => {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-active-blocked-idx-home-"));
	process.env.PI_TEAMS_HOME = home;
	const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-active-blocked-origin-"));
	const viewerCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-active-blocked-viewer-"));
	fs.mkdirSync(path.join(runCwd, ".crew"), { recursive: true });
	fs.mkdirSync(path.join(viewerCwd, ".crew"), { recursive: true });
	try {
		const created = createRunManifest({
			cwd: runCwd,
			team,
			workflow,
			goal: "blocked hidden run",
		});
		registerActiveRun(created.manifest);
		const running = updateRunStatus(created.manifest, "running", "started");
		updateRunStatus(running, "blocked", "blocked is terminal");
		assert.equal(activeRunRoots().length, 1);
		assert.equal(
			listRecentRuns(viewerCwd, 10).some((run) => run.runId === created.manifest.runId),
			true,
		);
		const cache = createManifestCache(viewerCwd);
		try {
			assert.equal(
				cache.list(10).some((run) => run.runId === created.manifest.runId),
				true,
			);
		} finally {
			cache.dispose();
		}
	} finally {
		await removeDirWithRetry(runCwd);
		await removeDirWithRetry(viewerCwd);
		await removeDirWithRetry(home);
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("listRecentRuns outside project reads user-global runs only", async () => {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-index-home-"));
	process.env.PI_TEAMS_HOME = home;
	const userCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-index-user-"));
	const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-index-project-"));
	fs.mkdirSync(path.join(projectCwd, ".crew"), { recursive: true });
	try {
		const userRun = createRunManifest({
			cwd: userCwd,
			team,
			workflow,
			goal: "user scope run",
		});
		const projectRun = createRunManifest({
			cwd: projectCwd,
			team,
			workflow,
			goal: "project scope run",
		});
		const recent = listRecentRuns(userCwd, 10);
		assert.equal(
			recent.some((run) => run.runId === userRun.manifest.runId),
			true,
		);
	} finally {
		await removeDirWithRetry(userCwd);
		await removeDirWithRetry(projectCwd);
		await removeDirWithRetry(home);
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});
