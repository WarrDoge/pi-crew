/**
 * reconcile-terminal-run-descendant-sweep.test.ts — wave 11b.2 REACHABILITY pins.
 *
 * Wave 11b shipped the run-scoped descendant sweep; 11b.1 made it reachable from
 * `reconcileStaleRun`'s `result_exists` branch. Both were still unreachable for
 * the shape that actually happened: `reconcileAllStaleRuns` (the STARTUP pass)
 * enumerated `status === "running" | "blocked"` only, so a run that had already
 * persisted as `completed` — team_20261022110510 completed at 13:02, its six
 * bash grandchildren still burning 390 MB the next morning — was never visited
 * by a later session's reconcile. A leak outlives its run.
 *
 * These tests are STARTUP-level (`reconcileAllStaleRuns`) and pin:
 *   h1  terminal run without a marker ⇒ enumerated + swept + marker persisted
 *   h2  second pass ⇒ skipped, ZERO /proc enumeration (collectRunDescendants)
 *   h3  30 unswept terminal runs ⇒ only the 25 OLDEST are swept (per-pass cap)
 *   h4  a RUNNING run keeps the old path and is never swept
 *   h5  old manifests load; an unknown field is neither required nor stripped
 *   h6  kill switch OFF ⇒ no sweep AND no marker (stays eligible)
 *   h7  a throwing sweep ⇒ no marker (retried next pass)
 *   h8  GRACE WINDOW (11b.3): updatedAt 30 s old ⇒ not selected, NO marker;
 *       120 s old ⇒ selected; the skipped run is picked up once it ages out
 *   h9  CACHE WINDOW (11b.3): 60 unswept terminal runs where the oldest sits
 *       OUTSIDE the reconcile lane's top-50 ⇒ still swept (oldest first)
 *   h10 SURFACE PIDS (11b.3): manifest.surface.workerPids ⇒ markers.surfacePids
 *       (the sweep then refuses to touch a live pane pid)
 *
 * The sweep is swapped through the `__test.setReapRunDescendants` seam (same as
 * the sibling 11b.1 suite) and the swapped implementation is the REAL
 * `reapRunDescendants` over an EMPTY synthetic pid table, so marker matching and
 * the early returns all execute while no /proc is read and no signal is sent.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ManifestCache } from "../../../../src/runtime/manifest-cache.ts";
import { type RunMarkers, reapRunDescendants } from "../../../../src/runtime/process/run-descendant-sweep.ts";
import { reconcileAllStaleRuns } from "../../../../src/runtime/recovery/crash-recovery.ts";
import { __test } from "../../../../src/runtime/stale-reconciler.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "w11b2",
	description: "w11b2",
	source: "builtin",
	filePath: "w11b2.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};
const workflow: WorkflowConfig = {
	name: "w11b2",
	description: "w11b2",
	source: "builtin",
	filePath: "w11b2.workflow.md",
	steps: [{ id: "one", role: "executor", task: "One" }],
};

/** A pid that is provably not in use — the "recorded worker is dead" fixture. */
const DEAD_WORKER_PID = 999_996;

/** Env keys the sweep's guards read; a worker shell leaks all of them. */
const GUARD_ENV_KEYS = ["PI_CREW_KIND", "PI_CREW_DEPTH", "PI_TEAMS_DEPTH", "PI_CREW_REAP_RUN_DESCENDANTS"] as const;

let savedEnv: Record<string, string | undefined> = {};
let savedHome: string | undefined;
let home: string;

beforeEach(() => {
	savedEnv = {};
	for (const key of GUARD_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	// Isolate the active-run registry + user state root: an ambient entry for a
	// fixture runId would make `reconcileStaleRun` report `healthy` forever.
	savedHome = process.env.PI_TEAMS_HOME;
	home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-w11b2-home-"));
	process.env.PI_TEAMS_HOME = home;
});

afterEach(() => {
	for (const key of GUARD_ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (savedHome === undefined) delete process.env.PI_TEAMS_HOME;
	else process.env.PI_TEAMS_HOME = savedHome;
	fs.rmSync(home, { recursive: true, force: true });
	__test.reset();
});

// ── fixtures ────────────────────────────────────────────────────────────────

function makeWorkspace(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-w11b2-ws-"));
	try {
		// A marker file keeps this out of any enclosing repo's project state root.
		fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	} catch {
		/* best-effort */
	}
	return dir;
}

interface WriteRunOptions {
	status: TeamRunManifest["status"];
	createdAtMs?: number;
	/**
	 * `manifest.updatedAt` (11b.3): the field the terminal lane uses for its grace
	 * window. Defaults to `createdAtMs`; set it OLDER than `createdAtMs` to model a
	 * run that finished long after it started, or NEWER to model one that just
	 * went terminal.
	 */
	updatedAtMs?: number;
	workerPid?: number;
	sweepAt?: string;
	/** 11b.4: the persisted "proven but not signalled yet" flag. */
	sweepPending?: boolean;
	/** Extra (foreign) manifest keys, written straight to the JSON file. */
	extraManifestFields?: Record<string, unknown>;
}

/** Persist a real run (manifest + tasks on disk) so the startup pass can load it. */
function writeRun(cwd: string, runId: string, options: WriteRunOptions): TeamRunManifest {
	const createdAtMs = options.createdAtMs ?? Date.now();
	const created = createRunManifest({
		cwd,
		team,
		workflow,
		goal: "wave 11b.2 fixture",
		runId,
		now: () => new Date(createdAtMs),
	});
	const manifest: TeamRunManifest = {
		...created.manifest,
		status: options.status,
		updatedAt: new Date(options.updatedAtMs ?? createdAtMs).toISOString(),
		...(options.sweepAt === undefined ? {} : { descendantSweepAt: options.sweepAt }),
		...(options.sweepPending === undefined ? {} : { descendantSweepPending: options.sweepPending }),
	};
	saveRunManifest(manifest);
	const task: TeamTaskState = {
		...created.tasks[0],
		id: "01_01-agent",
		status: "completed",
		startedAt: new Date(createdAtMs - 60_000).toISOString(),
		finishedAt: new Date(createdAtMs - 30_000).toISOString(),
		heartbeat: {
			workerId: "w-1",
			lastSeenAt: new Date(createdAtMs - 30_000).toISOString(),
			alive: false,
			pid: options.workerPid ?? DEAD_WORKER_PID,
		},
	};
	saveRunTasks(manifest, [task]);
	if (options.extraManifestFields) {
		const manifestPath = path.join(manifest.stateRoot, "manifest.json");
		const onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
		fs.writeFileSync(manifestPath, JSON.stringify({ ...onDisk, ...options.extraManifestFields }, null, 2));
	}
	return manifest;
}

/**
 * Stub cache honouring the real `list(limit)` contract: the REAL cache returns
 * the newest `createdAt` first and slices to `limit`, which is exactly the
 * top-N window 11b.3 has to widen (h9). Fixtures are therefore passed in the
 * order the real cache would return them (newest first) whenever the limit
 * matters.
 */
function makeStubCache(manifests: TeamRunManifest[]): ManifestCache {
	const byId = new Map(manifests.map((manifest) => [manifest.runId, manifest]));
	return {
		list: (limit?: number) => (limit === undefined ? manifests : manifests.slice(0, limit)),
		listActive: (limit: number) => manifests.filter((manifest) => manifest.status === "running").slice(0, limit),
		get: (runId: string) => byId.get(runId),
		clear: () => {
			/* no-op */
		},
		dispose: () => {
			/* no-op */
		},
	};
}

interface SweepSeam {
	/** Every sweep invocation, in order (runId per call). */
	calls: RunMarkers[];
	/** Count of /proc enumerations (i.e. `collectRunDescendants` runs). */
	procScans: number;
}

/** Install the seam: record the call, then run the REAL sweep over an empty pid table. */
function installSweepSeam(): SweepSeam {
	const seam: SweepSeam = { calls: [], procScans: 0 };
	__test.setReapRunDescendants((markers) => {
		seam.calls.push(markers);
		// `listPids` is exactly what collectRunDescendants iterates — counting it
		// IS the "how many /proc scans did this pass perform" metric.
		return reapRunDescendants(markers, {
			listPids: () => {
				seam.procScans += 1;
				return [];
			},
			platform: "linux",
		});
	});
	return seam;
}

function readManifestFromDisk(manifest: TeamRunManifest): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(manifest.stateRoot, "manifest.json"), "utf-8")) as Record<string, unknown>;
}

function isIsoTimestamp(value: unknown): boolean {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

// ── h1: a persisted-COMPLETED run is enumerated and swept ───────────────────

describe("wave 11b.2 — startup reconciliation reaches a terminal run", () => {
	it("(h1) completed run without descendantSweepAt ⇒ swept once and stamped", async () => {
		const cwd = makeWorkspace();
		try {
			const manifest = writeRun(cwd, "team_w11b2_h1", { status: "completed", createdAtMs: Date.now() - 120_000 });
			const seam = installSweepSeam();

			const results = await reconcileAllStaleRuns(cwd, makeStubCache([manifest]), Date.now());

			assert.equal(seam.calls.length, 1, "a completed run WITHOUT a marker MUST reach the sweep (this is the 11b.2 fix)");
			assert.equal(seam.calls[0]?.runId, "team_w11b2_h1");
			assert.equal(seam.procScans, 1, "exactly one /proc enumeration for one unswept run");
			assert.deepEqual(
				results.filter((result) => result.runId === "team_w11b2_h1"),
				[],
				"the terminal lane never reports a reconcile verdict (a finished run is not stale)",
			);
			const stamped = readManifestFromDisk(manifest).descendantSweepAt;
			assert.ok(isIsoTimestamp(stamped), `marker must be an ISO timestamp on disk, got ${JSON.stringify(stamped)}`);
			// 11b.4: a clean sweep (nothing discovered, nothing skipped) leaves NO
			// retry flag behind — the run is done, not "pending".
			assert.equal(
				readManifestFromDisk(manifest).descendantSweepPending,
				undefined,
				"a clean attempt must not mark the run as pending",
			);
			assert.equal(readManifestFromDisk(manifest).status, "completed", "stamping must not disturb the run status");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("(h2) second pass skips the stamped run: collectRunDescendants 0 calls", async () => {
		const cwd = makeWorkspace();
		try {
			const manifest = writeRun(cwd, "team_w11b2_h2", { status: "completed", createdAtMs: Date.now() - 120_000 });
			const seam = installSweepSeam();

			await reconcileAllStaleRuns(cwd, makeStubCache([manifest]), Date.now());
			assert.equal(seam.procScans, 1, "first pass sweeps once");

			// The cache is deliberately STALE (still lists the manifest without the
			// marker) — the in-lock re-read is what must catch it.
			await reconcileAllStaleRuns(cwd, makeStubCache([manifest]), Date.now());
			assert.equal(seam.calls.length, 1, "no second sweep for an already-swept run");
			assert.equal(seam.procScans, 1, "collectRunDescendants must NOT run again (0 calls on pass 2)");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("(h3) 30 unswept completed runs ⇒ only the 25 OLDEST are swept per pass", async () => {
		const cwd = makeWorkspace();
		try {
			const base = Date.parse("2026-10-20T00:00:00.000Z");
			const manifests: TeamRunManifest[] = [];
			for (let index = 0; index < 30; index += 1) {
				manifests.push(
					writeRun(cwd, `team_w11b2_r${String(index).padStart(2, "0")}`, {
						status: "completed",
						createdAtMs: base + index * 60_000,
					}),
				);
			}
			const seam = installSweepSeam();

			await reconcileAllStaleRuns(cwd, makeStubCache(manifests), Date.now());

			const swept = seam.calls.map((call) => call.runId);
			// 11b.3: OLDEST first (updatedAt asc) — the selection order. It is pinned
			// by MEMBERSHIP, not by call order: the lane runs `mapConcurrent(..., 2)`,
			// so the handful of runs that reach the seam are pushed in completion
			// order. What the ordering has to guarantee is WHICH 25 survive the cap.
			const expected = Array.from({ length: 25 }, (_, index) => `team_w11b2_r${String(index).padStart(2, "0")}`);
			assert.equal(swept.length, 25, "the per-pass cap is exactly 25 (/proc scan budget)");
			assert.deepEqual(
				[...swept].sort(),
				[...expected].sort(),
				"the 25 OLDEST are swept; the 5 youngest are deferred to a later pass",
			);
			// Deferred runs keep NO marker ⇒ eligible on the next pass.
			for (let index = 25; index < 30; index += 1) {
				const deferred = manifests[index];
				assert.ok(deferred !== undefined);
				assert.equal(
					readManifestFromDisk(deferred).descendantSweepAt,
					undefined,
					`${deferred.runId} must stay eligible (no marker) until its pass`,
				);
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("(h4) a RUNNING run keeps the old path and is never swept (regression)", async () => {
		const cwd = makeWorkspace();
		try {
			const manifest = writeRun(cwd, "team_w11b2_h4", { status: "running", workerPid: process.pid });
			// A genuinely live task (fresh heartbeat, live pid) ⇒ the verdict tree
			// says healthy; the run is NOT terminal, so the sweep lane skips it.
			const created = loadRunManifestById(cwd, "team_w11b2_h4");
			assert.ok(created !== undefined);
			saveRunTasks(created.manifest, [
				{
					...created.tasks[0],
					id: "01_01-agent",
					status: "running",
					startedAt: new Date().toISOString(),
					heartbeat: { workerId: "w-1", lastSeenAt: new Date().toISOString(), alive: true, pid: process.pid },
				} as TeamTaskState,
			]);
			const seam = installSweepSeam();

			const results = await reconcileAllStaleRuns(cwd, makeStubCache([manifest]), Date.now());

			const mine = results.filter((result) => result.runId === "team_w11b2_h4");
			assert.equal(mine.length, 1, "the running lane still reconciles (unchanged behaviour)");
			// No async runner pid + fresh task heartbeat ⇒ the verdict tree declines to
			// repair (`no_status`, the pre-11b.2 behaviour) and never sweeps.
			assert.equal(mine[0]?.verdict, "no_status");
			assert.equal(mine[0]?.repaired, false, "the live run is left completely alone");
			assert.equal(seam.calls.length, 0, "a live run's descendants are legitimate — never swept");
			assert.equal(readManifestFromDisk(manifest).descendantSweepAt, undefined, "a running run must never receive the sweep marker");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("(h5) old manifests load; foreign fields are neither required nor stripped", async () => {
		const cwd = makeWorkspace();
		try {
			const manifest = writeRun(cwd, "team_w11b2_h5", {
				status: "completed",
				extraManifestFields: { legacyOnlyField: { keep: true } },
			});
			const loaded = loadRunManifestById(cwd, "team_w11b2_h5");
			assert.ok(loaded !== undefined, "a manifest WITHOUT descendantSweepAt still loads (additive field)");
			assert.equal(loaded.manifest.descendantSweepAt, undefined, "absent marker reads as 'never swept'");
			assert.deepEqual(
				(loaded.manifest as unknown as Record<string, unknown>).legacyOnlyField,
				{ keep: true },
				"unknown fields survive a load (no schema strip)",
			);
			// Round-trip through the writer: the foreign field must not be lost.
			saveRunManifest(loaded.manifest);
			assert.deepEqual(readManifestFromDisk(manifest).legacyOnlyField, { keep: true }, "unknown fields survive a save");
			assert.equal(readManifestFromDisk(manifest).descendantSweepAt, undefined);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("(h6) kill switch off ⇒ no sweep AND no marker", async () => {
		const cwd = makeWorkspace();
		try {
			const manifest = writeRun(cwd, "team_w11b2_h6", { status: "completed", createdAtMs: Date.now() - 120_000 });
			const seam = installSweepSeam();
			process.env.PI_CREW_REAP_RUN_DESCENDANTS = "0";

			await reconcileAllStaleRuns(cwd, makeStubCache([manifest]), Date.now());

			assert.equal(seam.calls.length, 0, "the kill switch disables the sweep entirely");
			assert.equal(
				readManifestFromDisk(manifest).descendantSweepAt,
				undefined,
				"no marker while disabled — turning the switch back ON must still find this run",
			);
		} finally {
			delete process.env.PI_CREW_REAP_RUN_DESCENDANTS;
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("(h7) a throwing sweep leaves no marker ⇒ retried next pass", async () => {
		const cwd = makeWorkspace();
		try {
			const manifest = writeRun(cwd, "team_w11b2_h7", { status: "completed", createdAtMs: Date.now() - 120_000 });
			let attempts = 0;
			__test.setReapRunDescendants(() => {
				attempts += 1;
				throw new Error("sweep exploded (simulated /proc failure)");
			});

			await reconcileAllStaleRuns(cwd, makeStubCache([manifest]), Date.now());
			assert.equal(attempts, 1);
			assert.equal(
				readManifestFromDisk(manifest).descendantSweepAt,
				undefined,
				"a failed sweep must NOT be recorded as done (the leak is still out there)",
			);

			await reconcileAllStaleRuns(cwd, makeStubCache([manifest]), Date.now());
			assert.equal(attempts, 2, "the run stays eligible, so the next pass retries the sweep");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ── wave 11b.3: age gate + cache window + surface panes ────────────────

describe("wave 11b.3 — the terminal lane is bounded by age, depth and recorded panes", () => {
	it("(h8) a run that JUST went terminal is not swept yet (60 s grace window)", async () => {
		const cwd = makeWorkspace();
		try {
			const now = Date.now();
			// Identical but for `updatedAt`: 30 s vs 120 s since the run went terminal.
			const fresh = writeRun(cwd, "team_w11b3_fresh", {
				status: "completed",
				createdAtMs: now - 300_000,
				updatedAtMs: now - 30_000,
			});
			const aged = writeRun(cwd, "team_w11b3_aged", {
				status: "completed",
				createdAtMs: now - 300_000,
				updatedAtMs: now - 120_000,
			});
			const seam = installSweepSeam();

			await reconcileAllStaleRuns(cwd, makeStubCache([fresh, aged]), now);

			assert.deepEqual(
				seam.calls.map((call) => call.runId),
				["team_w11b3_aged"],
				"only the run past the 60 s window is swept; updatedAt (not createdAt) decides",
			);
			assert.equal(
				readManifestFromDisk(fresh).descendantSweepAt,
				undefined,
				"a run inside the grace window must NOT be stamped — its mux panes may still be attached",
			);
			assert.ok(isIsoTimestamp(readManifestFromDisk(aged).descendantSweepAt), "the aged run is swept once");

			// Nothing is lost: the deferred run is swept as soon as it ages out.
			await reconcileAllStaleRuns(cwd, makeStubCache([fresh, aged]), now + 90_000);
			assert.deepEqual(
				[...seam.calls.map((call) => call.runId)].sort(),
				["team_w11b3_aged", "team_w11b3_fresh"],
				"the skipped run stays eligible and is swept on a later pass (call order is concurrency-2 completion order, so only membership is asserted)",
			);
			assert.ok(isIsoTimestamp(readManifestFromDisk(fresh).descendantSweepAt));
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("(h9) 60 unswept terminal runs: the OLDEST (outside a top-50 window) is still swept", async () => {
		const cwd = makeWorkspace();
		try {
			const base = Date.parse("2026-10-20T00:00:00.000Z");
			const ascending: TeamRunManifest[] = [];
			for (let index = 0; index < 60; index += 1) {
				ascending.push(
					writeRun(cwd, `team_w11b3_c${String(index).padStart(2, "0")}`, {
						status: "completed",
						createdAtMs: base + index * 60_000,
					}),
				);
			}
			// The REAL cache returns newest `createdAt` first and slices to `limit`.
			const newestFirst = [...ascending].reverse();
			// Pre-condition of the fix: with the reconcile lane's window (50) the run
			// that ACTUALLY leaked would be invisible — the starvation 11b.3 removes.
			assert.ok(
				!newestFirst.slice(0, 50).some((manifest) => manifest.runId === "team_w11b3_c00"),
				"fixture precondition: c00 sits outside a top-50 window",
			);
			const seam = installSweepSeam();

			await reconcileAllStaleRuns(cwd, makeStubCache(newestFirst), Date.now());

			const swept = seam.calls.map((call) => call.runId);
			const expected = Array.from({ length: 25 }, (_, index) => `team_w11b3_c${String(index).padStart(2, "0")}`);
			assert.equal(swept.length, 25, "the /proc budget per pass is unchanged");
			// Membership, not call order: the lane sweeps at concurrency 2, so the
			// order in which the seam observes the runs is completion order. The
			// oldest-first SELECTION is what decides membership under the cap — and
			// with newest-first, c00 (below) would be the one starved.
			assert.deepEqual([...swept].sort(), [...expected].sort(), "the 25 OLDEST, so an old leak can never starve behind newer runs");
			assert.ok(swept.includes("team_w11b3_c00"), "the run outside a top-50 window is reached (11b.3 cache window)");
			assert.ok(isIsoTimestamp(readManifestFromDisk(ascending[0] as TeamRunManifest).descendantSweepAt));
			assert.equal(
				readManifestFromDisk(ascending[59] as TeamRunManifest).descendantSweepAt,
				undefined,
				"the remaining 35 keep no marker ⇒ eligible on the next pass",
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("(h10) manifest.surface.workerPids reach the sweep as surfacePids", async () => {
		const cwd = makeWorkspace();
		try {
			const manifest = writeRun(cwd, "team_w11b3_surface", {
				status: "completed",
				createdAtMs: Date.now() - 120_000,
				extraManifestFields: {
					surface: {
						provider: "tmux",
						panes: { "01_01-agent": "%3" },
						workerPids: { "01_01-agent": 424_201, "02_02-agent": 424_202 },
						sessionPaths: {},
					},
				},
			});
			const plain = writeRun(cwd, "team_w11b3_plain", { status: "completed", createdAtMs: Date.now() - 120_000 });
			const seam = installSweepSeam();

			await reconcileAllStaleRuns(cwd, makeStubCache([manifest, plain]), Date.now());

			const surfaced = seam.calls.find((call) => call.runId === "team_w11b3_surface");
			assert.deepEqual(
				surfaced?.surfacePids,
				[424_201, 424_202],
				"the recorded pane pids are handed to the sweep so a LIVE pane is never a candidate",
			);
			const plainCall = seam.calls.find((call) => call.runId === "team_w11b3_plain");
			assert.ok(plainCall !== undefined);
			assert.equal(plainCall.surfacePids, undefined, "no surface state ⇒ no surface exclusion (additive field)");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ── wave 11b.4: the retry gate (HIGH-2) ─────────────────────────────────────

/**
 * 11b.4 separates "when was the last attempt" (`descendantSweepAt`) from "is
 * there still something to signal" (`descendantSweepPending`). A pending run is
 * re-selected only once `TERMINAL_SWEEP_RETRY_MS` (10 min) has elapsed, so a
 * permanently blocked leak (a live leader, a tty'd candidate) still gets retried
 * without burning a /proc scan on every pass.
 */
describe("wave 11b.4 — a pending terminal run is retried, a clean one never is", () => {
	it("(h11) pending: not selected inside the retry window, selected after it", async () => {
		const cwd = makeWorkspace();
		try {
			const now = Date.now();
			const pending = writeRun(cwd, "team_w11b4_pending", {
				status: "completed",
				createdAtMs: now - 3_600_000,
				updatedAtMs: now - 3_600_000,
				// Swept a minute ago, but the sweep proved a descendant it could not
				// signal ⇒ still due.
				sweepAt: new Date(now - 60_000).toISOString(),
				sweepPending: true,
			});
			const seam = installSweepSeam();

			await reconcileAllStaleRuns(cwd, makeStubCache([pending]), now);
			assert.equal(seam.calls.length, 0, "inside the 10-minute window a pending run must NOT be re-scanned every pass");
			assert.equal(seam.procScans, 0, "no /proc enumeration for a run that is not due");

			await reconcileAllStaleRuns(cwd, makeStubCache([pending]), now + 11 * 60_000);
			assert.deepEqual(
				seam.calls.map((call) => call.runId),
				["team_w11b4_pending"],
				"past the retry interval the leak is looked at again",
			);
			const marker = readManifestFromDisk(pending);
			assert.ok(isIsoTimestamp(marker.descendantSweepAt), "the retry refreshes the attempt time");
			assert.equal(marker.descendantSweepPending, undefined, "the retry was clean (empty /proc table) ⇒ no longer pending");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("(h12) a CLEAN marker is terminal for good — no retry, however old", async () => {
		const cwd = makeWorkspace();
		try {
			const now = Date.now();
			const clean = writeRun(cwd, "team_w11b4_clean", {
				status: "completed",
				createdAtMs: now - 86_400_000,
				updatedAtMs: now - 86_400_000,
				sweepAt: new Date(now - 86_400_000).toISOString(),
			});
			const seam = installSweepSeam();

			await reconcileAllStaleRuns(cwd, makeStubCache([clean]), now);
			assert.equal(seam.calls.length, 0, "a stamped-clean run is done, not merely old");

			await reconcileAllStaleRuns(cwd, makeStubCache([clean]), now + 86_400_000);
			assert.equal(seam.calls.length, 0, "age never resurrects a clean run — only `descendantSweepPending` does");
			assert.equal(seam.procScans, 0);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
