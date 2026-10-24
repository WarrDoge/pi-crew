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
 *
 * C. WAVE 11a REVIEW REGRESSIONS: (b4c/b4d/b4e/b4f) our REAL pgrp (from the
 *    cached self identity — CRITICAL #1 / MINOR #3 / MINOR #4), (b10-b12) the
 *    dead-candidate leader-proof rules (MAJOR #2), (b13) recycle between SIGTERM
 *    and SIGKILL, (b14) win32, (b15) the escalation promise never rejects
 *    (MINOR #5), (b16-b19) leader-proof guards + the synchronous shutdown flush
 *    (MINOR #1 / MINOR #2 / MAJOR #3).
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import test, { beforeEach } from "node:test";
import {
	__armedEscalationCountForTest,
	__resetArmedEscalationsForTest,
	__resetSelfIdentityForTest,
	__setSelfIdentityForTest,
	__setSelfIdentityReaderForTest,
	assertSafeGroup,
	flushReapEscalationsSync,
	type GroupRefusalReason,
	readProcIdentity,
	reapGroup,
} from "../../../../src/runtime/process/reap-group.ts";

const isPosix = process.platform !== "win32";

/**
 * MINOR #4 consequence: rungs 1/3 read OUR identity from /proc, never from the
 * per-call injected reader. On a platform without /proc (macOS) every guarded
 * kill would short-circuit at `proc-unavailable`, so the ladders below would be
 * untestable there. Seed a synthetic self identity on exactly those platforms —
 * a no-op on Linux, and tests that set their own seam still win (this runs
 * before each test).
 */
beforeEach(() => {
	if (readProcIdentity(process.pid) === undefined) {
		__setSelfIdentityForTest({ pid: process.pid, pgid: 4_000_001, starttime: "1", uid: uid() });
	}
});
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
		/** Install a synthetic SELF identity (undefined ⇒ /proc unreadable for us). */
		selfIdentity?: ReturnType<typeof readProcIdentity>;
	},
	expectedReason: GroupRefusalReason,
): void {
	test(`(b) ${name} → ${expectedReason}, never signals`, () => {
		const signals: string[] = [];
		if ("selfIdentity" in opts) __setSelfIdentityForTest(opts.selfIdentity);
		try {
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
		} finally {
			if ("selfIdentity" in opts) __resetSelfIdentityForTest();
		}
	});
}

/** Identity reader that resolves our own pid as healthy and fakes the candidate. */
function reader(candidate: ReturnType<typeof readProcIdentity>, self = true) {
	return (pid: number): ReturnType<typeof readProcIdentity> => {
		if (self && pid === process.pid) return { pid, pgid: process.pid, starttime: "1", uid: uid() };
		return candidate;
	};
}

/**
 * The old reader faked our OWN identity through the injected seam. Rung 3 now
 * uses the module-cached REAL /proc identity (`selfIdentity()`, CRITICAL #1), so
 * the fake must never claim our pid belongs to the fake pgid — that would make
 * every "safe" case indistinguishable from "our own group".
 */

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
	// MINOR #4: rung 1 no longer consults the injected candidate reader for OUR
	// identity, so "unreadable" must be expressed through the self seam.
	{ pgid: FAKE_PGID, candidatePid: 4242, readIdentity: () => undefined, selfIdentity: undefined },
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
		// MINOR #4: the injected reader is now the CANDIDATE reader only, so a
		// short-circuit means NO read happens at all (the self identity comes from
		// the cached /proc read).
		assert.equal(identityReads, 0, "pgid-invalid must short-circuit before any candidate identity read");
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

// ── C. wave 11a REVIEW regressions ──────────────────────────────────────────

/** Identity reader for the dead-candidate cases: self is real, everything else is not there. */
function selfOnlyReader(extra: Record<number, ReturnType<typeof readProcIdentity>> = {}) {
	return (pid: number): ReturnType<typeof readProcIdentity> => {
		if (pid === process.pid) return { pid, pgid: process.pid, starttime: "1", uid: uid() };
		return extra[pid];
	};
}

test("(b4c) CRITICAL #1: our REAL pgrp is refused even when it is neither pid nor ppid", () => {
	// A host started under setsid/wrapper has pgrp ∉ {pid, ppid} — the pre-fix
	// rung compared only against pid/ppid, so kill(-pgrp) took out the session.
	const selfPgrp = process.pid + 500;
	__setSelfIdentityForTest({ pid: process.pid, pgid: selfPgrp, starttime: "1", uid: uid() });
	try {
		const signals: string[] = [];
		const opts = {
			readIdentity: selfOnlyReader({ 4242: { pid: 4242, pgid: selfPgrp, starttime: "11", uid: uid() } }),
			signalGroup: (g: number, s: NodeJS.Signals) => signals.push(`${g}:${s}`),
			groupAlive: () => true,
		};
		assert.equal(assertSafeGroup(selfPgrp, 4242, opts), "pgid-init-or-self");
		const result = reapGroup(selfPgrp, 4242, opts);
		assert.equal(result.outcome, "refused");
		assert.equal(result.refusal, "pgid-init-or-self");
		assert.deepEqual(signals, [], "our own group must never be signalled");
	} finally {
		__resetSelfIdentityForTest();
	}
});

test("(b4d) CRITICAL #1 / MINOR #3: an unreadable self identity is a fail-safe refusal that RETRIES", () => {
	__setSelfIdentityForTest(undefined);
	try {
		const signals: string[] = [];
		const reason = assertSafeGroup(FAKE_PGID, 4242, {
			readIdentity: selfOnlyReader({ 4242: { pid: 4242, pgid: FAKE_PGID, starttime: "11", uid: uid() } }),
			signalGroup: (g, s) => signals.push(`${g}:${s}`),
		});
		assert.equal(reason, "proc-unavailable", "without a readable self identity we must never group-kill");
		assert.deepEqual(signals, []);
	} finally {
		__resetSelfIdentityForTest();
	}
});

test("(b4e) MINOR #3: a read we can parse but without a pgrp is identity-missing", () => {
	// Distinct from (b4d): the process IS readable, its pgrp just could not be
	// parsed — same refusal, different rung.
	__setSelfIdentityForTest({ pid: process.pid, pgid: undefined, starttime: "1", uid: uid() });
	try {
		const reason = assertSafeGroup(FAKE_PGID, 4242, {
			readIdentity: selfOnlyReader({ 4242: { pid: 4242, pgid: FAKE_PGID, starttime: "11", uid: uid() } }),
		});
		assert.equal(reason, "identity-missing");
	} finally {
		__resetSelfIdentityForTest();
	}
});

test("(b4f) MINOR #3: a FAILED self read is NOT cached — the next evaluation retries", () => {
	// A transient /proc failure must not become a permanent refuse-everything
	// state: while the read fails, every guard evaluation retries; the first
	// SUCCESS is cached (a pgrp cannot change after start).
	__resetSelfIdentityForTest();
	let failedReads = 0;
	let okReads = 0;
	try {
		__setSelfIdentityReaderForTest(() => {
			failedReads++;
			return undefined;
		});
		const candidateGone = () => undefined;
		assert.equal(assertSafeGroup(FAKE_PGID, 4242, { readIdentity: candidateGone }), "proc-unavailable");
		assert.equal(assertSafeGroup(FAKE_PGID, 4242, { readIdentity: candidateGone }), "proc-unavailable");
		assert.equal(failedReads, 2, "the failed read must be retried on the next call, not replayed from cache");

		__setSelfIdentityReaderForTest((): ReturnType<typeof readProcIdentity> => {
			okReads++;
			return { pid: process.pid, pgid: 313_131, starttime: "1", uid: uid() };
		});
		assert.equal(assertSafeGroup(FAKE_PGID, 4242, { readIdentity: candidateGone }), "identity-missing");
		assert.equal(okReads, 1, "a successful read is used immediately");
		assert.equal(assertSafeGroup(FAKE_PGID, 4242, { readIdentity: candidateGone }), "identity-missing");
		assert.equal(okReads, 1, "and then cached (no second read)");
	} finally {
		__resetSelfIdentityForTest();
	}
});

test("(b10) MAJOR #2: dead candidate + leader starttime mismatch ⇒ starttime-mismatch, 0 signal", () => {
	// The candidate is gone from /proc, but the pgid still has a LIVE leader
	// whose starttime differs from the snapshot ⇒ the pgid was recycled.
	const signals: string[] = [];
	const opts = {
		readIdentity: selfOnlyReader({ [FAKE_PGID]: { pid: FAKE_PGID, pgid: FAKE_PGID, starttime: "999", uid: uid() } }),
		signalGroup: (g: number, s: NodeJS.Signals) => signals.push(`${g}:${s}`),
		groupAlive: () => true,
		expected: { pid: FAKE_PGID, pgid: FAKE_PGID, starttime: "111", uid: uid() },
	};
	assert.equal(assertSafeGroup(FAKE_PGID, FAKE_PGID, opts), "starttime-mismatch");
	const result = reapGroup(FAKE_PGID, FAKE_PGID, opts);
	assert.equal(result.outcome, "refused");
	assert.deepEqual(signals, [], "a recycled pgid must never be signalled");
});

test("(b11) MAJOR #2: leader dead but the group still has members ⇒ one group kill", async () => {
	// Kernel property: a pgid is NOT recycled while a member survives, so a
	// still-live group whose leader is gone is provably OUR old group.
	const signals: string[] = [];
	let aliveCalls = 0;
	const opts = {
		readIdentity: selfOnlyReader(), // candidate + leader both gone
		signalGroup: (g: number, s: NodeJS.Signals) => signals.push(`${g}:${s}`),
		// call 1 = the guard's leader-gone probe (alive), call 2 = post-SIGTERM (drained).
		groupAlive: () => ++aliveCalls === 1,
		expected: { pid: FAKE_PGID, pgid: FAKE_PGID, starttime: "111", uid: uid() },
	};
	const result = reapGroup(FAKE_PGID, FAKE_PGID, opts);
	assert.equal(result.outcome, "gone");
	assert.equal(await awaitWithKeepalive(result.pending), "gone");
	assert.deepEqual(signals, [`${FAKE_PGID}:SIGTERM`], "exactly ONE group signal");
	assert.equal(aliveCalls, 2);
});

test("(b12) MAJOR #2: dead candidate + non-leader-proof snapshot ⇒ refused", () => {
	// `expected.pid !== pgid` means the recorded process was NOT the leader, so
	// nothing in the snapshot proves the group identity (the pre-fix code made
	// rungs 4/6/7/8 tautological and killed blindly).
	const signatures: string[] = [];
	const reason = assertSafeGroup(4242, 4242, {
		readIdentity: selfOnlyReader(),
		signalGroup: (g, s) => signatures.push(`${g}:${s}`),
		groupAlive: () => true,
		expected: { pid: 4242, pgid: 999_999, starttime: "111", uid: uid() },
	});
	assert.equal(reason, "identity-missing");
	assert.deepEqual(signatures, []);
});

test("(b13) recycle between SIGTERM and SIGKILL ⇒ refused, NEVER a SIGKILL", async () => {
	// The group never drains and the pgid gets recycled between the graceful
	// signal and the escalation rung: the guard's re-check must refuse. The
	// leader's starttime changes between the guard call (1) and the re-check (2).
	const signals: string[] = [];
	let leaderReads = 0;
	const opts = {
		readIdentity: (pid: number): ReturnType<typeof readProcIdentity> => {
			if (pid === process.pid) return { pid, pgid: process.pid, starttime: "1", uid: uid() };
			if (pid === FAKE_PGID) {
				leaderReads++;
				return { pid, pgid: FAKE_PGID, starttime: leaderReads === 1 ? "111" : "222", uid: uid() };
			}
			return undefined; // the candidate is gone
		},
		signalGroup: (g: number, s: NodeJS.Signals) => signals.push(`${g}:${s}`),
		groupAlive: () => true, // the group never drains
		expected: { pid: FAKE_PGID, pgid: FAKE_PGID, starttime: "111", uid: uid() },
		gracefulMs: 60,
		capMs: 60,
	};
	const result = reapGroup(FAKE_PGID, FAKE_PGID, opts);
	assert.equal(result.outcome, "killed-after-escalation", "the sync verdict is provisional");
	assert.equal(await awaitWithKeepalive(result.pending), "refused", "the re-check must refuse the escalation");
	assert.deepEqual(signals, [`${FAKE_PGID}:SIGTERM`], "SIGTERM only — no SIGKILL on a possibly-recycled pgid");
	assert.equal(leaderReads, 2, "guard read + escalation re-check read");
});

test("(b14) win32: reapGroup refuses and never signals", () => {
	const signals: string[] = [];
	const result = reapGroup(FAKE_PGID, 4242, {
		platform: "win32",
		readIdentity: reader({ pid: 4242, pgid: FAKE_PGID, starttime: "11", uid: uid() }),
		signalGroup: (g, s) => signals.push(`${g}:${s}`),
		groupAlive: () => true,
	});
	assert.equal(result.outcome, "refused");
	assert.equal(result.refusal, "platform-not-posix");
	assert.deepEqual(signals, []);
});

test("(b15) the escalation promise never rejects (fatal unhandled rejection on Node 22)", async () => {
	// MINOR #5: a side effect that blows up INSIDE the async escalation must
	// degrade to `stuck`, not to a rejected promise the caller `void`s.
	let aliveCalls = 0;
	const result = reapGroup(FAKE_PGID, 4242, {
		readIdentity: reader({ pid: 4242, pgid: FAKE_PGID, starttime: "11", uid: uid() }),
		signalGroup: () => {
			/* the SIGTERM prefix is delivered */
		},
		groupAlive: () => {
			aliveCalls++;
			if (aliveCalls === 1) return true; // sync post-SIGTERM probe: still alive
			throw new Error("group probe exploded"); // async escalation rung throws
		},
		gracefulMs: 40,
		capMs: 40,
	});
	assert.equal(result.outcome, "killed-after-escalation", "the sync verdict is provisional");
	assert.equal(await awaitWithKeepalive(result.pending), "stuck", "an unexpected throw resolves as stuck, never rejects");
});

// ── D. WAVE 11a.1 review: leader-proof guards + the shutdown flush ──────────

test("(b16) MINOR #1: dead candidate whose pid is NOT the requested pgid ⇒ refused", () => {
	// `candidatePid !== pgid` means the recorded process was not the leader of the
	// group we are about to signal — a non-leader pid cannot prove a group.
	const signals: string[] = [];
	const opts = {
		readIdentity: selfOnlyReader(),
		signalGroup: (g: number, s: NodeJS.Signals) => signals.push(`${g}:${s}`),
		groupAlive: () => true,
		expected: { pid: 4242, pgid: 4242, starttime: "111", uid: uid() },
	};
	assert.equal(assertSafeGroup(4242, 5151, opts), "identity-missing");
	assert.equal(reapGroup(4242, 5151, opts).outcome, "refused");
	assert.deepEqual(signals, []);
});

test("(b17) MINOR #1: a leader pid that left its group is not evidence ⇒ refused", () => {
	// The live pid recorded as the leader reports a DIFFERENT pgid (it called
	// setpgid): the snapshot proves nothing about `pgid`.
	const signals: string[] = [];
	const opts = {
		readIdentity: selfOnlyReader({ [FAKE_PGID]: { pid: FAKE_PGID, pgid: OTHER_PGID, starttime: "111", uid: uid() } }),
		signalGroup: (g: number, s: NodeJS.Signals) => signals.push(`${g}:${s}`),
		groupAlive: () => true,
		expected: { pid: FAKE_PGID, pgid: FAKE_PGID, starttime: "111", uid: uid() },
	};
	assert.equal(assertSafeGroup(FAKE_PGID, FAKE_PGID, opts), "not-group-member");
	assert.equal(reapGroup(FAKE_PGID, FAKE_PGID, opts).outcome, "refused");
	assert.deepEqual(signals, []);
});

test("(b18) MINOR #2: dead candidate + snapshot WITHOUT uid ⇒ refused (no EPERM-as-reaped)", () => {
	// A snapshot without a uid cannot be separated from a stranger's process:
	// the signal would fail with EPERM AFTER the caller reported `reaped`, and
	// the escalation would then be reported as a false `stuck`.
	const signals: string[] = [];
	const opts = {
		readIdentity: selfOnlyReader(),
		signalGroup: (g: number, s: NodeJS.Signals) => signals.push(`${g}:${s}`),
		groupAlive: () => true,
		expected: { pid: FAKE_PGID, pgid: FAKE_PGID, starttime: "111", uid: undefined },
	};
	assert.equal(assertSafeGroup(FAKE_PGID, FAKE_PGID, opts), "identity-missing");
	assert.equal(reapGroup(FAKE_PGID, FAKE_PGID, opts).outcome, "refused");
	assert.deepEqual(signals, []);
});

test("(b19) MAJOR #3: flushReapEscalationsSync delivers the SIGKILL rung synchronously, exactly once", async () => {
	// The escalation's own poll timers are unref'd, so a host that exits while the
	// escalation is in flight abandons the SIGKILL. The shutdown flush delivers it
	// synchronously — and the async chain must not signal a SECOND time after.
	__resetArmedEscalationsForTest();
	const signals: string[] = [];
	const result = reapGroup(FAKE_PGID, 4242, {
		readIdentity: reader({ pid: 4242, pgid: FAKE_PGID, starttime: "11", uid: uid() }),
		signalGroup: (g, s) => signals.push(`${g}:${s}`),
		groupAlive: () => true, // group survives SIGTERM ⇒ an escalation is armed
		gracefulMs: 60,
		capMs: 60,
	});
	assert.equal(result.outcome, "killed-after-escalation");
	assert.equal(__armedEscalationCountForTest(), 1, "the escalation must be registered while in flight");
	assert.deepEqual(signals, [`${FAKE_PGID}:SIGTERM`], "only the graceful signal so far");

	assert.equal(flushReapEscalationsSync(), 1, "the flush must deliver exactly one SIGKILL");
	assert.deepEqual(signals, [`${FAKE_PGID}:SIGTERM`, `${FAKE_PGID}:SIGKILL`]);
	assert.equal(__armedEscalationCountForTest(), 0, "the registry is empty after the flush");

	// The async chain still resolves — and does NOT signal again.
	assert.equal(await awaitWithKeepalive(result.pending), "killed-after-escalation");
	assert.deepEqual(
		signals.filter((s) => s.endsWith("SIGKILL")),
		[`${FAKE_PGID}:SIGKILL`],
		"exactly ONE SIGKILL across flush + async escalation",
	);
	__resetArmedEscalationsForTest();
});

test("(b20) MAJOR #3: the flush RE-VALIDATES — a pgid recycled since arming is never SIGKILLed", async () => {
	__resetArmedEscalationsForTest();
	const signals: string[] = [];
	let live: ReturnType<typeof readProcIdentity> = { pid: 4242, pgid: FAKE_PGID, starttime: "11", uid: uid() };
	const opts = {
		readIdentity: (pid: number) => (pid === 4242 ? live : selfOnlyReader()(pid)),
		signalGroup: (g: number, s: NodeJS.Signals) => signals.push(`${g}:${s}`),
		groupAlive: () => true,
		expected: { pid: 4242, pgid: FAKE_PGID, starttime: "11", uid: uid() },
		gracefulMs: 40,
		capMs: 40,
	};
	const result = reapGroup(FAKE_PGID, 4242, opts);
	assert.equal(result.outcome, "killed-after-escalation");
	assert.deepEqual(signals, [`${FAKE_PGID}:SIGTERM`]);

	// PID reuse: the pid now belongs to a DIFFERENT incarnation in that group.
	live = { pid: 4242, pgid: FAKE_PGID, starttime: "999", uid: uid() };
	assert.equal(flushReapEscalationsSync(), 0, "a stale entry must be refused, not signalled");
	assert.deepEqual(signals, [`${FAKE_PGID}:SIGTERM`], "no SIGKILL for a recycled pgid");
	assert.equal(__armedEscalationCountForTest(), 0, "the registry is cleared even when everything was refused");
	assert.equal(await awaitWithKeepalive(result.pending), "refused");
	__resetArmedEscalationsForTest();
});

test("(b21) MAJOR #3: an empty flush is a no-op that never throws", () => {
	__resetArmedEscalationsForTest();
	assert.equal(flushReapEscalationsSync(), 0);
	assert.equal(flushReapEscalationsSync(), 0, "repeatable — no state to corrupt");
});
