/**
 * R4-A1 (deep-review wave-1): sweep-path agent-record retention pin.
 *
 * `sweepExpiredWaitingTasks` requeues an expired waiting park and rewrites
 * agents.json for the requeued task. agents.json is a FULL-INDEX overwrite
 * (saveCrewAgents) — the pre-fix code persisted only the requeued subset and
 * silently wiped every sibling agent record (incl. RUNNING agents), mirroring
 * the team-runner.ts:525 subset-save bug. The fix merges the requeued records
 * into the existing index. This test pins the merged contract: 2 sibling
 * records + 1 requeued park ⇒ agents.json retains ALL of them.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { readCrewAgents, recordFromTask, saveCrewAgents } from "../../../src/runtime/crew-agent-records.ts";
import { sweepExpiredWaitingTasks } from "../../../src/runtime/dispatch-batch.ts";
import { clearLiveAgentsForTest } from "../../../src/runtime/live-session/live-agent-manager.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";

function makeRunFixture(): { cwd: string; runId: string; manifest: TeamRunManifest } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-r4a1-sweep-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const team = {
		name: "test-team",
		description: "",
		roles: [{ name: "executor", agent: "executor" }],
		source: "test",
		filePath: "builtin",
	} as unknown as TeamConfig;
	const created = createRunManifest({ cwd, team, goal: "r4a1 sweep retention" });
	return { cwd, runId: created.manifest.runId, manifest: created.manifest };
}

function makeTask(id: string, status: TeamTaskState["status"], overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id,
		runId: "r4a1_run",
		stepId: "s1",
		role: "executor",
		agent: "executor",
		title: id,
		status,
		dependsOn: [],
		cwd: "/tmp/pi-crew-r4a1",
		graph: { taskId: id, children: [], dependencies: [], queue: "done" },
		...overrides,
	} as unknown as TeamTaskState;
}

test("R4-A1 sweep path: requeueing an expired park retains ALL sibling agent records", async () => {
	clearLiveAgentsForTest();
	const { cwd, runId, manifest } = makeRunFixture();
	try {
		// One expired waiting park (no heartbeat ⇒ worker DEAD ⇒ requeue) plus
		// two untouched siblings whose agent records already sit in agents.json.
		const parked = makeTask("wait", "waiting", {
			waiting: {
				questionId: randomUUID(),
				askedAt: new Date().toISOString(),
				deadline: Date.now() - 1_000,
			},
		});
		const runningSibling = makeTask("sib_running", "running");
		const doneSibling = makeTask("sib_done", "completed");
		saveRunTasks(manifest, [parked, runningSibling, doneSibling]);

		// Seed agents.json with the two sibling records (the pre-wipe state).
		saveCrewAgents(manifest, [
			recordFromTask(manifest, runningSibling, "child-process"),
			recordFromTask(manifest, doneSibling, "child-process"),
		]);
		assert.equal(readCrewAgents(manifest).length, 2, "seed: exactly 2 sibling records on disk");

		const sweep = await sweepExpiredWaitingTasks(cwd, runId, Date.now(), [parked]);
		assert.ok(sweep, "expired park must proceed into the locked sweep");
		assert.deepEqual(sweep.requeuedTaskIds, ["wait"], "dead worker ⇒ requeue the park");

		// tasks.json: only the park changed status.
		const loaded = loadRunManifestById(cwd, runId);
		assert.ok(loaded);
		assert.equal(loaded.tasks.find((t) => t.id === "wait")?.status, "queued");
		assert.equal(loaded.tasks.find((t) => t.id === "sib_running")?.status, "running");

		// R4-A1 pin: agents.json retains ALL records — the merge must keep both
		// siblings AND add the requeued task (pre-fix: only the requeued subset
		// survived, wiping the RUNNING sibling's record).
		const records = readCrewAgents(loaded.manifest);
		const byTaskId = new Map(records.map((r) => [r.taskId, r]));
		assert.equal(records.length, 3, "ALL 3 records must be retained (2 siblings + 1 requeued)");
		assert.equal(byTaskId.get("sib_running")?.status, "running", "running sibling record survives");
		assert.equal(byTaskId.get("sib_done")?.status, "completed", "completed sibling record survives");
		assert.equal(byTaskId.get("wait")?.status, "queued", "requeued task gets a fresh record");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
