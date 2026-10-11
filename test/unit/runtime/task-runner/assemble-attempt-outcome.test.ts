import assert from "node:assert/strict";
import test from "node:test";
import type { ChildPiRunResult } from "../../../../src/runtime/child-pi/child-pi.ts";
import { attemptErrorFor, evidenceStatusFor } from "../../../../src/runtime/task-runner/child-executor.ts";

// Quick Win 11 (Pattern 11 — error-as-data contract): pin the per-attempt
// outcome assembly precedence so the fallback ORDER cannot silently change.
// These pure functions were extracted from runChildProcessTask for direct
// testability; E008 (modelExhausted) stays in the caller (post-loop).

function mkResult(over: Partial<ChildPiRunResult>): ChildPiRunResult {
	return {
		exitCode: 0,
		exitStatus: undefined,
		stdout: "",
		stderr: "",
		rawFinalText: undefined,
		intermediateFindings: undefined,
		...over,
	} as ChildPiRunResult;
}

test("QW11 evidenceStatus: cancelled > failed > completed precedence", () => {
	// cancelled wins even with an error + non-zero exit
	assert.equal(evidenceStatusFor(mkResult({ exitStatus: { cancelled: true } as any, error: "boom", exitCode: 2 })), "cancelled");
	// failed when error set (exit 0)
	assert.equal(evidenceStatusFor(mkResult({ error: "boom", exitCode: 0 })), "failed");
	// failed when non-zero exit (no error)
	assert.equal(evidenceStatusFor(mkResult({ exitCode: 2 })), "failed");
	// completed: clean
	assert.equal(evidenceStatusFor(mkResult({ exitCode: 0 })), "completed");
});

// FIX-ROUND MAJOR 1 (review 0.11.17): child-pi-rpc.ts buildExitStatus now sets
// `cancelled: abortRequested || hostAbortedSettle`, so a HOST-aborted settle
// (agent_settled.aborted, pi 1.1.0+) reaches the task runner as a clean-shaped
// result — exit 0, no error — whose ONLY cancel signal is
// exitStatus.cancelled. Pre-fix that field stayed false and the run was
// classified "completed": the worker.cancelled evidence branch in
// child-executor.ts (the `evidenceStatus === "cancelled"` path that appends the
// worker.cancelled event) never fired for host aborts.
test("MAJOR 1 regression: host-aborted shape (exit 0, no error, exitStatus.cancelled) classifies as cancelled", () => {
	const hostAborted = mkResult({
		exitCode: 0, // warm-path/normal close exits 0 even when host-aborted
		exitStatus: { cancelled: true } as any, // as produced by buildExitStatus after the fix
	});
	assert.equal(evidenceStatusFor(hostAborted), "cancelled", "host-aborted settle must drive the worker.cancelled branch");
	// Counterfactual pinning the pre-fix symptom: identical result WITHOUT the
	// cancelled flag is a genuine clean finish.
	const clean = mkResult({ exitCode: 0, exitStatus: { cancelled: false } as any });
	assert.equal(evidenceStatusFor(clean), "completed");
});

test("QW11 attemptErrorFor: childResult.error is the base error", () => {
	const err = attemptErrorFor(mkResult({ error: "hard fail", exitCode: 0 }), undefined, "t1");
	assert.equal(err, "hard fail");
});

test("QW11 attemptErrorFor: non-zero exit (no error) → stderr-or-exit message", () => {
	assert.equal(attemptErrorFor(mkResult({ exitCode: 3, stderr: "oops" }), undefined, "t1"), "oops");
	assert.match(attemptErrorFor(mkResult({ exitCode: 3, stderr: "" }), undefined, "t1") ?? "", /Child Pi exited with 3/);
});

test("QW11 attemptErrorFor: E007 timedOut OVERRIDES the hard error (unconditional)", () => {
	// timedOut wins over a set childResult.error + non-zero exit.
	const err = attemptErrorFor(mkResult({ error: "hard fail", exitCode: 2, exitStatus: { timedOut: true } as any }), undefined, "t1");
	assert.ok(err, "timedOut must surface an error");
	// E007 childTimeout carries a CrewError code/message — not the raw 'hard fail'.
	assert.notEqual(err, "hard fail");
});

test("QW11 attemptErrorFor: 429-detection is GATED on !error (no override of a set error)", () => {
	// A parsedOutput is passed, but an error is already set → the 429 branch
	// (!err) must NOT fire; the existing error is returned unchanged. (The 429
	// detector itself is pinned in rate-limit-429-detection.test.ts.)
	const parsed = { textEvents: [], errorMessages: ["429 too many requests"] } as any;
	const err = attemptErrorFor(mkResult({ error: "hard fail", exitCode: 0 }), parsed, "t1");
	assert.equal(err, "hard fail", "a pre-set error must suppress 429 detection");
});

test("QW11 attemptErrorFor: no error + benign parsedOutput → undefined", () => {
	const parsed = { textEvents: ["real output"], finalText: "done", errorMessages: [] } as any;
	const err = attemptErrorFor(mkResult({ exitCode: 0 }), parsed, "t1");
	assert.equal(err, undefined, "clean run with real output has no error");
});
