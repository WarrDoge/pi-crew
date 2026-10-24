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
 *   h3  30 unswept terminal runs ⇒ only the 25 newest are swept (per-pass cap)
 *   h4  a RUNNING run keeps the old path and is never swept
 *   h5  old manifests load; an unknown field is neither required nor stripped
 *   h6  kill switch OFF ⇒ no sweep AND no marker (stays eligible)
 *   h7  a throwing sweep ⇒ no marker (retried next pass)
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
	workerPid?: number;
	sweepAt?: string;
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
		updatedAt: new Date(createdAtMs).toISOString(),
		...(options.sweepAt === undefined ? {} : { descendantSweepAt: options.sweepAt }),
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

function makeStubCache(manifests: TeamRunManifest[]): ManifestCache {
	const byId = new Map(manifests.map((manifest) => [manifest.runId, manifest]));
	return {
		list: () => manifests,
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
			const manifest = writeRun(cwd, "team_w11b2_h1", { status: "completed" });
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
			assert.equal(readManifestFromDisk(manifest).status, "completed", "stamping must not disturb the run status");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("(h2) second pass skips the stamped run: collectRunDescendants 0 calls", async () => {
		const cwd = makeWorkspace();
		try {
			const manifest = writeRun(cwd, "team_w11b2_h2", { status: "completed" });
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

	it("(h3) 30 unswept completed runs ⇒ only the 25 newest are swept per pass", async () => {
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
			const expected = Array.from({ length: 25 }, (_, offset) => `team_w11b2_r${String(29 - offset).padStart(2, "0")}`);
			assert.equal(swept.length, 25, "the per-pass cap is exactly 25 (/proc scan budget)");
			assert.deepEqual(swept, expected, "newest createdAt first; the 5 oldest are deferred to a later pass");
			// Deferred runs keep NO marker ⇒ eligible on the next pass.
			for (let index = 0; index < 5; index += 1) {
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
			const manifest = writeRun(cwd, "team_w11b2_h6", { status: "completed" });
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
			const manifest = writeRun(cwd, "team_w11b2_h7", { status: "completed" });
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
