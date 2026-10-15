/**
 * D5 (DR-02 Wave 2 Cluster C, 2026-10-15): the goal-loop post-turn
 * saveRunTasks(turnResult.manifest, turnResult.tasks) was an UNLOCKED write
 * of the executor's in-memory snapshot — it clobbered any NEWER state written
 * under the run lock between the executor's last persist and that save
 * (worker heartbeats/lastSeenAt, task claims, delegate statuses).
 *
 * The fix is a run-locked RMW with a fresh re-read inside the lock plus a
 * field-level merge (mergeTurnFinalTasksOntoFresh). The pure helper is
 * unit-tested directly (repo seam pattern — see
 * state-helpers-cas-contention.test.ts for the rationale against module
 * mocks); the interleaving itself is simulated at the disk seam by writing
 * the "concurrent writer's" newer state to tasks.json and comparing the OLD
 * bare-save shape against the NEW merge shape, plus a source-level wiring
 * pin (WI-2 precedent, goal-loop-lock-heartbeat.test.ts).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { mergeTurnFinalTasksOntoFresh } from "../../../../src/runtime/goal-workflow/goal-loop-runner.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "worker", agent: "worker" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "work", role: "worker", task: "Work {goal}" }],
};

function makeTask(manifest: ReturnType<typeof createRunManifest>["manifest"], id: string, status: TeamTaskState["status"]): TeamTaskState {
	return {
		id,
		runId: manifest.runId,
		role: "worker",
		agent: "worker",
		title: id,
		status,
		dependsOn: [],
		cwd: manifest.cwd,
	};
}

// ── Pure helper: field ownership + terminal-preserve ──────────────────────────

test("D5 merge: applies turn-owned terminal fields, never regresses fresh heartbeat/claim/delegate data", () => {
	const manifest = { runId: "team_x", cwd: "/tmp" } as ReturnType<typeof createRunManifest>["manifest"];
	const newerSeenAt = "2026-10-15T12:00:00.000Z";
	const olderSeenAt = "2026-10-15T11:00:00.000Z";
	const fresh: TeamTaskState = {
		...makeTask(manifest, "t1", "running"),
		heartbeat: { workerId: "t1", lastSeenAt: newerSeenAt, alive: true },
		claim: { owner: "worker-1", token: "tok-2", leasedUntil: newerSeenAt },
		usage: { input: 20, output: 30, cacheWrite: 0 },
	};
	const turn: TeamTaskState = {
		...makeTask(manifest, "t1", "running"),
		status: "completed",
		finishedAt: "2026-10-15T11:30:00.000Z",
		resultArtifact: {
			kind: "result",
			path: "results/t1.md",
			createdAt: "2026-10-15T11:30:00.000Z",
			producer: "worker",
			retention: "run",
		},
		exitCode: 0,
		heartbeat: { workerId: "t1", lastSeenAt: olderSeenAt, alive: true },
		usage: { input: 1, output: 2, cacheWrite: 0 },
	};
	const merged = mergeTurnFinalTasksOntoFresh([fresh], [turn]);
	assert.equal(merged.length, 1);
	const task = merged[0]!;
	assert.equal(task.status, "completed", "turn owns status");
	assert.equal(task.finishedAt, "2026-10-15T11:30:00.000Z", "turn owns finishedAt");
	assert.deepEqual(
		task.resultArtifact,
		{ kind: "result", path: "results/t1.md", createdAt: "2026-10-15T11:30:00.000Z", producer: "worker", retention: "run" },
		"turn owns resultArtifact",
	);
	assert.equal(task.exitCode, 0, "turn owns exitCode");
	assert.equal(task.heartbeat?.lastSeenAt, newerSeenAt, "fresh heartbeat/lastSeenAt must NOT be regressed");
	assert.equal(task.heartbeat?.alive, true);
	assert.deepEqual(task.claim, fresh.claim, "fresh claim must survive verbatim");
	assert.deepEqual(task.usage, { input: 20, output: 30, cacheWrite: 0 }, "fresh usage must survive (not the turn's stale copy)");
});

test("D5 merge: terminal-preserve — a task already terminal in the fresh read is never re-decided by the turn", () => {
	const manifest = { runId: "team_x", cwd: "/tmp" } as ReturnType<typeof createRunManifest>["manifest"];
	const fresh: TeamTaskState = {
		...makeTask(manifest, "t1", "cancelled"),
		finishedAt: "2026-10-15T12:00:00.000Z",
		error: "cancelled by operator",
	};
	const turn: TeamTaskState = {
		...makeTask(manifest, "t1", "running"),
		status: "completed",
		finishedAt: "2026-10-15T11:00:00.000Z",
	};
	const merged = mergeTurnFinalTasksOntoFresh([fresh], [turn]);
	assert.equal(merged[0]?.status, "cancelled", "external terminal decision wins");
	assert.equal(merged[0]?.finishedAt, "2026-10-15T12:00:00.000Z");
	assert.deepEqual(merged[0], fresh, "terminal fresh task is kept verbatim (object equality)");
});

test("D5 merge: turn tasks missing from the fresh read are appended; fresh-only tasks are kept verbatim", () => {
	const manifest = { runId: "team_x", cwd: "/tmp" } as ReturnType<typeof createRunManifest>["manifest"];
	const freshA = { ...makeTask(manifest, "a", "running"), status: "completed" as const, finishedAt: "2026-10-15T11:00:00.000Z" };
	const freshC = makeTask(manifest, "c", "running");
	const turnA = { ...makeTask(manifest, "a", "running"), status: "completed" as const, finishedAt: "2026-10-15T11:00:00.000Z" };
	const turnB = { ...makeTask(manifest, "b", "running"), status: "failed" as const, error: "boom" };
	const merged = mergeTurnFinalTasksOntoFresh([freshA, freshC], [turnA, turnB]);
	assert.equal(merged.length, 3);
	assert.deepEqual(
		merged.find((task) => task.id === "c"),
		freshC,
		"fresh-only task untouched",
	);
	const b = merged.find((task) => task.id === "b");
	assert.ok(b, "turn-only task must be appended");
	assert.equal(b.status, "failed");
});

// ── Interleaving at the disk seam: old bare save clobbers, merge preserves ────

test("D5 interleaving: a concurrent writer's fresh state survives the post-turn persist (old bare save would clobber it)", () => {
	const setup = (prefix: string) => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const created = createRunManifest({ cwd, team, workflow, goal: "d5 turn" });
		return { cwd, created };
	};
	const olderSeenAt = "2026-10-15T11:00:00.000Z";
	const newerSeenAt = "2026-10-15T11:59:00.000Z";
	const old = setup("pi-crew-d5-old-");
	const neu = setup("pi-crew-d5-new-");
	// The turn's in-memory snapshot: completed, but its heartbeat copy predates
	// the concurrent writer's refresh.
	const turnTaskFor = (created: ReturnType<typeof createRunManifest>): TeamTaskState => ({
		...makeTask(created.manifest, "t1", "running"),
		status: "completed",
		finishedAt: "2026-10-15T11:30:00.000Z",
		heartbeat: { workerId: "t1", lastSeenAt: olderSeenAt, alive: true },
	});
	try {
		// OLD shape (the ":757" bug): saveRunTasks(manifest, turnResult.tasks)
		// over a tasks.json a concurrent writer just refreshed under the lock.
		saveRunTasks(old.created.manifest, [
			{ ...makeTask(old.created.manifest, "t1", "running"), heartbeat: { workerId: "t1", lastSeenAt: newerSeenAt, alive: true } },
		]);
		saveRunTasks(old.created.manifest, [turnTaskFor(old.created)]); // ← the old unlocked bare save
		const oldDisk = loadRunManifestById(old.cwd, old.created.manifest.runId)?.tasks.find((task) => task.id === "t1");
		assert.equal(oldDisk?.heartbeat?.lastSeenAt, olderSeenAt, "counterfactual pin: the bare save regressed the writer's lastSeenAt");

		// NEW shape: fresh re-read + merge — writer's fields preserved, turn-owned
		// fields applied.
		saveRunTasks(neu.created.manifest, [
			{ ...makeTask(neu.created.manifest, "t1", "running"), heartbeat: { workerId: "t1", lastSeenAt: newerSeenAt, alive: true } },
		]);
		const freshTasks = loadRunManifestById(neu.cwd, neu.created.manifest.runId)?.tasks ?? [];
		saveRunTasks(neu.created.manifest, mergeTurnFinalTasksOntoFresh(freshTasks, [turnTaskFor(neu.created)]));
		const newDisk = loadRunManifestById(neu.cwd, neu.created.manifest.runId)?.tasks.find((task) => task.id === "t1");
		assert.equal(newDisk?.heartbeat?.lastSeenAt, newerSeenAt, "merge must preserve the concurrent writer's lastSeenAt");
		assert.equal(newDisk?.status, "completed", "turn-owned status still applied");
		assert.equal(newDisk?.finishedAt, "2026-10-15T11:30:00.000Z", "turn-owned finishedAt still applied");
	} finally {
		fs.rmSync(old.cwd, { recursive: true, force: true });
		fs.rmSync(neu.cwd, { recursive: true, force: true });
	}
});

// ── Source-level wiring pin (WI-2 precedent) ──────────────────────────────────

test("D5 wiring pin: the post-turn persist is a withRunLockSync RMW feeding the merge a fresh re-read", () => {
	const src = fs.readFileSync(path.join(import.meta.dirname, "../../../../src/runtime/goal-workflow/goal-loop-runner.ts"), "utf-8");
	const lockIdx = src.indexOf("withRunLockSync(turnResult.manifest");
	assert.ok(lockIdx > -1, "post-turn persist must be wrapped in withRunLockSync");
	const loadIdx = src.indexOf("loadRunManifestById(turnResult.manifest.cwd", lockIdx);
	assert.ok(loadIdx > lockIdx, "fresh re-read must happen INSIDE the lock");
	const mergeIdx = src.indexOf("mergeTurnFinalTasksOntoFresh(fresh.tasks, turnResult.tasks)", lockIdx);
	assert.ok(mergeIdx > loadIdx, "the save must merge onto the freshly read tasks");
	// The old unlocked bare save must be gone.
	assert.ok(
		!src.includes("saveRunTasks(turnResult.manifest, turnResult.tasks)"),
		"the pre-D5 bare save of the executor snapshot must not exist",
	);
});
