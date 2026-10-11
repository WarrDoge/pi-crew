/**
 * M3-1 (UI-AUDIT P0-2/P1-1): the terminal-status controller must actually be
 * WIRED. Before this fix `createTerminalStatusController` was only ever
 * constructed by its own unit tests (test/unit/t4-terminal-status.test.ts);
 * `ctx.terminalStatus` was never assigned, so neither the tab title nor the
 * Ghostty OSC 9;4 progress bar ever ran in production.
 *
 * These tests drive the REAL wiring module: events go through the real
 * `runEventBus`, evaluation runs on (mocked) timers, Ghostty sequences are
 * captured through the module's `setGhosttyWriterForTest` seam, and the
 * live-agent count comes from the wiring module's probe seam.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
	__test__resetTerminalStatusWiring,
	__test__setBlockedProbe,
	__test__setLiveAgentProbe,
	blockedSignalFromManifest,
	blockedSignalFromSubagentDir,
	installTerminalStatus,
	type TerminalBlockedSignal,
	type TerminalStatusWiringDeps,
} from "../../../../src/extension/registration/terminal-status-wiring.ts";
import { runEventBus } from "../../../../src/ui/run-event-bus.ts";
import { setGhosttyWriterForTest } from "../../../../src/ui/terminal-status.ts";

/** Ghostty OSC 9;4 sequences the controller emits (mirrors terminal-status.ts). */
const SEQ_INDETERMINATE = "\u001b]9;4;3\u0007";
const SEQ_COMPLETE_100 = "\u001b]9;4;1;100\u0007";
const SEQ_CLEAR = "\u001b]9;4;0\u0007";
const IDLE_TITLE = "π-crew";

interface Harness {
	writes: string[];
	titles: string[];
	deps: TerminalStatusWiringDeps;
	dispose: () => void;
}

function makeHarness(): Harness {
	const writes: string[] = [];
	const titles: string[] = [];
	setGhosttyWriterForTest((seq: string) => writes.push(seq));
	const deps: TerminalStatusWiringDeps = {
		currentCtx: { hasUI: true, ui: { setTitle: (t: string) => titles.push(t) } },
		terminalStatus: undefined,
		terminalStatusActive: false,
	};
	// Minimal pi: registerCleanupHandler only needs pi.on(...) bookkeeping.
	const handlers = new Map<string, Array<() => void>>();
	const pi = {
		on: (event: string, handler: () => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const current = handlers.get(event) ?? [];
				const idx = current.indexOf(handler);
				if (idx >= 0) current.splice(idx, 1);
			};
		},
	} as never;
	__test__resetTerminalStatusWiring();
	installTerminalStatus(pi, deps);
	return {
		writes,
		titles,
		deps,
		// Runs the REAL dispose closure (unsubscribe + timers + controller), the
		// same fn the signal handler would call — NOT the session_shutdown path
		// (crew-cleanup.ts only wires terminalStatusDispose to SIGTERM/SIGHUP).
		dispose: () => __test__resetTerminalStatusWiring(),
	};
}

/** Advance mocked timers then flush the real microtask/macrotask queues. */
async function advance(ms: number): Promise<void> {
	// 1) Let runEventBus's microtask fan-out run and arm the (mocked) timer.
	await new Promise((resolve) => setImmediate(resolve));
	// 2) Fire the mocked timers.
	mock.timers.tick(ms);
	// 3) Let timer-callback microtasks settle before returning.
	await new Promise((resolve) => setImmediate(resolve));
}

describe("M3-1: terminal-status wiring (P0-2/P1-1)", () => {
	beforeEach(() => {
		mock.timers.enable({ apis: ["setTimeout"] });
		// Hermeticity (B-1): the DEFAULT blocked probe reads the real active-run
		// registry under the user crew root — ambient state on the dev machine
		// must never leak into these tests (same discipline as the env-scrub
		// gotchas in .crew/knowledge.md).
		__test__setBlockedProbe(() => undefined);
	});

	afterEach(() => {
		__test__setLiveAgentProbe(() => 0);
		__test__setBlockedProbe(() => undefined);
		__test__resetTerminalStatusWiring();
		setGhosttyWriterForTest(undefined);
		mock.timers.reset();
	});

	it("run events construct the controller and drive the ACTIVE phase", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 2); // 2 live agents → active
		assert.equal(h.deps.terminalStatus, undefined, "controller must be lazy (constructed on first event)");

		runEventBus.emit({ type: "run_started", runId: "team_w1" });
		await advance(300); // > EVAL_DEBOUNCE_MS (250)

		assert.ok(h.deps.terminalStatus, "controller must be constructed after the first run event");
		assert.equal(h.deps.terminalStatusActive, true, "ctx.terminalStatusActive must latch in the active phase");
		assert.ok(h.writes.includes(SEQ_INDETERMINATE), `Ghostty INDETERMINATE not emitted: ${JSON.stringify(h.writes)}`);
		h.dispose();
	});

	it("an event burst collapses into ONE evaluation (debounced)", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 1);
		runEventBus.emit({ type: "run_started", runId: "team_w2" });
		runEventBus.emit({ type: "task_started", runId: "team_w2", taskId: "t1" });
		runEventBus.emit({ type: "worker_status", runId: "team_w2", taskId: "t1" });
		runEventBus.emit({ type: "task_completed", runId: "team_w2", taskId: "t1" });
		await advance(400);

		// One INDETERMINATE write per transition, not one per event.
		assert.equal(
			h.writes.filter((s) => s === SEQ_INDETERMINATE).length,
			1,
			`burst must coalesce to a single INDETERMINATE write: ${JSON.stringify(h.writes)}`,
		);
		h.dispose();
	});

	it("completion drives the flash, then IDLE (title restore + clear) after COMPLETE_FLASH_MS", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 1);
		runEventBus.emit({ type: "run_started", runId: "team_w3" });
		await advance(300);
		assert.equal(h.deps.terminalStatusActive, true);

		__test__setLiveAgentProbe(() => 0); // agents gone → idle transition
		runEventBus.emit({ type: "run_completed", runId: "team_w3" });
		await advance(300);

		assert.equal(h.deps.terminalStatusActive, false, "active flag must drop on the idle transition");
		assert.ok(h.writes.includes(SEQ_COMPLETE_100), `green flash missing: ${JSON.stringify(h.writes)}`);
		assert.ok(!h.writes.includes(SEQ_CLEAR), "flash must NOT be cleared immediately");
		assert.ok(!h.titles.includes(IDLE_TITLE), "idle title must not be set before the flash window ends");

		await advance(1500); // COMPLETE_FLASH_MS
		assert.ok(h.writes.includes(SEQ_CLEAR), `Ghostty CLEAR missing after flash: ${JSON.stringify(h.writes)}`);
		assert.ok(h.titles.includes(IDLE_TITLE), `idle title restore missing: ${JSON.stringify(h.titles)}`);
		h.dispose();
	});

	it("a new run during the flash window cancels the idle transition", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 1);
		runEventBus.emit({ type: "run_started", runId: "team_w4" });
		await advance(300);

		__test__setLiveAgentProbe(() => 0);
		runEventBus.emit({ type: "run_completed", runId: "team_w4" });
		await advance(300); // flash armed, idle pending

		__test__setLiveAgentProbe(() => 3); // another run starts before the flash ends
		runEventBus.emit({ type: "run_started", runId: "team_w5" });
		await advance(300);
		await advance(2000); // flash window fully elapsed

		assert.equal(h.deps.terminalStatusActive, true, "must be active again");
		assert.ok(!h.writes.includes(SEQ_CLEAR), "idle CLEAR must be cancelled by the new run");
		assert.ok(!h.titles.includes(IDLE_TITLE), "idle title must not be restored mid-run");
		h.dispose();
	});

	it("headless (hasUI=false) evaluates to a no-op — nothing is written", async () => {
		const h = makeHarness();
		h.deps.currentCtx = { hasUI: false, ui: { setTitle: () => undefined } };
		__test__setLiveAgentProbe(() => 5);
		runEventBus.emit({ type: "run_started", runId: "team_w6" });
		await advance(400);

		assert.equal(h.deps.terminalStatus, undefined, "no controller may be constructed headless");
		assert.deepEqual(h.writes, [], "no Ghostty writes headless");
		assert.deepEqual(h.titles, [], "no title writes headless");
		h.dispose();
	});

	it("dispose unsubscribes: later events write nothing", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 1);
		runEventBus.emit({ type: "run_started", runId: "team_w7" });
		await advance(300);
		h.dispose();
		// controller.dispose() itself best-effort-clears the Ghostty bar — that
		// write is expected, so snapshot AFTER dispose.
		const writesAfterDispose = h.writes.length;

		__test__setLiveAgentProbe(() => 0);
		runEventBus.emit({ type: "run_completed", runId: "team_w7" });
		await advance(300);
		await advance(2000);

		assert.equal(h.writes.length, writesAfterDispose, "events after dispose must not write anything");
		assert.equal(h.deps.terminalStatus, undefined, "controller must be released on dispose");
		assert.equal(h.deps.terminalStatusActive, false, "active flag must be reset on dispose");
	});
});

describe("B-1: blocked-state mapping → OSC 7501 program-status", () => {
	const ST = "\x1b\\";
	const msgB64 = Buffer.from("task t1 waiting for leader · team_b1", "utf8").toString("base64");
	const SEQ_7501_BLOCKED = `\x1b]7501;state=blocked:app=pi-crew:kind=question:msg=${msgB64}${ST}`;
	const SEQ_7501_WORKING = `\x1b]7501;state=working:app=pi-crew${ST}`;
	const SEQ_7501_IDLE = `\x1b]7501;state=idle:app=pi-crew${ST}`;
	const parkSignal: TerminalBlockedSignal = {
		kind: "question",
		message: "task t1 waiting for leader · team_b1",
	};

	beforeEach(() => {
		mock.timers.enable({ apis: ["setTimeout"] });
		__test__setBlockedProbe(() => undefined);
	});

	afterEach(() => {
		__test__setLiveAgentProbe(() => 0);
		__test__setBlockedProbe(() => undefined);
		__test__resetTerminalStatusWiring();
		setGhosttyWriterForTest(undefined);
		mock.timers.reset();
	});

	it("a blocked signal shows OSC 7501 blocked even with ZERO live agents (ask park)", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 0); // child-process run: no live-session agents
		__test__setBlockedProbe(() => parkSignal);
		runEventBus.emit({ type: "mailbox_updated", runId: "team_b1", taskId: "t1" });
		await advance(300);

		assert.ok(h.deps.terminalStatus, "controller must be constructed for a blocked crew");
		assert.equal(h.deps.terminalStatusActive, true, "blocked counts as active for the lifecycle");
		assert.ok(h.writes.includes(SEQ_7501_BLOCKED), `7501 blocked missing: ${JSON.stringify(h.writes)}`);
		assert.ok(h.writes.includes(SEQ_INDETERMINATE), "Ghostty pulse kept while blocked");
		h.dispose();
	});

	it("a persistent blocked signal is deduped — one 7501 write per signal change", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 0);
		__test__setBlockedProbe(() => parkSignal);
		runEventBus.emit({ type: "mailbox_updated", runId: "team_b1", taskId: "t1" });
		runEventBus.emit({ type: "worker_status", runId: "team_b1", taskId: "t1" });
		runEventBus.emit({ type: "effectiveness_changed", runId: "team_b1" });
		await advance(400);

		assert.equal(
			h.writes.filter((s) => s === SEQ_7501_BLOCKED).length,
			1,
			`blocked must be written once per signal: ${JSON.stringify(h.writes)}`,
		);
		h.dispose();
	});

	it("a changed blocked message re-emits (new signal key)", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 0);
		__test__setBlockedProbe(() => parkSignal);
		runEventBus.emit({ type: "mailbox_updated", runId: "team_b1", taskId: "t1" });
		await advance(300);
		const second: TerminalBlockedSignal = { kind: "question", message: "plan approval pending · team_b1" };
		__test__setBlockedProbe(() => second);
		runEventBus.emit({ type: "worker_status", runId: "team_b1" });
		await advance(300);

		const blockedWrites = h.writes.filter((s) => s.startsWith("\x1b]7501;state=blocked"));
		assert.equal(blockedWrites.length, 2, `two distinct signals → two writes: ${JSON.stringify(h.writes)}`);
		h.dispose();
	});

	it("blocked clears while runs are active → re-assert OSC 7501 working", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 1);
		__test__setBlockedProbe(() => parkSignal);
		runEventBus.emit({ type: "run_started", runId: "team_b1" });
		await advance(300);
		assert.ok(h.writes.includes(SEQ_7501_BLOCKED), "blocked first");

		__test__setBlockedProbe(() => undefined); // leader answered
		runEventBus.emit({ type: "task_started", runId: "team_b1", taskId: "t2" });
		await advance(300);
		assert.ok(h.writes.includes(SEQ_7501_WORKING), `7501 working re-assert missing: ${JSON.stringify(h.writes)}`);
		h.dispose();
	});

	it("blocked clears with no live agents → completion flash then idle (7501 idle)", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 0);
		__test__setBlockedProbe(() => parkSignal);
		runEventBus.emit({ type: "run_started", runId: "team_b1" });
		await advance(300);

		__test__setBlockedProbe(() => undefined);
		runEventBus.emit({ type: "run_completed", runId: "team_b1" });
		await advance(300);
		assert.ok(h.writes.includes(SEQ_COMPLETE_100), "green flash on unblock");
		await advance(1600);
		assert.ok(h.writes.includes(SEQ_CLEAR), "Ghostty cleared after flash");
		assert.ok(h.writes.includes(SEQ_7501_IDLE), `7501 idle missing: ${JSON.stringify(h.writes)}`);
		assert.ok(h.titles.includes(IDLE_TITLE), "idle title restored");
		h.dispose();
	});

	it("headless: a blocked signal writes nothing (probe not even consulted)", async () => {
		const h = makeHarness();
		h.deps.currentCtx = { hasUI: false, ui: { setTitle: () => undefined } };
		__test__setLiveAgentProbe(() => 3);
		__test__setBlockedProbe(() => {
			throw new Error("probe must not run headless");
		});
		runEventBus.emit({ type: "run_started", runId: "team_b9" });
		await advance(400);
		assert.equal(h.deps.terminalStatus, undefined, "no controller headless");
		assert.deepEqual(h.writes, [], "no writes headless");
		h.dispose();
	});

	it("a throwing probe is treated as no-signal (best-effort, never fails eval)", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 1);
		__test__setBlockedProbe(() => {
			throw new Error("registry unreadable");
		});
		runEventBus.emit({ type: "run_started", runId: "team_b2" });
		await advance(300);
		assert.equal(h.deps.terminalStatusActive, true, "active path unaffected");
		assert.ok(h.writes.includes(SEQ_7501_WORKING), "working asserted");
		h.dispose();
	});

	it("blockedSignalFromManifest: plan approval / fresh park / leaked park", () => {
		const now = Date.now();
		// Plan approval pending (mirrors isPlanApprovalStatePending).
		assert.deepEqual(blockedSignalFromManifest({ planApproval: { required: true, status: "pending" } }, now), {
			kind: "question",
			message: "plan approval pending",
		});
		// Pending WITHOUT required must not light up (WP-3 review F2 discipline).
		assert.equal(blockedSignalFromManifest({ planApproval: { status: "pending" } }, now), undefined);
		// Fresh waitState (ask park within the 1h deadline window).
		assert.deepEqual(blockedSignalFromManifest({ waitState: { taskId: "t7", askedAt: new Date(now - 60_000).toISOString() } }, now), {
			kind: "question",
			message: "task t7 waiting for leader",
		});
		// Leaked waitState (older than the freshness window) must NOT block.
		assert.equal(
			blockedSignalFromManifest({ waitState: { taskId: "t7", askedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString() } }, now),
			undefined,
		);
		// Healthy run: nothing.
		assert.equal(blockedSignalFromManifest({ status: "running" }, now), undefined);
	});

	it("blockedSignalFromSubagentDir: finds a blocked record, skips healthy ones", () => {
		const dir = mkdtempSync(`${tmpdir()}/pi-crew-subagents-`);
		// Param is the PROJECT CREW ROOT — records live under state/subagents/.
		const records = `${dir}/state/subagents`;
		mkdirSync(records, { recursive: true });
		try {
			writeFileSync(`${records}/alpha.json`, JSON.stringify({ id: "alpha", status: "running" }));
			writeFileSync(`${records}/beta.json`, JSON.stringify({ id: "beta", status: "blocked" }));
			assert.equal(blockedSignalFromSubagentDir(dir), "beta");
			// All healthy → undefined.
			writeFileSync(`${records}/beta.json`, JSON.stringify({ id: "beta", status: "completed" }));
			assert.equal(blockedSignalFromSubagentDir(dir), undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		// Absent dir → undefined (no throw).
		assert.equal(blockedSignalFromSubagentDir(`${tmpdir()}/pi-crew-nonexistent-dir`), undefined);
	});
});
