/**
 * reap-group.ts — fix-wave 11a (F5): THE single place that may signal a POSIX
 * process GROUP, with an identity-proven refusal ladder and a bounded
 * escalation ladder.
 *
 * Why this module exists: every pre-wave reap path sent ONE signal to ONE pid
 * (`orphan-reaper.ts`, `child-pi-kill.ts`) or blindly group-killed a stored
 * pgid (`owned-process.ts` distrusts nothing). Both shapes fail the incident
 * that motivated wave 11 (run `team_20261022110510_cefb9164af126460` completed
 * but 6 grandchildren survived 24 h): a pid-only SIGTERM never reaches
 * descendants, while a raw `kill(-pgid)` can hit an UNRELATED group after PID
 * reuse. The guard ladder below is what makes a group kill defensible:
 *
 *   1. POSIX only, and /proc must be readable (the identity source).
 *   2. `pgid` must be an integer > 1 — NEVER `kill(-1)` / `kill(0)`, which
 *      would signal every process we are allowed to signal, and never 1 (init's
 *      group).
 *   3. never our own group (its REAL pgrp, read once from /proc — see
 *      `selfIdentity()`), never our pid, never our parent's pid.
 *   4. the candidate must have a live identity, OR (candidate already gone) a
 *      caller-supplied snapshot (`expected`) that PROVES the group leader —
 *      `expected.pid === expected.pgid === pgid` + a starttime — because a
 *      dead candidate cannot prove anything by itself.
 *   5. same uid as us (we can only reason about our own processes).
 *   6. the candidate's REAL pgid must equal the requested pgid (PID-reuse).
 *   7. the identity must carry a starttime (the reuse-proof field).
 *   8. if a snapshot exists, its starttime must match the live one.
 *
 * Wave 11a REVIEW FIXES (round 1) baked into the ladder:
 *   - CRITICAL #1 `selfIdentity()`: comparing `pgid` with {pid, ppid} misses a
 *     host started under `setsid`/a wrapper, whose pgrp is neither ⇒ the old
 *     rung PASSED and `kill(-ownPgrp)` took out the host session.
 *   - MAJOR #2 dead-candidate path: `identity := expected` made rungs 4/6/7/8
 *     tautologies over the snapshot itself (blind `kill(-pgid)`). The snapshot
 *     is now only usable as LEADER PROOF, and the kernel's "a pgid is not
 *     recycled while the group still has members" property is what makes
 *     "leader gone but group alive" safe.
 *
 * Escalation: SIGTERM is delivered SYNCHRONOUSLY (postmortem-safe — a hard exit
 * right after the call still leaves the graceful signal sent), then a bounded
 * poll → re-validate → SIGKILL → bounded poll. The poll timers are unref'd so a
 * reaper never pins the event loop — which is exactly why the SIGKILL rung needs
 * explicit owners (see the "deferred SIGKILL deliveries" block below):
 * `drainReapEscalations()` awaits the armed promises under a REF'D keep-alive,
 * and `flushReapEscalationsSync()` delivers the last rung synchronously on
 * session shutdown. Nothing here throws: every failure is a typed refusal or
 * outcome.
 *
 * Scope note (wave 11a): a worker's bash grandchildren live in PI's bash-tool
 * group, not the worker's group (GAP-0) — this module cannot reach them. That
 * is the run-scoped descendant sweep (F7) in wave 11b.
 */

import * as fs from "node:fs";
import { getCrewEnvBool } from "../../config/env-vars.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { fieldsAfterComm, PROC_STAT_PGID_INDEX, PROC_STAT_STARTTIME_INDEX } from "./proc-stat.ts";

/** Default grace window between SIGTERM and SIGKILL (ms). */
const DEFAULT_GRACEFUL_MS = 2_000;
/** Default hard cap after SIGKILL before declaring the group stuck (ms). */
const DEFAULT_CAP_MS = 2_000;
/** Poll interval for group-liveness (ms). */
const POLL_INTERVAL_MS = 20;

/**
 * Kill switch (host-process only, default ON). `PI_CREW_REAP_GROUP=0` degrades
 * every group-kill caller to its pre-wave pid-only behaviour, without a
 * redeploy — the escape hatch if a platform turns out to mis-report pgids.
 */
export function resolveReapGroupEnabled(): boolean {
	return getCrewEnvBool("PI_CREW_REAP_GROUP") ?? true;
}

/** A process identity read from /proc — the reuse-proof triple plus pid/pgid. */
export interface ProcIdentity {
	pid: number;
	pgid: number | undefined;
	starttime: string | undefined;
	uid: number | undefined;
}

/** Every way we refuse to signal a group. Each maps to one ladder rung. */
export type GroupRefusalReason =
	| "platform-not-posix"
	| "proc-unavailable"
	| "pgid-invalid"
	| "pgid-init-or-self"
	| "uid-mismatch"
	| "identity-missing"
	| "starttime-mismatch"
	| "not-group-member";

/** Terminal verdict for a group reap attempt. */
export type GroupReapOutcome = "gone" | "killed-after-escalation" | "stuck" | "refused";

/** Injectable dependencies (every side effect is replaceable in tests). */
export interface ReapGroupOptions {
	/** Grace window between SIGTERM and SIGKILL. Default 2000 ms. */
	gracefulMs?: number;
	/** Hard cap after SIGKILL before giving up. Default 2000 ms. */
	capMs?: number;
	/** Platform override (tests simulate win32). Default `process.platform`. */
	platform?: NodeJS.Platform;
	/** /proc identity reader (tests inject fixtures). Default `readProcIdentity`. */
	readIdentity?: (pid: number) => ProcIdentity | undefined;
	/** Group signal sender. Default `process.kill(-pgid, signal)`. */
	signalGroup?: (pgid: number, signal: NodeJS.Signals) => void;
	/** Group liveness probe. Default `process.kill(-pgid, 0)`. */
	groupAlive?: (pgid: number) => boolean;
	/** Snapshot recorded at spawn time — required when the candidate is gone. */
	expected?: ProcIdentity;
	/** Diagnostic label used in log messages. */
	name?: string;
	/**
	 * uid source for the same-uid rungs (5 and the dead-path uid proof). Default
	 * `() => process.getuid?.()` — production behaviour is unchanged. The seam
	 * exists because `process.getuid` is undefined on win32, which made the uid
	 * rungs untestable there without a process-wide monkeypatch.
	 *
	 * Read PER CALL and never cached: unlike `selfIdentity()` (which is cached
	 * because a process cannot change its group), this is an injected value with
	 * no invariant of its own, and caching it would make the first caller win for
	 * the lifetime of the module.
	 */
	getuid?: () => number | undefined;
}

/** Sync verdict + the authoritative async verdict. */
export interface GroupReapResult {
	/**
	 * Provisional sync verdict: `refused` (nothing signalled), `gone` (SIGTERM
	 * already cleared the group) or `killed-after-escalation` (escalation
	 * armed — `pending` is authoritative).
	 */
	outcome: GroupReapOutcome;
	/** Set when the guard ladder refused. */
	refusal?: GroupRefusalReason;
	/** Authoritative verdict; already resolved when no escalation was needed. */
	pending: Promise<GroupReapOutcome>;
}

/** `/proc/<pid>/status` first `Uid:` field (real uid). Never throws. */
function readUidFromStatus(pid: number): number | undefined {
	try {
		const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
		const match = /^Uid:\s+(\d+)/m.exec(status);
		if (!match) return undefined;
		const uid = Number(match[1]);
		return Number.isInteger(uid) ? uid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read pid/pgid/starttime/uid from /proc. Reuses the paren-aware stat parser in
 * proc-stat.ts (comm may contain spaces AND parens — a naive split corrupts
 * every field after it). Returns undefined for anything unreadable: /proc is
 * absent (non-Linux), the pid is gone, or the line is malformed.
 */
export function readProcIdentity(pid: number): ProcIdentity | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	let stat: string;
	try {
		stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
	const fields = fieldsAfterComm(stat);
	if (!fields) return undefined;
	const rawPgid = Number(fields[PROC_STAT_PGID_INDEX]);
	const pgid = Number.isInteger(rawPgid) && rawPgid > 0 ? rawPgid : undefined;
	const rawStarttime = fields[PROC_STAT_STARTTIME_INDEX];
	const starttime = rawStarttime && Number.isFinite(Number(rawStarttime)) ? rawStarttime : undefined;
	return { pid, pgid, starttime, uid: readUidFromStatus(pid) };
}

/**
 * OUR OWN identity as read from /proc — the authoritative answer to "which
 * process group am I in?". Read ONCE per process and cached (a POSIX process
 * cannot change its group after start), so the ladder never re-reads /proc for
 * a value that cannot move. A FAILED read is NOT cached (MINOR #3): /proc can be
 * momentarily unreadable (mount race, sandbox start-up) and caching that would
 * turn a transient failure into a permanent refuse-everything state.
 *
 * Why not {process.pid, process.ppid} (the pre-review rung 3): a host started
 * under `setsid`, a tmux/systemd/supervisor wrapper, or any launcher that puts
 * it in a fresh group has a pgrp that is NEITHER its pid NOR its parent's pid
 * — the old comparison PASSED for that group, and `kill(-pgrp)` then killed the
 * whole host session. Review finding CRITICAL #1 (wave 11a).
 */
let selfIdentityCache: ProcIdentity | undefined;
let selfIdentityLoaded = false;
/** Injected ONLY by tests (the ladder never accepts a per-call reader for self). */
let selfIdentityReader: (pid: number) => ProcIdentity | undefined = readProcIdentity;

/**
 * Lazily read + cache our own /proc identity (undefined ⇒ unreadable RIGHT NOW;
 * the next call retries). Only a successful read is cached (MINOR #3).
 */
function selfIdentity(): ProcIdentity | undefined {
	if (selfIdentityLoaded) return selfIdentityCache;
	const identity = selfIdentityReader(process.pid);
	if (!identity) {
		logInternalError(
			"reap-group.self-identity",
			new Error("cannot read our own /proc identity — refusing group signals, will retry"),
			undefined,
			"debug",
		);
		return undefined;
	}
	selfIdentityCache = identity;
	selfIdentityLoaded = true;
	return identity;
}

/** Test seam: forget the cached self identity so the next call re-reads /proc. */
export function __resetSelfIdentityForTest(): void {
	selfIdentityCache = undefined;
	selfIdentityLoaded = false;
	selfIdentityReader = readProcIdentity;
}

/** Test seam: install a synthetic self identity (undefined ⇒ "cannot read"). */
export function __setSelfIdentityForTest(identity: ProcIdentity | undefined): void {
	selfIdentityCache = identity;
	selfIdentityLoaded = true;
}

/**
 * Test seam: swap the /proc reader used for OUR OWN identity. Needed to pin the
 * MINOR #3 retry rule (a FAILED self read must not be cached) without depending
 * on a real /proc — the per-call `opts.readIdentity` deliberately cannot do it.
 */
export function __setSelfIdentityReaderForTest(reader: ((pid: number) => ProcIdentity | undefined) | undefined): void {
	selfIdentityReader = reader ?? readProcIdentity;
}

/** Default uid source for the same-uid rungs: the real process uid, when the
 *  runtime has one (POSIX). win32 has none ⇒ `undefined` ⇒ the rungs degrade
 *  exactly as they did before the seam existed. */
const defaultGetuid = (): number | undefined => process.getuid?.();

/**
 * Run the refusal ladder. Returns the FIRST failing rung, or undefined when the
 * group is safe to signal. Pure with respect to injected `readIdentity` /
 * `groupAlive`; the self identity is cached module state (seam above).
 */
export function assertSafeGroup(pgid: number, candidatePid: number, opts: ReapGroupOptions = {}): GroupRefusalReason | undefined {
	const platform = opts.platform ?? process.platform;
	const readIdentity = opts.readIdentity ?? readProcIdentity;
	const groupAlive = opts.groupAlive ?? defaultGroupAlive;
	// Rung 1: our own /proc identity must be readable — it is BOTH the /proc
	// availability probe AND the rung-3 comparison. MINOR #4 (review): this is
	// the cached SELF read, never the injected `readIdentity`: the injection point
	// exists for the CANDIDATE, and letting a test hook vouch for our own identity
	// is precisely the shape of CRITICAL #1.
	if (platform === "win32") return "platform-not-posix";
	const self = selfIdentity();
	if (!self) return "proc-unavailable";
	// Rung 2: a non-positive pgid would signal far too much (kill(-1)/kill(0));
	// pgid 1 is init's group — reaping it is never a worker cleanup.
	if (!Number.isInteger(pgid) || pgid <= 1) return "pgid-invalid";
	// Rung 3: never our own group (its REAL pgrp — CRITICAL #1), never our pid,
	// never our parent's pid. Unknown self pgrp ⇒ refuse: that is exactly the
	// state in which `kill(-pgid)` could take out the host session.
	if (self.pgid === undefined) return "identity-missing";
	if (pgid === process.pid || pgid === process.ppid || pgid === self.pgid) return "pgid-init-or-self";
	const selfUid = (opts.getuid ?? defaultGetuid)();
	// Rung 4: a LIVE candidate identity, or (dead candidate) leader-proof.
	const live = readIdentity(candidatePid);
	if (!live) {
		// The candidate is gone, so nothing about IT can be verified any more. A
		// snapshot is only evidence when it PROVES the group leader: the candidate
		// we were asked to signal must BE the leader (`candidatePid === pgid`, and
		// the snapshot must agree on both pid and pgid — MINOR #1) and must carry
		// the starttime. Without that, every later rung would compare the snapshot
		// with itself ⇒ tautology ⇒ blind kill(-pgid) after PID reuse (MAJOR #2).
		const expected = opts.expected;
		if (!expected || candidatePid !== pgid || expected.pid !== pgid || expected.pgid !== pgid || expected.starttime === undefined) {
			return "identity-missing";
		}
		// Rung 5 (dead path): the uid proof is MANDATORY here (MINOR #2). The live
		// /proc path always carries one, so an absent uid means we cannot separate
		// our own process from a stranger's: signalling then fails with EPERM AFTER
		// the caller already reported `reaped`, which leaves a false `stuck`.
		if (expected.uid === undefined) return "identity-missing";
		if (selfUid !== undefined && expected.uid !== selfUid) return "uid-mismatch";
		// The kernel does NOT recycle a pgid while the group still has a member,
		// so the leader is the only pid whose starttime the snapshot pins. If the
		// leader is still there it must be the SAME incarnation AND still lead that
		// group (MINOR #1: a pid that left the group via setpgid is no evidence).
		const leader = readIdentity(pgid);
		if (leader) {
			if (leader.pgid !== pgid) return "not-group-member";
			if (leader.starttime === undefined) return "identity-missing";
			if (leader.starttime !== expected.starttime) return "starttime-mismatch";
			if (leader.uid !== undefined && selfUid !== undefined && leader.uid !== selfUid) return "uid-mismatch";
			return undefined;
		}
		// Leader gone: a still-live group means surviving members hold the pgid
		// (so it cannot have been recycled) ⇒ our old group. An empty group means
		// there is nothing to justify the kill and nothing to kill.
		if (groupAlive(pgid)) {
			// TOCTOU, documented on purpose (MINOR #7): between this probe and the
			// caller's `signalGroup` the LAST member may exit and the pgid be recycled
			// by an unrelated group. That window cannot be closed without a pidfd-style
			// handle (one signal per pid, no group target). It is accepted because the
			// alternative — re-introducing the snapshot as identity — made the very
			// rungs above tautological (MAJOR #2).
			return undefined;
		}
		return "identity-missing";
	}
	// Rung 5: same uid (a missing uid only happens for injected snapshots; the
	// live /proc path always carries one — the remaining rungs still hold).
	if (live.uid !== undefined && selfUid !== undefined && live.uid !== selfUid) return "uid-mismatch";
	// Rung 6: PID reuse — the candidate must actually belong to that group.
	if (live.pgid !== pgid) return "not-group-member";
	// Rung 7: starttime is the field that survives PID reuse.
	if (live.starttime === undefined) return "identity-missing";
	// Rung 8: the snapshot and the live process must be the SAME incarnation.
	const expectedStart = opts.expected?.starttime;
	if (expectedStart !== undefined && live.starttime !== expectedStart) return "starttime-mismatch";
	return undefined;
}

/** Unref'd sleep so an in-flight reap never pins the event loop. */
const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, Math.max(0, ms));
		timer.unref?.();
	});

/** Poll `predicate` until true or the deadline passes; returns the final value. */
async function pollUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + Math.max(0, timeoutMs);
	while (Date.now() < deadline) {
		await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
		if (predicate()) return true;
	}
	return predicate();
}

/** Default group liveness: `kill(-pgid, 0)`; EPERM means "alive, not ours". */
function defaultGroupAlive(pgid: number): boolean {
	if (!Number.isInteger(pgid) || pgid <= 1) return false;
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Default group signal. Defensively refuses non-positive pgids (kill(-1)/kill(0)). */
function defaultSignalGroup(pgid: number, signal: NodeJS.Signals): void {
	if (!Number.isInteger(pgid) || pgid <= 1) return;
	try {
		process.kill(-pgid, signal);
	} catch {
		/* group already gone — nothing to deliver */
	}
}

/** Log a refusal/abnormal outcome at debug (never above: refusals are expected). */
function logDebug(scope: string, message: string, opts: ReapGroupOptions): void {
	logInternalError(scope, new Error(message), `name=${opts.name ?? "-"}`, "debug");
}

// ── deferred SIGKILL deliveries (wave 11a review, MAJOR #3) ───────────────────
//
// `reapGroup` hands the SIGKILL rung back as a promise, and every production
// caller is SYNCHRONOUS (the stale-run reconciler, `killProcessTree`): they can
// at most register the promise with a drain owner. The escalation's own poll
// timers are unref'd (they must not keep a finished run alive), which means an
// un-awaited escalation is abandoned the moment the host's loop drains — the
// SIGKILL is silently never delivered (measured: an unsettled top-level await
// over unref'd timers exits 13).
//
// Two owners close that hole:
//   1. `drainReapEscalations()` (stale-reconciler.ts) awaits the registered
//      promises while holding a REF'D keep-alive interval.
//   2. `flushReapEscalationsSync()` (below) is for session shutdown: it
//      re-validates and delivers the SIGKILL rung synchronously, so the last
//      rung still happens in a process that is about to exit.
/** One armed escalation: everything needed to re-validate and signal it later. */
interface ArmedGroupEscalation {
	pgid: number;
	candidatePid: number;
	opts: ReapGroupOptions;
	/** Set once {@link flushReapEscalationsSync} delivered the SIGKILL — the async
	 *  escalation must then never signal a second time. */
	deliveredSync?: boolean;
}

const armedEscalations = new Set<ArmedGroupEscalation>();

/**
 * Deliver the SIGKILL rung of every ARMED escalation SYNCHRONOUSLY — the
 * session-shutdown path. Each entry is re-validated against the ladder at THIS
 * instant (the group may have drained, or the pgid been recycled since the
 * SIGTERM), so a stale entry never becomes a blind kill. Best-effort per entry:
 * one failure cannot stop the rest. The registry is cleared either way. Returns
 * the number of groups signalled. Never throws.
 */
export function flushReapEscalationsSync(): number {
	const entries = [...armedEscalations];
	armedEscalations.clear();
	let delivered = 0;
	for (const entry of entries) {
		try {
			const refusal = assertSafeGroup(entry.pgid, entry.candidatePid, entry.opts);
			if (refusal) {
				logDebug("reap-group.flush-refused", `no deferred SIGKILL for pgid=${entry.pgid} (${refusal})`, entry.opts);
				continue;
			}
			(entry.opts.signalGroup ?? defaultSignalGroup)(entry.pgid, "SIGKILL");
			entry.deliveredSync = true;
			delivered++;
		} catch (err) {
			logInternalError(
				"reap-group.flush-error",
				err instanceof Error ? err : new Error(String(err)),
				`pgid=${entry.pgid} name=${entry.opts.name ?? "-"}`,
				"warn",
			);
		}
	}
	if (delivered > 0) logDebug("reap-group.flush", `delivered ${delivered} deferred group SIGKILL(s) at shutdown`, {});
	return delivered;
}

/** Test seam: how many escalations are still armed (registry must empty on flush). */
export function __armedEscalationCountForTest(): number {
	return armedEscalations.size;
}

/** Test seam: drop the armed registry without signalling anything. */
export function __resetArmedEscalationsForTest(): void {
	armedEscalations.clear();
}

/**
 * Reap a whole process group. See the module header for the safety model.
 * Refused ⇒ nothing is signalled. Accepted ⇒ SIGTERM now, escalation in
 * `pending` (re-validated before SIGKILL).
 */
export function reapGroup(pgid: number, candidatePid: number, opts: ReapGroupOptions = {}): GroupReapResult {
	const signalGroup = opts.signalGroup ?? defaultSignalGroup;
	const groupAlive = opts.groupAlive ?? defaultGroupAlive;
	const gracefulMs = opts.gracefulMs ?? DEFAULT_GRACEFUL_MS;
	const capMs = opts.capMs ?? DEFAULT_CAP_MS;
	const refusal = assertSafeGroup(pgid, candidatePid, opts);
	if (refusal) {
		logDebug("reap-group.refused", `refusing to signal pgid=${pgid} (${refusal})`, opts);
		return { outcome: "refused", refusal, pending: Promise.resolve("refused") };
	}
	// Postmortem-safe prefix: the graceful signal is out BEFORE any await, so a
	// host that dies right here still leaves SIGTERM delivered.
	signalGroup(pgid, "SIGTERM");
	if (!groupAlive(pgid)) return { outcome: "gone", pending: Promise.resolve("gone") };
	// MINOR #5 (review): the escalation promise is handed to callers who may
	// `void` it. It must therefore NEVER reject — an unhandled rejection is fatal
	// on Node 22 — so every rung is wrapped and the worst case is a typed
	// "stuck" outcome.
	// MAJOR #3 (review): the escalation is also REGISTERED, so the two owners
	// above can await it (drain) or deliver it synchronously (shutdown flush).
	const armed: ArmedGroupEscalation = { pgid, candidatePid, opts };
	armedEscalations.add(armed);
	const pending = (async (): Promise<GroupReapOutcome> => {
		try {
			if (await pollUntil(() => !groupAlive(pgid), gracefulMs)) return "gone";
			// The shutdown flush may already have delivered SIGKILL synchronously —
			// signalling a second time would be a double kill of a possibly recycled
			// group, so stop here.
			if (armed.deliveredSync === true) return "killed-after-escalation";
			// Re-validate immediately before SIGKILL: between the SIGTERM prefix and
			// here the group may have drained and the pgid been recycled by an
			// unrelated group. A failure here is a refusal, not an escalation.
			const recheck = assertSafeGroup(pgid, candidatePid, opts);
			if (recheck) {
				logDebug("reap-group.sigkill-refused", `escalation refused for pgid=${pgid} (${recheck})`, opts);
				return "refused";
			}
			signalGroup(pgid, "SIGKILL");
			if (await pollUntil(() => !groupAlive(pgid), capMs)) return "killed-after-escalation";
			logInternalError(
				"reap-group.stuck",
				new Error(`process group ${pgid} still alive after SIGKILL cap (${capMs}ms); giving up`),
				`name=${opts.name ?? "-"}`,
				"warn",
			);
			return "stuck";
		} catch (err) {
			logInternalError(
				"reap-group.escalation-error",
				err instanceof Error ? err : new Error(String(err)),
				`pgid=${pgid} name=${opts.name ?? "-"}`,
				"warn",
			);
			return "stuck";
		}
	})();
	// Retire the entry the moment the escalation settles: a healthy escalation
	// leaves nothing behind for the shutdown flush (and an empty registry is what
	// the flush contract promises). Both handlers swallow — this derived promise
	// must never reject, nothing awaits it.
	void pending.then(
		() => armedEscalations.delete(armed),
		() => armedEscalations.delete(armed),
	);
	return { outcome: "killed-after-escalation", pending };
}
