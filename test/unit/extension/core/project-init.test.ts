import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { initializeProject } from "../../../../src/extension/project-init.ts";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { resolveCanonicalDir } from "../../../fixtures/test-tempdir.ts";
import { firstText } from "../../../fixtures/tool-result-helpers.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

async function withIsolatedHome(fn: () => Promise<void> | void): Promise<() => Promise<void>> {
	return async () => {
		const cwd = resolveCanonicalDir(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-init-test-")));
		const previousHome = process.env.PI_TEAMS_HOME;
		const previousSkipCheck = process.env.PI_CREW_SKIP_HOME_CHECK;
		// Sandbox the PROCESS home too (HOME on POSIX, USERPROFILE on win32): the
		// isolated home IS the project here, so the marker walk stops at the
		// boundary and projectCrewRoot(cwd) resolves to <cwd>/.crew everywhere.
		// Without this the walk can escape to the machine's real home on Windows
		// (its ~/.pi is a project marker) and initializeProject writes elsewhere.
		const previousOsHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		process.env.PI_TEAMS_HOME = cwd;
		process.env.PI_CREW_SKIP_HOME_CHECK = "1";
		process.env.HOME = cwd;
		process.env.USERPROFILE = cwd;
		try {
			await fn();
		} finally {
			if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
			else process.env.PI_TEAMS_HOME = previousHome;
			if (previousSkipCheck === undefined) delete process.env.PI_CREW_SKIP_HOME_CHECK;
			else process.env.PI_CREW_SKIP_HOME_CHECK = previousSkipCheck;
			if (previousOsHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousOsHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
			await removeDirWithRetry(cwd);
		}
	};
}

test(
	"project init creates directories and gitignore entries idempotently",
	await withIsolatedHome(async () => {
		const cwd = process.env.PI_TEAMS_HOME!;
		const first = initializeProject(cwd);
		assert.ok(first.gitignoreUpdated);
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "agents")));
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "teams")));
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "workflows")));
		assert.equal(first.configScope, "global");
		assert.equal(first.configCreated, true);
		assert.ok(fs.existsSync(path.join(cwd, ".pi", "agent", "pi-crew.json")));
		assert.equal(fs.existsSync(path.join(cwd, ".pi", "pi-crew.json")), false);
		const config = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "agent", "pi-crew.json"), "utf-8"));
		assert.equal(config.agents.overrides.explorer.model, false);
		assert.equal(config.agents.overrides.executor.thinking, "medium");
		assert.equal(config.ui.widgetPlacement, "bottom");
		assert.equal(config.ui.widgetMaxLines, 8);
		// L3 (2026-10-07): project-init derives from DEFAULT_UI — default "right".
		assert.equal(config.ui.dashboardPlacement, "right");
		assert.equal(config.ui.dashboardWidth, 72);
		assert.equal(config.ui.autoOpenDashboard, false);
		assert.equal(config.ui.autoOpenDashboardForForegroundRuns, false);
		assert.equal(config.ui.showModel, true);
		assert.equal(config.ui.showTokens, true);
		assert.equal(config.ui.showTools, true);
		const gitignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf-8");
		assert.match(gitignore, /\.crew\/state\//);
		const second = initializeProject(cwd);
		assert.equal(second.gitignoreUpdated, false);
		assert.equal(second.configScope, "global");
		assert.equal(second.configCreated, false);
		assert.equal(second.configSkipped, true);
		const tool = await handleTeamTool({ action: "init" }, { cwd });
		assert.equal(tool.isError, false);
		assert.match(firstText(tool), /Initialized pi-crew/);
		assert.match(firstText(tool), /Config:.*global/);
		const withBuiltins = await handleTeamTool({ action: "init", config: { copyBuiltins: true } }, { cwd });
		assert.equal(withBuiltins.isError, false);
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "teams", "default.team.md")));
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "workflows", "default.workflow.md")));
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "agents", "explorer.md")));
		const projectConfig = initializeProject(cwd, {
			configScope: "project",
		});
		assert.equal(projectConfig.configScope, "project");
		assert.ok(fs.existsSync(path.join(cwd, ".pi", "pi-crew.json")));
	}),
);

test(
	"project init with ignoreMethod=exclude writes to .git/info/exclude",
	await withIsolatedHome(async () => {
		const cwd = process.env.PI_TEAMS_HOME!;
		// Create .git/info/ to simulate git repo
		fs.mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });
		const result = initializeProject(cwd, { ignoreMethod: "exclude" });
		assert.ok(result.gitignoreUpdated);
		// Should write to .git/info/exclude, NOT .gitignore
		assert.equal(fs.existsSync(path.join(cwd, ".gitignore")), false);
		const exclude = fs.readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf-8");
		assert.match(exclude, /\.crew\/state\//);
		assert.match(exclude, /# pi-crew runtime state/);
		// Idempotent
		const second = initializeProject(cwd, { ignoreMethod: "exclude" });
		assert.equal(second.gitignoreUpdated, false);
	}),
);

test(
	"project init with ignoreMethod=exclude creates .git/info/ if missing",
	await withIsolatedHome(async () => {
		const cwd = process.env.PI_TEAMS_HOME!;
		// No .git directory at all
		const result = initializeProject(cwd, { ignoreMethod: "exclude" });
		assert.ok(result.gitignoreUpdated);
		assert.ok(fs.existsSync(path.join(cwd, ".git", "info", "exclude")));
	}),
);

// ── F13-A pin (wave-6 M3-22): an explicit overwrite must never be silent ──

test(
	"project init: overwriting an existing config backs it up and reports the path (F13-A)",
	await withIsolatedHome(async () => {
		const cwd = process.env.PI_TEAMS_HOME!;
		initializeProject(cwd);
		const configPath = path.join(cwd, ".pi", "agent", "pi-crew.json");
		fs.writeFileSync(configPath, JSON.stringify({ userCustom: { mine: true } }), "utf-8");

		const overwritten = initializeProject(cwd, { overwrite: true });

		assert.ok(overwritten.configBackupPath, "the overwrite must report where the old config went");
		assert.equal(
			JSON.parse(fs.readFileSync(overwritten.configBackupPath!, "utf-8")).userCustom.mine,
			true,
			"the backup holds the PRE-overwrite user content",
		);
		assert.equal(JSON.parse(fs.readFileSync(configPath, "utf-8")).userCustom, undefined, "the config is replaced by the defaults");

		// The tool result must surface the backup path (no silent replacement).
		const tool = await handleTeamTool({ action: "init", config: { overwrite: true } }, { cwd });
		assert.equal(tool.isError, false);
		assert.match(firstText(tool), /overwritten — previous content backed up to /);
	}),
);

test(
	"project init: without overwrite an existing config is preserved (and says so)",
	await withIsolatedHome(async () => {
		const cwd = process.env.PI_TEAMS_HOME!;
		initializeProject(cwd);
		const configPath = path.join(cwd, ".pi", "agent", "pi-crew.json");
		fs.writeFileSync(configPath, JSON.stringify({ keepMe: true }), "utf-8");

		const skipped = initializeProject(cwd);

		assert.equal(skipped.configSkipped, true);
		assert.equal(skipped.configCreated, false);
		assert.equal(skipped.configBackupPath, undefined);
		assert.equal(JSON.parse(fs.readFileSync(configPath, "utf-8")).keepMe, true, "existing config untouched");
		const tool = await handleTeamTool({ action: "init" }, { cwd });
		assert.match(firstText(tool), /already existed — left untouched \(pass config\.overwrite: true to replace\)/);
	}),
);
