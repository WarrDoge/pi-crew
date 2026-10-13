/**
 * U9-ADJ (upgrade 2026-10-13 §U9): no-progress gate for the generic retry
 * loop + additive `owner`/`intent` attribution fields on TaskAttemptState.
 *
 * Contract under test (retry-executor.ts):
 * - `noProgress` is consulted ONLY when a retry would be queued (attempt
 *   failed + retryable + below maxAttempts + shouldRetry approved), BEFORE
 *   onAttemptFailed/backoff. Returning true stops the loop with
 *   RetryNoProgressError (reason "no_progress") — the next attempt never
 *   spawns; onRetryGivenUp still fires (terminal parity with cancellation).
 * - `lastResult`/`previousResult` carry the thrown Errors of the just-failed
 *   and the previous failed attempt (undefined on the first failure).
 * - SOFT: a throwing/rejecting hook is logged (console.error) and treated as
 *   false — a broken detector never changes retry behavior.
 * - Unregistered hook ⇒ pre-U9-ADJ behaviour bit-for-bit (attempts + give-up
 *   reason identical).
 *
 * State side: TaskAttemptState.owner/intent are optional additive fields —
 * legacy tasks.json without them loads untouched; state carrying them
 * round-trips through the real store (saveRunTasks → disk → recovery loader).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { RetryHooks } from "../../../../src/runtime/recovery/retry-executor.ts";
import { executeWithRetry, RetryNoProgressError } from "../../../../src/runtime/recovery/retry-executor.ts";
import { loadTasksWithRecovery } from "../../../../src/state/stores/manifest-io.ts";
import { createRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TaskAttemptState, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const fastPolicy = { maxAttempts: 3, backoffMs: 1, jitterRatio: 0, exponentialFactor: 1 };

interface NoProgressContextSnapshot {
	attempt: number;
	lastResult: unknown;
	previousResult: unknown;
	durationMsLast: number;
}

function snapshot(context: NoProgressContextSnapshot): NoProgressContextSnapshot {
	return { ...context };
}

function errorMessage(result: unknown): string {
	return result instanceof Error ? result.message : String(result);
}

test("noProgress=true after attempt 2 stops the loop with reason no_progress — attempt 3 never runs", async () => {
	let attempts = 0;
	const contexts: NoProgressContextSnapshot[] = [];
	const givenUp: number[] = [];
	const hooks: RetryHooks = {
		onRetryGivenUp: (attempt) => {
			givenUp.push(attempt);
		},
		noProgress: async (context) => {
			contexts.push(snapshot(context));
			// Stuck loop: identical failure twice in a row ⇒ no progress.
			return context.attempt >= 2 && errorMessage(context.lastResult) === errorMessage(context.previousResult);
		},
	};
	await assert.rejects(
		() =>
			executeWithRetry(
				async () => {
					attempts += 1;
					throw new Error("stuck");
				},
				fastPolicy,
				hooks,
			),
		(error: unknown) =>
			error instanceof RetryNoProgressError &&
			error.reason === "no_progress" &&
			error.attempt === 2 &&
			error.attemptId === "retry_attempt_2" &&
			error.cause instanceof Error &&
			error.cause.message === "stuck" &&
			/no progress/.test(error.message),
	);
	assert.equal(attempts, 2, "loop must stop BEFORE spawning attempt 3");
	assert.deepEqual(givenUp, [2], "onRetryGivenUp fires once on the no-progress stop");
	assert.equal(contexts.length, 2, "gate consulted once per queued retry (after attempts 1 and 2)");
});

test("noProgress=false keeps retrying exactly like before — maxAttempts still exhausts", async () => {
	let attempts = 0;
	let gateCalls = 0;
	const givenUp: { attempt: number; message: string }[] = [];
	await assert.rejects(
		() =>
			executeWithRetry(
				async () => {
					attempts += 1;
					throw new Error(`boom-${attempts}`);
				},
				fastPolicy,
				{
					onRetryGivenUp: (attempt, error) => {
						givenUp.push({ attempt, message: error.message });
					},
					noProgress: () => {
						gateCalls += 1;
						return false;
					},
				},
			),
		(error: unknown) => error instanceof Error && error.message === "boom-3" && !(error instanceof RetryNoProgressError),
	);
	assert.equal(attempts, 3);
	// Gate only runs when a retry would be queued: after attempts 1 and 2 —
	// the attempt-3 failure exits via exhaustion without consulting it.
	assert.equal(gateCalls, 2);
	assert.deepEqual(givenUp, [{ attempt: 3, message: "boom-3" }]);
});

test("noProgress hook throwing is soft — logged via console.error, treated as false, loop unbroken", async () => {
	let attempts = 0;
	const consoleErrors: string[] = [];
	const originalConsoleError = console.error;
	console.error = (...args: unknown[]) => {
		consoleErrors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
	};
	try {
		await assert.rejects(
			() =>
				executeWithRetry(
					async () => {
						attempts += 1;
						throw new Error(`boom-${attempts}`);
					},
					fastPolicy,
					{
						noProgress: () => {
							throw new Error("detector exploded");
						},
					},
				),
			(error: unknown) => error instanceof Error && error.message === "boom-3",
		);
	} finally {
		console.error = originalConsoleError;
	}
	assert.equal(attempts, 3, "soft hook failure must not change the retry count");
	assert.equal(consoleErrors.length, 2, "one soft-fail log per gate call (after attempts 1 and 2)");
	assert.ok(
		consoleErrors.every((line) => line.includes("retry-executor.noProgress") && line.includes("detector exploded")),
		`soft-fail logs carry scope + hook error: ${JSON.stringify(consoleErrors)}`,
	);
});

test("unregistered noProgress hook — pre-U9-ADJ behaviour bit-for-bit", async () => {
	let attempts = 0;
	const givenUp: { attempt: number; message: string }[] = [];
	const failures: number[] = [];
	await assert.rejects(
		() =>
			executeWithRetry(
				async () => {
					attempts += 1;
					throw new Error(`boom-${attempts}`);
				},
				fastPolicy,
				{
					onAttemptFailed: (attempt) => {
						failures.push(attempt);
					},
					onRetryGivenUp: (attempt, error) => {
						givenUp.push({ attempt, message: error.message });
					},
				},
			),
		(error: unknown) => error instanceof Error && error.message === "boom-3" && !(error instanceof RetryNoProgressError),
	);
	assert.equal(attempts, 3);
	assert.deepEqual(failures, [1, 2]);
	assert.deepEqual(givenUp, [{ attempt: 3, message: "boom-3" }]);
});

test("previousResult/lastResult are fed correctly across attempts", async () => {
	const contexts: NoProgressContextSnapshot[] = [];
	let attempt = 0;
	await assert.rejects(
		() =>
			executeWithRetry(
				async () => {
					attempt += 1;
					throw new Error(`boom-${attempt}`); // distinct message per attempt
				},
				fastPolicy,
				{
					noProgress: (context) => {
						contexts.push(snapshot(context));
						return false;
					},
				},
			),
		(error: unknown) => error instanceof Error && error.message === "boom-3",
	);
	assert.equal(contexts.length, 2);

	// After attempt 1: previousResult is undefined — nothing to compare yet.
	assert.equal(contexts[0].attempt, 1);
	assert.ok(contexts[0].lastResult instanceof Error, "lastResult is the thrown Error of attempt 1");
	assert.equal(errorMessage(contexts[0].lastResult), "boom-1");
	assert.equal(contexts[0].previousResult, undefined, "no previous attempt on the first failure");
	assert.equal(typeof contexts[0].durationMsLast, "number");
	assert.ok(contexts[0].durationMsLast >= 0);

	// After attempt 2: lastResult = attempt-2 error, previousResult = attempt-1 error.
	assert.equal(contexts[1].attempt, 2);
	assert.ok(contexts[1].lastResult instanceof Error);
	assert.equal(errorMessage(contexts[1].lastResult), "boom-2");
	assert.ok(
		contexts[1].previousResult instanceof Error,
		"previousResult is the attempt-1 error, not the same object as lastResult",
	);
	assert.equal(errorMessage(contexts[1].previousResult), "boom-1");
	assert.notEqual(contexts[1].lastResult, contexts[1].previousResult);
	assert.equal(typeof contexts[1].durationMsLast, "number");
	assert.ok(contexts[1].durationMsLast >= 0);
});

const team: TeamConfig = {
	name: "u9adj",
	description: "U9-ADJ attempt-attribution round-trip",
	source: "builtin",
	filePath: "u9adj.team.md",
	roles: [{ name: "worker", agent: "worker" }],
};
const workflow: WorkflowConfig = {
	name: "u9adj",
	description: "U9-ADJ attempt-attribution round-trip",
	source: "builtin",
	filePath: "u9adj.workflow.md",
	steps: [{ id: "work", role: "worker", task: "Work" }],
};

function makeTempProject(): { cwd: string; cleanup(): void } {
	const cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-crew-u9adj-"));
	fs.mkdirSync(path.join(cwd, ".git")); // project marker → state stays under <tmp>/.crew/
	fs.mkdirSync(path.join(cwd, ".crew"));
	return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

test("TaskAttemptState owner/intent: legacy state without fields loads; state with fields round-trips through the real store", () => {
	const { cwd, cleanup } = makeTempProject();
	try {
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "U9-ADJ round-trip" });
		assert.ok(tasks.length >= 1);

		const legacyAttempt: TaskAttemptState = {
			attemptId: "retry_attempt_1",
			startedAt: "2026-10-13T00:00:00.000Z",
		};
		const attributedAttempt: TaskAttemptState = {
			attemptId: "retry_attempt_2",
			startedAt: "2026-10-13T00:00:01.000Z",
			endedAt: "2026-10-13T00:00:02.000Z",
			error: "boom",
			owner: "session-u9adj",
			intent: "auto-retry",
		};
		const updated: TeamTaskState[] = tasks.map((task, index) =>
			index === 0 ? { ...task, attempts: [legacyAttempt, attributedAttempt] } : task,
		);
		saveRunTasks(manifest, updated);

		const loaded = loadTasksWithRecovery(manifest.tasksPath, manifest.eventsPath, manifest.runId);
		assert.equal(loaded.length, updated.length);
		const loadedAttempts = loaded[0]?.attempts;
		assert.ok(loadedAttempts, "attempts array must survive the save/load round-trip");
		assert.deepEqual(loadedAttempts[0], legacyAttempt, "legacy attempt (no owner/intent) loads untouched");
		assert.deepEqual(loadedAttempts[1], attributedAttempt, "owner/intent survive the disk round-trip verbatim");
		assert.equal(loadedAttempts[1]?.owner, "session-u9adj");
		assert.equal(loadedAttempts[1]?.intent, "auto-retry");
	} finally {
		cleanup();
	}
});

test("TaskAttemptState back-compat: a pre-U9-ADJ tasks.json payload (no owner/intent anywhere) parses without rejection", () => {
	const { cwd, cleanup } = makeTempProject();
	try {
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "U9-ADJ legacy load" });
		// Hand-write a v0 bare-array tasks.json shaped exactly like a
		// pre-U9-ADJ writer would have produced (no owner/intent keys).
		const legacyTasks: TeamTaskState[] = tasks.map((task, index) =>
			index === 0
				? {
						...task,
						attempts: [{ attemptId: "retry_attempt_1", startedAt: "2026-10-12T00:00:00.000Z", error: "boom" }],
					}
				: task,
		);
		fs.writeFileSync(manifest.tasksPath, JSON.stringify(legacyTasks), "utf-8");
		const loaded = loadTasksWithRecovery(manifest.tasksPath, manifest.eventsPath, manifest.runId);
		assert.deepEqual(loaded[0]?.attempts, [
			{ attemptId: "retry_attempt_1", startedAt: "2026-10-12T00:00:00.000Z", error: "boom" },
		]);
	} finally {
		cleanup();
	}
});
