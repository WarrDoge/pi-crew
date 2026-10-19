import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { invalidateConfigCache } from "../../../../src/config/config.ts";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";
import { firstText } from "../../../fixtures/tool-result-helpers.ts";

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

test("live-session runtime can inherit parent conversation context", async () => {
	const previousEnable = process.env.PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION;
	const previousMock = process.env.PI_CREW_MOCK_LIVE_SESSION;
	const previousAllowMock = process.env.PI_CREW_ALLOW_MOCK; // wave-2b
	const previousDepth = process.env.PI_CREW_DEPTH;
	const previousCrewHome = process.env.PI_CREW_HOME;
	const previousTeamsHome = process.env.PI_TEAMS_HOME;
	process.env.PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION = "1";
	process.env.PI_CREW_MOCK_LIVE_SESSION = "success";
	process.env.PI_CREW_ALLOW_MOCK = "1"; // wave-2b: mock seam double-gated
	process.env.PI_CREW_DEPTH = "0";
	// M1-8 (R45-S2): runtime.mode / runtime.inheritContext are sensitive-marked in
	// the schema, so the run-param tier DROPS them by design (a worker must not be
	// able to flip live-session semantics or pull parent context via run params).
	// Configure the USER tier in an isolated home instead — the feature under test
	// (inheritContext:true end-to-end) is user-config territory now.
	const home = createTrackedTempDir("pi-crew-live-context-home-");
	process.env.PI_CREW_HOME = home;
	process.env.PI_TEAMS_HOME = home;
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".pi", "agent", "pi-crew.json"),
		JSON.stringify({ runtime: { mode: "live-session", inheritContext: true } }),
		"utf8",
	);
	invalidateConfigCache();
	const cwd = createTrackedTempDir("pi-crew-live-context-");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const ctx: TeamContext = {
			cwd,
			model: { provider: "test", id: "model" },
			modelRegistry: {
				find: (_provider: string, _id: string) => ({
					provider: "test",
					id: "model",
				}),
			},
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: {
							role: "user",
							content: [{ type: "text", text: "parent decision abc" }],
						},
					},
				],
			},
		} as TeamContext;
		const run = await handleTeamTool(
			{
				action: "run",
				team: "fast-fix",
				goal: "live inherited context",
			},
			ctx,
		);
		assert.equal(run.isError, false);
		const agentsResult = await handleTeamTool(
			{
				action: "api",
				runId: run.details.runId!,
				config: { operation: "list-agents" },
			},
			{ cwd },
		);
		const first = JSON.parse(firstText(agentsResult))[0];
		const transcript = await handleTeamTool(
			{
				action: "api",
				runId: run.details.runId!,
				config: {
					operation: "read-agent-transcript",
					agentId: first.taskId,
				},
			},
			{ cwd },
		);
		assert.match(firstText(transcript), /parent decision abc/);
	} finally {
		restoreEnv("PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION", previousEnable);
		restoreEnv("PI_CREW_MOCK_LIVE_SESSION", previousMock);
		restoreEnv("PI_CREW_ALLOW_MOCK", previousAllowMock);
		restoreEnv("PI_CREW_DEPTH", previousDepth);
		restoreEnv("PI_CREW_HOME", previousCrewHome);
		restoreEnv("PI_TEAMS_HOME", previousTeamsHome);
		invalidateConfigCache();
		removeTrackedTempDir(home);
		removeTrackedTempDir(cwd);
	}
});
