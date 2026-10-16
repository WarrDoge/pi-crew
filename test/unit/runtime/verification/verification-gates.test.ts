import assert from "node:assert/strict";
import test from "node:test";
import {
	CARGO_RUST_GATES,
	computeGreenLevelFromResults,
	executeCommand,
	executeVerificationCommands,
	NPM_TYPESCRIPT_GATES,
	runPhaseGates,
} from "../../../../src/runtime/verification/verification-gates.ts";
import type { VerificationCommandResult } from "../../../../src/state/types.ts";

test("verification-gates: NPM_TYPESCRIPT_GATES has expected phases", () => {
	assert.equal(NPM_TYPESCRIPT_GATES.length, 4);
	assert.ok(NPM_TYPESCRIPT_GATES.every((g) => g.name && g.command));
});

test("verification-gates: CARGO_RUST_GATES has expected phases", () => {
	assert.equal(CARGO_RUST_GATES.length, 3);
	assert.ok(CARGO_RUST_GATES.every((g) => g.name && g.command));
});

test("verification-gates: runPhaseGates executes commands sequentially", async () => {
	const gates = [
		{ name: "echo", command: "echo 'hello'", critical: true },
		{ name: "echo2", command: "echo 'world'", critical: true },
	];
	const result = await runPhaseGates(gates, process.cwd());
	assert.equal(result.results.length, 2);
	assert.equal(result.results[0].status, "passed");
	assert.equal(result.results[1].status, "passed");
	assert.ok(result.allPassed);
});

test("verification-gates: runPhaseGates stops on critical failure", async () => {
	const gates = [
		{ name: "success", command: "true", critical: true },
		{ name: "fails", command: "false", critical: true },
		{
			name: "would-run",
			command: "echo 'should not run'",
			critical: true,
		},
	];
	const result = await runPhaseGates(gates, process.cwd());
	// Results contain only executed gates (not skipped)
	assert.equal(result.results.length, 2);
	assert.equal(result.results[0].status, "passed");
	assert.equal(result.results[1].status, "failed");
	assert.ok(!result.allPassed);
	assert.equal(result.stoppedAt, 2);
});

test("verification-gates: runPhaseGates continues on non-critical failure", async () => {
	const gates = [
		{ name: "success", command: "true", critical: true },
		{ name: "fails", command: "false", critical: false },
		{
			name: "continues",
			command: "echo 'still going'",
			critical: true,
		},
	];
	const result = await runPhaseGates(gates, process.cwd());
	assert.equal(result.results.length, 3);
	assert.equal(result.results[0].status, "passed");
	assert.equal(result.results[1].status, "failed");
	assert.equal(result.results[2].status, "passed");
});

test("verification-gates: computeGreenLevelFromResults all passed", () => {
	const results: VerificationCommandResult[] = [
		{ cmd: "npm test", status: "passed", exitCode: 0 },
		{ cmd: "npm run build", status: "passed", exitCode: 0 },
	];
	const level = computeGreenLevelFromResults(results, "targeted");
	assert.equal(level, "targeted");
});

test("verification-gates: computeGreenLevelFromResults all failed", () => {
	const results: VerificationCommandResult[] = [{ cmd: "npm test", status: "failed", exitCode: 1 }];
	const level = computeGreenLevelFromResults(results, "targeted");
	assert.equal(level, "none");
});

test("verification-gates: computeGreenLevelFromResults partial pass", () => {
	const results: VerificationCommandResult[] = [
		{ cmd: "npm test", status: "passed", exitCode: 0 },
		{ cmd: "npm run build", status: "not_run" },
	];
	const level = computeGreenLevelFromResults(results, "targeted");
	assert.equal(level, "targeted");
});

test("verification-gates: computeGreenLevelFromResults empty commands", () => {
	const results: VerificationCommandResult[] = [];
	const level = computeGreenLevelFromResults(results, "targeted");
	assert.equal(level, "none");
});

test("verification-gates: executeVerificationCommands with empty contract", async () => {
	const results = await executeVerificationCommands(
		{
			requiredGreenLevel: "targeted",
			commands: [],
			allowManualEvidence: true,
		},
		process.cwd(),
		"test-run",
		"test-task",
		"/tmp",
	);
	assert.deepEqual(results, []);
});

// ── P-4 (DR-04 round-7): capped accumulation while streaming ────────────────
// The final result was always sliced to 100k, but the live buffer concatenated
// EVERY chunk until close/timeout — a multi-MB/GB-emitting gate held it all in
// memory. Past ~200KB the appender must stop and pin "[truncated]".

test("verification-gates: executeCommand bounds the accumulation buffer past the cap", { timeout: 60_000 }, async () => {
	// 300KB of output (> 200KB cap) from an allowlisted command (head).
	const res = await executeCommand("head -c 300000 /dev/zero", process.cwd(), 30000);
	assert.equal(res.exitCode, 0);
	// Final slice(-100000) still bounds the result…
	assert.ok(res.output.length <= 100000, `result must stay ≤100000 chars, got ${res.output.length}`);
	// …and the streaming buffer stopped at the cap with a visible marker.
	assert.ok(res.output.includes("[truncated]"), "capped stream must carry the [truncated] marker");
	assert.ok(res.durationMs >= 0);
});

test("verification-gates: executeCommand output under the cap is untruncated", { timeout: 30_000 }, async () => {
	const res = await executeCommand("echo small-output", process.cwd(), 30000);
	assert.equal(res.exitCode, 0);
	assert.ok(res.output.includes("small-output"));
	assert.ok(!res.output.includes("[truncated]"), "small output must not be marked truncated");
});
