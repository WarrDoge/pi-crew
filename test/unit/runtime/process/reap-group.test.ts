/**
 * reap-group.test.ts — fix-wave 11a (F5) unit pins for the guarded process-group
 * reaper.
 *
 * Two halves:
 *
 * A. REAL topology (POSIX/Linux only): `test/fixtures/proc-tree-leader.mjs` is
 *    spawned detached (⇒ its own group leader) with two kids in that group. The
 *    leader is SIGKILLed, then `reapGroup()` must reclaim the whole group from
 *    the pre-kill identity snapshot. (a1) cooperative kids → gone;
 *    (a2) SIGTERM-ignoring kids → `killed-after-escalation` (SIGKILL rung).
 *
 * B. GUARD LADDER (injected identity/signal spies — NO real process is ever
 *    signalled): one case per rung, each asserting the refusal reason AND that
 *    `signalGroup` was never called. Rungs: platform, proc-unavailable,
 *    pgid-invalid, pgid-init-or-self, identity-missing (no snapshot),
 *    uid-mismatch, not-group-member, identity-missing (no starttime),
 *    starttime-mismatch.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import { assertSafeGroup, type GroupRefusalReason, readProcIdentity, reapGroup } from "../../../../src/runtime/process/reap-group.ts";

const isPosix = process.platform !== "win32";
const FIXTURE = path.join(import.meta.dirname, "..", "..", "..", "fixtures", "proc-tree-leader.mjs");
const uid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

// ── A. real topology ────────────────────────────────────────────────────────

interface TreeHandle {
	leader: ChildProcess;
	leaderPid: number;
	kids: number[];
}

function spawnTree(extraArgs: string[] = []): Promise<TreeHandle> {
	return new Promise((resolve, reject) => {
		const leader = spawn(process.execPath, [FIXTURE, ...extraArgs], {
			detached: true, // own session + group leader (pgid === pid)
			stdio: ["ignore", "pipe", "ignore"],
		});
		let buffer = "";
		const timer = setTimeout(() => reject(new Error("fixture did not report its tree in time")), 15_000);
		leader.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			clearTimeout(timer);
			try {
				const parsed = JSON.parse(buffer.slice(0, newline)) as { leader: number; kids: number[] };
				resolve({ leader, leaderPid: parsed.leader, kids: parsed.kids });
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
		leader.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Await a reap promise while a REF'd timer keeps the loop alive. The reap
 * ladder's own poll timers are deliberately unref'd (a reaper must never pin a
 * host shutdown), so in a test with no other live handle the loop would drain
 * mid-poll and node:test would report "cancelled".
 */
function awaitWithKeepalive<T>(promise: Promise<T>): Promise<T> {
	const keepAlive = setInterval(() => {
		/* ref'd no-op: keeps the loop alive */
	}, 25);
	return promise.finally(() => clearInterval(keepAlive));
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForDeath(pid: number, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !pidAlive(pid);
}

function killQuietly(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		/* already gone */
	}
}

async function reapAfterLeaderKill(
	extraArgs: string[],
	gracefulMs: number,
): Promise<{
	pending: Awaited<ReturnType<typeof reapGroup>>["pending"];
	tree: TreeHandle;
}> {
	const tree = await spawnTree(extraArgs);
	// Snapshot BEFORE the kill: after the leader dies /proc is gone.
	const expected = readProcIdentity(tree.leaderPid);
	assert.ok(expected, "fixture leader must be readable from /proc");
	assert.equal(expected.pgid, tree.leaderPid, "detached fixture must be its own group leader");
	const exited = new Promise((resolve) => tree.leader.once("exit", resolve));
	killQuietly(tree.leaderPid, "SIGKILL");
	await exited;
	const result = reapGroup(tree.leaderPid, tree.leaderPid, { expected, gracefulMs, capMs: 5_000, name: "reap-group-test" });
	return { pending: result.pending, tree };
}

test("(a1) real tree: group reaped after the leader is SIGKILLed (kids ESRCH)", { skip: !isPosix }, async () => {
	const { pending, tree } = await reapAfterLeaderKill([], 2_000);
	try {
		const outcome = await awaitWithKeepalive(pending);
		assert.ok(outcome === "gone" || outcome === "killed-after-escalation", `unexpected outcome ${outcome}`);
		for (const kid of tree.kids) {
			assert.equal(await waitForDeath(kid), true, `kid ${kid} must be gone after the group reap`);
		}
	} finally {
		for (const kid of tree.kids) killQuietly(kid, "SIGKILL");
		killQuietly(tree.leaderPid, "SIGKILL");
	}
});

test("(a2) real tree: SIGTERM-ignoring kids force the SIGKILL rung", { skip: !isPosix }, async () => {
	const { pending, tree } = await reapAfterLeaderKill(["ignore-term"], 400);
	try {
		const outcome = await awaitWithKeepalive(pending);
		assert.equal(outcome, "killed-after-escalation", "ignoring SIGTERM must be killed after escalation");
		for (const kid of tree.kids) {
			assert.equal(await waitForDeath(kid), true, `kid ${kid} must be gone after SIGKILL escalation`);
		}
	} finally {
		for (const kid of tree.kids) killQuietly(kid, "SIGKILL");
		killQuietly(tree.leaderPid, "SIGKILL");
	}
});

// ── B. guard ladder ─────────────────────────────────────────────────────────

function refusalCase(
	name: string,
	opts: {
		pgid: number;
		candidatePid: number;
		readIdentity?: (pid: number) => ReturnType<typeof readProcIdentity>;
		expected?: ReturnType<typeof readProcIdentity>;
		platform?: NodeJS.Platform;
	},
	expectedReason: GroupRefusalReason,
): void {
	test(`(b) ${name} → ${expectedReason}, never signals`, () => {
		const signals: string[] = [];
		const opts2 = {
			readIdentity: opts.readIdentity,
			expected: opts.expected,
			platform: opts.platform,
			signalGroup: (pgid: number, signal: NodeJS.Signals) => signals.push(`${pgid}:${signal}`),
			groupAlive: () => true,
		};
		const reason = assertSafeGroup(opts.pgid, opts.candidatePid, opts2);
		assert.equal(reason, expectedReason);
		const result = reapGroup(opts.pgid, opts.candidatePid, opts2);
		assert.equal(result.outcome, "refused");
		assert.equal(result.refusal, expectedReason);
		assert.deepEqual(signals, [], "a refused group must never be signalled");
	});
}

/** Identity reader that resolves our own pid as healthy and fakes the candidate. */
function reader(candidate: ReturnType<typeof readProcIdentity>, self = true) {
	return (pid: number): ReturnType<typeof readProcIdentity> => {
		if (self && pid === process.pid) return { pid, pgid: process.pid, starttime: "1", uid: uid() };
		return candidate;
	};
}

const FAKE_PGID = 424_242;
const OTHER_PGID = 535_353;

refusalCase(
	"(b0) win32 platform",
	{
		pgid: FAKE_PGID,
		candidatePid: 4242,
		readIdentity: reader({ pid: 4242, pgid: FAKE_PGID, starttime: "11", uid: uid() }),
		platform: "win32",
	},
	"platform-not-posix",
);

refusalCase(
	"(b0b) /proc unreadable (own identity missing)",
	{ pgid: FAKE_PGID, candidatePid: 4242, readIdentity: () => undefined },
	"proc-unavailable",
);

refusalCase(
	"(b1) candidate is not a member of the requested group",
	{ pgid: FAKE_PGID, candidatePid: 4242, readIdentity: reader({ pid: 4242, pgid: OTHER_PGID, starttime: "11", uid: uid() }) },
	"not-group-member",
);

refusalCase(
	"(b2) PID reuse — snapshot starttime differs from the live one",
	{
		pgid: FAKE_PGID,
		candidatePid: 4242,
		readIdentity: reader({ pid: 4242, pgid: FAKE_PGID, starttime: "222", uid: uid() }),
		expected: { pid: 4242, pgid: FAKE_PGID, starttime: "111", uid: uid() },
	},
	"starttime-mismatch",
);

refusalCase(
	"(b3) stale snapshot pointing at a DIFFERENT group (candidate gone)",
	{
		pgid: FAKE_PGID,
		candidatePid: 4242,
		readIdentity: reader(undefined),
		expected: { pid: 4242, pgid: OTHER_PGID, starttime: "111", uid: uid() },
	},
	"identity-missing",
);

refusalCase(
	"(b5) uid differs from ours",
	{ pgid: FAKE_PGID, candidatePid: 4242, readIdentity: reader({ pid: 4242, pgid: FAKE_PGID, starttime: "11", uid: (uid() ?? 0) + 7 }) },
	"uid-mismatch",
);

refusalCase(
	"(b6) identity without starttime + no snapshot",
	{ pgid: FAKE_PGID, candidatePid: 4242, readIdentity: reader({ pid: 4242, pgid: FAKE_PGID, starttime: undefined, uid: uid() }) },
	"identity-missing",
);

test("(b4) invalid pgids (0, 1, -5, 1.5, NaN) are refused before any identity read", () => {
	const signals: string[] = [];
	for (const pgid of [0, 1, -5, 1.5, Number.NaN]) {
		let identityReads = 0;
		const reason = assertSafeGroup(pgid, 4242, {
			readIdentity: (pid) => {
				identityReads++;
				return pid === process.pid ? { pid, pgid: process.pid, starttime: "1", uid: uid() } : undefined;
			},
			signalGroup: (g, s) => signals.push(`${g}:${s}`),
		});
		assert.equal(reason, "pgid-invalid", `pgid ${pgid} must be invalid`);
		assert.equal(identityReads, 1, "pgid-invalid must short-circuit before the candidate identity read");
	}
	assert.deepEqual(signals, []);
});

test("(b4b) our own group / our parent's group is refused", () => {
	for (const pgid of [process.pid, process.ppid]) {
		const signals: string[] = [];
		const result = reapGroup(pgid, 4242, {
			readIdentity: (pid) => ({ pid, pgid, starttime: "1", uid: uid() }),
			signalGroup: (g, s) => signals.push(`${g}:${s}`),
		});
		assert.equal(result.refusal, "pgid-init-or-self");
		assert.equal(result.outcome, "refused");
		assert.deepEqual(signals, []);
	}
});

test("(b7) a passing ladder sends SIGTERM synchronously, then reports gone", async () => {
	const signals: string[] = [];
	const result = reapGroup(FAKE_PGID, 4242, {
		readIdentity: reader({ pid: 4242, pgid: FAKE_PGID, starttime: "11", uid: uid() }),
		signalGroup: (g, s) => signals.push(`${g}:${s}`),
		groupAlive: () => false, // the group died from the SIGTERM prefix
	});
	assert.equal(result.outcome, "gone");
	assert.equal(await awaitWithKeepalive(result.pending), "gone");
	assert.deepEqual(signals, [`${FAKE_PGID}:SIGTERM`], "SIGTERM must be delivered synchronously, before any await");
});
