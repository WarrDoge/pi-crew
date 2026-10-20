import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DWF_CHECKPOINT_VERSION, type DwfCheckpointState, DwfStore } from "../../../src/runtime/dwf-state-store.ts";
import { CrewScheduler, type ScheduleChangeEvent, type ScheduledJob } from "../../../src/runtime/scheduling/scheduler.ts";
import { loadRunManifestById, loadRunManifestByIdAsync } from "../../../src/state/stores/state-store.ts";

/**
 * WAVE 7 LOW-tail pins (2026-10-20): scheduler event-order (R14-C4),
 * best-effort manifest sweep robustness (R2-L-A1), and the DWF dispatch
 * fingerprint roundtrip (R14-C3 store half — the runner mismatch-event half
 * is pinned in dynamic-workflow-runner's suite via its events harness).
 */

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-w7-low-"));
}

// ── R14-C4: `added` event carries the post-arm job state ──────────────────

function makeJob(overrides: Partial<ScheduledJob>): ScheduledJob {
	return {
		id: "job-w7",
		name: "w7 probe",
		description: "",
		schedule: "",
		scheduleType: "once",
		subagentType: "team",
		prompt: "{}",
		enabled: true,
		createdAt: new Date().toISOString(),
		runCount: 0,
		...overrides,
	} as ScheduledJob;
}

test("R14-C4: past `once` job emits `added` with the post-arm (disabled, error) state", () => {
	const s = new CrewScheduler();
	const events: ScheduleChangeEvent[] = [];
	s.start({
		emit: (e) => events.push(e),
		executor: () => "run-x",
		finalizer: () => undefined,
	});
	try {
		s.add(makeJob({ schedule: "2000-01-01T00:00:00.000Z" })); // far past → arm() disables
		const added = events.find((e) => e.type === "added");
		assert.ok(added && added.type === "added", "added event must fire");
		const job = added.job;
		assert.equal(job.enabled, false, "added payload must reflect post-arm state (disabled)");
		assert.equal(job.lastStatus, "error", "added payload must carry the arm() error status");
	} finally {
		s.stop();
	}
});

test("R14-C4 (control): future `once` job emits `added` with enabled=true unchanged", () => {
	const s = new CrewScheduler();
	const events: ScheduleChangeEvent[] = [];
	s.start({
		emit: (e) => events.push(e),
		executor: () => "run-x",
		finalizer: () => undefined,
	});
	try {
		const future = new Date(Date.now() + 60_000).toISOString();
		s.add(makeJob({ schedule: future }));
		const added = events.find((e) => e.type === "added");
		assert.ok(added && added.type === "added", "added event must fire");
		assert.equal(added.job.enabled, true, "future job stays enabled in the added payload");
		assert.notEqual(added.job.lastStatus, "error", "no error status for a future job");
	} finally {
		s.stop();
	}
});

// ── R2-L-A1: a vanished run must read as undefined, never throw ───────────

test("R2-L-A1: loadRunManifestById returns undefined (no throw) when the manifest vanished", () => {
	const dir = tmp();
	try {
		const stateRoot = path.join(dir, "state", "runs", "team_gone_1234");
		fs.mkdirSync(stateRoot, { recursive: true });
		// Manifest never existed (or was pruned mid-sweep): the stat inside the
		// retry loop must map ENOENT → undefined (best-effort sweep contract).
		assert.equal(loadRunManifestById(dir, "team_gone_1234"), undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("R2-L-A1 (async twin): loadRunManifestByIdAsync returns undefined (no throw) on ENOENT", async () => {
	const dir = tmp();
	try {
		const stateRoot = path.join(dir, "state", "runs", "team_gone_async");
		fs.mkdirSync(stateRoot, { recursive: true });
		assert.equal(await loadRunManifestByIdAsync(dir, "team_gone_async"), undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ── R14-C3 (store half): dispatchContext fingerprints survive the roundtrip

test("R14-C3: DwfStore roundtrips the dispatchContext fingerprint (additive, version-stable)", () => {
	const dir = tmp();
	try {
		const store = new DwfStore(dir);
		const state: DwfCheckpointState = {
			version: DWF_CHECKPOINT_VERSION,
			runId: "team_w7_c3",
			vars: { x: 1 },
			phases: ["p1"],
			currentPhase: "p1",
			logs: [],
			spent: 0,
			agentCount: 0,
			dispatchContext: { modelOverride: "zai/glm-5.3", team: "implementation" },
			updatedAt: new Date().toISOString(),
		};
		store.save(state);
		const loaded = store.load();
		assert.ok(loaded, "checkpoint must load");
		assert.deepEqual(loaded.dispatchContext, { modelOverride: "zai/glm-5.3", team: "implementation" });
		// Legacy checkpoint without the field still loads (absent → skipped check).
		const legacy: DwfCheckpointState = { ...state, dispatchContext: undefined };
		delete (legacy as Partial<DwfCheckpointState>).dispatchContext;
		store.save(legacy);
		const loadedLegacy = store.load();
		assert.ok(loadedLegacy);
		assert.equal(loadedLegacy.dispatchContext, undefined, "legacy checkpoint loads without the fingerprint");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
