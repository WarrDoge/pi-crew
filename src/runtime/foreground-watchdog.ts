/**
 * Foreground run watchdog — periodically checks that active foreground runs
 * are making progress and auto-notifies the assistant if a run appears hung.
 *
 * Problem: foreground runs run in background via startForegroundRun(). The Pi
 * assistant has no way to know when a run completes or gets stuck without
 * manual polling. This watchdog monitors active runs and:
 *
 * 1. Detects hung runs (active status, manifest not updated for >2 min with
 *    no agent activity evidence — wave 13: a live registry claim or a fresh
 *    task heartbeat withholds the verdict, see CLAIMED_RUN_HUNG_MS)
 * 2. Injects a followUp message via pi.sendUserMessage() so the assistant
 *    is automatically notified — no manual sleep+check needed.
 * 3. Cleans up after itself when the run completes or the session ends.
 *
 * Hung alerts are additionally DELIVERY-gated (WD-DELIVER-GUARD): the message
 * is only handed to the host when the host will deliver it immediately, and
 * the run state is re-read at that instant — an alert whose run finished in
 * the meantime is dropped instead of nagging the user minutes late.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCrewEnv, getCrewEnvInt } from "../config/env-vars.ts";
import { TEAM_TERMINAL_TASK_STATUSES } from "../state/contracts.ts";
import { activeRunEntries } from "../state/stores/active-run-registry.ts";
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
	/**
	 * WD-DELIVER-GUARD (2026-10-23): capability-guarded probe for "the host will
	 * deliver a followUp message NOW" (`ctx.isIdle()`). When it reports false,
	 * a hung alert is held in this module's pending map and retried at the idle
	 * boundary instead of being handed to the host's unretractable followUp
	 * queue (where it can land minutes later, for a run that already finished).
	 * Absent / throwing → treated as idle (pre-guard behavior, fail-open).
	 */
	isSessionIdle?: () => boolean | undefined;
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
	/**
	 * WD-DELIVER-GUARD (2026-10-23): the one-time "drop hung alert at delivery"
	 * debug log has already been emitted for this runId.
	 */
	droppedAtDeliveryLogged?: boolean;
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

// ── Wave 13 (F1, GAP-0): hung-verdict liveness short-circuit ────────────────
//
// Live evidence (2026-10-24/25): five false "appears hung" alerts in one
// session, all direct single-agent runs executing ONE long tool call (a
// 20-min CI poll loop, a 20-min test suite). The hung verdict
// (isLikelyOrphanedActiveRun: manifest stale ≥2 min + no agent activity
// within 5 min) is structurally blind while a tool executes — every
// liveness write is event-driven and no pi events fire mid-tool — so a
// HEALTHY run reads as hung ~5-10 min into a long tool. The two signals
// other consumers already trust, and this verdict ignores, are consulted
// here IN THE WATCHDOG (never inside isLikelyOrphanedActiveRun — that
// predicate is shared with the dashboard's isDisplayActiveRun, GAP-4):
//   (a) a LIVE active-run-registry claim, and
//   (b) a fresh task heartbeat (kept fresh through long tools by F2's
//       live-executor timer).
// The two branches are INDEPENDENT ORs: the registry drops non-async
// entries once the manifest is >30 min stale, so past that horizon only the
// heartbeat carries liveness — never require both.

/**
 * Wave 13 (F1, GAP-0): hard ceiling for how long a LIVE active-run-registry
 * claim can shield a run from the watchdog's hung verdict. A claimed run
 * whose NEWEST liveness evidence (claim assertion time, task heartbeats/
 * activity) is older than this still alerts — a genuine in-process deadlock
 * (claim held, nothing progressing) is still caught — while healthy claimed
 * runs mid-long-tool are not false-alarmed by the 2-min ladder. 45 min is
 * 1.5× the registry's own 30-min freshness horizon and 9× the 5-min activity
 * shield, so only a truly stuck claim trips it. Unclaimed runs keep the
 * fast 2-min ladder unchanged; ORPHANED_ACTIVE_RUN_MS (process-status.ts,
 * shared with the dashboard — GAP-4) is NOT touched.
 */
export const CLAIMED_RUN_HUNG_MS = 45 * 60 * 1000;

/**
 * Wave 13 (F1): freshness window for task-heartbeat liveness evidence —
 * mirrors ACTIVE_EVIDENCE_TTL_MS in stale-reconciler.ts (5 min).
 */
const TASK_HEARTBEAT_EVIDENCE_MS = 5 * 60 * 1000;

/**
 * Wave 13 (F1): read-only active-run-registry claim consult result.
 * `claimedAtMs` is the registry entry's `updatedAt` (the moment the claim
 * was asserted — registerActiveRun fires at dispatch); undefined when the
 * entry carries no parseable timestamp.
 */
interface LiveRunClaim {
	claimedAtMs?: number;
}

/**
 * Wave 13 (F1, GAP-0): consult the active-run registry for a LIVE claim on
 * `runId`. Read-only mirror of findLiveRegistryEntry (stale-reconciler G24):
 * activeRunEntries() applies the full liveness filter itself (terminal
 * status, dead async PID, >30-min-stale non-async manifests, symlink
 * safety), so an entry found here means some live session/runner claims the
 * run RIGHT NOW. Inlined via the registry store instead of importing
 * stale-reconciler (its reaping graph must not enter the watchdog's import
 * closure); the async-PID half of hasLiveRunClaim is deliberately omitted —
 * async runs never reach this verdict path (isLikelyOrphanedActiveRun
 * excludes them). Fail-open: any registry error ⇒ no claim — a broken
 * registry must never shield a genuinely hung run (G24 contract).
 */
function consultActiveRunRegistry(runId: string): LiveRunClaim | undefined {
	try {
		const entry = activeRunEntries().find((item) => item.runId === runId);
		if (!entry) return undefined;
		const claimedAtMs = entry.updatedAt ? Date.parse(entry.updatedAt) : Number.NaN;
		return { claimedAtMs: Number.isFinite(claimedAtMs) ? claimedAtMs : undefined };
	} catch {
		return undefined;
	}
}

let liveClaimConsult: (runId: string) => LiveRunClaim | undefined = consultActiveRunRegistry;

/** @internal Test seam — replace the registry claim consult (null = real). */
export function setLiveClaimConsultForTests(consult: ((runId: string) => LiveRunClaim | undefined) | null): void {
	liveClaimConsult = consult ?? consultActiveRunRegistry;
}

/**
 * Wave 13 (F1): does any running/waiting task carry FRESH live evidence?
 * Behavioral mirror of hasRecentActiveEvidence (stale-reconciler.ts): a
 * running/waiting task whose `heartbeat.lastSeenAt` (with `alive !== false`)
 * or `agentProgress.lastActivityAt` is within TASK_HEARTBEAT_EVIDENCE_MS
 * counts. Absent/unreadable tasks (`[]`) ⇒ false — fail-open to the ladder,
 * same as WD-STALE-RECORD.
 */
function hasFreshTaskHeartbeatEvidence(tasks: TeamTaskState[] | undefined, now: number): boolean {
	if (!Array.isArray(tasks)) return false;
	return tasks.some((task) => {
		if (task.status !== "running" && task.status !== "waiting") return false;
		const heartbeatAt = task.heartbeat?.lastSeenAt ? new Date(task.heartbeat.lastSeenAt).getTime() : Number.NaN;
		if (task.heartbeat?.alive !== false && Number.isFinite(heartbeatAt) && now - heartbeatAt <= TASK_HEARTBEAT_EVIDENCE_MS) return true;
		const activityAt = task.agentProgress?.lastActivityAt ? new Date(task.agentProgress.lastActivityAt).getTime() : Number.NaN;
		return Number.isFinite(activityAt) && now - activityAt <= TASK_HEARTBEAT_EVIDENCE_MS;
	});
}

/**
 * Wave 13 (F1): newest liveness-evidence timestamp (epoch ms) among the
 * claim assertion time and the running/waiting tasks' heartbeat/activity
 * marks — everything EXCEPT manifest.updatedAt, which is the frozen
 * artifact under judgment, not evidence (the registry's own filter already
 * bounds it at 30 min for entry presence; counting it here would make the
 * CLAIMED_RUN_HUNG_MS ceiling unreachable). undefined when no signal
 * carries a finite timestamp.
 */
function newestClaimEvidenceMs(tasks: TeamTaskState[] | undefined, claim: LiveRunClaim): number | undefined {
	let newest: number | undefined;
	const consider = (ms: number): void => {
		if (Number.isFinite(ms) && (newest === undefined || ms > newest)) newest = ms;
	};
	if (claim.claimedAtMs !== undefined) consider(claim.claimedAtMs);
	for (const task of tasks ?? []) {
		if (task.status !== "running" && task.status !== "waiting") continue;
		const heartbeatAt = task.heartbeat?.lastSeenAt ? new Date(task.heartbeat.lastSeenAt).getTime() : Number.NaN;
		consider(heartbeatAt);
		const activityAt = task.agentProgress?.lastActivityAt ? new Date(task.agentProgress.lastActivityAt).getTime() : Number.NaN;
		consider(activityAt);
	}
	return newest;
}

/** Wave 13 (F1): hung-verdict liveness short-circuit result. */
interface LivenessShortCircuit {
	/** True ⇒ the hung verdict is withheld this cycle (live evidence present). */
	suppress: boolean;
	/** Debug-log reason (PI_CREW_DEBUG-gated). */
	reason: string;
	/** Claim present but its evidence aged past CLAIMED_RUN_HUNG_MS — the alert detail must name it. */
	claimExhausted: boolean;
}

/**
 * Wave 13 (F1, GAP-0): should the hung verdict for this cycle be withheld?
 * Two INDEPENDENT OR branches (never require both):
 *   (b) a fresh task heartbeat (≤5 min) ⇒ suppress outright;
 *   (a) a live registry claim ⇒ suppress while the newest liveness evidence
 *       is ≤ CLAIMED_RUN_HUNG_MS old; past the ceiling the ladder proceeds
 *       (claimExhausted ⇒ the alert names the claimed-run threshold).
 * No claim and no fresh heartbeat ⇒ the existing 2-min ladder is unchanged
 * (an unclaimed zombie still alerts fast).
 */
function assessClaimedRunLiveness(runId: string, tasks: TeamTaskState[] | undefined, now: number): LivenessShortCircuit {
	if (hasFreshTaskHeartbeatEvidence(tasks, now)) {
		return { suppress: true, reason: "fresh task heartbeat", claimExhausted: false };
	}
	const claim = liveClaimConsult(runId);
	if (claim) {
		const evidenceMs = newestClaimEvidenceMs(tasks, claim);
		const evidenceAgeMs = evidenceMs !== undefined ? now - evidenceMs : undefined;
		if (evidenceAgeMs !== undefined && evidenceAgeMs <= CLAIMED_RUN_HUNG_MS) {
			return {
				suppress: true,
				reason: `live registry claim (newest evidence ${Math.max(0, Math.round(evidenceAgeMs / 1000))}s old)`,
				claimExhausted: false,
			};
		}
		return { suppress: false, reason: "claim evidence older than CLAIMED_RUN_HUNG_MS", claimExhausted: true };
	}
	return { suppress: false, reason: "no live claim", claimExhausted: false };
}

/**
 * Pre-emit state re-verify loader. Injectable for tests to simulate the run
 * going terminal between the cycle's initial read and the emit point.
 */
type ReverifyLoader = typeof loadRunManifestById;
let reverifyLoader: ReverifyLoader = loadRunManifestById;

/**
 * WD-DELIVER-GUARD (2026-10-23) — the residual the emit-time gate cannot see.
 *
 * Real incident (run team_20261023050900): the alert was EMITTED while the run
 * was still running (so emit-time re-verify was correct), then
 * `pi.sendUserMessage(..., {deliverAs:"followUp"})` pushed it into the host's
 * follow-up queue while the session was streaming (`agent-session.js`:
 * `if (this.isStreaming) this.agent.followUp(appMessage)`) and the host
 * DELIVERED it 28 minutes later — after `run.completed` had landed. The user
 * still saw "appears hung" for a finished run. `clearQueue()` is all-or-
 * nothing, so a queued item cannot be retracted: the only fix is to not hand
 * it over until delivery is imminent.
 *
 * Mechanism: while the session is streaming, the alert stays in OUR pending
 * map; at the idle boundary (the moment the host delivers immediately) the run
 * state is re-read one final time. Run terminal (completed/failed/cancelled/
 * blocked) or all tasks terminal ⇒ DROP (debug-logged once per runId, no
 * user-facing noise). FAIL-OPEN: an unreadable/absent record still delivers —
 * a broken state file must never swallow a genuine hung alert.
 *
 * BOTH exits re-verify: the idle boundary AND the delivery cap. A session that
 * never idles (one tool call blocking past the cap) is not a license to hand
 * over a stale alert — the cap exit runs the same classify/verify, so an
 * unverified delivery is impossible. "Late beats never" only applies to alerts
 * whose run still reads as hung.
 */
const DEFAULT_DELIVER_RETRY_MS = 500;
const DEFAULT_DELIVER_CAP_MS = 10 * 60_000; // 10 min
/** Defensive bound — a burst of distinct hung runs must not grow the map. */
const HUNG_DELIVERY_CAP = 256;

interface PendingHungDelivery {
	/** Full alert text, handed over verbatim at the idle boundary. */
	text: string;
	/** Past this instant the alert is handed over anyway (late beats never). */
	deadline: number;
	/** Idle probe captured at queue time (see WatchdogOptions.isSessionIdle). */
	isSessionIdle?: () => boolean | undefined;
	timer?: ReturnType<typeof setTimeout>;
}

/** Hung alerts queued but not yet handed to the host, keyed by runId. */
const pendingHungDeliveries = new Map<string, PendingHungDelivery>();

let deliverRetryMs = DEFAULT_DELIVER_RETRY_MS;
let deliverCapMs = DEFAULT_DELIVER_CAP_MS;
/** Delivery-time state loader (separate seam from the emit-time re-verify). */
let deliveryLoader: ReverifyLoader = loadRunManifestById;

/** @internal Test seam — reset module-level hung-alert dedup + delivery state. */
export function resetHungAlertDedupForTests(): void {
	hungAlertRecords.clear();
	for (const entry of pendingHungDeliveries.values()) {
		if (entry.timer !== undefined) clearTimeout(entry.timer);
	}
	pendingHungDeliveries.clear();
	reverifyLoader = loadRunManifestById;
	deliveryLoader = loadRunManifestById;
	deliverRetryMs = DEFAULT_DELIVER_RETRY_MS;
	deliverCapMs = DEFAULT_DELIVER_CAP_MS;
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

/** @internal Test seam — replace the DELIVERY-time state loader (null = real). */
export function setDeliveryLoaderForTests(loader: ReverifyLoader | null): void {
	deliveryLoader = loader ?? loadRunManifestById;
}

/** @internal Test seam — shrink the idle-gate retry/cap timings. */
export function setDeliveryTimingForTests(retryMs?: number, capMs?: number): void {
	deliverRetryMs = typeof retryMs === "number" && retryMs > 0 ? retryMs : DEFAULT_DELIVER_RETRY_MS;
	deliverCapMs = typeof capMs === "number" && capMs > 0 ? capMs : DEFAULT_DELIVER_CAP_MS;
}

/** @internal Test seam — hung alerts queued but not yet handed to the host. */
export function hungAlertDeliveryPendingForTests(): number {
	return pendingHungDeliveries.size;
}

/**
 * Delivery-time verdict for a queued hung alert. `hung` = hand it to the host;
 * `dropped` = the run is provably no longer hung, stay silent.
 */
type DeliveryVerdict = { kind: "hung" } | { kind: "dropped"; reason: string };

/**
 * Read the run state at handoff time. This is the WD-DELIVER-GUARD decision
 * point: it runs immediately before `pi.sendUserMessage`, i.e. at the moment
 * the host will actually deliver the message (session idle).
 *
 * Drop conditions (the exact user-visible pain):
 *   • manifest status terminal (completed/failed/cancelled/blocked), or
 *   • manifest still active BUT every task is terminal (stale record — the
 *     finalize/worker write is merely behind).
 * FAIL-OPEN: a loader that throws, or a vanished manifest, yields `hung` — an
 * unreadable record must never swallow a genuine alert.
 */
function classifyAtDelivery(cwd: string, runId: string): DeliveryVerdict {
	let loaded: Awaited<ReturnType<ReverifyLoader>>;
	try {
		loaded = deliveryLoader(cwd, runId);
	} catch {
		return { kind: "hung" }; // unreadable state → fail-open
	}
	if (!loaded) return { kind: "hung" }; // indeterminate → fail-open
	if (!isActiveRunStatus(loaded.manifest.status)) {
		return { kind: "dropped", reason: `status=${loaded.manifest.status}` };
	}
	if (areAllTasksTerminal(loaded.tasks)) {
		return { kind: "dropped", reason: `all ${loaded.tasks.length} task(s) terminal (manifest ${loaded.manifest.status})` };
	}
	return { kind: "hung" };
}

/** True when the host would deliver a followUp message right now. */
function sessionLooksIdle(probe: (() => boolean | undefined) | undefined): boolean {
	if (typeof probe !== "function") return true; // no capability → pre-guard behavior
	try {
		return probe() !== false;
	} catch {
		return true;
	}
}

/**
 * Try to hand one pending hung alert to the host. Re-arms itself while the
 * session is streaming (the host would queue instead of deliver) and, at the
 * idle boundary or past the cap, re-reads the run state ONCE and either drops
 * or delivers.
 */
function attemptHungAlertDelivery(pi: ExtensionAPI, cwd: string, runId: string, force: boolean): void {
	const entry = pendingHungDeliveries.get(runId);
	if (!entry) return;
	if (entry.timer !== undefined) {
		clearTimeout(entry.timer);
		entry.timer = undefined;
	}
	if (!force && !sessionLooksIdle(entry.isSessionIdle) && Date.now() < entry.deadline) {
		const timer = setTimeout(() => attemptHungAlertDelivery(pi, cwd, runId, false), deliverRetryMs);
		timer.unref();
		entry.timer = timer;
		return;
	}

	// Fallthrough covers BOTH exits: the idle boundary and the cap expiry
	// (`Date.now() >= entry.deadline`, session still streaming), plus any forced
	// flush from the map cap. No exit skips the re-verify — an alert that got
	// old is not evidence the run is still hung, so the same drop conditions
	// apply here and the debug log names the reason it was dropped.
	const verdict = classifyAtDelivery(cwd, runId);
	pendingHungDeliveries.delete(runId);
	if (verdict.kind === "dropped") {
		if (!hungAlertRecords.get(runId)?.droppedAtDeliveryLogged) {
			updateHungAlertRecord(runId, { droppedAtDeliveryLogged: true });
			debugLog(`[foreground-watchdog] drop hung alert for ${runId} at delivery: run is no longer hung (${verdict.reason})`);
		}
		return;
	}
	try {
		pi.sendUserMessage(entry.text, { deliverAs: "followUp" });
	} catch {
		/* non-critical */
	}
}

/**
 * Queue a hung alert for guarded delivery (WD-DELIVER-GUARD). One in flight
 * per runId — a second notice for the same run while the first is still
 * pending is dropped as redundant drip.
 */
function queueHungAlertDelivery(
	pi: ExtensionAPI,
	cwd: string,
	runId: string,
	text: string,
	isSessionIdle: (() => boolean | undefined) | undefined,
): void {
	if (pendingHungDeliveries.has(runId)) {
		debugLog(`[foreground-watchdog] hung alert for ${runId} already pending delivery — not stacking another`);
		return;
	}
	pendingHungDeliveries.set(runId, { text, deadline: Date.now() + deliverCapMs, isSessionIdle });
	if (pendingHungDeliveries.size > HUNG_DELIVERY_CAP) {
		// Defensive: never let the map grow and never delay a real alert —
		// flush the oldest pending alert immediately (verify-then-send).
		const oldest = pendingHungDeliveries.keys().next().value;
		if (oldest !== undefined) attemptHungAlertDelivery(pi, cwd, oldest, true);
	}
	attemptHungAlertDelivery(pi, cwd, runId, false);
}

/** Drop a still-pending (not yet handed-over) hung alert for a runId. */
function cancelPendingHungDelivery(runId: string): void {
	const entry = pendingHungDeliveries.get(runId);
	if (!entry) return;
	if (entry.timer !== undefined) clearTimeout(entry.timer);
	pendingHungDeliveries.delete(runId);
}

/** Stop a specific watchdog by runId. */
export function stopWatchdog(runId: string): void {
	const timer = activeWatchdogs.get(runId);
	if (timer) {
		clearTimeout(timer);
		activeWatchdogs.delete(runId);
	}
	cancelPendingHungDelivery(runId);
}

/** @internal Stop all active watchdogs. Called on session shutdown (RC-01). */
export function stopAllWatchdogs(): void {
	for (const [runId, timer] of activeWatchdogs) {
		clearTimeout(timer);
	}
	activeWatchdogs.clear();
	for (const entry of pendingHungDeliveries.values()) {
		if (entry.timer !== undefined) clearTimeout(entry.timer);
	}
	pendingHungDeliveries.clear();
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
					// Wave 13 (F1, GAP-0): liveness short-circuit BEFORE any hung alert.
					// The verdict above is structurally blind while a tool executes; a
					// live registry claim or fresh task heartbeat withholds it. A
					// suppressed cycle means the run left the hung state — reset the
					// no-progress counter so a later genuine alert gets the full drip cap.
					const liveness = assessClaimedRunLiveness(runId, reverified.tasks, now);
					if (liveness.suppress) {
						consecutiveHungNotices = 0;
						debugLog(`[foreground-watchdog] suppress hung verdict for ${runId}: ${liveness.reason}`);
					} else {
						// Wave 13 (F3, GAP-2): the detail carries its EVIDENCE time (the
						// manifest read the verdict was based on) — "as of <ISO>" — not the
						// emit time, so a user re-checking can tell a stale/queued alert
						// apart from one about the last few minutes. An exhausted claim
						// names the claimed-run threshold so the user knows it is not the
						// 2-min ladder.
						const claimNote = liveness.claimExhausted
							? `, claimed-run hung threshold exceeded (no live evidence for >${Math.round(CLAIMED_RUN_HUNG_MS / 60_000)} min)`
							: "";
						const detail = `status=${manifest.status}, updatedAt=${manifest.updatedAt}, agents=${agents.length}, as of ${manifest.updatedAt}${claimNote}`;
						consecutiveHungNotices += 1;
						try {
							if (consecutiveHungNotices <= HUNG_NOTICE_CAP) {
								// WD-DEDUP: alert-once per runId at module scope — even a
								// fresh watchdog instance must not re-alert the same run.
								if (!hungAlertAlreadySent(runId)) {
									// Mark BEFORE queueing so a racing cycle cannot double-queue.
									updateHungAlertRecord(runId, { alerted: true });
									// WD-DELIVER-GUARD: the host queues a followUp while the
									// session streams and delivers it arbitrarily later — so
									// hand it over only at the idle boundary, re-verifying the
									// run state at THAT moment.
									queueHungAlertDelivery(
										pi,
										cwd,
										runId,
										`pi-crew watchdog: run ${runId} appears hung (${detail}). Consider running team action='cancel' runId='${runId}' or team action='doctor'.`,
										opts.isSessionIdle,
									);
								}
							} else if (consecutiveHungNotices === HUNG_NOTICE_CAP + 1) {
								// One-time handoff, then silence — still monitoring, no more drips.
								queueHungAlertDelivery(
									pi,
									cwd,
									runId,
									`pi-crew watchdog: run ${runId} is still hung after ${consecutiveHungNotices} checks — going quiet now. Intervene via team action='cancel' runId='${runId}', team action='doctor', or leave it; a completion notice will still fire.`,
									opts.isSessionIdle,
								);
							}
						} catch {
							/* non-critical */
						}
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
