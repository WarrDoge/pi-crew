/**
 * stale-reconciler-run-descendant-sweep.test.ts — wave 11b.1 REACHABILITY pins.
 *
 * Wave 11b shipped the run-scoped descendant sweep with 13 green tests that only
 * exercised `run-descendant-sweep.ts` directly. The production wiring was
 * unreachable for the exact case that motivated the wave: the sweep was called
 * from `repairStaleRun`, which only runs after `checkResultFile` says "no result
 * file". Run `team_20261022110510_cefb9164af126460` was `completed` (result file
 * present) ⇒ Phase 1 returned `result_exists` ⇒ no sweep ⇒ all 6 grandchildren
 * survived. `crash-recovery` enumerates `running | blocked` only, so nothing
 * else reached it either.
 *
 * These tests are therefore RECONCILE-level: they drive `reconcileStaleRun` and
 * assert that the sweep RUNS (or never runs) for the right run state. The sweep
 * itself is swapped by the `__test.setReapRunDescendants` seam, and the swapped
 * implementation is the REAL `reapRunDescendants` fed synthetic /proc readers —
 * so marker matching, the leader guard and the reap ladder all still execute,
 * while every signal is recorded instead of sent. No real process is signalled.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { __resetSelfIdentityForTest, __setSelfIdentityForTest, readProcIdentity } from "../../../src/runtime/process/reap-group.ts";
import {
	__resetSignalledGroupsForTest,
	type RunMarkers,
	type RunSweepResult,
	reapRunDescendants,
	type SweepOptions,
} from "../../../src/runtime/process/run-descendant-sweep.ts";
import { __test, reconcileStaleRun } from "../../../src/runtime/stale-reconciler.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";

const RUN_ID = "team_run_sweep_11b1";
/** A pid that is provably not in use — the "recorded worker is dead" fixture. */
const DEAD_WORKER_PID = 999_996;
/** A pid that is provably not in use — the recorded async runner. */
const DEAD_RUNNER_PID = 999_997;
/** A pid that is provably not in use — the recorded sync-run spawner (11c). */
const DEAD_SESSION_PID = 999_995;
const selfUid = (): number => (typeof process.getuid === "function" ? process.getuid() : 0);

/**
 * The sweep's same-uid rung compares candidates against OUR real uid — there
 * is no seam for it. Windows has no getuid, so the src-side read is undefined
 * there and every candidate is rejected as unprovable (an unreachable
 * combination in production: the platform gate returns [] first on any
 * non-Linux host, but the fixtures inject `platform: "linux"`). Define a
 * synthetic uid for the lifetime of this FILE only (node:test isolates every
 * file in its own process) so the rung is exercised identically on every OS.
 * Restored in `after()`; a no-op where a real getuid exists.
 */
const hadRealGetuid = typeof process.getuid === "function";
if (!hadRealGetuid) {
	(process as { getuid?: () => number }).getuid = () => 0;
}
after(() => {
	if (!hadRealGetuid) delete (process as { getuid?: () => number }).getuid;
});

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

// The sweep's guards read ambient PI_CREW_* env, and this suite is routinely run
// from INSIDE a pi-crew worker (PI_CREW_KIND=subagent, PI_CREW_DEPTH>=1) — which
// would silently disable every sweep assertion. Scrub, then restore verbatim.
beforeEach(() => {
	__resetSignalledGroupsForTest();
	__resetSelfIdentityForTest();
	// reap-group's ladder reads OUR identity from /proc; on a platform without
	// /proc every accepted path would short-circuit at `proc-unavailable`.
	if (readProcIdentity(process.pid) === undefined) {
		__setSelfIdentityForTest({ pid: process.pid, pgid: 4_000_001, starttime: "1", uid: selfUid() });
	}
	savedEnv = {};
	for (const key of GUARD_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	assert.equal(pidIsAlive(DEAD_WORKER_PID), false, `fixture assumes pid ${DEAD_WORKER_PID} is dead`);
	assert.equal(pidIsAlive(DEAD_RUNNER_PID), false, `fixture assumes pid ${DEAD_RUNNER_PID} is dead`);
	assert.equal(pidIsAlive(DEAD_SESSION_PID), false, `fixture assumes pid ${DEAD_SESSION_PID} is dead`);
});

afterEach(() => {
	for (const key of GUARD_ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	__test.reset();
	__resetSignalledGroupsForTest();
	__resetSelfIdentityForTest();
});

// ── fixtures ────────────────────────────────────────────────────────────────

function makeStateRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-sweep-"));
}

function makeManifest(stateRoot: string, overrides: Partial<TeamRunManifest> = {}): TeamRunManifest {
	const created = new Date().toISOString();
	return {
		schemaVersion: 1,
		runId: RUN_ID,
		cwd: stateRoot,
		team: "impl",
		goal: "wave 11b.1 sweep reachability",
		status: "running",
		createdAt: created,
		updatedAt: created,
		stateRoot,
		artifactsRoot: stateRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		workspaceMode: "single",
		artifacts: [],
		...overrides,
	};
}

/** A finished task whose recorded worker is DEAD_WORKER_PID (the incident shape). */
function completedTask(workerPid: number, id = "01_01-agent"): TeamTaskState {
	return {
		id,
		runId: RUN_ID,
		role: "executor",
		agent: "test-agent",
		title: "finished task",
		status: "completed",
		dependsOn: [],
		cwd: "/tmp",
		heartbeat: { workerId: id, lastSeenAt: new Date().toISOString(), alive: false, pid: workerPid },
	};
}

/** A still-running task with a heartbeat frozen 20 min ago (stale-repair path). */
function staleRunningTask(workerPid: number): TeamTaskState {
	const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
	return {
		id: "01_01-agent",
		runId: RUN_ID,
		role: "executor",
		agent: "test-agent",
		title: "stale task",
		status: "running",
		dependsOn: [],
		cwd: "/tmp",
		heartbeat: { workerId: "01_01-agent", lastSeenAt: twentyMinAgo, alive: true, pid: workerPid },
	};
}

/** A genuinely live task with a fresh heartbeat (the "do not touch" shape). */
function liveRunningTask(): TeamTaskState {
	return {
		...staleRunningTask(process.pid),
		status: "running",
		heartbeat: { workerId: "01_01-agent", lastSeenAt: new Date().toISOString(), alive: true, pid: process.pid },
	};
}

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
 * Synthetic /proc over a fixed pid table. `candidateStartMs` reads the starttime
 * string as epoch-ms so the run-window guard stays readable — the reconcile path
 * derives `startedAtMs` from the manifest timestamp, so the fixtures below stamp
 * candidates a few seconds AFTER it.
 */
function fakeSweep(procs: FakeProc[]): FakeSweep {
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
	return { opts, kills };
}

/** Install the sweeping seam: record every call, then run the REAL sweep. */
function installSweepSeam(opts: SweepOptions): { calls: RunMarkers[]; results: RunSweepResult[] } {
	const calls: RunMarkers[] = [];
	const results: RunSweepResult[] = [];
	__test.setReapRunDescendants((markers) => {
		calls.push(markers);
		const result = reapRunDescendants(markers, opts);
		results.push(result);
		return result;
	});
	return { calls, results };
}

/** A candidate that started inside the run window (a few seconds after it). */
function insideRun(manifest: TeamRunManifest, proc: FakeProc): FakeProc {
	const runStart = Date.parse(manifest.async?.spawnedAt ?? manifest.createdAt);
	return { starttime: String(runStart + 5_000), ...proc };
}

// ── g1: the incident shape — a COMPLETED run is swept ────────────────────────

describe("wave 11b.1 — the sweep is reachable for a terminal run", () => {
	it("(g1) result_exists (run completed) STILL sweeps: the leak that started the wave is reaped", () => {
		const stateRoot = makeStateRoot();
		const created = new Date().toISOString();
		const manifest = makeManifest(stateRoot, {
			async: { pid: DEAD_RUNNER_PID, logPath: path.join(stateRoot, "runner.log"), spawnedAt: created },
			createdAt: created,
		});
		const leakedPid = 800_001;
		const { opts, kills } = fakeSweep([
			// The 24 h survivor: a bash grandchild of the DEAD worker, in its own
			// group (pi's bash tool spawns detached), carrying only the inherited
			// markers. `PI_CREW_PARENT_PID` is the recorded, dead worker.
			insideRun(manifest, { pid: leakedPid, pgid: 900_001, env: { PI_CREW_PARENT_PID: String(DEAD_WORKER_PID) } }),
		]);
		const { calls, results } = installSweepSeam(opts);
		try {
			const result = reconcileStaleRun(manifest, [completedTask(DEAD_WORKER_PID)], Date.now());
			assert.equal(result.verdict, "result_exists", "all tasks terminal ⇒ Phase 1 short-circuits (the pre-11b.1 dead end)");
			assert.equal(result.repaired, false);
			assert.equal(calls.length, 1, "the sweep MUST run on the result_exists path (this is the whole 11b.1 fix)");
			const markers = calls[0];
			assert.ok(markers !== undefined);
			assert.equal(markers.runId, RUN_ID);
			assert.deepEqual(markers.workerPids, [DEAD_WORKER_PID], "recorded worker pid comes from the task heartbeat");
			assert.equal(markers.runnerPid, DEAD_RUNNER_PID, "runner pid comes from manifest.async.pid");
			assert.deepEqual(markers.taskIds, ["01_01-agent"]);
			assert.equal(markers.startedAtMs, Date.parse(created));
			assert.equal(results[0]?.reaped.length, 1, "the leaked grandchild is reaped, not just discovered");
			assert.deepEqual(
				kills,
				[{ pgid: 900_001, signal: "SIGTERM" }],
				"its OWN group is signalled (a worker-rooted kill cannot reach it)",
			);
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("(g4) exactly ONE sweep per reconcile pass on the result_exists path", () => {
		const stateRoot = makeStateRoot();
		const manifest = makeManifest(stateRoot);
		const { opts } = fakeSweep([]);
		const { calls } = installSweepSeam(opts);
		try {
			reconcileStaleRun(manifest, [completedTask(DEAD_WORKER_PID)], Date.now());
			assert.equal(calls.length, 1, "two sweeps for one run would signal a group twice");
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("(g4-b) exactly ONE sweep per reconcile pass on the stale-repair path", () => {
		const stateRoot = makeStateRoot();
		const manifest = makeManifest(stateRoot);
		const { opts } = fakeSweep([]);
		const { calls } = installSweepSeam(opts);
		__test.setReapRecordedWorkerOrphans(() => ({ reaped: [], skipped: [], candidates: [], pending: [] }));
		try {
			const result = reconcileStaleRun(manifest, [staleRunningTask(DEAD_WORKER_PID)], Date.now());
			assert.equal(result.verdict, "no_status");
			assert.equal(result.repaired, true, "the stale task is cancelled, so the run is terminal for the sweep");
			assert.equal(calls.length, 1);
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	// ── g2: per-candidate proof replaces the all-or-nothing gate ──────────────

	it("(g2) a LIVE recorded worker no longer vetoes the sweep, and is never signalled", async () => {
		const stateRoot = makeStateRoot();
		const child: ChildProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
		try {
			await once(child, "spawn");
			const liveWorkerPid = child.pid;
			assert.ok(typeof liveWorkerPid === "number", "the fixture worker must have a pid");
			// The run also recorded a DETACHED runner, now dead — the descent proof the
			// leaked grandchild below names (11b.4 HIGH-1: the run-id marker alone is
			// not proof any more).
			const manifest = makeManifest(stateRoot, {
				async: { pid: DEAD_RUNNER_PID, logPath: path.join(stateRoot, "runner.log"), spawnedAt: new Date().toISOString() },
			});
			const leakedPid = 800_002;
			const workerPgid = 900_010;
			const { opts, kills } = fakeSweep([
				// The still-alive recorded worker — carries the run marker (every
				// worker gets PI_CREW_BROKER_RUN_ID) and is excluded by PID.
				insideRun(manifest, { pid: liveWorkerPid, pgid: workerPgid, env: { PI_CREW_BROKER_RUN_ID: RUN_ID } }),
				// The real leak: a grandchild of the run, own group, dead runner as parent.
				insideRun(manifest, {
					pid: leakedPid,
					pgid: 900_002,
					env: { PI_CREW_BROKER_RUN_ID: RUN_ID, PI_CREW_PARENT_PID: String(DEAD_RUNNER_PID) },
				}),
			]);
			const { calls, results } = installSweepSeam(opts);
			const liveTask = completedTask(liveWorkerPid);

			const result = reconcileStaleRun(manifest, [liveTask], Date.now());
			assert.equal(result.verdict, "result_exists");
			assert.equal(calls.length, 1, "a LIVE recorded pid must not abort the sweep (the pre-11b.1 all-or-nothing gate)");
			assert.deepEqual(
				results[0]?.reaped.map((descendant) => descendant.pid),
				[leakedPid],
				"only the descendant is reaped",
			);
			assert.deepEqual(kills, [{ pgid: 900_002, signal: "SIGTERM" }], "the live worker's group is never signalled");
			assert.equal(pidIsAlive(liveWorkerPid), true, "the live worker is still running afterwards");
		} finally {
			child.kill("SIGKILL");
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	// ── g3: a running run is never swept ─────────────────────────────────────

	it("(g3) a RUNNING run never sweeps (regression pin)", () => {
		const stateRoot = makeStateRoot();
		const manifest = makeManifest(stateRoot, {
			status: "running",
			async: { pid: process.pid, logPath: path.join(stateRoot, "runner.log"), spawnedAt: new Date().toISOString() },
		});
		const { opts } = fakeSweep([]);
		const { calls } = installSweepSeam(opts);
		try {
			const result = reconcileStaleRun(manifest, [liveRunningTask()], Date.now());
			assert.equal(result.verdict, "healthy", "a live run with a live pid and fresh heartbeats is healthy");
			assert.equal(calls.length, 0, "an in-flight run's descendants are legitimate — never swept");
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	// ── g5: never sweep from inside a worker ─────────────────────────────────

	it("(g5) PI_CREW_KIND=subagent ⇒ no sweep, even for a completed run", () => {
		const stateRoot = makeStateRoot();
		const manifest = makeManifest(stateRoot);
		const { opts } = fakeSweep([insideRun(manifest, { pid: 800_003, pgid: 900_003, env: { PI_CREW_BROKER_RUN_ID: RUN_ID } })]);
		const { calls } = installSweepSeam(opts);
		process.env.PI_CREW_KIND = "subagent";
		try {
			const result = reconcileStaleRun(manifest, [completedTask(DEAD_WORKER_PID)], Date.now());
			assert.equal(result.verdict, "result_exists");
			assert.equal(calls.length, 0, "a worker must never reap processes of its own (still-running) run");
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("(g5-b) a non-zero PI_CREW_DEPTH ⇒ no sweep", () => {
		const stateRoot = makeStateRoot();
		const manifest = makeManifest(stateRoot);
		const { opts } = fakeSweep([insideRun(manifest, { pid: 800_004, pgid: 900_004, env: { PI_CREW_BROKER_RUN_ID: RUN_ID } })]);
		const { calls } = installSweepSeam(opts);
		process.env.PI_CREW_DEPTH = "1";
		try {
			reconcileStaleRun(manifest, [completedTask(DEAD_WORKER_PID)], Date.now());
			assert.equal(calls.length, 0, "only depth 0 (host session / detached runner) may sweep");
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});
});

// ── g6/g7: HIGH-2 — the stamp records the attempt, `pending` records the leak ──

/**
 * Wave 11b.4 (HIGH-2). 11b.2/11b.3 stamped `descendantSweepAt` even when the
 * sweep had PROVEN a descendant and then refused to signal it (a live unmatched
 * group leader, no usable pgid, a refused group reap, an interactive tty). That
 * re-created the wave-11b failure mode one level up: the run looked done, so the
 * startup lane never looked at its leak again. These pins drive the REAL sweep
 * (fake /proc, no signal) through `reconcileStaleRun` and assert the persisted
 * marker pair.
 */
describe("wave 11b.4 — the sweep marker separates ATTEMPT TIME from PENDING state", () => {
	/** The marker pair as persisted on disk (the stamp goes through saveRunManifest). */
	function readMarker(manifest: TeamRunManifest): Record<string, unknown> {
		return JSON.parse(fs.readFileSync(path.join(manifest.stateRoot, "manifest.json"), "utf-8")) as Record<string, unknown>;
	}

	function runnableManifest(stateRoot: string, overrides: Partial<TeamRunManifest> = {}): TeamRunManifest {
		return makeManifest(stateRoot, {
			async: { pid: DEAD_RUNNER_PID, logPath: path.join(stateRoot, "runner.log"), spawnedAt: new Date().toISOString() },
			...overrides,
		});
	}

	it("(g6) a live unmatched group leader leaves the run PENDING, not done", () => {
		const stateRoot = makeStateRoot();
		const manifest = runnableManifest(stateRoot);
		const { opts, kills } = fakeSweep([
			// Someone's still-running session leads the group ⇒ leader-alive-unmatched.
			insideRun(manifest, { pid: 910_101, pgid: 910_101, env: {} }),
			insideRun(manifest, {
				pid: 800_101,
				pgid: 910_101,
				env: { PI_CREW_BROKER_RUN_ID: RUN_ID, PI_CREW_PARENT_PID: String(DEAD_RUNNER_PID) },
			}),
		]);
		const { results } = installSweepSeam(opts);
		try {
			const result = reconcileStaleRun(manifest, [completedTask(DEAD_WORKER_PID)], Date.now());
			assert.equal(result.verdict, "result_exists");
			assert.deepEqual(results[0]?.skipped, [{ pid: 800_101, reason: "leader-alive-unmatched" }]);
			assert.deepEqual(kills, [], "a live unmatched leader is never signalled");
			const marker = readMarker(manifest);
			assert.ok(
				typeof marker.descendantSweepAt === "string" && Number.isFinite(Date.parse(marker.descendantSweepAt)),
				"the attempt itself is recorded (ISO timestamp)",
			);
			assert.equal(
				marker.descendantSweepPending,
				true,
				"a proven-but-blocked leak MUST stay eligible — otherwise 11b.2 buried it for good",
			);
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("(g7) an interactive candidate (controlling terminal) ⇒ zero signals, run PENDING", () => {
		const stateRoot = makeStateRoot();
		const manifest = runnableManifest(stateRoot);
		const { opts, kills } = fakeSweep([
			{
				...insideRun(manifest, {
					pid: 800_102,
					pgid: 910_102,
					env: { PI_CREW_BROKER_RUN_ID: RUN_ID, PI_CREW_PARENT_PID: String(DEAD_RUNNER_PID) },
				}),
				// A controlling terminal: the operator's shell, not a run resource.
				tty: 34_816,
			},
		]);
		const { results } = installSweepSeam(opts);
		try {
			reconcileStaleRun(manifest, [completedTask(DEAD_WORKER_PID)], Date.now());
			assert.deepEqual(results[0]?.skipped, [{ pid: 800_102, reason: "interactive-tty" }]);
			assert.deepEqual(kills, [], "an interactive candidate is never signalled");
			assert.equal(readMarker(manifest).descendantSweepPending, true, "the tty'd leak is retried, not forgotten");
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("(g7-b) a CLEAN sweep clears a previously pending flag", () => {
		const stateRoot = makeStateRoot();
		const manifest = runnableManifest(stateRoot, {
			descendantSweepAt: new Date(Date.now() - 3_600_000).toISOString(),
			descendantSweepPending: true,
		});
		const { opts } = fakeSweep([
			insideRun(manifest, {
				pid: 800_103,
				pgid: 910_103,
				env: { PI_CREW_BROKER_RUN_ID: RUN_ID, PI_CREW_PARENT_PID: String(DEAD_RUNNER_PID) },
			}),
		]);
		const { results } = installSweepSeam(opts);
		try {
			reconcileStaleRun(manifest, [completedTask(DEAD_WORKER_PID)], Date.now());
			assert.deepEqual(
				results[0]?.reaped.map((descendant) => descendant.pid),
				[800_103],
				"the retry actually reaps the leak it was kept eligible for",
			);
			const marker = readMarker(manifest);
			assert.ok(Number.isFinite(Date.parse(String(marker.descendantSweepAt))), "the stamp is refreshed");
			assert.equal(marker.descendantSweepPending, undefined, "nothing left to retry ⇒ the flag is cleared, not set to false");
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("(g7-c) a dry-run report never stamps and never sets pending", () => {
		const stateRoot = makeStateRoot();
		const manifest = runnableManifest(stateRoot);
		const { opts } = fakeSweep([
			insideRun(manifest, {
				pid: 800_104,
				pgid: 910_104,
				env: { PI_CREW_BROKER_RUN_ID: RUN_ID, PI_CREW_PARENT_PID: String(DEAD_RUNNER_PID) },
			}),
		]);
		__test.setReapRunDescendants((markers) => reapRunDescendants(markers, { ...opts, dryRun: true }));
		try {
			reconcileStaleRun(manifest, [completedTask(DEAD_WORKER_PID)], Date.now());
			const marker = readMarker(manifest);
			assert.equal(marker.descendantSweepAt, undefined, "a report-only pass must not consume the marker");
			assert.equal(marker.descendantSweepPending, undefined);
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});
});

// ── g8–g10: wave 11c — a SYNC run records its spawner pid (battery F2) ──────

/**
 * Wave 11c (battery 2026-10-24 finding F2). The E2E probe proved a SYNC
 * (foreground) run leaks forever: it records no `manifest.async.pid`, and its
 * leaked bash grandchildren carry `PI_CREW_PARENT_PID=<session pi pid>` — a
 * pid in NO recorded set, so the descent proof could never hold and the sweep
 * skipped the leak (safely, but permanently). New manifests record
 * `manifest.sessionPid` at creation; these pins drive the REAL sweep (fake
 * /proc, signals recorded) through `reconcileStaleRun` for a manifest with NO
 * async state — exactly the sync topology.
 */
describe("wave 11c — the run's spawner pid closes the sync-run descent-proof gap", () => {
	/** `markers[0]?.sessionPid` — kept tiny so each pin reads at a glance. */
	function markersSessionPid(calls: RunMarkers[]): number | undefined {
		return calls[0]?.sessionPid;
	}

	it("(g8) a DEAD recorded sessionPid proves descent for a sync run's leak", () => {
		const stateRoot = makeStateRoot();
		// SYNC topology: no `async` block at all, only the session pi that spawned
		// the workers — and it has since exited.
		const manifest = makeManifest(stateRoot, { sessionPid: DEAD_SESSION_PID });
		const leakedPid = 800_105;
		const { opts, kills } = fakeSweep([
			// The battery's 7b shape: markers of the run + PI_CREW_PARENT_PID naming
			// the (dead) session pi — pre-11c this candidate was provably NOTHING'S.
			insideRun(manifest, {
				pid: leakedPid,
				pgid: 910_105,
				env: { PI_CREW_BROKER_RUN_ID: RUN_ID, PI_CREW_PARENT_PID: String(DEAD_SESSION_PID) },
			}),
		]);
		const { calls, results } = installSweepSeam(opts);
		try {
			const result = reconcileStaleRun(manifest, [completedTask(DEAD_WORKER_PID)], Date.now());
			assert.equal(result.verdict, "result_exists");
			assert.equal(calls.length, 1, "a sync terminal run is swept exactly like an async one");
			const markers = calls[0];
			assert.ok(markers !== undefined);
			assert.equal(markers.sessionPid, DEAD_SESSION_PID, "the manifest's spawner pid reaches the sweep markers");
			assert.equal(markers.runnerPid, undefined, "sync run — no runner pid to record");
			assert.deepEqual(
				results[0]?.reaped.map((descendant) => descendant.pid),
				[leakedPid],
				"the sync-run leak naming its dead session pi is reaped, not skipped",
			);
			assert.deepEqual(kills, [{ pgid: 910_105, signal: "SIGTERM" }]);
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("(g9) a LIVE sessionPid proves nothing — the operator's session is never a reap licence", async () => {
		const stateRoot = makeStateRoot();
		const sessionPi: ChildProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
		try {
			await once(sessionPi, "spawn");
			const liveSessionPid = sessionPi.pid;
			assert.ok(typeof liveSessionPid === "number", "the fixture session pi must have a pid");
			const manifest = makeManifest(stateRoot, { sessionPid: liveSessionPid });
			const { opts, kills } = fakeSweep([
				insideRun(manifest, {
					pid: 800_106,
					pgid: 910_106,
					env: { PI_CREW_BROKER_RUN_ID: RUN_ID, PI_CREW_PARENT_PID: String(liveSessionPid) },
				}),
			]);
			const { calls, results } = installSweepSeam(opts);
			const result = reconcileStaleRun(manifest, [completedTask(DEAD_WORKER_PID)], Date.now());
			assert.equal(result.verdict, "result_exists");
			assert.equal(calls.length, 1, "the sweep still runs — it simply proves nothing");
			assert.equal(markersSessionPid(calls), liveSessionPid);
			assert.deepEqual(results[0]?.reaped, [], "a live session pi is not proof: the user may still be using that pi");
			assert.equal(kills.length, 0);
			assert.equal(pidIsAlive(liveSessionPid), true, "the fixture session survived untouched");
		} finally {
			sessionPi.kill("SIGKILL");
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("(g10) a pre-11c sync manifest without sessionPid behaves exactly as before (skip, no error)", () => {
		const stateRoot = makeStateRoot();
		// The exact manifest shape the battery 7b probe used: sync run, no
		// sessionPid (written before 11c), leak naming an unrecorded session pi.
		const manifest = makeManifest(stateRoot);
		const unrecordedSessionPid = 888_777;
		const { opts, kills } = fakeSweep([
			insideRun(manifest, {
				pid: 800_107,
				pgid: 910_107,
				env: { PI_CREW_BROKER_RUN_ID: RUN_ID, PI_CREW_PARENT_PID: String(unrecordedSessionPid) },
			}),
		]);
		const { calls, results } = installSweepSeam(opts);
		try {
			const result = reconcileStaleRun(manifest, [completedTask(DEAD_WORKER_PID)], Date.now());
			assert.equal(result.verdict, "result_exists", "the reconcile pass completes — no error for the old shape");
			assert.equal(calls.length, 1);
			assert.equal(markersSessionPid(calls), undefined, "no sessionPid on an old manifest");
			assert.deepEqual(results[0]?.reaped, [], "an unrecorded parent is still not proof (the documented miss)");
			assert.equal(kills.length, 0);
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});
});
