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
import { afterEach, beforeEach, describe, it } from "node:test";
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
const selfUid = (): number => (typeof process.getuid === "function" ? process.getuid() : 0);

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
	const kills: { pgid: number; signal: NodeJS.Signals }[] = [];
	const opts: SweepOptions = {
		listPids: () => procs.map((proc) => proc.pid),
		readIdentity: (pid) => identities.get(pid),
		readEnviron: (pid) => envs.get(pid),
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
			const manifest = makeManifest(stateRoot);
			const leakedPid = 800_002;
			const workerPgid = 900_010;
			const { opts, kills } = fakeSweep([
				// The still-alive recorded worker — carries the run marker (every
				// worker gets PI_CREW_BROKER_RUN_ID) and would match by run-id.
				insideRun(manifest, { pid: liveWorkerPid, pgid: workerPgid, env: { PI_CREW_BROKER_RUN_ID: RUN_ID } }),
				// The real leak: a grandchild of the run, own group, parent gone.
				insideRun(manifest, { pid: leakedPid, pgid: 900_002, env: { PI_CREW_BROKER_RUN_ID: RUN_ID } }),
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
