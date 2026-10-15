/**
 * E1 (DR-02 Wave 2, Cluster F) — the repairGroupTerminalWrite catch inside the
 * coalesced heartbeat tick previously swallowed the error with only a comment:
 * when the repair save fails, terminal status stays STALE on disk with zero
 * trace. The fix adds a logInternalError(..., "warn") with runId/taskIds
 * context while KEEPING the no-rethrow policy (the catch lives inside a
 * setInterval callback — it must never throw into the timer).
 *
 * WHY STRUCTURAL: the heartbeat is a 15s setInterval internal to
 * runCoalescedTaskGroup with no injection seam (documented in
 * run-coalesced-heartbeat-race.test.ts — driving it requires a real hung
 * worker and >15s wall-clock). This file follows the NEW-3 structural
 * pattern from run-coalesced-heartbeat-pid.test.ts: pin the wiring by
 * source-shape assertions when behavioral driving is not deterministic.
 * The warn-emission behavior of logInternalError itself is covered by
 * test/unit/utils/internal-error.test.ts (severity tiers).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

const SRC_PATH = "src/runtime/scheduling/run-coalesced-task-group.ts";

test("E1 structural: the repair-terminal-write catch logs a warn with runId/taskIds context", () => {
	const src = fs.readFileSync(SRC_PATH, "utf-8");

	const callIdx = src.indexOf("await repairGroupTerminalWrite(manifest, taskIds, updatedTasks)");
	assert.ok(callIdx >= 0, "the heartbeat repair call must exist (source drifted?)");
	// Window from the repair call through the following catch block.
	const region = src.slice(callIdx, callIdx + 900);

	// The catch must bind the error (a bare `catch {}` cannot log it).
	assert.ok(region.includes("catch (error) {"), "repair catch must bind the error object");

	// The warn log must carry the coalesced scope, the bound error, the
	// run/task context, and the warn severity. (DOLLAR avoids a literal `${`
	// inside these strings — biome's noTemplateCurlyInString footgun warning.)
	const DOLLAR = "$";
	assert.ok(region.includes('"run-coalesced.repair-terminal-write"'), "must log scope run-coalesced.repair-terminal-write");
	assert.ok(region.includes("logInternalError("), "must call logInternalError inside the catch");
	assert.ok(region.includes(`runId=${DOLLAR}{manifest.runId}`), "must include runId in the log context");
	assert.ok(region.includes(`taskIds=${DOLLAR}{taskIds.join(",")}`), "must include the group taskIds in the log context");
	assert.ok(region.includes('"warn"'), "must log at warn severity (always emits, unlike default debug)");

	// The catch must stay non-throwing — after stripping comments, the catch
	// body must contain no `throw` statement (the log call is the only one).
	const catchIdx = region.indexOf("catch (error) {");
	const catchBody = (region.slice(catchIdx).split("}")[0] ?? "").replace(/\/\/[^\n]*/g, "");
	assert.ok(!/\bthrow\b/.test(catchBody), "repair catch must NOT rethrow (timer callback)");
});

test("E1 structural: WI-1 settledWithoutAnswer gate remains intact next to the E1 edit", () => {
	// Guard against editing around the DR-02 WI-1 gate (same file, committed
	// earlier in this wave series) — the gate call must still be present.
	const src = fs.readFileSync(SRC_PATH, "utf-8");
	assert.ok(
		src.includes("settledWithoutAnswer") || src.includes("throwIfSettledWithoutAnswer"),
		"the WI-1 empty-settle gate must still be present in this file",
	);
});
