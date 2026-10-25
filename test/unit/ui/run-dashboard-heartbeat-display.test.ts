/**
 * Wave 15 (F2, GAP-0) — render-layer heartbeat tests (h2).
 *
 * Root cause (wave 15 SPEC §1): the dashboard's display predicates trust only
 * manifest `updatedAt` + agent `progress.lastActivityAt`, both of which freeze
 * at tool start (event-driven writes). A healthy direct run mid-long-tool kept
 * stamping `task.heartbeat.lastSeenAt` (wave 13) but the RENDER layer never
 * consulted it — the run showed "stale" and dropped from "Active" ~5 min in.
 *
 * These tests pin BOTH sides of the OR-branch:
 *   - heartbeat case: stale manifest + running agent + FRESH task heartbeat ⇒
 *     row status `running` (not `stale`), run grouped under "Active";
 *   - control (old behavior pinned): same fixture WITHOUT a fresh heartbeat ⇒
 *     status `stale`, run grouped under "Recent".
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { saveCrewAgents } from "../../../src/runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../../../src/runtime/crew-agent-runtime.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import { RunDashboard } from "../../../src/ui/run-dashboard.ts";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

interface FixtureOptions {
	/** Fresh task heartbeat stamp (ms before "now") — omit for the stale control. */
	heartbeatAgeMs?: number;
}

function makeStaleManifestRun(cwd: string, goal: string, options: FixtureOptions): TeamRunManifest {
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
	const created = createRunManifest({ cwd, team, workflow, goal });
	const now = Date.now();
	// Manifest frozen >2 min (isLikelyOrphanedActiveRun ladder) but well inside
	// the 30-min hard ghost filter — the exact false-stale window.
	const updatedAt = new Date(now - 3 * 60 * 1000).toISOString();
	const manifest: TeamRunManifest = { ...created.manifest, status: "running", updatedAt };
	saveRunManifest(manifest, { allowTerminalExit: true });
	// saveRunManifest may stamp its own updatedAt — rewrite the on-disk manifest
	// so disk readers (listRecentRuns parity, h3) see the same frozen stamp.
	fs.writeFileSync(path.join(manifest.stateRoot, "manifest.json"), JSON.stringify(manifest, null, "\t"), "utf-8");

	const task: TeamTaskState = {
		...created.tasks[0],
		status: "running",
		startedAt: new Date(now - 10 * 60 * 1000).toISOString(),
		...(options.heartbeatAgeMs !== undefined
			? { heartbeat: { workerId: "w1", lastSeenAt: new Date(now - options.heartbeatAgeMs).toISOString(), alive: true } }
			: {}),
	};
	saveRunTasks(manifest, [task]);

	// One RUNNING agent with NO recent activity evidence (progress without
	// lastActivityAt) — the pre-wave-15 blind spot: agent evidence frozen at
	// tool start, so only the task heartbeat can carry liveness.
	const agentRecord: CrewAgentRecord = {
		id: `${manifest.runId}:01`,
		runId: manifest.runId,
		taskId: created.tasks[0]?.id ?? "explore",
		agent: "explorer",
		role: "explorer",
		runtime: "child-process",
		status: "running",
		startedAt: manifest.createdAt,
		progress: { recentTools: [], recentOutput: ["working"], toolCount: 1, currentTool: "read", tokens: 10 },
	};
	saveCrewAgents(manifest, [agentRecord]);
	return manifest;
}

function tempCwd(prefix: string): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

test("h2: stale manifest + fresh task heartbeat renders running and stays in Active", () => {
	const cwd = tempCwd("pi-crew-w15-h2-live-");
	try {
		const manifest = makeStaleManifestRun(cwd, "w15-h2-heartbeat", { heartbeatAgeMs: 30_000 });
		const dashboard = new RunDashboard([manifest], () => undefined);
		try {
			const lines = dashboard.render(100).map(strip);
			const runIdSuffix = manifest.runId.slice(-8);
			const rowLine = lines.find((l) => l.includes(runIdSuffix));
			assert.ok(rowLine, "run row rendered");
			assert.ok(rowLine.includes("running"), `status token is running, got: ${rowLine}`);
			assert.ok(!rowLine.includes("stale"), "no stale label despite frozen manifest");
			assert.ok(
				lines.some((l) => /active/i.test(l)),
				"run grouped under Active",
			);
			assert.ok(!lines.some((l) => /recent/i.test(l)), "no Recent group for the only (live) run");
		} finally {
			dashboard.dispose();
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("h2: same snapshot WITHOUT a fresh heartbeat stays stale (old behavior pinned)", () => {
	const cwd = tempCwd("pi-crew-w15-h2-stale-");
	try {
		const manifest = makeStaleManifestRun(cwd, "w15-h2-control", {});
		const dashboard = new RunDashboard([manifest], () => undefined);
		try {
			const lines = dashboard.render(100).map(strip);
			const runIdSuffix = manifest.runId.slice(-8);
			const rowLine = lines.find((l) => l.includes(runIdSuffix));
			assert.ok(rowLine, "run row rendered");
			assert.ok(rowLine.includes("stale"), `status token is stale, got: ${rowLine}`);
			assert.ok(
				lines.some((l) => /recent/i.test(l)),
				"run grouped under Recent",
			);
			assert.ok(!lines.some((l) => /active/i.test(l)), "no Active group without evidence");
		} finally {
			dashboard.dispose();
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("h2: heartbeat older than the 5-min evidence TTL does NOT veto the stale label", () => {
	const cwd = tempCwd("pi-crew-w15-h2-ttl-");
	try {
		const manifest = makeStaleManifestRun(cwd, "w15-h2-ttl", { heartbeatAgeMs: 6 * 60 * 1000 });
		const dashboard = new RunDashboard([manifest], () => undefined);
		try {
			const lines = dashboard.render(100).map(strip);
			const runIdSuffix = manifest.runId.slice(-8);
			const rowLine = lines.find((l) => l.includes(runIdSuffix));
			assert.ok(rowLine, "run row rendered");
			assert.ok(rowLine.includes("stale"), "expired heartbeat keeps the stale verdict");
		} finally {
			dashboard.dispose();
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("h2: heartbeat.alive === false is not evidence (explicit dead mark)", () => {
	const cwd = tempCwd("pi-crew-w15-h2-dead-");
	try {
		const manifest = makeStaleManifestRun(cwd, "w15-h2-dead", {});
		// Rewrite tasks.json with a FRESH but dead-marked heartbeat.
		const now = Date.now();
		const tasksPath = manifest.tasksPath;
		const tasks = JSON.parse(fs.readFileSync(tasksPath, "utf-8")) as TeamTaskState[];
		tasks[0].heartbeat = { workerId: "w1", lastSeenAt: new Date(now - 10_000).toISOString(), alive: false };
		fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, "\t"), "utf-8");
		const dashboard = new RunDashboard([manifest], () => undefined);
		try {
			const lines = dashboard.render(100).map(strip);
			const rowLine = lines.find((l) => l.includes(manifest.runId.slice(-8)));
			assert.ok(rowLine, "run row rendered");
			assert.ok(rowLine.includes("stale"), "alive:false heartbeat does not veto the stale label");
		} finally {
			dashboard.dispose();
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
