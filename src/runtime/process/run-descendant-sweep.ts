/**
 * run-descendant-sweep.ts — fix-wave 11b (F7): reap the DESCENDANTS of a
 * TERMINAL pi-crew run by matching the pi-crew env markers they inherited.
 *
 * Why this module exists (the incident, SPEC §1): run
 * `team_20261022110510_cefb9164af126460` reached `completed` at 2026-10-22T13:02Z
 * and still had SIX grandchildren alive 24 h later (`dpi-backend` ×5, `caddy`;
 * 399 MB RSS). They carried `PI_CREW_KIND=subagent` and
 * `PI_CREW_PARENT_PID=<dead runner pid>`. No layer of the 11a teardown stack
 * could reach them, and never will: pi's bash tool spawns EVERY command with
 * `detached: true` (GAP-0), so each bash command gets its OWN process group.
 * A group kill rooted at the worker reaches the worker's group only — the bash
 * grandchildren live in a group of their own.
 *
 * The only identity that survives that topology is the ENVIRONMENT: the child
 * inherits the worker's env, so every descendant still carries the pi-crew
 * markers of the run it belongs to. This module therefore turns env markers
 * into kill candidates, scoped to ONE run, and only after that run is terminal.
 *
 * Markers actually used (VERIFIED in src — never invented):
 *   - `PI_CREW_BROKER_RUN_ID` — `child-pi-spawn.ts:382` writes
 *     `built.env.PI_CREW_BROKER_RUN_ID = input.runId` for every team worker
 *     (the env key is spelled by `PI_CREW_RUN_ID_ENV` in
 *     `scratchpad-lifecycle.ts:66`, whose VALUE is the broker name). This is
 *     the strongest marker ⇒ `matchedBy: "run-id"`.
 *     `PI_CREW_RUN_ID` itself is NOT matched: `env-allowlist-registry.ts:322`
 *     classifies it `test-only` ("fixture name; src uses PI_CREW_BROKER_RUN_ID")
 *     and grep confirms no src writer — matching it would only widen the kill
 *     surface onto test fixtures.
 *   - `PI_CREW_KIND=subagent` (`pi-args.ts:564`), `PI_CREW_TASK_ID`
 *     (`child-pi-spawn.ts:434,443`) and `PI_CREW_PARENT_PID`
 *     (`child-pi-spawn.ts:191` = the SPAWNING process pid) ⇒
 *     `matchedBy: "task-id"`.
 *   - `PI_CREW_PARENT_PID` alone, when the recorded parent is already dead ⇒
 *     `matchedBy: "parent-pid"` (the shape the incident's survivors had).
 *
 * Safety model — the sweep is additive, never a wider kill surface:
 *   1. Discovery is Linux `/proc` only; anything else yields `[]` (fail-open).
 *   2. Our own pid and every ancestor of it are never candidates.
 *   3. Same uid only: we can only reason about our own processes.
 *   4. The candidate must have STARTED no earlier than the run (starttime is
 *      converted to wall clock via /proc/uptime; > 60 s of pre-run clock skew
 *      is rejected) — a process that predates the run cannot belong to it.
 *   5. The candidate's group must not be our own group nor our own pid.
 *   6. Every signal goes through `reapGroup()` — the identity-proven ladder in
 *      reap-group.ts — anchored on the candidate pid, never a blind
 *      `kill(-pgid)`. Candidates without a usable pgid are skipped
 *      (`no-pgid`), never signalled individually.
 *   7. EXTRA rung for the sweep: the group's LEADER must either be gone, or be
 *      another matched candidate of this same run. A live, unmatched leader
 *      means the group belongs to a session that is still running ⇒
 *      `leader-alive-unmatched`, nothing signalled.
 *   8. `dryRun` reports and signals nothing; `PI_CREW_REAP_RUN_DESCENDANTS=0`
 *      disables the whole sweep.
 *   9. (11b.1) A RECORDED ancestor (the detached runner pid, a worker pid) is
 *      the tree's ROOT, never its descendant ⇒ it is never a candidate, even
 *      when it is still alive. Only its children/grandchildren are, so a live
 *      recorded pid cannot veto the sweep the way the old all-or-nothing
 *      "every recorded pid is dead" gate did.
 *  10. (11b.3) A recorded SURFACE pane pid (`manifest.surface.workerPids`) is
 *      something the operator may still be watching in a mux pane ⇒ while it is
 *      ALIVE it is never a candidate. It is not excluded unconditionally like a
 *      recorded ancestor: once it is dead there is nothing left to kill, so the
 *      pid simply falls out of /proc (and a recycled pid must still satisfy
 *      every start-time/uid/marker proof above).
 *
 * Escalation: like every other `reapGroup` caller, the SIGKILL rung comes back
 * as a `pending` promise. The caller registers it with the EXISTING drain
 * owners (`trackReapEscalation`/`drainReapEscalations` in stale-reconciler.ts,
 * `flushReapEscalationsSync` in reap-group.ts) — this module deliberately has
 * no drain of its own.
 *
 * Known limits (documented, not fixed here): a descendant that `setsid()`s or
 * runs inside a container/runtime with its own init (docker, systemd-run) is a
 * group we cannot prove and is left alone; and pi's bash tool remains the
 * primary leak source — the upstream fix (a `detached: false`/tracked-children
 * default) is what would make this sweep unnecessary.
 */

import * as fs from "node:fs";
import { getCrewEnvBool } from "../../config/env-vars.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { fieldsAfterComm, PROC_STAT_PPID_INDEX } from "./proc-stat.ts";
import { type ProcIdentity, readProcIdentity, reapGroup } from "./reap-group.ts";

/** Default grace window between SIGTERM and SIGKILL (ms). */
const DEFAULT_GRACEFUL_MS = 2_000;
/** Default hard cap after SIGKILL before giving up (ms). */
const DEFAULT_CAP_MS = 2_000;
/**
 * Allowed clock skew when comparing a candidate's start time against the run
 * start. A process that started MORE than this before the run cannot belong to
 * it; the window absorbs `createdAt` being stamped before the spawn and the
 * coarseness of `/proc/<pid>/stat` starttime ticks.
 */
const PRE_RUN_SKEW_MS = 60_000;
/** Linux `CLK_TCK` — hardcoded like zombie-scanner.ts (100 on every mainstream distro). */
const CLOCK_TICKS_PER_SEC = 100;
/** Bound on the "already signalled this group" registry (see idempotency note). */
const MAX_TRACKED_GROUPS = 256;

/**
 * Kill switch (default ON). `PI_CREW_REAP_RUN_DESCENDANTS=0` makes the sweep a
 * complete no-op without a redeploy — the escape hatch for a platform whose
 * /proc semantics turn out to over-match.
 */
export function resolveRunDescendantSweepEnabled(): boolean {
	return getCrewEnvBool("PI_CREW_REAP_RUN_DESCENDANTS") ?? true;
}

/** One process proven to belong to a terminal run. */
export interface RunDescendant {
	pid: number;
	pgid: number | undefined;
	starttime: string | undefined;
	uid: number | undefined;
	/** Which marker proved descent — highest available priority first. */
	matchedBy: "run-id" | "task-id" | "parent-pid";
	cmd: string;
	rssKb: number;
}

/** What identifies a run's process tree. All values come from run state. */
export interface RunMarkers {
	runId: string;
	/** `manifest.async.pid` — the detached team-runner, when recorded. */
	runnerPid?: number;
	/** Recorded worker pids of the run (heartbeat.pid / checkpoint.childPid). */
	workerPids: number[];
	/** Task ids of the run (PI_CREW_TASK_ID values its workers carried). */
	taskIds: string[];
	/**
	 * 11b.3: pids recorded in `manifest.surface.workerPids` (the mux-surface
	 * controller's view of each worker). A pane pid the operator can still see
	 * must not be reaped while it is alive — see safety rung 10.
	 */
	surfacePids?: number[];
	/** Run start (epoch ms) — a candidate that predates it cannot belong to it. */
	startedAtMs: number;
}

/** Injectable dependencies — every side effect is replaceable in tests. */
export interface SweepOptions {
	/** Report candidates without signalling (doctor). */
	dryRun?: boolean;
	/** /proc enumeration (tests inject a fixed pid list). Default `readdirSync("/proc")`. */
	listPids?: () => number[];
	/** /proc/<pid>/environ reader (tests inject marker maps). */
	readEnviron?: (pid: number) => Record<string, string> | undefined;
	/** /proc identity reader (tests inject fixtures). Default `readProcIdentity`. */
	readIdentity?: (pid: number) => ProcIdentity | undefined;
	/** Group signal sender (the reap-group `signalGroup` seam). */
	killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
	/** Group liveness probe (the reap-group `groupAlive` seam). */
	groupAlive?: (pgid: number) => boolean;
	/** Grace window between SIGTERM and SIGKILL on the group path (ms). */
	gracefulMs?: number;
	/** Hard cap after SIGKILL on the group path (ms). */
	capMs?: number;
	/** Platform override (tests simulate non-Linux). Default `process.platform`. */
	platform?: NodeJS.Platform;
	/** Candidate start (epoch ms) resolver — tests pin it, default reads /proc/uptime. */
	candidateStartMs?: (identity: ProcIdentity) => number | undefined;
}

/** Sweep verdict: what was signalled, what was refused, what is still in flight. */
export interface RunSweepResult {
	/** Candidates actually handed to the group reaper (empty on dryRun). */
	reaped: RunDescendant[];
	skipped: { pid: number; reason: string }[];
	/** SIGKILL escalations — register with the existing drain owners; never dropped. */
	pending: Promise<unknown>[];
	/**
	 * Every candidate discovery proved to belong to the run (dryRun included).
	 * `reaped` is the subset that was signalled; doctor reports THIS list.
	 */
	descendants: RunDescendant[];
}

// ── default /proc readers (all best-effort, none throw) ──────────────────────

/** `/proc/<pid>/environ` as a key=value record; undefined when unreadable. */
function readProcEnviron(pid: number): Record<string, string> | undefined {
	try {
		const raw = fs.readFileSync(`/proc/${pid}/environ`, "utf-8");
		const out: Record<string, string> = {};
		for (const entry of raw.split("\0")) {
			const eq = entry.indexOf("=");
			if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
		}
		return out;
	} catch {
		return undefined;
	}
}

/** Numeric pid directories under /proc; `[]` when /proc is unreadable. */
function listProcPids(): number[] {
	const pids: number[] = [];
	try {
		for (const entry of fs.readdirSync("/proc")) {
			if (/^\d+$/.test(entry)) pids.push(Number.parseInt(entry, 10));
		}
	} catch {
		/* no /proc — the platform gate above already handles the real case */
	}
	return pids;
}

/**
 * Parent pid of a process, from the shared paren-aware stat parser. Used ONLY to
 * walk OUR OWN ancestry (the skip set): that is real kernel state regardless of
 * any injected candidate reader, so it is deliberately not injectable.
 */
function readParentPid(pid: number): number | undefined {
	try {
		const fields = fieldsAfterComm(fs.readFileSync(`/proc/${pid}/stat`, "utf-8"));
		if (!fields) return undefined;
		const ppid = Number.parseInt(fields[PROC_STAT_PPID_INDEX] ?? "", 10);
		return Number.isFinite(ppid) && ppid > 0 ? ppid : undefined;
	} catch {
		return undefined;
	}
}

/** Our own ancestor chain (never a candidate: they host this session). */
function selfAncestors(): Set<number> {
	const chain = new Set<number>();
	let current = process.ppid;
	let guard = 0;
	while (current > 1 && guard++ < 64) {
		chain.add(current);
		const next = readParentPid(current);
		if (next === undefined || chain.has(next)) break;
		current = next;
	}
	return chain;
}

/** `/proc/<pid>/cmdline` for the report; `pid <n>` when unreadable. */
function readProcCmdline(pid: number): string {
	try {
		const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
		return raw.split("\0").filter(Boolean).join(" ").trim() || `pid ${pid}`;
	} catch {
		return `pid ${pid}`;
	}
}

/** `/proc/<pid>/status` VmRSS in kB; 0 when unreadable. */
function readProcRssKb(pid: number): number {
	try {
		const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf-8"));
		return match ? Number.parseInt(match[1] ?? "", 10) : 0;
	} catch {
		return 0;
	}
}

/** /proc/uptime first field (seconds since boot); undefined when unreadable. */
function readUptimeSec(): number | undefined {
	try {
		const seconds = Number.parseFloat(fs.readFileSync("/proc/uptime", "utf-8").split(" ")[0] ?? "");
		return Number.isFinite(seconds) ? seconds : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Wall-clock start of a candidate, from `starttime` ticks: boot = now - uptime,
 * start = boot + starttime/CLK_TCK. undefined when either side is unreadable —
 * an unprovable start time is a rejection, never a guess.
 */
function defaultCandidateStartMs(identity: ProcIdentity): number | undefined {
	if (identity.starttime === undefined) return undefined;
	const ticks = Number(identity.starttime);
	if (!Number.isFinite(ticks)) return undefined;
	const uptimeSec = readUptimeSec();
	if (uptimeSec === undefined) return undefined;
	return Date.now() - uptimeSec * 1000 + (ticks / CLOCK_TICKS_PER_SEC) * 1000;
}

/** Liveness by pid: ESRCH/ENOENT ⇒ gone, EPERM ⇒ alive but not ours. */
function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code !== "ESRCH" && code !== "ENOENT";
	}
}

// ── marker matching ─────────────────────────────────────────────────────────

/**
 * Match a candidate's inherited env against the run markers, highest priority
 * first (run-id → task-id → parent-pid). Returns the winning marker or
 * undefined.
 */
function matchMarkers(
	environ: Record<string, string>,
	markers: RunMarkers,
	recordedParents: ReadonlySet<number>,
	taskIds: ReadonlySet<string>,
): RunDescendant["matchedBy"] | undefined {
	if (environ.PI_CREW_BROKER_RUN_ID !== undefined && environ.PI_CREW_BROKER_RUN_ID === markers.runId) return "run-id";
	const parentPid = Number.parseInt(environ.PI_CREW_PARENT_PID ?? "", 10);
	const hasParent = Number.isInteger(parentPid) && parentPid > 1;
	// The worker shape: the process must carry the worker kind, belong to a task
	// of THIS run, and name a parent the run actually recorded (the runner pid
	// for a bash grandchild — the worker inherited PI_CREW_PARENT_PID from the
	// runner — or a worker pid for a nested worker).
	if (environ.PI_CREW_KIND === "subagent") {
		const taskId = environ.PI_CREW_TASK_ID;
		// 11b.1 (per-candidate proof): the recorded parent this candidate names
		// must ALSO be gone. While it is alive the candidate may still be doing
		// that worker's work, so a `task-id` match alone is not proof of a leak —
		// the parent-pid branch below has always required the same thing.
		if (taskId !== undefined && taskIds.has(taskId) && hasParent && recordedParents.has(parentPid) && !isPidAlive(parentPid)) {
			return "task-id";
		}
	}
	// The orphan shape of the incident survivors: only the dead recorded parent
	// is available as proof.
	if (hasParent && markers.workerPids.includes(parentPid) && !isPidAlive(parentPid)) return "parent-pid";
	return undefined;
}

/**
 * Enumerate the processes that PROVABLY belong to `markers.runId`. Pure
 * discovery — never signals. Returns `[]` on any platform without /proc and
 * when the kill switch is off (fail-open: the sweep is best-effort cleanup).
 */
export function collectRunDescendants(markers: RunMarkers, opts: SweepOptions = {}): RunDescendant[] {
	if (!resolveRunDescendantSweepEnabled()) return [];
	if ((opts.platform ?? process.platform) !== "linux") return [];
	const readIdentity = opts.readIdentity ?? readProcIdentity;
	const readEnviron = opts.readEnviron ?? readProcEnviron;
	const listPids = opts.listPids ?? listProcPids;
	const candidateStartMs = opts.candidateStartMs ?? defaultCandidateStartMs;
	const selfUid = typeof process.getuid === "function" ? process.getuid() : undefined;
	// Our own group: never a candidate's target group (belt to reap-group's rung).
	const selfPgrp = readIdentity(process.pid)?.pgid;
	const recordedParents = new Set<number>(markers.workerPids);
	if (markers.runnerPid !== undefined) recordedParents.add(markers.runnerPid);
	// 11b.3: pids the surface controller recorded for this run's panes.
	const surfacePids = new Set<number>((markers.surfacePids ?? []).filter((pid) => Number.isInteger(pid) && pid > 1));
	const taskIds = new Set<string>(markers.taskIds);
	const ancestors = selfAncestors();
	const descendants: RunDescendant[] = [];
	for (const pid of listPids()) {
		if (!Number.isInteger(pid) || pid <= 1) continue;
		// Never ourselves, never a process that hosts this session.
		if (pid === process.pid || ancestors.has(pid)) continue;
		// 11b.1 per-candidate rule: a RECORDED ancestor is the root of the tree we
		// are cleaning up, never a descendant of it. Excluding it is what makes the
		// sweep safe WITHOUT the old all-or-nothing "every recorded pid is dead"
		// gate: a live worker keeps running (its own group reap / orphan reaper
		// owns it) while the leaked grandchildren whose recorded parent is already
		// gone are still reaped. Trade-off, stated plainly: a recorded pid that was
		// recycled onto a genuine leaked descendant is skipped here — a miss, never
		// a wrong kill.
		if (recordedParents.has(pid)) continue;
		// 11b.3: a recorded surface pane pid that is STILL ALIVE may be the pane the
		// operator is watching right now (a run that just went terminal keeps its
		// mux panes until they are closed). Never a candidate while alive; once it
		// is dead the pid is gone from /proc anyway, so nothing is left to reap.
		if (surfacePids.has(pid) && isPidAlive(pid)) continue;
		const identity = readIdentity(pid);
		if (!identity) continue;
		// Same uid only — an unknown uid cannot be proven to be ours either.
		if (identity.uid === undefined || selfUid === undefined || identity.uid !== selfUid) continue;
		// The PID-reuse-proof field, and the run-scope proof: must exist and must
		// not predate the run.
		if (identity.starttime === undefined) continue;
		const startMs = candidateStartMs(identity);
		if (startMs === undefined || startMs < markers.startedAtMs - PRE_RUN_SKEW_MS) continue;
		// Never hand our own group (or our own pid as a pgid) to the reaper.
		if (identity.pgid === process.pid || (selfPgrp !== undefined && identity.pgid === selfPgrp)) continue;
		const environ = readEnviron(pid);
		if (!environ) continue;
		const matchedBy = matchMarkers(environ, markers, recordedParents, taskIds);
		if (matchedBy === undefined) continue;
		descendants.push({
			pid,
			pgid: identity.pgid,
			starttime: identity.starttime,
			uid: identity.uid,
			matchedBy,
			cmd: readProcCmdline(pid),
			rssKb: readProcRssKb(pid),
		});
	}
	return descendants;
}

// ── idempotency: one signal per group incarnation ───────────────────────────
//
// The stale reconciler runs on a timer and may look at the same terminal run
// more than once. Re-signalling an already-reaped group is not just noise: it
// is a second chance to hit a RECYCLED pgid (the group drained in between). The
// registry therefore remembers `pgid:leader-starttime` for every accepted
// signal — the leader starttime makes a new incarnation a NEW key — and is
// bounded so a long-lived host cannot grow it without limit. An escalation that
// ended `stuck`/`refused` is forgotten, so the next tick may retry it.
const signalledGroups = new Map<string, number>();

function rememberSignalledGroup(key: string): void {
	signalledGroups.set(key, Date.now());
	while (signalledGroups.size > MAX_TRACKED_GROUPS) {
		const oldest = signalledGroups.keys().next();
		if (oldest.done) break;
		signalledGroups.delete(oldest.value);
	}
}

/** Test seam: forget every remembered group (idempotency reset). */
export function __resetSignalledGroupsForTest(): void {
	signalledGroups.clear();
}

/** Test seam: how many group incarnations are remembered. */
export function __signalledGroupCountForTest(): number {
	return signalledGroups.size;
}

/** Default group signal — defensively refuses non-positive pgids. */
function defaultKillGroup(pgid: number, signal: NodeJS.Signals): void {
	if (!Number.isInteger(pgid) || pgid <= 1) return;
	try {
		process.kill(-pgid, signal);
	} catch {
		/* group already gone — nothing to deliver */
	}
}

/** Default group liveness: `kill(-pgid, 0)`; EPERM means alive but not ours. */
function defaultGroupAlive(pgid: number): boolean {
	if (!Number.isInteger(pgid) || pgid <= 1) return false;
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Reap the proven descendants of a TERMINAL run. Every signal goes through the
 * guarded group ladder (`reapGroup`), one signal per group incarnation; the
 * candidates that share a pgid are reported individually but signalled once.
 * Never throws.
 *
 * MUST only be called for a TERMINAL run. 11b.1: the recorded ancestors need NOT
 * be dead any more — a recorded pid is never a candidate (see
 * `collectRunDescendants`), so a live worker cannot veto reaping the leaked
 * grandchildren whose own recorded parent is gone. `stale-reconciler.ts`
 * enforces the terminal-run precondition before calling, and the doctor path is
 * `dryRun`.
 */
export function reapRunDescendants(markers: RunMarkers, opts: SweepOptions = {}): RunSweepResult {
	const result: RunSweepResult = { reaped: [], skipped: [], pending: [], descendants: [] };
	if (!resolveRunDescendantSweepEnabled()) return result;
	const descendants = collectRunDescendants(markers, opts);
	result.descendants = descendants;
	if (descendants.length === 0) return result;
	const readIdentity = opts.readIdentity ?? readProcIdentity;
	const signalGroup = opts.killGroup ?? defaultKillGroup;
	const groupAlive = opts.groupAlive ?? defaultGroupAlive;
	const selfPgrp = readIdentity(process.pid)?.pgid;
	const matchedPids = new Set<number>(descendants.map((descendant) => descendant.pid));
	// Candidates are grouped by the group we would signal: one reapGroup call per
	// pgid, so a sibling pair of bash grandchildren cannot be signalled twice.
	const byGroup = new Map<number, RunDescendant[]>();
	for (const descendant of descendants) {
		const pgid = descendant.pgid;
		if (
			pgid === undefined ||
			!Number.isInteger(pgid) ||
			pgid <= 1 ||
			pgid === process.pid ||
			(selfPgrp !== undefined && pgid === selfPgrp)
		) {
			result.skipped.push({ pid: descendant.pid, reason: "no-pgid" });
			continue;
		}
		const members = byGroup.get(pgid);
		if (members) members.push(descendant);
		else byGroup.set(pgid, [descendant]);
	}
	for (const [pgid, members] of byGroup) {
		// Sweep-only rung: a live leader that is NOT itself a matched candidate
		// means this group belongs to a session that is still running (or to a
		// stranger) — never signal it. A dead leader, or a leader that is one of
		// our own candidates, is safe: reapGroup re-validates identity anyway.
		const leader = readIdentity(pgid);
		if (leader && !matchedPids.has(pgid)) {
			logInternalError(
				"run-descendant-sweep.leader-alive-unmatched",
				new Error(`pgid ${pgid} has a live leader ${pgid} that carries no marker of run ${markers.runId}`),
				`candidates=${members.map((member) => member.pid).join(",")}`,
				"debug",
			);
			for (const member of members) result.skipped.push({ pid: member.pid, reason: "leader-alive-unmatched" });
			continue;
		}
		const groupKey = `${pgid}:${leader?.starttime ?? "dead"}`;
		if (signalledGroups.has(groupKey)) {
			for (const member of members) result.skipped.push({ pid: member.pid, reason: "already-swept" });
			continue;
		}
		if (opts.dryRun) {
			for (const member of members) result.skipped.push({ pid: member.pid, reason: "dry-run" });
			continue;
		}
		const anchor = members[0];
		if (anchor === undefined) continue;
		const expected: ProcIdentity = { pid: anchor.pid, pgid, starttime: anchor.starttime, uid: anchor.uid };
		const reap = reapGroup(pgid, anchor.pid, {
			expected,
			readIdentity,
			signalGroup,
			groupAlive,
			name: `run-sweep:${markers.runId}`,
			...(opts.gracefulMs !== undefined ? { gracefulMs: opts.gracefulMs } : {}),
			...(opts.capMs !== undefined ? { capMs: opts.capMs } : {}),
			...(opts.platform !== undefined ? { platform: opts.platform } : {}),
		});
		if (reap.refusal !== undefined) {
			// Nothing was signalled. Leave the key unset so a later tick can retry
			// once the group/identity state changes.
			logInternalError(
				"run-descendant-sweep.refused",
				new Error(`group reap refused for pgid ${pgid} (${reap.refusal})`),
				`run=${markers.runId} pids=${members.map((member) => member.pid).join(",")}`,
				"debug",
			);
			for (const member of members) result.skipped.push({ pid: member.pid, reason: `group-refused:${reap.refusal}` });
			continue;
		}
		rememberSignalledGroup(groupKey);
		// A no-op catch keeps a stuck/failed escalation from wedging the registry:
		// the group did not finish dying, so the next sweep may try again.
		void reap.pending.then(
			(outcome) => {
				if (outcome === "stuck" || outcome === "refused") signalledGroups.delete(groupKey);
			},
			() => signalledGroups.delete(groupKey),
		);
		result.pending.push(reap.pending);
		for (const member of members) result.reaped.push(member);
	}
	return result;
}
