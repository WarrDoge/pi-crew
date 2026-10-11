/**
 * b15 — Δ3 microbench: broker/scheduler task-array scan cost (10 / 100 / 1k tasks).
 *
 * QUESTION (bench-first rule — NO optimization in this task, measurement only):
 *   The scheduler loop and the crew-broker hot paths iterate the FULL task
 *   array on every pass: `taskGraphSnapshot()` runs 6 `.filter` passes after a
 *   `.map` refresh (src/runtime/scheduling/task-graph-scheduler.ts:206-214),
 *   ready selection adds map+filter (getReadyTasks :189), the DAG path adds
 *   some+filter+map before buildExecutionPlan (dagReadyTaskIds,
 *   src/runtime/dispatch-batch.ts:352), and the broker's delegate/wait
 *   handlers do `load → .tasks.find/.filter/.map → save` under the run lock
 *   (src/runtime/broker/crew-broker.ts ~1492-1847), each load re-parsing
 *   tasks.json O(N). Upstream cb4375493 indexes task-by-id; is a local index
 *   justified by numbers at realistic N? This bench captures the BEFORE
 *   numbers: wall-time AND scan-count (full task-array iteration passes) per
 *   call, plus the health-monitor full-walk (readdirSync over run dirs) as a
 *   reference row.
 *
 * WHAT THIS MEASURES (per N = 10 / 100 / 1,000 synthetic tasks in an ISOLATED
 * crew home — mkdtemp + PI_CREW_HOME/PI_TEAMS_HOME set in-process BEFORE the
 * src modules are imported, real ~/.pi never touched):
 *   scheduler (pure in-memory, REAL functions imported):
 *   - snapshotCold — taskGraphSnapshot([...tasks]) fresh array each call
 *                   (defeats the P14 WeakMap index cache → includes
 *                   buildTaskGraphIndex passes);
 *   - snapshotWarm — taskGraphSnapshot(sameRef) (P14 memoized index);
 *   - readySelect  — getReadyTasks(sameRef, 4) (map+filter+slice);
 *   - dagReady     — faithful replica of the scheduler call-site
 *                   (dispatch-batch.ts:352 dagReadyTaskIds + :442
 *                   completedIds construction) over REAL
 *                   buildExecutionPlan/getReadyTasks from task-graph.ts.
 *   broker (REAL CrewBroker over a REAL unix socket, REAL state-store on
 *   synthetic run dirs — the ~1492-1847 call-sites verbatim):
 *   - loadCold / loadWarm — loadRunManifestById alone (tasks.json parse
 *                   floor / manifestCache hit);
 *   - delegateAdmission / delegateSettle / delegateTotal — one full
 *                   delegate.request (prompt + role=explorer + budgetTokens
 *                   → hits load×3, find×2, filter×1 [overlap], map×2
 *                   [reserve + roll-up], saveRunTasks×3) with an injected
 *                   instant fake grandchild spawner;
 *   - waitPark      — one wait.request park (load, find, map, save×2).
 *   health (reference row):
 *   - zombieWalk    — scanZombieTempWorkspaces(tmpRoot) full walk: readdirSync
 *                   over synthetic pi-crew-* workspaces × run dirs +
 *                   manifest read+parse per run (extension/team-tool/
 *                   health-monitor.ts:124).
 *
 * SCAN-COUNT INSTRUMENTATION (bench-local "scan-metrics" — no hot file is
 * edited, crew-broker.ts stays untouched/≤2000 lines): Array.prototype
 * iteration methods (filter/map/find/some/every/forEach/findIndex/reduce) are
 * wrapped IN THIS PROCESS ONLY; a call counts when the receiver is a
 * TeamTaskState-shaped array (first element has string `status` + array
 * `dependsOn`). Timing passes run with the counter window CLOSED (patch
 * overhead never skews wall-time); counting passes are separate and
 * deterministic (verified by double-run equality assert). Passes over
 * non-task arrays (dependsOn strings, DAG nodes, waves) are deliberately NOT
 * counted — the metric is full task-array scans, exactly the thing an
 * id→task index would remove.
 *
 * Median of 5 samples per phase. Human tables first, then ONE final NDJSON
 * line (runner parses the LAST stdout JSON line).
 *
 * SAFETY: synthetic homes live under os.tmpdir() and are rm -rf'd in finally;
 * the REAL user runs root (~/.pi/agent/extensions/pi-crew/state/runs/) is
 * snapshotted before/after and asserted unchanged. The broker binds a socket
 * under os.tmpdir() only. PI_CREW_STATE_BACKEND is deleted to pin the default
 * JSON backend (the measured path).
 *
 * Standalone run (NO package.json script — bench/ files are standalone; picked
 * up automatically by `npm run bench` via the b*.bench.ts glob):
 *   node --experimental-strip-types bench/b15-broker-scan-cost.bench.ts
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { GrandchildSpawnInput, GrandchildSpawnResult } from "../src/runtime/delegate-spawn.ts";
import type { TaskNode } from "../src/runtime/scheduling/task-graph.ts";
import type { TeamRunManifest, TeamRunStatus, TeamTaskState } from "../src/state/types.ts";

const ITERATIONS = 5;
const SIZES = [10, 100, 1_000];
const READY_MAX_COUNT = 4; // typical batch size for getReadyTasks
const SETTLE_TIMEOUT_MS = 5_000;
const FRAME_TIMEOUT_MS = 10_000;
const BASE_EPOCH_MS = Date.UTC(2026, 9, 1, 0, 0, 0);
const GOAL_TEXT =
	"Δ3 bench synthetic goal: measure broker/scheduler full task-array scan cost at 10/100/1000 tasks " +
	"(taskGraphSnapshot filter passes, dagReadyTaskIds, crew-broker delegate/wait find/filter/map call-sites) " +
	"so the cb4375493-style id→task index decision is made on numbers, not vibes. This filler keeps each task " +
	"at a realistic ~1KB because task bytes drive tasks.json parse cost in every broker load.";

/** Real user runs root — guarded (must be untouched by this bench). */
const REAL_RUNS_ROOT = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-crew", "state", "runs");

const tmpRoots: string[] = [];
let failures = 0;

function expect(cond: boolean, msg: string): void {
	if (!cond) {
		failures++;
		console.error(`  [FAIL] ${msg}`);
	}
}

function fmt(ms: number): string {
	return ms >= 100 ? ms.toFixed(1) : ms >= 10 ? ms.toFixed(2) : ms.toFixed(3);
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? 0;
}

function minMax(xs: number[]): { min: number; max: number } {
	const s = [...xs].sort((a, b) => a - b);
	return { min: s[0] ?? 0, max: s[s.length - 1] ?? 0 };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotRealRoot(): string[] {
	try {
		return fs.readdirSync(REAL_RUNS_ROOT).sort();
	} catch {
		return [];
	}
}

// ── bench-local scan-metrics (see header: no hot-file edits) ────────────────

const COUNTED_METHODS = ["filter", "map", "find", "some", "every", "forEach", "findIndex", "reduce"] as const;
type CountedMethod = (typeof COUNTED_METHODS)[number];
type ScanCounts = {
	filter: number;
	map: number;
	find: number;
	some: number;
	every: number;
	forEach: number;
	findIndex: number;
	reduce: number;
	other: number;
	total: number;
};

const realMethods = new Map<CountedMethod, (this: unknown[], ...args: unknown[]) => unknown>();
/** Active window counts (null = window closed: patched methods are pass-through). */
let activeCounts: ScanCounts | null = null;

/** TeamTaskState-shaped receiver? (status: string + dependsOn: string[] on [0]) */
function isTaskArray(value: unknown): boolean {
	if (!Array.isArray(value) || value.length === 0) return false;
	const first = value[0] as Partial<TeamTaskState> | undefined;
	return typeof first?.status === "string" && Array.isArray(first?.dependsOn);
}

function installScanCounters(): void {
	const proto = Array.prototype as unknown as Record<CountedMethod, (this: unknown[], ...args: unknown[]) => unknown>;
	for (const method of COUNTED_METHODS) {
		const real = proto[method];
		realMethods.set(method, real);
		proto[method] = function patchedIter(this: unknown[], ...args: unknown[]): unknown {
			if (activeCounts !== null && isTaskArray(this)) {
				activeCounts[method] += 1;
				activeCounts.total += 1;
			}
			return realMethods.get(method)?.apply(this, args);
		};
	}
}

function beginScanWindow(): ScanCounts {
	const counts: ScanCounts = {
		filter: 0,
		map: 0,
		find: 0,
		some: 0,
		every: 0,
		forEach: 0,
		findIndex: 0,
		reduce: 0,
		other: 0,
		total: 0,
	};
	activeCounts = counts;
	return counts;
}

/** Snapshot + close the active scan window (throws if none open). */
function closeScanWindow(): Record<string, number> {
	const windowCounts = activeCounts;
	if (windowCounts === null) throw new Error("scan window closed before snapshot");
	windowCounts.other = windowCounts.every + windowCounts.forEach + windowCounts.findIndex + windowCounts.reduce;
	const snap: Record<string, number> = { ...windowCounts };
	activeCounts = null;
	return snap;
}

function countsLine(counts: Record<string, number>): string {
	const parts: string[] = [];
	for (const key of ["filter", "map", "find", "some", "other"]) {
		if (counts[key] > 0) parts.push(`${key}=${counts[key]}`);
	}
	parts.push(`total=${counts.total}`);
	return parts.join(" ");
}

// ── synthetic fixtures ──────────────────────────────────────────────────────

function synthManifest(home: string, runsRoot: string, runId: string, status: TeamRunStatus): TeamRunManifest {
	const iso = new Date(BASE_EPOCH_MS).toISOString();
	return {
		schemaVersion: 1,
		runId,
		sessionId: `crew-${runId}`,
		team: "default",
		workflow: "plan-execute",
		goal: GOAL_TEXT,
		status,
		workspaceMode: "single",
		createdAt: iso,
		updatedAt: iso,
		cwd: path.join(home, "ws"), // NOT a repo → user-root resolution (F-L1 primary)
		stateRoot: path.join(runsRoot, runId),
		artifactsRoot: path.join(home, ".pi", "agent", "extensions", "pi-crew", "artifacts", runId),
		tasksPath: path.join(runsRoot, runId, "tasks.json"),
		eventsPath: path.join(runsRoot, runId, "events.jsonl"),
		artifacts: [],
		runKind: "team-run",
		goalAchieved: "unknown",
		goalAchievementNote: "b15 Δ3 synthetic manifest (broker/scheduler scan-cost microbench)",
		summary: "Synthetic run for bench/b15-broker-scan-cost.bench.ts — Δ3 scan-cost probe.",
		budgetTotal: 2_000_000,
		budgetWarning: 0.8,
		budgetAbort: 0.95,
		policyDecisions: [],
	};
}

/**
 * Synthetic task set (statuses mirror a mid-flight run):
 *   - parent (middle index): running executor, depth 1, allocation (delegate parent);
 *   - ~12%: running (2 extra executors sharing parent cwd → overlap filter counts);
 *   - ~48%: completed (deps satisfied → ready pool);
 *   - queued: half depends on COMPLETED stepIds (ready), half on QUEUED stepIds (blocked);
 *   - ~8%: failed/skipped/needs_attention mix (drives the other snapshot queues).
 * Every task has a stepId (never a delegate shadow record) and ~1KB of payload.
 */
function synthTasks(runId: string, n: number, cwd: string): TeamTaskState[] {
	const tasks: TeamTaskState[] = [];
	const parentIndex = Math.floor(n / 2);
	const stepId = (i: number): string => `s-${i.toString().padStart(6, "0")}`;
	for (let i = 0; i < n; i++) {
		const id = `t-${i.toString().padStart(6, "0")}`;
		const completed = i % 2 === 0 && i !== parentIndex && i % 8 !== 5; // ~48%
		const queued = !completed && i % 3 !== 2 && i !== parentIndex; // of the rest
		let status: TeamTaskState["status"];
		if (i === parentIndex) status = "running";
		else if (i % 8 === 5) status = i % 16 === 5 ? "failed" : i % 16 === 13 ? "skipped" : "needs_attention";
		else if (completed) status = "completed";
		else if (queued) status = "queued";
		else status = "running";
		// Queued: even → ready (dep on a completed step), odd → blocked (dep on a queued step).
		// NOTE: every task carries a `graph` node — production tasks are created
		// with one, and withQueue() only resolves a queue when graph exists (a
		// graph-less task vanishes from ready/blocked — verified live).
		const parentStepId = stepId(Math.floor(n / 2));
		// Queued (all odd — evens are completed): i%3===1 → ready (dep on the
		// PREVIOUS COMPLETED even step), i%3===2-adjacent → blocked (dep on the
		// running parent step). Split on i%6 keeps both pools non-empty at every N.
		const dependsOn: string[] =
			status === "queued"
				? i % 6 === 1
					? [stepId(i - 1)]
					: [parentStepId]
				: status === "completed" && i >= 4
					? [stepId(i - 2)]
					: [];
		const role =
			i % 5 === 0 ? "executor" : i % 5 === 1 ? "researcher" : i % 5 === 2 ? "analyst" : i % 5 === 3 ? "reviewer" : "verifier";
		const started = new Date(BASE_EPOCH_MS + i * 1_000).toISOString();
		// NOTE: every task carries a `graph` node — production tasks are created
		// with one, and withQueue() only resolves a queue when graph exists (a
		// graph-less task vanishes from ready/blocked — verified live).
		const graph: TeamTaskState["graph"] = { taskId: id, children: [], dependencies: dependsOn, queue: "ready" };
		tasks.push({
			id,
			runId,
			stepId: stepId(i),
			role,
			agent: `${role}-agent`,
			title: `Synthetic task ${id}: ${role} work item ${i} of ${n} — Δ3 scan-cost probe filler title padding to ~80 chars.`,
			description:
				`Synthetic description for ${id}: this filler mirrors a realistic task packet body so per-task JSON bytes ` +
				`stay near 1KB and tasks.json parse cost scales the way production payloads do. Padding padding padding padding.`,
			status,
			dependsOn,
			cwd,
			graph,
			...(i === parentIndex
				? { depth: 1, allocation: { tokensGranted: 1_000, tokensSpent: 0 }, startedAt: started, model: "probe/model-a" }
				: {}),
			...(status === "running" ? { startedAt: started } : {}),
			...(status === "completed" || status === "failed" || status === "skipped"
				? { startedAt: started, finishedAt: new Date(BASE_EPOCH_MS + i * 1_000 + 30_000).toISOString() }
				: {}),
			...(status === "completed"
				? {
						resultArtifact: { kind: "result", path: path.join(cwd, "artifacts", `${id}.md`) },
						usage: { inputTokens: 1_000, outputTokens: 2_000 },
					}
				: {}),
		});
	}
	return tasks;
}

interface BrokerHome {
	home: string;
	ws: string;
	runsRoot: string;
	runId: string;
	runDir: string;
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	parent: TeamTaskState;
	pristineTasksJson: string;
	pristineManifestJson: string;
}

function buildBrokerHome(n: number): BrokerHome {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-b15-n${n}-`));
	tmpRoots.push(home);
	const runsRoot = path.join(home, ".pi", "agent", "extensions", "pi-crew", "state", "runs");
	const ws = path.join(home, "ws"); // NOT a repo → user-root resolution
	fs.mkdirSync(runsRoot, { recursive: true });
	fs.mkdirSync(ws, { recursive: true });
	const runId = `team_20261011000000_b15synth${n.toString().padStart(4, "0")}`;
	const runDir = path.join(runsRoot, runId);
	fs.mkdirSync(runDir, { recursive: true });
	fs.mkdirSync(path.join(home, ".pi", "agent", "extensions", "pi-crew", "artifacts", runId), { recursive: true });
	const manifest = synthManifest(home, runsRoot, runId, "running"); // active run: worker tokens must auth
	const tasks = synthTasks(runId, n, ws);
	const pristineManifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
	const pristineTasksJson = `${JSON.stringify(tasks, null, 2)}\n`;
	fs.writeFileSync(path.join(runDir, "manifest.json"), pristineManifestJson);
	fs.writeFileSync(path.join(runDir, "tasks.json"), pristineTasksJson);
	fs.writeFileSync(path.join(runDir, "events.jsonl"), "");
	const parent = tasks[Math.floor(n / 2)] as TeamTaskState;
	return { home, ws, runsRoot, runId, runDir, manifest, tasks, parent, pristineTasksJson, pristineManifestJson };
}

/** Health-monitor fixture: workspaces × run dirs, minimal manifests (zombie walk reads runId only). */
function buildZombieRoot(n: number): { root: string; workspaces: number; runDirs: number } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-b15-zw-n${n}-`));
	tmpRoots.push(root);
	const perWorkspace = 10;
	const workspaces = Math.ceil(n / perWorkspace);
	let runDirs = 0;
	for (let w = 0; w < workspaces; w++) {
		const runs = path.join(root, `pi-crew-w${w.toString().padStart(4, "0")}`, ".crew", "state", "runs");
		fs.mkdirSync(runs, { recursive: true });
		for (let r = 0; r < perWorkspace && runDirs < n; r++, runDirs++) {
			const runId = `team_20261011000000_zw${runDirs.toString().padStart(4, "0")}`;
			fs.mkdirSync(path.join(runs, runId), { recursive: true });
			fs.writeFileSync(
				path.join(runs, runId, "manifest.json"),
				JSON.stringify({ runId, status: "running", cwd: root, updatedAt: new Date().toISOString() }),
			);
		}
	}
	return { root, workspaces, runDirs };
}

// ── raw socket client (same idiom as test/unit/runtime/broker handshake tests) ──

interface RawClient {
	socket: net.Socket;
	write: (value: unknown) => void;
	waitForFrame: (predicate: (frame: unknown) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
	close: () => void;
}

function connectOnce(socketPath: string): Promise<RawClient> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		const pending: Array<{ predicate: (f: unknown) => boolean; resolve: (v: Record<string, unknown>) => void }> = [];
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
			let idx = buffer.indexOf(0x0a);
			while (idx !== -1) {
				const line = buffer.subarray(0, idx);
				buffer = buffer.subarray(idx + 1);
				idx = buffer.indexOf(0x0a);
				if (line.length === 0) continue;
				let frame: unknown;
				try {
					frame = JSON.parse(line.toString("utf8"));
				} catch {
					continue;
				}
				const hit = pending.findIndex((p) => p.predicate(frame));
				if (hit !== -1) pending.splice(hit, 1)[0]?.resolve(frame as Record<string, unknown>);
			}
		});
		socket.on("error", (err) => reject(err));
		socket.once("connect", () => {
			resolve({
				socket,
				write: (value: unknown) => {
					socket.write(encodeBrokerFrameRef(value));
				},
				waitForFrame: (predicate, timeoutMs = FRAME_TIMEOUT_MS) =>
					new Promise((res, rej) => {
						pending.push({ predicate, resolve: res });
						setTimeout(() => rej(new Error("waitForFrame: timeout")), timeoutMs).unref();
					}),
				close: () => {
					try {
						socket.destroy();
					} catch {
						/* ignore */
					}
				},
			});
		});
	});
}

// Late-bound src imports (set PI_CREW_HOME/PI_TEAMS_HOME BEFORE these load).
let encodeBrokerFrameRef: (value: unknown) => Buffer;

// ── scheduler phase (pure in-memory, REAL functions) ────────────────────────

interface SchedulerResult {
	snapshotColdMs: number;
	snapshotWarmMs: number;
	readySelectMs: number;
	dagReadyMs: number;
	snapshotColdMinMax: { min: number; max: number };
	snapshotWarmMinMax: { min: number; max: number };
	readySelectMinMax: { min: number; max: number };
	dagReadyMinMax: { min: number; max: number };
	scans: Record<string, Record<string, number>>;
}

/** Faithful replica of dagReadyTaskIds (dispatch-batch.ts:352-380) + the
 * completedIds construction at its call-site (dispatch-batch.ts:442). The
 * original is module-private; buildExecutionPlan/getReadyTasks are the REAL
 * imports it delegates to. */
function makeDagReadyPath(deps: {
	isDelegateShadowTask: (task: Pick<TeamTaskState, "id" | "agent" | "stepId">) => boolean;
	buildDagExecutionPlan: (nodes: TaskNode[]) => { hasCycle: boolean };
	getDagReadyTasks: (plan: unknown, completedIds: Set<string>) => string[];
}) {
	return function dagReadyPath(tasks: TeamTaskState[]): string[] | null {
		const completedIds = new Set(tasks.filter((t) => t.status === "completed" || t.status === "needs_attention").map((t) => t.id));
		const hasExplicitDeps = tasks.some((t) => t.dependsOn.length > 0);
		if (!hasExplicitDeps) return null;
		const workflowTasks = tasks.filter((t) => !deps.isDelegateShadowTask(t));
		const stepToTaskId = new Map<string, string>();
		for (const t of workflowTasks) {
			if (t.stepId) stepToTaskId.set(t.stepId, t.id);
		}
		const nodes: TaskNode[] = workflowTasks.map((t) => ({
			id: t.id,
			dependsOn: t.dependsOn.map((dep) => stepToTaskId.get(dep) ?? dep),
			phase: t.adaptive?.phase ?? t.stepId,
		}));
		const plan = deps.buildDagExecutionPlan(nodes);
		if (plan.hasCycle) return null;
		return deps.getDagReadyTasks(plan, completedIds);
	};
}

async function phaseScheduler(
	h: BrokerHome,
	mods: {
		taskGraphSnapshot: (tasks: TeamTaskState[], index?: unknown) => unknown;
		getReadyTasks: (tasks: TeamTaskState[], maxCount?: number) => TeamTaskState[];
		isDelegateShadowTask: (task: Pick<TeamTaskState, "id" | "agent" | "stepId">) => boolean;
		buildDagExecutionPlan: (nodes: TaskNode[]) => { hasCycle: boolean };
		getDagReadyTasks: (plan: unknown, completedIds: Set<string>) => string[];
	},
): Promise<SchedulerResult> {
	const { taskGraphSnapshot, getReadyTasks } = mods;
	const dagReadyPath = makeDagReadyPath(mods);
	const tasks = h.tasks;
	const warmRef = [...tasks]; // stable ref → P14 WeakMap index cache warms once

	// Sanity: the mixture must exercise every snapshot queue + the DAG path.
	const sanity = taskGraphSnapshot([...tasks]) as {
		ready: string[];
		blocked: string[];
		running: string[];
		done: string[];
		failed: string[];
		cancelled: string[];
	};
	expect(sanity.ready.length > 0, `N=${tasks.length}: no ready tasks in mixture`);
	expect(sanity.blocked.length > 0, `N=${tasks.length}: no blocked tasks in mixture`);
	expect(sanity.running.length > 0, `N=${tasks.length}: no running tasks in mixture`);
	expect(sanity.done.length > 0, `N=${tasks.length}: no done tasks in mixture`);
	// N=10 cannot fit every queue (the single i%8===5 slot collides with the
	// parent at floor(10/2)=5) — the failed-queue assert only applies from N=20.
	expect(tasks.length < 20 || sanity.failed.length > 0, `N=${tasks.length}: no failed tasks in mixture`);
	const sanityDag = dagReadyPath(tasks);
	expect(Array.isArray(sanityDag) && sanityDag.length > 0, `N=${tasks.length}: dagReadyPath returned ${String(sanityDag)}`);
	expect(getReadyTasks(warmRef, READY_MAX_COUNT).length > 0, `N=${tasks.length}: getReadyTasks empty`);

	const samples = { snapshotCold: [] as number[], snapshotWarm: [] as number[], readySelect: [] as number[], dagReady: [] as number[] };
	for (let iter = 0; iter < ITERATIONS; iter++) {
		expect(activeCounts === null, "scan window must be CLOSED during timing passes");
		{
			const t0 = performance.now();
			taskGraphSnapshot([...tasks]);
			samples.snapshotCold.push(performance.now() - t0);
		}
		{
			const t0 = performance.now();
			taskGraphSnapshot(warmRef);
			samples.snapshotWarm.push(performance.now() - t0);
		}
		{
			const t0 = performance.now();
			getReadyTasks(warmRef, READY_MAX_COUNT);
			samples.readySelect.push(performance.now() - t0);
		}
		{
			const t0 = performance.now();
			dagReadyPath(tasks);
			samples.dagReady.push(performance.now() - t0);
		}
	}

	// Counting passes (window open; timing ignored — patch overhead is excluded above).
	const counted: Record<string, Record<string, number>> = {};
	const runCounted = (label: string, fn: () => void): void => {
		beginScanWindow();
		fn();
		const first = closeScanWindow();
		beginScanWindow();
		fn();
		const second = closeScanWindow();
		expect(
			JSON.stringify(first) === JSON.stringify(second),
			`${label}: scan counts not deterministic (${JSON.stringify(first)} vs ${JSON.stringify(second)})`,
		);
		counted[label] = first;
	};
	runCounted("snapshotCold", () => taskGraphSnapshot([...tasks]));
	runCounted("snapshotWarm", () => taskGraphSnapshot(warmRef));
	runCounted("readySelect", () => getReadyTasks(warmRef, READY_MAX_COUNT));
	runCounted("dagReady", () => dagReadyPath(tasks));
	// The 6 filter passes of taskGraphSnapshot are the Δ3 headline — pin them.
	expect(counted.snapshotWarm?.filter === 6, `snapshotWarm filter passes = ${counted.snapshotWarm?.filter} (expected 6)`);

	return {
		snapshotColdMs: median(samples.snapshotCold),
		snapshotWarmMs: median(samples.snapshotWarm),
		readySelectMs: median(samples.readySelect),
		dagReadyMs: median(samples.dagReady),
		snapshotColdMinMax: minMax(samples.snapshotCold),
		snapshotWarmMinMax: minMax(samples.snapshotWarm),
		readySelectMinMax: minMax(samples.readySelect),
		dagReadyMinMax: minMax(samples.dagReady),
		scans: counted,
	};
}

// ── broker phase (REAL CrewBroker + REAL state-store) ──────────────────────

interface BrokerResult {
	loadColdMs: number;
	loadWarmMs: number;
	delegateAdmissionMs: number;
	delegateSettleMs: number;
	delegateTotalMs: number;
	waitParkMs: number;
	scans: Record<string, Record<string, number>>;
}

interface BrokerMods {
	CrewBrokerCtor: new (
		options: Record<string, unknown>,
	) => { start: () => Promise<void>; stop: () => Promise<void>; issueRunToken: (runId: string, taskId?: string) => string };
	loadRunManifestById: (cwd: string, runId: string) => { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined;
}

async function phaseBroker(h: BrokerHome, mods: BrokerMods): Promise<BrokerResult> {
	const { CrewBrokerCtor, loadRunManifestById } = mods;
	const spawnCalls: GrandchildSpawnInput[] = [];
	const fakeSpawner = async (input: GrandchildSpawnInput): Promise<GrandchildSpawnResult> => {
		spawnCalls.push(input);
		return { ok: true, resultText: "b15 synthetic grandchild result (instant fake spawner)", usageTokens: 8 };
	};
	const socketPath =
		process.platform === "win32"
			? `\\\\.\\pipe\\pi-crew-b15-${randomBytes(3).toString("hex")}`
			: path.join(os.tmpdir(), `pch-b15-${randomBytes(3).toString("hex")}.sock`);
	const broker = new CrewBrokerCtor({
		sessionId: "session-b15",
		socketPath,
		enabled: true,
		cwd: h.ws,
		nestingEnabled: true,
		nestingTrustedEscalation: true, // trust gate manual-only → bench opts in
		waitMethodsEnabled: true,
		grandchildSpawner: fakeSpawner,
		modelCatalog: () => [],
	});
	await broker.start();
	const client = await connectOnce(socketPath);
	const restorePristine = (): void => {
		fs.writeFileSync(path.join(h.runDir, "tasks.json"), h.pristineTasksJson);
		fs.writeFileSync(path.join(h.runDir, "manifest.json"), h.pristineManifestJson);
	};
	try {
		// hello with a task-scoped (compound) token — delegate requires it.
		const token = broker.issueRunToken(h.runId, h.parent.id);
		client.write({ id: "b15-hello", method: "hello", params: { protocol: 1, runId: h.runId, taskId: h.parent.id, token } });
		const ack = await client.waitForFrame(
			(f) => (f as { id?: string })?.id === "b15-hello" && (f as { result?: { ok?: boolean } })?.result?.ok === true,
		);
		expect(ack.result !== undefined, "hello ack missing result");

		const delegateOnce = async (label: string): Promise<{ admissionMs: number; settleMs: number; counts: Record<string, number> }> => {
			beginScanWindow();
			const t0 = performance.now();
			client.write({
				id: label,
				method: "delegate.request",
				params: {
					prompt: "b15 Δ3 probe: measure the broker delegate call-site scan cost (admission + settle).",
					description: "b15 scan-cost probe",
					role: "explorer",
					budgetTokens: 64,
				},
			});
			const response = (await client.waitForFrame((f) => (f as { id?: string })?.id === label)) as {
				result?: { ok?: boolean; grandchildTaskRef?: string };
				error?: { code?: string; message?: string };
			};
			const admissionMs = performance.now() - t0;
			if (response.error || response.result?.ok !== true) {
				throw new Error(`delegate.request rejected: ${JSON.stringify(response.error ?? response.result)}`);
			}
			const subId = response.result?.grandchildTaskRef ?? "";
			expect(subId.startsWith("gc-"), `grandchildTaskRef malformed: ${subId}`);
			// Settle: poll tasks.json for the subId shadow record terminal flip
			// (for..of only — never a counted array method).
			const t1 = performance.now();
			let settled = false;
			const deadline = Date.now() + SETTLE_TIMEOUT_MS;
			while (Date.now() < deadline) {
				try {
					const raw = JSON.parse(fs.readFileSync(path.join(h.runDir, "tasks.json"), "utf8")) as TeamTaskState[];
					for (const task of raw) {
						if (task.id === subId && (task.status === "completed" || task.status === "failed")) {
							settled = true;
							break;
						}
					}
				} catch {
					/* transient mid-write read — retry */
				}
				if (settled) break;
				await sleep(2);
			}
			const settleMs = performance.now() - t1;
			expect(settled, `delegate settle not observed within ${SETTLE_TIMEOUT_MS}ms (subId=${subId})`);
			// close the counting window AFTER settle (mailbox append is async but
			// touches no task arrays; the roll-up find/map + save precede the flip)
			const counts = closeScanWindow();
			return { admissionMs, settleMs, counts };
		};
		const waitParkOnce = async (label: string): Promise<{ parkMs: number; counts: Record<string, number> }> => {
			beginScanWindow();
			const t0 = performance.now();
			client.write({
				id: label,
				method: "wait.request",
				params: { to: h.parent.id, question: "b15 Δ3 probe: park cost?", timeoutSec: 300 },
			});
			const response = (await client.waitForFrame((f) => (f as { id?: string })?.id === label)) as {
				result?: { ok?: boolean };
				error?: unknown;
			};
			const parkMs = performance.now() - t0;
			if (response.error || response.result?.ok !== true) {
				throw new Error(`wait.request rejected: ${JSON.stringify(response)}`);
			}
			return { parkMs, counts: closeScanWindow() };
		};

		// Warmup (not recorded): one full delegate + settle, then restore.
		await delegateOnce("b15-warmup");
		restorePristine();

		const admission: number[] = [];
		const settle: number[] = [];
		const totals: number[] = [];
		const parks: number[] = [];
		let delegateCounts: Record<string, number> | undefined;
		let parkCounts: Record<string, number> | undefined;
		for (let iter = 0; iter < ITERATIONS; iter++) {
			expect(activeCounts === null, "scan window must be CLOSED between requests");
			const round = await delegateOnce(`b15-d-${iter}`);
			admission.push(round.admissionMs);
			settle.push(round.settleMs);
			totals.push(round.admissionMs + round.settleMs);
			delegateCounts = round.counts;
			restorePristine();
			const park = await waitParkOnce(`b15-w-${iter}`);
			parks.push(park.parkMs);
			parkCounts = park.counts;
			restorePristine();
		}
		expect(spawnCalls.length === ITERATIONS + 1, `spawner invoked ${spawnCalls.length}× (expected ${ITERATIONS + 1})`);

		// loadRunManifestById floor: cold (mtime bumped → manifestCache miss →
		// full read+parse) vs warm (immediate second call → cache hit). One
		// UNTIMED warmup load first so first-home fs-cache/verdict-cache cold
		// starts do not skew the N=10 baseline.
		const tasksPath = path.join(h.runDir, "tasks.json");
		void loadRunManifestById(h.ws, h.runId);
		const colds: number[] = [];
		const warms: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			const stamp = new Date();
			fs.utimesSync(tasksPath, stamp, stamp); // bump mtime → deterministic cache miss
			{
				const t0 = performance.now();
				const loaded = loadRunManifestById(h.ws, h.runId);
				colds.push(performance.now() - t0);
				expect(
					loaded?.tasks.length === h.tasks.length,
					`cold load returned ${loaded?.tasks.length} tasks (expected ${h.tasks.length})`,
				);
			}
			{
				const t0 = performance.now();
				const loaded = loadRunManifestById(h.ws, h.runId);
				warms.push(performance.now() - t0);
				expect(loaded?.tasks.length === h.tasks.length, `warm load returned ${loaded?.tasks.length} tasks`);
			}
		}

		return {
			loadColdMs: median(colds),
			loadWarmMs: median(warms),
			delegateAdmissionMs: median(admission),
			delegateSettleMs: median(settle),
			delegateTotalMs: median(totals),
			waitParkMs: median(parks),
			scans: { delegate: delegateCounts ?? {}, waitPark: parkCounts ?? {} },
		};
	} finally {
		client.close();
		await broker.stop();
		restorePristine();
	}
}

// ── health-monitor phase (reference row) ────────────────────────────────────

function phaseHealth(
	zombie: { root: string; workspaces: number; runDirs: number },
	scanZombieTempWorkspaces: (tmpDir: string, now: number) => Array<{ dir: string; runCount: number }>,
): { zombieWalkMs: number; workspaces: number; runDirs: number; readdirs: number } {
	const samples: number[] = [];
	let zombies: Array<{ dir: string; runCount: number }> = [];
	for (let iter = 0; iter < ITERATIONS; iter++) {
		const t0 = performance.now();
		zombies = scanZombieTempWorkspaces(zombie.root, Date.now());
		samples.push(performance.now() - t0);
	}
	expect(zombies.length === zombie.workspaces, `zombie walk saw ${zombies.length}/${zombie.workspaces} workspaces`);
	const totalRuns = zombies.reduce((acc, z) => acc + z.runCount, 0);
	expect(totalRuns === zombie.runDirs, `zombie walk counted ${totalRuns}/${zombie.runDirs} run dirs`);
	// readdirSync shape: 1 (tmp root) + 1 per workspace (health-monitor.ts:129/143)
	return { zombieWalkMs: median(samples), workspaces: zombie.workspaces, runDirs: zombie.runDirs, readdirs: 1 + zombie.workspaces };
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<Record<string, unknown>> {
	installScanCounters();
	const realRootBefore = snapshotRealRoot();
	console.log(`b15 — broker/scheduler task-array scan-cost microbench (Δ3)`);
	console.log(`  real user runs root guard: ${REAL_RUNS_ROOT}`);
	console.log(`  entries before: [${realRootBefore.join(", ")}]`);
	// Pin the measured backend: the default JSON path (never sqlite ambient).
	delete process.env.PI_CREW_STATE_BACKEND;

	const cases: Record<string, Record<string, unknown>> = {};
	for (const n of SIZES) {
		const h = buildBrokerHome(n);
		// Isolated crew home FIRST, then load the modules that read PI_CREW_HOME /
		// PI_TEAMS_HOME (LAZY: env must be set before any userCrewRoot() resolution).
		process.env.PI_CREW_HOME = h.home;
		process.env.PI_TEAMS_HOME = h.home;
		const schedulerMods = await import("../src/runtime/scheduling/task-graph-scheduler.ts");
		const taskGraphMods = await import("../src/runtime/scheduling/task-graph.ts");
		const shadowLifecycle = await import("../src/runtime/broker/delegate/shadow-lifecycle.ts");
		const stateStore = await import("../src/state/stores/state-store.ts");
		const healthMonitor = await import("../src/extension/team-tool/health-monitor.ts");
		const brokerMod = await import("../src/runtime/broker/crew-broker.ts");
		const ndjson = await import("../src/utils/ndjson.ts");
		encodeBrokerFrameRef = ndjson.encodeBrokerFrame;

		const tasksJsonBytes = fs.statSync(path.join(h.runDir, "tasks.json")).size;
		console.log(`\n── N=${n} tasks (home ${h.home}, tasks.json ${tasksJsonBytes} B ≈ ${Math.round(tasksJsonBytes / n)} B/task) ──`);

		const scheduler = await phaseScheduler(h, {
			taskGraphSnapshot: schedulerMods.taskGraphSnapshot,
			getReadyTasks: schedulerMods.getReadyTasks,
			isDelegateShadowTask: shadowLifecycle.isDelegateShadowTask,
			buildDagExecutionPlan: taskGraphMods.buildExecutionPlan,
			getDagReadyTasks: taskGraphMods.getReadyTasks,
		});
		console.log(`  scheduler phase   median(ms)   min..max          task-array scans/call`);
		const schedRows: Array<[string, number, { min: number; max: number }, Record<string, number>]> = [
			["snapshotCold", scheduler.snapshotColdMs, scheduler.snapshotColdMinMax, scheduler.scans.snapshotCold ?? {}],
			["snapshotWarm", scheduler.snapshotWarmMs, scheduler.snapshotWarmMinMax, scheduler.scans.snapshotWarm ?? {}],
			["readySelect", scheduler.readySelectMs, scheduler.readySelectMinMax, scheduler.scans.readySelect ?? {}],
			["dagReady", scheduler.dagReadyMs, scheduler.dagReadyMinMax, scheduler.scans.dagReady ?? {}],
		];
		for (const [label, med, mm, counts] of schedRows) {
			console.log(`  ${label.padEnd(15)} ${fmt(med).padStart(10)}   ${fmt(mm.min)}..${fmt(mm.max)}   ${countsLine(counts)}`);
		}

		const broker = await phaseBroker(h, {
			CrewBrokerCtor: brokerMod.CrewBroker,
			loadRunManifestById: stateStore.loadRunManifestById,
		});
		console.log(`  broker phase      median(ms)   task-array scans/request`);
		console.log(`  ${"loadCold".padEnd(15)} ${fmt(broker.loadColdMs).padStart(10)}   (parse floor — no array methods)`);
		console.log(`  ${"loadWarm".padEnd(15)} ${fmt(broker.loadWarmMs).padStart(10)}   (manifestCache hit)`);
		console.log(
			`  ${"delegAdmission".padEnd(15)} ${fmt(broker.delegateAdmissionMs).padStart(10)}   ${countsLine(broker.scans.delegate ?? {})}`,
		);
		console.log(`  ${"delegSettle".padEnd(15)} ${fmt(broker.delegateSettleMs).padStart(10)}   (roll-up included above)`);
		console.log(`  ${"delegTotal".padEnd(15)} ${fmt(broker.delegateTotalMs).padStart(10)}`);
		console.log(`  ${"waitPark".padEnd(15)} ${fmt(broker.waitParkMs).padStart(10)}   ${countsLine(broker.scans.waitPark ?? {})}`);

		const zombie = buildZombieRoot(n);
		const health = phaseHealth(zombie, healthMonitor.scanZombieTempWorkspaces);
		console.log(`  health phase      median(ms)   walk shape`);
		console.log(
			`  ${"zombieWalk".padEnd(15)} ${fmt(health.zombieWalkMs).padStart(10)}   readdirSync×${health.readdirs} over ${health.workspaces} workspaces / ${health.runDirs} run dirs`,
		);

		cases[`n${n}`] = {
			tasks: n,
			tasksJsonBytes,
			taskAvgBytes: Math.round(tasksJsonBytes / n),
			scheduler: {
				snapshotColdMs: scheduler.snapshotColdMs,
				snapshotWarmMs: scheduler.snapshotWarmMs,
				readySelectMs: scheduler.readySelectMs,
				dagReadyMs: scheduler.dagReadyMs,
				scans: scheduler.scans,
			},
			broker: {
				loadColdMs: broker.loadColdMs,
				loadWarmMs: broker.loadWarmMs,
				delegateAdmissionMs: broker.delegateAdmissionMs,
				delegateSettleMs: broker.delegateSettleMs,
				delegateTotalMs: broker.delegateTotalMs,
				waitParkMs: broker.waitParkMs,
				scans: broker.scans,
			},
			health: {
				zombieWalkMs: health.zombieWalkMs,
				workspaces: health.workspaces,
				runDirs: health.runDirs,
				readdirs: health.readdirs,
			},
		};
	}

	// User-root guard (must be untouched — the synthetic home was the only root).
	const userRootAfter = snapshotRealRoot();
	const unchanged = realRootBefore.join("|") === userRootAfter.join("|");
	expect(unchanged, `real user runs root CHANGED by bench: [${userRootAfter.join(", ")}]`);

	return {
		name: "b15.broker-scan-cost",
		unit: "ms",
		iterations: ITERATIONS,
		cases,
		backend: "json (PI_CREW_STATE_BACKEND deleted at startup)",
		instrumentation:
			"Array.prototype filter/map/find/some/every/forEach/findIndex/reduce wrapped bench-local; counts full TeamTaskState-array passes only",
		userRootGuard: { unchanged, entries: userRootAfter },
		failures,
	};
}

let result: Record<string, unknown>;
try {
	result = await main();
} finally {
	// Cleanup: remove ALL synthetic roots, then assert removal.
	for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
	for (const root of tmpRoots) expect(!fs.existsSync(root), `cleanup failed: ${root} still exists`);
	delete process.env.PI_CREW_HOME;
	delete process.env.PI_TEAMS_HOME;
}

// NDJSON contract line — must be the LAST stdout line (runner parses it).
console.log(JSON.stringify(result));

if (failures > 0) {
	console.error(`\nb15 FAILED (${failures} check(s))`);
	process.exit(1);
}
console.log("\nb15 PASSED");
