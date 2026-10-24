/**
 * R39-M3 (fix-wave 6, EP3) — orphan reaper unit pin.
 *
 * Pins the conservative safety model: a recorded worker pid is reaped ONLY when
 * it is alive, not self/ancestor, and inside the authoritative orphan set. All
 * IO is injected so no real process is ever signalled.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { collectWorkerPidEvidence, reapOrphanWorkers, reapRecordedWorkerOrphans } from "../../../../src/runtime/process/orphan-reaper.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";

function task(overrides: Partial<TeamTaskState> & { id: string; status: TeamTaskState["status"] }): TeamTaskState {
	return {
		runId: "run-x",
		role: "executor",
		agent: "executor",
		title: "t",
		dependsOn: [],
		cwd: "/tmp",
		...overrides,
	} as TeamTaskState;
}

test("collectWorkerPidEvidence: only in-flight tasks with a recorded pid, deduped", () => {
	const tasks = [
		task({ id: "t1", status: "running", heartbeat: { pid: 4242 } as TeamTaskState["heartbeat"] }),
		task({ id: "t2", status: "running", heartbeat: { pid: 4242 } as TeamTaskState["heartbeat"] }), // dup pid
		task({ id: "t3", status: "waiting", checkpoint: { childPid: 5151 } as TeamTaskState["checkpoint"] }),
		task({ id: "t4", status: "running" }), // no pid recorded
		task({ id: "t5", status: "completed", heartbeat: { pid: 6262 } as TeamTaskState["heartbeat"] }), // terminal
		task({ id: "t6", status: "running", heartbeat: { pid: 1 } as TeamTaskState["heartbeat"] }), // init
	];
	const evidence = collectWorkerPidEvidence(tasks);
	assert.deepEqual(evidence, [
		{ taskId: "t1", pid: 4242 },
		{ taskId: "t3", pid: 5151 },
	]);
});

test("reapOrphanWorkers: SIGTERMs alive, allowed, unprotected pids; skips the rest", () => {
	const killed: Array<{ pid: number; signal: string }> = [];
	const result = reapOrphanWorkers(
		[
			{ taskId: "a", pid: 1000 },
			{ taskId: "b", pid: 2000 },
			{ taskId: "c", pid: 3000 },
			{ taskId: "self", pid: process.pid },
			{ taskId: "init", pid: 1 },
		],
		{
			isAlive: (pid) => pid !== 2000, // 2000 is already dead
			kill: (pid, signal) => {
				killed.push({ pid, signal: String(signal) });
			},
			protectedPids: new Set([process.pid]),
			allowedPids: new Set([1000, 2000, 3000]), // authoritative orphan set
		},
	);

	assert.deepEqual(result.reaped, [1000, 3000]);
	assert.deepEqual(killed, [
		{ pid: 1000, signal: "SIGTERM" },
		{ pid: 3000, signal: "SIGTERM" },
	]);
	assert.ok(result.skipped.some((s) => s.pid === 2000 && s.reason === "already-dead"));
	assert.ok(result.skipped.some((s) => s.pid === process.pid && s.reason === "protected-self-or-ancestor"));
	assert.ok(result.skipped.some((s) => s.pid === 1 && s.reason === "invalid-or-init-pid"));
});

test("reapOrphanWorkers: a pid outside the authoritative orphan set is NEVER killed", () => {
	const killed: number[] = [];
	const result = reapOrphanWorkers([{ taskId: "a", pid: 7777 }], {
		isAlive: () => true,
		kill: (pid) => killed.push(pid),
		allowedPids: new Set([8888]),
	});
	assert.deepEqual(result.reaped, []);
	assert.deepEqual(killed, []);
	assert.deepEqual(result.skipped, [{ pid: 7777, reason: "not-an-authoritative-orphan" }]);
});

test("reapOrphanWorkers: dry-run reports candidates without killing", () => {
	const killed: number[] = [];
	const result = reapOrphanWorkers([{ taskId: "a", pid: 1234 }], {
		isAlive: () => true,
		kill: (pid) => killed.push(pid),
		dryRun: true,
	});
	assert.deepEqual(result.reaped, []);
	assert.deepEqual(result.candidates, [1234]);
	assert.deepEqual(killed, []);
});

test("reapRecordedWorkerOrphans: no recorded pid → no-op", () => {
	const result = reapRecordedWorkerOrphans([task({ id: "t1", status: "running" })]);
	assert.deepEqual(result.reaped, []);
	assert.deepEqual(result.candidates, []);
});

// ── Wave 11a (F2): identity-proven admission + guarded group reaping ─────────
//
// Everything below injects the identity reader, the group liveness probe and
// BOTH signal senders — no real process and no real pgid is ever signalled.

const selfUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

interface SignalLog {
	pidSignals: Array<{ pid: number; signal: string }>;
	groupSignals: string[];
}

function signalSpies(log: SignalLog) {
	return {
		kill: (pid: number, signal: NodeJS.Signals) => log.pidSignals.push({ pid, signal: String(signal) }),
		killGroup: (pgid: number, signal: NodeJS.Signals) => log.groupSignals.push(`${pgid}:${signal}`),
	};
}

function newLog(): SignalLog {
	return { pidSignals: [], groupSignals: [] };
}

test("(c1) legacy record without pgid/starttime keeps the pid-only SIGTERM path", () => {
	const log = newLog();
	const result = reapOrphanWorkers([{ taskId: "a", pid: 4000 }], {
		isAlive: () => true,
		readIdentity: () => undefined,
		groupAlive: () => false,
		allowedPids: new Set([4000]),
		...signalSpies(log),
	});
	assert.deepEqual(result.reaped, [4000]);
	assert.deepEqual(log.pidSignals, [{ pid: 4000, signal: "SIGTERM" }]);
	assert.deepEqual(log.groupSignals, [], "no group signal without a known pgid");
	assert.deepEqual(result.pending, []);
});

test("(c2) identity-proven pid uses the GROUP path and bypasses the allowed-pid gate", () => {
	const log = newLog();
	const result = reapOrphanWorkers([{ taskId: "a", pid: 4000, pgid: 4000, starttime: "555", uid: selfUid() }], {
		isAlive: () => true,
		readIdentity: (pid) => ({ pid, pgid: 4000, starttime: "555", uid: selfUid() }),
		groupAlive: () => false, // group died from the synchronous SIGTERM prefix
		allowedPids: new Set([9999]), // scan set does NOT contain 4000 — starttime proof wins
		...signalSpies(log),
	});
	assert.deepEqual(result.reaped, [4000]);
	assert.deepEqual(log.groupSignals, ["4000:SIGTERM"], "the pgid (not the pid) must be signalled");
	assert.deepEqual(log.pidSignals, [], "the pid-only path must not run when the group path is taken");
});

test("(c3) a refused group falls back to the pid-only path — recorded in ONE array only (MINOR #6)", () => {
	const log = newLog();
	const result = reapOrphanWorkers([{ taskId: "a", pid: 4000, pgid: 4000, starttime: "555", uid: selfUid() }], {
		isAlive: () => true,
		// Live identity says the candidate belongs to a DIFFERENT group ⇒ ladder refuses.
		readIdentity: (pid) => ({ pid, pgid: 7777, starttime: "555", uid: selfUid() }),
		groupAlive: () => true,
		...signalSpies(log),
	});
	assert.deepEqual(log.groupSignals, [], "a refused group must never be signalled");
	assert.deepEqual(log.pidSignals, [{ pid: 4000, signal: "SIGTERM" }], "legacy pid-only fallback still runs");
	assert.deepEqual(result.reaped, [4000]);
	assert.ok(
		!result.skipped.some((s) => s.pid === 4000),
		`a REAPED pid must not also appear in skipped (double accounting): ${JSON.stringify(result.skipped)}`,
	);
});

test("(c4) zombie-scan throw is fail-open: identity-proven pids reap, unproven ones do not", () => {
	const log = newLog();
	const result = reapRecordedWorkerOrphans(
		[
			task({
				id: "proven",
				status: "running",
				heartbeat: { pid: 4000, pgid: 4000, starttime: "555", uid: selfUid() } as TeamTaskState["heartbeat"],
			}),
			task({ id: "unproven", status: "running", heartbeat: { pid: 5000 } as TeamTaskState["heartbeat"] }),
		],
		{
			isAlive: () => true,
			readIdentity: (pid) => ({ pid, pgid: pid, starttime: "555", uid: selfUid() }),
			groupAlive: () => false,
			scanZombies: () => {
				throw new Error("scanner exploded");
			},
			...signalSpies(log),
		},
	);
	assert.deepEqual(result.reaped, [4000], "identity-proven pid still reaps when the scan throws");
	assert.ok(!result.skipped.some((s) => s.reason === "zombie-scan-unavailable"), "the pre-wave blanket no-op reason must be gone");
	assert.ok(
		result.skipped.some((s) => s.pid === 5000 && s.reason === "not-an-authoritative-orphan"),
		"an unproven pid stays untouched",
	);
});

test("(c5) reaping is idempotent — a second pass on a dead pid signals nothing", () => {
	const log = newLog();
	let alive = true;
	const opts = {
		isAlive: () => alive,
		readIdentity: () => undefined,
		groupAlive: () => false,
		...signalSpies(log),
	};
	const first = reapOrphanWorkers([{ taskId: "a", pid: 4000 }], opts);
	assert.deepEqual(first.reaped, [4000]);
	assert.equal(log.pidSignals.length, 1);
	alive = false;
	const second = reapOrphanWorkers([{ taskId: "a", pid: 4000 }], opts);
	assert.deepEqual(second.reaped, []);
	assert.ok(second.skipped.some((s) => s.pid === 4000 && s.reason === "already-dead"));
	assert.equal(log.pidSignals.length, 1, "the second pass must not signal again");
});

test("(c6) PI_CREW_REAP_GROUP=0 degrades the group path to pid-only (single accounting)", () => {
	const log = newLog();
	const saved = process.env.PI_CREW_REAP_GROUP;
	process.env.PI_CREW_REAP_GROUP = "0";
	try {
		const result = reapOrphanWorkers([{ taskId: "a", pid: 4000, pgid: 4000, starttime: "555", uid: selfUid() }], {
			isAlive: () => true,
			readIdentity: (pid) => ({ pid, pgid: 4000, starttime: "555", uid: selfUid() }),
			groupAlive: () => false,
			...signalSpies(log),
		});
		assert.deepEqual(log.groupSignals, [], "kill switch must disable group signalling");
		assert.deepEqual(log.pidSignals, [{ pid: 4000, signal: "SIGTERM" }], "pid-only fallback remains");
		assert.deepEqual(result.reaped, [4000], "the pid is still reaped (pid-only, pre-wave behaviour)");
		assert.ok(!result.skipped.some((s) => s.pid === 4000), "MINOR #6: a reaped pid must not also be reported as skipped");
	} finally {
		if (saved === undefined) delete process.env.PI_CREW_REAP_GROUP;
		else process.env.PI_CREW_REAP_GROUP = saved;
	}
});

test("(c7) identity proof requires LEADER proof — a non-leader pgid is never admitted", () => {
	// MAJOR #2: `pgid !== pid` can be the HOST's group (rpc / useGroup=false). A
	// matching starttime alone used to bypass the authoritative-orphan gate.
	const log = newLog();
	const result = reapOrphanWorkers([{ taskId: "a", pid: 4000, pgid: 5000, starttime: "555", uid: selfUid() }], {
		isAlive: () => true,
		readIdentity: (pid) => ({ pid, pgid: 5000, starttime: "555", uid: selfUid() }),
		groupAlive: () => true,
		allowedPids: new Set([9999]), // scan set does NOT contain 4000
		...signalSpies(log),
	});
	assert.deepEqual(result.reaped, []);
	assert.deepEqual(log.groupSignals, []);
	assert.deepEqual(log.pidSignals, []);
	assert.deepEqual(result.skipped, [{ pid: 4000, reason: "not-an-authoritative-orphan" }]);
});

test("(c8) dead candidate + non-leader snapshot ⇒ group refused, skipped exactly once", () => {
	const log = newLog();
	const result = reapOrphanWorkers([{ taskId: "a", pid: 4000, pgid: 5000, starttime: "555", uid: selfUid() }], {
		isAlive: () => false,
		// self readable (rung 1), candidate + leader gone from /proc
		readIdentity: (pid) => (pid === process.pid ? { pid, pgid: process.pid, starttime: "1", uid: selfUid() } : undefined),
		groupAlive: () => true,
		...signalSpies(log),
	});
	assert.deepEqual(log.groupSignals, [], "nothing may be signalled");
	assert.deepEqual(log.pidSignals, []);
	assert.deepEqual(result.reaped, []);
	assert.deepEqual(
		result.skipped.filter((s) => s.pid === 4000),
		[{ pid: 4000, reason: "group-refused:identity-missing" }],
		"exactly one skipped entry, carrying the leader-proof refusal reason",
	);
});

test("(c9) escalate:false still COLLECTS the escalation (never dropped, never rejects)", () => {
	const log = newLog();
	const result = reapOrphanWorkers([{ taskId: "a", pid: 4000, pgid: 4000, starttime: "555", uid: selfUid() }], {
		isAlive: () => true,
		readIdentity: (pid) => ({ pid, pgid: 4000, starttime: "555", uid: selfUid() }),
		groupAlive: () => true, // the group survives SIGTERM ⇒ an escalation is armed
		gracefulMs: 30,
		capMs: 30,
		escalate: false,
		...signalSpies(log),
	});
	assert.deepEqual(log.groupSignals, ["4000:SIGTERM"]);
	assert.equal(result.pending.length, 1, "MINOR #5: the escalation must be collected even with escalate:false");
	assert.doesNotThrow(() => result.pending[0]?.catch(() => {}));
});
