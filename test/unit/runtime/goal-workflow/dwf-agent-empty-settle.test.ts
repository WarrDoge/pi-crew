/**
 * DR-01 P0 completeness (DWF path): the attemptErrorFor empty-settle branch
 * lives in the task-runner attempt loop, which ctx.agent() BYPASSES —
 * dynamic-workflow-context calls runWorker directly and parsed stdout itself.
 * Before the fix, a 429-exhausted worker (exit 0, empty final assistant
 * message_end, rawFinalText = an early opening sentence) passed the
 * `exitCode !== 0 || childResult.error` gate and the step went GREEN with
 * garbage text — the DWF variant of the false-green that marked 7/7 tasks of
 * run team_20261014082741 "completed" with zero findings.
 *
 * The fix widens the gate with `parsed.settledWithoutAnswer === true`
 * (parser flag from the same DR-01 change). This test drives it through the
 * real ctx.agent() pipeline using the `json-429-empty-settle` mock-fixture
 * seam (in-process, no real pi spawn), mirroring dwf-agent-call-cap.test.ts.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { dwfSettledWithoutAnswerFailure, makeWorkflowCtx } from "../../../../src/runtime/goal-workflow/dynamic-workflow-context.ts";
import type { TeamRunManifest, WorkerExitStatus } from "../../../../src/state/types.ts";
import { cleanupStateRoot } from "../../../helpers/rm-retry.ts";

function tmpCwd(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeManifest(cwd: string): TeamRunManifest {
	const now = new Date().toISOString();
	return {
		runId: "team_dwf_empty_settle_test",
		team: "dwf-test",
		workflow: "test",
		goal: "test empty-settle gate",
		status: "running",
		createdAt: now,
		updatedAt: now,
		cwd,
		stateRoot: `${cwd}/.crew/state/runs/team_dwf_empty_settle_test`,
		artifactsRoot: `${cwd}/.crew/artifacts/team_dwf_empty_settle_test`,
		tasksPath: `${cwd}/.crew/state/runs/team_dwf_empty_settle_test/tasks.json`,
		eventsPath: `${cwd}/.crew/state/runs/team_dwf_empty_settle_test/events.jsonl`,
		artifacts: [],
	} as unknown as TeamRunManifest;
}

function withMockEnv<T>(mode: string, fn: () => Promise<T> | T): Promise<T> | T {
	const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_TEAMS_MOCK_CHILD_PI = mode;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	return Promise.resolve(fn()).finally(() => {
		if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
		if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
	});
}

test("DR-01 DWF: 429-empty-settle worker (exit 0, no error) fails the step instead of green-with-garbage", async () => {
	const cwd = tmpCwd("pi-crew-dwf-empty-settle-");
	try {
		const manifest = fakeManifest(cwd);
		const result = await withMockEnv("json-429-empty-settle", async () => {
			const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
			return await ctx.agent({ role: "explorer", prompt: "explore the thing" });
		});
		assert.equal(result.ok, false, "empty-settle worker must fail the DWF step");
		assert.match(result.error ?? "", /settled without a final answer/i);
		assert.match(result.error ?? "", /rate-limit\/429/i);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("DR-01 DWF: healthy worker (json-success) still passes the gate", async () => {
	const cwd = tmpCwd("pi-crew-dwf-healthy-");
	try {
		const manifest = fakeManifest(cwd);
		const result = await withMockEnv("json-success", async () => {
			const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
			return await ctx.agent({ role: "explorer", prompt: "explore the thing" });
		});
		assert.equal(result.ok, true, "healthy mock worker must keep passing the DWF gate");
		assert.ok((result.text ?? "").length > 0);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

// ---------------------------------------------------------------------------
// DR-03 round-6 Cluster 3 — R6-7: gate exemptions (patches + cancelled),
// mirroring child-executor.ts attemptErrorFor :428-431 exactly.
//
// Tested at the extracted seam dwfSettledWithoutAnswerFailure (the exact
// predicate ctx.agent()'s gate consults) because the mock-fixture layer
// cannot synthesise patch-bearing or cancelled child results without new
// fixtures (mock-fixtures.ts is outside this cluster's file set). The wiring
// of the helper INTO the gate is pinned by the two tests above: the
// json-429-empty-settle shape reaches the gate through the real pipeline and
// its ok:false outcome proves the non-exempt branch fires end-to-end.
// ---------------------------------------------------------------------------

/** Minimal cancelled WorkerExitStatus (abort kill shape). */
function cancelledExitStatus(): WorkerExitStatus {
	return {
		exitCode: null,
		cancelled: true,
		timedOut: false,
		killed: true,
		signal: "SIGTERM",
		cleanupErrors: [],
		finalDrainMs: 0,
	};
}

test("R6-7 DWF gate: patch-only settle is NOT a failure (patches are real work)", () => {
	const failure = dwfSettledWithoutAnswerFailure(
		{},
		{ settledWithoutAnswer: true, patches: ["--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new"] },
	);
	assert.equal(failure, undefined, "coder roles may legitimately end patch-only — gate passes (ok:true path)");
});

test("R6-7 DWF gate: cancelled/aborted attempt is NOT a 429 failure", () => {
	const failure = dwfSettledWithoutAnswerFailure({ exitStatus: cancelledExitStatus() }, { settledWithoutAnswer: true });
	assert.equal(failure, undefined, "an abort must never surface as upstream-rate-limit exhaustion");
});

test("R6-7 DWF gate: patches + cancelled together still exempt", () => {
	const failure = dwfSettledWithoutAnswerFailure(
		{ exitStatus: cancelledExitStatus() },
		{ settledWithoutAnswer: true, patches: ["--- a/x\n+++ b/x"] },
	);
	assert.equal(failure, undefined);
});

test("R6-7 counter-pin: bare empty-settle (no patches, not cancelled) still fails with the 429-style error", () => {
	const failure = dwfSettledWithoutAnswerFailure({}, { settledWithoutAnswer: true });
	assert.match(failure ?? "", /settled without a final answer/i);
	assert.match(failure ?? "", /rate-limit\/429/i);
});

test("R6-7: worker that DID settle with an answer never enters the settled branch", () => {
	assert.equal(dwfSettledWithoutAnswerFailure({}, { settledWithoutAnswer: false }), undefined);
	assert.equal(dwfSettledWithoutAnswerFailure({}, {}), undefined);
});
