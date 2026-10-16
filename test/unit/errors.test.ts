import assert from "node:assert/strict";
import test from "node:test";
import { CrewError, ErrorCode, errors } from "../../src/errors.ts";

test("CrewError formats with error code", () => {
	const err = new CrewError(ErrorCode.TaskNotFound, "Task 'xyz' not found");
	assert.match(err.toString(), /^error\[E003\]: Task 'xyz' not found/);
});

test("CrewError formats with context", () => {
	const err = new CrewError(ErrorCode.FileReadError, "Failed to read manifest.json").withContext("while loading run state");
	const str = err.toString();
	assert.match(str, /error\[E001\]:/);
	assert.match(str, /context: while loading run state/);
});

test("CrewError formats with help", () => {
	const err = new CrewError(ErrorCode.ConfigError, "parse failure").withHelp("Try running `team init`");
	const str = err.toString();
	assert.match(str, /help: Try running `team init`/);
});

test("CrewError has default help for E001-E006", () => {
	assert.ok(errors.fileRead("x.txt", { code: "ENOENT" } as NodeJS.ErrnoException).help);
	assert.ok(errors.taskNotFound("t1").help);
	assert.ok(errors.config("bad").help);
});

test("CrewError is instanceof Error", () => {
	assert.ok(new CrewError(ErrorCode.FileWriteError, "x") instanceof Error);
});

test("withHelp overrides default help", () => {
	const err = errors.fileRead("x", { code: "ENOENT" } as NodeJS.ErrnoException).withHelp("custom help override");
	assert.equal(err.help, "custom help override");
});

test("CrewError factory methods produce correct codes", () => {
	assert.equal(errors.fileRead("x", {} as NodeJS.ErrnoException).code, ErrorCode.FileReadError);
	assert.equal(errors.taskNotFound("t1").code, ErrorCode.TaskNotFound);
	assert.equal(errors.invalidStatusTransition("running", "queued").code, ErrorCode.InvalidStatusTransition);
	assert.equal(errors.resourceNotFound("agent", "my-agent").code, ErrorCode.ResourceNotFound);
});
// E1 (Round 15): new runtime error constructors E007–E012.

test("ErrorCode exposes E007–E012 runtime categories", () => {
	assert.equal(ErrorCode.ChildTimeout, "E007");
	assert.equal(ErrorCode.ModelExhausted, "E008");
	assert.equal(ErrorCode.PreStepFailed, "E009");
	assert.equal(ErrorCode.EventLogLockTimeout, "E010");
	assert.equal(ErrorCode.DepthLimitExceeded, "E011");
	assert.equal(ErrorCode.RunStale, "E012");
});

test("errors.childTimeout builds E007 with stderr tail and context", () => {
	const err = errors.childTimeout({ taskId: "t1", stderr: "x".repeat(800) });
	assert.equal(err.code, ErrorCode.ChildTimeout);
	assert.match(err.message, /unresponsive/);
	assert.ok(err.message.length < err.message.replace(/x{800}/, "").length + 500, "stderr truncated to ~400 chars");
	assert.match(err.toString(), /error\[E007\]:/);
	assert.match(err.toString(), /task t1/);
	assert.ok(err.help, "has a default help hint");
	assert.match(err.help!, /response timeout/i);
});

test("errors.modelExhausted builds E008 with the full chain tried", () => {
	const err = errors.modelExhausted(["claude-a", "claude-b", "sonnet"], "rate_limit_error");
	assert.equal(err.code, ErrorCode.ModelExhausted);
	assert.match(err.message, /3 model candidates exhausted/);
	assert.match(err.message, /claude-a → claude-b → sonnet/);
	assert.match(err.message, /Last failure: rate_limit_error/);
	assert.match(err.toString(), /context: model fallback chain/);
});

// J4 (DR-03 round-6): the loop can break EARLY (non-retryable failure,
// classifier veto, spawn-budget stop) while queued fallbacks remain — "All N
// exhausted" overstated that case. Both shapes must be distinguishable.
test("errors.modelExhausted distinguishes early break from genuine exhaustion (J4)", () => {
	const early = errors.modelExhausted(["claude-a", "claude-b"], "api key missing", 3);
	assert.equal(early.code, ErrorCode.ModelExhausted);
	assert.match(early.message, /Model chain failed early/);
	assert.match(early.message, /claude-a → claude-b/);
	assert.match(early.message, /2 of 3/);
	assert.match(early.message, /1 queued fallback not tried/);
	assert.match(early.message, /Last failure: api key missing/);
	assert.doesNotMatch(early.message, /exhausted/);
	assert.match(early.toString(), /context: model fallback chain/);

	// plannedChainLength equal to the tried chain = genuine exhaustion — keep
	// the all-exhausted wording.
	const exhausted = errors.modelExhausted(["claude-a", "claude-b", "sonnet"], "rate_limit_error", 3);
	assert.equal(exhausted.code, ErrorCode.ModelExhausted);
	assert.match(exhausted.message, /All 3 model candidates exhausted/);
	assert.match(exhausted.message, /claude-a → claude-b → sonnet/);
	assert.doesNotMatch(exhausted.message, /failed early/);
});

test("errors.preStepFailed builds E009 with script + exit code + stderr", () => {
	const err = errors.preStepFailed("./hooks/build.sh", 2, "syntax error near fi");
	assert.equal(err.code, ErrorCode.PreStepFailed);
	assert.match(err.message, /build\.sh/);
	assert.match(err.message, /exited 2/);
	assert.match(err.message, /syntax error near fi/);
	assert.match(err.toString(), /pre-step hook execution/);
});

test("errors.eventLogLockTimeout builds E010 with path + timeout", () => {
	const err = errors.eventLogLockTimeout("/tmp/run/events.jsonl", 5000);
	assert.equal(err.code, ErrorCode.EventLogLockTimeout);
	assert.match(err.message, /events\.jsonl/);
	assert.match(err.message, /5000ms/);
	assert.match(err.help!, /orphaned/i);
});

test("errors.depthLimitExceeded builds E011 for pipeline + chain kinds", () => {
	const pipe = errors.depthLimitExceeded(50, "pipeline");
	const chain = errors.depthLimitExceeded(50, "chain");
	assert.equal(pipe.code, ErrorCode.DepthLimitExceeded);
	assert.match(pipe.message, /Pipeline recursion/);
	assert.match(chain.message, /Chain recursion/);
	assert.match(pipe.help!, /circular/i);
});

test("errors.runStale builds E012 with reason + optional heartbeat age", () => {
	const noAge = errors.runStale("pid_dead");
	const withAge = errors.runStale("pid_dead", 312);
	assert.equal(noAge.code, ErrorCode.RunStale);
	assert.equal(withAge.code, ErrorCode.RunStale);
	assert.ok(!noAge.message.includes("Last heartbeat"));
	assert.match(withAge.message, /Last heartbeat was 312s ago/);
	assert.match(withAge.help!, /heartbeat/i);
});

test("all new codes have a default help hint in DEFAULT_HELP", () => {
	for (const code of [
		ErrorCode.ChildTimeout,
		ErrorCode.ModelExhausted,
		ErrorCode.PreStepFailed,
		ErrorCode.EventLogLockTimeout,
		ErrorCode.DepthLimitExceeded,
		ErrorCode.RunStale,
	]) {
		const err = new CrewError(code, "x");
		assert.ok(err.help, `code ${code} should have a default help hint`);
		assert.ok(err.help!.length > 20, `code ${code} help hint should be meaningful`);
	}
});
