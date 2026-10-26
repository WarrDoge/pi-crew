/**
 * 2026-10-11 user-root leak hardening — the CWD dimension of collectRuns()'s
 * 2.19 temp-origin guard (src/extension/run-index.ts).
 *
 * Production geometry of the leak: unit-test fixtures created runs with bare
 * /tmp cwds (no repo marker) whose state scopeBaseRoot() routed to the REAL
 * user root (~/.pi/agent/extensions/pi-crew), so every live session's
 * async-notifier toasted the fixture failures as
 * "Error: pi-crew run failed: … (inline-seam-fixture/none)".
 *
 * These tests reproduce that geometry with a NON-temp isolated crew home
 * (mkdtemp under os.homedir()). Everything under os.tmpdir() would already be
 * temp-origin via the SCAN root (which keeps its original semantics — active
 * runs liveness-gated, terminal runs listed) and could not exercise the cwd
 * check at all.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { listRecentRuns } from "../../../../src/extension/run-index.ts";
import { createRunManifest, updateRunStatus } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const team: TeamConfig = {
	name: "tempcwd",
	description: "tempcwd",
	source: "builtin",
	filePath: "tempcwd.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};

/**
 * Isolated crew home OUTSIDE os.tmpdir() (see file doc). viewerCwd has no repo
 * markers, so listRecentRuns(viewerCwd) scans ONLY the isolated user root —
 * exactly the leaked-fixture geometry.
 */
async function withNonTempCrewHome<T>(fn: (home: string, viewerCwd: string) => Promise<T> | T): Promise<T> {
	const previous = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.homedir(), "pi-crew-runindex-tempcwd-home-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		return await fn(home, path.join(home, "viewer"));
	} finally {
		if (previous === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previous;
		await removeDirWithRetry(home);
	}
}

function listedRunIds(viewerCwd: string): string[] {
	return listRecentRuns(viewerCwd, 10).map((run) => run.runId);
}

test("terminal bare-temp-cwd run is hidden even when parked in a non-temp crew root (the leak)", async () => {
	await withNonTempCrewHome(async (_home, viewerCwd) => {
		const fixtureCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-tempcwd-fixture-")); // no repo markers
		try {
			const created = createRunManifest({ cwd: fixtureCwd, team, goal: "leaked fixture run" });
			const failed = updateRunStatus(created.manifest, "failed", "bogus goal-loop (fixture)");
			assert.equal(failed.status, "failed");
			assert.equal(
				listedRunIds(viewerCwd).includes(created.manifest.runId),
				false,
				"terminal bare-temp-cwd fixture run must NOT be listed from a non-temp crew root",
			);
		} finally {
			await removeDirWithRetry(fixtureCwd);
		}
	});
});

test("terminal run with non-temp cwd in the same crew root stays listed (control)", async () => {
	await withNonTempCrewHome(async (home, viewerCwd) => {
		const projectCwd = path.join(home, "plain-project"); // non-temp, no repo markers → state also lands in the user root
		const created = createRunManifest({ cwd: projectCwd, team, goal: "control run" });
		const running = updateRunStatus(created.manifest, "running", "started");
		const done = updateRunStatus(running, "completed", "done");
		assert.equal(done.status, "completed");
		assert.equal(listedRunIds(viewerCwd).includes(created.manifest.runId), true, "non-temp-cwd terminal run must remain listed");
	});
});

test("terminal run with MARKERED temp cwd stays listed (deliberate /tmp project or isolated worktree)", async () => {
	await withNonTempCrewHome(async (_home, viewerCwd) => {
		const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-tempcwd-project-"));
		fs.mkdirSync(path.join(tempProject, ".git"), { recursive: true }); // repo marker → deliberate project
		const parkedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-tempcwd-parked-")); // bare cwd: parks state in the user root
		try {
			// The marker'd-cwd-in-user-root geometry cannot arise through createRunManifest
			// (a marker'd cwd routes state under the project itself), so park the run via a
			// bare cwd first, then hand-rewrite the persisted manifest's cwd — the guard
			// reads exactly this field.
			const created = createRunManifest({ cwd: parkedCwd, team, goal: "marked temp project run" });
			const running = updateRunStatus(created.manifest, "running", "started");
			const done = updateRunStatus(running, "completed", "done");
			assert.equal(done.status, "completed");
			const manifestPath = created.paths.manifestPath;
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { cwd: string };
			manifest.cwd = tempProject;
			fs.writeFileSync(manifestPath, JSON.stringify(manifest));
			assert.equal(
				listedRunIds(viewerCwd).includes(created.manifest.runId),
				true,
				"terminal run from a repo-marked temp cwd must remain listed",
			);
		} finally {
			await removeDirWithRetry(tempProject);
			await removeDirWithRetry(parkedCwd);
		}
	});
});

test("active bare-temp-cwd run stays listed in a non-temp root (scratch-dir users keep history)", async () => {
	await withNonTempCrewHome(async (_home, viewerCwd) => {
		const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-tempcwd-scratch-")); // no repo markers
		try {
			const created = createRunManifest({ cwd: scratchCwd, team, goal: "active scratch run" });
			const running = updateRunStatus(created.manifest, "running", "started");
			assert.equal(running.status, "running");
			assert.equal(
				listedRunIds(viewerCwd).includes(created.manifest.runId),
				true,
				"active bare-temp-cwd run must remain listed (only terminal fixture remnants are hidden)",
			);
		} finally {
			await removeDirWithRetry(scratchCwd);
		}
	});
});
