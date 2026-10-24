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
import test, { after, beforeEach } from "node:test";
import { __setSelfIdentityForTest, readProcIdentity } from "../../../../src/runtime/process/reap-group.ts";
import {
	__resetSignalledGroupsForTest,
	__signalledGroupCountForTest,
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

// reap-group's ladder reads OUR identity from /proc. On a platform without
// /proc (macOS) every group signal would short-circuit at `proc-unavailable`,
// making the accepted-path cases untestable there. Seed a synthetic self
// identity on exactly those platforms (a no-op on Linux).
beforeEach(() => {
	__resetSignalledGroupsForTest();
	if (readProcIdentity(process.pid) === undefined) {
		__setSelfIdentityForTest({ pid: process.pid, pgid: 4_000_001, starttime: "1", uid: selfUid() });
	}
});

/** One synthetic /proc row. */
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
 * Build injected readers over a fixed pid table. `candidateStartMs` treats the
 * starttime string as an epoch-ms number so the run-window guard stays readable
 * (real /proc starttime is ticks-since-boot, converted through /proc/uptime).
 */
function fakeSweep(procs: FakeProc[], nowMs: number): FakeSweep {
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

function withRun(pid: number, pgid: number): FakeProc {
	return inside({ pid, pgid, env: { PI_CREW_BROKER_RUN_ID: "team_test_11b" } });
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
	const { opts, kills } = fakeSweep(
		[
			{ pid: 541, env: { PI_CREW_BROKER_RUN_ID: "team_test_11b" }, starttime: String(STARTED_AT_MS + 1_000) },
			{ pid: 542, pgid: 1, env: { PI_CREW_BROKER_RUN_ID: "team_test_11b" }, starttime: String(STARTED_AT_MS + 1_000) },
		],
		STARTED_AT_MS,
	);
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
				// Its leaked grandchild, own group, same run marker.
				withRun(682, 900_682),
			],
			STARTED_AT_MS,
		);
		const result = reapRunDescendants(markers({ workerPids: [liveWorker], runnerPid: undefined }), opts);
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
