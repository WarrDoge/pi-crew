/**
 * orphan-reaper.ts — R39-M3 (fix-wave 6, EP3): reclaim orphaned pi-crew worker
 * processes.
 *
 * Root cause: when the host pi process is SIGKILLed mid-run, the spawned worker
 * is re-parented to PID 1 and keeps running with NO automatic reaper. The stale
 * reconciler repairs run *state* (cancels tasks) but never touches the recorded
 * worker process, and `cleanupOrphanWorkers` (session-start only) only knows
 * about *registered* workers — a reparented orphan is never in the registry.
 *
 * Safety model (mirrors zombie-scanner.ts): this module NEVER kills on a bare
 * pid-liveness guess. A pid is reaped only when it is (a) recorded as the
 * worker of a run whose reconcile verdict was already "stale", AND (b) either
 * confirmed by the AUTHORITATIVE zombie signal — `PI_CREW_KIND=subagent` with a
 * DEAD `PI_CREW_PARENT_PID` — or IDENTITY-PROVEN (wave 11a: the recorded
 * starttime matches the live /proc value, so we know it is the exact process we
 * spawned, PID reuse excluded). A worker whose parent is still alive and whose
 * identity we cannot prove is never a candidate, so a healthy in-flight worker
 * cannot be killed by accident. All IO is injectable for unit testing (no real
 * kills in tests).
 *
 * Wave 11a (F2) changes, in one place each:
 *   - evidence carries the persisted pgid/starttime/uid (GAP-3 fix feeds it),
 *   - a known pgid routes through reap-group.ts (guarded ladder, SIGTERM →
 *     SIGKILL escalation) instead of a single fire-and-forget pid SIGTERM,
 *   - the `scanZombieSubagents()` gate is FAIL-OPEN: a scan throw no longer
 *     disables reaping wholesale — identity-proven candidates still reap,
 *   - `PI_CREW_REAP_GROUP=0` degrades every path to the pre-wave pid-only kill.
 */

import type { TeamTaskState } from "../../state/types.ts";
import { checkProcessLiveness } from "../process-status.ts";
import { type ProcIdentity, readProcIdentity, reapGroup, resolveReapGroupEnabled } from "./reap-group.ts";
import { scanZombieSubagents } from "./zombie-scanner.ts";

/**
 * A recorded worker process for a run task (from heartbeat.pid /
 * checkpoint.childPid) plus, when the record carries it, the spawn-time
 * identity that makes the pid reuse-proof.
 */
export interface WorkerPidEvidence {
	taskId: string;
	pid: number;
	/** Process-group id recorded at spawn (heartbeat.pgid / checkpoint.childPgid). */
	pgid?: number;
	/** `/proc/<pid>/stat` field 22 at spawn — survives PID reuse. */
	starttime?: string;
	/** uid at spawn — a group we may not signal is refused. */
	uid?: number;
}

export interface ReapOrphanOptions {
	/** Liveness probe (default: process.kill(pid, 0)). */
	isAlive?: (pid: number) => boolean;
	/** Signal sender (default: process.kill). Injected in tests. */
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	/** Group signal sender for the reap-group path (default: process.kill(-pgid, sig)). */
	killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
	/**
	 * Group liveness probe for the reap-group path (default: `process.kill(-pgid, 0)`).
	 * Test seam: without it a unit test would have to pick a pgid that must not
	 * exist in the host's process table before it could observe the refusal path.
	 */
	groupAlive?: (pgid: number) => boolean;
	/** Signal to send first (default SIGTERM — graceful). */
	signal?: NodeJS.Signals;
	/** Pids that must never be touched (self/ancestors). */
	protectedPids?: ReadonlySet<number>;
	/** When set, ONLY reap these pids (the authoritative orphan-zombie set). */
	allowedPids?: ReadonlySet<number>;
	/** Report candidates without killing (used by doctor/dry-run). */
	dryRun?: boolean;
	/** Grace window between SIGTERM and SIGKILL on the group path (ms). */
	gracefulMs?: number;
	/** Hard cap after SIGKILL on the group path (ms). */
	capMs?: number;
	/** Collect the async escalation promises in `pending` (default true). */
	escalate?: boolean;
	/** Let identity-proven pids bypass the `allowedPids` gate (default true). */
	allowIdentityProven?: boolean;
	/**
	 * When set, a pid that is NOT identity-proven is skipped even with no
	 * `allowedPids` gate at all. Used by the fail-open branch below: a scan that
	 * throws must not degrade into "SIGTERM every recorded pid" (a recycled pid
	 * would then be a stranger's process) — only identity-proven candidates pass.
	 */
	requireIdentityProof?: boolean;
	/** Platform override for the reap-group guard ladder (tests). */
	platform?: NodeJS.Platform;
	/** /proc identity reader override (tests). */
	readIdentity?: (pid: number) => ProcIdentity | undefined;
	/** Zombie-scan override (tests force the fail-open path). */
	scanZombies?: () => { zombies: { pid: number }[] };
}

export interface ReapOrphanResult {
	reaped: number[];
	skipped: { pid: number; reason: string }[];
	/** Every distinct pid considered. */
	candidates: number[];
	/**
	 * In-flight group escalations (SIGKILL ladder). The caller that owns the
	 * process lifetime must await these — `stale-reconciler.ts` does — so the
	 * host does not exit before SIGKILL has been delivered.
	 */
	pending: Promise<unknown>[];
}

/**
 * Collect the recorded worker pids of a run's in-flight tasks. A `running` or
 * `waiting` task that recorded its child pid (heartbeat or checkpoint) is the
 * evidence we reap against. Deduped by pid. Optional identity fields are copied
 * verbatim — a legacy record simply yields the pre-wave shape.
 */
export function collectWorkerPidEvidence(tasks: TeamTaskState[]): WorkerPidEvidence[] {
	const seen = new Set<number>();
	const evidence: WorkerPidEvidence[] = [];
	for (const task of tasks) {
		if (task.status !== "running" && task.status !== "waiting") continue;
		const heartbeat = task.heartbeat;
		const checkpoint = task.checkpoint;
		const pid = heartbeat?.pid ?? checkpoint?.childPid;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) continue;
		if (seen.has(pid)) continue;
		seen.add(pid);
		// Wave 11a (F3): the persisted identity, spread only when present so a
		// legacy record keeps its exact pre-wave shape.
		const pgid = heartbeat?.pgid ?? checkpoint?.childPgid;
		const starttime = heartbeat?.starttime ?? checkpoint?.childStartTime;
		const uid = heartbeat?.uid ?? checkpoint?.childUid;
		evidence.push({
			taskId: task.id,
			pid,
			...(pgid !== undefined ? { pgid } : {}),
			...(starttime !== undefined ? { starttime } : {}),
			...(uid !== undefined ? { uid } : {}),
		});
	}
	return evidence;
}

/**
 * Reap orphaned worker processes. Conservative by construction:
 *   * invalid / pid<=1 → skipped,
 *   * protected (self/ancestors) → skipped,
 *   * `allowedPids` set → any pid outside it is skipped UNLESS identity-proven
 *     (wave 11a fail-open: a matching starttime proves it is our process),
 *   * `dryRun` → skipped,
 *   * known pgid + kill switch on → guarded group reap (SIGTERM → escalation),
 *     falling back to the pid-only SIGTERM when the guard ladder refuses,
 *   * otherwise the pre-wave pid-only SIGTERM.
 */
export function reapOrphanWorkers(evidences: WorkerPidEvidence[], opts: ReapOrphanOptions = {}): ReapOrphanResult {
	const readIdentity = opts.readIdentity ?? readProcIdentity;
	const isAlive = opts.isAlive ?? ((pid: number) => checkProcessLiveness(pid).alive);
	const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
	const protectedPids = opts.protectedPids ?? new Set<number>([process.pid, process.ppid]);
	const signal = opts.signal ?? "SIGTERM";
	const escalate = opts.escalate ?? true;
	const allowIdentityProven = opts.allowIdentityProven ?? true;
	const reaped: number[] = [];
	const skipped: { pid: number; reason: string }[] = [];
	const candidates: number[] = [];
	const pending: Promise<unknown>[] = [];
	const seen = new Set<number>();

	for (const evidence of evidences) {
		const { pid } = evidence;
		if (seen.has(pid)) continue;
		seen.add(pid);
		candidates.push(pid);
		if (!Number.isInteger(pid) || pid <= 1) {
			skipped.push({ pid, reason: "invalid-or-init-pid" });
			continue;
		}
		if (protectedPids.has(pid)) {
			skipped.push({ pid, reason: "protected-self-or-ancestor" });
			continue;
		}
		const alive = isAlive(pid);
		// Wave 11a: a recorded starttime that matches the LIVE process (or a pid
		// that is already gone, so nothing can be reused) proves this is the very
		// incarnation we spawned — no zombie-scan confirmation needed.
		const liveIdentity = alive ? readIdentity(pid) : undefined;
		const identityProven =
			allowIdentityProven &&
			evidence.starttime !== undefined &&
			(alive ? liveIdentity?.starttime !== undefined && liveIdentity.starttime === evidence.starttime : true);
		if (opts.allowedPids && !opts.allowedPids.has(pid) && !identityProven) {
			skipped.push({ pid, reason: "not-an-authoritative-orphan" });
			continue;
		}
		if (opts.requireIdentityProof && !identityProven) {
			skipped.push({ pid, reason: "not-an-authoritative-orphan" });
			continue;
		}
		if (opts.dryRun) {
			skipped.push({ pid, reason: "dry-run" });
			continue;
		}
		const pgid = evidence.pgid ?? liveIdentity?.pgid;
		if (pgid !== undefined && Number.isInteger(pgid) && pgid > 1) {
			if (!resolveReapGroupEnabled()) {
				// Kill switch: record it, then fall through to the pid-only path.
				skipped.push({ pid, reason: "group-disabled" });
			} else {
				const expected: ProcIdentity | undefined =
					evidence.starttime !== undefined ? { pid, pgid, starttime: evidence.starttime, uid: evidence.uid } : undefined;
				const groupResult = reapGroup(pgid, pid, {
					...(opts.gracefulMs !== undefined ? { gracefulMs: opts.gracefulMs } : {}),
					...(opts.capMs !== undefined ? { capMs: opts.capMs } : {}),
					...(opts.platform !== undefined ? { platform: opts.platform } : {}),
					readIdentity,
					...(opts.killGroup !== undefined ? { signalGroup: opts.killGroup } : {}),
					...(opts.groupAlive !== undefined ? { groupAlive: opts.groupAlive } : {}),
					...(expected !== undefined ? { expected } : {}),
					name: `orphan-reaper:${pid}`,
				});
				if (groupResult.refusal === undefined) {
					if (escalate) pending.push(groupResult.pending);
					reaped.push(pid);
					continue;
				}
				skipped.push({ pid, reason: `group-refused:${groupResult.refusal}` });
				if (!alive) continue; // nothing left to signal individually
			}
		}
		if (!alive) {
			skipped.push({ pid, reason: "already-dead" });
			continue;
		}
		try {
			kill(pid, signal);
			reaped.push(pid);
		} catch (error) {
			skipped.push({ pid, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { reaped, skipped, candidates, pending };
}

/**
 * R39-M3: reap the recorded worker processes of a stale run, gated on the
 * AUTHORITATIVE orphan signal. `scanZombieSubagents()` classifies a process as a
 * zombie only when it carries `PI_CREW_KIND=subagent` AND its recorded
 * `PI_CREW_PARENT_PID` is dead — i.e. the host is gone and the worker was
 * re-parented (PID 1). Intersecting that set with the run's recorded task pids
 * yields exactly the unreapable orphans, with no false-positive kill risk for a
 * live worker. Linux-only (the scanner needs /proc); on other platforms the
 * scan yields no zombies and this is a no-op. Best-effort: never throws.
 *
 * Wave 11a (F2) FAIL-OPEN: a scanner throw used to disable the whole pass
 * ("zombie-scan-unavailable"). It now only removes the `allowedPids` gate and
 * flips on `requireIdentityProof`, so IDENTITY-PROVEN candidates (recorded
 * starttime === live starttime) are still reaped while unproven ones stay
 * untouched (no blanket "SIGTERM every recorded pid" degrade).
 */
export function reapRecordedWorkerOrphans(tasks: TeamTaskState[], opts: ReapOrphanOptions = {}): ReapOrphanResult {
	const evidence = collectWorkerPidEvidence(tasks);
	if (evidence.length === 0) return { reaped: [], skipped: [], candidates: [], pending: [] };
	const scanZombies = opts.scanZombies ?? scanZombieSubagents;
	let allowedPids: Set<number> | undefined;
	let requireIdentityProof = opts.requireIdentityProof ?? false;
	try {
		allowedPids = new Set(scanZombies().zombies.map((zombie) => zombie.pid));
	} catch {
		// FAIL-OPEN (wave 11a): no authoritative set at all — but NOT a licence to
		// signal every recorded pid. Only identity-proven candidates pass.
		allowedPids = undefined;
		requireIdentityProof = true;
	}
	return reapOrphanWorkers(evidence, { ...opts, allowedPids, requireIdentityProof });
}
