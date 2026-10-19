/**
 * R48-N2 regression replay (fix-wave 6, EP3) — the "zombie-sync" orphan blind
 * spot. Ported from the hard-evidence probe
 * `fixwave6-sdd-2026-10-19/probes/r50b-s6/probe-b-orphan.ts` (log
 * `logs/b-orphan.log`):
 *
 *   B1 = zombie sync run: task "running" + agent frozen "running" (no progress
 *        written), host process dead, manifest.updatedAt 20 min stale.
 *        BEFORE the fix `isLikelyOrphanedActiveRun` returned false (a frozen
 *        `running` agent defeated both branches) and the health scan reported
 *        NOTHING, while `detectStuckTasks` DID see the stale task.
 *   B3 = 0 agents, stale, NON-magic summary.
 *   B4 = 0 agents, stale, the exact legacy magic summary
 *        ("Creating workflow prompts and placeholder results.").
 *        BEFORE the fix B3 was silently ignored and B4 was flagged purely on
 *        the summary STRING. AFTER the fix both are flagged structurally, so
 *        the two controls are identical (summary is irrelevant).
 *   C  = healthy control: fresh manifest + a running agent with recent activity
 *        evidence → NOT orphaned.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildHealthReport, detectStuckTasks } from "../../../../src/extension/team-tool/health-monitor.ts";
import { isLikelyOrphanedActiveRun } from "../../../../src/runtime/process-status.ts";
import {
	__test__clearManifestCache,
	createRunManifest,
	saveRunManifest,
	saveRunTasks,
	updateRunStatus,
} from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import { clearProjectRootCache } from "../../../../src/utils/paths.ts";
import { sharedScanCache } from "../../../../src/utils/scan-cache.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { resolveCanonicalDir } from "../../../fixtures/test-tempdir.ts";

const team: TeamConfig = {
	name: "health-n2-test",
	description: "R48-N2 replay team",
	source: "builtin",
	filePath: "health-n2-test.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const workflow: WorkflowConfig = {
	name: "health-n2-test",
	description: "R48-N2 replay workflow",
	source: "builtin",
	filePath: "health-n2-test.workflow.md",
	steps: [{ id: "run", role: "executor", task: "Run {goal}" }],
};

function withIsolatedHome<T>(fn: () => T): T {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = resolveCanonicalDir(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-n2-home-")));
	process.env.PI_TEAMS_HOME = home;
	clearProjectRootCache();
	sharedScanCache.clear();
	__test__clearManifestCache();
	try {
		return fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
		clearProjectRootCache();
		sharedScanCache.clear();
		__test__clearManifestCache();
	}
}

function createProjectCwd(tmpDir: string): string {
	const cwd = resolveCanonicalDir(fs.mkdtempSync(path.join(tmpDir, "hc-n2-cwd-")));
	fs.mkdirSync(path.join(cwd, ".crew"));
	return cwd;
}

function createIsolatedTmpDir(): string {
	return resolveCanonicalDir(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-n2-tmp-")));
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** Write agents.json for a run (mirrors the probe's frozen-running-agent shape). */
function writeAgents(manifest: TeamRunManifest, agents: unknown[]): void {
	fs.writeFileSync(path.join(manifest.stateRoot, "agents.json"), JSON.stringify(agents, null, 1));
}

test("R48-N2 replay: frozen running agent + dead host (B1) IS flagged as orphaned", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);
		try {
			const created = createRunManifest({ cwd: projectCwd, team, workflow, goal: "zombie sync" });
			const running = updateRunStatus(created.manifest, "running", "started");
			const staleManifest: TeamRunManifest = { ...running, updatedAt: minutesAgo(20) };
			saveRunManifest(staleManifest);

			// Frozen running agent: no progress evidence at all (the blind spot).
			writeAgents(running, [
				{
					id: "a1",
					runId: running.runId,
					taskId: created.tasks[0]!.id,
					agent: "executor",
					role: "executor",
					runtime: "child-process",
					status: "running",
					startedAt: minutesAgo(25),
				},
			]);
			// A stale running task so the stuck scanner ALSO has a signal (contrast).
			const staleTasks: TeamTaskState[] = [
				{
					...created.tasks[0]!,
					status: "running",
					startedAt: minutesAgo(25),
					agentProgress: { recentTools: [], recentOutput: [], toolCount: 0, lastActivityAt: minutesAgo(25) },
				},
			];
			saveRunTasks(running, staleTasks);

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			// Pure verdict.
			assert.equal(
				isLikelyOrphanedActiveRun(staleManifest, [
					{
						id: "a1",
						runId: running.runId,
						taskId: created.tasks[0]!.id,
						agent: "executor",
						role: "executor",
						runtime: "child-process",
						status: "running",
						startedAt: minutesAgo(25),
					},
				]),
				true,
				"frozen running agent must be detected as orphaned (R48-N2)",
			);

			// Health scan surfaces it.
			const { text, counts } = buildHealthReport({ cwd: projectCwd }, {}, { tmpDir: isolatedTmp });
			assert.equal(counts.orphaned, 1, "one orphaned run reported");
			assert.ok(text.includes(running.runId), "report lists the zombie-sync runId");

			// Contrast: the stuck scanner could already see it (structural signal existed).
			const stuck = detectStuckTasks({ runId: running.runId, stateRoot: running.stateRoot }, Date.now());
			assert.equal(stuck.length, 1, "stuck-task scanner sees the stale running task");
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

test("R48-N2 replay: 0-agent stale runs (B3 non-magic, B4 magic) are flagged identically", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);
		try {
			const magic = "Creating workflow prompts and placeholder results.";
			const b3 = createRunManifest({ cwd: projectCwd, team, workflow, goal: "b3" });
			const b3r = updateRunStatus(b3.manifest, "running", "started");
			saveRunManifest({ ...b3r, updatedAt: minutesAgo(20), summary: "Investigating flaky test in worker lane" });
			writeAgents(b3r, []);

			const b4 = createRunManifest({ cwd: projectCwd, team, workflow, goal: "b4" });
			const b4r = updateRunStatus(b4.manifest, "running", "started");
			saveRunManifest({ ...b4r, updatedAt: minutesAgo(20), summary: magic });
			writeAgents(b4r, []);

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			// Summary is irrelevant post-fix: both stale 0-agent runs are orphaned.
			assert.equal(isLikelyOrphanedActiveRun({ ...b3r, updatedAt: minutesAgo(20), summary: "x" }, []), true);
			assert.equal(isLikelyOrphanedActiveRun({ ...b4r, updatedAt: minutesAgo(20), summary: magic }, []), true);

			const { counts } = buildHealthReport({ cwd: projectCwd }, {}, { tmpDir: isolatedTmp });
			assert.equal(counts.total, 2);
			assert.equal(counts.orphaned, 2, "both 0-agent stale runs flagged (magic string no longer needed)");
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

test("R48-N2 replay: healthy control — running agent with recent activity is NOT orphaned", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);
		try {
			const created = createRunManifest({ cwd: projectCwd, team, workflow, goal: "healthy" });
			const running = updateRunStatus(created.manifest, "running", "started");
			saveRunManifest({ ...running, updatedAt: minutesAgo(20) }); // stale manifest, live worker
			writeAgents(running, [
				{
					id: "a1",
					runId: running.runId,
					taskId: created.tasks[0]!.id,
					agent: "executor",
					role: "executor",
					runtime: "child-process",
					status: "running",
					startedAt: minutesAgo(20),
					progress: {
						recentTools: [],
						recentOutput: [],
						toolCount: 4,
						lastActivityAt: new Date(Date.now() - 30_000).toISOString(),
					},
				},
			]);

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			const { counts } = buildHealthReport({ cwd: projectCwd }, {}, { tmpDir: isolatedTmp });
			assert.equal(counts.total, 1);
			assert.equal(counts.orphaned, 0, "recent agent activity proves the host is alive");
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});
