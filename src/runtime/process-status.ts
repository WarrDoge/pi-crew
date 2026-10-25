import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import type { CrewAgentRecord } from "./crew-agent-runtime.ts";

export { hasAsyncStartMarker } from "./async-marker.ts";

export interface ProcessLiveness {
	pid?: number;
	alive: boolean;
	detail: string;
}

/**
 * How long (ms) a foreground team run with status "running" but no active agents
 * survives before being flagged as orphaned. Reduced from 10min to 2min to
 * improve UX: stuck foreground runs (e.g. planner with 0 tool calls) no longer
 * linger for 10min before the dashboard shows them as stale.
 */
const ORPHANED_ACTIVE_RUN_MS = 2 * 60 * 1000;
/** How long a completed run stays visible in the widget after completion. */
const COMPLETED_VISIBILITY_GRACE_MS = 8_000;
/** Errors (failed/cancelled) linger far longer so a failed run leaves a visible
 * trace in the crew widget for ~10 min (F-5). Successful completions vanish
 * quickly to keep the widget quiet. */
const ERROR_VISIBILITY_GRACE_MS = 10 * 60 * 1000;
/** Maximum age (ms) for an active run before it's considered stale.
 * After this time, PID-only liveness is unreliable due to PID recycling. */
const STALE_ACTIVE_RUN_MS = 30 * 60 * 1000;
/** Window (ms) during which an active run whose agents are all
 * completed/queued-without-evidence still counts as display-active: the
 * runner just wrote the manifest (task transition) and the next worker has
 * not recorded progress yet. Without this the dock flickers off between
 * phases of a healthy run. */
const SPAWN_GAP_VISIBILITY_MS = 60 * 1000;

export function checkProcessLiveness(pid: number | undefined): ProcessLiveness {
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
		return { pid, alive: false, detail: "no pid recorded" };
	}
	try {
		process.kill(pid, 0);
		return { pid, alive: true, detail: "process is alive" };
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code === "EPERM")
			return {
				pid,
				alive: true,
				detail: "process exists but permission is denied",
			};
		if (nodeError.code === "ESRCH") return { pid, alive: false, detail: "process does not exist" };
		const message = error instanceof Error ? error.message : String(error);
		return { pid, alive: false, detail: message };
	}
}

export function isActiveRunStatus(status: string): boolean {
	return status === "queued" || status === "planning" || status === "running" || status === "waiting";
}

export function isFinishedRunStatus(status: string): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "blocked";
}

/**
 * R48-N2 (2026-10-19): window (ms) within which an agent's last recorded
 * activity timestamp still proves its host process is alive. Mirrors the
 * health-monitor's STUCK_TASK_THRESHOLD_MS (5 min).
 */
const AGENT_ACTIVITY_LIVENESS_MS = 5 * 60 * 1000;

/** Agent statuses that are terminal — never count as liveness evidence. */
const TERMINAL_AGENT_STATUSES = new Set<CrewAgentRecord["status"]>(["completed", "failed", "cancelled", "stopped"]);

/** Latest recorded agent activity timestamp (ms epoch), or NaN when none. */
function agentLatestActivityAt(agent: CrewAgentRecord): number {
	const raw = agent.progress?.lastActivityAt;
	if (!raw) return Number.NaN;
	const parsed = new Date(raw).getTime();
	return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * R48-N2: does this agent provide RECENT durable activity evidence that its
 * host process is still alive? A frozen `running` agent that never wrote
 * progress (the zombie-sync blind spot) returns false. Terminal agents are
 * never evidence. Deliberately NOT based on `run.summary` — the legacy
 * magic-summary gate is gone.
 */
export function hasRecentAgentActivityEvidence(agent: CrewAgentRecord, now = Date.now(), livenessMs = AGENT_ACTIVITY_LIVENESS_MS): boolean {
	if (TERMINAL_AGENT_STATUSES.has(agent.status)) return false;
	const at = agentLatestActivityAt(agent);
	return Number.isFinite(at) && now - at < livenessMs;
}

/**
 * Wave 15 (F1, GAP-0): does any running/waiting task carry FRESH live
 * evidence — a `heartbeat.lastSeenAt` (with `alive !== false`) or the
 * `agentProgress.lastActivityAt` fallback — within `ttlMs`? Behavioral
 * mirror of the watchdog's private helper (foreground-watchdog.ts) and
 * hasRecentActiveEvidence (stale-reconciler.ts), so watchdog, reconciler
 * and display stop growing a third divergent private copy. PURE (GAP-4:
 * the shared display predicates keep their signatures — call sites that
 * already hold the tasks OR this in). Default TTL 5 min keeps the constant
 * family aligned (AGENT_ACTIVITY_LIVENESS_MS = TASK_HEARTBEAT_EVIDENCE_MS
 * = ACTIVE_EVIDENCE_TTL_MS). Undefined/empty/all-terminal ⇒ false.
 */
export function hasFreshTaskHeartbeatEvidence(
	tasks: TeamTaskState[] | undefined,
	now = Date.now(),
	ttlMs = AGENT_ACTIVITY_LIVENESS_MS,
): boolean {
	if (!Array.isArray(tasks)) return false;
	return tasks.some((task) => {
		if (task.status !== "running" && task.status !== "waiting") return false;
		const heartbeatAt = task.heartbeat?.lastSeenAt ? new Date(task.heartbeat.lastSeenAt).getTime() : Number.NaN;
		if (task.heartbeat?.alive !== false && Number.isFinite(heartbeatAt) && now - heartbeatAt <= ttlMs) return true;
		const activityAt = task.agentProgress?.lastActivityAt ? new Date(task.agentProgress.lastActivityAt).getTime() : Number.NaN;
		return Number.isFinite(activityAt) && now - activityAt <= ttlMs;
	});
}

export function isLikelyOrphanedActiveRun(
	run: TeamRunManifest,
	agents: CrewAgentRecord[] = [],
	now = Date.now(),
	staleMs = ORPHANED_ACTIVE_RUN_MS,
): boolean {
	if (!isActiveRunStatus(run.status)) return false;
	if (run.async?.pid !== undefined) return false;
	const updatedAt = new Date(run.updatedAt).getTime();
	if (!Number.isFinite(updatedAt)) return false;

	// R48-N2: structural orphan test. A run whose manifest has not been updated
	// within `staleMs` is orphaned UNLESS some agent still reports recent durable
	// activity evidence — which proves the executing host is alive. This replaces
	// the legacy magic-string summary gate plus the all-queued-only check, both of
	// which were structurally blind:
	//   * a FROZEN `running` agent (never queued) defeated both branches, and
	//   * any 0-agent stale run whose summary happened not to match was ignored.
	// The `summary` field is now irrelevant — the decision is purely structural.
	if (now - updatedAt >= staleMs) {
		const livenessMs = Math.max(staleMs, AGENT_ACTIVITY_LIVENESS_MS);
		return !agents.some((agent) => hasRecentAgentActivityEvidence(agent, now, livenessMs));
	}

	return false;
}

function hasDurableActiveAgentEvidence(agent: CrewAgentRecord): boolean {
	if (agent.status === "running") {
		// Running agents are actively executing — trust them.
		// Activity evidence is only required for queued agents (zombie prevention).
		return true;
	}
	if (agent.status === "queued") {
		// Queued agents need actual activity evidence to distinguish from zombies:
		// spawned-but-never-executed agents should not appear as active.
		return Boolean(
			(agent.progress && (agent.progress.toolCount > 0 || agent.progress.recentOutput.length > 0)) ||
				(agent.jsonEvents && agent.jsonEvents > 0) ||
				(agent.toolUses && agent.toolUses > 0),
		);
	}
	return false;
}

export function hasStaleAsyncProcess(run: TeamRunManifest, now = Date.now()): boolean {
	if (!isActiveRunStatus(run.status) || !run.async) return false;
	const pidAlive = checkProcessLiveness(run.async.pid).alive;
	if (!pidAlive) return true;
	// PID is alive, but check if the run is suspiciously old.
	// PID recycling means a stale PID could point to an unrelated process.
	const updatedAt = new Date(run.updatedAt).getTime();
	const age = now - updatedAt;
	if (Number.isFinite(updatedAt) && age > STALE_ACTIVE_RUN_MS) {
		// Additional evidence: if no agent has recent activity, treat as stale.
		// The real process would have updated the manifest within 30 minutes.
		return true;
	}
	return false;
}

export function isDisplayActiveRun(run: TeamRunManifest, agents: CrewAgentRecord[] = [], now = Date.now()): boolean {
	if (hasStaleAsyncProcess(run, now) || isLikelyOrphanedActiveRun(run, agents, now)) return false;
	// Hard filter: if an active-status run hasn't been updated in > STALE_ACTIVE_RUN_MS
	// and has no async PID tracking, it's a ghost from a crashed process.
	if (isActiveRunStatus(run.status) && !run.async) {
		const updatedAt = new Date(run.updatedAt).getTime();
		if (Number.isFinite(updatedAt) && now - updatedAt > STALE_ACTIVE_RUN_MS) return false;
	}
	// Grace period: show completed runs for a few seconds so users see the result.
	// R5-4 (DR-02 wave 2): "blocked" is terminal (isFinishedRunStatus) but NOT an
	// error the user caused — without the grace branch it fell through to
	// `!isActiveRunStatus` and vanished from the widget instantly while "failed"
	// lingered 10min. Blocked now gets the same ERROR_VISIBILITY_GRACE_MS so the
	// block reason stays inspectable.
	if (run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "blocked") {
		const grace = run.status === "completed" ? COMPLETED_VISIBILITY_GRACE_MS : ERROR_VISIBILITY_GRACE_MS;
		const lastAgentActivity = agents.reduce<number>((max, agent) => {
			const ts = agent.completedAt ?? agent.startedAt;
			const parsed = ts ? new Date(ts).getTime() : 0;
			return Number.isFinite(parsed) && parsed > max ? parsed : max;
		}, new Date(run.updatedAt).getTime());
		if (Number.isFinite(lastAgentActivity) && now - lastAgentActivity < grace) return true;
		return false;
	}
	if (!isActiveRunStatus(run.status)) return false;
	// Keep the always-visible widget quiet until a worker actually exists.
	// Empty active manifests can be created briefly at startup, by old fixture/scaffold
	// runs, or from cross-cwd registry history; showing them causes noisy 0/0 rows and
	// needless spinner redraws. The full dashboard can still list historical runs.
	if (agents.length === 0) return false;
	if (agents.some(hasDurableActiveAgentEvidence)) return true;
	// Spawn gap between phases: an active run whose manifest was JUST written
	// and whose next agents are queued/waiting without evidence yet stays
	// visible — the runner is alive and about to spawn them. Stale manifests
	// (zombies) fall through and stay hidden.
	if (agents.some((agent) => agent.status === "queued" || agent.status === "waiting")) {
		const updatedAt = new Date(run.updatedAt).getTime();
		if (Number.isFinite(updatedAt) && now - updatedAt < SPAWN_GAP_VISIBILITY_MS) return true;
	}
	return false;
}
