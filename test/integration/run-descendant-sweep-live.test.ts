/**
 * run-descendant-sweep-live.test.ts — wave 11b LIVE reproduction (real /proc).
 *
 * Every other 11b suite injects the sweep seam and a synthetic pid table, so it
 * proves the SELECTION logic while saying nothing about whether a real leaked
 * process actually dies. This test does the opposite on purpose: it rebuilds the
 * incident shape out of REAL processes and lets the REAL sweep (real `/proc`,
 * real `reapGroup`, real signals) run through the REAL startup lane,
 * `reconcileAllStaleRuns`.
 *
 * The incident (run `team_20261022110510_cefb9164af126460`, completed 2026-10-22
 * 13:02Z, six grandchildren — `dpi-backend` ×5 + `caddy`, 399 MB — still alive
 * 24 h later): pi's bash tool spawns every command `detached: true`, so the
 * descendants live in the BASH command's process group, not the worker's. They
 * are identifiable only by the env markers they inherited
 * (`PI_CREW_KIND=subagent`, `PI_CREW_TASK_ID`, `PI_CREW_PARENT_PID` = the dead
 * runner, `PI_CREW_BROKER_RUN_ID` = the runId).
 *
 * Rebuilt shape (all in a scratch dir under the OS tmpdir):
 *   leak   detached leader bash → `node -e setInterval` grandchild carrying all
 *          four markers with the DEAD recorded runner as PARENT_PID; the leader
 *          is SIGKILLed so the grandchild is orphaned/reparented ⇒ must DIE (A1)
 *   N1     same markers minus PARENT_PID ⇒ must SURVIVE (A2)
 *   N2     full markers under a real PTY (`script`) ⇒ must SURVIVE (tty guard),
 *          and its skip is RETRYABLE ⇒ manifest carries descendantSweepPending
 *   N3     a plain marker-less process ⇒ must SURVIVE (A2)
 *
 * Assertions (A3–A5): the manifest keeps `status:"completed"`, gains an ISO
 * `descendantSweepAt` and `descendantSweepPending:true`; a second immediate pass
 * signals nothing (stamp unchanged — the 11b.4 retry interval); cleanup leaves
 * no survivor and removes the scratch dir.
 *
 * Linux-only: the sweep is `/proc`-based (`collectRunDescendants` fail-opens to
 * `[]` everywhere else), so the whole suite skips on win32/darwin.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { ManifestCache } from "../../src/runtime/manifest-cache.ts";
import { reconcileAllStaleRuns } from "../../src/runtime/recovery/crash-recovery.ts";
import { createRunManifest, loadRunManifestById } from "../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const LINUX = process.platform === "linux";
/** Unique cmdline token so A5's leftover scan targets ONLY this suite's procs. */
const CMD_MARKER = "w11livesweepmarker";
/** Path the recorded-dead pids are verified against (`kill -0` ⇒ ESRCH). */
const DEAD_PID_CANDIDATES = 9_998_871;
/** The incident run this shape is copied from (real state, when present). */
const INCIDENT_RUN_DIR = "/home/bom/source/my-durable/.crew/state/runs/team_20261022110510_cefb9164af126460";

// ── signal plumbing ────────────────────────────────────────────────────────

const trackedGroups = new Set<number>();
const trackedPids = new Set<number>();
let workspace: string | undefined;

function isAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A pid no process owns: `kill -0` reports ESRCH. Verified, never assumed. */
function findDeadPid(from: number): number {
	for (let pid = from; pid > from - 50; pid -= 1) {
		if (!isAlive(pid)) return pid;
	}
	throw new Error("could not find a dead pid in the scanned range");
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail(`${label} did not happen within ${timeoutMs} ms`);
}

function killGroup(pgid: number): void {
	if (!Number.isInteger(pgid) || pgid <= 1) return;
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {
		/* already gone */
	}
}

/** Spawn `argv` in its OWN process group (detached), exactly like pi's bash tool. */
function spawnDetached(argv: string[], env: NodeJS.ProcessEnv): number {
	const child = spawn(argv[0] as string, argv.slice(1), { detached: true, stdio: "ignore", env });
	const pid = child.pid;
	assert.ok(typeof pid === "number" && pid > 1, "detached spawn must report a pid");
	child.unref();
	trackedPids.add(pid);
	trackedGroups.add(pid);
	return pid;
}

// ── fixtures ────────────────────────────────────────────────────────────────

const team: TeamConfig = {
	name: "w11live",
	description: "wave 11b live repro",
	source: "builtin",
	filePath: "w11live.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};
const workflow: WorkflowConfig = {
	name: "w11live",
	description: "wave 11b live repro",
	source: "builtin",
	filePath: "w11live.workflow.md",
	steps: [{ id: "one", role: "executor", task: "Incident shape" }],
};
const TASK_ID = "01_01-agent";

interface IncidentShape {
	runId: string;
	stateRoot: string;
	deadRunnerPid: number;
	deadWorkerPid: number;
}

/**
 * Seed a TERMINAL run whose manifest/tasks are the REAL incident pair (rewritten
 * to point at this scratch project) when that state is present on this host, and
 * a schema-built equivalent otherwise (CI has no `/home/bom/source/my-durable`).
 * Either way the fields the sweep reads are identical: `status:"completed"`, a
 * 10-minute-old `updatedAt`, a DEAD `async.pid`, a DEAD `checkpoint.childPid`,
 * one terminal task and NO sweep marker.
 */
function seedIncidentRun(cwd: string, runId: string): IncidentShape {
	const deadRunnerPid = findDeadPid(DEAD_PID_CANDIDATES);
	const deadWorkerPid = findDeadPid(deadRunnerPid - 1);
	const stateRoot = path.join(cwd, ".crew", "state", "runs", runId);
	fs.mkdirSync(stateRoot, { recursive: true });
	fs.mkdirSync(path.join(cwd, ".crew", "artifacts", runId), { recursive: true });

	const tasksPath = path.join(stateRoot, "tasks.json");
	const eventsPath = path.join(stateRoot, "events.jsonl");
	const artifactsRoot = path.join(cwd, ".crew", "artifacts", runId);
	const now = Date.now();

	const realManifestPath = path.join(INCIDENT_RUN_DIR, "manifest.json");
	const realTasksPath = path.join(INCIDENT_RUN_DIR, "tasks.json");
	const haveIncident = fs.existsSync(realManifestPath) && fs.existsSync(realTasksPath);

	let manifest: Record<string, unknown>;
	let tasks: Record<string, unknown>[];
	if (haveIncident) {
		manifest = JSON.parse(fs.readFileSync(realManifestPath, "utf-8")) as Record<string, unknown>;
		tasks = JSON.parse(fs.readFileSync(realTasksPath, "utf-8")) as Record<string, unknown>[];
		assert.equal(tasks.length, 1, "the incident run has exactly one task");
	} else {
		const created = createRunManifest({ cwd, team, workflow, goal: "wave 11b live repro", runId, now: () => new Date(now) });
		manifest = created.manifest as unknown as Record<string, unknown>;
		tasks = created.tasks as unknown as Record<string, unknown>[];
	}

	// Rewrite identity/paths so the run validates inside THIS project…
	manifest.runId = runId;
	manifest.cwd = cwd;
	manifest.stateRoot = stateRoot;
	manifest.tasksPath = tasksPath;
	manifest.eventsPath = eventsPath;
	manifest.artifactsRoot = artifactsRoot;
	manifest.artifacts = [];
	// …and the terminal shape the lane selects: completed, 10 min ago, dead runner.
	manifest.status = "completed";
	manifest.updatedAt = new Date(now - 10 * 60_000).toISOString();
	manifest.createdAt = new Date(now - 30 * 60_000).toISOString();
	manifest.async = {
		pid: deadRunnerPid,
		logPath: path.join(stateRoot, "background.log"),
		spawnedAt: new Date(now - 30 * 60_000).toISOString(),
	};
	manifest.surface = { provider: null, panes: {}, workerPids: {}, sessionPaths: {} };
	// The marker/retry fields must be ABSENT: this is the "never swept" shape.
	delete manifest.descendantSweepAt;
	delete manifest.descendantSweepPending;

	const task = tasks[0] as Record<string, unknown>;
	task.id = TASK_ID;
	task.runId = runId;
	task.status = "completed";
	task.startedAt = new Date(now - 29 * 60_000).toISOString();
	task.finishedAt = new Date(now - 11 * 60_000).toISOString();
	task.cwd = cwd;
	delete task.heartbeat;
	task.checkpoint = {
		phase: "artifact-written",
		updatedAt: new Date(now - 11 * 60_000).toISOString(),
		childPid: deadWorkerPid,
	};

	fs.writeFileSync(path.join(stateRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
	fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2));
	fs.writeFileSync(eventsPath, "");
	return { runId, stateRoot, deadRunnerPid, deadWorkerPid };
}

/** In-memory cache over the REAL loaded manifest (list contract: newest first). */
function makeCache(cwd: string, runId: string): ManifestCache {
	const loaded = loadRunManifestById(cwd, runId);
	assert.ok(loaded !== undefined, `fixture run ${runId} must load through the real state store`);
	const manifest = loaded.manifest;
	return {
		list: (limit?: number) => (limit === undefined ? [manifest] : [manifest].slice(0, limit)),
		listActive: () => [],
		get: (id: string) => (id === manifest.runId ? manifest : undefined),
		clear: () => undefined,
		dispose: () => undefined,
	};
}

function readManifestOnDisk(stateRoot: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(stateRoot, "manifest.json"), "utf-8")) as Record<string, unknown>;
}

/** The inherited env of a pi-crew descendant, minus the marker under test. */
function markerEnv(runId: string, deadRunnerPid: number, overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: process.env.HOME ?? os.tmpdir(),
		PI_CREW_KIND: "subagent",
		PI_CREW_TASK_ID: TASK_ID,
		PI_CREW_BROKER_RUN_ID: runId,
		PI_CREW_PARENT_PID: String(deadRunnerPid),
	};
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

/** A long-lived, marker-tagged node process; argv carries CMD_MARKER for A5. */
function nodeIntervalArgv(): string[] {
	return [process.execPath, "-e", "setInterval(()=>{},1000)", CMD_MARKER];
}

async function readPidFile(file: string): Promise<number> {
	await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, "utf-8").trim().length > 0, 5_000, `pid file ${file}`);
	const raw = Number.parseInt(fs.readFileSync(file, "utf-8").trim(), 10);
	assert.ok(Number.isInteger(raw) && raw > 1, `pid file ${file} must carry a pid, got ${raw}`);
	return raw;
}

// ── cleanup (runs even when an assertion fails) ──────────────────────────────

after(async () => {
	for (const pgid of trackedGroups) killGroup(pgid);
	for (const pid of trackedPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* gone */
		}
	}
	// Give the kernel a moment to reap, then assert no survivor and no debris.
	await new Promise((resolve) => setTimeout(resolve, 200));
	for (const pid of trackedPids) {
		assert.equal(isAlive(pid), false, `pid ${pid} survived cleanup (A5)`);
	}
	if (workspace !== undefined) {
		fs.rmSync(workspace, { recursive: true, force: true });
		assert.equal(fs.existsSync(workspace), false, `${workspace} must be removed (A5)`);
	}
});

// ── the live reproduction ───────────────────────────────────────────────────

describe("wave 11b LIVE — the run-descendant sweep against real processes", {
	skip: LINUX ? false : "Linux-only: the sweep is /proc-based",
}, () => {
	it("reaps the incident shape and nothing else (A1–A5)", { timeout: 180_000 }, async () => {
		// Env scrub: the sweep refuses to run inside a worker (`PI_CREW_KIND`) and
		// the crew depth gate must see a host session. Only values this test sets
		// survive. PI_TEAMS_HOME isolates the active-run registry from the host.
		const savedEnv: Record<string, string | undefined> = {};
		for (const key of ["PI_CREW_KIND", "PI_CREW_DEPTH", "PI_TEAMS_DEPTH", "PI_CREW_REAP_RUN_DESCENDANTS", "PI_TEAMS_HOME"]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-w11live-"));
		process.env.PI_TEAMS_HOME = path.join(tmpRoot, "home");
		workspace = path.join(tmpRoot, "project");
		fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
		try {
			const runId = `team_W11LIVE_${Date.now()}`;
			const shape = seedIncidentRun(workspace, runId);

			// ── 1. the leak: detached leader bash + marker-tagged grandchild ──────
			const leakPidFile = path.join(tmpRoot, "leak.pid");
			const leakLeaderPid = spawnDetached(
				["bash", "-c", `${process.execPath} -e "setInterval(()=>{},1000)" ${CMD_MARKER} & echo $! > ${leakPidFile}; wait`],
				markerEnv(runId, shape.deadRunnerPid, {}),
			);
			const leakGrandchildPid = await readPidFile(leakPidFile);
			trackedPids.add(leakGrandchildPid);
			assert.equal(isAlive(leakGrandchildPid), true, "the leak grandchild must be alive before the sweep");
			// Orphan it: kill ONLY the group leader (SIGKILL), never the group — the
			// grandchild is reparented to init and keeps the leader's (now leaderless)
			// pgid, which is exactly the incident topology.
			process.kill(leakLeaderPid, "SIGKILL");
			await waitFor(() => !isAlive(leakLeaderPid), 5_000, "leak leader death");
			assert.equal(isAlive(leakGrandchildPid), true, "the orphaned grandchild must still be alive (the leak)");

			// ── 2. negative controls ─────────────────────────────────────────────
			// N1: markers WITHOUT PI_CREW_PARENT_PID ⇒ no descent proof ⇒ survives.
			const n1Pid = spawnDetached(nodeIntervalArgv(), markerEnv(runId, shape.deadRunnerPid, { PI_CREW_PARENT_PID: undefined }));
			// N2: FULL markers under a real PTY ⇒ interactive, must never be signalled.
			// The markers are injected INSIDE the pty command (`exec` replaces the
			// `sh -c` wrapper, so the pty-attached process itself is the marker
			// carrier); the `script` wrapper stays marker-free, because a wrapper that
			// inherited the markers WOULD be a legitimate non-tty leak candidate.
			const n2LeaderPid = spawnDetached(["script", "-qfc", ptyMarkerCommand(runId, shape.deadRunnerPid), "/dev/null"], {
				PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
				HOME: process.env.HOME ?? os.tmpdir(),
			});
			// N3: no pi-crew markers at all ⇒ survives.
			const n3Pid = spawnDetached(nodeIntervalArgv(), {
				PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
				HOME: process.env.HOME ?? os.tmpdir(),
			});
			await waitFor(() => isAlive(n1Pid) && isAlive(n3Pid), 5_000, "negative controls up");
			// The PTY'd process is a CHILD of `script`; wait until it exists so the
			// tty guard is actually exercised rather than trivially empty.
			const n2Pids = await waitForPtyChild(n2LeaderPid);

			// ── 3. the sweep (REAL startup lane: enumeration + lock + /proc + signal)
			const startedAt = Date.now();
			const firstPass = await reconcileAllStaleRuns(workspace, makeCache(workspace, runId), Date.now());
			assert.deepEqual(firstPass, [], "a terminal run contributes no reconcile verdict (it is finished, not stale)");

			// A1: the leak dies within 6 s.
			await waitFor(() => !isAlive(leakGrandchildPid), 6_000, "A1: leaked grandchild death");
			const reapMs = Date.now() - startedAt;

			// A2: all three negative controls survive.
			assert.equal(isAlive(n1Pid), true, "A2 N1: a marker-tagged process without a proof parent must survive");
			assert.equal(isAlive(n2LeaderPid), true, "A2 N2: the pty leader must survive");
			for (const pid of n2Pids) assert.equal(isAlive(pid), true, `A2 N2: pty child ${pid} must survive the tty guard`);
			assert.equal(isAlive(n3Pid), true, "A2 N3: a marker-less process must survive");

			// A3: the manifest records the attempt but keeps the run completed.
			const afterFirst = readManifestOnDisk(shape.stateRoot);
			assert.equal(afterFirst.status, "completed", "A3: stamping must never revert the run status");
			const stamp = afterFirst.descendantSweepAt;
			assert.equal(typeof stamp, "string", `A3: descendantSweepAt must be an ISO string, got ${JSON.stringify(stamp)}`);
			assert.ok(Number.isFinite(Date.parse(stamp as string)), "A3: descendantSweepAt must parse as a date");
			assert.equal(afterFirst.descendantSweepPending, true, "A3: the tty skip is retryable ⇒ descendantSweepPending");

			// A4: a second immediate pass is a no-op (retry interval is 10 min).
			const secondPass = await reconcileAllStaleRuns(workspace, makeCache(workspace, runId), Date.now());
			assert.deepEqual(secondPass, [], "A4: no verdict from the terminal lane");
			const afterSecond = readManifestOnDisk(shape.stateRoot);
			assert.equal(afterSecond.descendantSweepAt, stamp, "A4: the second pass must not even attempt a sweep (stamp unchanged)");
			assert.equal(afterSecond.descendantSweepPending, true, "A4: pending survives the no-op pass");
			assert.equal(isAlive(n1Pid), true, "A4: nothing else died on the second pass");
			assert.equal(isAlive(n2LeaderPid), true, "A4: nothing else died on the second pass");
			assert.equal(isAlive(n3Pid), true, "A4: nothing else died on the second pass");

			// A4b: after the retry interval the lane re-selects the pending run, and
			// the tty guard STILL refuses to signal (a documented miss, never a kill).
			rewriteSweepStamp(shape.stateRoot, new Date(Date.now() - 11 * 60_000).toISOString());
			const thirdPass = await reconcileAllStaleRuns(workspace, makeCache(workspace, runId), Date.now());
			assert.deepEqual(thirdPass, [], "A4b: still no verdict");
			const afterThird = readManifestOnDisk(shape.stateRoot);
			assert.notEqual(afterThird.descendantSweepAt, new Date(Date.now() - 11 * 60_000).toISOString());
			for (const pid of n2Pids) assert.equal(isAlive(pid), true, `A4b: pty child ${pid} must survive the retry (tty guard)`);
			assert.equal(afterThird.descendantSweepPending, true, "A4b: the run stays pending while the tty leak is unreachable");
			assert.equal(afterThird.status, "completed", "A4b: status still untouched");

			// Evidence for the report (the PIDs are what make this reproducible).
			const ptyTty = n2Pids.map((pid) => readTtyNr(pid));
			process.stdout.write(
				`[wave11b-live] run=${runId} leak=${leakGrandchildPid} reapedIn=${reapMs}ms n1=${n1Pid} n2wrapper=${n2LeaderPid} n2pty=${n2Pids.join(",")} n2tty=${ptyTty.join(",")} n3=${n3Pid} stamp=${String(afterThird.descendantSweepAt)}\n`,
			);
		} finally {
			for (const [key, value] of Object.entries(savedEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			for (const pgid of trackedGroups) killGroup(pgid);
			await new Promise((resolve) => setTimeout(resolve, 100));
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
});

/** `/proc/<pid>/stat` field 7 — `0` means "no controlling terminal". */
function readTtyNr(pid: number): number | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const value = Number.parseInt(fields[4] ?? "", 10);
		return Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Rewrite ONLY the sweep stamp on disk (models the 10-minute retry interval). */
function rewriteSweepStamp(stateRoot: string, iso: string): void {
	const manifestPath = path.join(stateRoot, "manifest.json");
	const onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
	onDisk.descendantSweepAt = iso;
	fs.writeFileSync(manifestPath, JSON.stringify(onDisk, null, 2));
}

/** `sh -c` payload for N2: markers are set for the pty process only, then `exec`. */
function ptyMarkerCommand(runId: string, deadRunnerPid: number): string {
	return (
		`PI_CREW_KIND=subagent PI_CREW_TASK_ID=${TASK_ID} PI_CREW_BROKER_RUN_ID=${runId} ` +
		`PI_CREW_PARENT_PID=${deadRunnerPid} exec ${process.execPath} -e "setInterval(()=>{},1000)" ${CMD_MARKER}`
	);
}

/** Children of a `script` leader — the pty-attached node process. */
async function waitForPtyChild(leaderPid: number): Promise<number[]> {
	const readChildren = (): number[] => {
		try {
			const stat = fs.readFileSync(`/proc/${leaderPid}/task/${leaderPid}/children`, "utf-8").trim();
			return stat
				.split(/\s+/)
				.filter(Boolean)
				.map((pid) => Number.parseInt(pid, 10));
		} catch {
			return [];
		}
	};
	await waitFor(() => readChildren().length > 0, 5_000, "pty child spawn");
	const children = readChildren();
	for (const pid of children) trackedPids.add(pid);
	return children;
}
