import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readCrewAgents, saveCrewAgents } from "../runtime/crew-agent-records.ts";
import { checkProcessLiveness, isActiveRunStatus } from "../runtime/process-status.ts";
import { withRunLock, withRunLockSync } from "../state/coordination/locks.ts";
import { appendEventAsync, readEventsCursor, type TeamEvent } from "../state/event-log/event-log.ts";
import { loadRunManifestById, saveRunTasks, updateRunStatus } from "../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { extractSessionId } from "../utils/session-utils.ts";
import { listRecentRuns, listRuns } from "./run-index.ts";
import type { WebhookNotifier } from "./webhook-notify.ts";

export interface AsyncNotifierState {
	seenFinishedRunIds: Set<string>;
	interval?: ReturnType<typeof setInterval>;
	generation?: number;
	lastStoppedAtMs?: number;
	lastListRunsMs?: number;
}

export interface AsyncNotifierOptions {
	generation?: number;
	isCurrent?: (generation: number) => boolean;
	/**
	 * US-030 (docs/specs/US-030.md): outbound webhook sink, invoked ONCE per
	 * observed terminal transition — the same point (and dedupe memory) as the
	 * completion toast below. The sink handles quiet-hours, SSRF, HMAC and
	 * retry internally and NEVER throws. Optional — absent = disabled.
	 */
	webhookNotifier?: WebhookNotifier;
}

function isFinished(status: string): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "blocked";
}

// R5-M2 (Round 5 MEDIUM-2): FIFO cap for the dedupe Set. Set preserves
// insertion order, so evicting .values().next().value drops the oldest-seen
// runId. 256 >> the ~20 runs polled per tick; eviction only matters for a
// long-lived host session that observes thousands of finished runs.
const MAX_SEEN_FINISHED_RUN_IDS = 256;

function addSeenFinishedRunId(state: AsyncNotifierState, runId: string): void {
	state.seenFinishedRunIds.add(runId);
	while (state.seenFinishedRunIds.size > MAX_SEEN_FINISHED_RUN_IDS) {
		const oldest = state.seenFinishedRunIds.values().next().value;
		if (oldest === undefined) break;
		state.seenFinishedRunIds.delete(oldest);
	}
}

export function isAsyncTerminalEvent(event: TeamEvent): boolean {
	return event.type === "async.completed" || event.type === "async.failed" || event.type === "async.died";
}

function timeMs(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : undefined;
}

function latestEventAgeMs(events: TeamEvent[], now = Date.now()): number {
	const latest = events.at(-1);
	if (!latest) return Number.POSITIVE_INFINITY;
	const time = new Date(latest.time).getTime();
	return Number.isFinite(time) ? now - time : Number.POSITIVE_INFINITY;
}

function isTaskActive(task: TeamTaskState): boolean {
	return task.status === "running" || task.status === "queued" || task.status === "waiting";
}

/**
 * R4-7 (DR-02 Wave 2 Cluster C): pure RMW core of the async-died sweep —
 * flip ONLY still-active tasks to failed. Exported so the locked sweep body
 * stays unit-testable without the notifier interval harness (repo seam
 * pattern). Predicate is byte-identical to the previous inline map.
 */
export function failStillActiveTasks(tasks: readonly TeamTaskState[], failedAt: string, message: string): TeamTaskState[] {
	return tasks.map((task) =>
		isTaskActive(task)
			? {
					...task,
					status: "failed",
					finishedAt: failedAt,
					error: message,
				}
			: task,
	);
}

function markActiveTasksAndAgentsFailed(run: TeamRunManifest, message: string): void {
	const failedAt = new Date().toISOString();
	// R4-7 (DR-02 Wave 2 Cluster C): the task flip used to be an UNLOCKED
	// load→map→save on tasks.json (":74 no withRunLock - best-effort"). It is
	// now a run-locked RMW with the fresh re-read INSIDE the lock (R13-S1
	// canonical pattern): only tasks that are STILL active in the fresh read
	// are flipped, so a task that completed (or was cancelled) by a concurrent
	// writer is never overwritten with failed. Lock re-entrance: the sole
	// caller (markDeadAsyncRunIfNeeded) already holds the ASYNC run lock for
	// this run in the same async context, so this sync acquisition bypasses
	// via lockCtx — no self-deadlock, no double file acquire; an unlocked
	// future caller gets real mutual exclusion.
	try {
		withRunLockSync(run, () => {
			const fresh = loadRunManifestById(run.cwd, run.runId);
			if (!fresh) return;
			if (!fresh.tasks.some(isTaskActive)) return;
			saveRunTasks(fresh.manifest, failStillActiveTasks(fresh.tasks, failedAt, message));
		});
	} catch (error) {
		// Best-effort sweep: lock contention or a store failure must not break
		// the notifier tick (the run-status flip above already happened) — warn
		// and keep going; whatever remains active is retried by the next pass.
		logInternalError("async-notifier.markActiveTasksFailed", error, `runId=${run.runId}`, "warn");
	}
	const agents = readCrewAgents(run);
	if (agents.some((agent) => agent.status === "running" || agent.status === "queued" || agent.status === "waiting")) {
		saveCrewAgents(
			run,
			agents.map((agent) =>
				agent.status === "running" || agent.status === "queued" || agent.status === "waiting"
					? {
							...agent,
							status: "failed",
							completedAt: failedAt,
							error: message,
						}
					: agent,
			),
		);
	}
}

export async function markDeadAsyncRunIfNeeded(
	run: TeamRunManifest,
	now = Date.now(),
	quietMs = 30_000,
): Promise<TeamRunManifest | undefined> {
	if (!run.async || !isActiveRunStatus(run.status)) return undefined;
	const liveness = checkProcessLiveness(run.async.pid);
	if (liveness.alive) return undefined;
	const events = readEventsCursor(run.eventsPath).events;
	if (events.some(isAsyncTerminalEvent)) return undefined;
	if (latestEventAgeMs(events, now) < quietMs) return undefined;
	const asyncPid = run.async.pid;
	const message = `Background runner died unexpectedly; check background.log (${liveness.detail}).`;
	// RR-021 WI-1.4: rerouted to the async run-lock (same v0.9.26 lock family as
	// the sync helper — sync and async acquisitions interoperate via live-token
	// registration, RR-011 F02). The notifier tick is async, so we must not hold
	// the event loop with a blocking sync acquisition while other async contenders
	// (background runner, stale reconciler) wait.
	return withRunLock(run, async () => {
		const fresh = loadRunManifestById(run.cwd, run.runId); // NOTE: best-effort only inside the lock; concurrent writes may cause inconsistency;
		if (!fresh || !isActiveRunStatus(fresh.manifest.status)) return undefined;
		const failed = updateRunStatus(fresh.manifest, "failed", message);
		markActiveTasksAndAgentsFailed(failed, message);
		// U2 (2026-10-10): awaited async append — the lock callback is async; the
		// event lands after run.failed (sync updateRunStatus write above) in file
		// order and is durable before the notifier tick resolves.
		await appendEventAsync(failed.eventsPath, {
			type: "async.died",
			runId: failed.runId,
			message,
			data: { pid: asyncPid, detail: liveness.detail },
		});
		return failed;
	});
}

const LIST_RUNS_DEBOUNCE_MS = 30_000;

export function startAsyncRunNotifier(
	ctx: ExtensionContext,
	state: AsyncNotifierState,
	intervalMs = 5000,
	options: AsyncNotifierOptions = {},
): void {
	if (state.interval) clearInterval(state.interval);
	const generation = options.generation ?? (state.generation ?? 0) + 1;
	state.generation = generation;
	const startedAtMs = Date.now();
	const staleBeforeMs = state.lastStoppedAtMs ?? startedAtMs;
	// Vector #11: only observe runs owned by THIS pi session (plus
	// ownerless/legacy runs). Runs owned by a different pi session must never be
	// toasted here — otherwise session B notifies about session A's completions
	// (cross-session information leak). When the session id is unavailable (older
	// Pi / test mocks without a sessionManager), nothing is filtered (back-compat).
	const sid = extractSessionId(ctx);
	const ownsRun = (run: TeamRunManifest): boolean => !sid || !run.ownerSessionId || run.ownerSessionId === sid;
	for (const run of listRuns(ctx.cwd).filter(ownsRun)) {
		// R5-M2: the seed scans the FULL listRuns() index (newest-first); stop
		// seeding once the Set is at capacity so a huge historical index cannot
		// push the newest finished runIds out via FIFO eviction.
		if (state.seenFinishedRunIds.size >= MAX_SEEN_FINISHED_RUN_IDS) break;
		// Suppress only terminal runs that were already finished before this owner
		// session (or before the previous session switch). Active runs must remain
		// un-seen so completions during auto-compaction/session restart are delivered.
		const updatedAtMs = timeMs(run.updatedAt) ?? 0;
		if (isFinished(run.status) && updatedAtMs < staleBeforeMs) addSeenFinishedRunId(state, run.runId);
	}
	let cachedRuns: TeamRunManifest[] | undefined;
	// RR-021 WI-1.4: the tick is async now (markDeadAsyncRunIfNeeded awaits the
	// run-lock). `ticking` preserves the old no-overlap semantics — setInterval
	// must not re-enter a tick that is still awaiting a lock.
	let ticking = false;
	const tick = async (): Promise<void> => {
		if (ticking) return;
		ticking = true;
		try {
			if (options.isCurrent && !options.isCurrent(generation)) return;
			const nowMs = Date.now();
			if (cachedRuns === undefined || nowMs - (state.lastListRunsMs ?? 0) > LIST_RUNS_DEBOUNCE_MS) {
				// RR-021 WI-4.1: bounded recent-runs read (40 = 2x the 20 we keep) instead
				// of a full listRuns() index scan on every debounce window — the 2x bound
				// survives the ownsRun filter still yielding 20 owned runs.
				cachedRuns = listRecentRuns(ctx.cwd, 40).filter(ownsRun).slice(0, 20);
				state.lastListRunsMs = nowMs;
			}
			for (const run of cachedRuns) {
				const current = (await markDeadAsyncRunIfNeeded(run)) ?? run;
				if (!isFinished(current.status) || state.seenFinishedRunIds.has(current.runId)) continue;
				addSeenFinishedRunId(state, current.runId);
				// Suppress notifications for INTERNAL goal-loop sub-runs.
				// The outer goal-loop creates a synthetic 'goal-turn' workflow per turn
				// (see buildTurnWorkflow in goal-loop-runner.ts). These runs are
				// implementation details of the autonomous loop — the user only cares
				// about the OUTER goal-loop's status (runKind:'goal-loop'), which has
				// its own event stream + status command. Without this filter, every
				// turn that hits e.g. a transient model rate limit triggers an
				// alarming 'Error: pi-crew run failed' toast for an internal sub-run
				// the user never started directly.
				if (current.workflow === "goal-turn" && current.team.startsWith("goal-")) continue;
				// US-030: outbound webhook on the terminal transition. Only the three
				// spec statuses (completed/failed/cancelled) — "blocked" runs do not
				// notify. Fire-and-forget: the sink is contractually non-throwing, the
				// try/catch is belt-only so a webhook failure can NEVER suppress the
				// local toast (or reach the run lifecycle path).
				if (
					options.webhookNotifier &&
					(current.status === "completed" || current.status === "failed" || current.status === "cancelled")
				) {
					try {
						options.webhookNotifier.notifyTerminalRun(current);
					} catch (error) {
						logInternalError("async-notifier.webhook", error, current.runId);
					}
				}
				const level = current.status === "completed" ? "info" : current.status === "cancelled" ? "warning" : "error";
				ctx.ui.notify(`pi-crew run ${current.status}: ${current.runId} (${current.team}/${current.workflow ?? "none"})`, level);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("stale") || message.includes("session replacement") || message.includes("old ctx")) {
				// Don't stop the interval — session_start will create a new notifier
				// with the refreshed ctx. The isCurrent guard will make this old
				// notifier dormant once sessionGeneration increments.
				// Stopping here creates a race: old notifier dies before new one starts.
				return;
			}
			logInternalError("async-notifier", error, `interval=${intervalMs}`);
		} finally {
			ticking = false;
		}
	};
	state.interval = setInterval(() => {
		// tick() never rejects (it catches internally) — void is safe.
		void tick();
	}, intervalMs);
	// Defense-in-depth: never let the notifier timer keep the event loop alive.
	// If stopAsyncRunNotifier is missed (session switch race), the next run of
	// this interval is harmless, but the timer must not block process exit.
	if (typeof state.interval.unref === "function") state.interval.unref();
}

export function stopAsyncRunNotifier(state: AsyncNotifierState): void {
	if (state.interval) clearInterval(state.interval);
	state.interval = undefined;
	// R5-M2: clear the dedupe Set on stop so entries do not persist across
	// stop/start cycles; startAsyncRunNotifier re-seeds from listRuns() using
	// lastStoppedAtMs, so runs finished before the stop stay suppressed.
	state.seenFinishedRunIds.clear();
	state.generation = (state.generation ?? 0) + 1;
	state.lastStoppedAtMs = Date.now();
}
