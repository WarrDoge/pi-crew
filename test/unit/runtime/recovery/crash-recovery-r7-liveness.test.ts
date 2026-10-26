/**
 * DR-04 W1 (round-7 audit fixes) — liveness revalidation in crash-recovery.
 *
 * R7-1 (HIGH) — purge step 6 false-cancels a LIVE dynamic-workflow (DWF)
 *   foreground run. `hasRecentLifeEvidence` only knows manifest.updatedAt +
 *   heartbeat.json; DWF-foreground runs write NEITHER while a long subagent
 *   step executes — only task heartbeats keep flowing. Past staleThresholdMs
 *   step 6 cancelled the live run and dropped its registry entry; a later
 *   `team resume` double-dispatched the still-running worker.
 *   Fix under test: step 6 (under the run lock, fresh snapshot) honors the
 *   same task-level evidence cancelOrphanedRuns uses (hasRecentTaskActivity).
 *
 * R7-6 (MED) — under-lock revalidation in cancelOrphanedRuns / purge steps
 *   5+6 checked only `status === "running"`, never re-deriving the liveness
 *   inputs the cancel decision was built on. A `team resume` adopting the run
 *   between the pre-lock scan and lock acquisition rewrites manifest.updatedAt
 *   (adoption save) — the cancel must abort instead of killing a live run.
 *   Fix under test: hasFreshLivenessEvidence re-checks fresh updatedAt /
 *   heartbeat.json mtime / live fresh pid / task heartbeats under the lock.
 *
 * M-4 (LOW) — applyRecoveryPlan reset the plan's resumableTasks verbatim from
 *   a stale snapshot; a task that reached a terminal status during the
 *   run_recovery hook gap was requeued, destroying its result.
 *   Fix under test: `reset` is filtered to tasks whose FRESH status is
 *   non-terminal (mirror of applyReconcileAtOpenFastPath's filter).
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ManifestCache } from "../../../../src/runtime/manifest-cache.ts";
import {
	_setReadManifestFileSyncForTest,
	applyRecoveryPlan,
	cancelOrphanedRuns,
	purgeStaleActiveRunIndex,
} from "../../../../src/runtime/recovery/crash-recovery.ts";
import { readEvents } from "../../../../src/state/event-log/event-log.ts";
import { readActiveRunRegistry, registerActiveRun } from "../../../../src/state/stores/active-run-registry.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { cleanupStateRoot } from "../../../helpers/rm-retry.ts";

const team: TeamConfig = {
	name: "r7",
	description: "r7",
	source: "builtin",
	filePath: "r7.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "r7",
	description: "r7",
	source: "builtin",
	filePath: "r7.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

const STALE = 5 * 60 * 1000; // matches the default staleThresholdMs

/** A long-lived child whose PID is alive (for registration) and can be reaped. */
class AliveWorker {
	readonly pid: number;
	private readonly child: ChildProcess;
	constructor() {
		this.child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], { stdio: "ignore" });
		this.pid = this.child.pid ?? -1;
	}
	/** Kill + fully reap so the PID is genuinely dead (ESRCH), not a zombie. */
	async stop(): Promise<void> {
		try {
			this.child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
		await new Promise<void>((resolve) => {
			this.child.once("exit", () => resolve());
			setTimeout(resolve, 2000);
		});
	}
}

async function withIsolatedHomeAsync<T>(fn: () => Promise<T>): Promise<T> {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-r7-home-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		await cleanupStateRoot(home);
	}
}

function mkProjectDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
	return dir;
}

/** Manifest with the `async` field ABSENT (foreground run — step 6's shape). */
function foregroundManifest(
	created: { manifest: TeamRunManifest },
	overrides: { updatedAt: string; ownerSessionId: string },
): TeamRunManifest {
	const { async: _async, ...foreground } = created.manifest;
	void _async;
	return {
		...foreground,
		status: "running",
		ownerSessionId: overrides.ownerSessionId,
		updatedAt: overrides.updatedAt,
	};
}

function runningTaskWithHeartbeat(task: TeamTaskState, lastSeenAtIso: string): TeamTaskState {
	return {
		...task,
		status: "running",
		startedAt: lastSeenAtIso,
		heartbeat: { workerId: "dwf-worker", alive: true, lastSeenAt: lastSeenAtIso },
	};
}

function registryHasEntry(runId: string): boolean {
	return readActiveRunRegistry().some((entry) => entry.runId === runId);
}

function fakeCache(manifests: TeamRunManifest[]): ManifestCache {
	return { list: () => manifests } as unknown as ManifestCache;
}

// ─── R7-1 (HIGH): DWF-foreground false-cancel — fresh task heartbeat must veto step 6 ───

test("R7-1: purge step 6 does NOT cancel a foreground run with a fresh task heartbeat (no heartbeat.json, stale manifest)", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = mkProjectDir("pi-crew-r7-dwf-");
		try {
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "DWF foreground run" });
			// 20 min into a long subagent step: manifest.updatedAt frozen at t0,
			// NO team-level heartbeat.json (DWF-foreground never writes one)…
			const manifest = foregroundManifest(created, { updatedAt: new Date(t0).toISOString(), ownerSessionId: "session-MAIN" });
			saveRunManifest(manifest);
			// …but the worker heartbeats every ~30s (fresh in simulated time).
			const now = t0 + 20 * 60 * 1000;
			saveRunTasks(manifest, [runningTaskWithHeartbeat(created.tasks[0]!, new Date(now - 30_000).toISOString())]);
			registerActiveRun(manifest);

			const result = purgeStaleActiveRunIndex(STALE, now);

			assert.ok(!result.purged.includes(manifest.runId), "R7-1: live DWF-foreground run must NOT be purged");
			assert.ok(result.kept.includes(manifest.runId), "run must be kept");
			assert.ok(registryHasEntry(manifest.runId), "registry entry (live-claim signal) must survive");
			const after = loadRunManifestById(cwd, manifest.runId)!;
			assert.equal(after.manifest.status, "running", "run survives the purge scan");
			assert.equal(after.tasks[0]!.status, "running", "the running task is not cancelled");
		} finally {
			await cleanupStateRoot(cwd);
		}
	});
});

test("R7-1 (counterfactual): the same foreground run WITHOUT fresh task evidence is still cancelled", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = mkProjectDir("pi-crew-r7-dwf-stale-");
		try {
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "stale foreground run" });
			const manifest = foregroundManifest(created, { updatedAt: new Date(t0).toISOString(), ownerSessionId: "session-MAIN" });
			saveRunManifest(manifest);
			const now = t0 + 20 * 60 * 1000;
			// Heartbeat frozen at t0 too — genuinely dead run (crashed process).
			saveRunTasks(manifest, [runningTaskWithHeartbeat(created.tasks[0]!, new Date(t0).toISOString())]);
			registerActiveRun(manifest);

			const result = purgeStaleActiveRunIndex(STALE, now);

			assert.ok(result.purged.includes(manifest.runId), "a run with NO fresh evidence of any kind must still be cancelled");
			const after = loadRunManifestById(cwd, manifest.runId)!;
			assert.equal(after.manifest.status, "cancelled", "genuinely-dead run is cancelled");
		} finally {
			await cleanupStateRoot(cwd);
		}
	});
});

// ─── R7-6 (MED): resume-adoption race — fresh liveness observed under the lock aborts the cancel ───

test("R7-6: purge step 6 aborts when a fresh manifest.updatedAt appears under the lock (resume just adopted)", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = mkProjectDir("pi-crew-r7-adopt6-");
		try {
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "adopted run" });
			const now = t0 + 20 * 60 * 1000;
			// ON DISK (what the under-lock re-read sees): a `team resume` adopted
			// the run 1 min ago — adoption saves the manifest (fresh updatedAt).
			const adopted = foregroundManifest(created, {
				updatedAt: new Date(now - 60_000).toISOString(),
				ownerSessionId: "session-RESUMED",
			});
			saveRunManifest(adopted);
			saveRunTasks(adopted, [{ ...created.tasks[0]!, status: "running", startedAt: new Date(now - 60_000).toISOString() }]);
			registerActiveRun(adopted);

			// PRE-LOCK read (purge step 3) still sees the PRE-adoption manifest:
			// stale updatedAt, same shape. This is the exact race window R7-6 pins.
			const preAdoption = { ...adopted, updatedAt: new Date(t0).toISOString(), ownerSessionId: "session-DEAD" };
			_setReadManifestFileSyncForTest(() => JSON.stringify(preAdoption));
			let result: ReturnType<typeof purgeStaleActiveRunIndex>;
			try {
				result = purgeStaleActiveRunIndex(STALE, now);
			} finally {
				_setReadManifestFileSyncForTest(null);
			}

			assert.ok(!result.purged.includes(adopted.runId), "R7-6: an adopted run must NOT be cancelled by the purge");
			assert.ok(result.kept.includes(adopted.runId), "adopted run is kept");
			assert.ok(registryHasEntry(adopted.runId), "registry entry must survive the abort");
			const after = loadRunManifestById(cwd, adopted.runId)!;
			assert.equal(after.manifest.status, "running", "run still running after the aborted purge");
			const events = readEvents(after.manifest.eventsPath);
			assert.ok(
				events.some(
					(e) =>
						e.type === "crew.run.orphan_skip" &&
						(e.data as { reason?: string } | undefined)?.reason === "fresh_liveness_under_lock",
				),
				"the abort is recorded as an orphan_skip event with the fresh_liveness_under_lock reason",
			);
		} finally {
			await cleanupStateRoot(cwd);
		}
	});
});

test("R7-6: purge step 5 (dead worker pid) aborts when fresh manifest.updatedAt appears under the lock", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = mkProjectDir("pi-crew-r7-adopt5-");
		try {
			const worker = new AliveWorker();
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "adopted async run" });
			const now = t0 + 20 * 60 * 1000;
			// ON DISK: worker pid dead (reaped) but a resume adopted the run 1 min
			// ago — fresh updatedAt under the lock.
			const adopted: TeamRunManifest = {
				...created.manifest,
				status: "running",
				ownerSessionId: "session-RESUMED",
				updatedAt: new Date(now - 60_000).toISOString(),
				async: { pid: worker.pid, logPath: "", spawnedAt: new Date(t0).toISOString() },
			};
			saveRunManifest(adopted);
			saveRunTasks(adopted, [{ ...created.tasks[0]!, status: "running", startedAt: new Date(now - 60_000).toISOString() }]);
			registerActiveRun(adopted); // pid alive at registration
			await worker.stop(); // pid now genuinely dead — the pre-lock gate's evidence

			// PRE-LOCK read sees the stale pre-adoption copy (stale updatedAt).
			const preAdoption = { ...adopted, updatedAt: new Date(t0).toISOString() };
			_setReadManifestFileSyncForTest(() => JSON.stringify(preAdoption));
			let result: ReturnType<typeof purgeStaleActiveRunIndex>;
			try {
				result = purgeStaleActiveRunIndex(STALE, now);
			} finally {
				_setReadManifestFileSyncForTest(null);
			}

			assert.ok(!result.purged.includes(adopted.runId), "R7-6: dead-pid run with fresh adoption evidence must NOT be cancelled");
			assert.ok(result.kept.includes(adopted.runId), "adopted run is kept");
			const after = loadRunManifestById(cwd, adopted.runId)!;
			assert.equal(after.manifest.status, "running", "run still running after the aborted purge");
		} finally {
			await cleanupStateRoot(cwd);
		}
	});
});

test("R7-6: cancelOrphanedRuns aborts when a fresh manifest.updatedAt appears under the lock (resume just adopted)", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = mkProjectDir("pi-crew-r7-adopt-cancel-");
		try {
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "adopted run vs orphan-cancel" });
			const now = t0 + 20 * 60 * 1000;
			// ON DISK: adopted 1 min ago — fresh updatedAt under the lock.
			const adopted = foregroundManifest(created, {
				updatedAt: new Date(now - 60_000).toISOString(),
				ownerSessionId: "session-RESUMED",
			});
			saveRunManifest(adopted);
			saveRunTasks(adopted, [{ ...created.tasks[0]!, status: "running", startedAt: new Date(now - 60_000).toISOString() }]);

			// The manifest CACHE (what the scan iterates) still holds the
			// PRE-adoption snapshot — stale updatedAt, dead owner session.
			const cached = { ...adopted, updatedAt: new Date(t0).toISOString(), ownerSessionId: "session-DEAD" };

			const result = cancelOrphanedRuns(cwd, fakeCache([cached]), "session-THIRD", STALE, now);

			assert.deepEqual(result.cancelled, [], "R7-6: an adopted run must NOT be orphan-cancelled");
			assert.ok(result.skipped.includes(adopted.runId), "adopted run is reported skipped");
			const after = loadRunManifestById(cwd, adopted.runId)!;
			assert.equal(after.manifest.status, "running", "run survives the orphan scan");
			assert.equal(after.tasks[0]!.status, "running", "the running task is not cancelled");
			const events = readEvents(after.manifest.eventsPath);
			assert.ok(
				events.some(
					(e) =>
						e.type === "crew.run.orphan_skip" &&
						(e.data as { reason?: string } | undefined)?.reason === "fresh_liveness_under_lock",
				),
				"the abort is recorded as an orphan_skip event with the fresh_liveness_under_lock reason",
			);
		} finally {
			await cleanupStateRoot(cwd);
		}
	});
});

// ─── M-4 (LOW): stale recovery plan must not requeue terminal tasks ───

test("M-4: applyRecoveryPlan does not requeue a task that completed during the plan's staleness window", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = mkProjectDir("pi-crew-r7-m4-");
		try {
			const created = createRunManifest({ cwd, team, workflow, goal: "stale recovery plan" });
			const finishedAt = new Date().toISOString();
			const tasks: TeamTaskState[] = [
				{
					...created.tasks[0]!,
					status: "completed",
					startedAt: finishedAt,
					finishedAt,
				},
				{
					...created.tasks[0]!,
					id: "task-2",
					status: "running",
					startedAt: finishedAt,
				},
			];
			saveRunTasks(created.manifest, tasks);

			// The (stale) plan still believes task-1 is interrupted.
			await applyRecoveryPlan(
				{ runId: created.manifest.runId, resumableTasks: [created.tasks[0]!.id, "task-2"], preservedTasks: [], lastEventSeq: 0 },
				{ cwd },
			);

			const after = loadRunManifestById(cwd, created.manifest.runId)!;
			const completedTask = after.tasks.find((t) => t.id === created.tasks[0]!.id)!;
			assert.equal(completedTask.status, "completed", "M-4: a task completed on the FRESH snapshot must NOT be requeued");
			assert.equal(completedTask.finishedAt, finishedAt, "its terminal result fields are untouched");
			const runningTask = after.tasks.find((t) => t.id === "task-2")!;
			assert.equal(runningTask.status, "queued", "the genuinely-interrupted task is still recovered");
			const events = readEvents(created.manifest.eventsPath);
			assert.ok(
				events.some((e) => e.type === "crew.run.resumed"),
				"recovery still recorded",
			);
		} finally {
			await cleanupStateRoot(cwd);
		}
	});
});
