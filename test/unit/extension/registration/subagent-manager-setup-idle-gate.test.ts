/**
 * Idle-gate unit tests (dup-close, 2026-10-14).
 *
 * Root cause these pin: a followUp wake-up queued via sendUserMessage CANNOT
 * be retracted — if the leader proactively joins the result mid-turn
 * (get_subagent_result wait=true), the already-queued message still drips in
 * at the next turn boundary (live-caught 6× 2026-10-13/14). The fix defers
 * the emit while the leader turn is active and re-runs the resultConsumed
 * check at the moment the message would actually queue (session idle).
 *
 * These tests drive the coalescer + runWhenLeaderIdle directly with a minimal
 * fake ctx — no child spawns, deterministic timing windows.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { leaderTurnActive, runWhenLeaderIdle } from "../../../../src/extension/registration/subagent-manager-setup.ts";

interface FakeCtx {
	cleanedUp?: boolean;
	currentCtx?: { cwd: string; isIdle: () => boolean };
}

test("leaderTurnActive: false when currentCtx missing, isIdle missing, or isIdle()=true", () => {
	assert.equal(leaderTurnActive({ cleanedUp: false } as never), false);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-idle-gate-"));
	assert.equal(leaderTurnActive({ cleanedUp: false, currentCtx: { cwd } } as never), false); // no isIdle fn
	assert.equal(leaderTurnActive({ cleanedUp: false, currentCtx: { cwd, isIdle: () => true } } as never), false);
	assert.equal(leaderTurnActive({ cleanedUp: false, currentCtx: { cwd, isIdle: () => false } } as never), true);
	assert.equal(
		leaderTurnActive({
			cleanedUp: false,
			currentCtx: {
				cwd,
				isIdle: () => {
					throw new Error("boom");
				},
			},
		} as never),
		false,
	);
});

test("runWhenLeaderIdle: runs immediately when idle (no deferral)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-idle-gate-"));
	const ctx: FakeCtx = { currentCtx: { cwd, isIdle: () => true } };
	let ran = 0;
	runWhenLeaderIdle(ctx as never, () => {
		ran++;
	});
	assert.equal(ran, 1, "idle session → fn runs synchronously");
});

test("runWhenLeaderIdle: runs immediately when host lacks isIdle (pre-gate bit-for-bit)", () => {
	const ctx: FakeCtx = {};
	let ran = 0;
	runWhenLeaderIdle(ctx as never, () => {
		ran++;
	});
	assert.equal(ran, 1, "capability fallback → fn runs synchronously");
});

test("runWhenLeaderIdle: defers while the leader turn is active, runs after idle", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-idle-gate-"));
	let idle = false;
	const ctx: FakeCtx = { currentCtx: { cwd, isIdle: () => idle } }; // isIdle()=false until flipped
	let ran = 0;
	runWhenLeaderIdle(ctx as never, () => {
		ran++;
	});
	assert.equal(ran, 0, "active turn → deferred");
	idle = true; // leader turn ends
	await new Promise((r) => setTimeout(r, 700)); // > IDLE_RETRY_MS (500)
	assert.equal(ran, 1, "idle flip → fn ran on the retry tick");
});

test("runWhenLeaderIdle: cleanedUp during the wait → never runs", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-idle-gate-"));
	const ctx: FakeCtx = { currentCtx: { cwd, isIdle: () => false } };
	let ran = 0;
	runWhenLeaderIdle(ctx as never, () => {
		ran++;
	});
	ctx.cleanedUp = true;
	await new Promise((r) => setTimeout(r, 700));
	assert.equal(ran, 0, "cleanup cancels the pending emit");
});
