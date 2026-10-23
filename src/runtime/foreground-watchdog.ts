/**
 * Foreground run watchdog — periodically checks that active foreground runs
 * are making progress and auto-notifies the assistant if a run appears hung.
 *
 * Problem: foreground runs run in background via startForegroundRun(). The Pi
 * assistant has no way to know when a run completes or gets stuck without
 * manual polling. This watchdog monitors active runs and:
 *
 * 1. Detects hung runs (active status, no heartbeat update for >10 min)
 * 2. Injects a followUp message via pi.sendUserMessage() so the assistant
 *    is automatically notified — no manual sleep+check needed.
 * 3. Cleans up after itself when the run completes or the session ends.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCrewEnv, getCrewEnvInt } from "../config/env-vars.ts";
import { TEAM_TERMINAL_TASK_STATUSES } from "../state/contracts.ts";
import { loadRunManifestById } from "../state/stores/state-store.ts";
import type { TeamTaskState } from "../state/types.ts";
import { readCrewAgents } from "./crew-agent-records.ts";
import { isActiveRunStatus, isLikelyOrphanedActiveRun } from "./process-status.ts";

export interface WatchdogOptions {
	pi: ExtensionAPI;
	cwd: string;
	runId: string;
	/**
	 * Check interval in ms. Default: 5 minutes, or the
	 * `PI_CREW_WATCHDOG_INTERVAL_MS` override when set (WD-INTERVAL).
	 */
	checkIntervalMs?: number;
	/** Maximum time to monitor in ms. Default: 2 hours. */
	maxMonitorMs?: number;
}

const DEFAULT_CHECK_INTERVAL_MS = 300_000; // 5 minutes
const DEFAULT_MAX_MONITOR_MS = 7_200_000; // 2 hours

/** Active watchdog timers — keyed by runId for cleanup. */
const activeWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * WD-DEDUP (2026-10-23): hung-alert dedup state, keyed by runId at module
 * scope so a *new* watchdog instance (or a re-armed one after stop/start)
 * cannot re-alert for a run the user already heard about. Bounded FIFO —
 * the oldest entry is evicted once the cap is reached, so long-lived
 * sessions cannot leak memory on this map.
 */
interface HungAlertRecord {
	/** A "run … appears hung" alert has already been emitted for this runId. */
	alerted: boolean;
	/** The one-time re-verify-skip debug log has already been emitted. */
	skipLogged: boolean;
	/**
	 * WD-STALE-RECORD (2026-10-23): the one-time "record stale (all tasks
	 * terminal) — skipped hung alert" notice has already been emitted.
	 */
	staleNoticeSent?: boolean;
}
const HUNG_ALERT_RECORDS_CAP = 256;
const hungAlertRecords = new Map<string, HungAlertRecord>();

function hungAlertAlreadySent(runId: string): boolean {
	return hungAlertRecords.get(runId)?.alerted === true;
}

/** Insert/update a record, evicting the oldest entry when the cap is hit. */
function updateHungAlertRecord(runId: string, patch: Partial<HungAlertRecord>): void {
	if (!hungAlertRecords.has(runId) && hungAlertRecords.size >= HUNG_ALERT_RECORDS_CAP) {
		const oldest = hungAlertRecords.keys().next().value;
		if (oldest !== undefined) hungAlertRecords.delete(oldest);
	}
	const prev = hungAlertRecords.get(runId) ?? { alerted: false, skipLogged: false, staleNoticeSent: false };
	hungAlertRecords.set(runId, { ...prev, ...patch });
}

/** Debug log gated behind PI_CREW_DEBUG (same convention as background-runner). */
function debugLog(message: string): void {
	if (getCrewEnv("PI_CREW_DEBUG")) console.log(message);
}

/**
 * WD-STALE-RECORD (2026-10-23): a run record whose manifest is still `running`
 * but whose EVERY task is terminal is a stale record, not a hung run. The
 * worker(s) finished; the manifest write is merely behind (finalize racing, or
 * a finalize write lost to a crash). Alerting "appears hung" for such a run is
 * the exact pain users reported (alert for a run that is actually done), so the
 * re-verify gate treats it as terminal and stays silent.
 *
 * Fail-open by design: no tasks recorded (`[]`), a non-array, or an unreadable
 * tasks.json (loadRunManifestById degrades to `tasks: []`) returns false so the
 * legacy alert behavior is preserved — a broken tasks file must never silence
 * a genuinely hung run.
 */
function areAllTasksTerminal(tasks: TeamTaskState[] | undefined): boolean {
	if (!Array.isArray(tasks) || tasks.length === 0) return false;
	return tasks.every((task) => TEAM_TERMINAL_TASK_STATUSES.has(task.status));
}

/**
 * WD-INTERVAL (2026-10-23): resolve the poll interval. An explicit
 * `checkIntervalMs` (tests / callers) wins, then the `PI_CREW_WATCHDOG_INTERVAL_MS`
 * env override (live repro at 20s instead of 5 min), then the 5-minute default.
 * Only positive finite values are honored — `0`/negative/garbage fall through.
 */
function resolveCheckIntervalMs(overrideMs: number | undefined): number {
	if (typeof overrideMs === "number" && Number.isFinite(overrideMs) && overrideMs > 0) return overrideMs;
	const configured = getCrewEnvInt("PI_CREW_WATCHDOG_INTERVAL_MS");
	if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) return configured;
	return DEFAULT_CHECK_INTERVAL_MS;
}

/**
 * Pre-emit state re-verify loader. Injectable for tests to simulate the run
 * going terminal between the cycle's initial read and the emit point.
 */
type ReverifyLoader = typeof loadRunManifestById;
let reverifyLoader: ReverifyLoader = loadRunManifestById;

/** @internal Test seam — reset module-level hung-alert dedup state. */
export function resetHungAlertDedupForTests(): void {
	hungAlertRecords.clear();
	reverifyLoader = loadRunManifestById;
}

/** @internal Test seam — snapshot of the dedup map size (cap/leak assertions). */
export function hungAlertDedupSizeForTests(): number {
	return hungAlertRecords.size;
}

/** @internal Test seam — force-mark a runId as already alerted (cap assertions). */
export function markHungAlertForTests(runId: string): void {
	updateHungAlertRecord(runId, { alerted: true });
}

/** @internal Test seam — replace the pre-emit re-verify loader (null = real). */
export function setReverifyLoaderForTests(loader: ReverifyLoader | null): void {
	reverifyLoader = loader ?? loadRunManifestById;
}

/** Stop a specific watchdog by runId. */
export function stopWatchdog(runId: string): void {
	const timer = activeWatchdogs.get(runId);
	if (timer) {
		clearTimeout(timer);
		activeWatchdogs.delete(runId);
	}
}

/** @internal Stop all active watchdogs. Called on session shutdown (RC-01). */
export function stopAllWatchdogs(): void {
	for (const [runId, timer] of activeWatchdogs) {
		clearTimeout(timer);
	}
	activeWatchdogs.clear();
}

/**
 * Start a periodic watchdog for a foreground run.
 * Checks at regular intervals whether the run is still progressing.
 * If the run appears hung (no update for >10 min with no active agents),
 * injects a followUp message into the Pi conversation.
 *
 * Automatically stops when:
 * - The run reaches a terminal status (completed/failed/cancelled)
 * - The max monitor time is exceeded
 * - Explicitly stopped via stopWatchdog()
 */
export function startForegroundWatchdog(opts: WatchdogOptions): void {
	const { pi, cwd, runId } = opts;
	const checkIntervalMs = resolveCheckIntervalMs(opts.checkIntervalMs);
	const maxMonitorMs = opts.maxMonitorMs ?? DEFAULT_MAX_MONITOR_MS;
	const startTime = Date.now();

	// Don't stack watchdogs for the same run
	if (activeWatchdogs.has(runId)) return;

	// ARCH-5: cap consecutive no-progress wake notices at 2, then send one
	// final guidance message and go quiet — a ~24-notices/2h drip trains the
	// user to ignore the watchdog. Reset on any sign of progress (run ends or
	// leaves the hung state).
	let consecutiveHungNotices = 0;
	const HUNG_NOTICE_CAP = 2;

	const check = (): void => {
		// Check if max monitor time exceeded
		if (Date.now() - startTime > maxMonitorMs) {
			activeWatchdogs.delete(runId);
			return;
		}

		try {
			const loaded = loadRunManifestById(cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
			if (!loaded) {
				// Run not found — stop watchdog
				activeWatchdogs.delete(runId);
				return;
			}

			const { manifest } = loaded;

			// Terminal status — send completion notification and stop
			if (!isActiveRunStatus(manifest.status)) {
				const teamName = manifest.team ?? "unknown";
				try {
					pi.sendUserMessage(`pi-crew run ${manifest.status}: ${runId} (${teamName}/${manifest.workflow ?? "default"})`, {
						deliverAs: "followUp",
					});
				} catch {
					/* non-critical */
				}
				activeWatchdogs.delete(runId);
				return;
			}

			// Check if run appears hung
			const agents = readCrewAgents(manifest);
			const now = Date.now();
			if (isLikelyOrphanedActiveRun(manifest, agents, now)) {
				// WD-DEDUP (2026-10-23): re-verify the run state right before any
				// emit. A check armed by an older poll cycle can race the run
				// reaching a terminal status — alerting "appears hung" for a run
				// that already finished is exactly the repeated-alert pain.
				// Terminal (or vanished) at re-verify → skip the emit entirely;
				// the next cycle's terminal branch delivers the completion notice.
				const reverified = reverifyLoader(cwd, runId);
				if (!reverified || !isActiveRunStatus(reverified.manifest.status)) {
					const reason = reverified ? `status=${reverified.manifest.status}` : "manifest gone";
					if (!hungAlertRecords.get(runId)?.skipLogged) {
						updateHungAlertRecord(runId, { skipLogged: true });
						debugLog(`[foreground-watchdog] skip hung alert for ${runId}: re-verify saw ${reason}`);
					}
					// Fall through to the shared schedule — keep monitoring; the next
					// cycle hits the terminal branch (completion notice) or !loaded.
				} else if (areAllTasksTerminal(reverified.tasks)) {
					// WD-STALE-RECORD: manifest still says running, but every task is
					// terminal → the run is done and only the record is behind. Stay
					// silent about "hung" and tell the user ONCE that the record is
					// stale (per runId, module-scope — no spam across restarts).
					if (!hungAlertRecords.get(runId)?.skipLogged) {
						updateHungAlertRecord(runId, { skipLogged: true });
						debugLog(
							`[foreground-watchdog] skip hung alert for ${runId}: record stale (manifest ${reverified.manifest.status}, all ${reverified.tasks.length} task(s) terminal)`,
						);
					}
					if (!hungAlertRecords.get(runId)?.staleNoticeSent) {
						updateHungAlertRecord(runId, { staleNoticeSent: true });
						try {
							pi.sendUserMessage(`pi-crew watchdog: run ${runId} record stale (all tasks terminal) — skipped hung alert.`, {
								deliverAs: "followUp",
							});
						} catch {
							/* non-critical */
						}
					}
					// Keep monitoring: if the manifest eventually finalizes, the
					// terminal branch delivers the completion notice.
				} else {
					const detail = `status=${manifest.status}, updatedAt=${manifest.updatedAt}, agents=${agents.length}`;
					consecutiveHungNotices += 1;
					try {
						if (consecutiveHungNotices <= HUNG_NOTICE_CAP) {
							// WD-DEDUP: alert-once per runId at module scope — even a
							// fresh watchdog instance must not re-alert the same run.
							if (!hungAlertAlreadySent(runId)) {
								pi.sendUserMessage(
									`pi-crew watchdog: run ${runId} appears hung (${detail}). Consider running team action='cancel' runId='${runId}' or team action='doctor'.`,
									{ deliverAs: "followUp" },
								);
								updateHungAlertRecord(runId, { alerted: true });
							}
						} else if (consecutiveHungNotices === HUNG_NOTICE_CAP + 1) {
							// One-time handoff, then silence — still monitoring, no more drips.
							pi.sendUserMessage(
								`pi-crew watchdog: run ${runId} is still hung after ${consecutiveHungNotices} checks — going quiet now. Intervene via team action='cancel' runId='${runId}', team action='doctor', or leave it; a completion notice will still fire.`,
								{ deliverAs: "followUp" },
							);
						}
					} catch {
						/* non-critical */
					}
				}
				// Keep monitoring (ARCH-5: silently past the cap — no more notices).
			} else {
				// Run is alive and progressing — reset the no-progress wake counter.
				consecutiveHungNotices = 0;
			}
		} catch {
			// Non-critical — skip this check
		}

		// Schedule next check
		const timer = setTimeout(check, checkIntervalMs);
		timer.unref(); // Don't prevent process exit
		activeWatchdogs.set(runId, timer);
	};

	// First check after initial interval
	const timer = setTimeout(check, checkIntervalMs);
	timer.unref();
	activeWatchdogs.set(runId, timer);
}
