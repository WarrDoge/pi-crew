import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mock, test } from "node:test";
import { emptyCrewAgentProgress } from "../../../../src/runtime/crew-agent-records.ts";
import {
	LIVE_TOOL_HEARTBEAT_INTERVAL_MS,
	runLiveTask,
	setLiveToolHeartbeatTimerForTests,
	startLiveToolHeartbeatTimer,
} from "../../../../src/runtime/task-runner/live-executor.ts";
import { flushPendingAtomicWrites } from "../../../../src/state/atomic-write.ts";
import type { TeamEvent } from "../../../../src/state/event-log/event-log.ts";
import { flushEventLogBuffer, readEvents } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

/**
 * Wave 13 (F2, GAP-1) — live-executor tool heartbeat timer.
 *
 * Live evidence (2026-10-24/25): the task heartbeat was persisted ONLY from
 * onEvent (persistLiveProgress) — purely event-driven, so a single long tool
 * (20-min CI poll / test suite) froze heartbeat.lastSeenAt while the executor
 * was alive and working, and every consumer (watchdog, dashboard, doctor,
 * stale-reconciler) saw a stale-but-healthy run.
 *
 * Fix under test (SPEC §3.2): a 30s unref'd interval armed per attempt that
 * touches ONLY the heartbeat (shared 1s throttle, tasks.json only — never the
 * event log) and ONLY while a tool is executing
 * (agentProgress.currentToolStartedAt set by tool_execution_start / cleared
 * by tool_execution_end), cleared in the finally that finalises the attempt.
 *
 * Strategy:
 *   [t1] helper-level with node:test mock.timers — the gate (idle ⇒ no
 *        touch, in-flight ⇒ one touch per interval), error containment, and
 *        stop() clearing;
 *   [t2] wiring-level through the REAL runLiveTask (mock live-session) with
 *        global setInterval/clearInterval spies — the timer is armed with the
 *        real 30s cadence and cleared on BOTH normal completion and throw;
 *   [t3] wiring-level with the timer-factory test seam capturing the REAL
 *        closures — a tick while a tool is in flight persists a FRESH
 *        heartbeat.lastSeenAt, appends ZERO event-log lines, and the shared
 *        1s throttle still binds after the attempt.
 */

const team = {
	name: "t",
	description: "",
	source: "test",
	filePath: "t",
	roles: [{ name: "r", agent: "a" }],
} as const;
const workflow = {
	name: "w",
	description: "",
	source: "test",
	filePath: "w",
	steps: [{ id: "s", role: "r", task: "x" }],
} as const;
const agent = {
	name: "a",
	description: "",
	source: "test",
	filePath: "a",
	systemPrompt: "test",
} as const;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TimerSpy {
	/** Intervals created while the spy was active: {handle, ms}. */
	created: Array<{ handle: unknown; ms: number }>;
	/** Handles passed to clearInterval while the spy was active. */
	cleared: Set<unknown>;
	restore: () => void;
}

/** Spy on global setInterval/clearInterval to observe timer arming + clearing. */
function spyGlobalIntervals(): TimerSpy {
	const created: Array<{ handle: unknown; ms: number }> = [];
	const cleared = new Set<unknown>();
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
		const handle = realSetInterval(fn as never, ms, ...(args as never[]));
		created.push({ handle, ms: ms ?? 0 });
		return handle;
	}) as typeof setInterval;
	globalThis.clearInterval = ((handle: unknown) => {
		cleared.add(handle);
		return realClearInterval(handle as never);
	}) as typeof clearInterval;
	return {
		created,
		cleared,
		restore: () => {
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
		},
	};
}

/** The live-tool-heartbeat intervals observed by a TimerSpy (30s cadence). */
function heartbeatIntervals(spy: TimerSpy): Array<{ handle: unknown; ms: number }> {
	return spy.created.filter((entry) => entry.ms === LIVE_TOOL_HEARTBEAT_INTERVAL_MS);
}

interface LiveFixture {
	cwd: string;
	runId: string;
	taskId: string;
	eventsPath: string;
	manifest: TeamRunManifest;
	/** Running task with a tool in flight + stale heartbeat (wave-13 shape). */
	task: TeamTaskState;
}

/** Temp project + manifest + a RUNNING task mid-tool with a frozen heartbeat. */
function prepareLiveFixture(): LiveFixture {
	let cwd = createTrackedTempDir("pi-crew-live-hb-");
	try {
		const r = fs.realpathSync.native(cwd);
		cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		/* keep as-is */
	}
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	const created = createRunManifest({ cwd, team: team as never, workflow: workflow as never, goal: "live-heartbeat" });
	const base = created.tasks[0]!;
	// The wave-13 shape: a tool has been executing for a while (evidence frozen
	// at tool start), no pi events fired since, the heartbeat is far in the past.
	const task: TeamTaskState = {
		...base,
		status: "running",
		heartbeat: { workerId: base.id, lastSeenAt: "2026-01-01T00:00:00.000Z", alive: true },
		agentProgress: {
			...emptyCrewAgentProgress(),
			currentTool: "bash",
			currentToolStartedAt: new Date().toISOString(),
		},
	};
	saveRunTasks(created.manifest, [task]);
	return {
		cwd,
		runId: created.manifest.runId,
		taskId: base.id,
		eventsPath: created.manifest.eventsPath,
		manifest: created.manifest,
		task,
	};
}

/** The mock live-session needs BOTH gates (wave-2b mock double-gate). */
function mockEnv(): { apply: () => void; restore: () => void } {
	const saved: Record<string, string | undefined> = {
		PI_CREW_ALLOW_MOCK: process.env.PI_CREW_ALLOW_MOCK,
		PI_CREW_MOCK_LIVE_SESSION: process.env.PI_CREW_MOCK_LIVE_SESSION,
	};
	return {
		apply: () => {
			process.env.PI_CREW_ALLOW_MOCK = "1";
			process.env.PI_CREW_MOCK_LIVE_SESSION = "success";
		},
		restore: () => {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}

function readTaskHeartbeatLastSeenAt(cwd: string, runId: string, taskId: string): string | undefined {
	const loaded = loadRunManifestById(cwd, runId);
	return loaded?.tasks.find((task) => task.id === taskId)?.heartbeat?.lastSeenAt;
}

/**
 * The full event list once the attempt's fire-and-forget appends have landed:
 * they resolve a few event-loop turns AFTER runLiveTask returns (asyncQueues
 * + cross-process lock + buffered 20ms timer), so a bare read can observe a
 * mid-flight file. Poll until two reads 100ms apart agree.
 */
async function settledEvents(eventsPath: string): Promise<TeamEvent[]> {
	await flushEventLogBuffer();
	let events = readEvents(eventsPath);
	for (let i = 0; i < 20; i++) {
		await sleep(100);
		await flushEventLogBuffer();
		const next = readEvents(eventsPath);
		if (next.length === events.length) return next;
		events = next;
	}
	return events;
}

// ── [t1] gate semantics (helper level, fake timers) ─────────────────────────

test("[t1] the timer ticks only while a tool is in flight — idle gaps between tools persist nothing", () => {
	const timers = mock.timers;
	timers.enable({ apis: ["setInterval"] });
	try {
		let toolInFlight = false;
		let touches = 0;
		const timer = startLiveToolHeartbeatTimer({
			intervalMs: LIVE_TOOL_HEARTBEAT_INTERVAL_MS,
			isToolInFlight: () => toolInFlight,
			touch: () => {
				touches += 1;
			},
		});
		try {
			// Idle between tools (currentToolStartedAt cleared): intervals fire,
			// nothing may be persisted.
			timers.tick(3 * LIVE_TOOL_HEARTBEAT_INTERVAL_MS);
			assert.equal(touches, 0, "idle (no tool executing) ⇒ no touch, no state write");

			// Tool in flight: exactly one touch per interval.
			toolInFlight = true;
			timers.tick(LIVE_TOOL_HEARTBEAT_INTERVAL_MS);
			assert.equal(touches, 1, "tool executing ⇒ one touch per 30s interval");
			timers.tick(2 * LIVE_TOOL_HEARTBEAT_INTERVAL_MS);
			assert.equal(touches, 3, "ticks keep firing while the long tool runs");
		} finally {
			timer.stop();
		}
	} finally {
		timers.reset();
	}
});

test("[t1b] a throwing gate/touch is contained — the timer keeps ticking, the host never crashes", () => {
	const timers = mock.timers;
	timers.enable({ apis: ["setInterval"] });
	try {
		let touches = 0;
		const timer = startLiveToolHeartbeatTimer({
			intervalMs: LIVE_TOOL_HEARTBEAT_INTERVAL_MS,
			isToolInFlight: () => {
				throw new Error("gate boom");
			},
			touch: () => {
				touches += 1;
			},
		});
		try {
			assert.doesNotThrow(() => timers.tick(LIVE_TOOL_HEARTBEAT_INTERVAL_MS), "a throwing gate cannot crash the host");
			assert.equal(touches, 0, "touch never ran");
		} finally {
			timer.stop();
		}
	} finally {
		timers.reset();
	}
});

// ── [t2] timer cleared in the finally (wiring level, real runLiveTask) ──────

test("[t2] runLiveTask clears the heartbeat timer in its finally — normal completion, no dangling interval", async () => {
	const env = mockEnv();
	env.apply();
	const fixture = prepareLiveFixture();
	const spy = spyGlobalIntervals();
	try {
		await runLiveTask({
			manifest: fixture.manifest,
			tasks: [fixture.task],
			task: fixture.task,
			step: workflow.steps[0] as never,
			agent: agent as never,
			prompt: "p",
			workspaceId: fixture.cwd,
			isCurrent: () => true,
		});

		const ours = heartbeatIntervals(spy);
		assert.equal(ours.length, 1, "exactly one live-tool-heartbeat interval armed for the attempt");
		assert.ok(
			ours.every((entry) => spy.cleared.has(entry.handle)),
			"the interval was cleared (finally) — no dangling setInterval",
		);
	} finally {
		spy.restore();
		env.restore();
		await removeDirWithRetry(fixture.cwd);
	}
});

test("[t2b] runLiveTask clears the heartbeat timer even when the attempt throws", async () => {
	const env = mockEnv();
	env.apply();
	const fixture = prepareLiveFixture();
	const spy = spyGlobalIntervals();
	try {
		await assert.rejects(
			runLiveTask({
				manifest: fixture.manifest,
				tasks: [fixture.task],
				task: fixture.task,
				step: workflow.steps[0] as never,
				agent: agent as never,
				prompt: "p",
				workspaceId: fixture.cwd,
				// The mock live-session calls isCurrent before its first onEvent —
				// a throw here fails the attempt AFTER the timer was armed.
				isCurrent: () => {
					throw new Error("attempt boom");
				},
			}),
			/attempt boom/,
			"the attempt failure propagates",
		);

		const ours = heartbeatIntervals(spy);
		assert.equal(ours.length, 1, "the timer was armed before the attempt failed");
		assert.ok(
			ours.every((entry) => spy.cleared.has(entry.handle)),
			"the finally cleared the interval on the throw path too",
		);
	} finally {
		spy.restore();
		env.restore();
		await removeDirWithRetry(fixture.cwd);
	}
});

// ── [t3] a tick during a long tool persists a fresh heartbeat, not events ───

test("[t3] a tick while the tool is in flight refreshes heartbeat.lastSeenAt and appends ZERO event-log lines", async () => {
	const env = mockEnv();
	env.apply();
	const fixture = prepareLiveFixture();
	// Capture the REAL wiring closures (gate + touch) via the timer-factory
	// seam so the tick drives the real persist path against the real manifest.
	let captured: { intervalMs: number; isToolInFlight: () => boolean; touch: () => void } | undefined;
	let stops = 0;
	setLiveToolHeartbeatTimerForTests((opts) => {
		captured = opts;
		return {
			stop() {
				stops += 1;
			},
		};
	});
	try {
		await runLiveTask({
			manifest: fixture.manifest,
			tasks: [fixture.task],
			task: fixture.task,
			step: workflow.steps[0] as never,
			agent: agent as never,
			prompt: "p",
			workspaceId: fixture.cwd,
			isCurrent: () => true,
		});

		// Wiring: armed with the real cadence, gate sees the in-flight tool,
		// stopped exactly once by the finally.
		assert.ok(captured, "the heartbeat timer was armed for the attempt");
		assert.equal(captured.intervalMs, LIVE_TOOL_HEARTBEAT_INTERVAL_MS, "armed with the 30s cadence");
		assert.equal(captured.isToolInFlight(), true, "the gate reads agentProgress.currentToolStartedAt (tool still in flight)");
		assert.equal(stops, 1, "the finally stopped the timer exactly once");

		// The attempt's event-driven persist already refreshed the stale seed
		// (flush the coalesced tasks.json write so the read sees the final value).
		await flushPendingAtomicWrites();
		const afterAttempt = readTaskHeartbeatLastSeenAt(fixture.cwd, fixture.runId, fixture.taskId);
		assert.ok(
			afterAttempt && afterAttempt !== "2026-01-01T00:00:00.000Z",
			"event-driven persist refreshed the heartbeat during the attempt",
		);

		// Past the shared 1s throttle window: a tick while the tool is in flight
		// persists a FRESH lastSeenAt (tasks.json writes are coalesced — flush the
		// 50ms window so the read sees the tick's value)…
		await sleep(1100);
		const tickWindowStartMs = Date.now();
		captured.touch();
		flushPendingAtomicWrites();
		const afterTick = readTaskHeartbeatLastSeenAt(fixture.cwd, fixture.runId, fixture.taskId);
		assert.ok(
			afterTick && new Date(afterTick).getTime() > new Date(afterAttempt).getTime(),
			"a tick during the long tool persisted a FRESH heartbeat.lastSeenAt",
		);
		// …and an IMMEDIATE second tick is absorbed by the same 1s throttle the
		// event-driven persist uses (shared lastHeartbeatPersistedAt) — no write.
		captured.touch();
		flushPendingAtomicWrites();
		assert.equal(
			readTaskHeartbeatLastSeenAt(fixture.cwd, fixture.runId, fixture.taskId),
			afterTick,
			"the timer reuses the event-driven 1s throttle (immediate tick is a no-op)",
		);
		// …and the ticks appended ZERO event-log lines: no event may carry a
		// timestamp from the tick window (late-landing ATTEMPT appends keep their
		// attempt-time `time` and are irrelevant; anything a tick wrote would
		// carry a tick-time stamp — SPEC §4.2: the event log cannot grow from
		// heartbeats).
		const events = await settledEvents(fixture.eventsPath);
		const tickTimeEvents = events.filter((event) => new Date(event.time).getTime() >= tickWindowStartMs);
		assert.equal(tickTimeEvents.length, 0, "ticks append ZERO event-log lines (no task.progress from heartbeats)");
	} finally {
		setLiveToolHeartbeatTimerForTests(null);
		env.restore();
		await removeDirWithRetry(fixture.cwd);
	}
});
