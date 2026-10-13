/**
 * U16 — usage ledger, subprocess tier (child-process runtimeKind) e2e test.
 *
 * Drives the REAL runTeamTask → child-executor path through the mock child pi
 * (`PI_TEAMS_MOCK_CHILD_PI=json-usage-ledger`, added with U16), which emits
 * message_end events carrying the REAL message-level usage shape — usage
 * nested under message.role="assistant" with cost as an OBJECT
 * ({input, output, cacheRead, cacheWrite, total} per @earendil-works/pi-ai
 * Usage). Asserts:
 *   - AC 5: task.lifetimeUsage accumulates input/output/cacheRead/cacheWrite
 *     and cost (via cost.total) across MULTIPLE message_end events.
 *   - the final task.usage (parsedOutput.usage, subprocess write-site) also
 *     carries a numeric cost extracted from the object form.
 *   - RT-8 immutable-snapshot invariant: the input task object is untouched.
 *
 * Harness copied from child-executor-spawn-budget-config.test.ts (same mock
 * child pi env seam).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { runTeamTask } from "../../../../src/runtime/task-runner.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const team = {
	name: "t",
	description: "",
	source: "project",
	filePath: "t",
	roles: [{ name: "r", agent: "a" }],
} satisfies TeamConfig;
const workflow = {
	name: "w",
	description: "",
	source: "project",
	filePath: "w",
	steps: [{ id: "s", role: "r", task: "usage ledger test", model: "x" }],
} satisfies WorkflowConfig;
const agent = {
	name: "a",
	description: "",
	source: "project",
	filePath: "a",
	systemPrompt: "test",
	tools: ["read"],
	extensions: [],
	systemPromptMode: "append",
	inheritProjectContext: false,
	inheritSkills: false,
} satisfies AgentConfig;

const modelRegistry = {
	getAvailable: () => [{ provider: "test", id: "m1" }],
};

function withMockEnv<T>(mock: string, fn: () => Promise<T>): Promise<T> {
	const prevExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const prevMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const prevAllowMock = process.env.PI_CREW_ALLOW_MOCK;
	const prevCrewRole = process.env.PI_CREW_ROLE;
	const prevTeamsRole = process.env.PI_TEAMS_ROLE;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = mock;
	delete process.env.PI_CREW_ROLE;
	delete process.env.PI_TEAMS_ROLE;
	return fn().finally(() => {
		if (prevExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = prevExecute;
		if (prevMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = prevMock;
		if (prevAllowMock === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = prevAllowMock;
		if (prevCrewRole === undefined) delete process.env.PI_CREW_ROLE;
		else process.env.PI_CREW_ROLE = prevCrewRole;
		if (prevTeamsRole === undefined) delete process.env.PI_TEAMS_ROLE;
		else process.env.PI_TEAMS_ROLE = prevTeamsRole;
	});
}

test("U16: lifetimeUsage accumulates cost + cacheRead from object-cost message_end events", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-u16-ledger-"));
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	try {
		await withMockEnv("json-usage-ledger", async () => {
			const created = createRunManifest({ cwd, team, workflow, goal: "u16 usage ledger" });
			const task = created.tasks[0]!;
			// Freeze the input so any in-place mutation (RT-8 regression) throws.
			const inputSnapshot = structuredClone(task);
			Object.freeze(task);

			const result = await runTeamTask({
				manifest: created.manifest,
				tasks: created.tasks,
				task,
				step: workflow.steps[0]!,
				agent,
				executeWorkers: true,
				runtimeKind: "child-process",
				workspaceId: cwd,
				modelOverride: "x",
				modelRegistry,
			});

			assert.deepEqual(task, inputSnapshot, "input task must NOT be mutated in place (RT-8)");

			const resultTask = result.tasks.find((t) => t.id === task.id);
			assert.ok(resultTask, "result must contain the task");

			// AC 5 — the two mock message_end events sum:
			// input 10+7, output 5+2, cacheRead 40+20, cacheWrite 3+1,
			// cost 0.035+0.0203 (extracted from the cost OBJECT totals).
			const lifetime = resultTask.lifetimeUsage;
			assert.ok(lifetime, "lifetimeUsage must be present after message_end events");
			assert.equal(lifetime.input, 17);
			assert.equal(lifetime.output, 7);
			assert.equal(lifetime.cacheRead, 60, "cacheRead must accumulate (was dropped pre-U16)");
			assert.equal(lifetime.cacheWrite, 4);
			assert.ok(
				lifetime.cost !== undefined && Math.abs(lifetime.cost - 0.0553) < 1e-9,
				`cost must accumulate via cost.total (was dropped pre-U16), got ${lifetime.cost}`,
			);

			// Subprocess write-site: final task.usage (parsedOutput.usage) must
			// carry a numeric cost parsed from the message-level object form.
			const usage = resultTask.usage;
			assert.ok(usage, "final task.usage must be present");
			assert.ok(
				usage.cost !== undefined && typeof usage.cost === "number" && Math.abs(usage.cost - 0.0203) < 1e-9,
				`task.usage.cost must be the numeric last-event total, got ${usage.cost}`,
			);
			assert.ok(usage.cacheRead !== undefined, "task.usage.cacheRead must be present");
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
