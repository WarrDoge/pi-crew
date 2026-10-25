/**
 * R39-M2 regression (fix-wave 6, EP3): corrupt tasks.json recover-then-persist
 * silently DROPPED tasks (events.jsonl only holds tasks that already emitted
 * events) and the run then reported "completed 100%" with no trace. This suite
 * pins the new dropped-count reporting:
 *   - the corrupt payload is quarantined,
 *   - tasks are reconstructed from events,
 *   - task ids present ONLY in the corrupt payload are counted as DROPPED and
 *     recorded (so the loss is observable instead of silent),
 *   - a total-loss payload with no salvageable ids reports 0 dropped.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	__test__clearTasksCorruptionReports,
	getTasksCorruptionReport,
	loadTasksWithRecovery,
	salvageTaskIds,
} from "../../../src/state/stores/manifest-io.ts";
import { removeDirWithRetry } from "../../helpers/rm-retry.ts";

function writeEvents(eventsPath: string, runId: string): void {
	const lines = [
		{ type: "task.created", runId, taskId: "task-A" },
		{ type: "task.started", runId, taskId: "task-A" },
		{ type: "task.completed", runId, taskId: "task-A" },
		{ type: "task.created", runId, taskId: "task-B" },
		{ type: "task.started", runId, taskId: "task-B" },
	];
	fs.writeFileSync(eventsPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

test("salvageTaskIds: recovers top-level task ids, ignores nested ids", () => {
	const raw = '[{"id":"t1","modelRouting":{"id":"nested-should-not-count"}},{"id":"t2"}';
	assert.deepEqual(salvageTaskIds(raw), ["t1", "t2"]);
});

test("salvageTaskIds: returns [] for a payload with no salvageable task objects", () => {
	assert.deepEqual(salvageTaskIds("{}"), []);
	assert.deepEqual(salvageTaskIds("{ this is not json }"), []);
});

test("R39-M2: corrupt tasks.json reports the tasks DROPPED by event-only reconstruction", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-corrupt-"));
	try {
		const runId = "team_20260101000000_drop";
		const tasksPath = path.join(dir, "tasks.json");
		const eventsPath = path.join(dir, "events.jsonl");
		writeEvents(eventsPath, runId);

		// A valid-prefix truncated array: individual objects parse, the whole
		// file does not. Salvageable ids = t1,t2,t3; the event log only knows
		// task-A/task-B, so all three are "dropped".
		fs.writeFileSync(tasksPath, '[{"id":"t1","status":"queued"},{"id":"t2","status":"queued"},{"id":"t3","status":"running"},');

		__test__clearTasksCorruptionReports();
		const reconstructed = loadTasksWithRecovery(tasksPath, eventsPath, runId);

		assert.deepEqual(reconstructed.map((task) => task.id).sort(), ["task-A", "task-B"], "tasks reconstructed from events");
		assert.ok(
			fs.readdirSync(dir).some((f) => f.startsWith("tasks.json.corrupt-")),
			"corrupt file quarantined",
		);

		const report = getTasksCorruptionReport(runId);
		assert.ok(report, "a corruption report is recorded");
		assert.equal(report!.reconstructedCount, 2);
		assert.equal(report!.salvagedCount, 3);
		assert.deepEqual(report!.droppedIds.sort(), ["t1", "t2", "t3"], "dropped task ids are reported");
	} finally {
		await removeDirWithRetry(dir);
		__test__clearTasksCorruptionReports();
	}
});

test("R39-M2: non-array ({}) corruption reports 0 salvaged / 0 dropped (total loss is not misreported)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-corrupt-"));
	try {
		const runId = "team_20260101000000_allloss";
		const tasksPath = path.join(dir, "tasks.json");
		const eventsPath = path.join(dir, "events.jsonl");
		writeEvents(eventsPath, runId);
		fs.writeFileSync(tasksPath, '{"not":"an array"}');

		__test__clearTasksCorruptionReports();
		const reconstructed = loadTasksWithRecovery(tasksPath, eventsPath, runId);
		assert.equal(reconstructed.length, 2, "still reconstructs from events");

		const report = getTasksCorruptionReport(runId);
		assert.ok(report);
		assert.equal(report!.salvagedCount, 0);
		assert.deepEqual(report!.droppedIds, []);
	} finally {
		await removeDirWithRetry(dir);
		__test__clearTasksCorruptionReports();
	}
});
