/**
 * child-pi-kill-exited-root.test.ts — fix-wave 11a (F1) pins.
 *
 * GAP-1: `killProcessTree` bailed out on `child.exitCode !== null`, so an exited
 * root meant "nothing left" — even when its process group still had live
 * descendants. Wave 11a reaps the group from the REGISTRATION-TIME identity
 * snapshot, and only when that snapshot proves the root was its own group
 * leader (pgid === pid).
 *
 * Every case below uses the `__test` seam (identity snapshot + group reaper
 * injection) and a real child that has already exited, so:
 *   - (d1) matching snapshot  → the injected reaper is called exactly once,
 *   - (d2) no snapshot        → NO signal and nothing logged above `debug`
 *                               (regression: a clean exit must not be killed
 *                               a second time),
 *   - (d3) pgid !== pid       → refused, nothing signalled,
 *   - (d4) win32              → never a negative-pid signal.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import test from "node:test";
import { __test, killProcessTree } from "../../../../src/runtime/child-pi/child-pi-kill.ts";
import { type ProcIdentity, reapGroup } from "../../../../src/runtime/process/reap-group.ts";

const selfUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/** Spawn a node that exits immediately and wait until it really has. */
function exitedChild(): Promise<ChildProcess> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		child.once("exit", () => resolve(child));
		child.once("error", reject);
	});
}

/** Record every process.kill call while `fn` runs (pass-through to the real one). */
function withKillSpy(fn: () => void): Array<{ pid: number; signal: unknown }> {
	const original = process.kill;
	const calls: Array<{ pid: number; signal: unknown }> = [];
	process.kill = ((pid: number, signal?: string | number) => {
		calls.push({ pid, signal });
		return original.call(process, pid, signal as NodeJS.Signals);
	}) as typeof process.kill;
	try {
		fn();
	} finally {
		process.kill = original;
	}
	return calls;
}

interface ReapCall {
	pgid: number;
	candidatePid: number;
	expected: ProcIdentity | undefined;
}

/** Install a recording reaper; returns the recorded calls. */
function spyReaper(): ReapCall[] {
	const calls: ReapCall[] = [];
	__test.setReapGroup((pgid, candidatePid, opts) => {
		calls.push({ pgid, candidatePid, expected: opts?.expected });
		return { outcome: "refused", refusal: "identity-missing", pending: Promise.resolve("refused") };
	});
	return calls;
}

function reset(): void {
	__test.setReapGroup(undefined);
	__test.clearIdentities();
}

test("(d1) exited root + group-leader snapshot ⇒ the group is reaped from the snapshot", async () => {
	const child = await exitedChild();
	const pid = child.pid;
	assert.ok(pid && pid > 1, "child must have a pid");
	const identity: ProcIdentity = { pid, pgid: pid, starttime: "424242", uid: selfUid() };
	__test.seedIdentity(pid, identity);
	const calls = spyReaper();
	try {
		const kills = withKillSpy(() => killProcessTree(pid, child));
		assert.equal(calls.length, 1, "the exited-root branch must reap the group exactly once");
		assert.deepEqual(calls[0], { pgid: pid, candidatePid: pid, expected: identity });
		assert.deepEqual(kills, [], "no direct pid signal — the group reaper owns the kill");
	} finally {
		reset();
	}
});

test("(d2) exited root without a snapshot ⇒ no signal, nothing logged above debug", async () => {
	const child = await exitedChild();
	const pid = child.pid;
	assert.ok(pid && pid > 1);
	const calls = spyReaper();
	const errors: string[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
	// `logInternalError` emits `debug` ONLY when PI_TEAMS_DEBUG is set. Unsetting it
	// makes the assertion exact: with debug silenced, anything still printed is a
	// warn/error — which this path must never produce.
	const savedDebug = process.env.PI_TEAMS_DEBUG;
	delete process.env.PI_TEAMS_DEBUG;
	try {
		const kills = withKillSpy(() => killProcessTree(pid, child));
		assert.equal(calls.length, 0, "without a snapshot the old no-op behaviour must hold");
		assert.deepEqual(kills, [], "a cleanly exited child must never be signalled again");
		assert.deepEqual(errors, [], `nothing above debug may be logged, got: ${JSON.stringify(errors)}`);
	} finally {
		if (savedDebug !== undefined) process.env.PI_TEAMS_DEBUG = savedDebug;
		console.error = originalError;
		reset();
	}
});

test("(d3) snapshot whose pgid is NOT the pid ⇒ refused, nothing signalled", async () => {
	const child = await exitedChild();
	const pid = child.pid;
	assert.ok(pid && pid > 1);
	// Not a group leader (e.g. the rpc branch): pgid belongs to another group.
	__test.seedIdentity(pid, { pid, pgid: pid + 1, starttime: "424242", uid: selfUid() });
	const calls = spyReaper();
	try {
		const kills = withKillSpy(() => killProcessTree(pid, child));
		assert.equal(calls.length, 0, "a non-leader root must not be group-reaped");
		assert.deepEqual(kills, []);
	} finally {
		reset();
	}
});

test("(d4) win32 ⇒ the group reaper never receives a negative-pid signal", async () => {
	const child = await exitedChild();
	const pid = child.pid;
	assert.ok(pid && pid > 1);
	__test.seedIdentity(pid, { pid, pgid: pid, starttime: "424242", uid: selfUid() });
	const groupSignals: string[] = [];
	// Route the real reaper with a simulated win32 platform: the guard ladder must
	// refuse before any signal is attempted.
	__test.setReapGroup((pgid, candidatePid, opts) =>
		reapGroup(pgid, candidatePid, {
			...opts,
			platform: "win32",
			signalGroup: (group, signal) => groupSignals.push(`${group}:${signal}`),
			groupAlive: () => true,
		}),
	);
	try {
		const kills = withKillSpy(() => killProcessTree(pid, child));
		assert.deepEqual(groupSignals, [], "win32 must never signal a process group");
		assert.deepEqual(
			kills.filter((call) => call.pid < 0),
			[],
			"no negative-pid (group) signal may ever be sent on win32",
		);
	} finally {
		reset();
	}
});
