/**
 * R41-4 / M3-12 — cap eviction must abort + dispose BEFORE removing the record,
 * and abort() must be deadline-bounded.
 *
 * Before the fix the cap block was a bare `liveAgents.delete(...)`: the evicted
 * session was never aborted and never disposed, so the registry could drop a
 * RUNNING record while its session kept executing (an untracked live worker);
 * and terminateLiveAgent awaited `session.abort()` with no deadline, so a
 * session whose abort never settles deferred the whole teardown forever.
 *
 * PIN NOTE: the wave's pre-fix probe `fixwave6-sdd-2026-10-19/probes/r50b-s1/
 * probe-b.mjs` encodes the DEFECT as its expectation (abortCalls=0 /
 * disposeCalls=0 / terminated=false / insertion-order eviction). Re-running it
 * after this fix inverts exactly those four assertions — that inversion IS the
 * fix, not a regression. These tests encode the correct (post-fix) behavior.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
	__test__abortLiveSessionWithDeadline,
	__test__LIVE_AGENT_ABORT_DEADLINE_MS,
	clearLiveAgentsForTest,
	getLiveAgent,
	type LiveAgentHandle,
	listLiveAgents,
	registerLiveAgent,
	terminateLiveAgent,
} from "../../../../src/runtime/live-session/live-agent-manager.ts";

const MAX_LIVE_AGENTS = 5_000;

interface SessionLog {
	events: string[];
	/** Registry state observed AT THE MOMENT abort()/dispose() ran. */
	registeredWhenAborted?: boolean;
	registeredWhenDisposed?: boolean;
}

function makeSession(id: string, log: SessionLog, opts: { hungAbort?: boolean; rejectAbort?: boolean; abortDelayMs?: number } = {}) {
	return {
		abort: async () => {
			log.events.push(`abort:${id}`);
			log.registeredWhenAborted = getLiveAgent(id) !== undefined;
			if (opts.abortDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.abortDelayMs));
			// Never settles: the code under test must rely on its own deadline.
			if (opts.hungAbort)
				return await new Promise<void>(() => {
					/* intentionally never settles */
				});
			if (opts.rejectAbort) throw new Error("abort failed");
		},
		dispose: () => {
			log.events.push(`dispose:${id}`);
			log.registeredWhenDisposed = getLiveAgent(id) !== undefined;
		},
	};
}

function register(id: string, log: SessionLog, opts: Parameters<typeof makeSession>[2] = {}): LiveAgentHandle {
	return registerLiveAgent({
		agentId: id,
		taskId: `task-${id}`,
		runId: "run-evict",
		workspaceId: "ws",
		role: "executor",
		agent: "explorer",
		status: "running",
		session: makeSession(id, log, opts),
	});
}

function fillToCap(log: SessionLog): void {
	for (let i = 0; i < MAX_LIVE_AGENTS; i++) register(`agent-${i}`, log);
}

describe("R41-4: live-agent cap eviction", () => {
	beforeEach(() => {
		clearLiveAgentsForTest();
	});

	it("evicts the oldest COMPLETED agent by completedAtMs, aborting and disposing before removal", () => {
		const log: SessionLog = { events: [] };
		// MAX-2 plain running agents, then two completed ones whose Map order is the
		// OPPOSITE of their completion order (completedAtMs decides, not insertion).
		for (let i = 0; i < MAX_LIVE_AGENTS - 2; i++) register(`agent-${i}`, log);
		register("completed-newer", log).activity.completedAtMs = 5_000;
		register("completed-older", log).activity.completedAtMs = 1_000;
		assert.equal(listLiveAgents().length, MAX_LIVE_AGENTS);

		const before = log.events.length;
		register("agent-new", log);

		assert.equal(getLiveAgent("completed-older"), undefined, "oldest completed agent was evicted");
		assert.ok(getLiveAgent("completed-newer"), "the newer completed agent survived");
		assert.ok(getLiveAgent("agent-new"), "the new agent is registered");
		assert.equal(listLiveAgents().length, MAX_LIVE_AGENTS, "cap respected after the add");

		const evictionEvents = log.events.slice(before);
		assert.deepEqual(
			evictionEvents.filter((e) => e.startsWith("abort:") || e.startsWith("dispose:")),
			["abort:completed-older", "dispose:completed-older"],
			"the evicted session is aborted then disposed (previously: never)",
		);
		assert.equal(log.registeredWhenAborted, true, "abort runs while the record is still registered");
		assert.equal(log.registeredWhenDisposed, true, "dispose runs while the record is still registered");
	});

	it("evicts the oldest RUNNING agent (no completed one) with the same teardown", () => {
		const log: SessionLog = { events: [] };
		fillToCap(log);
		const before = log.events.length;
		register("agent-new", log);

		assert.equal(getLiveAgent("agent-0"), undefined, "oldest running agent evicted");
		assert.ok(getLiveAgent("agent-new"), "new agent registered");
		assert.deepEqual(
			log.events.slice(before).filter((e) => e.startsWith("abort:") || e.startsWith("dispose:")),
			["abort:agent-0", "dispose:agent-0"],
			"running eviction also aborts + disposes before removing the record",
		);
		assert.equal(log.registeredWhenAborted, true);
		assert.equal(log.registeredWhenDisposed, true);
		assert.equal(listLiveAgents().length, MAX_LIVE_AGENTS);
	});

	it("a hung abort() during eviction does not block registration", () => {
		const log: SessionLog = { events: [] };
		// Registered FIRST → it is the "oldest" entry, which is what the cap
		// evicts when no completed agent exists.
		register("hung-agent", log, { hungAbort: true });
		for (let i = 0; i < MAX_LIVE_AGENTS - 1; i++) register(`agent-${i}`, log);
		assert.equal(listLiveAgents().length, MAX_LIVE_AGENTS);

		const started = Date.now();
		register("agent-new", log); // triggers the cap eviction of hung-agent
		assert.ok(Date.now() - started < 2_000, "registration was not blocked by the hung abort");
		assert.equal(getLiveAgent("hung-agent"), undefined, "hung-abort agent evicted");
		assert.ok(log.events.includes("abort:hung-agent"), "abort was initiated before removal");
		assert.ok(log.events.includes("dispose:hung-agent"), "dispose ran before removal");
	});

	it("the abort deadline resolves a never-settling abort()", async () => {
		const log: SessionLog = { events: [] };
		const hung = register("hung-deadline", log, { hungAbort: true });
		const started = Date.now();
		await __test__abortLiveSessionWithDeadline(hung, 25);
		assert.ok(Date.now() - started < 2_000, "deadline-bounded abort returned promptly");
		assert.ok(
			__test__LIVE_AGENT_ABORT_DEADLINE_MS > 0 && __test__LIVE_AGENT_ABORT_DEADLINE_MS <= 60_000,
			"the production deadline is a sane bound",
		);
	});

	it("terminateLiveAgent tears down even when the abort never settles (deadline-bounded)", { timeout: 30_000 }, async () => {
		const log: SessionLog = { events: [] };
		register("hung", log, { hungAbort: true });
		const started = Date.now();
		const terminated = await terminateLiveAgent("hung");
		const elapsed = Date.now() - started;

		assert.ok(terminated, "terminate returned the handle");
		assert.equal(getLiveAgent("hung"), undefined, "record removed despite the hung abort");
		assert.equal(terminated?.terminated, true, "handle marked terminal");
		assert.ok(log.events.includes("dispose:hung"), "session disposed");
		assert.ok(elapsed >= __test__LIVE_AGENT_ABORT_DEADLINE_MS - 1_000, "waited for the deadline before force-tearing down");
		assert.ok(elapsed < 20_000, "but did not hang forever");
	});

	it("terminateLiveAgent still tears down (and propagates) when abort rejects", async () => {
		const log: SessionLog = { events: [] };
		register("rejecting", log, { rejectAbort: true });
		await assert.rejects(() => terminateLiveAgent("rejecting"), /abort failed/, "abort failure propagates after teardown");
		assert.equal(getLiveAgent("rejecting"), undefined, "teardown ran in the finally block");
		assert.ok(log.events.includes("dispose:rejecting"));
	});

	it("terminateLiveAgent does not remove a handle re-registered during its bounded abort", async () => {
		const log: SessionLog = { events: [] };
		register("dup", log, { abortDelayMs: 50 });
		// D4-style handoff: the same agentId re-registered with a FRESH session while
		// the old handle's abort is still in flight. The identity-checked delete must
		// keep the live replacement.
		const pending = terminateLiveAgent("dup");
		const fresh = register("dup", log);
		await pending;
		assert.equal(getLiveAgent("dup"), fresh, "the re-registered handle survived terminate's delete");
	});
});
