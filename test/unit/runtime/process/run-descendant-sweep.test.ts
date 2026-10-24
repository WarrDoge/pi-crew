/**
 * run-descendant-sweep.test.ts — fix-wave 11b (F7) pins for the run-scoped
 * descendant sweep.
 *
 * Two halves:
 *
 * A. INJECTED READS (no real process is ever signalled): one case per guard —
 *    marker priority (run-id / task-id / parent-pid), uid, self/ancestor,
 *    starttime-before-the-run, no-pgid, leader-alive-unmatched, one signal per
 *    GROUP, dryRun, the kill switch, idempotency across sweeps, and the
 *    no-marker regression (the test runner must never be a candidate).
 *
 * B. REAL TOPOLOGY (Linux only): `test/fixtures/marked-bash-tree.mjs` models pi's
 *    bash tool — a detached "command" (its own group leader) holding a
 *    grandchild, all carrying worker markers and a DEAD recorded parent. The
 *    test SIGKILLs the worker, then the sweep must find and reap the survivor by
 *    its markers (nothing else can: no group kill rooted at the worker reaches
 *    that group).
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import test, { after, afterEach, beforeEach } from "node:test";
import { __setSelfIdentityForTest, readProcIdentity } from "../../../../src/runtime/process/reap-group.ts";
import {
	__resetSignalledGroupsForTest,
	__signalledGroupCountForTest,
	buildProcSnapshot,
	collectRunDescendants,
	type RunDescendant,
	type RunMarkers,
	reapRunDescendants,
	type SweepOptions,
} from "../../../../src/runtime/process/run-descendant-sweep.ts";

const isLinux = process.platform === "linux";
const selfUid = (): number => (typeof process.getuid === "function" ? process.getuid() : 0);
/** A pid that is certainly not in use — the "recorded parent is dead" fixture. */
const DEAD_PID = 999_999;
/** A pid that is certainly not in use — the "dead surface pane" fixture (11b.4). */
const MEDIUM_3_PID = 999_998;
/** A pid that is certainly not in use — the "dead session pi" fixture (11c). */
const DEAD_SESSION_PID = 999_997;

// The suite's guards read ambient PI_CREW_* env — and `getCrewEnv` has no
// injectable seam for the kill-switch key. An ambient
// `PI_CREW_REAP_RUN_DESCENDANTS=0` (left exported by an off-path probe) made 17
// tests expect reaps that never happened, so the suite was only green on ONE of
// the two switch states the decision table demands. Pin "1" for every test
// ((a9) flips it to "0" itself) and restore the ambient value verbatim — the
// same save/restore pattern the stale-reconciler sweep suite uses for its
// guard keys (wave 11c battery finding F1).
let savedReapRunDescendants: string | undefined;

// reap-group's ladder reads OUR identity from /proc. On a platform without
// /proc (macOS) every group signal would short-circuit at `proc-unavailable`,
// making the accepted-path cases untestable there. Seed a synthetic self
// identity on exactly those platforms (a no-op on Linux).
beforeEach(() => {
	savedReapRunDescendants = process.env.PI_CREW_REAP_RUN_DESCENDANTS;
	process.env.PI_CREW_REAP_RUN_DESCENDANTS = "1";
	__resetSignalledGroupsForTest();
	if (readProcIdentity(process.pid) === undefined) {
		__setSelfIdentityForTest({ pid: process.pid, pgid: 4_000_001, starttime: "1", uid: selfUid() });
	}
});

afterEach(() => {
	if (savedReapRunDescendants === undefined) delete process.env.PI_CREW_REAP_RUN_DESCENDANTS;
	else process.env.PI_CREW_REAP_RUN_DESCENDANTS = savedReapRunDescendants;
});

/** One synthetic /proc row. */
interface FakeProc {
	pid: number;
	pgid?: number;
	starttime?: string;
	uid?: number;
	env?: Record<string, string>;
	/** `/proc/<pid>/stat` field 7 — undefined/0 ⇒ no controlling terminal. */
	tty?: number;
}

interface FakeSweep {
	opts: SweepOptions;
	kills: { pgid: number; signal: NodeJS.Signals }[];
}

/**
 * Build injected readers over a fixed pid table. `candidateStartMs` treats the
 * starttime string as an epoch-ms number so the run-window guard stays readable
 * (real /proc starttime is ticks-since-boot, converted through /proc/uptime).
 */
function fakeSweep(procs: FakeProc[], nowMs: number): FakeSweep {
	const identities = new Map(
		procs.map((proc) => [proc.pid, { pid: proc.pid, pgid: proc.pgid, starttime: proc.starttime, uid: proc.uid ?? selfUid() }]),
	);
	const envs = new Map(procs.map((proc) => [proc.pid, proc.env ?? {}]));
	const ttys = new Map(procs.filter((proc) => proc.tty !== undefined).map((proc) => [proc.pid, proc.tty as number]));
	const kills: { pgid: number; signal: NodeJS.Signals }[] = [];
	const opts: SweepOptions = {
		listPids: () => procs.map((proc) => proc.pid),
		readIdentity: (pid) => identities.get(pid),
		readEnviron: (pid) => envs.get(pid),
		readTtyNr: (pid) => ttys.get(pid),
		killGroup: (pgid, signal) => kills.push({ pgid, signal }),
		groupAlive: () => false,
		candidateStartMs: (identity) => (identity.starttime === undefined ? undefined : Number(identity.starttime)),
		platform: "linux",
	};
	void nowMs;
	return { opts, kills };
}

const STARTED_AT_MS = 1_000_000;

/** Markers for the synthetic runs below; the dead recorded parent is DEAD_PID. */
function markers(overrides: Partial<RunMarkers> = {}): RunMarkers {
	return {
		runId: "team_test_11b",
		runnerPid: DEAD_PID,
		workerPids: [],
		taskIds: ["01_01-agent"],
		startedAtMs: STARTED_AT_MS,
		...overrides,
	};
}

/** A candidate that started well inside the run window. */
function inside(proc: FakeProc): FakeProc {
	return { starttime: String(STARTED_AT_MS + 5_000), ...proc };
}

/**
 * A candidate that started well inside the run window, carrying the run-id
 * marker AND the descent proof 11b.4 requires with it: `PI_CREW_PARENT_PID` is
 * the recorded runner pid (`DEAD_PID`), which is dead. Before 11b.4 the run-id
 * marker alone was enough — see the (a16) block for why it no longer is.
 */
function withRun(pid: number, pgid: number): FakeProc {
	return inside({
		pid,
		pgid,
		env: { PI_CREW_BROKER_RUN_ID: "team_test_11b", PI_CREW_PARENT_PID: String(DEAD_PID) },
	});
}

const pids = (descendants: RunDescendant[]): number[] => descendants.map((descendant) => descendant.pid);

// ── A1. marker priority ─────────────────────────────────────────────────────

test("(a1) run-id marker matches by PI_CREW_BROKER_RUN_ID", () => {
	const { opts } = fakeSweep(
		[
			withRun(501, 900_501),
			// Different run id — never a candidate.
			inside({ pid: 502, pgid: 900_502, env: { PI_CREW_BROKER_RUN_ID: "team_other" } }),
		],
		STARTED_AT_MS,
	);
	const found = collectRunDescendants(markers(), opts);
	assert.deepEqual(pids(found), [501]);
	assert.equal(found[0]?.matchedBy, "run-id");
});

test("(a2) task-id marker needs KIND=subagent + recorded task + recorded parent", () => {
	const { opts } = fakeSweep(
		[
			inside({
				pid: 511,
				pgid: 900_511,
				env: { PI_CREW_KIND: "subagent", PI_CREW_TASK_ID: "01_01-agent", PI_CREW_PARENT_PID: String(DEAD_PID) },
			}),
			// Same task id but a parent that belongs to no run ⇒ no proof of descent.
			inside({
				pid: 512,
				pgid: 900_512,
				env: { PI_CREW_KIND: "subagent", PI_CREW_TASK_ID: "01_01-agent", PI_CREW_PARENT_PID: "424242" },
			}),
			// Parent matches but the task is not part of the run.
			inside({
				pid: 513,
				pgid: 900_513,
				env: { PI_CREW_KIND: "subagent", PI_CREW_TASK_ID: "99_99-other", PI_CREW_PARENT_PID: String(DEAD_PID) },
			}),
		],
		STARTED_AT_MS,
	);
	const found = collectRunDescendants(markers(), opts);
	assert.deepEqual(pids(found), [511]);
	assert.equal(found[0]?.matchedBy, "task-id");
});

test("(a3) parent-pid marker: PI_CREW_PARENT_PID is a recorded WORKER pid and it is dead", () => {
	const workerPid = DEAD_PID;
	assert.equal(
		(() => {
			try {
				process.kill(workerPid, 0);
				return true;
			} catch {
				return false;
			}
		})(),
		false,
		`fixture assumes pid ${workerPid} is dead`,
	);
	const { opts } = fakeSweep(
		[
			inside({ pid: 521, pgid: 900_521, env: { PI_CREW_PARENT_PID: String(workerPid) } }),
			// The legacy zombie shape: parent recorded but NOT a worker of this run.
			inside({ pid: 522, pgid: 900_522, env: { PI_CREW_PARENT_PID: "424242" } }),
		],
		STARTED_AT_MS,
	);
	const found = collectRunDescendants(markers({ workerPids: [workerPid], runnerPid: undefined }), opts);
	assert.deepEqual(pids(found), [521]);
	assert.equal(found[0]?.matchedBy, "parent-pid");
});

// ── A2. discovery rejections ────────────────────────────────────────────────

test("(a4) foreign uid, self, ancestors and pre-run starttimes are never candidates", () => {
	const { opts } = fakeSweep(
		[
			// Foreign uid (uid + 1 ⇒ provably not ours).
			inside({ pid: 531, pgid: 900_531, uid: selfUid() + 1, env: { PI_CREW_BROKER_RUN_ID: "team_test_11b" } }),
			// Ourselves and our parent — hosts of this session, never candidates.
			inside({ pid: process.pid, pgid: 900_532, env: { PI_CREW_BROKER_RUN_ID: "team_test_11b" } }),
			inside({ pid: process.ppid, pgid: 900_533, env: { PI_CREW_BROKER_RUN_ID: "team_test_11b" } }),
			// Started long before the run ⇒ cannot belong to it.
			{
				pid: 534,
				pgid: 900_534,
				starttime: String(STARTED_AT_MS - 120_000),
				env: { PI_CREW_BROKER_RUN_ID: "team_test_11b" },
			},
			// No starttime at all ⇒ identity unprovable.
			{ pid: 535, pgid: 900_535, env: { PI_CREW_BROKER_RUN_ID: "team_test_11b" } },
			// The one legitimate candidate.
			withRun(536, 900_536),
		],
		STARTED_AT_MS,
	);
	assert.deepEqual(pids(collectRunDescendants(markers(), opts)), [536]);
});

test("(a5) pgid undefined or <= 1 ⇒ skipped as no-pgid, never signalled individually", () => {
	// Both candidates carry the run marker AND the dead recorded parent, so they
	// ARE proven descendants — the no-pgid skip is what stops the signal: 541 has
	// no group of its own and 542 sits in pgid 1 (init's group), neither of which
	// may ever be signalled.
	const { opts, kills } = fakeSweep(
		[
			inside({ pid: 541, env: { PI_CREW_BROKER_RUN_ID: "team_test_11b", PI_CREW_PARENT_PID: String(DEAD_PID) } }),
			inside({
				pid: 542,
				pgid: 1,
				env: { PI_CREW_BROKER_RUN_ID: "team_test_11b", PI_CREW_PARENT_PID: String(DEAD_PID) },
			}),
		],
		STARTED_AT_MS,
	);
	assert.deepEqual(pids(collectRunDescendants(markers(), opts)), [541, 542], "both are proven descendants");
	const result = reapRunDescendants(markers(), opts);
	assert.deepEqual(pids(result.descendants), [541, 542], "discovery still reports them");
	assert.deepEqual(result.skipped, [
		{ pid: 541, reason: "no-pgid" },
		{ pid: 542, reason: "no-pgid" },
	]);
	assert.deepEqual(result.reaped, []);
	assert.equal(kills.length, 0);
});

// ── A3. leader guards ───────────────────────────────────────────────────────

test("(a6) a live leader that carries no marker blocks the group (leader-alive-unmatched)", () => {
	const { opts, kills } = fakeSweep(
		[
			// Group leader 900_601 is alive and marker-less — someone's live session.
			inside({ pid: 900_601, pgid: 900_601, env: {} }),
			withRun(601, 900_601),
		],
		STARTED_AT_MS,
	);
	const result = reapRunDescendants(markers(), opts);
	assert.deepEqual(result.skipped, [{ pid: 601, reason: "leader-alive-unmatched" }]);
	assert.deepEqual(result.reaped, []);
	assert.deepEqual(kills, [], "a live unmatched leader must never be signalled");
});

test("(a7) a dead leader is not an obstacle: exactly ONE SIGTERM per group", () => {
	const { opts, kills } = fakeSweep(
		[
			// Two grandchildren in the SAME group (one bash command), leader gone.
			withRun(611, 900_611),
			withRun(612, 900_611),
		],
		STARTED_AT_MS,
	);
	const result = reapRunDescendants(markers(), opts);
	assert.deepEqual(pids(result.reaped), [611, 612], "both candidates are reported as reaped");
	assert.deepEqual(kills, [{ pgid: 900_611, signal: "SIGTERM" }], "the group is signalled once, never per pid");
});

test("(a8) dryRun reports the candidates and signals nothing", () => {
	const { opts, kills } = fakeSweep([withRun(621, 900_621)], STARTED_AT_MS);
	const result = reapRunDescendants(markers(), { ...opts, dryRun: true });
	assert.deepEqual(pids(result.descendants), [621]);
	assert.deepEqual(result.reaped, []);
	assert.deepEqual(result.skipped, [{ pid: 621, reason: "dry-run" }]);
	assert.deepEqual(kills, []);
});

// ── A4. kill switch + idempotency ───────────────────────────────────────────

test("(a9) PI_CREW_REAP_RUN_DESCENDANTS=0 makes collect and reap complete no-ops", () => {
	const { opts, kills } = fakeSweep([withRun(631, 900_631)], STARTED_AT_MS);
	// `getCrewEnv` has no injectable seam for this key: set + restore.
	const saved = process.env.PI_CREW_REAP_RUN_DESCENDANTS;
	process.env.PI_CREW_REAP_RUN_DESCENDANTS = "0";
	try {
		assert.deepEqual(collectRunDescendants(markers(), opts), []);
		const result = reapRunDescendants(markers(), opts);
		assert.deepEqual(result.reaped, []);
		assert.deepEqual(result.skipped, []);
		assert.deepEqual(result.pending, []);
		assert.equal(kills.length, 0);
	} finally {
		if (saved === undefined) delete process.env.PI_CREW_REAP_RUN_DESCENDANTS;
		else process.env.PI_CREW_REAP_RUN_DESCENDANTS = saved;
	}
});

test("(a10) a second sweep over the same readers signals nothing (idempotent)", () => {
	const { opts, kills } = fakeSweep([withRun(641, 900_641)], STARTED_AT_MS);
	const first = reapRunDescendants(markers(), opts);
	assert.equal(first.reaped.length, 1);
	assert.equal(kills.length, 1);
	assert.equal(__signalledGroupCountForTest(), 1);
	const second = reapRunDescendants(markers(), opts);
	assert.deepEqual(second.reaped, []);
	assert.deepEqual(second.skipped, [{ pid: 641, reason: "already-swept" }]);
	assert.equal(kills.length, 1, "the group must not be signalled twice");
});

test("(a11) a group-refused candidate is not remembered, so the next sweep retries", () => {
	const procs = [withRun(651, 900_651)];
	const { opts, kills } = fakeSweep(procs, STARTED_AT_MS);
	// A platform the ladder refuses outright (win32 ⇒ platform-not-posix).
	const refused = reapRunDescendants(markers(), { ...opts, platform: "win32" });
	assert.deepEqual(refused.reaped, []);
	assert.deepEqual(kills, []);
	// The refusal must not burn the idempotency key: a valid platform still reaps.
	const accepted = reapRunDescendants(markers(), opts);
	assert.deepEqual(pids(accepted.reaped), [651]);
	assert.deepEqual(kills, [{ pgid: 900_651, signal: "SIGTERM" }]);
});

// ── A5. no-marker regression ────────────────────────────────────────────────

test("(a12) a process without a run marker is never a candidate — and never signalled", () => {
	const { opts, kills } = fakeSweep(
		[
			// No markers at all (the test runner's own shape).
			inside({ pid: 661, pgid: 900_661, env: {} }),
			// Markers of a DIFFERENT run.
			inside({
				pid: 662,
				pgid: 900_662,
				env: {
					PI_CREW_KIND: "subagent",
					PI_CREW_TASK_ID: "01_01-agent",
					PI_CREW_PARENT_PID: "424242",
					PI_CREW_BROKER_RUN_ID: "team_other",
				},
			}),
		],
		STARTED_AT_MS,
	);
	const result = reapRunDescendants(markers(), opts);
	assert.deepEqual(result.descendants, []);
	assert.deepEqual(result.reaped, []);
	assert.deepEqual(result.skipped, []);
	assert.deepEqual(kills, []);
});

// ── A5b. per-candidate proof (wave 11b.1: the all-or-nothing gate is gone) ───

/** A real, live child process — the "recorded pid is still running" fixture. */
async function spawnLivePid(): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", () => resolve());
		child.once("error", reject);
	});
	return child;
}

test("(a13) task-id needs a DEAD recorded parent — a live one may still be doing its work", async () => {
	const child = await spawnLivePid();
	try {
		const liveParent = child.pid;
		assert.ok(typeof liveParent === "number", "the fixture parent must have a pid");
		const { opts } = fakeSweep(
			[
				inside({
					pid: 671,
					pgid: 900_671,
					env: { PI_CREW_KIND: "subagent", PI_CREW_TASK_ID: "01_01-agent", PI_CREW_PARENT_PID: String(liveParent) },
				}),
			],
			STARTED_AT_MS,
		);
		const found = collectRunDescendants(markers({ workerPids: [liveParent], runnerPid: undefined }), opts);
		assert.deepEqual(pids(found), [], "a live recorded parent means the candidate is not (yet) an orphan");
	} finally {
		child.kill("SIGKILL");
	}
});

test("(a14) a recorded ancestor is never a candidate, even while it is alive", async () => {
	const child = await spawnLivePid();
	try {
		const liveWorker = child.pid;
		assert.ok(typeof liveWorker === "number", "the fixture worker must have a pid");
		const { opts, kills } = fakeSweep(
			[
				// The live recorded worker itself carries the run marker (every worker
				// gets PI_CREW_BROKER_RUN_ID) — it must be excluded by PID, not by death.
				withRun(liveWorker, 900_681),
				// Its leaked grandchild, own group, same run marker, and the recorded
				// runner as its (dead) parent — the descent proof 11b.4 requires.
				withRun(682, 900_682),
			],
			STARTED_AT_MS,
		);
		// The recorded worker stays in the markers (exclusion is by PID, not by
		// death); the recorded runner is the dead parent the grandchild names.
		const result = reapRunDescendants(markers({ workerPids: [liveWorker] }), opts);
		assert.deepEqual(pids(result.descendants), [682], "only the descendant is a candidate");
		assert.deepEqual(kills, [{ pgid: 900_682, signal: "SIGTERM" }], "the live worker's group is never signalled");
	} finally {
		child.kill("SIGKILL");
	}
});

// ── A5c. recorded surface panes (wave 11b.3) ────────────────────────

test("(a15) a LIVE recorded surface pane pid is never a candidate; a dead one has nothing to reap", async () => {
	const child = await spawnLivePid();
	try {
		const livePane = child.pid;
		assert.ok(typeof livePane === "number", "the fixture pane must have a pid");
		assert.equal(pidAlive(livePane), true, "fixture precondition: the recorded pane pid is alive");
		const procs = [
			// The pane the operator may still be watching. It carries the run marker
			// (every worker gets PI_CREW_BROKER_RUN_ID) ⇒ it WOULD match by run-id.
			withRun(livePane, 900_691),
			// A genuine leak of the same run, in its own group.
			withRun(692, 900_692),
		];

		// Control: with no surface knowledge this live pid IS collected — that is
		// exactly what the exclusion has to prevent.
		const control = fakeSweep(procs, STARTED_AT_MS);
		assert.deepEqual(pids(collectRunDescendants(markers(), control.opts)), [livePane, 692]);

		const { opts, kills } = fakeSweep(procs, STARTED_AT_MS);
		// DEAD_PID stands for a pane that has already exited: a dead pid has no
		// /proc entry, so it is never enumerated and never appears in the report.
		const result = reapRunDescendants(markers({ surfacePids: [livePane, DEAD_PID] }), opts);

		assert.deepEqual(pids(result.descendants), [692], "only the real leak is reported — the live pane is not a descendant");
		assert.deepEqual(pids(result.reaped), [692]);
		assert.deepEqual(kills, [{ pgid: 900_692, signal: "SIGTERM" }], "the live pane's group is never signalled");
		assert.ok(!pids(result.descendants).includes(DEAD_PID), "a dead surface pid is absent from the report (nothing to reap)");
		assert.ok(!result.skipped.some((skip) => skip.pid === DEAD_PID));
		assert.equal(pidAlive(livePane), true, "the operator's pane survives the sweep");
	} finally {
		child.kill("SIGKILL");
	}
});

// ── A5d. descent proof for the run-id marker (wave 11b.4, HIGH-1) ─────────

test("(a16) the run-id marker alone is NOT descent proof — a dead recorded parent is required", async () => {
	const child = await spawnLivePid();
	try {
		const liveParent = child.pid;
		assert.ok(typeof liveParent === "number", "the fixture parent must have a pid");
		const runEnv = { PI_CREW_BROKER_RUN_ID: "team_test_11b" };
		const { opts, kills } = fakeSweep(
			[
				// The incident shape: inherited env + a recorded parent (the runner) that
				// is already dead ⇒ provably an orphan of THIS run.
				withRun(701, 900_701),
				// A live recorded parent: the process may still be doing that run's work.
				inside({ pid: 702, pgid: 900_702, env: { ...runEnv, PI_CREW_PARENT_PID: String(liveParent) } }),
				// No PI_CREW_PARENT_PID at all: an operator shell (or a service the run
				// left behind) that merely INHERITED the env. Nothing proves descent.
				inside({ pid: 703, pgid: 900_703, env: runEnv }),
				// A parent this run never recorded — someone else's tree entirely.
				inside({ pid: 704, pgid: 900_704, env: { ...runEnv, PI_CREW_PARENT_PID: "424242" } }),
			],
			STARTED_AT_MS,
		);
		const withLiveWorker = markers({ workerPids: [liveParent] });
		const found = collectRunDescendants(withLiveWorker, opts);
		assert.deepEqual(pids(found), [701], "only the candidate with a DEAD recorded parent is collected");
		assert.equal(found[0]?.matchedBy, "run-id");
		assert.deepEqual(kills, [], "collect never signals");
		const result = reapRunDescendants(withLiveWorker, opts);
		assert.deepEqual(kills, [{ pgid: 900_701, signal: "SIGTERM" }], "the operator shell's group is never signalled");
		assert.deepEqual(pids(result.reaped), [701]);
	} finally {
		child.kill("SIGKILL");
	}
});

test("(a17) a recorded surface pane pid is an accepted proof parent once it is dead (MEDIUM-3 guard)", () => {
	assert.equal(pidAlive(MEDIUM_3_PID), false, `fixture assumes pid ${MEDIUM_3_PID} is dead`);
	const { opts } = fakeSweep(
		[
			inside({
				pid: 721,
				pgid: 900_721,
				env: { PI_CREW_BROKER_RUN_ID: "team_test_11b", PI_CREW_PARENT_PID: String(MEDIUM_3_PID) },
			}),
		],
		STARTED_AT_MS,
	);
	// No recorded parent and no surface pid ⇒ no proof ⇒ not a candidate.
	const unproven = markers({ runnerPid: undefined });
	assert.deepEqual(pids(collectRunDescendants(unproven, opts)), []);
	// Recorded as a surface pane pid (and dead) ⇒ descent is provable. Today this
	// set is redundant with the recorded parents; it is kept as a guard in case
	// surface pids ever diverge from what the tasks recorded.
	const proven = markers({ runnerPid: undefined, surfacePids: [MEDIUM_3_PID] });
	assert.deepEqual(pids(collectRunDescendants(proven, opts)), [721]);
});

// ── A5e. interactive candidates (wave 11b.4, safety rung 12) ───────────────

test("(a18) a candidate holding a controlling terminal is skipped as interactive-tty and never signalled", () => {
	const { opts, kills } = fakeSweep(
		[
			// The operator's shell inside a pane: its markers DO match (dead recorded
			// parent), but it is attached to a terminal ⇒ rung 12 keeps it alive.
			{ ...withRun(731, 900_731), tty: 34_816 },
			// Control: the same shape with no terminal (a detached server) is reaped.
			withRun(732, 900_732),
		],
		STARTED_AT_MS,
	);
	const result = reapRunDescendants(markers(), opts);
	assert.deepEqual(pids(result.descendants), [731, 732], "discovery reports both — the doctor must still show them");
	assert.equal(result.descendants.find((descendant) => descendant.pid === 731)?.ttyNr, 34_816, "the tty is reported");
	assert.deepEqual(pids(result.reaped), [732]);
	assert.deepEqual(result.skipped, [{ pid: 731, reason: "interactive-tty" }]);
	assert.deepEqual(kills, [{ pgid: 900_732, signal: "SIGTERM" }], "the interactive group is never signalled");
});

// ── A6. one /proc snapshot per pass (wave 11b.4, LOW-4) ────

test("(a19) one snapshot serves N sweeps in a pass; without a snapshot each sweep reads /proc", () => {
	let scans = 0;
	const runs = [
		{ runId: "team_pass_a", pid: 741, pgid: 900_741 },
		{ runId: "team_pass_b", pid: 742, pgid: 900_742 },
		{ runId: "team_pass_c", pid: 743, pgid: 900_743 },
	];
	const { opts } = fakeSweep(
		runs.map((run) =>
			inside({ pid: run.pid, pgid: run.pgid, env: { PI_CREW_BROKER_RUN_ID: run.runId, PI_CREW_PARENT_PID: String(DEAD_PID) } }),
		),
		STARTED_AT_MS,
	);
	// `listPids` is exactly the /proc enumeration the snapshot is built from, so
	// counting it IS "how many full /proc scans did this pass perform".
	const counting: SweepOptions = {
		...opts,
		listPids: () => {
			scans += 1;
			return runs.map((run) => run.pid);
		},
	};
	const snapshot = buildProcSnapshot(counting);
	assert.equal(scans, 1, "the pass pays for exactly ONE /proc enumeration");
	for (const run of runs) {
		const result = reapRunDescendants(markers({ runId: run.runId, workerPids: [], runnerPid: DEAD_PID }), {
			...counting,
			snapshot,
		});
		assert.deepEqual(pids(result.reaped), [run.pid], `${run.runId} reaps its own descendant from the shared snapshot`);
	}
	assert.equal(scans, 1, "N runs in one pass ⇒ ONE scan, not N (the 25-run budget used to be 25 full scans)");
	// No snapshot ⇒ one enumeration per sweep (the doctor path and the lone
	// reconciler call keep their pre-11b.4 behaviour).
	scans = 0;
	__resetSignalledGroupsForTest();
	for (const run of runs) {
		reapRunDescendants(markers({ runId: run.runId, workerPids: [], runnerPid: DEAD_PID }), counting);
	}
	assert.equal(scans, 3, "without a snapshot each sweep builds its own view");
});

// ── A7. wave 11c — the run's SPAWNER pid is a proof parent for SYNC runs ────

test("(a20) a recorded sessionPid proves descent for a SYNC run's leak — dead only, absent field unchanged", () => {
	const sessionPid = DEAD_SESSION_PID;
	// The fixture assumes the pid is not in use (the "session pi already exited"
	// shape) — same liveness check the other fixture pids get.
	assert.equal(
		(() => {
			try {
				process.kill(sessionPid, 0);
				return true;
			} catch {
				return false;
			}
		})(),
		false,
		`fixture assumes pid ${sessionPid} is dead`,
	);
	const leak = (pid: number, pgid: number, parentPid: string): FakeProc =>
		inside({ pid, pgid, env: { PI_CREW_BROKER_RUN_ID: "team_test_11b", PI_CREW_PARENT_PID: parentPid } });
	// A SYNC run: no runner pid recorded at all — the ONLY parent its leaked
	// bash grandchildren can name is the session pi that spawned the workers.
	const syncMarkers = (): RunMarkers => markers({ runnerPid: undefined, workerPids: [], sessionPid });
	// (i) the session pi is DEAD ⇒ the run-id + parent-pid pair is descent proof.
	const dead = fakeSweep([leak(751, 900_751, String(sessionPid))], STARTED_AT_MS);
	const found = collectRunDescendants(syncMarkers(), dead.opts);
	assert.deepEqual(pids(found), [751]);
	assert.equal(found[0]?.matchedBy, "run-id");
	// (ii) the session pi is ALIVE (ourselves — provably alive) ⇒ NOT proof: the
	// operator may still be typing in that very pi, so its name proves nothing.
	const alive = fakeSweep([leak(752, 900_752, String(process.pid))], STARTED_AT_MS);
	assert.deepEqual(collectRunDescendants(markers({ runnerPid: undefined, workerPids: [], sessionPid: process.pid }), alive.opts), []);
	// (iii) a pre-11c manifest has no sessionPid ⇒ same behaviour as before the
	// field existed: an unrecorded parent pid is not proof, the leak is skipped.
	const legacy = fakeSweep([leak(753, 900_753, String(sessionPid))], STARTED_AT_MS);
	assert.deepEqual(collectRunDescendants(markers({ runnerPid: undefined, workerPids: [] }), legacy.opts), []);
});

// ── B. real topology (pi bash tool shape) ────────────────────────────────────

const FIXTURE = path.join(import.meta.dirname, "..", "..", "..", "fixtures", "marked-bash-tree.mjs");

interface MarkedTree {
	worker: ChildProcess;
	bashLeader: number;
	grandkids: number[];
}

const spawned: ChildProcess[] = [];

function spawnMarkedTree(): Promise<MarkedTree> {
	return new Promise((resolve, reject) => {
		const worker = spawn(process.execPath, [FIXTURE], {
			detached: true, // this fixture stands in for the worker
			stdio: ["ignore", "pipe", "ignore"],
			env: {
				...process.env,
				// The markers a pi-crew worker leaves on every descendant.
				PI_CREW_KIND: "subagent",
				PI_CREW_TASK_ID: "01_01-agent",
				PI_CREW_PARENT_PID: String(DEAD_PID),
			},
			windowsHide: true,
		});
		spawned.push(worker);
		let buffer = "";
		const timer = setTimeout(() => reject(new Error("fixture did not report its tree in time")), 20_000);
		worker.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			clearTimeout(timer);
			try {
				const parsed = JSON.parse(buffer.slice(0, newline)) as { leader: number; grandkids: number[] };
				resolve({ worker, bashLeader: parsed.leader, grandkids: parsed.grandkids });
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
		worker.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

function killQuietly(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		/* already gone */
	}
}

function killGroupQuietly(pgid: number): void {
	if (!Number.isInteger(pgid) || pgid <= 1) return;
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {
		/* group already gone */
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForDeath(pid: number, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !pidAlive(pid);
}

/** Await a reap promise under a REF'd timer (the ladder's own timers are unref'd). */
function awaitWithKeepalive<T>(promise: Promise<T>): Promise<T> {
	const keepAlive = setInterval(() => {
		/* ref'd no-op: keeps the loop alive */
	}, 25);
	return promise.finally(() => clearInterval(keepAlive));
}

// Whatever happens above, no fixture process may survive this file.
after(() => {
	for (const worker of spawned) {
		if (worker.pid !== undefined) killGroupQuietly(worker.pid);
		if (worker.pid !== undefined) killQuietly(worker.pid, "SIGKILL");
	}
});

test("(b1) real tree: a detached bash grandchild is found by its markers and reaped", { skip: !isLinux }, async () => {
	const tree = await spawnMarkedTree();
	try {
		// The survivor shape: the worker is SIGKILLed, the bash command and its
		// grandchild live on in a group of their own (exactly the incident).
		const exited = new Promise((resolve) => tree.worker.once("exit", resolve));
		killQuietly(tree.worker.pid ?? 0, "SIGKILL");
		await exited;
		assert.equal(await waitForDeath(tree.worker.pid ?? 0), true, "worker must be gone before the sweep");

		const runMarkers: RunMarkers = {
			runId: "team_test_11b_real",
			runnerPid: DEAD_PID, // the recorded parent the survivors point at
			workerPids: [],
			taskIds: ["01_01-agent"],
			startedAtMs: Date.now() - 60_000,
		};
		const found = collectRunDescendants(runMarkers);
		const foundPids = pids(found);
		assert.ok(
			foundPids.includes(tree.bashLeader),
			`bash group leader ${tree.bashLeader} must be discovered (found: ${foundPids.join(",")})`,
		);
		for (const grandkid of tree.grandkids) {
			assert.ok(foundPids.includes(grandkid), `grandchild ${grandkid} must be discovered (found: ${foundPids.join(",")})`);
		}
		assert.ok(
			found.every((descendant) => descendant.matchedBy === "task-id"),
			"survivors are proven by the inherited task-id marker",
		);

		const result = reapRunDescendants(runMarkers);
		assert.ok(result.reaped.length >= 1, "the sweep must reap the surviving group");
		await awaitWithKeepalive(Promise.all(result.pending));
		for (const grandkid of tree.grandkids) {
			assert.equal(await waitForDeath(grandkid), true, `grandchild ${grandkid} must be gone after the sweep`);
		}
	} finally {
		killGroupQuietly(tree.bashLeader);
		for (const pid of [tree.bashLeader, ...tree.grandkids]) killQuietly(pid, "SIGKILL");
	}
});
