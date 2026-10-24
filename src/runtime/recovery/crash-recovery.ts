import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PATHS } from "../../config/defaults.ts";
import { appendHookEvent, executeHook } from "../../hooks/registry.ts";
import type { MetricRegistry } from "../../observability/metric-registry.ts";
import { discoverRunLockFiles, sweepStaleLocks, withRunLock, withRunLockSync } from "../../state/coordination/locks.ts";
import type { AppendTeamEvent } from "../../state/event-log/event-log.ts";
import { appendEvent, appendEventAsync, scanSequence } from "../../state/event-log/event-log.ts";
import { readActiveRunRegistry, unregisterActiveRun } from "../../state/stores/active-run-registry.ts";
import {
	loadRunManifestById,
	loadRunManifestByIdAsync,
	saveRunManifest,
	saveRunTasks,
	updateRunStatus,
} from "../../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { projectCrewRoot, userCrewRoot } from "../../utils/paths.ts";
import { resolveRealContainedPath } from "../../utils/safe-paths.ts";
import { sleepSync } from "../../utils/sleep.ts";
import { recordFromTask, upsertCrewAgent } from "../crew-agent-records.ts";
import { isWorkerHeartbeatStale } from "../heartbeat/worker-heartbeat.ts";
import { terminateLiveAgentsForRun } from "../live-session/live-agent-manager.ts";
import type { ManifestCache } from "../manifest-cache.ts";
import { buildProcSnapshot, type ProcSnapshot } from "../process/run-descendant-sweep.ts";
import { checkProcessLiveness } from "../process-status.ts";
import { mapConcurrent } from "../scheduling/parallel-utils.ts";
import {
	drainReapEscalations,
	hasLiveRunClaim,
	isIntentionalWait,
	isPlanApprovalPendingEffective,
	type ReconcileResult,
	reconcileStaleRun,
	sweepTerminalRunDescendants,
} from "../stale-reconciler.ts";

export interface RecoveryPlan {
	runId: string;
	resumableTasks: string[];
	preservedTasks: string[];
	lastEventSeq: number;
}

function isTerminalTask(task: TeamTaskState): boolean {
	return (
		task.status === "completed" ||
		task.status === "failed" ||
		task.status === "cancelled" ||
		task.status === "skipped" ||
		task.status === "needs_attention"
	);
}

/**
 * Errno codes that represent transient filesystem conditions (e.g. Windows AV
 * scan temporarily locking the file, or a brief permission window). On these
 * errors the manifest is NOT corrupt — retrying the read after a short backoff
 * will succeed.
 */
const TRANSIENT_READ_ERRNO_CODES = new Set(["EBUSY", "EACCES", "EAGAIN", "EPERM", "ENFILE", "EMFILE"]);

/**
 * Raw file-read function used by readManifestWithTransientRetry. Separated as
 * a module-level binding so tests can inject transient-error mocks without
 * needing to mutate the frozen ESM `fs` namespace.
 */
let _readManifestFileSync: (filePath: string) => string = (p) => fs.readFileSync(p, "utf-8");

/**
 * @internal — test seam for readManifestWithTransientRetry. Pass `null` to reset.
 */
export function _setReadManifestFileSyncForTest(fn: ((filePath: string) => string) | null): void {
	_readManifestFileSync = fn ?? ((p) => fs.readFileSync(p, "utf-8"));
}

/**
 * Read and JSON-parse a manifest file, retrying transient read errors
 * (EBUSY/EACCES/EAGAIN — common on Windows when AV software briefly locks the
 * file) with exponential backoff.
 *
 * ST-6: Previously, a single `catch` quarantined the manifest on ALL errors,
 * including transient I/O failures that left a perfectly healthy manifest
 * unparseable for a few milliseconds. This renamed the valid file to
 * `.corrupt-*`, making the run permanently unloadable.
 *
 * Behavior:
 * - Success → returns parsed object
 * - SyntaxError (genuinely corrupt JSON) → rethrown immediately (caller quarantines)
 * - Transient ErrnoException → retried up to `maxRetries` times; if still
 *   failing, rethrown so the caller can skip WITHOUT quarantining
 * - Other ErrnoException (ENOENT, etc.) → rethrown immediately
 */
export function readManifestWithTransientRetry(manifestPath: string, maxRetries = 3, baseDelayMs = 100): Record<string, unknown> {
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return JSON.parse(_readManifestFileSync(manifestPath)) as Record<string, unknown>;
		} catch (err) {
			// SyntaxError = genuinely corrupt JSON → rethrow immediately
			if (err instanceof SyntaxError) throw err;
			const code = (err as NodeJS.ErrnoException).code;
			// Transient read error → retry with exponential backoff
			if (code !== undefined && TRANSIENT_READ_ERRNO_CODES.has(code)) {
				if (attempt < maxRetries) {
					sleepSync(baseDelayMs * 2 ** attempt);
					continue;
				}
			}
			// Non-transient error, or retries exhausted → rethrow
			throw err;
		}
	}
	// Unreachable: the loop either returns or throws on every iteration.
	throw new Error(`unreachable: readManifestWithTransientRetry exhausted for ${manifestPath}`);
}

export function shouldRecoverTask(task: TeamTaskState, deadMs: number): boolean {
	if (task.status !== "running") return false;
	if (!task.heartbeat) return true;
	return task.heartbeat.alive === false || isWorkerHeartbeatStale(task.heartbeat, deadMs);
}

export function detectInterruptedRuns(
	cwd: string,
	manifestCache: ManifestCache,
	deadMs = 300_000,
	currentSessionId?: string,
): RecoveryPlan[] {
	const plans: RecoveryPlan[] = [];
	for (const manifest of manifestCache.list(50)) {
		if (manifest.status !== "running" && manifest.status !== "blocked") continue;
		// Preserve runs intentionally blocked on plan approval — not crashes.
		// B1 battery 2026-08-18 (case b): generalized to isIntentionalWait — a run
		// parked on an ask answer is equally intentional and must not be auto-resumed
		// out from under its parked worker.
		if (isIntentionalWait(manifest)) continue;
		if (manifest.async?.pid !== undefined && checkProcessLiveness(manifest.async.pid).alive) continue;
		// Skip runs owned by the current live session — a live session B must NOT
		// detect session A's still-running run as interrupted.
		if (currentSessionId && manifest.ownerSessionId && manifest.ownerSessionId === currentSessionId) continue;
		// NOTE: no withRunLock — best-effort only; concurrent writes may cause inconsistency
		const loaded = loadRunManifestById(cwd, manifest.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
		if (!loaded) continue;
		// U9 (upgrade-spec 2026-10-09 — reconcile-at-open fast-path DETECTION): a
		// dead detached runner PID + no live active-run-registry claim is
		// AUTHORITATIVE crash evidence. The deadMs heartbeat-staleness wait in
		// shouldRecoverTask exists to protect runs whose liveness we cannot probe
		// (foreground/no-PID runs); for a dead async runner it only delays an
		// interrupted run from becoming actionable by the full deadMs (300s).
		// Skip the wait here so a crashed run is resumable the moment it is opened.
		const fastPathEligible = loaded.manifest.async?.pid !== undefined && !hasLiveRunClaim(loaded.manifest.runId, loaded.manifest);
		const resumableTasks = loaded.tasks
			.filter((task) => (fastPathEligible ? task.status === "running" : shouldRecoverTask(task, deadMs)))
			.map((task) => task.id);
		if (!resumableTasks.length) continue;
		plans.push({
			runId: manifest.runId,
			resumableTasks,
			preservedTasks: loaded.tasks.filter(isTerminalTask).map((task) => task.id),
			lastEventSeq: scanSequence(loaded.manifest.eventsPath),
		});
	}
	return plans;
}

export async function applyRecoveryPlan(plan: RecoveryPlan, ctx: Pick<ExtensionContext, "cwd">, registry?: MetricRegistry): Promise<void> {
	const loaded = loadRunManifestById(ctx.cwd, plan.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) throw new Error(`Run '${plan.runId}' not found.`);

	const hookReport = await executeHook("run_recovery", {
		runId: plan.runId,
		cwd: ctx.cwd,
	});

	// R14-4: the hook await above is an arbitrary async gap — a concurrent writer
	// may have completed/cancelled the run in the meantime. Re-read inside the
	// lock and derive every write from the FRESH snapshot; never reset a run that
	// reached a terminal status.
	// U2 (2026-10-10): recovery lifecycle events are captured under the sync run
	// lock (payload derived from the fresh snapshot, as R14-4 requires) but
	// appended via the awaited async primitive AFTER the lock — the sync lock
	// callback cannot await, and awaiting outside keeps the read-your-writes
	// contract (recovery-hooks tests read events.jsonl synchronously right after
	// applyRecoveryPlan resolves) while dropping the sleepSync event-loop block.
	let lifecycle: { eventsPath: string; event: AppendTeamEvent } | undefined;
	withRunLockSync(loaded.manifest, () => {
		const fresh = loadRunManifestById(ctx.cwd, plan.runId); // NOTE: inside withRunLockSync - consistent read
		if (!fresh) throw new Error(`Run '${plan.runId}' not found.`);
		if (fresh.manifest.status === "completed" || fresh.manifest.status === "failed" || fresh.manifest.status === "cancelled") {
			// Run reached a terminal status while the recovery hook was running —
			// do NOT reset it (no task reset, no status change).
			lifecycle = {
				eventsPath: fresh.manifest.eventsPath,
				event: {
					type: "crew.run.recovery_skipped",
					runId: plan.runId,
					message: `Recovery skipped: run is already '${fresh.manifest.status}'`,
					data: { status: fresh.manifest.status },
				},
			};
			return;
		}
		appendHookEvent(fresh.manifest, hookReport);
		if (hookReport.outcome === "block") {
			lifecycle = {
				eventsPath: fresh.manifest.eventsPath,
				event: {
					type: "crew.run.recovery_blocked",
					runId: plan.runId,
					message: `Recovery blocked by hook: ${hookReport.reason ?? "run_recovery hook blocked the operation."}`,
					data: { hookOutcome: "block", reason: hookReport.reason },
				},
			};
			return;
		}

		// M-4 (2026-10-16): the plan was computed from a pre-hook (stale) snapshot.
		// Filter the reset set to tasks whose FRESH status is still non-terminal — a
		// task that completed/failed/... during the run_recovery hook gap must keep
		// its terminal status and result (mirror of the requeue-eligibility filter
		// in applyReconcileAtOpenFastPath). Terminal tasks pass through untouched
		// below, so a stale plan can never requeue finished work.
		const reset = new Set(
			plan.resumableTasks.filter((id) => {
				const task = fresh.tasks.find((t) => t.id === id);
				return task !== undefined && !isTerminalTask(task);
			}),
		);
		const tasks = fresh.tasks.map((task) =>
			reset.has(task.id)
				? {
						...task,
						status: "queued" as const,
						startedAt: undefined,
						finishedAt: undefined,
						error: undefined,
						heartbeat: undefined,
						// WP-2/R2 (ADR-0 item 9): a requeued task must not resume parked
						// state — drop any stale ask-park marker along with the other
						// per-attempt transient fields. Tasks NOT reset (e.g. a task parked
						// in `waiting`) pass through untouched, marker intact; the marker's
						// deadline is then owned by the scheduler tick (dispatch-batch).
						waiting: undefined,
					}
				: task,
		);
		saveRunTasks(fresh.manifest, tasks);
		lifecycle = {
			eventsPath: fresh.manifest.eventsPath,
			event: {
				type: "crew.run.resumed",
				runId: plan.runId,
				message: `Recovered ${reset.size} interrupted task(s).`,
				data: {
					recoveredFromSeq: plan.lastEventSeq,
					// M-4: report what was ACTUALLY reset from the fresh snapshot
					// (terminal tasks filtered out), not what the stale plan asked for.
					resumableTasks: [...reset],
				},
			},
		};
		registry?.counter("crew.run.count", "Total runs by status").inc({ status: "resumed" });
	});
	if (lifecycle) await appendEventAsync(lifecycle.eventsPath, lifecycle.event);
}

export function declineRecoveryPlan(plan: RecoveryPlan, ctx: Pick<ExtensionContext, "cwd">): void {
	const loaded = loadRunManifestById(ctx.cwd, plan.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) throw new Error(`Run '${plan.runId}' not found.`);
	// R14-4: re-read inside the lock so the decline decision applies to the
	// on-disk state, not the best-effort snapshot read above. Kept SYNC —
	// withRunLockSync is the sync lock variant.
	withRunLockSync(loaded.manifest, () => {
		const fresh = loadRunManifestById(ctx.cwd, plan.runId); // NOTE: inside withRunLockSync - consistent read
		if (!fresh) return;
		// Log the event first — if appendEvent fails, state remains consistent.
		// U2 (2026-10-10): kept SYNC — this event must land on disk BEFORE the
		// run.cancelled written by the updateRunStatus call below it (audit order:
		// decline reason precedes the terminal status); declineRecoveryPlan is a
		// sync API with no await boundary to flush an async append.
		appendEvent(fresh.manifest.eventsPath, {
			type: "crew.run.recovery_declined",
			runId: plan.runId,
			message: "Interrupted run was not resumed.",
			data: { recoveredFromSeq: plan.lastEventSeq },
		});
		updateRunStatus(fresh.manifest, "cancelled", "interrupted-not-resumed");
	});
}

/**
 * Run 3-phase stale reconciliation on all active runs.
 * Returns results for each reconciled run.
 */
/**
 * Auto-cancel orphaned runs whose owner session no longer exists.
 *
 * When a Pi session dies (crash, force-close, Ctrl+C), `session_shutdown`
 * does not fire and child workers are not terminated. The next Pi session
 * must detect these orphaned runs and cancel them.
 *
 * Criteria for orphan detection:
 * 1. Manifest status is "running"
 * 2. Manifest has an `ownerSessionId` that is NOT the current session
 * 3. The owner session's process is no longer alive (PID check)
 * 4. No recent heartbeat activity (task heartbeat or agent progress within threshold)
 *
 * Returns the number of runs cancelled.
 */
export function cancelOrphanedRuns(
	cwd: string,
	manifestCache: ManifestCache,
	currentSessionId: string,
	staleThresholdMs = 300_000,
	now = Date.now(),
): { cancelled: string[]; skipped: string[] } {
	const cancelled: string[] = [];
	const skipped: string[] = [];

	// Phase 1: Scan project-level manifests via manifestCache
	for (const manifest of manifestCache.list(50)) {
		if (manifest.status !== "running" && manifest.status !== "blocked") continue;
		// B1 battery 2026-08-18 (case b): preserve runs intentionally blocked on a
		// HUMAN DECISION — plan approval (pre-v2 semantics) OR a pending ask answer
		// within the waiting TTL (ADR-0 item 9: "not crashes and must not be
		// stale-repaired or cancelled by reconciliation"). Live proof: a resumed
		// run parked on ask (worker alive, waitState set, parked workers do NOT
		// heartbeat) was orphan-cancelled 5m18s into a 10-minute park by a THIRD
		// session's startup scan because the predicate only knew plan approval.
		if (isIntentionalWait(manifest)) {
			skipped.push(manifest.runId);
			continue;
		}

		// Only consider runs owned by a different session
		const ownerId = manifest.ownerSessionId;
		if (!ownerId || ownerId === currentSessionId) continue;

		// Check if the owner process is still alive
		const ownerPid = manifest.async?.pid;
		if (ownerPid !== undefined && checkProcessLiveness(ownerPid).alive) {
			skipped.push(manifest.runId);
			continue;
		}

		// Foreground (in-process) runs have NO async worker PID, so the liveness
		// check above cannot apply. They execute inside THIS pi process — a
		// recently-updated manifest conclusively proves the run is alive; only a
		// run that has gone quiet for the stale threshold can be an orphan (a
		// crashed process stops updating). Without this, a YOUNG foreground run
		// (first worker heartbeat not yet written) was orphan-cancelled by the
		// session that opened its agent view seconds after the run started —
		// killing the very run the user was looking at.
		if (!manifest.async) {
			const updatedMs = manifest.updatedAt ? new Date(manifest.updatedAt).getTime() : Number.NaN;
			if (Number.isFinite(updatedMs) && now - updatedMs <= staleThresholdMs) {
				skipped.push(manifest.runId);
				continue;
			}
		}

		// Check for recent heartbeat activity
		const loaded = loadRunManifestById(cwd, manifest.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
		if (!loaded) continue;

		// R7-1 (2026-10-16): the inline predicate moved to the shared
		// `hasRecentTaskActivity` helper so purgeStaleActiveRunIndex step 6 can
		// honor the same task-level life evidence this path has always honored.
		if (hasRecentTaskActivity(loaded.tasks, now, staleThresholdMs)) {
			skipped.push(manifest.runId);
			continue;
		}

		// Orphan confirmed — mark durable state terminal before best-effort live-agent abort.
		// terminateLiveAgent unregisters handles before awaiting abort(), and live-executor's
		// isCurrent() checks durable terminal state before writing progress.

		// Orphan confirmed — cancel all running tasks
		let cancelledRun = false;
		withRunLockSync(loaded.manifest, () => {
			const fresh = loadRunManifestById(cwd, manifest.runId); // NOTE: inside withRunLockSync - consistent read
			if (!fresh) return;
			if (fresh.manifest.status !== "running" && fresh.manifest.status !== "blocked") {
				// Status changed between initial check (line 109) and acquiring the lock — normal concurrent update, not an orphan
				// U2 (2026-10-10): kept SYNC — cancelOrphanedRuns is a sync API (returns
				// {cancelled,skipped} synchronously to session-start callers); no await
				// boundary exists to flush an async append before those callers read events.
				appendEvent(loaded.manifest.eventsPath, {
					type: "crew.run.orphan_skip",
					runId: manifest.runId,
					message: `Skipped orphan cancellation: status is '${fresh.manifest.status}' (was 'running'/'blocked' at initial scan)`,
					data: { currentStatus: fresh.manifest.status },
				});
				return;
			}

			// R7-6 (2026-10-16): status is still "running", but that alone is not
			// revalidation — re-derive EVERY liveness input the cancel decision was
			// built on from this FRESH snapshot (manifest.updatedAt / heartbeat.json
			// mtime / async pid / task heartbeats). A `team resume` that adopted the
			// run between the pre-lock scan and this lock rewrote exactly those inputs;
			// cancelling here would false-cancel a run that is alive again (and then
			// terminate its live agents).
			if (hasFreshLivenessEvidence(fresh, now, staleThresholdMs)) {
				// U2 (2026-10-10): SYNC append — cancelOrphanedRuns is a sync API with no
				// await boundary to flush an async append.
				appendEvent(loaded.manifest.eventsPath, {
					type: "crew.run.orphan_skip",
					runId: manifest.runId,
					message:
						"Skipped orphan cancellation: fresh liveness evidence observed under the run lock (run re-adopted or still active)",
					data: { reason: "fresh_liveness_under_lock" },
				});
				skipped.push(manifest.runId);
				return;
			}

			const now_iso = new Date(now).toISOString();
			const repairedTasks = fresh.tasks.map((task) => {
				if (task.status === "running" || task.status === "queued" || task.status === "waiting") {
					return {
						...task,
						status: "cancelled" as const,
						finishedAt: now_iso,
						error: `Orphaned run: owner session ${ownerId} no longer exists`,
					};
				}
				return task;
			});

			saveRunTasks(fresh.manifest, repairedTasks);
			// B1 battery 2026-08-18 (case b leak fix): a cancelled run must not keep
			// its waitState pointer — observed live: orphan-cancel left waitState set,
			// shielding the dead run from staleness repair for the full 24h TTL.
			if (fresh.manifest.waitState) {
				const cleared = { ...fresh.manifest, waitState: undefined, updatedAt: new Date(now).toISOString() };
				saveRunManifest(cleared);
				fresh.manifest = cleared;
			}
			for (const task of repairedTasks) {
				try {
					upsertCrewAgent(fresh.manifest, recordFromTask(fresh.manifest, task, "scaffold"));
				} catch {
					/* non-critical */
				}
			}
			updateRunStatus(fresh.manifest, "cancelled", `Orphaned run: owner session ${ownerId} no longer exists`);
			// U2 (2026-10-10): kept SYNC — must land AFTER run.cancelled (updateRunStatus
			// above, still sync) for audit order, and cancelOrphanedRuns is a sync API
			// with no await boundary to flush an async append.
			appendEvent(fresh.manifest.eventsPath, {
				type: "crew.run.orphan_cancelled",
				runId: manifest.runId,
				message: `Auto-cancelled orphaned run (owner: ${ownerId})`,
				data: {
					ownerSessionId: ownerId,
					cancelledTasks: repairedTasks.filter((t) => t.status === "cancelled").length,
				},
			});
			cancelled.push(manifest.runId);
			cancelledRun = true;
		});
		if (cancelledRun)
			void terminateLiveAgentsForRun(manifest.runId, "cancelled", appendEvent, loaded.manifest.eventsPath).catch((error) =>
				logInternalError("crash-recovery.orphan.terminate", error, `runId=${manifest.runId}`, "warn"),
			);
	}

	return { cancelled, skipped };
}

/**
 * Purge the global active-run-index of entries whose manifest is no longer active.
 *
 * This scans every entry in active-run-index.json and removes any whose:
 * - manifest file no longer exists, OR
 * - manifest status is terminal (completed/failed/cancelled/blocked), OR
 * - manifest cwd directory no longer exists (e.g. temp test dirs)
 *
 * Also removes entries where the manifest is still "running" but:
 * - The cwd has been deleted (temp dir cleanup)
 * - The async worker PID is dead AND no heartbeat for > threshold
 *
 * This is the **global** cleanup that cancelOrphanedRuns (project-scoped)
 * cannot reach.
 */
/**
 * Best-effort removal of stateRoot and artifactsRoot directories for a purged run.
 * Uses resolveRealContainedPath to ensure we only delete paths that are safely
 * contained within a known crew root (project or user level).
 */
function tryRemoveRunDirectories(entry: { stateRoot: string; cwd: string }): void {
	const roots = [projectCrewRoot(entry.cwd), userCrewRoot()];
	for (const root of roots) {
		try {
			resolveRealContainedPath(root, entry.stateRoot);
			// If we get here, stateRoot is safely contained — remove it
			fs.rmSync(entry.stateRoot, { recursive: true, force: true });
			break;
		} catch {
			// Not contained in this root, try next
		}
	}
	// NOTE: artifactsRoot is shared across runs and cleaned up by pruneFinishedRuns/pruneUserLevelRuns — not deleted here.
}

/**
 * Age (ms) of the team-level heartbeat file for a run. The team-runner writes
 * `<stateRoot>/heartbeat.json` periodically while a workflow is executing
 * (startTeamHeartbeat), so a fresh heartbeat is strong evidence the run is alive
 * even when its recorded PID check is inconclusive or its active-run-index
 * entry's `updatedAt` was frozen at registration. Returns Infinity when absent.
 */
function heartbeatAgeMs(entry: { stateRoot: string }, now: number): number {
	try {
		const mtime = fs.statSync(path.join(entry.stateRoot, "heartbeat.json")).mtimeMs;
		return Number.isFinite(mtime) ? now - mtime : Infinity;
	} catch {
		return Infinity;
	}
}

/**
 * True if there is recent evidence the run is (or was very recently) alive, so
 * it must NOT be purged. Any one of these signals is sufficient:
 *   - on-disk `manifest.updatedAt` fresher than `staleThresholdMs` (rewritten on
 *     every task transition / status change), and/or
 *   - team-level `heartbeat.json` fresher than `staleThresholdMs`.
 * `entry.updatedAt` is intentionally NOT consulted: it is frozen at
 * registration and never refreshed during execution, which previously caused
 * long-running legitimate runs to be falsely purged — destroying their
 * stateRoot, and because saveRunTasks() silently no-ops once the state dir is
 * gone, hanging the workflow permanently at the current task with no
 * recoverable state ("Run not found").
 */
function hasRecentLifeEvidence(
	entry: { stateRoot: string },
	manifestUpdatedAt: string | undefined,
	now: number,
	staleThresholdMs: number,
): boolean {
	const manifestMs = manifestUpdatedAt ? new Date(manifestUpdatedAt).getTime() : NaN;
	if (Number.isFinite(manifestMs) && now - manifestMs <= staleThresholdMs) return true;
	const hbAge = heartbeatAgeMs(entry, now);
	if (Number.isFinite(hbAge) && hbAge <= staleThresholdMs) return true;
	return false;
}

/**
 * R7-1 (2026-10-16): TASK-level life evidence — true when any running/waiting
 * task has a live heartbeat or agent progress within `staleThresholdMs`.
 * A DWF-foreground run (run.ts → runDynamicWorkflow) writes NO team-level
 * heartbeat.json and never touches manifest.updatedAt while a long subagent
 * step executes, so a fresh task heartbeat can be the ONLY signal proving the
 * run is alive. Extracted from cancelOrphanedRuns so the purge path
 * (purgeStaleActiveRunIndex step 6) honors exactly the same evidence.
 */
function hasRecentTaskActivity(tasks: TeamTaskState[], now: number, staleThresholdMs: number): boolean {
	return tasks.some((task) => {
		if (task.status !== "running" && task.status !== "waiting") return false;
		const heartbeatAt = task.heartbeat?.lastSeenAt ? new Date(task.heartbeat.lastSeenAt).getTime() : Number.NaN;
		if (task.heartbeat?.alive !== false && Number.isFinite(heartbeatAt) && now - heartbeatAt <= staleThresholdMs) return true;
		const activityAt = task.agentProgress?.lastActivityAt ? new Date(task.agentProgress.lastActivityAt).getTime() : Number.NaN;
		return Number.isFinite(activityAt) && now - activityAt <= staleThresholdMs;
	});
}

/**
 * R7-6 (2026-10-16): under-lock liveness revalidation. Proving
 * `status === "running"` on the in-lock re-read is NOT enough: a concurrent
 * `team resume` that adopted the run between the pre-lock scan and lock
 * acquisition rewrote the very liveness inputs the cancel decision was built
 * on. Re-derive them from the FRESH snapshot — any ONE of these is sufficient
 * evidence the run came back to life and the cancel must abort:
 *   - fresh on-disk `manifest.updatedAt` and/or team `heartbeat.json` mtime
 *     (the same corroboration `hasRecentLifeEvidence` applies pre-lock),
 *   - a fresh/repopulated async worker PID that is ALIVE (re-dispatch),
 *   - fresh task heartbeats / agent progress (DWF-foreground evidence).
 */
function hasFreshLivenessEvidence(
	fresh: { manifest: TeamRunManifest; tasks: TeamTaskState[] },
	now: number,
	staleThresholdMs: number,
): boolean {
	if (hasRecentLifeEvidence(fresh.manifest, fresh.manifest.updatedAt, now, staleThresholdMs)) return true;
	const pid = fresh.manifest.async?.pid;
	if (pid !== undefined && checkProcessLiveness(pid).alive) return true;
	return hasRecentTaskActivity(fresh.tasks, now, staleThresholdMs);
}

/**
 * Purge the global active-run-index of entries whose manifest is no longer active.
 *
 * Note: This function only cleans user-level active run entries.
 * Project-level stale runs are handled by session_start auto-prune triggered during run creation.
 */
export function purgeStaleActiveRunIndex(
	staleThresholdMs = 300_000,
	now = Date.now(),
	currentSessionId?: string,
): { purged: string[]; kept: string[] } {
	const purged: string[] = [];
	const kept: string[] = [];
	const entries = readActiveRunRegistry();

	for (const entry of entries) {
		// 1. Manifest file gone → stale, but PRESERVE stateRoot for manual recovery.
		//    R-01: A single missing-manifest signal is insufficient to warrant
		//    deleting all run state (events.jsonl, task data, artifacts). Require
		//    corroboration — only remove stateRoot if it is ALREADY gone.
		if (!fs.existsSync(entry.manifestPath)) {
			if (!fs.existsSync(entry.stateRoot)) {
				tryRemoveRunDirectories(entry);
			}
			unregisterActiveRun(entry.runId);
			purged.push(entry.runId);
			continue;
		}

		// 2. CWD gone → temp dir cleaned up, but PRESERVE stateRoot for recovery.
		//    R-01: Same dual-signal guard as step 1 — a single missing-CWD signal
		//    must not delete all run state. Only clean up if stateRoot is already gone.
		if (!fs.existsSync(entry.cwd)) {
			if (!fs.existsSync(entry.stateRoot)) {
				tryRemoveRunDirectories(entry);
			}
			unregisterActiveRun(entry.runId);
			purged.push(entry.runId);
			continue;
		}

		// 3. Read manifest status
		let manifest:
			| {
					status?: string;
					updatedAt?: string;
					async?: { pid?: number };
					ownerSessionId?: string;
			  }
			| undefined;
		try {
			manifest = readManifestWithTransientRetry(entry.manifestPath) as typeof manifest;
		} catch (err) {
			// ST-6: Transient read errors (EBUSY/EACCES/EAGAIN from Windows AV
			// scans) must NOT quarantine a healthy manifest — the file is fine,
			// just temporarily locked. Skip this entry and try again next cycle.
			const code = (err as NodeJS.ErrnoException).code;
			const isTransient = code !== undefined && TRANSIENT_READ_ERRNO_CODES.has(code);
			if (isTransient) continue;

			// R-01: Quarantine the corrupt manifest instead of deleting all run
			// state. A single corrupted byte must NOT cause total data loss —
			// events.jsonl, task data, and artifacts are preserved for manual
			// recovery. SyntaxError (genuinely corrupt JSON) and unexpected
			// non-transient errors fall through to here.
			try {
				// Include pid for uniqueness across concurrent quarantines in the same ms.
				fs.renameSync(entry.manifestPath, entry.manifestPath + ".corrupt-" + Date.now() + "-" + process.pid);
			} catch {
				// Rename may fail if the path doesn't exist or permissions deny it — best effort.
			}
			unregisterActiveRun(entry.runId);
			purged.push(entry.runId);
			continue;
		}

		// 4. Terminal status → no longer active (just unregister, don't delete files)
		const terminalStatuses = new Set(["completed", "failed", "cancelled", "blocked"]);
		if (manifest && terminalStatuses.has(manifest.status ?? "")) {
			unregisterActiveRun(entry.runId);
			purged.push(entry.runId);
			continue;
		}

		// 4b. Skip runs owned by the current live session — a live session B must
		// NOT purge session A's still-running run from the active-run-index.
		if (currentSessionId && manifest?.ownerSessionId && manifest.ownerSessionId === currentSessionId) {
			kept.push(entry.runId);
			continue;
		}

		// 5. Still "running" with an async worker PID — only purge when the worker
		// is actually dead AND there is no recent evidence of life. We must NOT
		// rely solely on `entry.updatedAt` (frozen at registration) nor on a single
		// dead-PID reading: a long-running worker (e.g. a 15-minute explorer)
		// legitimately keeps the run "running" while periodically rewriting the
		// on-disk manifest.updatedAt and heartbeat.json. Falsely purging such a run
		// destroys its stateRoot, and because saveRunTasks() silently no-ops once
		// the state dir is gone, the workflow then hangs permanently at the
		// current task with no recoverable state ("Run not found"). When we do mark
		// a run cancelled here, we KEEP its stateRoot so the run stays queryable/
		// resumable and its diagnostics survive; the finished-run pruner removes
		// the directory later on its normal schedule.
		if (manifest?.status === "running" && manifest.async?.pid !== undefined) {
			const pidAlive = checkProcessLiveness(manifest.async.pid).alive;
			if (!pidAlive && !hasRecentLifeEvidence(entry, manifest.updatedAt, now, staleThresholdMs)) {
				// Dead PID + no recent life evidence → cancel the manifest and unregister.
				// RT-F5: wrap load+modify+save in withRunLockSync so concurrent writers
				// (e.g. team-runner final saveRunTasks) cannot interleave between the
				// repaired-tasks write and the manifest-status flip. terminateLiveAgentsForRun
				// is fire-and-forget so it stays OUTSIDE the lock to avoid blocking the
				// critical section on async IPC.
				let abortedFreshLiveness = false;
				let abortedIntentionalWait = false; // R2-M-A3: keep intentional-wait runs
				try {
					const fullLoaded = loadRunManifestById(entry.cwd, entry.runId);
					if (fullLoaded) {
						withRunLockSync(fullLoaded.manifest, () => {
							// Re-read under lock so the stale-best-effort load above
							// can't cause us to clobber a fresh status flip.
							const fresh = loadRunManifestById(entry.cwd, entry.runId);
							if (!fresh) return;
							if (fresh.manifest.status !== "running") return;
							// R2-M-A3 (2026-10-17): mirror :135/:329/:937 — purgeStaleActiveRunIndex
							// was the only recovery path without an isIntentionalWait guard: a run
							// parked on a plan approval / pending ask was purge-CANCELLED here even
							// though every sibling recovery path preserves it. KEEP the entry.
							if (isIntentionalWait(fresh.manifest, now)) {
								abortedIntentionalWait = true;
								return;
							}
							// R7-6 (2026-10-16): under-lock liveness revalidation — the pre-lock
							// gate used inputs read BEFORE the lock; a concurrent `team resume`
							// adoption may have rewritten them in that window (fresh
							// manifest.updatedAt / re-populated live pid / fresh task heartbeats).
							// Fresh evidence → abort WITHOUT cancelling and KEEP the registry
							// entry (it is the live-claim signal G12 relies on).
							if (hasFreshLivenessEvidence(fresh, now, staleThresholdMs)) {
								abortedFreshLiveness = true;
								appendEvent(fresh.manifest.eventsPath, {
									type: "crew.run.orphan_skip",
									runId: entry.runId,
									message:
										"Skipped purge cancellation: fresh liveness evidence observed under the run lock (run re-adopted or still active)",
									data: { reason: "fresh_liveness_under_lock" },
								});
								return;
							}
							const now_iso = new Date(now).toISOString();
							const repairedTasks = fresh.tasks.map((task) => {
								if (task.status === "running" || task.status === "queued" || task.status === "waiting") {
									return {
										...task,
										status: "cancelled" as const,
										finishedAt: now_iso,
										error: "Orphaned run: worker process dead and no recent activity",
									};
								}
								return task;
							});
							saveRunTasks(fresh.manifest, repairedTasks);
							for (const task of repairedTasks) {
								try {
									upsertCrewAgent(fresh.manifest, recordFromTask(fresh.manifest, task, "scaffold"));
								} catch {
									/* non-critical */
								}
							}
							updateRunStatus(fresh.manifest, "cancelled", "Orphaned run: worker process dead and no recent activity");
							// R2-M-A3: clear waitState on cancel (mirror cancelOrphanedRuns :431-438) —
							// an orphan-cancelled run must not keep the park pointer shielding it
							// from staleness repair for the full waiting TTL.
							if (fresh.manifest.waitState) {
								const cleared = { ...fresh.manifest, waitState: undefined, updatedAt: new Date(now).toISOString() };
								saveRunManifest(cleared);
								fresh.manifest = cleared;
							}
						});
						// R7-6: only terminate live agents when the cancel actually landed —
						// an aborted (fresh-evidence) run is alive; terminating it would kill
						// the run we just decided to keep.
						if (!abortedFreshLiveness) {
							void terminateLiveAgentsForRun(
								fullLoaded.manifest.runId,
								"cancelled",
								appendEvent,
								fullLoaded.manifest.eventsPath,
							).catch((error) =>
								logInternalError("crash-recovery.pid-dead.terminate", error, `runId=${fullLoaded.manifest.runId}`, "warn"),
							);
						}
					}
				} catch {
					// Best-effort manifest cleanup
				}
				// R7-6: a fresh-evidence abort means the run is alive again — KEEP the
				// registry entry (live-claim signal) instead of unregistering it.
				// R2-M-A3: an intentional-wait abort keeps the entry too (same reasoning —
				// the run is parked on a human decision, not crashed).
				if (abortedFreshLiveness || abortedIntentionalWait) {
					kept.push(entry.runId);
					continue;
				}
				unregisterActiveRun(entry.runId);
				purged.push(entry.runId);
				continue;
			}
		}

		// 6. "running" but no async worker PID — possible orphaned run where the
		// manifest was never updated to a terminal status after the worker exited.
		// Uses the same life-evidence corroboration as condition 5; the stateRoot is
		// kept on cancel so the run stays queryable/resumable with diagnostics.
		// R7-1 (2026-10-16): step 6 now also honors TASK-level life evidence
		// (hasRecentTaskActivity), making it symmetric with cancelOrphanedRuns.
		// A DWF-foreground run (run.ts → runDynamicWorkflow) writes neither
		// heartbeat.json nor manifest.updatedAt while a long subagent step
		// executes — only its task heartbeats prove liveness. Without this check
		// a subagent step longer than staleThresholdMs was false-cancelled
		// (tasks cancelled + run flipped terminal + registry entry dropped)
		// while the worker was still running; a later `team resume` then
		// double-dispatched the live run.
		if (manifest?.status === "running" && manifest.async === undefined) {
			if (!hasRecentLifeEvidence(entry, manifest.updatedAt, now, staleThresholdMs)) {
				let cancelledUnderLock = false;
				let abortedFreshLiveness = false;
				let abortedIntentionalWait = false; // R2-M-A3: keep intentional-wait runs
				try {
					const fullLoaded = loadRunManifestById(entry.cwd, entry.runId);
					if (fullLoaded && fullLoaded.manifest.status === "running") {
						withRunLockSync(fullLoaded.manifest, () => {
							const fresh = loadRunManifestById(entry.cwd, entry.runId);
							if (fresh?.manifest.status !== "running") return;
							// R2-M-A3 (2026-10-17): mirror the step-5 guard (and :135/:329/:937) — a
							// parked run (plan approval / pending ask) is not an orphan. KEEP it.
							if (isIntentionalWait(fresh.manifest, now)) {
								abortedIntentionalWait = true;
								return;
							}
							// R7-6 (2026-10-16): under-lock liveness revalidation — the pre-lock
							// gate used inputs read BEFORE the lock; a concurrent `team resume`
							// adoption may have rewritten them in that window (fresh
							// manifest.updatedAt / re-populated live pid / fresh task heartbeats).
							// Fresh evidence → abort WITHOUT cancelling and KEEP the registry
							// entry (it is the live-claim signal G12 relies on). This ALSO covers
							// R7-1’s task-heartbeat evidence: hasFreshLivenessEvidence consults
							// hasRecentTaskActivity on this FRESH in-lock snapshot.
							if (hasFreshLivenessEvidence(fresh, now, staleThresholdMs)) {
								abortedFreshLiveness = true;
								appendEvent(fresh.manifest.eventsPath, {
									type: "crew.run.orphan_skip",
									runId: entry.runId,
									message:
										"Skipped purge cancellation: fresh liveness evidence observed under the run lock (run re-adopted or still active)",
									data: { reason: "fresh_liveness_under_lock" },
								});
								return;
							}
							const now_iso = new Date(now).toISOString();
							const repairedTasks = fresh.tasks.map((task) => {
								if (task.status === "running" || task.status === "queued" || task.status === "waiting") {
									return {
										...task,
										status: "cancelled" as const,
										finishedAt: now_iso,
										error: "Orphaned run: workflow completed but manifest never updated to terminal status",
									};
								}
								return task;
							});
							saveRunTasks(fresh.manifest, repairedTasks);
							for (const task of repairedTasks) {
								try {
									upsertCrewAgent(fresh.manifest, recordFromTask(fresh.manifest, task, "scaffold"));
								} catch {
									/* non-critical */
								}
							}
							updateRunStatus(
								fresh.manifest,
								"cancelled",
								"Orphaned run: no async worker and no manifest update in over " +
									Math.round(staleThresholdMs / 60000) +
									" minutes",
							);
							// R2-M-A3: clear waitState on cancel (mirror :431-438 + step 5 above).
							if (fresh.manifest.waitState) {
								const cleared = { ...fresh.manifest, waitState: undefined, updatedAt: new Date(now).toISOString() };
								saveRunManifest(cleared);
								fresh.manifest = cleared;
							}
							cancelledUnderLock = true;
						});
						// R7-1/R7-6: only terminate live agents when the cancel actually landed
						// under the lock — an aborted (fresh-evidence) run is alive; terminating
						// it would kill the run we just decided to keep.
						if (cancelledUnderLock) {
							void terminateLiveAgentsForRun(
								fullLoaded.manifest.runId,
								"cancelled",
								appendEvent,
								fullLoaded.manifest.eventsPath,
							).catch((error) =>
								logInternalError("crash-recovery.pid-dead.terminate", error, `runId=${fullLoaded.manifest.runId}`, "warn"),
							);
						}
					}
				} catch {
					// Best-effort
				}
				// R7-1/R7-6: a fresh-evidence abort means the run is alive again — KEEP
				// the registry entry (live-claim signal) instead of unregistering it.
				// R2-M-A3: an intentional-wait abort keeps the entry too.
				if (abortedFreshLiveness || abortedIntentionalWait) {
					kept.push(entry.runId);
					continue;
				}
				unregisterActiveRun(entry.runId);
				purged.push(entry.runId);
				continue;
			}
		}

		kept.push(entry.runId);
	}

	return { purged, kept };
}

/**
 * U9 (upgrade-spec 2026-10-09): reconcile-at-open FAST-PATH result — the
 * durable-scheduler-inspired "1 pass" that replaces the verdict tree for
 * crashed runs WITHOUT a live claim. `event` is appended by the CALLER via the
 * async primitive after the sync writes land (U2 discipline — mirrors
 * applyRecoveryPlan's `lifecycle` pattern; the run lock is held by the caller).
 */
export interface ReconcileAtOpenFastPathOutcome {
	result: ReconcileResult;
	eventsPath: string;
	event: AppendTeamEvent;
}

/**
 * U9 (upgrade-spec 2026-10-09): reconcile-at-open fast-path.
 *
 * When a run is opened after a crash and there is NO live claim (dead async
 * runner PID + no live active-run-registry entry), ONE pass requeues every
 * `running` task → `queued`, PRESERVING attempt/deps/partial state (attempts,
 * checkpoint, claim, artifacts, usage — only per-attempt transient fields are
 * reset, mirroring applyRecoveryPlan), then marks the run `failed` so later
 * reconcile passes leave the requeued tasks alone (the failed status is
 * load-bearing idempotency: reconcileAllStaleRuns only visits running/blocked
 * runs, so the fast-path fires exactly once; a later `team resume` requeues
 * failed/cancelled/skipped/running → queued and re-executes what remains).
 *
 * G12 preserved: a run WITH a live claim NEVER takes this path — callers fall
 * through to the full stale-reconciler verdict tree
 * (healthy/waiting_answer/pid_dead/...), unchanged. Intentional waits (plan
 * approval / pending ask) are likewise left to the verdict tree. Runs without
 * an async runner PID (foreground/live-session) also defer — their liveness
 * evidence is the registry entry plus heartbeat staleness, which the verdict
 * tree already weighs.
 *
 * MUST be called under the run lock on a freshly-loaded state (the
 * reconcileAllStaleRuns call site does exactly that). Returns undefined when
 * the fast-path does not apply (live claim / intentional wait / no async PID /
 * nothing left in `running`/`waiting` — the idempotent re-entry case).
 */
export function applyReconcileAtOpenFastPath(
	loaded: { manifest: TeamRunManifest; tasks: TeamTaskState[] },
	now = Date.now(),
): ReconcileAtOpenFastPathOutcome | undefined {
	const { manifest } = loaded;
	const pid = manifest.async?.pid;
	// Only a dead, well-formed detached-runner PID is authoritative crash
	// evidence. No PID (foreground/live-session runs) → verdict tree.
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return undefined;
	if (checkProcessLiveness(pid).alive) return undefined; // live claim → verdict tree
	if (hasLiveRunClaim(manifest.runId, manifest)) return undefined; // G12: never touch a claimed run
	// Intentional waits (plan approval / pending ask within TTL) are not crashes.
	if (isIntentionalWait(manifest, now)) return undefined;
	// `waiting` tasks requeue alongside `running` ones (review round-2 MINOR-1):
	// an ask parked past WAITING_TTL — or whose waitState was lost in the crash —
	// is NOT an intentional wait (isIntentionalWait above already declined), and
	// `team resume` only requeues failed/cancelled/skipped/running, so leaving a
	// `waiting` task inside the failed run would strand it for manual repair.
	const requeueEligible = loaded.tasks.filter((task) => task.status === "running" || task.status === "waiting");
	if (requeueEligible.length === 0) return undefined; // idempotent: nothing to requeue

	const requeued = new Set(requeueEligible.map((task) => task.id));
	const tasks = loaded.tasks.map((task) =>
		requeued.has(task.id)
			? {
					...task,
					status: "queued" as const,
					startedAt: undefined,
					finishedAt: undefined,
					error: undefined,
					heartbeat: undefined,
					// WP-2/R2 discipline (same as applyRecoveryPlan): a requeued task must
					// not resume parked ask state.
					waiting: undefined,
					// attempt/deps/partial state PRESERVED (attempts, checkpoint, claim,
					// artifacts, usage, modelAttempts) — only per-attempt transient
					// fields above are reset, exactly like applyRecoveryPlan.
				}
			: task,
	);
	saveRunTasks(manifest, tasks);
	updateRunStatus(
		manifest,
		"failed",
		`Interrupted: async runner dead (no live claim); ${requeueEligible.length} task(s) requeued for resume`,
	);
	return {
		result: {
			runId: manifest.runId,
			verdict: "requeued_no_claim",
			repaired: true,
			detail: `No live claim (async pid ${pid} dead, no live registry entry); requeued ${requeueEligible.length} interrupted task(s) (running or abandoned waiting) → queued for resume (attempt state preserved); run marked failed so later reconcile passes leave it resumable`,
			repairedTasks: tasks,
		},
		eventsPath: manifest.eventsPath,
		event: {
			type: "crew.run.resumed",
			runId: manifest.runId,
			message: `Reconcile-at-open fast-path: requeued ${requeueEligible.length} interrupted task(s) for resume (no live claim).`,
			data: {
				fastPath: true,
				requeuedTasks: [...requeued],
				recoveredFromSeq: scanSequence(manifest.eventsPath),
			},
		},
	};
}

/**
 * Wave 11b.2: run statuses whose descendants are fair game for the startup
 * sweep. Deliberately NARROWER than `TEAM_TERMINAL_RUN_STATUSES`, which also
 * counts `blocked`: a blocked run is intentionally parked (plan approval / ask)
 * and is enumerated by the reconcile lane, so its descendants must not be swept
 * here. `queued`/`planning`/`running` never appear either — those runs may
 * legitimately own live processes.
 */
const TERMINAL_RUN_STATUSES_FOR_SWEEP: ReadonlySet<TeamRunManifest["status"]> = new Set(["completed", "failed", "cancelled"]);

/**
 * Wave 11b.2: hard cap on terminal runs swept in ONE pass. Each visit costs a
 * /proc enumeration (plus a lock + two manifest reads), so an install with
 * hundreds of historical runs must not turn startup into a /proc storm; the
 * remainder are picked up on later passes (startup + the periodic reconcile),
 * newest first, which is also where leaks are most likely to still exist.
 */
const MAX_UNSWEPT_TERMINAL_RUNS_PER_PASS = 25;

/**
 * Wave 11b.3 (grace window): a terminal run is only swept once its `updatedAt`
 * is at least this old. `status` flips to `completed` the moment the last task
 * finishes, while the run's mux panes / live sessions can still be attached for
 * a while afterwards — the operator may be reading that output. Sweeping
 * immediately would kill processes the operator is still using, so the lane
 * waits one minute. A run that is still inside the window is NOT stamped: it
 * simply stays eligible and is picked up by a later pass (startup + the periodic
 * reconcile), which is exactly the reachability the 11b.2 marker provides.
 */
const TERMINAL_SWEEP_MIN_AGE_MS = 60_000;

/**
 * Wave 11b.3 (old-run starvation): how deep the terminal lane reads the manifest
 * cache. `list(50)` (the call the reconcile lane uses) is a top-N by `createdAt`
 * — with 50 newer runs in between, the run that actually leaked (the 10-22
 * incident: completed a day before its grandchildren died) would never be seen.
 * 200 is a per-lane window only; `DEFAULT_CACHE.manifestMaxEntries` and the
 * global `list()` default stay untouched.
 */
const TERMINAL_SWEEP_CACHE_WINDOW = 200;

/**
 * Wave 11b.4 (HIGH-2): how long a run marked `descendantSweepPending` waits
 * before the lane tries it again. A pending flag means the sweep PROVED
 * descendants it could not signal (a live unmatched group leader, a candidate
 * with no usable pgid, a refused group reap, an interactive tty) — the leak is
 * still out there, but the blocker is usually another live process, so retrying
 * on the very next pass would burn a /proc scan per pass for as long as that
 * process lives. Ten minutes is short enough that a real leak is reaped while
 * the operator is still in the same session, and long enough that a stuck run
 * cannot dominate the 25-per-pass budget.
 */
const TERMINAL_SWEEP_RETRY_MS = 10 * 60_000;

function isTerminalRunStatus(status: TeamRunManifest["status"]): boolean {
	return TERMINAL_RUN_STATUSES_FOR_SWEEP.has(status);
}

/**
 * Wave 11b.2 + 11b.4: is this TERMINAL run still entitled to a sweep attempt?
 *
 * Never swept ⇒ yes. Swept and clean ⇒ no (that is what the marker is for).
 * Swept but `descendantSweepPending` ⇒ yes again, once the bounded retry
 * interval has elapsed — otherwise a run whose candidates were all skipped
 * would never be looked at again and 11b.4's whole point (a real leak must stay
 * reachable) would be lost.
 */
function isTerminalSweepEligible(manifest: TeamRunManifest, now: number): boolean {
	if (!isTerminalRunStatus(manifest.status)) return false;
	if (manifest.descendantSweepAt === undefined) return true;
	if (manifest.descendantSweepPending !== true) return false;
	const sweptAt = Date.parse(manifest.descendantSweepAt);
	return Number.isFinite(sweptAt) && now - sweptAt > TERMINAL_SWEEP_RETRY_MS;
}

/**
 * Epoch ms of the run's last state change (`updatedAt`), falling back to
 * `createdAt`. `TeamRunManifest` has no `completedAt` (verified in
 * state/types.ts) and `updatedAt` is the field every status write refreshes, so
 * it is the correct "when did this run become terminal" proxy. A manifest whose
 * timestamps are both unparseable is treated as ANCIENT (0) — it must not starve
 * a leak just because its clock field is broken.
 */
function terminalSinceMs(manifest: TeamRunManifest): number {
	const updated = Date.parse(manifest.updatedAt);
	if (Number.isFinite(updated)) return updated;
	const created = Date.parse(manifest.createdAt);
	return Number.isFinite(created) ? created : 0;
}

/**
 * Wave 11b.2 + 11b.3: terminal runs whose descendant sweep marker is absent,
 * OLDEST first, capped at `MAX_UNSWEPT_TERMINAL_RUNS_PER_PASS`.
 *
 * This list is what makes the sweep reachable after the fact: the pre-11b.2
 * enumeration (`status === running | blocked`) structurally could not see a run
 * that had already persisted as `completed` — the shape of the incident run,
 * whose leaked grandchildren outlived it by a day. It is intentionally NOT
 * filtered by `currentSessionId`: a terminal run has no live claim to respect
 * (the marker, checked again under the run lock, is the idempotency guard), and
 * the sweep itself refuses to signal anything it cannot prove descends from
 * THIS run with a dead recorded parent.
 *
 * Ordering (11b.3): OLDEST `updatedAt` first, deliberately the opposite of the
 * reconcile lane. The cap is 25 /proc scans per pass, so whatever order is
 * chosen decides which leaks STARVE — and a leak from an old run is the one
 * that has been burning memory longest (the incident ran for 24 h). Newest-first
 * would let a steady stream of fresh runs push an old leak out of the cap
 * forever; oldest-first guarantees every eligible run is visited within
 * `ceil(eligible / 25)` passes.
 *
 * Age gate (11b.3): a run whose `updatedAt` is younger than
 * `TERMINAL_SWEEP_MIN_AGE_MS` is skipped and left UNSTAMPED (see the constant).
 *
 * Retry gate (11b.4, HIGH-2): a stamped run comes back only while it still
 * carries `descendantSweepPending` AND `TERMINAL_SWEEP_RETRY_MS` has elapsed
 * since the stamp — see `isTerminalSweepEligible`. Selection is still
 * oldest-first and still capped, so a pending run competes for the same 25-scan
 * budget as a never-swept one rather than getting a lane of its own.
 */
function selectUnsweptTerminalRunIds(manifestCache: ManifestCache, now = Date.now()): string[] {
	return manifestCache
		.list(TERMINAL_SWEEP_CACHE_WINDOW)
		.filter((manifest) => isTerminalSweepEligible(manifest, now))
		.map((manifest) => ({ runId: manifest.runId, terminalSinceMs: terminalSinceMs(manifest) }))
		.filter((entry) => now - entry.terminalSinceMs >= TERMINAL_SWEEP_MIN_AGE_MS)
		.sort((a, b) => a.terminalSinceMs - b.terminalSinceMs)
		.slice(0, MAX_UNSWEPT_TERMINAL_RUNS_PER_PASS)
		.map((entry) => entry.runId);
}

export async function reconcileAllStaleRuns(
	cwd: string,
	manifestCache: ManifestCache,
	now = Date.now(),
	currentSessionId?: string,
): Promise<ReconcileResult[]> {
	// Wave 11b.2 (F7 reachability): startup reconciliation used to enumerate
	// `running | blocked` only, so a run that had ALREADY persisted as terminal —
	// the common case the next morning — never reached `reconcileStaleRun` and its
	// leaked descendants (the 390 MB / 24 h bash grandchildren behind
	// team_20261022110510) were never reaped. A leak outlives its run, so the
	// sweep must be reachable from a LATER pass: every terminal run that has not
	// been swept yet (`manifest.descendantSweepAt` absent) is enumerated here and
	// swept once, under its own run lock, in a lane that never runs the stale
	// verdict tree (a terminal run is not stale — it is finished).
	// Wave 11b.3 adds the two bounds: the grace window (`updatedAt` at least a
	// minute old, so a just-finished run keeps its panes) and the deeper cache
	// window (oldest first), both documented on the constants above.
	const terminalRunIds = selectUnsweptTerminalRunIds(manifestCache, now);
	// Capture runIds to reconcile BEFORE acquiring locks — avoids TOCTOU between cache iteration and lock acquisition.
	const runIds = manifestCache
		.list(50)
		.filter((m) => {
			if (m.status !== "running" && m.status !== "blocked") return false;
			// Skip runs owned by the current live session — a live session B must
			// NOT reconcile (mark failed) session A's still-running run.
			if (currentSessionId && m.ownerSessionId && m.ownerSessionId === currentSessionId) return false;
			return true;
		})
		.map((m) => m.runId);
	// RR-021 WI-1.5 (audit C3): serial reconcile → mapConcurrent bound 4.
	// Each runId acquires its OWN run lock file (lockPath() is per-run), so the
	// acquisitions are independent; bound 4 caps fs/CPU contention. Results keep
	// input (snapshot) order — mapConcurrent indexes by item — and per-run
	// semantics (re-read inside lock, plan-approval re-check) are unchanged.
	const perRun = await mapConcurrent(runIds, 4, async (runId): Promise<ReconcileResult[]> => {
		// RR-021 review remediation: per-run error isolation — one corrupt run
		// must not reject the whole sweep (serial baseline threw too, but the
		// SPEC's "independent per-run" intent requires continue-on-error).
		try {
			const cached = manifestCache.get(runId);
			if (!cached) return [];
			const loaded = await loadRunManifestByIdAsync(cwd, runId); // NOTE: best-effort only; concurrent writes may cause inconsistency
			if (!loaded) return [];
			const out: ReconcileResult[] = [];
			// Use lock to prevent race with cancel/status handlers modifying the same run.
			// Same v0.9.26 lock family as the old sync acquisition — interop-safe.
			await withRunLock(loaded.manifest, async () => {
				// Re-read inside lock to get freshest data
				const fresh = await loadRunManifestByIdAsync(cwd, runId); // NOTE: inside withRunLock - consistent read
				if (!fresh || (fresh.manifest.status !== "running" && fresh.manifest.status !== "blocked")) return;
				// Belt-and-suspenders: reconcileStaleRun itself guards this, but the run
				// may have flipped to blocked+plan-approval between cache-list and lock
				// acquisition — re-check the freshest manifest under the lock.
				if (isPlanApprovalPendingEffective(fresh.manifest)) {
					out.push({
						runId,
						verdict: "blocked_awaiting_approval",
						repaired: false,
						detail: "Plan approval is pending; stale reconciliation skipped",
					});
					return;
				}
				// U9 (upgrade-spec 2026-10-09): reconcile-at-open FAST-PATH. A crashed run
				// with NO live claim (dead async runner PID + no live registry entry) is
				// requeued in one pass instead of going through the verdict tree, whose
				// pid_dead branch would CANCEL the running tasks and destroy resume
				// eligibility. Runs WITH a live claim (or intentional waits / no async
				// PID) skip this and keep the full verdict-tree semantics, unchanged.
				const fastPath = applyReconcileAtOpenFastPath(fresh, now);
				if (fastPath) {
					// Async lifecycle append AFTER the sync saveRunTasks/updateRunStatus
					// writes (U2 discipline — same ordering as the verdict branch below:
					// run.failed lands first, then the fast-path recovery record).
					await appendEventAsync(fastPath.eventsPath, fastPath.event);
					out.push(fastPath.result);
					return;
				}
				const result = reconcileStaleRun(fresh.manifest, fresh.tasks, now);
				if (result.repaired || result.verdict === "result_exists") {
					if (result.repairedTasks) {
						// NEW-1 (SDD 2026-09-30 WI-2): persist the FULL task array — the
						// individual-stale branch filters `repairedTasks` down to the stale
						// subset, and saveRunTasks full-overwrites tasks.json, which used to
						// drop every healthy task from disk. `persistTasks` carries the full
						// array; every other branch leaves it unset and falls back here.
						saveRunTasks(fresh.manifest, result.persistTasks ?? result.repairedTasks);
						for (const task of result.repairedTasks) {
							try {
								upsertCrewAgent(fresh.manifest, recordFromTask(fresh.manifest, task, "scaffold"));
							} catch {
								/* non-critical */
							}
						}
					}
					updateRunStatus(fresh.manifest, "failed", `Stale run reconciled: ${result.detail}`);
					void terminateLiveAgentsForRun(fresh.manifest.runId, "failed", appendEvent, fresh.manifest.eventsPath).catch((error) =>
						logInternalError("crash-recovery.reconcile.terminate", error, `runId=${fresh.manifest.runId}`, "warn"),
					);
					// U2 (2026-10-10): awaited async append — the lock callback is async; the
					// event lands after run.failed (sync updateRunStatus write above) in file
					// order and is durable before reconcileAllStaleRuns resolves.
					await appendEventAsync(fresh.manifest.eventsPath, {
						type: "crew.run.reconciled_stale",
						runId,
						message: result.detail,
						data: { verdict: result.verdict },
					});
				}
				if (result.verdict !== "healthy") {
					out.push(result);
				}
			});
			// Wave 11a review (MAJOR #3): the SYNC reconcile arms a group SIGKILL
			// escalation it cannot await. This async owner awaits it OUTSIDE the run
			// lock (so the lock hold time is unchanged) — the sweep must not resolve
			// while a SIGKILL is still pending delivery.
			await drainReapEscalations();
			return out;
		} catch (error) {
			logInternalError("crash-recovery.reconcileStaleRuns", error, `runId=${runId}`, "warn");
			return [];
		}
	});
	const results = perRun.flat();
	// Wave 11b.2: terminal-run descendant sweep lane. Deliberately SEPARATE from
	// the reconcile lane above: a terminal run must never enter the stale verdict
	// tree (`updateRunStatus`, task repair, `crew.run.reconciled_stale`), it only
	// needs its leaked descendants reaped once. Same per-run error isolation and
	// per-run lock as the reconcile lane; contributes no ReconcileResult.
	if (terminalRunIds.length > 0) {
		logInternalError(
			"crash-recovery.terminal-descendant-sweep",
			new Error(`sweeping descendants of ${terminalRunIds.length} unswept terminal run(s)`),
			terminalRunIds.join(","),
			"debug",
		);
	}
	// Wave 11b.4 (LOW-4): ONE /proc snapshot for the whole lane. Built lazily —
	// a pass whose every run bails out below (already clean, resumed, inside the
	// grace window) never pays for it. Before 11b.4 each run built its own, so a
	// full 25-run budget read /proc for every process on the host 25 times.
	let passSnapshot: ProcSnapshot | undefined;
	const sweepSnapshot = (): ProcSnapshot => (passSnapshot ??= buildProcSnapshot());
	await mapConcurrent(terminalRunIds, 2, async (runId): Promise<void> => {
		try {
			const loaded = await loadRunManifestByIdAsync(cwd, runId); // best-effort; re-read under the lock below
			if (!loaded) return;
			await withRunLock(loaded.manifest, async () => {
				const fresh = await loadRunManifestByIdAsync(cwd, runId); // consistent read inside the lock
				if (!fresh) return;
				// Idempotency: a concurrent pass (or the run's own completion path)
				// already stamped this run clean ⇒ nothing to do, and no /proc scan.
				// 11b.4 (HIGH-2): a run stamped `descendantSweepPending` is NOT done
				// — it is due again once the retry interval has elapsed, which is
				// what the cache selection just said; re-checked here because the
				// fresh read is authoritative and another pass may have just run it.
				if (!isTerminalSweepEligible(fresh.manifest, now)) return;
				// The run may have flipped back to running/blocked (resume) between
				// the cache list and this lock — that run belongs to the reconcile
				// lane, and its descendants are legitimate again.
				if (!isTerminalRunStatus(fresh.manifest.status)) return;
				// 11b.3: re-check the grace window on the FRESH manifest — a run that
				// resumed and finished again since the cache snapshot is young again,
				// and its panes may have just been re-attached.
				if (now - terminalSinceMs(fresh.manifest) < TERMINAL_SWEEP_MIN_AGE_MS) return;
				sweepTerminalRunDescendants(fresh.manifest, fresh.tasks, { snapshot: sweepSnapshot() });
			});
			// Wave 11a review MAJOR #3 (same owner as the reconcile lane): the sync
			// sweep arms a group SIGKILL escalation it cannot await.
			await drainReapEscalations();
		} catch (error) {
			logInternalError("crash-recovery.terminal-descendant-sweep", error, `runId=${runId}`, "warn");
		}
	});
	// US-002 (2026-09-22): structured stale-lock sweep. Runs after reconciliation
	// so locks whose holder died (kill -9 / crash) do not linger. The sweep is
	// strictly safer than acquire-time steal (stale AND holder-dead only), so a
	// live holder is never disturbed. Best-effort.
	// U21 (2026-10-13): socket holders need no sweep — the kernel process socket
	// of an async run-lock holder dies with its process. This sweep covers the
	// SYNC path (withRunLockSync, file-only by design) + legacy file-only holders;
	// remove after the file-lock migration window closes.
	try {
		const runsRoots = [
			path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.runsSubdir),
			path.join(userCrewRoot(), DEFAULT_PATHS.state.runsSubdir),
		];
		for (const runsRoot of runsRoots) {
			const { removed } = sweepStaleLocks(discoverRunLockFiles(runsRoot));
			if (removed.length > 0) {
				logInternalError(
					"crash-recovery.sweep-stale-locks",
					new Error(`swept ${removed.length} stale run lock(s)`),
					removed.join(", "),
					"warn",
				);
			}
		}
	} catch (error) {
		logInternalError("crash-recovery.sweep-stale-locks", error);
	}
	return results;
}
