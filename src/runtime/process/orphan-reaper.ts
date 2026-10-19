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
 * worker of a run whose reconcile verdict was already "stale", AND (b) confirmed
 * by the AUTHORITATIVE zombie signal — `PI_CREW_KIND=subagent` with a DEAD
 * `PI_CREW_PARENT_PID` (i.e. its host is gone). A worker whose parent is still
 * alive is never a candidate, so a healthy in-flight worker cannot be killed by
 * accident. All IO is injectable for unit testing (no real kills in tests).
 */

import type { TeamTaskState } from "../../state/types.ts";
import { checkProcessLiveness } from "../process-status.ts";
import { scanZombieSubagents } from "./zombie-scanner.ts";

/** A recorded worker process for a run task (from heartbeat.pid / checkpoint.childPid). */
export interface WorkerPidEvidence {
	taskId: string;
	pid: number;
}

export interface ReapOrphanOptions {
	/** Liveness probe (default: process.kill(pid, 0)). */
	isAlive?: (pid: number) => boolean;
	/** Signal sender (default: process.kill). Injected in tests. */
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	/** Signal to send first (default SIGTERM — graceful). */
	signal?: NodeJS.Signals;
	/** Pids that must never be touched (self/ancestors). */
	protectedPids?: ReadonlySet<number>;
	/** When set, ONLY reap these pids (the authoritative orphan-zombie set). */
	allowedPids?: ReadonlySet<number>;
	/** Report candidates without killing (used by doctor/dry-run). */
	dryRun?: boolean;
}

export interface ReapOrphanResult {
	reaped: number[];
	skipped: { pid: number; reason: string }[];
	/** Every distinct pid considered. */
	candidates: number[];
}

/**
 * Collect the recorded worker pids of a run's in-flight tasks. A `running` or
 * `waiting` task that recorded its child pid (heartbeat or checkpoint) is the
 * evidence we reap against. Deduped by pid.
 */
export function collectWorkerPidEvidence(tasks: TeamTaskState[]): WorkerPidEvidence[] {
	const seen = new Set<number>();
	const evidence: WorkerPidEvidence[] = [];
	for (const task of tasks) {
		if (task.status !== "running" && task.status !== "waiting") continue;
		const pid = task.heartbeat?.pid ?? task.checkpoint?.childPid;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) continue;
		if (seen.has(pid)) continue;
		seen.add(pid);
		evidence.push({ taskId: task.id, pid });
	}
	return evidence;
}

/**
 * Reap orphaned worker processes. Conservative by construction:
 *   * invalid / pid<=1 → skipped,
 *   * protected (self/ancestors) → skipped,
 *   * not alive → skipped (nothing to reap),
 *   * `allowedPids` set → any pid outside it is skipped (authoritative gate),
 *   * otherwise SIGTERM.
 */
export function reapOrphanWorkers(evidences: WorkerPidEvidence[], opts: ReapOrphanOptions = {}): ReapOrphanResult {
	const isAlive = opts.isAlive ?? ((pid: number) => checkProcessLiveness(pid).alive);
	const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
	const protectedPids = opts.protectedPids ?? new Set<number>([process.pid, process.ppid]);
	const signal = opts.signal ?? "SIGTERM";
	const reaped: number[] = [];
	const skipped: { pid: number; reason: string }[] = [];
	const candidates: number[] = [];
	const seen = new Set<number>();

	for (const { pid } of evidences) {
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
		if (opts.allowedPids && !opts.allowedPids.has(pid)) {
			skipped.push({ pid, reason: "not-an-authoritative-orphan" });
			continue;
		}
		if (!isAlive(pid)) {
			skipped.push({ pid, reason: "already-dead" });
			continue;
		}
		if (opts.dryRun) {
			skipped.push({ pid, reason: "dry-run" });
			continue;
		}
		try {
			kill(pid, signal);
			reaped.push(pid);
		} catch (error) {
			skipped.push({ pid, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { reaped, skipped, candidates };
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
 */
export function reapRecordedWorkerOrphans(tasks: TeamTaskState[], opts: ReapOrphanOptions = {}): ReapOrphanResult {
	const evidence = collectWorkerPidEvidence(tasks);
	if (evidence.length === 0) return { reaped: [], skipped: [], candidates: [] };
	let zombiePids: Set<number>;
	try {
		zombiePids = new Set(scanZombieSubagents().zombies.map((zombie) => zombie.pid));
	} catch {
		return { reaped: [], skipped: evidence.map((item) => ({ pid: item.pid, reason: "zombie-scan-unavailable" })), candidates: [] };
	}
	return reapOrphanWorkers(evidence, { ...opts, allowedPids: zombiePids });
}
