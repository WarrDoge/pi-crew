/**
 * R48-N1 (fix-wave 6, EP3) — status `needsAttention` must incorporate an
 * EXTERNAL liveness signal (heartbeat/activity age), not worker self-report
 * alone. Before the fix the only input was `activityState === "needs_attention"`
 * (the monitored entity's own claim), so a dead sync host rendered
 * "running / needsAttention=none / 0%" forever.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handleStatus } from "../../../../src/extension/team-tool/status.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

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

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe("status needsAttention external signal (R48-N1)", () => {
	it("surfaces a stale running task even when the worker never self-reports needs_attention", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-n1-"));
		try {
			fs.writeFileSync(path.join(cwd, "package.json"), "{}\n");
			fs.mkdirSync(path.join(cwd, ".git"));
			const created = createRunManifest({ cwd, team, workflow, goal: "n1 external" });
			const taskId = created.tasks[0]!.id;
			saveRunManifest({ ...created.manifest, status: "running" });
			saveRunTasks(created.manifest, [
				{
					...created.tasks[0]!,
					status: "running",
					startedAt: minutesAgo(15),
					// No activityState: the worker self-report is absent (the N1 blind spot).
					agentProgress: { recentTools: [], recentOutput: [], toolCount: 0, lastActivityAt: minutesAgo(15) },
				},
			]);

			const ctx = { cwd } as TeamContext;
			const out = textFromToolResult(handleStatus({ runId: created.manifest.runId }, ctx));
			assert.match(out, new RegExp(`- needsAttention=${taskId}`), "stale task folded into needsAttention");
			assert.match(out, /- unresponsive=.*stale/, "external heartbeat-age signal surfaced");
		} finally {
			await removeDirWithRetry(cwd);
		}
	});

	it("keeps needsAttention=none for a recently active task (no false positive)", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-n1-"));
		try {
			fs.writeFileSync(path.join(cwd, "package.json"), "{}\n");
			fs.mkdirSync(path.join(cwd, ".git"));
			const created = createRunManifest({ cwd, team, workflow, goal: "n1 fresh" });
			saveRunManifest({ ...created.manifest, status: "running" });
			saveRunTasks(created.manifest, [
				{
					...created.tasks[0]!,
					status: "running",
					startedAt: minutesAgo(1),
					agentProgress: { recentTools: [], recentOutput: [], toolCount: 2, lastActivityAt: minutesAgo(0) },
				},
			]);

			const ctx = { cwd } as TeamContext;
			const out = textFromToolResult(handleStatus({ runId: created.manifest.runId }, ctx));
			assert.match(out, /- needsAttention=none/);
			assert.match(out, /- unresponsive=none/);
		} finally {
			await removeDirWithRetry(cwd);
		}
	});
});
