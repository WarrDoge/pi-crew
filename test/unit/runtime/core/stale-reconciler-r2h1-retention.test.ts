import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { reconcileOrphanedTempWorkspaces } from "../../../../src/runtime/stale-reconciler.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";

/**
 * R2-H1 (deep-review wave-1): orphan-reconcile persistence caller pin.
 *
 * `reconcileOrphanedTempWorkspaces` persists the repaired task array after
 * `reconcileStaleRun` repairs a no-PID run with an individually-stale zombie
 * task. The pre-fix caller wrote `result.repairedTasks` — the FILTERED stale
 * subset (stale-reconciler.ts:581) — so one reconcile tick on a mixed run
 * (one pid-ALIVE running sibling + one zombie + one completed) destroyed the
 * two healthy records in tasks.json (mirror of crash-recovery.ts:1066). The
 * fix persists `result.persistTasks ?? result.repairedTasks` (NEW-1 full
 * array). This test drives the REAL caller one tick and pins: tasks.json
 * retains ALL 3 tasks, only the zombie gets cancelled.
 *
 * Discriminating fixture (probe 02_code-review-probes/p0-r2h1.mjs):
 *  - task_a: running, heartbeat 20min stale BUT heartbeat.pid = OUR pid
 *    (alive) → F1 pid-liveness gate excludes it from staleTaskIds.
 *  - task_b: running zombie — stale heartbeat, NO pid → individually stale.
 *  - task_c: completed (terminal, never repaired).
 * Manifest has NO async.pid → no-PID branch → individual-stale repair path.
 */

const STALE_MS = 20 * 60 * 1000; // 20min — beyond ACTIVE_EVIDENCE_TTL / NO_PID_HEARTBEAT_STALE (5min)

test("R2-H1 orphan reconcile tick retains all sibling tasks; only the zombie is cancelled", () => {
	const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-isotmp-"));
	const wsDir = fs.mkdtempSync(path.join(isolatedTmp, "pi-crew-test-"));
	const runId = `run_r2h1_${Date.now()}`;
	const runDir = path.join(wsDir, ".crew", "state", "runs", runId);
	fs.mkdirSync(runDir, { recursive: true });
	try {
		const now = Date.now();
		const iso = (t: number) => new Date(t).toISOString();

		const manifest: TeamRunManifest = {
			schemaVersion: 1,
			runId,
			cwd: wsDir,
			team: "test",
			goal: "r2h1 retention",
			status: "running",
			createdAt: iso(now - STALE_MS - 60_000),
			updatedAt: iso(now - STALE_MS - 60_000),
			stateRoot: path.join(wsDir, ".crew", "state"),
			artifactsRoot: path.join(wsDir, ".crew", "artifacts"),
			tasksPath: path.join(runDir, "tasks.json"),
			eventsPath: path.join(runDir, "events.jsonl"),
			workspaceMode: "single",
			artifacts: [],
		};
		// NO async.pid — required to reach the no-PID individual-stale branch
		// (the only branch whose persistTasks differs from repairedTasks).
		fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));

		const tasks: TeamTaskState[] = [
			{
				id: "task_a",
				runId,
				role: "executor",
				agent: "test-agent",
				title: "alive sibling",
				status: "running",
				dependsOn: [],
				cwd: wsDir,
				startedAt: iso(now - STALE_MS),
				// Stale heartbeat BUT pid alive (ours) → F1 gate → NOT stale.
				heartbeat: {
					taskId: "task_a",
					pid: process.pid,
					lastSeenAt: iso(now - STALE_MS),
					alive: true,
				},
			} as unknown as TeamTaskState,
			{
				id: "task_b",
				runId,
				role: "executor",
				agent: "test-agent",
				title: "zombie",
				status: "running",
				dependsOn: [],
				cwd: wsDir,
				startedAt: iso(now - STALE_MS),
				// Stale heartbeat, no pid → zombie (individually stale).
				heartbeat: {
					taskId: "task_b",
					lastSeenAt: iso(now - STALE_MS),
				},
			} as unknown as TeamTaskState,
			{
				id: "task_c",
				runId,
				role: "executor",
				agent: "test-agent",
				title: "done sibling",
				status: "completed",
				dependsOn: [],
				cwd: wsDir,
				startedAt: iso(now - STALE_MS),
				finishedAt: iso(now - STALE_MS),
			} as unknown as TeamTaskState,
		];
		fs.writeFileSync(path.join(runDir, "tasks.json"), JSON.stringify(tasks, null, 2));

		const result = reconcileOrphanedTempWorkspaces(now, {
			tmpDir: isolatedTmp,
			cleanupOrphanedTempDirs: false,
		});
		assert.ok(result.repaired >= 1, `expected the run to be repaired, got repaired=${result.repaired}`);

		// R2-H1 pin: the caller must persist the FULL array (persistTasks), not
		// the filtered repairedTasks subset — pre-fix, tasks.json held ONLY
		// task_b and the pid-ALIVE task_a + completed task_c records VANISHED.
		// (R2-M-A1, separate finding NOT in wave-1 scope: the individual-stale
		// repair still cancels the pid-ALIVE task_a too — repairStaleRun maps
		// every non-terminal task; round-2 validation N4 pinned this survives
		// the R2-H1 fix. We pin record RETENTION here, not survival semantics.)
		const after = JSON.parse(fs.readFileSync(path.join(runDir, "tasks.json"), "utf-8")) as TeamTaskState[];
		const byId = new Map(after.map((t) => [t.id, t]));
		assert.equal(after.length, 3, `tasks.json must retain ALL 3 tasks (got ${after.length}: ${after.map((t) => t.id).join(",")})`);
		assert.ok(byId.has("task_a"), "pid-ALIVE sibling record must survive the write (R2-H1 data-loss fix)");
		assert.equal(byId.get("task_b")?.status, "cancelled", "zombie must be cancelled");
		assert.ok(byId.get("task_b")?.finishedAt, "cancelled zombie gets finishedAt");
		assert.equal(byId.get("task_c")?.status, "completed", "completed sibling must stay completed");
	} finally {
		fs.rmSync(isolatedTmp, { recursive: true, force: true });
	}
});
