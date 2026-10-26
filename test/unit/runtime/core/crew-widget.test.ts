import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { saveCrewAgents } from "../../../../src/runtime/crew-agent-records.ts";
import { clearLiveAgentsForTest } from "../../../../src/runtime/live-session/live-agent-manager.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { createRunSnapshotCache } from "../../../../src/ui/run-snapshot-cache.ts";
import { buildCrewWidgetLines, type CrewWidgetState, updateCrewWidget } from "../../../../src/ui/widget/index.ts";
import { activeWidgetRuns } from "../../../../src/ui/widget/widget-model.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

test("crew widget renders installed-style run and agent summary lines", async () => {
	clearLiveAgentsForTest();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-"));
	// ISOLATION (2026-09-14): pin PI_TEAMS_HOME to a temp dir (same pattern as
	// the "hides old fixture runs" test below) — listRecentRuns merges the
	// user-scope root, and a developer machine with a live run in flight
	// (watch-loop/surface demos) leaked into the counts and broke /1 running/.
	const previousHome = process.env.PI_TEAMS_HOME;
	const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-home-"));
	process.env.PI_TEAMS_HOME = tempHome;
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "widget smoke",
			},
			{ cwd },
		);
		assert.equal(run.isError, false);
		const loaded = loadRunManifestById(cwd, run.details.runId!)!;
		saveRunManifest({ ...loaded.manifest, status: "running" }, { allowTerminalExit: true });
		saveCrewAgents(loaded.manifest, [
			{
				id: `${loaded.manifest.runId}:01`,
				runId: loaded.manifest.runId,
				taskId: "01",
				agent: "executor",
				role: "executor",
				runtime: "child-process",
				status: "running",
				startedAt: loaded.manifest.createdAt,
				progress: {
					recentTools: [],
					recentOutput: [],
					toolCount: 1,
					currentTool: "bash",
				},
			},
		]);
		// Single-line dock (RAIL §2.B): the identity canopy + counts only —
		// team/workflow and agent detail moved into the Agents & Jobs browser
		// (↓ + Enter). R3-9: the subject is wrapped in an OSC-8 file:// hyperlink
		// to the run's artifacts dir, so the team name sits between the
		// hyperlink escape sequences — match with escapes allowed around it.
		const lines = buildCrewWidgetLines(cwd, 1);
		assert.match(lines[0]!, /^┃ \S+ CREW ▸ (?:\x1b\]8;;\S+\x1b\\)?fast-fix/, `rail + canopy, got '${lines[0]}'`);
		assert.match(lines[0]!, /\x1b\]8;;file:\/\//, "R3-9: dock subject must be a file:// hyperlink");
		assert.match(lines.join("\n"), /1 running/);
		assert.match(lines.join("\n"), /···· ↓·enter/);
		const calls: Array<{ key: string; content: string[] | undefined }> = [];
		const state: CrewWidgetState = { frame: 0 };
		updateCrewWidget(
			{
				cwd,
				hasUI: true,
				sessionManager: { getSessionId: () => "test-session" } as never,
				ui: {
					setStatus: () => undefined,
					setWidget: (key: string, content: string[] | undefined) => calls.push({ key, content }),
				} as never,
			},
			state,
		);
		// With the aboveEditor task list (e58f648b) the calls end with the tasks
		// widget; the agent dock is still installed with content alongside it.
		assert.ok(
			calls.some((call) => call.key === "pi-crew-active" && call.content?.length),
			"agent dock installed with content",
		);
		assert.ok(calls.at(-1)?.key === "pi-crew-tasks" && calls.at(-1)?.content?.length, "task list installed after the dock");
	} finally {
		await removeDirWithRetry(cwd);
		await removeDirWithRetry(tempHome);
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("crew widget hides old fixture runs, shows active runs", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-stale-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-home-"));
	process.env.PI_TEAMS_HOME = tempHome;
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = {
			name: "fast-fix",
			description: "",
			roles: [{ name: "explorer", agent: "explorer" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "fast-fix",
			description: "",
			steps: [{ id: "explore", role: "explorer" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "orphan",
		});
		const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
		saveRunManifest({
			...created.manifest,
			status: "running",
			updatedAt: old,
			summary: "Creating workflow prompts and placeholder results.",
		});
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: "01",
				agent: "explorer",
				role: "explorer",
				runtime: "scaffold",
				status: "queued",
				startedAt: old,
			},
		]);
		let lines = buildCrewWidgetLines(cwd, 0);
		assert.ok(!lines.join("\n").includes(created.manifest.runId.slice(-8)));
		saveRunManifest({
			...created.manifest,
			status: "running",
			updatedAt: new Date().toISOString(),
			summary: undefined,
		});
		// A run with runtime: "scaffold" + status: "running" IS active evidence
		// with the zombie-agent fix (hasDurableActiveAgentEvidence trusts running agents).
		// So this run SHOULD appear in the widget. Update the assertion to reflect
		// the correct new behavior: fixture scaffolding with a running agent is active.
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: "01",
				agent: "explorer",
				role: "explorer",
				runtime: "scaffold",
				status: "running",
				startedAt: old,
			},
		]);
		// Single-line widget: an active run surfaces as the running count
		// (the runId itself is browsed in the Agents & Jobs browser).
		lines = buildCrewWidgetLines(cwd, 0);
		assert.match(lines.join("\n"), /1 running/, `active run should count, got: ${lines.join(" / ")}`);
	} finally {
		await removeDirWithRetry(cwd);
		await removeDirWithRetry(tempHome);
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("crew widget keeps persistent component until placement changes and refreshes progress", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-persist-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = {
			name: "fast-fix",
			description: "",
			roles: [{ name: "explorer", agent: "explorer" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "fast-fix",
			description: "",
			steps: [{ id: "explore", role: "explorer" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "persistent widget",
		});
		saveRunManifest({ ...created.manifest, status: "running" }, { allowTerminalExit: true });
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: "01",
				agent: "explorer",
				role: "explorer",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
				progress: {
					recentTools: [],
					recentOutput: ["first output"],
					toolCount: 1,
					currentTool: "read",
					tokens: 10,
				},
			},
		]);
		const setWidgetCalls: Array<{
			key: string;
			content: unknown;
			placement?: string;
		}> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				setStatus: () => undefined,
				setWidget: (key: string, content: unknown, options?: { placement?: string }) =>
					setWidgetCalls.push({
						key,
						content,
						placement: options?.placement,
					}),
				requestRender: () => undefined,
			},
		} as never;
		const state: CrewWidgetState = { frame: 0 };
		updateCrewWidget(ctx, state, { widgetPlacement: "aboveEditor" });
		updateCrewWidget(ctx, state, { widgetPlacement: "aboveEditor" });
		assert.equal(setWidgetCalls.filter((call) => call.key === "pi-crew-active" && call.content).length, 1);
		const factory = setWidgetCalls.find((call) => call.key === "pi-crew-active" && call.content)?.content as (
			tui: unknown,
			theme: unknown,
		) => { render(width: number): string[]; invalidate(): void };
		const component = factory(undefined, {
			fg: (_color: string, value: string) => value,
			bold: (value: string) => value,
		});
		// Single-line dock: currentTool/read detail moved to the browser —
		// the persistent component now renders the canopy row.
		assert.match(component.render(100).join("\n"), /CREW ▸ /);
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: "01",
				agent: "explorer",
				role: "explorer",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
				progress: {
					recentTools: [],
					recentOutput: ["second output"],
					toolCount: 2,
					currentTool: "bash",
					tokens: 20,
				},
			},
		]);
		// C4: in production, the agent-data change fires a run:state /
		// worker:lifecycle event that clears the buildSignature cache via
		// onInvalidate. This unit test has no event bus wired, so simulate the
		// event-driven invalidation explicitly.
		component.invalidate();
		assert.match(component.render(100).join("\n"), /CREW ▸ /, "stable counts render after invalidate");
		updateCrewWidget(ctx, state, { widgetPlacement: "belowEditor" });
		assert.equal(setWidgetCalls.filter((call) => call.key === "pi-crew-active" && call.content).length, 2);
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("crew widget header spinner animates time-based across renders even when state.frame is fixed", async () => {
	clearLiveAgentsForTest();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-spin-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = {
			name: "fast-fix",
			description: "",
			roles: [{ name: "executor", agent: "executor" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "fast-fix",
			description: "",
			steps: [{ id: "fix", role: "executor" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "spin smoke",
		});
		saveRunManifest({ ...created.manifest, status: "running" }, { allowTerminalExit: true });
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: "01",
				agent: "executor",
				role: "executor",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
				progress: {
					recentTools: [],
					recentOutput: ["working"],
					toolCount: 1,
					currentTool: "bash",
				},
			},
		]);
		const setWidgetCalls: Array<{ key: string; content: unknown }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				setStatus: () => undefined,
				setWidget: (key: string, content: unknown) => setWidgetCalls.push({ key, content }),
				requestRender: () => undefined,
			},
		} as never;
		const state: CrewWidgetState = { frame: 7 };
		// The dock spinner rides the rail line unconditionally since the M4 RAIL
		// redesign (ui.widgetRowStyle was removed 2026-09-16); this test covers
		// the animated rail glyph itself.
		updateCrewWidget(ctx, state, { widgetPlacement: "aboveEditor" });
		const factory = setWidgetCalls.find((call) => call.key === "pi-crew-active" && call.content)?.content as (
			tui: unknown,
			theme: unknown,
		) => { render(width: number): string[] };
		const component = factory(undefined, {
			fg: (_color: string, value: string) => value,
			bold: (value: string) => value,
		});
		const first = component.render(100)[0] ?? "";
		// The spinner rides INSIDE the dock row, right after the `┃` rail
		// (`┃ <frame> CREW ▸ …`), so the rail glyph is never overwritten.
		const spinnerOf = (line: string): number => line.codePointAt(2) ?? 0;
		const firstGlyph = spinnerOf(first);
		// Wait > spinner frame interval; state.frame is unchanged but glyph should rotate.
		await new Promise((resolve) => setTimeout(resolve, 220));
		const second = component.render(100)[0] ?? "";
		const secondGlyph = spinnerOf(second);
		assert.equal(first.slice(0, 2), "┃ ", `the rail survives the spinner, got ${JSON.stringify(first)}`);
		assert.notEqual(firstGlyph, secondGlyph, "expected spinner glyph to advance with wall-clock time even when state.frame is stable");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("compact dock hint line never gets the legacy spinner-frame swap (pi-subtask hint is text)", async () => {
	clearLiveAgentsForTest();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-compact-hint-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = {
			name: "fast-fix",
			description: "",
			roles: [{ name: "executor", agent: "executor" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "fast-fix",
			description: "",
			steps: [{ id: "fix", role: "executor" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({ cwd, team, workflow, goal: "compact hint" });
		saveRunManifest({ ...created.manifest, status: "running" }, { allowTerminalExit: true });
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: "01",
				agent: "executor",
				role: "executor",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
				progress: { recentTools: [], recentOutput: ["working"], toolCount: 1, currentTool: "bash" },
			},
		]);
		const setWidgetCalls: Array<{ key: string; content: unknown }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				setStatus: () => undefined,
				setWidget: (key: string, content: unknown) => setWidgetCalls.push({ key, content }),
				requestRender: () => undefined,
			},
		} as never;
		const state: CrewWidgetState = { frame: 7 };
		updateCrewWidget(ctx, state, { widgetPlacement: "belowEditor" });
		const factory = setWidgetCalls.find((call) => call.key === "pi-crew-active" && call.content)?.content as (
			tui: unknown,
			theme: unknown,
		) => { render(width: number): string[] };
		const component = factory(undefined, {
			fg: (_color: string, value: string) => value,
			bold: (value: string) => value,
		});
		const lines = component.render(100);
		const hint = lines[0] ?? "";
		// Single-line dock: the spinner is part of the row BY DESIGN
		// ("┃ ⠸ CREW ▸ fast-fix · 1 running ···· ↓·enter"). The regression guard
		// stays: the spinner must never EAT the rail or the text after it (the old
		// component-level `line[0]` swap would have overwritten the `┃`).
		assert.ok(hint.startsWith("┃ "), `the rail survives, got ${JSON.stringify(hint)}`);
		assert.ok(hint.includes("CREW ▸ "), `counts text must stay intact, got ${JSON.stringify(hint)}`);
		assert.ok(hint.includes("···· ↓·enter"), `entry hint must stay intact, got ${JSON.stringify(hint)}`);
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("crew widget hides active async runs whose background process is stale", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-stale-async-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-stale-async-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = {
			name: "parallel-research",
			description: "",
			roles: [{ name: "explorer", agent: "explorer" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "parallel-research",
			description: "",
			steps: [{ id: "discover", role: "explorer" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "stale async",
		});
		const stalePid = 0;
		saveRunManifest({
			...created.manifest,
			status: "queued",
			async: {
				pid: stalePid,
				logPath: path.join(created.manifest.stateRoot, "background.log"),
				spawnedAt: new Date().toISOString(),
			},
		});
		const lines = buildCrewWidgetLines(cwd, 0);
		assert.equal(lines.join("\n"), "");
	} finally {
		await removeDirWithRetry(cwd);
		await removeDirWithRetry(home);
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("C4: widget signature cache invalidates on write so genuine state changes trigger re-render", async () => {
	clearLiveAgentsForTest();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-c4-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = {
			name: "fast-fix",
			description: "",
			roles: [{ name: "executor", agent: "executor" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "fast-fix",
			description: "",
			steps: [{ id: "fix", role: "executor" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({ cwd, team, workflow, goal: "c4 cache test" });
		saveRunManifest({ ...created.manifest, status: "running" }, { allowTerminalExit: true });
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: "01",
				agent: "executor",
				role: "executor",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
				progress: {
					recentTools: [],
					recentOutput: ["first"],
					toolCount: 1,
					currentTool: "read",
					tokens: 10,
				},
			},
		]);
		const setWidgetCalls: Array<{ key: string; content: unknown }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				setStatus: () => undefined,
				setWidget: (key: string, content: unknown) => setWidgetCalls.push({ key, content }),
				requestRender: () => undefined,
			},
		} as never;
		const state: CrewWidgetState = { frame: 0 };
		updateCrewWidget(ctx, state, { widgetPlacement: "aboveEditor" });
		const factory = setWidgetCalls.find((call) => call.key === "pi-crew-active" && call.content)?.content as (
			tui: unknown,
			theme: unknown,
		) => { render(width: number): string[]; invalidate(): void };
		const component = factory(undefined, {
			fg: (_color: string, value: string) => value,
			bold: (value: string) => value,
		});

		// First render — builds and caches the signature. (Single-line dock: the
		// tool detail this test used to pin moved to the browser; the
		// cache-invalidation contract below is what still matters.)
		const firstRender = component.render(100).join("\n");
		assert.match(firstRender, /CREW ▸ /, "first render should show the canopy row");

		// Change agent data on disk (simulates a genuine state change).
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: "01",
				agent: "executor",
				role: "executor",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
				progress: {
					recentTools: [],
					recentOutput: ["second"],
					toolCount: 2,
					currentTool: "bash",
					tokens: 20,
				},
			},
		]);

		// C4 invalidate-on-write: in production, the run:state /
		// worker:lifecycle event fires onInvalidate which clears the cached
		// buildSignature. This unit test has no event bus, so simulate it.
		component.invalidate();

		// After invalidation, the next render must still resolve state cleanly
		// (the observable surface is the counts line; tool detail lives in the
		// Agents & Jobs browser now, so "differs" is no longer assertable).
		const secondRender = component.render(100).join("\n");
		assert.match(secondRender, /CREW ▸ /, "re-render after invalidation stays healthy");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

/* Wave 16 (residual render wiring): activeWidgetRuns keeps a frozen-manifest
 * run visible while its task heartbeats stay fresh — WITHOUT a disk read on
 * the render tick (the guard reads only item.snapshot?.tasks). */
test("wave 16: widget keeps frozen-manifest run visible while task heartbeats are fresh", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-hb-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-hb-home-"));
	process.env.PI_TEAMS_HOME = tempHome;
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = {
			name: "hb-fix",
			description: "",
			roles: [{ name: "explorer", agent: "explorer" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "hb-fix",
			description: "",
			steps: [{ id: "explore", role: "explorer" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({ cwd, team, workflow, goal: "frozen manifest fresh heartbeat" });
		// Manifest froze 3 minutes ago (past the 2min orphan threshold); the agent
		// record is a frozen queued worker — isDisplayActiveRun alone says hidden.
		const frozenAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
		const manifest: TeamRunManifest = { ...created.manifest, status: "running", updatedAt: frozenAt };
		saveRunManifest(manifest);
		const heartbeatTasks: TeamTaskState[] = [
			{
				...created.tasks[0]!,
				status: "running",
				startedAt: frozenAt,
				heartbeat: { workerId: "worker-1", lastSeenAt: new Date().toISOString() },
			},
		];
		saveRunTasks(manifest, heartbeatTasks);
		saveCrewAgents(created.manifest, [
			{
				id: `${manifest.runId}:01`,
				runId: manifest.runId,
				taskId: created.tasks[0]!.id,
				agent: "explorer",
				role: "explorer",
				runtime: "child-process",
				status: "queued",
				startedAt: frozenAt,
			},
		]);

		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		cache.refresh(manifest.runId);
		const snapshot = cache.get(manifest.runId);
		assert.ok(snapshot, "precondition: snapshot cached");
		assert.ok(
			snapshot?.tasks.some((task) => task.heartbeat?.lastSeenAt),
			"precondition: snapshot carries the heartbeat task",
		);

		const runs = activeWidgetRuns(cwd, undefined, cache, [manifest], undefined);
		assert.equal(runs.length, 1, `fresh-heartbeat frozen-manifest run must stay visible, got ${runs.length}`);
		assert.equal(runs[0]?.run.runId, manifest.runId);
	} finally {
		await removeDirWithRetry(cwd);
		await removeDirWithRetry(tempHome);
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});
