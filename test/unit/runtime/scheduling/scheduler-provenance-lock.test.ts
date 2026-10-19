/**
 * M3-7 (R22-F2 / F22-2, fix-wave 6): the scheduler provenance stamp must be
 * written INSIDE run.lock through the terminal-preserving save path.
 *
 * Pre-fix, the scheduled executor did
 *   `atomicWriteJson(stateRoot + "/manifest.json", {...loaded.manifest, schedulerJobId, schedulerName})`
 * — a RAW write that (a) bypassed run.lock (racing team-runner's
 * saveRunManifest/saveRunManifestAsync → lost update of usage/artifacts) and
 * (b) bypassed `preserveDiskTerminalStatus` (state-store.ts), so a
 * cancel/reconciler terminal flip landing in the window was resurrected to
 * "running" on disk. It fired on EVERY scheduled fire.
 *
 * Fix under test: `stampSchedulerRunProvenance` re-reads INSIDE run.lock
 * (bounded busy-retry) and persists via saveRunManifest (terminal-preserving,
 * cache-invalidating). Pins:
 *  1. the stamp lands the provenance keys (traceability preserved);
 *  2. no write lands while run.lock is held by a foreign holder, and a
 *     terminal status written during the hold survives the stamp;
 *  3. structural: the raw atomicWriteJson manifest write is gone.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { stampSchedulerRunProvenance } from "../../../../src/extension/registration/lifecycle-handlers.ts";
import { withRunLock } from "../../../../src/state/coordination/locks.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";

const LIFECYCLE_SRC = "src/extension/registration/lifecycle-handlers.ts";

const team: TeamConfig = {
	name: "scheduler-provenance",
	description: "M3-7 lock-held provenance stamp",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-sched-prov-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
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

/** Hold run.lock from a context the stamp does NOT inherit (lockCtx
 *  re-entrance is per async context → the test body is a foreign contender,
 *  exactly like the detached runner's state flush). */
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

test("M3-7: stampSchedulerRunProvenance persists schedulerJobId/schedulerName (and is a no-op for an unknown run)", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, goal: "M3-7 provenance" });
		const stamped = await stampSchedulerRunProvenance(cwd, manifest.runId, { id: "job-42", name: "nightly review" });
		assert.equal(stamped, true, "stamp must report success");

		const onDisk = loadRunManifestById(cwd, manifest.runId)!.manifest as TeamRunManifest & {
			schedulerJobId?: string;
			schedulerName?: string;
		};
		assert.equal(onDisk.schedulerJobId, "job-42", "schedulerJobId persisted for traceability");
		assert.equal(onDisk.schedulerName, "nightly review", "schedulerName persisted for traceability");

		// Unknown/pruned run → best-effort false, never a throw.
		assert.equal(await stampSchedulerRunProvenance(cwd, "run-does-not-exist", { id: "j", name: "n" }), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("M3-7: stamp is written inside run.lock and never resurrects a terminal status", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, goal: "M3-7 terminal preserve" });
		saveRunManifest({ ...manifest, status: "running" }, { allowTerminalExit: true });

		await withHeldLock(manifest, async (release) => {
			// Outer load sees the pre-cancel manifest (status "running"), then the
			// stamp queues behind the held run.lock.
			const pending = stampSchedulerRunProvenance(cwd, manifest.runId, { id: "job-7", name: "cancel-window" });
			await sleep(250);
			const held = loadRunManifestById(cwd, manifest.runId)!.manifest as TeamRunManifest & { schedulerJobId?: string };
			assert.equal(
				held.schedulerJobId,
				undefined,
				"stamp must NOT write while run.lock is held (pre-fix: raw write lands immediately)",
			);
			assert.equal(held.status, "running", "nothing written during the hold");

			// A cancel/reconciler terminal flip lands in the window.
			saveRunManifest({ ...loadRunManifestById(cwd, manifest.runId)!.manifest, status: "cancelled" }, { allowTerminalExit: true });
			release();
			assert.equal(await pending, true, "stamp completes after the lock is released");
		});

		const after = loadRunManifestById(cwd, manifest.runId)!.manifest as TeamRunManifest & { schedulerJobId?: string };
		assert.equal(after.status, "cancelled", "the stamp must NOT resurrect a terminal status to running");
		assert.equal(after.schedulerJobId, "job-7", "provenance still stamped on the terminal manifest");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("M3-7 structural: the raw atomicWriteJson manifest provenance write is gone", () => {
	const src = fs.readFileSync(LIFECYCLE_SRC, "utf-8");
	assert.equal(
		/atomicWriteJson\(\s*loaded\.manifest\.stateRoot\s*\+\s*"\/manifest\.json"/.test(src),
		false,
		"the provenance stamp must not raw-write manifest.json (bypasses run.lock + terminal-preserve)",
	);
	assert.ok(src.includes("saveRunManifest(next)"), "the stamp persists through the terminal-preserving saveRunManifest");
	assert.ok(src.includes("withRunLockBusyRetryAsync("), "the stamp's read+write are lock-held");
});
