/**
 * Unit tests for src/runtime/foreground-watchdog.ts (ZERO-COVERAGE module).
 *
 * Public API under test:
 *   - startForegroundWatchdog(opts: WatchdogOptions): void
 *   - stopWatchdog(runId: string): void
 *
 * Strategy: drive the REAL watchdog against manifests + agents persisted on
 * disk in an isolated temp project (mirrors heartbeat-watcher.test.ts). This
 * exercises the real loadRunManifestById → readCrewAgents →
 * isLikelyOrphanedActiveRun path plus the timer/scheduling + pi.sendUserMessage
 * notification wiring. A tiny checkIntervalMs makes checks fire promptly.
 *
 * The Pi callback is stubbed to capture sendUserMessage calls; no LLM/SDK is
 * involved. The watchdog timers are unref()'d and explicitly stopped in
 * finally blocks.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { saveCrewAgents } from "../../../../src/runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../../../../src/runtime/crew-agent-runtime.ts";
import {
	hungAlertDedupSizeForTests,
	hungAlertDeliveryPendingForTests,
	markHungAlertForTests,
	resetHungAlertDedupForTests,
	setDeliveryLoaderForTests,
	setDeliveryTimingForTests,
	setReverifyLoaderForTests,
	startForegroundWatchdog,
	stopWatchdog,
} from "../../../../src/runtime/foreground-watchdog.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";

// Minimal team/workflow fixtures (cast as never — matches heartbeat-watcher.test.ts).
const team = {
	name: "watchdog-team",
	description: "",
	source: "test",
	filePath: "t",
	roles: [{ name: "worker", agent: "agent-a" }],
} as never;
const workflow = {
	name: "watchdog-flow",
	description: "",
	source: "test",
	filePath: "w",
	steps: [{ id: "do", role: "worker", task: "do the thing" }],
} as never;

interface CapturedMessage {
	text: string;
	options: unknown;
}

interface PiStub {
	messages: CapturedMessage[];
}

/** A pi stub capturing sendUserMessage calls. No extensions → isPiDiffLoaded false. */
function makePi(): PiStub & Record<string, unknown> {
	const messages: CapturedMessage[] = [];
	return {
		messages,
		sendUserMessage: (text: string, options: unknown): void => {
			messages.push({ text, options });
		},
	};
}

/** Resolve predicate true within timeoutMs, polling on the event loop. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000, message = "waitFor timed out"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new assert.AssertionError({ message });
}

/** Sleep helper for negative assertions (give timers a chance to misbehave). */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SetupOptions {
	status: TeamRunManifest["status"];
	/** How far in the past to backdate updatedAt (ms). 0 = now. */
	ageMs: number;
	/** Optional agent records to persist to agents.json. */
	agents?: CrewAgentRecord[];
	/** Optional tasks persisted to tasks.json (WD-STALE-RECORD fixtures). */
	tasks?: TeamTaskState[];
}

interface PreparedRun {
	cwd: string;
	runId: string;
	manifest: TeamRunManifest;
}

/** Create an isolated temp project + run manifest with the requested state. */
function prepareRun(opts: SetupOptions): PreparedRun {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fg-watchdog-"));
	// Canonicalize to long-name form (mirrors production path resolution).
	try {
		const r = fs.realpathSync.native(cwd);
		cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		/* keep as-is */
	}
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

	const created = createRunManifest({ cwd, team, workflow, goal: "watchdog goal" });
	const updatedAt = new Date(Date.now() - opts.ageMs).toISOString();
	const manifest: TeamRunManifest = { ...created.manifest, status: opts.status, updatedAt };
	saveRunManifest(manifest);
	if (opts.agents) {
		saveCrewAgents(manifest, opts.agents);
	}
	if (opts.tasks) {
		saveRunTasks(manifest, opts.tasks);
	}
	return { cwd, runId: manifest.runId, manifest };
}

/** Minimal TeamTaskState — the watchdog stale-record check reads only `status`. */
function task(id: string, status: TeamTaskState["status"], runId: string): TeamTaskState {
	return {
		id,
		runId,
		stepId: id,
		role: "worker",
		agent: "agent-a",
		title: id,
		status,
		dependsOn: [],
		cwd: "/tmp/pi-crew-fg-watchdog",
		graph: { taskId: id, children: [], dependencies: [], queue: "done" },
	} as unknown as TeamTaskState;
}

function queuedAgent(runId: string): CrewAgentRecord {
	return {
		id: `${runId}:do`,
		runId,
		taskId: "do",
		agent: "agent-a",
		role: "worker",
		runtime: "scaffold",
		status: "queued",
		startedAt: new Date().toISOString(),
	};
}

function runningAgent(runId: string): CrewAgentRecord {
	return {
		id: `${runId}:do`,
		runId,
		taskId: "do",
		agent: "agent-a",
		role: "worker",
		runtime: "scaffold",
		status: "running",
		startedAt: new Date().toISOString(),
		progress: { recentTools: [], recentOutput: [], toolCount: 1 },
	};
}

test("startForegroundWatchdog: detects a hung run (stale heartbeat + idle agents) and notifies via followUp", async () => {
	// Create the run first (no agents yet), then persist agents with the real runId.
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	const pi = makePi();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });

		await waitFor(() => pi.messages.some((m) => m.text.includes("appears hung")), 2000);

		const hung = pi.messages.find((m) => m.text.includes("appears hung"));
		assert.ok(hung, "a 'hung' notification was sent");
		assert.ok(hung.text.includes(runId), "notification names the runId");
		assert.ok(hung.text.includes("watchdog"), "message is the watchdog message");
		assert.deepEqual(hung.options, { deliverAs: "followUp" }, "delivered as followUp");
	} finally {
		stopWatchdog(runId);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("startForegroundWatchdog: notifies exactly once on terminal completion then self-stops", async () => {
	const { cwd, runId } = prepareRun({ status: "completed", ageMs: 0 });
	const pi = makePi();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });

		await waitFor(() => pi.messages.some((m) => m.text.includes("run completed")), 2000);

		// Give the scheduler several more intervals to (wrongly) re-fire.
		await sleep(60);

		const completions = pi.messages.filter((m) => m.text.includes("run completed"));
		assert.equal(completions.length, 1, "exactly one completion notification (watchdog self-stopped)");
		assert.ok(completions[0].text.includes(runId), "names the runId");
		assert.ok(completions[0].text.includes("watchdog-team/watchdog-flow"), "names team/workflow");
		assert.deepEqual(completions[0].options, { deliverAs: "followUp" });
	} finally {
		stopWatchdog(runId);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("startForegroundWatchdog: a healthy active run (fresh heartbeat, running agent) is NOT flagged", async () => {
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 0 });
	saveCrewAgents(manifest, [runningAgent(runId)]);
	const pi = makePi();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });

		// Let several check intervals elapse — a healthy run produces no message.
		await sleep(80);

		assert.equal(pi.messages.length, 0, "no notification sent for a healthy active run");
	} finally {
		stopWatchdog(runId);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("startForegroundWatchdog: does not stack duplicate timers for the same runId", async () => {
	const { cwd, runId } = prepareRun({ status: "completed", ageMs: 0 });
	const pi = makePi();
	try {
		// Start the watchdog twice for the same run — second call must be a no-op.
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });

		await waitFor(() => pi.messages.some((m) => m.text.includes("run completed")), 2000);
		await sleep(60);

		const completions = pi.messages.filter((m) => m.text.includes("run completed"));
		assert.equal(completions.length, 1, "dedup ensures a single timer → single notification");
	} finally {
		stopWatchdog(runId);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("startForegroundWatchdog: stops silently when the run manifest is gone (no crash, no message)", async () => {
	const { cwd, runId } = prepareRun({ status: "running", ageMs: 0 });
	const pi = makePi();
	try {
		// Delete the run state dir so loadRunManifestById returns undefined.
		fs.rmSync(path.join(cwd, ".crew", "state", "runs", runId), { recursive: true, force: true });

		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });
		await sleep(80);

		assert.equal(pi.messages.length, 0, "missing manifest → no notification and no throw");
	} finally {
		stopWatchdog(runId);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("WD-DEDUP: a persistently hung run alerts 'appears hung' exactly once — even across watchdog restarts", async () => {
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	const pi = makePi();
	resetHungAlertDedupForTests();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });
		await waitFor(() => pi.messages.some((m) => m.text.includes("appears hung")), 2000);

		// Let MANY more hung cycles fire — old behavior re-alerted (notice cap 2).
		await sleep(150);
		assert.equal(
			pi.messages.filter((m) => m.text.includes("appears hung")).length,
			1,
			"alert-once per runId: exactly one 'appears hung' notice",
		);

		// A fresh watchdog instance for the same run must not re-alert either —
		// the dedup lives at module scope, not per instance.
		stopWatchdog(runId);
		const pi2 = makePi();
		startForegroundWatchdog({ pi: pi2 as never, cwd, runId, checkIntervalMs: 5 });
		await sleep(150);
		assert.equal(
			pi2.messages.filter((m) => m.text.includes("appears hung")).length,
			0,
			"fresh watchdog instance does not re-alert the same runId",
		);
	} finally {
		stopWatchdog(runId);
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("WD-DEDUP: run that went terminal before the emit point never alerts (re-verify skips emit)", async () => {
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	const pi = makePi();
	resetHungAlertDedupForTests();
	// Simulate the real incident: the cycle still reads a stale hung manifest,
	// but by emit time the run has already reached a terminal status.
	setReverifyLoaderForTests(() => ({ manifest: { ...manifest, status: "completed" }, tasks: [] }));
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });
		await sleep(150); // many hung cycles, each re-verified terminal → skip
		assert.equal(pi.messages.filter((m) => m.text.includes("appears hung")).length, 0, "no hung alert for a run terminal at emit time");
		assert.equal(
			pi.messages.filter((m) => m.text.includes("going quiet")).length,
			0,
			"no going-quiet drip either — emit skipped entirely",
		);
	} finally {
		stopWatchdog(runId);
		setReverifyLoaderForTests(null);
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("WD-DEDUP: run completing after the first alert yields one completion notice and no repeat hung alerts", async () => {
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	const pi = makePi();
	resetHungAlertDedupForTests();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });
		await waitFor(() => pi.messages.some((m) => m.text.includes("appears hung")), 2000);

		// Run reaches a terminal status between cycles.
		saveRunManifest({ ...manifest, status: "completed" });
		await waitFor(() => pi.messages.some((m) => m.text.includes("run completed")), 2000);
		await sleep(80);

		assert.equal(
			pi.messages.filter((m) => m.text.includes("appears hung")).length,
			1,
			"no repeat hung alert after the run went terminal",
		);
		assert.equal(pi.messages.filter((m) => m.text.includes("run completed")).length, 1, "exactly one completion notice");
	} finally {
		stopWatchdog(runId);
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("WD-DEDUP: hung-alert dedup map is bounded — oldest evicted at cap, no leak", async () => {
	resetHungAlertDedupForTests();
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	const pi = makePi();
	try {
		// Overflow the cap with synthetic runIds — size must stop growing.
		for (let i = 0; i < 1000; i++) markHungAlertForTests(`synthetic-run-${i}`);
		const boundedSize = hungAlertDedupSizeForTests();
		assert.ok(boundedSize > 0 && boundedSize < 1000, `map is bounded (size=${boundedSize}), not 1000`);
		for (let i = 1000; i < 1500; i++) markHungAlertForTests(`synthetic-run-${i}`);
		assert.equal(hungAlertDedupSizeForTests(), boundedSize, "size stays capped after further inserts — no unbounded growth");

		// The eviction means a never-alerted runId can still alert exactly once.
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });
		await waitFor(() => pi.messages.some((m) => m.text.includes("appears hung")), 2000);
		await sleep(80);
		assert.equal(
			pi.messages.filter((m) => m.text.includes("appears hung")).length,
			1,
			"fresh (evicted-oldest) runId still alerts exactly once",
		);
	} finally {
		stopWatchdog(runId);
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * WD-STALE-RECORD (2026-10-23) — the user-visible pain being fixed: the
 * watchdog alerted "run … appears hung" for runs that were actually DONE.
 * Shape of the incident (real runs team_20261023030033 / team_20261023050900):
 * manifest still `running` with a frozen updatedAt, but tasks.json shows every
 * task terminal. The re-verify gate must treat that as terminal (silent hung,
 * one stale-record notice) instead of nagging for a finished run.
 */
test("WD-STALE-RECORD: manifest running + ALL tasks terminal → 0 hung alerts, 1 stale notice", async () => {
	resetHungAlertDedupForTests();
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	saveRunTasks(manifest, [task("do", "completed", runId), task("verify", "failed", runId)]);
	const pi = makePi();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });
		await waitFor(() => pi.messages.some((m) => m.text.includes("record stale")), 2000);
		// Many more cycles: no hung alert, and the stale notice stays a single one.
		await sleep(150);

		assert.equal(
			pi.messages.filter((m) => m.text.includes("appears hung")).length,
			0,
			"no hung alert for a stale record whose tasks are all terminal",
		);
		const notices = pi.messages.filter((m) => m.text.includes("record stale (all tasks terminal) — skipped hung alert"));
		assert.equal(notices.length, 1, "exactly ONE stale-record notice per runId (no spam)");
		assert.ok(notices[0].text.includes(runId), "stale notice names the runId");
		assert.deepEqual(notices[0].options, { deliverAs: "followUp" }, "stale notice delivered as followUp");
	} finally {
		stopWatchdog(runId);
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("WD-STALE-RECORD: manifest running + ONE task still running → hung alert fires (not a stale record)", async () => {
	resetHungAlertDedupForTests();
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	saveRunTasks(manifest, [task("do", "completed", runId), task("verify", "running", runId)]);
	const pi = makePi();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });
		await waitFor(() => pi.messages.some((m) => m.text.includes("appears hung")), 2000);

		assert.equal(
			pi.messages.filter((m) => m.text.includes("appears hung")).length,
			1,
			"one hung alert for a genuinely non-terminal task set",
		);
		assert.equal(pi.messages.filter((m) => m.text.includes("record stale")).length, 0, "no stale notice when work is still in flight");
	} finally {
		stopWatchdog(runId);
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("WD-STALE-RECORD: tasks.json MISSING → no crash and NEVER a stale-record claim (fail-open, pre-existing skip)", async () => {
	resetHungAlertDedupForTests();
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	saveRunTasks(manifest, [task("do", "completed", runId)]);
	// Remove the tasks file AFTER a completed-task write. loadRunManifestById
	// deliberately refuses to serve a run whose tasks.json vanished (state-store
	// cache-miss contract → undefined), so the re-verify sees "manifest gone" and
	// keeps its PRE-EXISTING silent-skip behavior. What must NOT happen is the
	// new stale-record branch treating missing tasks as "all terminal" (that
	// would silence a genuinely hung run).
	fs.rmSync(manifest.tasksPath, { force: true });
	const pi = makePi();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });
		await sleep(150); // many cycles — must not throw, must not claim stale

		assert.equal(
			pi.messages.filter((m) => m.text.includes("record stale")).length,
			0,
			"missing tasks.json is NOT read as 'all tasks terminal'",
		);
		assert.ok(
			pi.messages.every((m) => !m.text.includes("appears hung")),
			"unchanged pre-existing behavior: an unloadable run is skipped, not alerted",
		);
	} finally {
		stopWatchdog(runId);
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("WD-STALE-RECORD: CORRUPT tasks.json → fail-open (legacy hung alert, no crash)", async () => {
	resetHungAlertDedupForTests();
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	saveRunTasks(manifest, [task("do", "completed", runId)]);
	fs.writeFileSync(manifest.tasksPath, "{ this is not json ]]", "utf-8");
	const pi = makePi();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });
		await waitFor(() => pi.messages.some((m) => m.text.includes("appears hung")), 2000);

		assert.equal(
			pi.messages.filter((m) => m.text.includes("appears hung")).length,
			1,
			"corrupt tasks.json keeps the legacy hung alert (fail-open)",
		);
		assert.equal(pi.messages.filter((m) => m.text.includes("record stale")).length, 0, "a broken tasks file never silences a hung run");
	} finally {
		stopWatchdog(runId);
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("WD-STALE-RECORD: stale notice is per-runId across watchdog restarts (module-scope dedup)", async () => {
	resetHungAlertDedupForTests();
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	saveRunTasks(manifest, [task("do", "cancelled", runId)]);
	const pi = makePi();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });
		await waitFor(() => pi.messages.some((m) => m.text.includes("record stale")), 2000);
		stopWatchdog(runId);

		// A brand-new watchdog for the same run must not repeat the notice.
		const pi2 = makePi();
		startForegroundWatchdog({ pi: pi2 as never, cwd, runId, checkIntervalMs: 5 });
		await sleep(150);
		assert.equal(
			pi2.messages.filter((m) => m.text.includes("record stale")).length,
			0,
			"fresh watchdog does not re-send the stale notice",
		);
		assert.equal(pi2.messages.filter((m) => m.text.includes("appears hung")).length, 0, "and never a hung alert");
	} finally {
		stopWatchdog(runId);
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("WD-INTERVAL: PI_CREW_WATCHDOG_INTERVAL_MS drives the poll cadence when no explicit interval is given", async () => {
	resetHungAlertDedupForTests();
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	const pi = makePi();
	const previous = process.env.PI_CREW_WATCHDOG_INTERVAL_MS;
	process.env.PI_CREW_WATCHDOG_INTERVAL_MS = "15";
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId }); // no checkIntervalMs → env override
		await waitFor(() => pi.messages.some((m) => m.text.includes("appears hung")), 2000);
		assert.equal(
			pi.messages.filter((m) => m.text.includes("appears hung")).length,
			1,
			"env-driven 15ms cadence produced the alert quickly",
		);
	} finally {
		stopWatchdog(runId);
		if (previous === undefined) delete process.env.PI_CREW_WATCHDOG_INTERVAL_MS;
		else process.env.PI_CREW_WATCHDOG_INTERVAL_MS = previous;
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * WD-DELIVER-GUARD (2026-10-23) — the residual the emit-time gate cannot see.
 *
 * Real incident (run team_20261023050900): the alert was EMITTED while the run
 * was genuinely running, but `sendUserMessage({deliverAs:"followUp"})` parked
 * it in the host's follow-up queue (session streaming) and the host DELIVERED
 * it 28 minutes later — 19s after `run.completed`. Emit-time re-verify can
 * never see that; the guard has to run at the DELIVERY moment. These tests
 * drive the real watchdog with an `isSessionIdle` probe that stays false
 * (session streaming) while the run finishes, then flips true (the host can
 * deliver now) and asserts the alert is dropped.
 */

/** Capture PI_CREW_DEBUG output for drop-log assertions. */
function captureDebugLogs(): { logs: string[]; restore: () => void } {
	const previous = process.env.PI_CREW_DEBUG;
	process.env.PI_CREW_DEBUG = "1";
	const logs: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => {
		logs.push(args.map((a) => String(a)).join(" "));
	};
	return {
		logs,
		restore: () => {
			console.log = original;
			if (previous === undefined) delete process.env.PI_CREW_DEBUG;
			else process.env.PI_CREW_DEBUG = previous;
		},
	};
}

test("WD-DELIVER-GUARD: alert emitted while running is DROPPED when the run finishes before delivery", async () => {
	resetHungAlertDedupForTests();
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	setDeliveryTimingForTests(5, 10_000);
	const debug = captureDebugLogs();
	let sessionIdle = false; // streaming: the host would QUEUE, not deliver
	const pi = makePi();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5, isSessionIdle: () => sessionIdle });

		// The watchdog emitted its hung alert (correct at emit time) while the
		// session streamed → the alert is HELD, not handed to the host queue.
		await waitFor(() => hungAlertDeliveryPendingForTests() === 1, 2000);
		assert.equal(
			pi.messages.filter((m) => m.text.includes("appears hung")).length,
			0,
			"alert is held while the host would only queue it",
		);

		// Run finalizes (real state write) BEFORE delivery can happen.
		saveRunManifest({ ...manifest, status: "completed", updatedAt: new Date().toISOString() });
		sessionIdle = true; // host delivers NOW → the guard re-reads the run state

		await waitFor(() => hungAlertDeliveryPendingForTests() === 0, 2000);
		await sleep(60);

		assert.equal(
			pi.messages.filter((m) => m.text.includes("appears hung")).length,
			0,
			"0 'appears hung' messages: the run was completed at delivery time",
		);
		assert.equal(
			debug.logs.filter((l) => l.includes("drop hung alert") && l.includes(runId)).length,
			1,
			"exactly ONE debug log for the delivery-time drop",
		);
	} finally {
		stopWatchdog(runId);
		debug.restore();
		setDeliveryTimingForTests();
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("WD-DELIVER-GUARD: a run still hung at delivery time IS delivered (exactly one message)", async () => {
	resetHungAlertDedupForTests();
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	setDeliveryTimingForTests(5, 10_000);
	let sessionIdle = false;
	const pi = makePi();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5, isSessionIdle: () => sessionIdle });
		await waitFor(() => hungAlertDeliveryPendingForTests() === 1, 2000);
		assert.equal(pi.messages.length, 0, "nothing handed over while streaming");

		sessionIdle = true; // idle boundary: delivery moment, run is STILL hung
		await waitFor(() => pi.messages.some((m) => m.text.includes("appears hung")), 2000);
		await sleep(80);

		const hung = pi.messages.filter((m) => m.text.includes("appears hung"));
		assert.equal(hung.length, 1, "exactly one hung alert for a genuinely hung run");
		assert.ok(hung[0].text.includes(runId), "names the runId");
		assert.deepEqual(hung[0].options, { deliverAs: "followUp" }, "still delivered as followUp");
		assert.equal(hungAlertDeliveryPendingForTests(), 0, "nothing left pending after the handover");
	} finally {
		stopWatchdog(runId);
		setDeliveryTimingForTests();
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("WD-DELIVER-GUARD: unreadable / indeterminate state at delivery FAILS OPEN (alert still delivered)", async () => {
	// (a) loader throws — e.g. EACCES while reading tasks.json.
	resetHungAlertDedupForTests();
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	setDeliveryTimingForTests(5, 10_000);
	let sessionIdle = false;
	const pi = makePi();
	try {
		setDeliveryLoaderForTests(() => {
			throw new Error("EACCES: permission denied, open 'tasks.json'");
		});
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5, isSessionIdle: () => sessionIdle });
		await waitFor(() => hungAlertDeliveryPendingForTests() === 1, 2000);
		sessionIdle = true;
		await waitFor(() => pi.messages.some((m) => m.text.includes("appears hung")), 2000);
		assert.equal(
			pi.messages.filter((m) => m.text.includes("appears hung")).length,
			1,
			"an unreadable state file NEVER swallows the alert (fail-open)",
		);
	} finally {
		stopWatchdog(runId);
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}

	// (b) manifest vanished between emit and delivery → indeterminate → deliver.
	resetHungAlertDedupForTests();
	const second = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(second.manifest, [queuedAgent(second.runId)]);
	setDeliveryTimingForTests(5, 10_000);
	let idle2 = false;
	const pi2 = makePi();
	try {
		setDeliveryLoaderForTests(() => undefined as never);
		startForegroundWatchdog({ pi: pi2 as never, cwd: second.cwd, runId: second.runId, checkIntervalMs: 5, isSessionIdle: () => idle2 });
		await waitFor(() => hungAlertDeliveryPendingForTests() === 1, 2000);
		idle2 = true;
		await waitFor(() => pi2.messages.some((m) => m.text.includes("appears hung")), 2000);
		assert.equal(
			pi2.messages.filter((m) => m.text.includes("appears hung")).length,
			1,
			"a vanished manifest is indeterminate → alert delivered (fail-open)",
		);
	} finally {
		stopWatchdog(second.runId);
		setDeliveryTimingForTests();
		resetHungAlertDedupForTests();
		fs.rmSync(second.cwd, { recursive: true, force: true });
	}
});

test("WD-DELIVER-GUARD: the drop happens once per runId — dedup + no drip across cycles", async () => {
	resetHungAlertDedupForTests();
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	setDeliveryTimingForTests(5, 10_000);
	const debug = captureDebugLogs();
	let sessionIdle = false;
	const pi = makePi();
	try {
		// Delivery-time read says terminal while the ON-DISK manifest stays hung,
		// so the watchdog keeps cycling and re-evaluating the same runId.
		setDeliveryLoaderForTests(() => ({ manifest: { ...manifest, status: "cancelled" }, tasks: [] }));
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5, isSessionIdle: () => sessionIdle });
		await waitFor(() => hungAlertDeliveryPendingForTests() === 1, 2000);
		sessionIdle = true;
		await waitFor(() => hungAlertDeliveryPendingForTests() === 0, 2000);

		// Many further hung cycles — dedup must suppress any re-queue.
		await sleep(150);
		assert.equal(
			pi.messages.filter((m) => m.text.includes("appears hung")).length,
			0,
			"no hung alert ever reaches the session for the dropped run",
		);
		assert.equal(hungAlertDeliveryPendingForTests(), 0, "nothing re-queued after the drop (dedup intact)");
		assert.equal(
			debug.logs.filter((l) => l.includes("drop hung alert") && l.includes(runId)).length,
			1,
			"the drop is logged once per runId, not per cycle",
		);
	} finally {
		stopWatchdog(runId);
		debug.restore();
		setDeliveryTimingForTests();
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("WD-DELIVER-GUARD: no idle probe (legacy caller) → verify-then-send, still guarded at handoff", async () => {
	resetHungAlertDedupForTests();
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	const pi = makePi();
	try {
		// Emit-time re-verify says running (alert is emitted), delivery-time read
		// says completed → the handoff guard drops it even without an idle probe.
		setDeliveryLoaderForTests(() => ({ manifest: { ...manifest, status: "completed" }, tasks: [] }));
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });
		await sleep(150);
		assert.equal(
			pi.messages.filter((m) => m.text.includes("appears hung")).length,
			0,
			"handoff guard applies with no idle capability (pre-fix callers stay safe)",
		);
	} finally {
		stopWatchdog(runId);
		resetHungAlertDedupForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
