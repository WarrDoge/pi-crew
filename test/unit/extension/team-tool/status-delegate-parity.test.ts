/**
 * EP2 parity rider (wave-6 M4-R2) — status must fold `delegate.completed` the
 * same way finalize-run does.
 *
 * A grandchild delegate task carries no usage/transcript of its own — its real
 * output flowed through the broker mailbox to the parent — so effectiveness
 * flagged it as "no observable worker activity" (R9-F3). finalize-run passes
 * the `delegate.completed` id set to suppress that false flag; `status`
 * omitted it, so the SAME run rendered a phantom `noObservedWork` row while
 * finalize counted the task as work. This pins status-side parity.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handleStatus } from "../../../../src/extension/team-tool/status.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { appendEvent } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "run", role: "executor", task: "Run {goal}" }],
};

describe("status delegate.completed parity (EP2 rider)", () => {
	it("a completed delegate task WITHOUT usage/transcript is not flagged noObservedWork when delegate.completed ok:true exists", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ep2-"));
		try {
			fs.writeFileSync(path.join(cwd, "package.json"), "{}\n");
			fs.mkdirSync(path.join(cwd, ".git"));
			const created = createRunManifest({ cwd, team, workflow, goal: "ep2 parity" });
			const taskId = created.tasks[0]!.id;
			saveRunManifest({ ...created.manifest, status: "running" });
			// Completed, but with NO observable worker activity of its own — the
			// exact shape of a delegate grandchild whose output went via mailbox.
			saveRunTasks(created.manifest, [{ ...created.tasks[0]!, status: "completed", finishedAt: new Date().toISOString() }]);
			// The broker records a delegate.completed ok:true event for the subId.
			appendEvent(created.manifest.eventsPath, {
				type: "delegate.completed",
				runId: created.manifest.runId,
				data: { subId: taskId, ok: true },
			});

			const out = textFromToolResult(handleStatus({ runId: created.manifest.runId }, { cwd } as TeamContext));
			assert.match(out, /- noObservedWork=none/, `delegate.completed must suppress the phantom row, got: ${out}`);
			assert.match(out, /- observable=1\/1 completed tasks/, "the delegate task counts as observable work");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("control: the SAME completed task IS flagged when no delegate.completed event exists", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ep2-"));
		try {
			fs.writeFileSync(path.join(cwd, "package.json"), "{}\n");
			fs.mkdirSync(path.join(cwd, ".git"));
			const created = createRunManifest({ cwd, team, workflow, goal: "ep2 control" });
			const taskId = created.tasks[0]!.id;
			saveRunManifest({ ...created.manifest, status: "running" });
			saveRunTasks(created.manifest, [{ ...created.tasks[0]!, status: "completed", finishedAt: new Date().toISOString() }]);

			const out = textFromToolResult(handleStatus({ runId: created.manifest.runId }, { cwd } as TeamContext));
			assert.match(out, new RegExp(`- noObservedWork=${taskId}`), `without the event the task must be flagged, got: ${out}`);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
