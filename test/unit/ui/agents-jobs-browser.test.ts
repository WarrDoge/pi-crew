import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ScheduledJob } from "../../../src/runtime/scheduling/scheduler.ts";
import { loadRunManifestById } from "../../../src/state/stores/state-store.ts";
import { type AgentsBrowserAgentEntry, AgentsJobsBrowser } from "../../../src/ui/agents-jobs-browser.ts";
import { visibleWidth } from "../../../src/utils/visual.ts";

// CI 3-OS parity (2026-10-16, 0.11.22 matrix): the product canonicalizes cwd
// with realpathSync.NATIVE (paths.ts canonicalizePath) — plain realpathSync
// keeps macOS symlinked $TMPDIR (/var → /private/var) UNRESOLVED is fine, but
// on Windows it preserves 8.3 short names (RUNNER~1) that .native expands, so
// manifest.stateRoot identity checks mismatch and runs read as "not found".
// Canonicalize fixtures with the SAME primitive the product uses.
const nativeRealpath = (p: string): string => {
	try {
		return realpathSync.native(p);
	} catch {
		try {
			return realpathSync(p);
		} catch {
			return p;
		}
	}
};
const mkFixtureDir = (prefix: string): string => nativeRealpath(mkdtempSync(join(tmpdir(), prefix)));

// ─── Fixtures ──────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 8, 14, 4, 0, 0);

function agent(partial: Partial<AgentsBrowserAgentEntry>): AgentsBrowserAgentEntry {
	return {
		kind: "agent",
		runId: "run-x",
		taskId: "task-x",
		role: "Explorer",
		status: "completed",
		// Completed agents carry the transcript on the durable record; `p`
		// watchers it. (Running agents resolve via record.statusPath instead.)
		record: {
			taskId: "task-x",
			agent: "explorer",
			role: "Explorer",
			status: "completed",
			transcriptPath: "/tmp/crew-test/transcript.jsonl",
		} as never,
		...partial,
	};
}

function job(partial: Partial<ScheduledJob> = {}): ScheduledJob {
	return {
		id: "job-1",
		name: "watch: omo",
		description: "watch-loop",
		schedule: "0 */2 * * *",
		scheduleType: "cron",
		subagentType: "team",
		prompt: "{}",
		enabled: true,
		createdAt: new Date(NOW - 86_400_000).toISOString(),
		runCount: 0,
		nextRun: new Date(NOW + 3_600_000).toISOString(),
		...partial,
	};
}

let tmpCwd: string;

beforeEach(() => {
	tmpCwd = mkFixtureDir("agents-browser-");
});

afterEach(() => {
	rmSync(tmpCwd, { recursive: true, force: true });
});

function makeBrowser(overrides: {
	agents?: AgentsBrowserAgentEntry[];
	jobs?: ScheduledJob[];
	hiddenCount?: number;
	surfaceReachable?: boolean;
}) {
	return new AgentsJobsBrowser({
		cwd: tmpCwd,
		now: () => NOW,
		refreshTtlMs: 0,
		agentsProvider: () => overrides.agents ?? [],
		jobsProvider: () => ({ jobs: overrides.jobs ?? [], hiddenCount: overrides.hiddenCount ?? 0 }),
		surfaceReachable: overrides.surfaceReachable ?? false,
		surfaceAgent: async () => true,
	});
}

// ─── List merging & ordering ───────────────────────────────────────────────

test("merges agents before jobs, running agents first", () => {
	const browser = makeBrowser({
		agents: [
			agent({ taskId: "done-1", role: "Writer", status: "completed" }),
			agent({ taskId: "run-1", role: "Explorer", status: "running", tokPerSec: 41 }),
		],
		jobs: [job()],
	});
	browser.dispose();

	const entries = browser.entriesView;
	assert.equal(entries.length, 3);
	assert.equal(entries[0].kind, "agent");
	assert.equal(entries[0].kind === "agent" ? entries[0].taskId : "?", "run-1", "running agent sorts first");
	assert.equal(entries[1].kind === "agent" ? entries[1].taskId : "?", "done-1");
	assert.equal(entries[2].kind, "job");
	assert.equal(browser.selectedIndex, 0);
});

test("empty providers render a placeholder list without crashing", () => {
	const browser = makeBrowser({});
	browser.dispose();

	assert.equal(browser.entriesView.length, 0);
	const lines = browser.render(100);
	assert.ok(lines.length > 0, "renders a placeholder");
});

test("selection clamps when the list shrinks", () => {
	let agents: AgentsBrowserAgentEntry[] = [agent({ taskId: "a" }), agent({ taskId: "b" }), agent({ taskId: "c" })];
	const browser = new AgentsJobsBrowser({
		cwd: tmpCwd,
		now: () => NOW,
		refreshTtlMs: 0,
		agentsProvider: () => agents,
		jobsProvider: () => ({ jobs: [], hiddenCount: 0 }),
		surfaceReachable: false,
	});
	browser.handleInput("j");
	browser.handleInput("j");
	assert.equal(browser.selectedIndex, 2);
	agents = [agents[0]];
	browser.refreshData(true);
	browser.dispose();
	assert.equal(browser.selectedIndex, 0, "clamped to last available entry");
});

// ─── Detail rendering ──────────────────────────────────────────────────────

test("job detail reuses schedule details and appends enabled + hidden lines", () => {
	const browser = makeBrowser({ jobs: [job()], hiddenCount: 2 });
	browser.dispose();

	const lines = browser.detailLinesFor(browser.entriesView[0]);
	const text = lines.join("\n");
	assert.match(text, /watch: omo/, "job name present");
	assert.match(text, /enabled: ● on/, "enabled line appended");
	assert.match(text, /hidden project-tier jobs: 2/, "hidden-tier count appended");
});

test("agent detail without a durable record falls back to a stub, never throws", () => {
	const browser = makeBrowser({ agents: [agent({ taskId: "ghost", role: "Verifier", status: "failed" })] });
	browser.dispose();

	const lines = browser.detailLinesFor(browser.entriesView[0]);
	assert.match(lines.join("\n"), /agent record unavailable/);
});

// ─── R5-3: manifest cache invalidation (DR-02 wave 2) ─────────────────────

/** Write a minimal but state-store-loadable run fixture: manifest.json +
 *  agents.json under `.crew/state/runs/<runId>/`. */
function writeRunFixture(dir: string, runId: string): { stateRoot: string; iso: string } {
	const stateRoot = join(dir, ".crew", "state", "runs", runId);
	mkdirSync(stateRoot, { recursive: true });
	const iso = new Date().toISOString();
	writeFileSync(
		join(stateRoot, "manifest.json"),
		JSON.stringify({
			schemaVersion: 1,
			runId,
			sessionId: `sess-${runId}`,
			team: "direct-explorer",
			workflow: "direct-agent",
			goal: "R5-3 fixture",
			status: "completed",
			workspaceMode: "single",
			createdAt: iso,
			updatedAt: iso,
			cwd: dir,
			stateRoot,
			artifactsRoot: join(dir, ".crew", "artifacts", runId),
			tasksPath: join(stateRoot, "tasks.json"),
			eventsPath: join(stateRoot, "events.jsonl"),
			artifacts: [],
		}),
	);
	writeFileSync(
		join(stateRoot, "agents.json"),
		JSON.stringify([
			{
				id: `${runId}:01_01-agent`,
				runId,
				taskId: "01_01-agent",
				agent: "explorer",
				role: "Explorer",
				runtime: "child-process",
				status: "completed",
				startedAt: iso,
				completedAt: iso,
			},
		]),
	);
	return { stateRoot, iso };
}

function bareAgentEntry(runId: string): AgentsBrowserAgentEntry {
	// No record, no manifest — detailLinesFor must resolve BOTH from disk.
	return { kind: "agent", runId, taskId: "01_01-agent", role: "Explorer", status: "completed" };
}

test("R5-3: a manifest miss is not durably cached — a manifest created later is visible without force", () => {
	// Pre-fix: the first miss cached null forever, so a manifest written while
	// the overlay was open NEVER became visible (loadRunManifestById races
	// writes lock-free; a transient read failure pinned the miss for life).
	// NOTE: `.crew` is a project-root marker (project-markers.ts) — create it
	// BEFORE the first manifest lookup or findRepoRoot caches the negative and
	// the run state root never resolves to this fixture dir.
	const dir = mkFixtureDir("crew-browser-manifest-late-");
	mkdirSync(join(dir, ".crew"), { recursive: true });
	try {
		const runId = "team_test_manifest_late";
		const browser = new AgentsJobsBrowser({
			cwd: dir,
			now: () => NOW,
			refreshTtlMs: 0,
			agentsProvider: () => [bareAgentEntry(runId)],
			jobsProvider: () => ({ jobs: [], hiddenCount: 0 }),
		});
		const entry = browser.entriesView[0];
		assert.ok(entry && entry.kind === "agent");
		if (entry?.kind !== "agent") return;

		assert.match(
			browser.detailLinesFor(entry).join("\n"),
			/agent record unavailable/,
			"miss before the manifest exists renders the stub",
		);

		writeRunFixture(dir, runId);
		const after = browser.detailLinesFor(entry).join("\n");
		assert.ok(!after.includes("agent record unavailable"), `the miss must not be pinned, got: ${after}`);
		assert.match(after, /01_01-agent/, "detail renders from the just-written manifest (no force refresh)");
		browser.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("R5-3: refreshData(true) invalidates cached manifests — a deleted manifest.json stops serving after force", () => {
	// Isolation trick: the RECORD (agents.json) is re-read every call, so only
	// the manifest layer can explain a difference. Delete manifest.json but
	// KEEP agents.json — while the manifest is cached, detail still renders
	// (readCrewAgents reads agents.json through the cached manifest's paths);
	// after force the cache clears and loadRunManifestById cannot resolve the
	// run anymore → stub. Pre-fix: the manifest was cached forever, so a run
	// whose manifest.json was gone kept rendering with no way to notice.
	const dir = mkFixtureDir("crew-browser-manifest-force-");
	mkdirSync(join(dir, ".crew"), { recursive: true });
	try {
		const runId = "team_test_manifest_force";
		const { stateRoot } = writeRunFixture(dir, runId);
		const browser = new AgentsJobsBrowser({
			cwd: dir,
			now: () => NOW,
			refreshTtlMs: 0,
			agentsProvider: () => [bareAgentEntry(runId)],
			jobsProvider: () => ({ jobs: [], hiddenCount: 0 }),
		});
		const entry = browser.entriesView[0];
		assert.ok(entry && entry.kind === "agent");
		if (entry?.kind !== "agent") return;

		const loaded = browser.detailLinesFor(entry).join("\n");
		assert.ok(!loaded.includes("agent record unavailable") && loaded.includes("01_01-agent"), `v1 renders, got: ${loaded}`);

		// manifest.json disappears (state trimmed / crash debris). agents.json
		// stays so the record read itself would still work.
		rmSync(join(stateRoot, "manifest.json"), { force: true });

		const stillCached = browser.detailLinesFor(entry).join("\n");
		assert.ok(
			!stillCached.includes("agent record unavailable") && stillCached.includes("01_01-agent"),
			`cache hit without force keeps serving the cached manifest, got: ${stillCached}`,
		);

		// Force refresh clears the manifest cache → resolution fails → stub.
		browser.refreshData(true);
		assert.match(
			browser.detailLinesFor(entry).join("\n"),
			/agent record unavailable/,
			"force refresh drops the stale manifest (pre-fix: cached forever)",
		);
		browser.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("R5-3: detailLinesFor prefers the fresh entry.manifest over a disk re-read", () => {
	const dir = mkFixtureDir("crew-browser-manifest-entry-");
	try {
		const runId = "team_test_manifest_entry";
		const { iso } = writeRunFixture(dir, runId);
		const loaded = loadRunManifestById(dir, runId);
		assert.ok(loaded, "fixture manifest loads through state-store");
		const browser = new AgentsJobsBrowser({
			cwd: dir,
			now: () => NOW,
			refreshTtlMs: 0,
			agentsProvider: () => [
				{
					kind: "agent",
					// entry.runId has NO manifest on disk — only entry.manifest can
					// satisfy the detail render (pre-fix: manifestFor miss → stub).
					runId: "run_missing_nowhere",
					taskId: "01_01-agent",
					role: "Explorer",
					status: "completed",
					manifest: loaded.manifest,
					record: {
						taskId: "01_01-agent",
						runId: "run_missing_nowhere",
						agent: "explorer",
						role: "Explorer",
						runtime: "child-process",
						status: "completed",
						startedAt: iso,
						completedAt: iso,
					} as never,
				},
			],
			jobsProvider: () => ({ jobs: [], hiddenCount: 0 }),
		});
		const entry = browser.entriesView[0];
		assert.ok(entry && entry.kind === "agent");
		if (entry?.kind !== "agent") return;
		const lines = browser.detailLinesFor(entry).join("\n");
		assert.ok(!lines.includes("agent record unavailable"), `entry.manifest must win, got: ${lines}`);
		assert.match(lines, /01_01-agent/);
		browser.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─── Keyboard navigation ───────────────────────────────────────────────────

test("j/k and arrows move selection with bounds; Enter focuses detail; Esc returns", () => {
	const browser = makeBrowser({
		agents: [agent({ taskId: "a" }), agent({ taskId: "b", status: "running" }), agent({ taskId: "c" })],
		jobs: [job()],
	});

	browser.handleInput("j");
	assert.equal(browser.selectedIndex, 1);
	browser.handleInput("\x1b[B"); // down arrow
	assert.equal(browser.selectedIndex, 2);
	browser.handleInput("\x1b[B");
	assert.equal(browser.selectedIndex, 3, "lands on the job row");
	browser.handleInput("\x1b[B");
	assert.equal(browser.selectedIndex, 3, "clamped at the end");
	browser.handleInput("k");
	assert.equal(browser.selectedIndex, 2);

	assert.equal(browser.focusMode, "list");
	browser.handleInput("\r");
	assert.equal(browser.focusMode, "detail", "Enter opens detail");
	browser.handleInput("j");
	browser.handleInput("\x1b");
	assert.equal(browser.focusMode, "list", "Esc backs out of detail");
	browser.dispose();
});

test("q or raw ESC closes the browser from list focus", () => {
	const browser = makeBrowser({ agents: [agent({ taskId: "a" })] });
	assert.equal(browser.isClosed, false);
	browser.handleInput("q");
	assert.equal(browser.isClosed, true);
	browser.dispose();
});

test("[p] is disabled (retired watcher pane) — a no-op on every surface state", () => {
	// DISABLED (2026-09-14, user): p's transcript-watcher pane did not meet the
	// "live pi session" spec — live sessions now come from runtime.surface
	// (workers boot as real pi TUIs in their own panes). p must do NOTHING:
	// no pane spawn, no notice, focus unchanged.
	for (const surfaceReachable of [false, true]) {
		const spawned: string[] = [];
		const browser = new AgentsJobsBrowser({
			cwd: tmpdir(),
			now: () => NOW,
			refreshTtlMs: 0,
			surfaceReachable,
			surfaceAgent: async (entry) => {
				spawned.push(entry.taskId);
				return true;
			},
			agentsProvider: () => [agent({ taskId: "a", status: "running" })],
			jobsProvider: () => ({ jobs: [], hiddenCount: 0 }),
		});
		browser.handleInput("p");
		assert.deepEqual(spawned, [], "no pane spawned");
		assert.equal(browser.focusMode, "list", "focus untouched");
		assert.doesNotMatch(browser.render(100)[0] ?? "", /no tmux\/herdr/, "no notice fired");
		browser.dispose();
	}
});

// ─── Width discipline ──────────────────────────────────────────────────────

test("render lines never exceed the terminal width (80 and 200 cols)", () => {
	const browser = makeBrowser({
		agents: [
			agent({
				taskId: "very-long-task-id-that-must-truncate-0123456789",
				role: "Security-Reviewer",
				status: "running",
				tokPerSec: 1234,
			}),
			agent({ taskId: "b", role: "Writer", status: "waiting" }),
		],
		jobs: [job({ name: "extremely-long-job-name-that-will-need-truncating-in-the-list-column-0123456789" })],
	});
	for (const width of [80, 200]) {
		const lines = browser.render(width);
		assert.ok(lines.length > 0, `renders at ${width}`);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: visibleWidth=${visibleWidth(line)}: ${JSON.stringify(line)}`);
		}
	}
	const wide = browser.render(200).join("\n");
	assert.match(wide, /┏ AGENTS ▸ 2 agents · 1 job/, "canopy carries counts");
	browser.dispose();
});

// ─── Headless no-op ────────────────────────────────────────────────────────

test("openAgentsJobsBrowser is a no-op returning false without UI", async () => {
	const { openAgentsJobsBrowser } = await import("../../../src/extension/registration/viewers.ts");
	const result = await openAgentsJobsBrowser({ hasUI: false } as never);
	assert.equal(result, false);
});

// ─── Freeze regression (2026-09-14): kitty/enhanced keyboard protocol ───
// Live bug: terminals delivering keys as kitty CSI-u sequences (Escape =
// "\x1b[27u", letters as "\x1b[<code>u") left the browser permanently
// stuck — raw byte comparisons matched NOTHING, so no key worked and the
// overlay could not close. matchesKey normalizes all encodings.
test("kitty-protocol key sequences navigate and close (freeze regression)", () => {
	const browser = makeBrowser({
		agents: [agent({ taskId: "a", status: "running" }), agent({ taskId: "b", status: "completed" })],
		jobs: [job()],
	});
	// down as kitty CSI-u (j = 106): moves selection
	browser.handleInput("\x1b[106u");
	assert.equal(browser.selectedIndex, 1, "kitty j moves down");
	// up (k = 107)
	browser.handleInput("\x1b[107u");
	assert.equal(browser.selectedIndex, 0, "kitty k moves up");
	// enter as kitty CSI-u (return = 13)
	browser.handleInput("\x1b[13u");
	assert.equal(browser.focusMode, "detail", "kitty enter opens detail");
	browser.handleInput("\x1b[27u");
	assert.equal(browser.focusMode, "list", "kitty escape backs out");
	// q as kitty CSI-u (113) closes
	browser.handleInput("\x1b[113u");
	assert.equal(browser.isClosed, true, "kitty q closes the browser");
	browser.dispose();
});

test("default agents source mirrors the widget pipeline (state/runs agents.json)", () => {
	// Regression (live probe 2026-09-14): Agent-tool subagents (foreground AND
	// background) run as child processes and never registerLiveAgent() in the
	// extension process — the old default (in-process live-agent registry) listed
	// NOTHING while the widget said "1 running". The browser must read the same
	// `.crew/state/runs/*/agents.json` pipeline the widget counts use.
	const dir = mkFixtureDir("crew-browser-default-");
	try {
		const runId = "team_test_browser_default";
		const stateRoot = join(dir, ".crew", "state", "runs", runId);
		mkdirSync(stateRoot, { recursive: true });
		const now = new Date();
		const iso = now.toISOString();
		writeFileSync(
			join(stateRoot, "manifest.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId,
				sessionId: "sess-test",
				team: "direct-explorer",
				workflow: "direct-agent",
				goal: "live probe fixture",
				status: "running",
				createdAt: iso,
				updatedAt: iso,
				stateRoot,
			}),
		);
		writeFileSync(
			join(stateRoot, "agents.json"),
			JSON.stringify([
				{
					id: `${runId}:01_01-agent`,
					runId,
					taskId: "01_01-agent",
					agent: "explorer",
					role: "Explorer",
					runtime: "child-process",
					status: "running",
					startedAt: iso,
				},
			]),
		);
		const browser = new AgentsJobsBrowser({
			cwd: dir,
			now: () => now.getTime() + 5000,
			refreshTtlMs: 0,
		});
		const agents = browser.entriesView.filter((e) => e.kind === "agent");
		// NOTE (2026-09-14): listRecentRuns merges USER-scope runs too, so a
		// live workspace may contribute extra agents — assert the FIXTURE agent
		// is present (the regression guard: Agent-tool runs were invisible).
		const fixtureAgent = agents.find((e) => e.kind === "agent" && e.taskId === "01_01-agent");
		assert.ok(fixtureAgent, `fixture agent missing (got ${agents.length} agents)`);
		if (fixtureAgent?.kind === "agent") {
			assert.equal(fixtureAgent.role, "Explorer");
			assert.equal(fixtureAgent.status, "running");
		}
		const text = browser.render(120).join("\n");
		assert.match(text, /Live agents \(\d+\)/);
		assert.match(text, /Explorer/);
		browser.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Enter on an agent fires onOpenTranscript seam; job still focuses inline detail", () => {
	const opened: Array<{ runId: string; taskId: string }> = [];
	const browser = new AgentsJobsBrowser({
		cwd: tmpdir(),
		now: () => Date.UTC(2026, 8, 14, 12),
		refreshTtlMs: 0,
		agentsProvider: () => [{ kind: "agent", runId: "r1", taskId: "t1", role: "Explorer", status: "running" }],
		jobsProvider: () => ({
			jobs: [job()],
			hiddenCount: 0,
		}),
		onOpenTranscript: (entry) => opened.push(entry),
	});
	browser.handleInput("\r");
	assert.deepEqual(opened, [{ runId: "r1", taskId: "t1" }], "Enter opens the transcript overlay via the seam");
	assert.equal(browser.focusMode, "list", "focus stays on list — the overlay owns the detail now");

	// Move down to the job row (agents sort before jobs) and Enter → inline detail.
	opened.length = 0;
	browser.handleInput("j");
	browser.handleInput("\r");
	assert.equal(opened.length, 0, "jobs do not use the transcript seam");
	assert.equal(browser.focusMode, "detail", "job Enter focuses the inline detail column");
	browser.dispose();
});

test("transcriptPathFor falls back to status.json while the agent is RUNNING", () => {
	// Live bug (2026-09-14): agents.json records for running agents carry
	// transcriptPath=null; the live path only exists in the per-agent
	// status.json (record.statusPath). Without the fallback, `p` died
	// silently on every running agent.
	const dir = mkFixtureDir("crew-browser-status-");
	try {
		const transcriptPath = join(dir, "transcripts", "01_01-agent.attempt-0.jsonl");
		mkdirSync(join(dir, "transcripts"), { recursive: true });
		writeFileSync(transcriptPath, "");
		const statusPath = join(dir, "status.json");
		writeFileSync(statusPath, JSON.stringify({ transcriptPath }));
		const browser = new AgentsJobsBrowser({
			cwd: dir,
			now: () => Date.UTC(2026, 8, 14, 12),
			refreshTtlMs: 0,
			agentsProvider: () => [
				{
					kind: "agent",
					runId: "r1",
					taskId: "t1",
					role: "Explorer",
					status: "running",
					record: {
						taskId: "t1",
						agent: "explorer",
						role: "Explorer",
						status: "running",
						statusPath,
						transcriptPath: undefined,
					} as never,
				},
			],
			jobsProvider: () => ({ jobs: [], hiddenCount: 0 }),
		});
		const entry = browser.entriesView[0];
		assert.ok(entry && entry.kind === "agent");
		if (entry.kind === "agent") {
			assert.equal(browser.transcriptPathFor(entry), transcriptPath, "running agent resolves via status.json");
		}
		browser.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("transcriptPathFor tier 3: running agent resolves via artifacts convention", () => {
	// Live probe round 6 (2026-09-14): while RUNNING, neither agents.json nor
	// status.json carries transcriptPath — but the transcript FILE exists from
	// the first turn at <artifactsRoot>/transcripts/<taskId>.attempt-N.jsonl.
	const dir = mkFixtureDir("crew-browser-tier3-");
	try {
		const runId = "team_test_tier3";
		const stateRoot = join(dir, ".crew", "state", "runs", runId);
		mkdirSync(stateRoot, { recursive: true });
		const artifactsRoot = join(dir, ".crew", "artifacts", runId);
		const transcriptsDir = join(artifactsRoot, "transcripts");
		mkdirSync(transcriptsDir, { recursive: true });
		writeFileSync(join(transcriptsDir, "01_01-agent.attempt-0.jsonl"), "{}\n");
		const iso = new Date().toISOString();
		writeFileSync(
			join(stateRoot, "manifest.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId,
				sessionId: "sess-tier3",
				team: "direct-explorer",
				workflow: "direct-agent",
				goal: "tier3 fixture",
				status: "running",
				createdAt: iso,
				updatedAt: iso,
				stateRoot,
				artifactsRoot,
			}),
		);
		writeFileSync(
			join(stateRoot, "agents.json"),
			JSON.stringify([
				{
					id: `${runId}:01_01-agent`,
					runId,
					taskId: "01_01-agent",
					agent: "explorer",
					role: "agent",
					runtime: "child-process",
					status: "running",
					startedAt: iso,
					// No transcriptPath, no statusPath — exactly the live shape.
				},
			]),
		);
		const browser = new AgentsJobsBrowser({ cwd: dir, now: () => Date.parse(iso) + 5000, refreshTtlMs: 0 });
		const entry = browser.entriesView[0];
		assert.ok(entry && entry.kind === "agent", "fixture agent visible");
		if (entry?.kind === "agent") {
			const resolved = browser.transcriptPathFor(entry);
			assert.equal(
				resolved,
				join(artifactsRoot, "transcripts", "01_01-agent.attempt-0.jsonl"),
				"tier 3 resolves the convention path for a running agent",
			);
		}
		browser.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
