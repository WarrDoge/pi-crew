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
 *      would signal every process we are allowed to signal.
 *   3. never our own group or our parent's group.
 *   4. the candidate must have a live identity, OR a caller-supplied snapshot
 *      (`expected`) that itself carries pgid + starttime.
 *   5. same uid as us (we can only reason about our own processes).
 *   6. the candidate's REAL pgid must equal the requested pgid (PID-reuse).
 *   7. the identity must carry a starttime (the reuse-proof field).
 *   8. if a snapshot exists, its starttime must match the live one.
 *
 * Escalation: SIGTERM is delivered SYNCHRONOUSLY (postmortem-safe — a hard exit
 * right after the call still leaves the graceful signal sent), then a bounded
 * poll → re-validate → SIGKILL → bounded poll. Timers are unref'd so a reaper
 * never pins the event loop. Nothing here throws: every failure is a typed
 * refusal or outcome.
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
 * Run the refusal ladder. Returns the FIRST failing rung, or undefined when the
 * group is safe to signal. Pure with respect to injected `readIdentity`.
 */
export function assertSafeGroup(pgid: number, candidatePid: number, opts: ReapGroupOptions = {}): GroupRefusalReason | undefined {
	const platform = opts.platform ?? process.platform;
	const readIdentity = opts.readIdentity ?? readProcIdentity;
	// Rung 1: we can only reason about POSIX groups, and only with /proc.
	if (platform === "win32") return "platform-not-posix";
	if (!readIdentity(process.pid)) return "proc-unavailable";
	// Rung 2: a non-positive pgid would signal far too much (kill(-1)/kill(0)).
	if (!Number.isInteger(pgid) || pgid <= 1) return "pgid-invalid";
	// Rung 3: never our own group, never our parent's group.
	if (pgid === process.pid || pgid === process.ppid) return "pgid-init-or-self";
	// Rung 4: live identity, or a snapshot that itself proves pgid + starttime.
	const live = readIdentity(candidatePid);
	let identity = live;
	if (!identity) {
		const expected = opts.expected;
		if (!expected || expected.pgid !== pgid || expected.starttime === undefined) return "identity-missing";
		identity = expected;
	}
	// Rung 5: same uid (a missing uid only happens for injected snapshots; the
	// live /proc path always carries one — the remaining rungs still hold).
	const selfUid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (identity.uid !== undefined && selfUid !== undefined && identity.uid !== selfUid) return "uid-mismatch";
	// Rung 6: PID reuse — the candidate must actually belong to that group.
	if (identity.pgid !== pgid) return "not-group-member";
	// Rung 7: starttime is the field that survives PID reuse.
	if (identity.starttime === undefined) return "identity-missing";
	// Rung 8: the snapshot and the live process must be the SAME incarnation.
	const expectedStart = opts.expected?.starttime;
	if (expectedStart !== undefined && identity.starttime !== expectedStart) return "starttime-mismatch";
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
	const pending = (async (): Promise<GroupReapOutcome> => {
		if (await pollUntil(() => !groupAlive(pgid), gracefulMs)) return "gone";
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
	})();
	return { outcome: "killed-after-escalation", pending };
}
