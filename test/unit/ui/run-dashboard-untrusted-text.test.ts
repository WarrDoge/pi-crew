/**
 * EP1 (fixwave6 M2-1) — R11-F2/S3 + R31-S1 pins: worker-authored text entering
 * the operator TUI must go through `sanitizeUntrustedLine`, not the trusted
 * `sanitizeLine` (which deliberately preserves ALL well-formed escapes for
 * theme colors — so OSC-52 clipboard writes / OSC-8 hyperlinks from a worker
 * goal or a worker-stderr terminal reason pass through verbatim).
 *
 * Sources:
 *  - run.goal is worker-authorable (un-gated `team run`) → run list row
 *    (renderRunRow) + selected-run detail header.
 *  - terminal reason = summarizeTerminalReason → first failed task's `error`
 *    (child stderr) → detail header suffix.
 *
 * `sanitizeLine` already collapses CR/LF, so the residual gap is ESCAPES —
 * these pins therefore assert the OSC-52 / OSC-8 / BEL bytes are gone (SGR
 * colors legitimately survive the untrusted sanitizer).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { __test__resetDashboardState, RunDashboard } from "../../../src/ui/run-dashboard.ts";
import { removeDirWithRetry } from "../../helpers/rm-retry.ts";

const BEL = "\u0007";
/** OSC-52 clipboard write — paste-to-execute on kitty/tmux set-clipboard-on. */
const OSC52 = `\u001b]52;c;aGVsbG8gc3Bvb2ZlZA==${BEL}`;
/** OSC-8 hyperlink — clickable phishing link in the operator terminal. */
const OSC8 = "\u001b]8;;https://evil.example\u001b\\click-me\u001b]8;;\u001b\\";

const team = {
	name: "ep1-team",
	description: "",
	roles: [{ name: "worker", agent: "worker" }],
	source: "test",
	filePath: "builtin",
} as never;

const workflow = {
	name: "ep1-workflow",
	description: "",
	steps: [{ id: "one", role: "worker" }],
	source: "test",
	filePath: "builtin",
} as never;

function memoryRun(id: string, status: TeamRunManifest["status"], goal: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: id,
		team: "default",
		workflow: "default",
		goal,
		status,
		workspaceMode: "single",
		createdAt: "2026-04-26T00:00:00.000Z",
		updatedAt: "2026-04-26T00:00:00.000Z",
		cwd: "/tmp/project",
		stateRoot: "/tmp/state",
		artifactsRoot: "/tmp/artifacts",
		tasksPath: "/tmp/state/tasks.json",
		eventsPath: "/tmp/state/events.jsonl",
		artifacts: [],
	};
}

/** No OSC-52 / OSC-8 / BEL byte may reach any rendered dashboard line. */
function assertNoOsc(lines: string[], label: string): void {
	const joined = lines.join("\n");
	assert.ok(!joined.includes("]52;"), `${label}: OSC-52 clipboard write must not reach the TUI`);
	assert.ok(!joined.includes("]8;;"), `${label}: OSC-8 hyperlink must not reach the TUI`);
	assert.ok(!joined.includes(BEL), `${label}: no BEL terminator survives`);
}

test("R11-F2/S3: run-list goal renders through sanitizeUntrustedLine (OSC-52/OSC-8 neutralized)", () => {
	__test__resetDashboardState();
	const goal = `benign-goal-marker ${OSC52} ${OSC8} tail`;
	const dashboard = new RunDashboard([memoryRun("team_ep1_goal", "running", goal)], () => undefined);
	const lines = dashboard.render(120);

	assertNoOsc(lines, "run-list goal");
	// The benign goal text still renders (the fix is not a drop).
	assert.ok(
		lines.some((line) => line.includes("benign-goal-marker")),
		`benign goal text missing: ${JSON.stringify(lines.filter((l) => l.includes("benign")))}`,
	);
});

test("R31-S1: terminal-reason (worker stderr) renders through sanitizeUntrustedLine", async () => {
	__test__resetDashboardState();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ep1-reason-"));
	try {
		const created = createRunManifest({ cwd: tmp, team, workflow, goal: "ep1 terminal reason" });
		const reason = `child-stderr-marker ${OSC52} ${OSC8} done`;
		// Pin the run + tasks to THIS temp dir so readRunTasks (no snapshot cache)
		// reads the file synchronously — same pattern as the other dashboard tests.
		const failedManifest: TeamRunManifest = {
			...created.manifest,
			status: "failed",
			stateRoot: tmp,
			tasksPath: path.join(tmp, "tasks.json"),
		};
		saveRunManifest(failedManifest, { allowTerminalExit: true });
		saveRunTasks(
			failedManifest,
			created.tasks.map((task, index) => (index === 0 ? { ...task, status: "failed" as const, error: reason } : task)),
		);

		const dashboard = new RunDashboard([failedManifest], () => undefined);
		const lines = dashboard.render(120);

		assertNoOsc(lines, "terminal reason");
		assert.ok(
			lines.some((line) => line.includes("child-stderr-marker")),
			`terminal reason text missing: ${JSON.stringify(lines.filter((l) => l.includes("child-stderr")))}`,
		);
	} finally {
		await removeDirWithRetry(tmp);
	}
});
