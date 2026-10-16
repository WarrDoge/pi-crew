import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { setupCrewScheduler } from "../../../../src/extension/registration/lifecycle-handlers.ts";
import { persistScheduledJobUpdate } from "../../../../src/extension/team-tool/handle-schedule.ts";
import { CrewScheduler, type ScheduledJob } from "../../../../src/runtime/scheduling/scheduler.ts";
import { loadCrewSettingsTiers, saveCrewSettings } from "../../../../src/runtime/settings-store.ts";

/**
 * R6-2 (round-6 audit, HIGH): scheduled jobs died after restart.
 *
 * Root cause chain (lead-verified at spec time):
 *  1. fire() flips lastStatus:"running" (memory) and the executor's async
 *     completion persisted the job snapshot BEFORE flipping the terminal
 *     status — so the on-disk record said "running".
 *  2. The `updated`-event persist flow armCron's docstring claimed existed
 *     was never wired (the emit callback only notified), so the terminal
 *     flip (success/error) stayed memory-only forever.
 *  3. A process death in that window left "running" persisted; on reload
 *     fire()'s in-flight guard treated it as live backpressure and skipped
 *     EVERY later occurrence — the job never ran again.
 *
 * Fixes under test:
 *  (a) lifecycle emit wiring persists `updated` events (test: wiring),
 *  (c) settings-store load normalization strips the stale "running" flag
 *      (tests: restart round-trip + surgical),
 * plus the restart round-trip: crash snapshot on disk → reload → fires.
 *
 * The in-flight guard itself (still correct within one process) is pinned by
 * scheduler-inflight-guard.test.ts.
 */

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
	return {
		id: "job-rt",
		name: "round-trip probe",
		description: "",
		schedule: "50ms",
		scheduleType: "interval",
		intervalMs: 50,
		subagentType: "team",
		prompt: "{}",
		enabled: true,
		createdAt: new Date().toISOString(),
		runCount: 3,
		...overrides,
	};
}

/** Hermetic scratch dir + a pinned (absent) user-tier global file plus the
 * Wave B2 opt-in flags so project-tier scheduledJobs (where
 * persistScheduledJobUpdate writes) register in `effectiveScheduledJobs`. */
function makeScratchProject(): { dir: string; globalFile: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-persist-reload-"));
	const globalFile = path.join(dir, "user-crew-settings.json");
	fs.writeFileSync(globalFile, JSON.stringify({ schedulingEnabled: true, allowProjectScheduledJobs: true }), "utf-8");
	return { dir, globalFile };
}

/** Minimal headless fakes for setupCrewScheduler: no UI (toast bridge no-ops),
 * no pi event bus, cleanedUp=false. The executor is never invoked by these
 * tests (no job fires through it), so handleTeamTool never runs. */
function fakeLifecycleDeps(dir: string): {
	pi: Parameters<typeof setupCrewScheduler>[0];
	ctx: Parameters<typeof setupCrewScheduler>[1];
	extensionCtx: Parameters<typeof setupCrewScheduler>[2];
} {
	return {
		pi: { events: undefined } as unknown as Parameters<typeof setupCrewScheduler>[0],
		ctx: { cleanedUp: false } as unknown as Parameters<typeof setupCrewScheduler>[1],
		extensionCtx: { cwd: dir, hasUI: false, ui: undefined } as unknown as Parameters<typeof setupCrewScheduler>[2],
	};
}

test("R6-2(a) wiring: scheduler `updated` events persist the job to crew-settings", () => {
	const { dir, globalFile } = makeScratchProject();
	try {
		const job = makeJob({ id: "job-wiring", scheduleType: "interval", schedule: "3600000ms", intervalMs: 3_600_000 });
		// Seed the settings file the way handleSchedule does on job creation.
		saveCrewSettings({ scheduledJobs: [job] }, dir);

		const { pi, ctx, extensionCtx } = fakeLifecycleDeps(dir);
		const scheduler = setupCrewScheduler(pi, ctx, extensionCtx, "session-wiring");
		try {
			// Register the job in the live scheduler (as session_start does), then
			// update() — which emits {type:"updated"}. The production wiring must
			// persist that event (the flow armCron's docstring claimed existed).
			scheduler.add(job);
			scheduler.update(job.id, { lastStatus: "success", runCount: 4, lastRun: "2026-10-16T09:00:00.000Z" });
		} finally {
			scheduler.stop();
		}

		const reloaded = loadCrewSettingsTiers(dir, globalFile).effectiveScheduledJobs as ScheduledJob[];
		assert.equal(reloaded.length, 1, "job must still be on disk after the update");
		assert.equal(reloaded[0].lastStatus, "success", "`updated` events must persist terminal status");
		assert.equal(reloaded[0].runCount, 4, "`updated` events must persist runCount");
		assert.equal(reloaded[0].lastRun, "2026-10-16T09:00:00.000Z", "`updated` events must persist lastRun");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("R6-2 restart round-trip: crash snapshot (lastStatus 'running') reloads normalized and fires again", async () => {
	const { dir, globalFile } = makeScratchProject();
	try {
		const job = makeJob({ id: "job-crash", runCount: 7, lastRun: "2026-10-16T00:00:00.000Z" });
		saveCrewSettings({ scheduledJobs: [job] }, dir);
		// The exact snapshot the PRE-FIX executor left behind when the process
		// died mid-run: the fire-time "running" flag persisted, terminal flip lost.
		persistScheduledJobUpdate(dir, { ...job, lastStatus: "running" });

		// Control: the guard is what makes a stale "running" lethal — a job still
		// carrying it in memory must NOT dispatch (pinned behavior).
		{
			let dispatches = 0;
			const control = new CrewScheduler();
			control.start({
				emit: () => undefined,
				executor: () => {
					dispatches++;
					return "agent-control";
				},
				finalizer: () => undefined,
			});
			control.add(makeJob({ ...job, lastStatus: "running" }));
			(control as unknown as { fire: (id: string, force?: boolean) => void }).fire(job.id, false);
			assert.equal(dispatches, 0, "in-flight guard must still suppress a genuinely-running job");
			control.stop();
		}

		// Restart: reload through the same tiers view session_start registers from.
		const loaded = loadCrewSettingsTiers(dir, globalFile).effectiveScheduledJobs as ScheduledJob[];
		assert.equal(loaded.length, 1, "job must reload from settings");
		assert.notEqual(loaded[0].lastStatus, "running", "R6-2(c): stale in-flight flag must be stripped at load");
		assert.equal(loaded[0].runCount, 7, "unrelated fields must survive normalization");
		assert.equal(loaded[0].id, job.id);

		// The reloaded job must FIRE (pre-fix: permanent skip → job died).
		let dispatches = 0;
		const restarted = new CrewScheduler();
		restarted.start({
			emit: () => undefined,
			executor: () => {
				dispatches++;
				return "agent-restarted";
			},
			finalizer: () => undefined,
		});
		restarted.add(loaded[0]);
		await new Promise((r) => setTimeout(r, 200));
		restarted.stop();
		assert.ok(dispatches >= 1, `reloaded job must fire after restart, got ${dispatches} dispatches`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("R6-2(c) normalization is surgical: terminal statuses (success/error) survive load", () => {
	const { dir, globalFile } = makeScratchProject();
	try {
		// User-tier jobs always load (no opt-in needed) — put the three statuses
		// in the trusted global file.
		fs.writeFileSync(
			globalFile,
			JSON.stringify({
				schedulingEnabled: true,
				allowProjectScheduledJobs: true,
				scheduledJobs: [
					makeJob({ id: "job-ok", lastStatus: "success", runCount: 11 }),
					makeJob({ id: "job-fail", lastStatus: "error", runCount: 2 }),
					makeJob({ id: "job-stale", lastStatus: "running", runCount: 5 }),
				],
			}),
			"utf-8",
		);
		const loaded = loadCrewSettingsTiers(dir, globalFile).effectiveScheduledJobs as ScheduledJob[];
		const byId = new Map(loaded.map((j) => [j.id, j]));
		assert.equal(byId.get("job-ok")?.lastStatus, "success", "terminal success must survive load");
		assert.equal(byId.get("job-fail")?.lastStatus, "error", "terminal error must survive load");
		assert.notEqual(byId.get("job-stale")?.lastStatus, "running", "stale running must be stripped");
		assert.equal(byId.get("job-stale")?.runCount, 5, "sibling fields must survive the strip");
		assert.equal(loaded.length, 3, "no job may be dropped by normalization");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
