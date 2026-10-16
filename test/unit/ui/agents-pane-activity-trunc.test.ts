/**
 * O-5 (DR-04 round-7, 2026-10-16): the dashboard AGENTS pane's live activity
 * line (describeActivity, agents-pane.ts) must truncate with the shared
 * grapheme-aware helper instead of the old ad-hoc `slice(0, 40)` — an astral
 * character at the cut boundary used to be split into a lone surrogate.
 *
 * The live handle is registered through the real live-agent-manager with a
 * UNIQUE workspaceId so ambient live agents from other sessions can never
 * leak into this test (U7 knowledge: scope assertions to fixture data).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	clearLiveAgentsForTest,
	registerLiveAgent,
	trackLiveAgentResponseText,
} from "../../../src/runtime/live-session/live-agent-manager.ts";
import { renderAgentsPane } from "../../../src/ui/dashboard-panes/agents-pane.ts";
import type { RunUiSnapshot } from "../../../src/ui/snapshot-types.ts";

const WORKSPACE = "ws-dr04-o5-agents-pane";

function snapshot(): RunUiSnapshot {
	return {
		runId: "team_dr04_o5",
		status: "running",
		team: "t",
		workflow: "t",
		goal: "g",
		progress: { total: 1, completed: 0, running: 1, failed: 0, queued: 0 },
		tasks: [],
		agents: [
			{
				id: "01",
				taskId: "01",
				status: "running" as const,
				role: "explorer",
				agent: "explorer",
				runtime: "child-process" as const,
			},
		],
	} as unknown as RunUiSnapshot;
}

test("O-5: live activity line truncation is grapheme-aware — astral chars never split", () => {
	clearLiveAgentsForTest();
	registerLiveAgent({
		agentId: "01",
		taskId: "01",
		runId: "team_dr04_o5",
		workspaceId: WORKSPACE,
		session: {},
		status: "running",
	});
	// 21 ASCII + 15 emoji = 51 visual cols. The old `line.slice(0, 40)` cut at
	// UTF-16 unit 40 — 21 ASCII + 9.5 emoji → a lone HIGH surrogate + "…".
	trackLiveAgentResponseText("01", `${"x".repeat(21)}${"🚀".repeat(15)}`);

	const lines = renderAgentsPane(snapshot(), { workspaceId: WORKSPACE, nowMs: Date.now() });
	const activity = lines.find((line) => line.includes("🚀"));
	assert.ok(activity, `activity line must surface the response text, got: ${lines.join("\n")}`);
	assert.ok(activity.includes("…"), `51-col line must be truncated, got: ${activity}`);
	assert.ok(!activity.includes("�"), `no replacement char from a split surrogate pair: ${activity}`);
	assert.ok(
		!Array.from(activity).some((c) => c.length === 1 && /[\uD800-\uDFFF]/.test(c)),
		`no lone surrogate unit may leak into the pane: ${activity}`,
	);
	clearLiveAgentsForTest();
});
