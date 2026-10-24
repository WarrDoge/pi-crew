/**
 * stale-reconciler-reap-escalation.test.ts — wave 11a review MAJOR #3 pins.
 *
 * The reconciler arms a process-group SIGKILL escalation when it reaps a
 * cancelled task's worker, but it is SYNCHRONOUS by contract (withRunLockSync
 * callers + the sync temp-workspace scan + 50+ sync test call sites), so it can
 * never await that escalation itself. The pre-fix code dropped the promise with
 * `void Promise.allSettled(...).catch(...)` — a catch that could never fire,
 * because allSettled never rejects — so nothing guaranteed the escalation had
 * been delivered before the host could return and exit.
 *
 * Pinned here:
 *   1. a reconcile pass REGISTERS the armed escalation (nothing is dropped),
 *   2. `drainReapEscalations()` does not resolve while the escalation is still
 *      in flight — it resolves strictly AFTER it settles,
 *   3. a rejecting escalation cannot escape as an unhandled rejection and
 *      `drainReapEscalations()` still resolves,
 *   4. a drain with nothing armed is an immediate no-op (and creates NO
 *      keep-alive interval),
 *   5. the drain holds a REF'D keep-alive while it waits: proven in a CHILD
 *      process by the escalation outliving the script's top level (an unref'd
 *      timer chain alone lets Node drain the loop and exit),
 *   6. `flushReapEscalationsSync()` (re-exported here) delivers the SIGKILL rung
 *      synchronously — and re-validates first, so a recycled pgid is skipped,
 *   7. the armed registry is empty after a flush, and flushing an empty registry
 *      never throws.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	__armedEscalationCountForTest,
	__resetArmedEscalationsForTest,
	__resetSelfIdentityForTest,
	__setSelfIdentityForTest,
	readProcIdentity,
	reapGroup,
} from "../../../src/runtime/process/reap-group.ts";
import { __test, drainReapEscalations, flushReapEscalationsSync, reconcileStaleRun } from "../../../src/runtime/stale-reconciler.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";

/** Repo root — the tsx loader (`--import tsx/esm`) must resolve from here. */
const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
/** The module under test, as an absolute URL a generated child script can import. */
const RECONCILER_URL = new URL("../../../src/runtime/stale-reconciler.ts", import.meta.url).href;
const PROC_IDENTITY_UID = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

function makeStateRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-reap-drain-"));
}

function makeManifest(stateRoot: string): TeamRunManifest {
	const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
	return {
		schemaVersion: 1,
		runId: "run-reap-drain-1",
		cwd: stateRoot,
		team: "impl",
		goal: "reap escalation drain",
		status: "running",
		createdAt: twentyMinAgo,
		updatedAt: twentyMinAgo,
		stateRoot,
		artifactsRoot: stateRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		workspaceMode: "single",
		artifacts: [],
	};
}

function staleTask(): TeamTaskState {
	const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
	return {
		id: "task-1",
		runId: "run-reap-drain-1",
		role: "executor",
		agent: "test-agent",
		title: "Test task",
		status: "running",
		dependsOn: [],
		cwd: "/tmp",
		// No async pid + a heartbeat frozen 20 min ago ⇒ no_pid_heartbeat_stale.
		heartbeat: { workerId: "task-1", lastSeenAt: twentyMinAgo, alive: true, pid: 4242 },
	} as TeamTaskState;
}

describe("stale-reconciler — armed group escalations are drained (MAJOR #3)", () => {
	afterEach(() => {
		__test.reset();
	});

	it("registers the armed escalation and resolves the drain only AFTER it settles", async () => {
		const stateRoot = makeStateRoot();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		__test.setReapRecordedWorkerOrphans(() => ({
			reaped: [4242],
			skipped: [],
			candidates: [4242],
			pending: [gate],
		}));
		try {
			const result = reconcileStaleRun(makeManifest(stateRoot), [staleTask()], Date.now());
			assert.equal(result.repaired, true, "the stale task must be cancelled (reap path reached)");

			let drained = false;
			const drain = drainReapEscalations().then(() => {
				drained = true;
			});
			// Give the drain a few macrotasks: the escalation is still in flight.
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.equal(drained, false, "the drain must NOT resolve while the SIGKILL escalation is pending");

			release();
			await drain;
			assert.equal(drained, true, "the drain resolves once the escalation settled");
		} finally {
			release();
			await drainReapEscalations();
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("a rejecting escalation is swallowed (never an unhandled rejection) and still drains", async () => {
		const stateRoot = makeStateRoot();
		__test.setReapRecordedWorkerOrphans(() => ({
			reaped: [4242],
			skipped: [],
			candidates: [4242],
			pending: [Promise.reject(new Error("escalation exploded"))],
		}));
		try {
			reconcileStaleRun(makeManifest(stateRoot), [staleTask()], Date.now());
			await assert.doesNotReject(() => drainReapEscalations());
		} finally {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("drain with nothing armed is an immediate no-op", async () => {
		const started = Date.now();
		await drainReapEscalations();
		assert.ok(Date.now() - started < 100, "an empty drain must not wait");
	});
});

// ── event-loop pin + synchronous shutdown flush (wave 11a.1 review) ──────────

/** A proc identity fixture (the escalation only ever compares these fields). */
function identity(
	pid: number,
	pgid: number,
	starttime: string,
): {
	pid: number;
	pgid: number;
	starttime: string;
	uid: number | undefined;
} {
	return { pid, pgid, starttime, uid: PROC_IDENTITY_UID() };
}

describe("stale-reconciler — the drain pins the loop, the flush delivers the SIGKILL", () => {
	// reap-group's ladder reads OUR OWN identity from /proc (rung 1 — never the
	// injected candidate reader). On a platform without /proc (macOS, Windows)
	// that read is undefined and (ii)'s arming calls would be refused at
	// `proc-unavailable` before any escalation exists. Seed a synthetic self
	// identity on exactly those platforms (a no-op on Linux).
	beforeEach(() => {
		__resetSelfIdentityForTest();
		if (readProcIdentity(process.pid) === undefined) {
			__setSelfIdentityForTest({ pid: process.pid, pgid: 4_000_001, starttime: "1", uid: PROC_IDENTITY_UID() });
		}
	});

	afterEach(() => {
		__test.reset();
		__resetArmedEscalationsForTest();
		__resetSelfIdentityForTest();
	});

	it("(i) holds a REF'D keep-alive while an escalation is in flight — proven in a child process", () => {
		// A resolver-free proof: the child arms an escalation whose only timer is
		// UNREF'd (exactly like reap-group's poll chain), starts the drain without
		// awaiting it, and lets its top level end. Without the drain's ref'd pin,
		// Node drains the loop immediately and the script's `.then` never runs; with
		// it, the child stays alive until the escalation settles and then exits 0.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-drain-pin-"));
		const script = path.join(dir, "pin-child.mts");
		fs.writeFileSync(
			script,
			[
				`import { __test, drainReapEscalations } from ${JSON.stringify(RECONCILER_URL)};`,
				"const startedAt = Date.now();",
				"let settled = false;",
				"const escalation = new Promise<void>((resolve) => {",
				"\tconst timer = setTimeout(() => {",
				"\t\tsettled = true;",
				"\t\tresolve();",
				"\t}, 250);",
				"\ttimer.unref?.();",
				"});",
				"__test.trackEscalation(escalation);",
				"void drainReapEscalations().then(() => {",
				"\tprocess.stdout.write(JSON.stringify({ elapsed: Date.now() - startedAt, settled }));",
				"});",
			].join("\n"),
			"utf-8",
		);
		try {
			const res = spawnSync(process.execPath, ["--import", "tsx/esm", script], {
				cwd: ROOT,
				encoding: "utf-8",
				timeout: 120_000,
				stdio: ["ignore", "pipe", "pipe"],
			});
			assert.equal(res.status, 0, `the pinned child must exit 0 (stderr: ${res.stderr})`);
			assert.notEqual(res.stdout.trim(), "", "the drain must still be running when the top level ends (a ref'd keep-alive)");
			const seen = JSON.parse(res.stdout.trim()) as { elapsed: number; settled: boolean };
			assert.equal(seen.settled, true, "the escalation settled before the process exited");
			assert.ok(seen.elapsed >= 200, `the process must live until the escalation settles (saw ${seen.elapsed}ms)`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("(i-b) an EMPTY drain creates no keep-alive interval at all", async (t) => {
		const setIntervalSpy = t.mock.method(globalThis, "setInterval");
		await drainReapEscalations();
		assert.equal(setIntervalSpy.mock.callCount(), 0, "nothing armed ⇒ nothing to pin");
	});

	it("(ii) flush delivers SIGKILL once for a pending group and NOT for a re-validated-away one", () => {
		__resetArmedEscalationsForTest();
		const signals: string[] = [];
		const pgidA = 424_242;
		const pgidB = 434_343;
		const identities = new Map<number, ReturnType<typeof identity>>([
			[4242, identity(4242, pgidA, "111")],
			[4343, identity(4343, pgidB, "111")],
		]);
		// Arm two escalations whose groups survive SIGTERM.
		for (const [candidatePid, pgid] of [
			[4242, pgidA],
			[4343, pgidB],
		] as const) {
			const result = reapGroup(pgid, candidatePid, {
				platform: "linux", // exercise the ladder identically on every OS (win32 would refuse at the platform rung)
				readIdentity: (pid) => identities.get(pid),
				signalGroup: (g, s) => signals.push(`${g}:${s}`),
				groupAlive: () => true,
				expected: identity(candidatePid, pgid, "111"),
				gracefulMs: 50,
				capMs: 50,
			});
			assert.equal(result.outcome, "killed-after-escalation");
		}
		assert.equal(__armedEscalationCountForTest(), 2, "both escalations are armed");
		assert.deepEqual(signals, [`${pgidA}:SIGTERM`, `${pgidB}:SIGTERM`]);

		// PID reuse on the FIRST group only: its starttime no longer matches the
		// snapshot, so the flush must refuse it and signal the second one only.
		identities.set(4242, identity(4242, pgidA, "999"));

		assert.equal(flushReapEscalationsSync(), 1, "exactly ONE deferred SIGKILL (the still-proven group only)");
		assert.deepEqual(signals, [`${pgidA}:SIGTERM`, `${pgidB}:SIGTERM`, `${pgidB}:SIGKILL`]);
		assert.equal(__armedEscalationCountForTest(), 0, "(iii) the armed registry is empty after the flush");
	});

	it("(iv) flushing an empty registry never throws", () => {
		__resetArmedEscalationsForTest();
		assert.doesNotThrow(() => flushReapEscalationsSync());
		assert.equal(flushReapEscalationsSync(), 0);
		assert.equal(__armedEscalationCountForTest(), 0);
	});
});
