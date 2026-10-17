/**
 * WI-2 (DR-02 R4-3, 2026-10-15): the goal loop must refresh the workspace-lock
 * heartbeat while it runs.
 *
 * Bug: the heartbeat was written ONCE at acquire and never refreshed, so
 * workspace-lock isLockStale clause (b) marked the lock stale after 60s
 * REGARDLESS of holder pid liveness — a goal running >60s got its workspace
 * lock force-stolen by a second goal on the same cwd (multi-goal clobber).
 *
 * The lock-level semantics (belongs-to check, format preservation,
 * no-clobber-after-reclaim, steal-vs-wait with/without refresh) are pinned in
 * test/unit/runtime/core/workspace-lock.test.ts. THIS file pins the loop wiring
 * via the exported startWorkspaceLockHeartbeatRefresh seam: real-interval
 * behavior, stop(), throw-safety, cadence contract, and a source-level pin
 * that runGoalLoop actually starts the refresh after acquire and stops it in
 * the release finally.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	startWorkspaceLockHeartbeatRefresh,
	WORKSPACE_LOCK_HEARTBEAT_REFRESH_MS,
} from "../../../../src/runtime/goal-workflow/goal-loop-runner.ts";
import {
	acquireWorkspaceLock,
	refreshWorkspaceLockHeartbeat,
	type StartTimeResolver,
	workspaceLockPath,
} from "../../../../src/runtime/workspace-lock.ts";
import { clearProjectRootCache } from "../../../../src/utils/paths.ts";

function makeTmpCwd(): string {
	clearProjectRootCache(); // findRepoRoot has a global cache — clear so each tmpdir resolves correctly.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wslock-hb-"));
	fs.mkdirSync(path.join(cwd, ".crew", "state", "workspace-locks"), { recursive: true });
	return cwd;
}

/** A mock startTime resolver that returns undefined for every pid (non-Linux shape). */
function undefinedStartTimeResolver(): StartTimeResolver {
	return () => undefined;
}

/** Read the lockfile's heartbeat (undefined when missing). */
function readHeartbeat(cwd: string): number | undefined {
	try {
		return (JSON.parse(fs.readFileSync(workspaceLockPath(cwd), "utf-8")) as { heartbeat: number }).heartbeat;
	} catch {
		return undefined;
	}
}

describe("startWorkspaceLockHeartbeatRefresh (goal-loop wiring seam, WI-2)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = makeTmpCwd();
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("default cadence is 15s (4x margin under the 60s staleness threshold)", () => {
		assert.equal(WORKSPACE_LOCK_HEARTBEAT_REFRESH_MS, 15_000);
	});

	it("periodically refreshes the heartbeat of the held lock, and stop() halts it", async () => {
		// Mock resolver returns undefined for every pid — models the non-Linux shape
		// (startTime undefined, clause (a) skipped). Acquire WITHOUT pid injection so the
		// lockfile records process.pid — exactly what the goal loop does in production,
		// so the refresher's default-pid ownership check matches.
		const resolver = undefinedStartTimeResolver();
		await acquireWorkspaceLock(cwd, "goal_a", { startTimeResolver: resolver, pollMs: 5 });
		const heartbeatAtStart = readHeartbeat(cwd);
		assert.ok(typeof heartbeatAtStart === "number");

		const refresher = startWorkspaceLockHeartbeatRefresh({ lockPath: workspaceLockPath(cwd), goalId: "goal_a" }, { refreshMs: 10 });
		try {
			// Wait long enough for several 10ms ticks: heartbeat must advance past acquire's stamp.
			await new Promise((r) => setTimeout(r, 60));
			const afterTicks = readHeartbeat(cwd);
			assert.ok(
				afterTicks !== undefined && afterTicks > heartbeatAtStart,
				`heartbeat must advance under the refresh interval (start=${heartbeatAtStart} after=${afterTicks})`,
			);
		} finally {
			refresher.stop();
		}

		// After stop(), the heartbeat must freeze (a stopped refresher must not resurrect a
		// reclaimed/stale lock — this is also the finally-block contract in runGoalLoop).
		const frozen = readHeartbeat(cwd);
		await new Promise((r) => setTimeout(r, 40));
		assert.equal(readHeartbeat(cwd), frozen, "heartbeat must not change after stop()");
	});

	it("a throwing refresh implementation never escapes into the loop (logged + swallowed)", async () => {
		// An escaping throw from a setInterval callback is an uncaught exception that kills
		// the node:test process — this test passing proves the try/catch contract.
		let thrown = 0;
		const refresher = startWorkspaceLockHeartbeatRefresh(
			{ lockPath: "/nonexistent/should-not-matter.lock", goalId: "goal_x" },
			{
				refreshMs: 5,
				refresh: () => {
					thrown++;
					throw new Error("boom: refresh exploded");
				},
			},
		);
		try {
			await new Promise((r) => setTimeout(r, 25));
			assert.ok(thrown >= 1, `refresh stub must have been invoked (invocations=${thrown})`);
		} finally {
			refresher.stop();
		}
	});

	it("runGoalLoop wiring pin: refresh starts right after acquire and stops in the release finally", async () => {
		const src = fs.readFileSync(path.join(import.meta.dirname, "../../../../src/runtime/goal-workflow/goal-loop-runner.ts"), "utf-8");
		// 1. The loop acquires the workspace lock...
		const acquireIdx = src.indexOf("await acquireWorkspaceLock(goal.cwd");
		assert.ok(acquireIdx > -1, "runGoalLoop must acquire the workspace lock");
		// 2. ...then starts the heartbeat refresh (WI-2) — after acquire, before the loop body...
		const startIdx = src.indexOf("startWorkspaceLockHeartbeatRefresh(workspaceLock");
		assert.ok(startIdx > -1, "runGoalLoop must start the workspace-lock heartbeat refresh");
		assert.ok(startIdx > acquireIdx, "refresh must start AFTER the lock is acquired");
		// 3. ...and stops it in the same finally that releases the lock (the LAST finally of the fn).
		const finallyIdx = src.lastIndexOf("} finally {");
		const stopIdx = src.indexOf("lockHeartbeat?.stop()", finallyIdx);
		const releaseIdx = src.indexOf("workspaceLock?.release()", finallyIdx);
		assert.ok(finallyIdx > startIdx, "release finally must come after refresh start");
		assert.ok(stopIdx > -1, "release finally must stop the heartbeat refresh");
		assert.ok(releaseIdx > -1, "release finally must release the workspace lock");
		assert.ok(stopIdx < releaseIdx, "refresh stops BEFORE the lock is released (no window where a released lock is refreshed)");
	});
});

// R3-M-B1 (Wave-3): refresh()===false (ownership lost — lock stolen/reclaimed)
// must STOP the heartbeat loop and surface via onOwnershipLost exactly once;
// the goal loop wires that to blocked + a goal.workspace_lock_lost event.
describe("startWorkspaceLockHeartbeatRefresh ownership-lost handling (R3-M-B1)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = makeTmpCwd();
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("refresh()===false → stops the loop and fires onOwnershipLost exactly once", async () => {
		let refreshCalls = 0;
		let ownershipLostCalls = 0;
		const hb = startWorkspaceLockHeartbeatRefresh(
			{ lockPath: workspaceLockPath(cwd), goalId: "goal_lost" },
			{
				refreshMs: 10,
				refresh: () => {
					refreshCalls += 1;
					return false; // ownership lost every tick
				},
				onOwnershipLost: () => {
					ownershipLostCalls += 1;
				},
			},
		);
		try {
			await new Promise((r) => setTimeout(r, 60));
			assert.equal(ownershipLostCalls, 1, "onOwnershipLost fired exactly once");
			assert.equal(refreshCalls, 1, "the loop stopped itself — no further refresh ticks");
		} finally {
			hb.stop();
		}
	});

	it("refresh()===true keeps the loop alive and never fires onOwnershipLost", async () => {
		let refreshCalls = 0;
		let ownershipLostCalls = 0;
		const hb = startWorkspaceLockHeartbeatRefresh(
			{ lockPath: workspaceLockPath(cwd), goalId: "goal_ok" },
			{
				refreshMs: 10,
				refresh: () => {
					refreshCalls += 1;
					return true;
				},
				onOwnershipLost: () => {
					ownershipLostCalls += 1;
				},
			},
		);
		try {
			await new Promise((r) => setTimeout(r, 60));
			assert.ok(refreshCalls > 1, "loop keeps ticking");
			assert.equal(ownershipLostCalls, 0);
		} finally {
			hb.stop();
		}
	});

	it("real refresh on a STOLEN lock reports false (foreign owner never clobbered)", async () => {
		const resolver = undefinedStartTimeResolver();
		const ours = await acquireWorkspaceLock(cwd, "goal_mine", { startTimeResolver: resolver, pollMs: 5 });
		assert.ok(ours);
		// A second goal steals the (stale-able) lock by rewriting the file foreign.
		const lockPath = workspaceLockPath(cwd);
		const foreignJson = JSON.stringify({
			goalId: "goal_stealer",
			pid: process.pid + 1,
			acquiredAt: new Date().toISOString(),
			heartbeat: Date.now(),
		});
		fs.writeFileSync(lockPath, foreignJson);
		const ok = refreshWorkspaceLockHeartbeat(lockPath, "goal_mine");
		assert.equal(ok, false, "refresh refuses a foreign-owned lock");
		assert.equal(fs.readFileSync(lockPath, "utf-8"), foreignJson, "foreign lockfile left untouched");
	});
});
