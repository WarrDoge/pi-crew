import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withRunLock } from "../../src/state/coordination/locks.ts";
import { appendMailboxMessage } from "../../src/state/coordination/mailbox.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../src/state/types.ts";
import {
	dispatchDiagnosticExport,
	dispatchKillStaleWorkers,
	dispatchMailboxAck,
	dispatchMailboxAckAll,
	dispatchMailboxCompose,
	markStaleWorkerHeartbeatsDead,
} from "../../src/ui/run-action-dispatcher.ts";
import { sleepSync } from "../../src/utils/sleep.ts";

function createRun(): {
	cwd: string;
	ctx: ExtensionContext;
	runId: string;
	manifest: ReturnType<typeof createRunManifest>["manifest"];
} {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dispatcher-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = {
		name: "dispatch",
		description: "",
		roles: [{ name: "worker", agent: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "wf",
		description: "",
		steps: [{ id: "one", role: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const created = createRunManifest({
		cwd,
		team,
		workflow,
		goal: "dispatch",
	});
	return {
		cwd,
		ctx: { cwd } as unknown as ExtensionContext,
		runId: created.manifest.runId,
		manifest: created.manifest,
	};
}

test("mailbox dispatchers compose ack and ack all", async () => {
	const run = createRun();
	try {
		const composed = await dispatchMailboxCompose(run.ctx, run.runId, {
			from: "operator",
			to: "one",
			body: "hello",
			direction: "inbox",
		});
		assert.equal(composed.ok, true);
		const messageId = JSON.parse(composed.message).id as string;
		assert.equal((await dispatchMailboxAck(run.ctx, run.runId, messageId)).ok, true);
		appendMailboxMessage(run.manifest, {
			direction: "inbox",
			from: "a",
			to: "b",
			body: "one",
		});
		appendMailboxMessage(run.manifest, {
			direction: "inbox",
			from: "a",
			to: "b",
			body: "two",
		});
		const ackAll = await dispatchMailboxAckAll(run.ctx, run.runId);
		assert.equal(ackAll.ok, true);
		assert.match(ackAll.message, /Acknowledged/);
		// L9: the count noun is pluralised (formatCount) — `N messages` for N>1.
		// (The singular `1 message.` pin lives in the test below.)
		assert.match(ackAll.message, /^Acknowledged \d+ messages\.$/);
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});

test("mailbox ack-all with a single message reads singular (L9 formatCount)", async () => {
	const run = createRun();
	try {
		appendMailboxMessage(run.manifest, {
			direction: "inbox",
			from: "a",
			to: "b",
			body: "only one",
		});
		const ackAll = await dispatchMailboxAckAll(run.ctx, run.runId);
		assert.equal(ackAll.ok, true);
		assert.equal(ackAll.message, "Acknowledged 1 message.");
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});

test("health dispatchers mark only stale heartbeats dead and export diagnostics", async () => {
	const run = createRun();
	try {
		const staleAt = new Date(Date.now() - 90_000).toISOString();
		const freshAt = new Date().toISOString();
		saveRunTasks(run.manifest, [
			{
				id: "stale",
				runId: run.runId,
				role: "worker",
				agent: "worker",
				title: "stale",
				status: "running",
				dependsOn: [],
				cwd: run.cwd,
				heartbeat: {
					workerId: "stale",
					lastSeenAt: staleAt,
					alive: true,
				},
			},
			{
				id: "fresh",
				runId: run.runId,
				role: "worker",
				agent: "worker",
				title: "fresh",
				status: "running",
				dependsOn: [],
				cwd: run.cwd,
				heartbeat: {
					workerId: "fresh",
					lastSeenAt: freshAt,
					alive: true,
				},
			},
		]);
		const killed = await dispatchKillStaleWorkers(run.ctx, run.runId);
		assert.equal(killed.ok, true);
		assert.deepEqual(killed.data, { count: 1 });
		const reloaded = loadRunManifestById(run.cwd, run.runId);
		assert.equal(reloaded?.tasks.find((task) => task.id === "stale")?.heartbeat?.alive, false);
		assert.equal(reloaded?.tasks.find((task) => task.id === "fresh")?.heartbeat?.alive, true);
		const diagnostic = await dispatchDiagnosticExport(run.ctx, run.runId);
		assert.equal(diagnostic.ok, true);
		assert.equal(fs.existsSync(String(diagnostic.data)), true);
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});

test("dispatchDiagnosticExport reports missing run", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dispatcher-missing-"));
	try {
		const result = await dispatchDiagnosticExport({ cwd } as unknown as ExtensionContext, "missing");
		assert.equal(result.ok, false);
		assert.match(result.message, /not found/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ── R4-6 (DR-02 Wave 2 Cluster C): kill-stale is a run-locked RMW ──────────────

/** Minimal task fixture for the kill-stale sweep tests. */
function heartbeatTask(run: ReturnType<typeof createRun>, id: string, status: TeamTaskState["status"], lastSeenAt: string): TeamTaskState {
	return {
		id,
		runId: run.runId,
		role: "worker",
		agent: "worker",
		title: id,
		status,
		dependsOn: [],
		cwd: run.cwd,
		heartbeat: { workerId: id, lastSeenAt, alive: true },
	};
}

/** Standalone task fixture for the pure helper test (no run manifest needed). */
function baseTask(id: string, status: TeamTaskState["status"] = "running"): TeamTaskState {
	return {
		id,
		runId: "team_test",
		role: "worker",
		agent: "worker",
		title: id,
		status,
		dependsOn: [],
		cwd: "/tmp",
	};
}

test("R4-6 helper: markStaleWorkerHeartbeatsDead kills only running/queued tasks with stale heartbeats", () => {
	const staleAt = "2026-01-01T00:00:00.000Z";
	const freshAt = "2026-01-01T01:00:00.000Z";
	const currentMs = Date.parse("2026-01-01T01:00:30.000Z"); // 30s past freshAt, 1h past staleAt
	const { tasks, count } = markStaleWorkerHeartbeatsDead(
		[
			{ ...baseTask("stale-running"), heartbeat: { workerId: "stale-running", lastSeenAt: staleAt, alive: true } },
			{ ...baseTask("stale-queued"), status: "queued", heartbeat: { workerId: "stale-queued", lastSeenAt: staleAt, alive: true } },
			{ ...baseTask("fresh-running"), heartbeat: { workerId: "fresh-running", lastSeenAt: freshAt, alive: true } },
			{ ...baseTask("already-dead"), heartbeat: { workerId: "already-dead", lastSeenAt: staleAt, alive: false } },
			{ ...baseTask("no-heartbeat") },
			{
				...baseTask("completed-stale"),
				status: "completed",
				heartbeat: { workerId: "completed-stale", lastSeenAt: staleAt, alive: true },
			},
			{
				...baseTask("malformed-date"),
				heartbeat: { workerId: "malformed-date", lastSeenAt: "not-a-date", alive: true },
			},
		],
		currentMs,
	);
	assert.equal(count, 2);
	const byId = new Map(tasks.map((task) => [task.id, task]));
	assert.equal(byId.get("stale-running")?.heartbeat?.alive, false);
	assert.equal(byId.get("stale-queued")?.heartbeat?.alive, false);
	assert.equal(byId.get("stale-running")?.heartbeat?.lastSeenAt, new Date(currentMs).toISOString());
	assert.equal(byId.get("fresh-running")?.heartbeat?.alive, true, "fresh heartbeat must be kept");
	assert.equal(byId.get("already-dead")?.heartbeat?.alive, false, "already-dead untouched (no rewrite)");
	assert.equal(byId.get("no-heartbeat")?.heartbeat, undefined, "no-heartbeat untouched");
	assert.equal(byId.get("completed-stale")?.heartbeat?.alive, true, "terminal task is not the sweep's business");
	assert.equal(byId.get("malformed-date")?.heartbeat?.alive, true, "unparseable lastSeenAt is not provably stale — keep");
});

test("R4-6 lock contention: kill-stale skips (best-effort, non-blocking) when another context holds the run lock", async () => {
	const run = createRun();
	try {
		const staleAt = new Date(Date.now() - 90_000).toISOString();
		saveRunTasks(run.manifest, [heartbeatTask(run, "stale", "running", staleAt)]);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		// Another writer holds the run lock (e.g. a leader-side state flush).
		const holder = withRunLock(run.manifest, async () => {
			await gate;
		});
		const lockPath = path.join(run.manifest.stateRoot, "run.lock");
		const deadline = Date.now() + 2_000;
		while (!fs.existsSync(lockPath) && Date.now() < deadline) sleepSync(5);
		assert.equal(fs.existsSync(lockPath), true, "test precondition: run.lock is held");

		const skipped = await dispatchKillStaleWorkers(run.ctx, run.runId);
		assert.equal(skipped.ok, false, "contention must skip, not block or throw");
		assert.match(skipped.message, /lock/i);
		const untouched = loadRunManifestById(run.cwd, run.runId);
		assert.equal(untouched?.tasks.find((task) => task.id === "stale")?.heartbeat?.alive, true, "no write may land on contention");

		// Once the holder releases, the same sweep converges (best-effort, retryable).
		release?.();
		await holder;
		const killed = await dispatchKillStaleWorkers(run.ctx, run.runId);
		assert.equal(killed.ok, true);
		assert.deepEqual(killed.data, { count: 1 });
		const converged = loadRunManifestById(run.cwd, run.runId);
		assert.equal(converged?.tasks.find((task) => task.id === "stale")?.heartbeat?.alive, false);
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});

test("R4-6 fresh-read semantics: a heartbeat refreshed by a concurrent writer is never regressed by the sweep", async () => {
	const run = createRun();
	try {
		// Simulate the interleaving: an earlier reader saw BOTH tasks stale, but a
		// concurrent writer (under the lock) refreshed "revived" before the sweep
		// acquired it. The sweep decides on the FRESH disk state — and never writes
		// a stale array over the writer's fields.
		const staleAt = new Date(Date.now() - 90_000).toISOString();
		const refreshedAt = new Date().toISOString();
		saveRunTasks(run.manifest, [
			heartbeatTask(run, "revived", "running", refreshedAt),
			heartbeatTask(run, "still-stale", "running", staleAt),
		]);
		const killed = await dispatchKillStaleWorkers(run.ctx, run.runId);
		assert.equal(killed.ok, true);
		assert.deepEqual(killed.data, { count: 1 });
		const reloaded = loadRunManifestById(run.cwd, run.runId);
		const revived = reloaded?.tasks.find((task) => task.id === "revived");
		assert.equal(revived?.heartbeat?.alive, true, "refreshed heartbeat preserved");
		assert.equal(revived?.heartbeat?.lastSeenAt, refreshedAt, "writer's lastSeenAt not regressed");
		assert.equal(reloaded?.tasks.find((task) => task.id === "still-stale")?.heartbeat?.alive, false);
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});
