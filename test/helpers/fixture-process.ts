/**
 * fixture-process.ts — the ONE place a test may spawn and reap a fixture tree.
 *
 * THE RULE, stated once: a fixture spawned `detached` owns its own process group
 * and is therefore UNREACHABLE from the test runner's group. Teardown must go
 * through {@link reapFixture} — a group reap carrying the identity snapshot taken
 * at spawn time, with SIGKILL escalation. `finally { child.kill() }` is a pid-only
 * no-op against a SIGTERM-swallowing process and is NOT teardown.
 *
 * Why this module exists (fix-wave 12, live evidence): two fixtures of the shape
 * `node -e "process.on('SIGTERM',()=>{}); setInterval(...)"` were found alive
 * > 6 h after their run completed, re-parented to systemd. Both properties that
 * made them immortal come from the fixture, not the product: spawned detached
 * (own group ⇒ no group kill rooted at the test can reach them) and swallowing
 * SIGTERM (the polite kill never lands).
 *
 * Non-detached fixtures are refused (see {@link spawnFixture}) because a group
 * kill rooted at such a child signals the RUNNER's group — the test file, its
 * siblings, and the runner process itself.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { after } from "node:test";
import {
	flushReapEscalationsSync,
	type GroupRefusalReason,
	type ProcIdentity,
	readProcIdentity,
	reapGroup,
} from "../../src/runtime/process/reap-group.ts";

/** Grace window between the group SIGTERM and the SIGKILL rung (ms). */
const DEFAULT_GRACEFUL_MS = 250;
/** Hard cap after SIGKILL before the group is declared stuck (ms). */
const DEFAULT_CAP_MS = 2_000;
/** Poll interval of the ref'd keep-alive that spans an awaited escalation (ms). */
const KEEPALIVE_MS = 25;

/**
 * Refusal reasons that PROVE the pid is no longer our fixture (a reused pid, a
 * group it left, a different uid). Those must never degrade into a pid kill:
 * the whole point of the snapshot is to not signal a stranger.
 */
const STRANGER_PROOF_REFUSALS: ReadonlySet<GroupRefusalReason> = new Set<GroupRefusalReason>([
	"starttime-mismatch",
	"uid-mismatch",
	"not-group-member",
]);

/** Everything teardown needs about one spawned fixture. */
export interface FixtureHandle {
	/** The fixture's pid (= its pgid: a detached child is its own group leader). */
	pid: number;
	/** Process group to signal. Equals {@link pid} by construction. */
	pgid: number;
	/** The live child, for fixtures that report their own tree via stdout. */
	child: ChildProcess;
	/**
	 * `/proc` identity snapshotted IMMEDIATELY after spawn — the reuse-proof
	 * evidence handed to `reapGroup` as `expected`. `undefined` where `/proc` is
	 * unreadable (non-Linux): {@link reapFixture} then falls back to a pid kill.
	 */
	identity: ProcIdentity | undefined;
}

/** Spawn options. `detached` exists ONLY so the refusal is testable — pass `true`. */
export interface SpawnFixtureOptions {
	/** Must be `true` (default). `false` throws — see {@link spawnFixture}. */
	detached?: boolean;
	/** Replaces the runner's environment entirely (`spawn` semantics). Default: inherit. */
	env?: NodeJS.ProcessEnv;
	/** Working directory of the fixture. Default: the runner's cwd. */
	cwd?: string;
}

/** Teardown options, forwarded to `reapGroup`. */
export interface ReapFixtureOptions {
	/** Grace window between SIGTERM and SIGKILL. Default 250 ms. */
	gracefulMs?: number;
	/** Hard cap after SIGKILL. Default 2000 ms. */
	capMs?: number;
}

/** Outcome of a fixture teardown. Never a throw — it runs in `finally` bodies. */
export interface ReapFixtureResult {
	/** `true` when nothing of the fixture is left (or the pid fallback killed it). */
	ok: boolean;
	/** Why `ok` is `false`, or which refusal/outcome the fallback came from. */
	reason?: string;
}

/**
 * Spawn a fixture in its OWN process group and snapshot its identity at once.
 *
 * `detached` defaults to `true` and the child is a session leader by
 * construction (the child calls `setsid` before `exec`), so `pgid === pid`.
 * stdout is piped so fixtures that announce their own tree (pid lists) can be
 * read; stdin and stderr are ignored.
 *
 * @throws when `opts.detached` is `false` — see the message for the rationale.
 */
export function spawnFixture(argv: string[], opts: SpawnFixtureOptions = {}): FixtureHandle {
	const detached = opts.detached ?? true;
	if (detached !== true) {
		throw new Error(
			"spawnFixture refuses `detached: false`: a non-detached fixture shares the TEST RUNNER's process group, " +
				"so the group kill in reapFixture would signal the runner and every sibling test file. " +
				"Spawn such a child with `child_process.spawn` directly and tear it down pid-only — it is the one " +
				"shape reapFixture must never be handed (see test/integration/background-runner-sigint-cleanup.test.ts).",
		);
	}
	const [command, ...args] = argv;
	if (!command) throw new Error("spawnFixture requires a non-empty argv (argv[0] = executable)");
	const child = spawn(command, args, {
		detached: true, // own session + group leader ⇒ pgid === pid ⇒ group-kill reachable
		stdio: ["ignore", "pipe", "ignore"], // stdout stays readable for pid-reporting fixtures
		env: opts.env ?? process.env,
		cwd: opts.cwd,
		windowsHide: true,
	});
	const pid = child.pid;
	if (!pid) throw new Error(`spawnFixture: failed to spawn ${command} (spawn returned no pid)`);
	// Snapshot NOW: the identity is only readable while the pid is still ours, and
	// it is what makes the later group kill reuse-proof.
	const rawIdentity = readProcIdentity(pid);
	// A detached child leads its own group by construction, so `pgid` is `pid`.
	// Normalise the snapshot: an immediate /proc read can in principle land before
	// the child's setsid and report the RUNNER's pgid, which would make every later
	// leader proof fail (`identity-missing`) for a fixture that is perfectly ours.
	const identity = rawIdentity ? { ...rawIdentity, pgid: pid } : undefined;
	return { pid, pgid: pid, child, identity };
}

/** `kill` that never throws and refuses pid 0/1. */
function killPidQuietly(pid: number, signal: NodeJS.Signals): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

/**
 * Await a reap verdict while a REF'd timer keeps the loop alive. The escalation's
 * own poll timers are unref'd on purpose (a reaper must never pin a host
 * shutdown), so without this the loop can drain mid-poll in a test.
 */
function awaitEscalation<T>(promise: Promise<T>): Promise<T> {
	const keepAlive = setInterval(() => {
		/* ref'd no-op: keeps the loop alive across the escalation's unref'd polls */
	}, KEEPALIVE_MS);
	return promise.finally(() => clearInterval(keepAlive));
}

/**
 * Reap a fixture's whole process group: SIGTERM now, SIGKILL after the grace
 * window, every signal re-validated against the spawn-time identity snapshot.
 *
 * Degradation rules, both deliberate:
 *  - refusal WITHOUT proof of reuse (`identity-missing`, `proc-unavailable`,
 *    `platform-not-posix`, …) ⇒ pid `SIGKILL` fallback — this is the non-Linux
 *    path, and it is what a group kill cannot cover.
 *  - refusal WITH proof the pid is a stranger (`starttime-mismatch`,
 *    `uid-mismatch`, `not-group-member`) ⇒ nothing is signalled. Never pid-kill a
 *    reused pid.
 *
 * Never throws: it is called from `finally` bodies, where a throw would mask the
 * failure under test. Safe to call twice (the second call reports `ok: false`).
 */
export async function reapFixture(handle: FixtureHandle, opts: ReapFixtureOptions = {}): Promise<ReapFixtureResult> {
	const result = reapGroup(handle.pgid, handle.pid, {
		expected: handle.identity,
		gracefulMs: opts.gracefulMs ?? DEFAULT_GRACEFUL_MS,
		capMs: opts.capMs ?? DEFAULT_CAP_MS,
		name: `fixture:${handle.pid}`,
	});
	if (result.outcome === "refused") {
		const refusal: GroupRefusalReason = result.refusal ?? "identity-missing";
		if (STRANGER_PROOF_REFUSALS.has(refusal)) return { ok: false, reason: `${refusal} (stranger-proof; nothing signalled)` };
		return { ok: killPidQuietly(handle.pid, "SIGKILL"), reason: `${refusal} (pid fallback)` };
	}
	const outcome = await awaitEscalation(result.pending);
	if (outcome === "stuck") return { ok: killPidQuietly(handle.pid, "SIGKILL"), reason: "stuck (pid fallback)" };
	return { ok: true };
}

const trapped: FixtureHandle[] = [];
let trapInstalled = false;

/**
 * Register fixtures for reaping on the two shutdown paths a test file has:
 *
 *  1. `after()` (node:test) — runs even when an assertion throws, which is the
 *     abort window that leaked the incident fixtures.
 *  2. `process.on("exit")` — synchronous last chance: re-run the ladder-guarded
 *     reap prefix and let `flushReapEscalationsSync()` deliver the armed SIGKILL
 *     rung (the escalation's own timers are unref'd and never fire here).
 *
 * Idempotent: repeated calls add new handles but install the hooks exactly once.
 */
export function registerFixtureTrap(handles: FixtureHandle[]): void {
	for (const handle of handles) {
		if (!trapped.includes(handle)) trapped.push(handle);
	}
	if (trapInstalled) return;
	trapInstalled = true;
	after(async () => {
		for (const handle of [...trapped]) {
			try {
				await reapFixture(handle);
			} catch {
				/* best-effort: a throw here would mask the failure under test */
			}
		}
	});
	process.on("exit", () => {
		for (const handle of trapped) {
			try {
				// Sync SIGTERM prefix; the flush below delivers the escalation.
				reapGroup(handle.pgid, handle.pid, { expected: handle.identity, gracefulMs: 0, capMs: 0, name: `fixture:${handle.pid}` });
			} catch {
				/* best-effort */
			}
		}
		flushReapEscalationsSync();
	});
}

/** Test seam: how many times the trap registered its hooks, and for how many handles. */
export function __fixtureTrapStateForTest(): { hookInstalled: boolean; handleCount: number; exitListenerCount: number } {
	return {
		hookInstalled: trapInstalled,
		handleCount: trapped.length,
		exitListenerCount: process.listenerCount("exit"),
	};
}
