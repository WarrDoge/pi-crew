/**
 * Regression tests for battery bug #4 (2026-10-10 full battery, run
 * team_20261010172900): steer_subagent accepted a steer ~5s after manifest
 * creation and appended it to artifacts/steering/<taskId>.jsonl at
 * 17:29:05.088, returning "Steer delivered". The child-executor's attempt
 * loop had NOT started yet — taskDispatchStartedAtMs is captured when the
 * executor begins (later than the steer, e.g. 17:29:05.500) — so the F7 race
 * guard compared the file mtime against a LATER baseline, failed, and the
 * on-spawn truncate (17:29:05.753) wiped the line → "Steer delivered" +
 * 0-byte file, STEER marker nowhere on disk.
 *
 * Fix under test: steerRaceBaselineMs() — the skip-truncate baseline is the
 * RUN'S creation time (manifest.createdAt, the earliest instant
 * steer_subagent could have accepted a steer), not the executor-local
 * dispatch timestamp. The fresh per-run artifacts root cannot hold pre-run
 * residue, so the baseline only moves EARLIER: post-dispatch race protection
 * (the original F7 case) is unchanged.
 *
 * Red-first: [steer-race-1] replays the EXACT live timeline and fails on the
 * pre-fix formula (dispatch-start baseline → guard false → wipe). The mock
 * child (PI_TEAMS_MOCK_CHILD_PI) returns before the real spawn path, so the
 * onSpawn truncate is unreachable in mock mode — hence the pure-helper tests
 * + the structural wiring pin below (same technique as the heartbeat-pulse
 * suite's [pulse-4] structural pins).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { steerRaceBaselineMs } from "../../../../src/runtime/task-runner/child-executor.ts";

const SOURCE_PATH = new URL("../../../../src/runtime/task-runner/child-executor.ts", import.meta.url);

/** The live bug #4 timeline (UTC ms, run team_20261010172900, 2026-10-10). */
const T = {
	manifestCreatedAt: Date.parse("2026-10-10T17:29:00.100Z"),
	steerAppendedAt: Date.parse("2026-10-10T17:29:05.088Z"),
	executorDispatchStartedAt: Date.parse("2026-10-10T17:29:05.500Z"),
	onSpawnTruncateAt: Date.parse("2026-10-10T17:29:05.753Z"),
};

function skipTruncate(steerFileMtimeMs: number, baselineMs: number): boolean {
	// The exact comparison from the onSpawn truncate block.
	return steerFileMtimeMs >= baselineMs - 1;
}

test("[steer-race-1] live bug #4 timeline: steer between manifest creation and executor start survives the truncate", () => {
	const baseline = steerRaceBaselineMs({ createdAt: new Date(T.manifestCreatedAt).toISOString() }, T.executorDispatchStartedAt);
	// NEW: baseline = manifest creation → steer mtime (.088) ≥ baseline → skip.
	assert.ok(
		skipTruncate(T.steerAppendedAt, baseline),
		"steer accepted before executor start must survive the on-spawn truncate (battery bug #4 shape: \"Steer delivered\" + 0-byte file)",
	);
	// OLD (pre-fix) formula for contrast — this is what wiped the live steer:
	assert.ok(
		!skipTruncate(T.steerAppendedAt, T.executorDispatchStartedAt),
		"sanity: the old dispatch-start baseline really did fail this guard (red-first proof)",
	);
});

test("[steer-race-2] original F7 case still protected: steer racing dispatch → spawn survives", () => {
	const baseline = steerRaceBaselineMs({ createdAt: new Date(T.manifestCreatedAt).toISOString() }, T.executorDispatchStartedAt);
	// Steer landed after dispatch started, before onSpawn (the 2026-08-18 case:
	// steer 15:59:11, truncate 15:59:59). Old guard: keep. New guard: also keep.
	const midFlightSteer = Date.parse("2026-10-10T17:29:05.600Z"); // after executor start, before truncate
	assert.ok(skipTruncate(midFlightSteer, baseline), "post-dispatch racing steer must still be preserved");
});

test("[steer-race-3] backdated residue (pre-run mtime) is still wiped", () => {
	const baseline = steerRaceBaselineMs({ createdAt: new Date(T.manifestCreatedAt).toISOString() }, T.executorDispatchStartedAt);
	const residue = Date.parse("2026-10-10T17:28:00.000Z"); // before the run existed
	assert.ok(!skipTruncate(residue, baseline), "pre-run residue must still be truncated");
});

test("[steer-race-4] boundary: mtime == manifest.createdAt counts as a live steer (−1ms buffer)", () => {
	const baseline = steerRaceBaselineMs({ createdAt: new Date(T.manifestCreatedAt).toISOString() }, T.executorDispatchStartedAt);
	assert.ok(skipTruncate(T.manifestCreatedAt, baseline), "equal-ms boundary must skip (same-clock-ms steer append)");
});

test("[steer-race-5] legacy manifest with unparsable createdAt falls back to dispatch-start baseline", () => {
	const baseline = steerRaceBaselineMs({ createdAt: "not-a-date" }, T.executorDispatchStartedAt);
	assert.equal(baseline, T.executorDispatchStartedAt);
	// And that fallback still protects the post-dispatch race window:
	assert.ok(skipTruncate(T.onSpawnTruncateAt - 10, baseline));
	assert.ok(!skipTruncate(T.steerAppendedAt, baseline));
});

test("[steer-race-6] structural pin: the onSpawn truncate block is wired to steerRaceBaselineMs", () => {
	const src = fs.readFileSync(SOURCE_PATH, "utf-8");
	const pin = "const racedSteerBaseMs = steerRaceBaselineMs(manifest, taskDispatchStartedAtMs);";
	assert.ok(src.includes(pin), `child-executor onSpawn must derive the race baseline via steerRaceBaselineMs (missing: ${pin})`);
	assert.ok(
		src.includes("racedSteerArrived = fs.statSync(safeSteeringPath).mtimeMs >= racedSteerBaseMs - 1"),
		"the guard comparison must use racedSteerBaseMs",
	);
});
