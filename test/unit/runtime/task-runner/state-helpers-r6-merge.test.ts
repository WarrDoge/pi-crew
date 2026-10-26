/**
 * DR-03 Cluster 1 (R6-1 HIGH + R6-4 MED) regression tests for the
 * persistSingleTaskUpdate merge point.
 *
 * R6-1 terminal-preserve: a late worker settle (incoming TERMINAL status)
 * must NOT overwrite a DIFFERENT terminal status already on disk (esp.
 * `cancelled` written by crash-recovery / stale-reconciler / external
 * cancel) — disk wins for status + error; the worker's other fields
 * (result artifacts, finishedAt) are still recorded. Non-terminal disk
 * status → incoming wins as today (normal settle pinned). Same terminal →
 * idempotent, incoming fields win as today.
 *
 * R6-4 allocation merge: the crew-broker's delegate budget reserve/roll-up
 * (tokensSpent written under the run lock, computed off the then-current
 * disk base) must survive the runner's ~1s heartbeat whole-record persist
 * which carries the stale dispatch-time (pre-reserve) copy. Rule:
 * tokensSpent = max(disk, incoming) — see mergeTaskUpdateWithDisk docblock
 * in state-helpers.ts for the derivation.
 *
 * Deterministic by construction — no timing, no child processes; broker
 * writes are simulated with direct saveRunTasks calls under the same
 * invariants the real broker holds (run lock + disk-base arithmetic).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { persistSingleTaskUpdate } from "../../../../src/runtime/task-runner/state-helpers.ts";
import { flushPendingAtomicWrites } from "../../../../src/state/atomic-write.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { resolveCanonicalDir } from "../../../fixtures/test-tempdir.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "s1", role: "executor", task: "Do {goal}" }],
};

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	// Canonicalize (same rationale as state-helpers-bug028-stale-fallback.test.ts):
	// keeps run identity stable across createRunManifest / loadRunManifestById.
	return resolveCanonicalDir(dir);
}

async function withIsolatedHome<T>(fn: () => T | Promise<T>): Promise<T> {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = makeTempDir("pi-crew-r6-merge-home-");
	process.env.PI_TEAMS_HOME = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		await removeDirWithRetry(home);
	}
}

function makeTask(id: string, status: TeamTaskState["status"], overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id,
		stepId: `step-${id}`,
		role: "executor",
		agent: "executor",
		status,
		createdAt: "2026-10-16T00:00:00.000Z",
		updatedAt: "2026-10-16T00:00:00.000Z",
		...overrides,
	} as TeamTaskState;
}

function diskTasksFor(cwd: string, runId: string): TeamTaskState[] {
	const loaded = loadRunManifestById(cwd, runId)?.tasks;
	assert.ok(loaded, "tasks.json must exist after persist");
	return loaded;
}

test("R6-1: cancelled-disk + completed-incoming → disk terminal status + error preserved", () => {
	withIsolatedHome(async () => {
		const cwd = makeTempDir("pi-crew-r6-term-");
		try {
			const created = createRunManifest({ cwd, team, workflow, goal: "r6-1 terminal preserve" });
			// Crash-recovery cancelled the task on disk while the detached
			// worker was still settling (the audit's orphan_cancelled timeline).
			const cancelledError = "run orphan-cancelled by crash recovery (crew.run.orphan_cancelled)";
			saveRunTasks(created.manifest, [makeTask("T", "cancelled", { error: cancelledError, finishedAt: "2026-10-16T00:00:01.000Z" })]);

			// The late worker settle arrives: completed + its own result fields.
			const incoming = makeTask("T", "completed", {
				finishedAt: "2026-10-16T00:00:09.000Z",
				resultArtifact: { path: "/tmp/t.txt", kind: "result" } as never,
				usage: { totalTokens: 42 } as never,
			});
			const out = persistSingleTaskUpdate(created.manifest, [incoming], incoming, undefined, true);
			flushPendingAtomicWrites();

			// Returned array keeps the disk terminal verdict…
			const outTask = out.find((t) => t.id === "T");
			assert.ok(outTask, "task must be in the returned array");
			assert.equal(outTask.status, "cancelled", "disk terminal status must be preserved, not overwritten by completed");
			assert.equal(outTask.error, cancelledError, "disk terminal error must be preserved");
			// …while the worker's own result fields are still recorded.
			assert.equal(outTask.finishedAt, "2026-10-16T00:00:09.000Z", "incoming finishedAt survives");
			assert.ok(outTask.resultArtifact, "incoming resultArtifact survives");

			// And disk agrees (post-execution aligns its event to this record).
			const diskTask = diskTasksFor(cwd, created.manifest.runId).find((t) => t.id === "T");
			assert.ok(diskTask, "task must exist on disk");
			assert.equal(diskTask.status, "cancelled");
			assert.equal(diskTask.error, cancelledError);
		} finally {
			await removeDirWithRetry(cwd);
		}
	});
});

test("R6-1: running-disk + completed-incoming → completed (normal settle path pinned)", () => {
	withIsolatedHome(async () => {
		const cwd = makeTempDir("pi-crew-r6-normal-");
		try {
			const created = createRunManifest({ cwd, team, workflow, goal: "r6-1 normal settle" });
			saveRunTasks(created.manifest, [makeTask("T", "running")]);

			const incoming = makeTask("T", "completed", {
				finishedAt: "2026-10-16T00:00:05.000Z",
				resultArtifact: { path: "/tmp/t.txt", kind: "result" } as never,
			});
			const out = persistSingleTaskUpdate(created.manifest, [incoming], incoming, undefined, true);
			flushPendingAtomicWrites();

			const outTask = out.find((t) => t.id === "T");
			assert.ok(outTask);
			assert.equal(outTask.status, "completed", "non-terminal disk status → incoming terminal wins as today");

			const diskTask = diskTasksFor(cwd, created.manifest.runId).find((t) => t.id === "T");
			assert.ok(diskTask);
			assert.equal(diskTask.status, "completed");
			assert.equal(diskTask.finishedAt, "2026-10-16T00:00:05.000Z");
		} finally {
			await removeDirWithRetry(cwd);
		}
	});
});

test("R6-1: idempotent same-terminal (completed-disk + completed-incoming) → unchanged, incoming fields win", () => {
	withIsolatedHome(async () => {
		const cwd = makeTempDir("pi-crew-r6-idem-");
		try {
			const created = createRunManifest({ cwd, team, workflow, goal: "r6-1 idempotent terminal" });
			// e.g. a settle replayed after a CAS retry: disk already terminal
			// with the SAME status — must stay a plain replace-by-id.
			saveRunTasks(created.manifest, [makeTask("T", "completed", { finishedAt: "2026-10-16T00:00:01.000Z" })]);

			const incoming = makeTask("T", "completed", {
				finishedAt: "2026-10-16T00:00:08.000Z",
				resultArtifact: { path: "/tmp/t2.txt", kind: "result" } as never,
			});
			const out = persistSingleTaskUpdate(created.manifest, [incoming], incoming, undefined, true);
			flushPendingAtomicWrites();

			const outTask = out.find((t) => t.id === "T");
			assert.ok(outTask);
			assert.equal(outTask.status, "completed", "same terminal → status unchanged");
			assert.equal(outTask.finishedAt, "2026-10-16T00:00:08.000Z", "same terminal → incoming fields win as today");

			const diskTask = diskTasksFor(cwd, created.manifest.runId).find((t) => t.id === "T");
			assert.ok(diskTask);
			assert.equal(diskTask.status, "completed");
			assert.equal(diskTask.finishedAt, "2026-10-16T00:00:08.000Z");
		} finally {
			await removeDirWithRetry(cwd);
		}
	});
});

test("R6-4: broker reserve survives a concurrent heartbeat whole-record persist", () => {
	withIsolatedHome(async () => {
		const cwd = makeTempDir("pi-crew-r6-reserve-");
		try {
			const created = createRunManifest({ cwd, team, workflow, goal: "r6-4 reserve survives heartbeat" });
			// Broker reserve landed on disk: base 100 + reserved 300 = 400
			// (crew-broker.ts admission writes this under the run lock).
			saveRunTasks(created.manifest, [makeTask("T", "running", { allocation: { tokensGranted: 1000, tokensSpent: 400 } })]);

			// The runner's ~1s heartbeat (live-executor.ts persistLiveProgress)
			// carries the stale pre-reserve copy: tokensSpent still 100.
			const staleHeartbeat = makeTask("T", "running", { allocation: { tokensGranted: 1000, tokensSpent: 100 } });
			persistSingleTaskUpdate(created.manifest, [staleHeartbeat], staleHeartbeat);
			flushPendingAtomicWrites();

			let diskTask = diskTasksFor(cwd, created.manifest.runId).find((t) => t.id === "T");
			assert.ok(diskTask?.allocation, "allocation must exist on disk");
			assert.equal(diskTask.allocation.tokensSpent, 400, "reserve must survive the stale heartbeat (max merge)");
			assert.equal(diskTask.allocation.tokensGranted, 1000);

			// Pre-admission heartbeat variant: snapshot with NO allocation at
			// all must not DELETE the broker's accounting via whole-record
			// replace (same lost-update class).
			const preAdmissionHeartbeat = makeTask("T", "running");
			persistSingleTaskUpdate(created.manifest, [preAdmissionHeartbeat], preAdmissionHeartbeat);
			flushPendingAtomicWrites();

			diskTask = diskTasksFor(cwd, created.manifest.runId).find((t) => t.id === "T");
			assert.ok(diskTask?.allocation, "allocation must survive a heartbeat that lacks it");
			assert.equal(diskTask.allocation.tokensSpent, 400);
			assert.equal(diskTask.allocation.tokensGranted, 1000);
		} finally {
			await removeDirWithRetry(cwd);
		}
	});
});

test("R6-4: roll-up final value correct across reserve/roll-up/heartbeat interleavings", () => {
	withIsolatedHome(async () => {
		const cwd = makeTempDir("pi-crew-r6-rollup-");
		try {
			const created = createRunManifest({ cwd, team, workflow, goal: "r6-4 roll-up interleaving" });
			// Base: parent task has spent 100 before any delegate.
			saveRunTasks(created.manifest, [makeTask("T", "running", { allocation: { tokensGranted: 1000, tokensSpent: 100 } })]);
			// Runner in-memory copy stays at the dispatch-time 100 for the
			// whole run (no task-runner path reloads it mid-execution).
			const staleCopy = () => makeTask("T", "running", { allocation: { tokensGranted: 1000, tokensSpent: 100 } });

			// 1. Broker reserve: 100 + 300 reserved = 400 (disk-base arithmetic).
			saveRunTasks(
				created.manifest,
				diskTasksFor(cwd, created.manifest.runId).map((t) =>
					t.id === "T" ? { ...t, allocation: { tokensGranted: 1000, tokensSpent: 400 } } : t,
				),
			);
			// 2. Heartbeat with the stale 100 copy lands mid-execution.
			const hb1 = staleCopy();
			persistSingleTaskUpdate(created.manifest, [hb1], hb1);
			flushPendingAtomicWrites();
			assert.equal(
				diskTasksFor(cwd, created.manifest.runId).find((t) => t.id === "T")?.allocation?.tokensSpent,
				400,
				"reserve survives heartbeat 1",
			);

			// 3. Broker roll-up: actual 120 → 400 − 300 + 120 = 220 on the
			// then-current base (this is exactly crew-broker.ts roll-up math).
			saveRunTasks(
				created.manifest,
				diskTasksFor(cwd, created.manifest.runId).map((t) =>
					t.id === "T" ? { ...t, allocation: { tokensGranted: 1000, tokensSpent: 220 } } : t,
				),
			);
			// 4. Another stale heartbeat.
			const hb2 = staleCopy();
			persistSingleTaskUpdate(created.manifest, [hb2], hb2);
			flushPendingAtomicWrites();
			assert.equal(
				diskTasksFor(cwd, created.manifest.runId).find((t) => t.id === "T")?.allocation?.tokensSpent,
				220,
				"roll-up result survives heartbeat 2 (max keeps disk, does not resurrect the stale 100)",
			);

			// 5. Terminal settle still carrying the stale allocation: the final
			// record must hold the reconciled 220.
			const settle = makeTask("T", "completed", {
				finishedAt: "2026-10-16T00:00:30.000Z",
				allocation: { tokensGranted: 1000, tokensSpent: 100 },
			});
			const out = persistSingleTaskUpdate(created.manifest, [settle], settle, undefined, true);
			flushPendingAtomicWrites();
			const outTask = out.find((t) => t.id === "T");
			assert.ok(outTask);
			assert.equal(outTask.status, "completed");
			assert.equal(outTask.allocation?.tokensSpent, 220, "terminal settle keeps the reconciled roll-up value");
			assert.equal(diskTasksFor(cwd, created.manifest.runId).find((t) => t.id === "T")?.allocation?.tokensSpent, 220);
		} finally {
			await removeDirWithRetry(cwd);
		}
	});
});

test("R6-1+R6-4 compose: preserved terminal verdict + allocation merge in one persist", () => {
	withIsolatedHome(async () => {
		const cwd = makeTempDir("pi-crew-r6-compose-");
		try {
			const created = createRunManifest({ cwd, team, workflow, goal: "r6-1 + r6-4 compose" });
			// Disk: cancelled by external cancel AND holding a live reserve.
			const cancelledError = "cancelled by operator (run.cancel_requested)";
			saveRunTasks(created.manifest, [
				makeTask("T", "cancelled", {
					error: cancelledError,
					finishedAt: "2026-10-16T00:00:01.000Z",
					allocation: { tokensGranted: 1000, tokensSpent: 400 },
				}),
			]);

			const incoming = makeTask("T", "completed", {
				finishedAt: "2026-10-16T00:00:09.000Z",
				resultArtifact: { path: "/tmp/t.txt", kind: "result" } as never,
				allocation: { tokensGranted: 1000, tokensSpent: 100 },
			});
			const out = persistSingleTaskUpdate(created.manifest, [incoming], incoming, undefined, true);
			flushPendingAtomicWrites();

			const outTask = out.find((t) => t.id === "T");
			assert.ok(outTask);
			assert.equal(outTask.status, "cancelled", "terminal verdict preserved");
			assert.equal(outTask.error, cancelledError, "cancel error preserved");
			assert.equal(outTask.allocation?.tokensSpent, 400, "reserve preserved through the terminal persist");
			assert.ok(outTask.resultArtifact, "worker result fields still recorded");

			const diskTask = diskTasksFor(cwd, created.manifest.runId).find((t) => t.id === "T");
			assert.ok(diskTask);
			assert.equal(diskTask.status, "cancelled");
			assert.equal(diskTask.allocation?.tokensSpent, 400);
		} finally {
			await removeDirWithRetry(cwd);
		}
	});
});
