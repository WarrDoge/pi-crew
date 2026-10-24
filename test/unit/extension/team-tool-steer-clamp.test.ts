/**
 * R5-6 (DR-02 round-5 audit) — send-side clamp for `team steer` bodies.
 *
 * The worker-side receiver (prompt-runtime sanitizeSteerMessage) clamps too,
 * but its pre-fix rejection of >4096-char steers was TERMINAL: the poll
 * cursor advanced past the line (warn-only) and the send side had no clamp,
 * so an oversized leader steer silently vanished. handleSteer (team-tool.ts)
 * is the dispatch entry for the `team steer` action — clamping there means
 * pendingSteers, the steering JSONL, and the task.steer_queued event all
 * already carry a receiver-safe body with the truncation marker visible in
 * the leader's audit trail.
 *
 * Fixture: a minimal on-disk run (manifest.json + tasks.json under
 * <tmp>/.crew/state/runs/<runId>/) — `.crew` is a project marker, so
 * locateRunCwd/loadRunManifestById resolve the run from ctx.cwd.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { handleSteer } from "../../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import { removeDirWithRetry } from "../../helpers/rm-retry.ts";

const RUN_ID = "team_steer_clamp_test";
const TASK_ID = "01_execute";
const STEER_LIMIT = 4096;
const MARKER = `[message truncated at ${STEER_LIMIT} chars]`;

const tmpDirs: string[] = [];

function makeRun(status: TeamTaskState["status"]): string {
	// CI platform parity (2026-10-16, caught by the 0.11.22 matrix): mkdtemp
	// returns the LEXICAL tmpdir path. The product canonicalizes with
	// realpathSync.NATIVE (paths.ts) — plain realpathSync does NOT expand Windows
	// 8.3 short names (GH runners' TEMP=C:\Users\RUNNER~1\...) while .native
	// does, and locateRunCwd's stateRoot comparison then mismatches → handleSteer
	// answers "Run not found" on windows (macOS symlink case fixed by plain
	// realpath already; this native form covers BOTH). Same primitive as product.
	const cwd = (() => {
		const lexical = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-steer-clamp-"));
		try {
			return fs.realpathSync.native(lexical);
		} catch {
			try {
				return fs.realpathSync(lexical);
			} catch {
				return lexical;
			}
		}
	})();
	tmpDirs.push(cwd);
	const crewRoot = path.join(cwd, ".crew");
	const stateRoot = path.join(crewRoot, "state", "runs", RUN_ID);
	const artifactsRoot = path.join(crewRoot, "artifacts", RUN_ID);
	fs.mkdirSync(stateRoot, { recursive: true });
	fs.mkdirSync(artifactsRoot, { recursive: true });
	fs.writeFileSync(path.join(stateRoot, "events.jsonl"), "");
	const manifest: TeamRunManifest = {
		schemaVersion: 1,
		runId: RUN_ID,
		team: "default",
		workflow: "default",
		goal: "steer clamp test",
		status: "running",
		cwd,
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		stateRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifactsRoot,
		artifacts: [],
	};
	fs.writeFileSync(path.join(stateRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
	const task: TeamTaskState = {
		runId: RUN_ID,
		id: TASK_ID,
		title: "steer clamp probe task",
		role: "executor",
		agent: "executor",
		status,
		dependsOn: [],
		cwd,
	};
	fs.writeFileSync(manifest.tasksPath, JSON.stringify([task]));
	return cwd;
}

// Wave 12d — teardown race. handleSteer is sync and fires `void
// appendEventAsync(...)` (team-tool.ts:1028); that queued write awaits
// fs.promises.mkdir(dirname(eventsPath)) (event-log.ts:787) and can RECREATE
// .crew/state/runs/<runId>/ after a bare rmSync already walked past it ⇒
// ENOTEMPTY under load. removeDirWithRetry settles 250 ms (letting the in-flight
// writer land) then retries EBUSY/EPERM/ENOTEMPTY. There is no public drain for
// the asyncQueues tier (drainAsyncQueues is module-private in event-log.ts), so
// settle+retry is the strongest teardown available here.
afterEach(async () => {
	for (const dir of tmpDirs.splice(0)) {
		await removeDirWithRetry(dir);
	}
});

test("R5-6: handleSteer clamps an oversized message before every sink sees it", () => {
	const cwd = makeRun("running");
	const oversized = `x`.repeat(STEER_LIMIT + 2000);
	const result = handleSteer({ action: "steer", runId: RUN_ID, taskId: TASK_ID, message: oversized }, { cwd });
	assert.equal(result.isError, false, "oversized steer must be accepted (clamped), not refused");

	// Sink 1: pendingSteers on the persisted task.
	const loaded = loadRunManifestById(cwd, RUN_ID);
	assert.ok(loaded, "run reloads");
	const steered = loaded?.tasks.find((t) => t.id === TASK_ID);
	assert.ok(steered?.pendingSteers?.[0], "steer queued on the task");
	const queued = steered?.pendingSteers?.[0] ?? "";
	assert.ok(queued.length <= STEER_LIMIT, `queued body fits the receiver limit (got ${queued.length})`);
	assert.ok(queued.includes(MARKER), "queued body carries the truncation marker");
	assert.ok(queued.startsWith("x".repeat(100)), "head preserved");

	// Sink 2: the steering JSONL the worker polls.
	const steeringFile = path.join(loaded!.manifest.artifactsRoot, "steering", `${TASK_ID}.jsonl`);
	assert.ok(fs.existsSync(steeringFile), "steering JSONL written");
	const line = fs.readFileSync(steeringFile, "utf-8").trim().split("\n").at(-1) ?? "";
	const entry = JSON.parse(line) as { type: string; message: string };
	assert.equal(entry.type, "steer");
	assert.ok(entry.message.length <= STEER_LIMIT, "JSONL body fits the receiver limit");
	assert.ok(entry.message.includes(MARKER), "JSONL body carries the truncation marker");
});

test("R5-6: handleSteer passes a short message through verbatim (no marker)", () => {
	const cwd = makeRun("running");
	const short = "Focus on the caching layer next.";
	const result = handleSteer({ action: "steer", runId: RUN_ID, taskId: TASK_ID, message: short }, { cwd });
	assert.equal(result.isError, false);
	const loaded = loadRunManifestById(cwd, RUN_ID);
	const queued = loaded?.tasks.find((t) => t.id === TASK_ID)?.pendingSteers?.[0];
	assert.equal(queued, short, "short steer queued verbatim");
});

test("R5-6: exactly at the limit is verbatim (boundary parity with the receiver)", () => {
	const cwd = makeRun("running");
	const atLimit = "y".repeat(STEER_LIMIT);
	handleSteer({ action: "steer", runId: RUN_ID, taskId: TASK_ID, message: atLimit }, { cwd });
	const loaded = loadRunManifestById(cwd, RUN_ID);
	const queued = loaded?.tasks.find((t) => t.id === TASK_ID)?.pendingSteers?.[0];
	assert.equal(queued, atLimit, "4096-char steer passes through unclamped");
});
