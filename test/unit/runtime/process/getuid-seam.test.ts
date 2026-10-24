/**
 * getuid-seam.test.ts — fix-wave 12b (F5): the `getuid` injection seam.
 *
 * Why this file exists (SPEC §3.5, GAP-6): the uid rungs of both the group
 * ladder (`reap-group.ts`) and the run-scoped sweep (`run-descendant-sweep.ts`)
 * read `process.getuid()` directly. `process.getuid` does not exist on win32,
 * so three suites made the rungs testable by MONKEYPATCHING the global for the
 * lifetime of the file — a duplicated, process-wide seam that also hides the
 * production read, and that would keep every suite green if `src` ever switched
 * to `geteuid()` / `os.userInfo().uid`.
 *
 * Wave 12b replaced it with an optional `getuid?: () => number | undefined` on
 * `ReapGroupOptions` / `SweepOptions` (default `() => process.getuid?.()`, so
 * production behaviour is byte-identical). This file pins the seam itself:
 *
 *   (u1) the ladder compares against the INJECTED uid — refuses on mismatch
 *        (signalling nothing), accepts and SIGTERMs on match, and re-reads the
 *        seam per call instead of caching it;
 *   (u2) the sweep honours the same seam on BOTH halves: discovery and the
 *        `reapGroup` call site it delegates to (the split-brain rule), plus the
 *        `getuid ⇒ undefined` branch and the env-read decision;
 *   (u3) omitting the option falls back to the REAL `process.getuid` and never
 *        throws (the production-default pin).
 *
 * Everything here is pure logic and runs on EVERY OS (win32/macOS included —
 * the thing the old monkeypatch could not promise): no process is ever
 * signalled (the signal sender is a spy), no `/proc` is read (identity/env/tty
 * readers are injected), and the single real probe is the "recorded parent is
 * dead" fixture pid, which is asserted dead before use.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
	__resetArmedEscalationsForTest,
	__resetSelfIdentityForTest,
	__setSelfIdentityForTest,
	reapGroup,
} from "../../../../src/runtime/process/reap-group.ts";
import {
	__resetSignalledGroupsForTest,
	buildProcSnapshot,
	collectRunDescendants,
	type ProcSnapshot,
	type ProcSnapshotEntry,
	type RunMarkers,
	reapRunDescendants,
	type SweepOptions,
} from "../../../../src/runtime/process/run-descendant-sweep.ts";

/** The real uid, or undefined on a runtime without `process.getuid` (win32). */
const realUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/**
 * A uid that is PROVABLY not the host's real uid — required by (u2b): the only
 * way to prove the group path consumed the injected value is to make the
 * "injected" and "real" verdicts differ. With `FAKE_UID === realUid()` a green
 * result would be indistinguishable from a missing propagation.
 */
const FAKE_UID: number = (() => {
	const real = realUid();
	let candidate = 7000;
	while (candidate === real) candidate += 1;
	return candidate;
})();

/** A pgid no real process owns (rung 2 accepts it: integer > 1). */
const FAKE_PGID = 900_601;
/** Our synthetic self pgid — never `FAKE_PGID`. */
const SELF_PGID = 4_000_001;
/** A pid that is provably not in use — the "recorded parent is dead" fixture. */
const DEAD_PID = 999_991;
/** Candidate pids no real process owns. */
const PID_A = 601;
const PID_B = 602;

/** Env keys the sweep's guards read; a worker shell leaks all of them. */
const GUARD_ENV_KEYS = ["PI_CREW_KIND", "PI_CREW_DEPTH", "PI_TEAMS_DEPTH", "PI_CREW_REAP_RUN_DESCENDANTS"] as const;
let savedEnv: Record<string, string | undefined> = {};

function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

beforeEach(() => {
	__resetSignalledGroupsForTest();
	__resetArmedEscalationsForTest();
	// Rungs 1/3 read OUR identity from /proc and the per-call reader may NOT
	// vouch for it (CRITICAL #1), so seed a synthetic self identity: that is what
	// makes the ladder deterministic on Linux and reachable at all on macOS/win32.
	__resetSelfIdentityForTest();
	__setSelfIdentityForTest({ pid: process.pid, pgid: SELF_PGID, starttime: "1", uid: FAKE_UID });
	// The sweep's guards read ambient PI_CREW_* env (this suite is routinely run
	// from inside a pi-crew worker) — scrub, then force the kill switch ON.
	savedEnv = {};
	for (const key of GUARD_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.PI_CREW_REAP_RUN_DESCENDANTS = "1";
	assert.equal(pidIsAlive(DEAD_PID), false, `fixture assumes pid ${DEAD_PID} is dead`);
});

afterEach(() => {
	for (const key of GUARD_ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	__resetSelfIdentityForTest();
	__resetSignalledGroupsForTest();
	__resetArmedEscalationsForTest();
});

// ── u1: the group ladder reads the injected uid ─────────────────────────────

test("(u1a) reapGroup: identity uid ≠ injected getuid ⇒ refused `uid-mismatch`, nothing signalled", () => {
	const signals: { pgid: number; signal: NodeJS.Signals }[] = [];
	const result = reapGroup(FAKE_PGID, FAKE_PGID, {
		getuid: () => FAKE_UID,
		readIdentity: (pid) => ({ pid, pgid: FAKE_PGID, starttime: "11", uid: FAKE_UID + 1 }),
		signalGroup: (pgid, signal) => signals.push({ pgid, signal }),
		groupAlive: () => true,
		platform: "linux",
	});
	assert.equal(result.outcome, "refused");
	assert.equal(result.refusal, "uid-mismatch");
	assert.deepEqual(signals, [], "a refused group must receive NO signal — not even SIGTERM");
});

test("(u1b) reapGroup: identity uid === injected getuid ⇒ accepted, SIGTERM delivered", () => {
	const signals: { pgid: number; signal: NodeJS.Signals }[] = [];
	const result = reapGroup(FAKE_PGID, FAKE_PGID, {
		getuid: () => FAKE_UID,
		readIdentity: (pid) => ({ pid, pgid: FAKE_PGID, starttime: "11", uid: FAKE_UID }),
		signalGroup: (pgid, signal) => signals.push({ pgid, signal }),
		// Gone right after the SIGTERM ⇒ no escalation is armed, no timer is used.
		groupAlive: () => false,
		platform: "linux",
	});
	assert.equal(result.refusal, undefined);
	assert.equal(result.outcome, "gone");
	assert.deepEqual(signals, [{ pgid: FAKE_PGID, signal: "SIGTERM" }]);
});

test("(u1c) reapGroup: the seam is read PER CALL, never cached", () => {
	// Same identity, two different injected uids: the second call must be judged
	// by ITS uid (a cached value would let (1)'s match leak into (2)).
	const identity = (pid: number) => ({ pid, pgid: FAKE_PGID, starttime: "11", uid: FAKE_UID });
	const base = { readIdentity: identity, signalGroup: () => undefined, groupAlive: () => false, platform: "linux" as const };
	assert.equal(reapGroup(FAKE_PGID, FAKE_PGID, { ...base, getuid: () => FAKE_UID }).refusal, undefined);
	__resetSignalledGroupsForTest();
	assert.equal(reapGroup(FAKE_PGID, FAKE_PGID, { ...base, getuid: () => FAKE_UID + 3 }).refusal, "uid-mismatch");
});

// ── u2: the sweep honours the seam on BOTH halves ───────────────────────────

const STARTED_AT_MS = 1_000_000;

interface FakeProc {
	pid: number;
	pgid?: number;
	starttime?: string;
	uid?: number;
	env?: Record<string, string>;
}

interface FakeSweep {
	opts: SweepOptions;
	signals: { pgid: number; signal: NodeJS.Signals }[];
	envReads: number[];
}

/** Synthetic /proc over a fixed pid table (no real `/proc` is ever read). */
function fakeSweep(procs: FakeProc[], getuid: (() => number | undefined) | undefined): FakeSweep {
	const identities = new Map(
		procs.map((proc) => [proc.pid, { pid: proc.pid, pgid: proc.pgid, starttime: proc.starttime, uid: proc.uid ?? FAKE_UID }]),
	);
	const envs = new Map(procs.map((proc) => [proc.pid, proc.env ?? {}]));
	const signals: { pgid: number; signal: NodeJS.Signals }[] = [];
	const envReads: number[] = [];
	const opts: SweepOptions = {
		listPids: () => procs.map((proc) => proc.pid),
		readIdentity: (pid) => identities.get(pid),
		readEnviron: (pid) => {
			envReads.push(pid);
			return envs.get(pid);
		},
		readTtyNr: () => 0,
		killGroup: (pgid, signal) => signals.push({ pgid, signal }),
		groupAlive: () => false,
		candidateStartMs: (identity) => (identity.starttime === undefined ? undefined : Number(identity.starttime)),
		platform: "linux",
		// `undefined` ⇒ the option is OMITTED (the production default is exercised).
		...(getuid === undefined ? {} : { getuid }),
	};
	return { opts, signals, envReads };
}

/** Markers for the synthetic run below: the dead recorded parent is DEAD_PID. */
function markers(): RunMarkers {
	return {
		runId: "team_test_12b",
		workerPids: [DEAD_PID],
		taskIds: ["01_01-agent"],
		startedAtMs: STARTED_AT_MS,
	};
}

/** The incident shape: a leaked process whose recorded parent is already gone. */
function leak(pid: number, pgid: number, uid?: number): FakeProc {
	return {
		pid,
		pgid,
		starttime: String(STARTED_AT_MS + 5_000),
		...(uid === undefined ? {} : { uid }),
		env: { PI_CREW_PARENT_PID: String(DEAD_PID) },
	};
}

test("(u2a) discovery: a candidate whose uid ≠ the injected getuid is dropped by the uid rung", () => {
	const sweep = fakeSweep([leak(PID_A, 900_611), leak(PID_B, 900_612, FAKE_UID + 1)], () => FAKE_UID);
	const found = collectRunDescendants(markers(), sweep.opts);
	assert.deepEqual(
		found.map((descendant) => descendant.pid),
		[PID_A],
		"only the candidate matching the INJECTED uid survives",
	);
	assert.deepEqual(sweep.signals, [], "discovery never signals");
});

test("(u2b) SPLIT-BRAIN RULE: the injected uid reaches the reapGroup call site (group IS signalled)", () => {
	// `FAKE_UID` is provably not the host uid. Had `reapRunDescendants` forwarded
	// the seam to discovery only, the candidate would be proven under one uid
	// policy and executed under another: the ladder would refuse with
	// `uid-mismatch` and skip the group. The SIGTERM recorded below is therefore
	// the propagation proof, not a coincidence.
	assert.notEqual(FAKE_UID, realUid(), "FAKE_UID must differ from the real uid for this proof to hold");
	const sweep = fakeSweep([leak(611, 900_621)], () => FAKE_UID);
	const result = reapRunDescendants(markers(), sweep.opts);
	assert.deepEqual(
		result.reaped.map((descendant) => descendant.pid),
		[611],
		"the discovered candidate must be REAPED, not refused one call deeper",
	);
	assert.deepEqual(result.skipped, [], "no `group-refused:uid-mismatch` skip may appear");
	assert.deepEqual(sweep.signals, [{ pgid: 900_621, signal: "SIGTERM" }]);
});

test("(u2c) getuid ⇒ undefined rejects every candidate (the win32 branch, unchanged)", () => {
	// Production never reaches this branch (the platform gate returns [] on any
	// non-Linux host), but the seam must reproduce the pre-existing behaviour
	// instead of inventing a new one.
	const sweep = fakeSweep([leak(621, 900_631)], () => undefined);
	assert.deepEqual(collectRunDescendants(markers(), sweep.opts), [], "an unknown self uid proves nothing about a candidate");
	const result = reapRunDescendants(markers(), sweep.opts);
	assert.deepEqual(result.reaped, []);
	assert.deepEqual(sweep.signals, []);
});

test("(u2d) the snapshot half consumes the same seam (env read only for the injected uid)", () => {
	// `buildProcSnapshot` decides whether `/proc/<pid>/environ` is consulted at
	// all (foreign uid ⇒ never), so it must read the SAME uid source.
	const sweep = fakeSweep([leak(PID_A, 900_641), leak(PID_B, 900_642, FAKE_UID + 1)], () => FAKE_UID);
	const snapshot: ProcSnapshot = buildProcSnapshot(sweep.opts);
	assert.deepEqual(snapshot.pids, [PID_A, PID_B]);
	assert.deepEqual(sweep.envReads, [PID_A], "only the pid matching the INJECTED uid has its env read");
	const entry: ProcSnapshotEntry | undefined = snapshot.entries.get(PID_B);
	assert.equal(entry?.environ, undefined, "a foreign-uid row carries no environ");
});

// ── u3: the production default is the REAL `process.getuid` ─────────────────

test("(u3a) no `getuid` ⇒ the ladder compares against the real process uid", () => {
	// Identity carries the REAL uid ⇒ the uid rung must pass and the ladder must
	// refuse LATER (group membership) instead of at `uid-mismatch`. Same verdict
	// on win32 (no real uid ⇒ the rung cannot fire), which is exactly what the
	// default must do there.
	const seen: NodeJS.Signals[] = [];
	const result = reapGroup(FAKE_PGID + 1, FAKE_PGID, {
		readIdentity: (pid) => ({ pid, pgid: FAKE_PGID, starttime: "11", uid: realUid() }),
		signalGroup: (_pgid, signal) => seen.push(signal),
		groupAlive: () => false,
		platform: "linux",
	});
	assert.equal(result.refusal, "not-group-member", "the real uid must match itself — the refusal comes from a later rung");
	assert.deepEqual(seen, [], "refused ⇒ nothing signalled");
});

test("(u3b) no `getuid` ⇒ a foreign uid is refused with `uid-mismatch` where a real uid exists", () => {
	const real = realUid();
	const foreign = real === undefined ? FAKE_UID : real + 1;
	const seen: NodeJS.Signals[] = [];
	const result = reapGroup(FAKE_PGID, FAKE_PGID, {
		readIdentity: (pid) => ({ pid, pgid: FAKE_PGID, starttime: "11", uid: foreign }),
		signalGroup: (_pgid, signal) => seen.push(signal),
		groupAlive: () => false,
		platform: "linux",
	});
	// Where `process.getuid` does not exist (win32) the rung cannot fire at all:
	// that IS the documented production behaviour of the default, so assert the
	// consequence (the group is accepted) rather than pretending otherwise.
	assert.equal(result.refusal, real === undefined ? undefined : "uid-mismatch");
	assert.equal(seen.length, real === undefined ? 1 : 0);
});

test("(u3c) `getuid: () => undefined` reproduces the win32 default exactly", () => {
	const live = { pid: FAKE_PGID, pgid: FAKE_PGID, starttime: "11", uid: FAKE_UID + 2 };
	const opts = { readIdentity: () => live, signalGroup: () => undefined, groupAlive: () => false, platform: "linux" as const };
	const explicit = reapGroup(FAKE_PGID, FAKE_PGID, { ...opts, getuid: () => undefined });
	assert.equal(explicit.refusal, undefined, "an unknown self uid cannot fire the uid rung");
	// On a runtime WITH a real getuid the omitted form differs by construction
	// (that is the point of the default) — compare only where they must agree.
	if (realUid() === undefined) assert.equal(reapGroup(FAKE_PGID, FAKE_PGID, opts).refusal, explicit.refusal);
});
