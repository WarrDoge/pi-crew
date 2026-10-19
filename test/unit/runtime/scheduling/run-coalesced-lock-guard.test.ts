/**
 * M3-8 (R23-F1, fix-wave 6): coalesced group writes must read + write INSIDE
 * run.lock — a terminal write must never be clobbered by a peer writer that
 * lands between the read and the save.
 *
 * The pre-fix helpers (`persistGroupHeartbeats` / `repairGroupTerminalWrite`)
 * did a sync `loadRunManifestById` followed by a LOCKLESS awaited
 * `saveRunTasksAsync`. The FIND-06/R15-3/R3-H1 guards made the merge
 * group-scoped, but read and write were still not atomic: a concurrent group's
 * write, the 15s heartbeat interval, or any external run-lock writer could
 * interleave so the LATER writer persisted its pre-terminal snapshot over the
 * committed terminal state — a terminal write permanently lost with NO crash
 * required (runtime-proven 5/5 in R23).
 *
 * Fix: both helper bodies run inside `withRunLockBusyRetryAsync` with the
 * fresh reload INSIDE the critical section. These tests pin BOTH orderings the
 * review requires, deterministically, by holding run.lock from the test and
 * observing that the helper's write cannot land while the lock is held:
 *
 *   ordering 1 — heartbeat-lands-last: `persistGroupHeartbeats` must queue
 *                behind the holder (no write while held), and once it lands the
 *                peer's terminal state written during the hold survives.
 *   ordering 2 — peer-terminal-lands-first: `repairGroupTerminalWrite` queued
 *                behind the holder must (a) not write while held, and (b) pick
 *                up the peer terminal state that landed during the hold (its
 *                read happens INSIDE the lock), applying only its own group's
 *                terminal state on top.
 *
 * Pre-fix (lockless) both orderings write immediately during the hold → red.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	__test__persistGroupHeartbeats,
	__test__repairGroupTerminalWrite,
} from "../../../../src/runtime/scheduling/run-coalesced-task-group.ts";
import { withRunLock } from "../../../../src/state/coordination/locks.ts";
import { createRunManifest, loadRunManifestById, saveRunTasksAsync } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";

const team: TeamConfig = {
	name: "coalesced-lock-guard",
	description: "R23-F1 lock-held read+write",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-lock-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function makeTask(id: string, status: TeamTaskState["status"], runId: string, cwd: string): TeamTaskState {
	return {
		id,
		runId,
		stepId: "batch",
		role: "worker",
		agent: "worker",
		title: id,
		status,
		dependsOn: [],
		cwd,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor: timeout");
		await sleep(10);
	}
}

function taskById(manifest: TeamRunManifest, id: string): TeamTaskState {
	const loaded = loadRunManifestById(manifest.cwd, manifest.runId);
	return loaded!.tasks.find((t) => t.id === id)!;
}

/** Hold run.lock from a context the helper call does NOT inherit (lockCtx
 *  re-entrance is per async context, so the test body is a foreign contender —
 *  exactly like a peer group / heartbeat tick). */
async function withHeldLock(manifest: TeamRunManifest, body: (release: () => void) => Promise<void>): Promise<void> {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let held = false;
	const holder = withRunLock(manifest, async () => {
		held = true;
		await gate;
	});
	await waitFor(() => held);
	try {
		await body(() => release());
	} finally {
		release();
		await holder;
	}
}

test("R23-F1 ordering 1: heartbeat save is queued behind run.lock and never clobbers a peer terminal write", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, goal: "R23-F1 heartbeat ordering" });
		const GROUP_ID = "g1";
		const PEER_ID = "peer1";
		await saveRunTasksAsync(manifest, [
			makeTask(GROUP_ID, "running", manifest.runId, cwd),
			makeTask(PEER_ID, "running", manifest.runId, cwd),
		]);

		await withHeldLock(manifest, async (release) => {
			const pending = __test__persistGroupHeartbeats(manifest, [GROUP_ID], 4242);
			await sleep(250);
			// The helper's write must NOT have landed while run.lock is held.
			assert.equal(
				taskById(manifest, GROUP_ID).heartbeat,
				undefined,
				"heartbeat write must wait for run.lock (pre-fix: lockless save lands immediately)",
			);

			// A peer writer terminalises the OTHER task during the hold.
			const during = loadRunManifestById(manifest.cwd, manifest.runId)!;
			await saveRunTasksAsync(
				manifest,
				during.tasks.map((t) =>
					t.id === PEER_ID ? { ...t, status: "completed" as const, finishedAt: new Date().toISOString() } : t,
				),
			);
			release();
			await pending;
		});

		// Heartbeat landed for the group task; the peer's terminal state survives
		// because the read happens INSIDE the lock (post-peer-write).
		const groupTask = taskById(manifest, GROUP_ID);
		assert.equal(groupTask.status, "running", "heartbeat never flips task status");
		assert.ok(groupTask.heartbeat, "heartbeat landed after the lock was released");
		assert.equal(groupTask.heartbeat?.pid, 4242, "worker pid stamped");
		const peerTask = taskById(manifest, PEER_ID);
		assert.equal(peerTask.status, "completed", "peer terminal state must NOT be reverted by the heartbeat save");
		assert.equal(peerTask.heartbeat, undefined, "heartbeat save stays group-scoped");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("R23-F1 ordering 2: terminal repair is queued behind run.lock, re-reads inside it, and preserves the peer terminal state", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, goal: "R23-F1 terminal ordering" });
		const GROUP_ID = "g1";
		const PEER_ID = "peer1";
		await saveRunTasksAsync(manifest, [
			makeTask(GROUP_ID, "running", manifest.runId, cwd),
			makeTask(PEER_ID, "running", manifest.runId, cwd),
		]);

		const updatedTasks: TeamTaskState[] = [
			{ ...makeTask(GROUP_ID, "completed", manifest.runId, cwd), finishedAt: new Date().toISOString() },
			makeTask(PEER_ID, "running", manifest.runId, cwd), // stale snapshot: peer still running
		];

		await withHeldLock(manifest, async (release) => {
			const pending = __test__repairGroupTerminalWrite(manifest, [GROUP_ID], updatedTasks);
			await sleep(250);
			assert.equal(
				taskById(manifest, GROUP_ID).status,
				"running",
				"terminal write must wait for run.lock (pre-fix: lockless save lands immediately)",
			);

			// Peer terminal write lands FIRST — exactly the ordering that used to
			// resurrect "running" from the helper's pre-lock read.
			const during = loadRunManifestById(manifest.cwd, manifest.runId)!;
			await saveRunTasksAsync(
				manifest,
				during.tasks.map((t) =>
					t.id === PEER_ID ? { ...t, status: "cancelled" as const, finishedAt: new Date().toISOString() } : t,
				),
			);
			release();
			await pending;
		});

		const groupTask = taskById(manifest, GROUP_ID);
		assert.equal(groupTask.status, "completed", "group terminal state lands");
		assert.ok(groupTask.finishedAt, "group terminal finishedAt applied");
		const peerTask = taskById(manifest, PEER_ID);
		assert.equal(peerTask.status, "cancelled", "peer terminal state that landed during the hold is preserved");
		assert.ok(peerTask.finishedAt, "peer finishedAt preserved");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
