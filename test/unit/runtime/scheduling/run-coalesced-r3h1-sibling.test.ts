/**
 * R3-H1 (deep-review wave-1): coalesced-group dispatch saves must never
 * revert concurrent sibling terminal state.
 *
 * The three dispatch-time saves in runCoalescedTaskGroup (pre-dispatch status
 * flip ×2 + the terminal write) previously called
 * `saveRunTasksAsync(manifest, updatedTasks)` — persisting the DISPATCH-TIME
 * FULL-ARRAY closure, which silently reverted sibling tasks that reached
 * completed/cancelled on disk AFTER dispatch (external cancel, reconciler,
 * sibling agent finishing). The fix routes all three through
 * repairGroupTerminalWrite (fresh-read + group-scoped merge). This file pins
 * both halves:
 *  1. behavioral — repairGroupTerminalWrite preserves disk-terminal siblings
 *     (completed AND cancelled) while still applying the group's own state;
 *  2. structural — none of the dispatch save sites may write the raw
 *     `updatedTasks` closure array anymore.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { __test__repairGroupTerminalWrite } from "../../../../src/runtime/scheduling/run-coalesced-task-group.ts";
import { createRunManifest, loadRunManifestById, saveRunTasksAsync } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";

const SRC_PATH = "src/runtime/scheduling/run-coalesced-task-group.ts";

const team: TeamConfig = {
	name: "r3h1-coalesced",
	description: "R3-H1 concurrent sibling pin",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-r3h1-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function makeTask(id: string, status: TeamTaskState["status"], runId: string, cwd: string): TeamTaskState {
	return {
		id,
		runId,
		stepId: "batch",
		role: "worker",
		agent: "worker",
		title: id,
		status,
		dependsOn: [],
		cwd,
	};
}

test("R3-H1: group terminal write does NOT revert concurrent sibling completed/cancelled state", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, goal: "R3-H1 concurrent siblings" });
		const runId = manifest.runId;

		// Disk truth AFTER dispatch: both group tasks still running, sibling_a
		// COMPLETED by its own agent, sibling_b CANCELLED externally.
		await saveRunTasksAsync(manifest, [
			makeTask("g1", "running", runId, cwd),
			makeTask("g2", "running", runId, cwd),
			{ ...makeTask("sibling_a", "completed", runId, cwd), finishedAt: new Date().toISOString() },
			{ ...makeTask("sibling_b", "cancelled", runId, cwd), finishedAt: new Date().toISOString() },
		]);

		// Dispatch-time closure snapshot: group tasks now terminal, siblings
		// STILL RUNNING (stale — this is the array the pre-fix code persisted).
		const updatedTasks: TeamTaskState[] = [
			{ ...makeTask("g1", "completed", runId, cwd), finishedAt: new Date().toISOString() },
			{ ...makeTask("g2", "failed", runId, cwd), finishedAt: new Date().toISOString(), error: "boom" },
			makeTask("sibling_a", "running", runId, cwd),
			makeTask("sibling_b", "running", runId, cwd),
		];

		await __test__repairGroupTerminalWrite(manifest, ["g1", "g2"], updatedTasks);

		const after = loadRunManifestById(manifest.cwd, manifest.runId)!;
		const byId = new Map(after.tasks.map((t) => [t.id, t]));

		// Group's own terminal state lands.
		assert.equal(byId.get("g1")?.status, "completed", "group task g1 terminal state must be applied");
		assert.equal(byId.get("g2")?.status, "failed", "group task g2 terminal state must be applied");
		// Concurrent sibling terminal state is NEVER reverted by the group write.
		assert.equal(byId.get("sibling_a")?.status, "completed", "sibling completed on disk must NOT be reverted to running");
		assert.ok(byId.get("sibling_a")?.finishedAt, "sibling_a finishedAt preserved");
		assert.equal(byId.get("sibling_b")?.status, "cancelled", "sibling cancelled on disk must NOT be reverted to running");
		assert.ok(byId.get("sibling_b")?.finishedAt, "sibling_b finishedAt preserved");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("R3-H1 structural: no dispatch save site persists the raw updatedTasks closure array", () => {
	const src = fs.readFileSync(SRC_PATH, "utf-8");
	// Pre-fix shape — writing the full dispatch-time snapshot — must be GONE.
	assert.equal(
		src.includes("saveRunTasksAsync(manifest, updatedTasks)"),
		false,
		"dispatch saves must go through repairGroupTerminalWrite (fresh-read merge), never the raw updatedTasks array",
	);
	// All three swapped sites are present (pre-dispatch ×2 + terminal write).
	const swaps = src.match(/await repairGroupTerminalWrite\(manifest, taskIds, updatedTasks\)/g) ?? [];
	assert.ok(swaps.length >= 3, `expected >= 3 repairGroupTerminalWrite call sites, found ${swaps.length}`);
	// The merge helper itself only persists the fresh-read merged array.
	assert.ok(src.includes("await saveRunTasksAsync(manifest, merged)"), "merge helpers persist the fresh-read merged array");
});
