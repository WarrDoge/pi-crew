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
import { makeWorkflowCtx } from "../../../../src/runtime/goal-workflow/dynamic-workflow-context.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

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
		fs.rmSync(cwd, { recursive: true, force: true });
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
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
