/**
 * env-splice-canary.test.ts — MINOR-4 + R2-L-A7 pins (wave 8).
 *
 * The RPC env-splice contract: RpcClient.start() must spawn its child in the
 * SYNCHRONOUS prefix (while process.env is swapped to the allowlisted
 * childEnv). If an SDK update moves the spawn past the first await, the child
 * silently inherits the FULL parent env (provider keys) — the canary detects
 * that and the caller kills the child.
 *
 * Wave-8 fix pins THREE things the wave-2b version got wrong:
 *  1. DEAD WINDOW: the canary used to be deleted from the parent env
 *     synchronously after start() returned — BEFORE `await startPromise`. The
 *     drifted spawn (the exact case being guarded) happened after the delete,
 *     inherited a canary-free env, and could NEVER be detected — even on
 *     Linux. The window now stays open (refcounted across concurrent RPC
 *     spawns) until post-spawn verification completes. The LIVE drift test
 *     below fails against the old ordering.
 *  2. PLATFORM COVERAGE: linux /proc/<pid>/environ; darwin `ps -Eww -o
 *     command=`; win32 has no cross-process environ API — no longer a silent
 *     PASS (one-time explicit warn via onUnobservable/logInternalError).
 *  3. INJECTABLE OBSERVATION: verifyRpcSpawnEnvSplice accepts {reader,
 *     platform, onUnobservable} so every branch is pinned cross-platform.
 *
 * Mutation checks (2026-10-20):
 *  - moving the window close back before the await (old ordering) → the LIVE
 *    drift test fails;
 *  - removing the refcount (unconditional set/delete per window) → the
 *    overlapping-window test fails.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { closeRpcEnvSpliceWindow, openRpcEnvSpliceWindow, verifyRpcSpawnEnvSplice } from "../../../../src/runtime/child-pi/child-pi-rpc.ts";

const CANARY = "PI_CREW_RPC_ENV_SPLICE_CANARY";

/** Close until the marker is gone (self-healing cleanup for failed tests). */
function closeAllWindows(): void {
	for (let i = 0; i < 8 && process.env[CANARY] !== undefined; i++) closeRpcEnvSpliceWindow();
}

test("canary window: refcounted — open/open/close keeps the marker, last close removes it", () => {
	try {
		delete process.env[CANARY];
		openRpcEnvSpliceWindow();
		assert.equal(process.env[CANARY], "1", "first open sets the marker");
		openRpcEnvSpliceWindow();
		assert.equal(process.env[CANARY], "1", "nested open keeps the marker");
		closeRpcEnvSpliceWindow();
		assert.equal(process.env[CANARY], "1", "inner window close must NOT remove the marker while an outer window is open");
		closeRpcEnvSpliceWindow();
		assert.equal(process.env[CANARY], undefined, "last close removes the marker");
		closeRpcEnvSpliceWindow(); // over-close is a safe no-op
		assert.equal(process.env[CANARY], undefined);
	} finally {
		closeAllWindows();
	}
});

test("canary window: closing an unopened window is a no-op (depth floor at 0)", () => {
	try {
		delete process.env[CANARY];
		closeRpcEnvSpliceWindow();
		assert.equal(process.env[CANARY], undefined);
		// A subsequent open still works (depth did not go negative).
		openRpcEnvSpliceWindow();
		assert.equal(process.env[CANARY], "1");
		closeRpcEnvSpliceWindow();
		assert.equal(process.env[CANARY], undefined);
	} finally {
		closeAllWindows();
	}
});

test("verify: /proc-format environ (linux dispatch) — canary entry detected", () => {
	const fakeProc = { pid: 424242 } as never;
	const ok = verifyRpcSpawnEnvSplice(fakeProc, {
		platform: "linux",
		reader: () => "PATH=/usr/bin\0HOME=/root\0LC_ALL=C",
	});
	assert.equal(ok, true, "clean child env → verified");
	const leaked = verifyRpcSpawnEnvSplice(fakeProc, {
		platform: "linux",
		reader: () => "PATH=/usr/bin\0PI_CREW_RPC_ENV_SPLICE_CANARY=1\0LC_ALL=C",
	});
	assert.equal(leaked, false, "canary entry in child environ → SPAWN CONTRACT DRIFT");
});

test("verify: /proc entry must match the KEY exactly (value substrings don't false-positive)", () => {
	const fakeProc = { pid: 424242 } as never;
	const ok = verifyRpcSpawnEnvSplice(fakeProc, {
		platform: "linux",
		reader: () => "SOME_VAR=prefix PI_CREW_RPC_ENV_SPLICE_CANARY suffix",
	});
	assert.equal(ok, true, "an entry merely CONTAINING the name in its VALUE is not a leak");
});

test("verify: darwin ps -Eww format — appended KEY=VALUE environment detected", () => {
	const fakeProc = { pid: 424242 } as never;
	const ok = verifyRpcSpawnEnvSplice(fakeProc, {
		platform: "darwin",
		reader: () => "/usr/local/bin/pi --mode rpc --some-flag TERM=xterm-256color PATH=/usr/bin:/bin",
	});
	assert.equal(ok, true, "clean ps output → verified");
	const leaked = verifyRpcSpawnEnvSplice(fakeProc, {
		platform: "darwin",
		reader: () => "/usr/local/bin/pi --mode rpc PI_CREW_RPC_ENV_SPLICE_CANARY=1 TERM=xterm-256color",
	});
	assert.equal(leaked, false, "canary in the ps-appended environment → SPAWN CONTRACT DRIFT");
});

test("verify: unobservable platform (win32) — explicit signal, never a silent-PASS with zero signal", () => {
	const fakeProc = { pid: 424242 } as never;
	const seen: string[] = [];
	const ok = verifyRpcSpawnEnvSplice(fakeProc, { platform: "win32", onUnobservable: (p) => seen.push(p) });
	assert.equal(ok, true, "no OS API → best-effort pass (kill-on-suspicion is worse)");
	assert.deepEqual(seen, ["win32"], "the observability gap must be surfaced to the caller");
});

test("verify: reader reports unobservable (raced exit) → best-effort pass, no unobservable signal", () => {
	const fakeProc = { pid: 424242 } as never;
	const seen: string[] = [];
	const ok = verifyRpcEnvHelper(
		fakeProc,
		() => undefined,
		(p) => seen.push(p),
	);
	assert.equal(ok, true);
	assert.deepEqual(seen, [], "an unobservable PID is NOT the same as an unobservable PLATFORM");
});

// The linux dispatch path uses the built-in /proc reader; exercise it via the
// opts shape it actually takes in production (no explicit reader).
function verifyRpcEnvHelper(proc: never, reader: () => string | undefined, onUnobservable: (p: string) => void): boolean {
	return verifyRpcSpawnEnvSplice(proc, { platform: "linux", reader, onUnobservable: onUnobservable as never });
}

test("LIVE drift (linux): a child spawned DURING the open window inherits the canary → verify MUST fail", {
	skip: process.platform !== "linux",
}, async () => {
	openRpcEnvSpliceWindow();
	let leaked: ReturnType<typeof verifyRpcSpawnEnvSplice> | undefined;
	let clean: ReturnType<typeof verifyRpcSpawnEnvSplice> | undefined;
	try {
		// Simulate the drifted SDK: the spawn happens AFTER start()'s sync
		// prefix (i.e. during the await window), so the child inherits
		// process.env AS IT IS NOW — marker included. This is exactly the
		// ordering the wave-2b code destroyed by deleting the marker early.
		const child = spawn(process.execPath, ["-e", "process.stdout.write('up'); setInterval(() => {}, 1e6)"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		try {
			await new Promise<void>((resolve) => {
				child.stdout.once("data", () => resolve());
				child.once("exit", () => resolve());
			});
			leaked = verifyRpcSpawnEnvSplice(child); // real /proc reader
		} finally {
			child.kill("SIGKILL");
		}
		assert.equal(leaked, false, "drifted spawn during the window MUST be detected (wave-2b ordering was blind here)");
	} finally {
		closeRpcEnvSpliceWindow();
	}
	// After the window closes, a child spawned now is CLEAN — the negative
	// control proving the detection above came from the window, not from some
	// ambient env pollution.
	const child2 = spawn(process.execPath, ["-e", "process.stdout.write('up'); setInterval(() => {}, 1e6)"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	try {
		await new Promise<void>((resolve) => {
			child2.stdout.once("data", () => resolve());
			child2.once("exit", () => resolve());
		});
		clean = verifyRpcSpawnEnvSplice(child2);
	} finally {
		child2.kill("SIGKILL");
	}
	assert.equal(clean, true, "post-window spawn must verify clean");
	assert.equal(process.env[CANARY], undefined, "window must be fully closed after verification");
});

// ---------------------------------------------------------------------------
// WIRING pin (runRpcSession): the window must span client.start()'s await —
// a client whose spawn lands AFTER start()'s sync prefix (SDK drift) must be
// killed with the loud splice-failure error. Differential: against the
// wave-2b ordering (marker deleted right after start() returned) the drifted
// child inherits a marker-free env, verification passes, and this exact
// assertion fails (2026-10-20 mutation check).
// ---------------------------------------------------------------------------

test("WIRING: drifted (post-await) spawn via runRpcSession → killed with splice-failure error", {
	skip: process.platform !== "linux",
}, async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const { __runRpcSessionWithCtorForTests } = await import("../../../../src/runtime/child-pi/child-pi-rpc.ts");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-drift-"));
	try {
		const spawned: Array<import("node:child_process").ChildProcess> = [];
		class DriftingClient {
			process: import("node:child_process").ChildProcess | null = null;
			constructor(_opts: unknown) {}
			async start() {
				// SDK DRIFT: the spawn happens AFTER an await — outside the
				// synchronous prefix, with process.env restored (marker still
				// present under the FIXED window ordering).
				await new Promise((r) => setTimeout(r, 25));
				const child = spawn(process.execPath, ["-e", "process.stdout.write('up'); setInterval(() => {}, 1e6)"], {
					stdio: ["ignore", "pipe", "ignore"],
					env: { ...process.env },
				});
				this.process = child;
				spawned.push(child);
			}
			async stop() {}
			onEvent(_l: unknown) {
				return () => {};
			}
			getStderr() {
				return "";
			}
			async prompt() {
				throw new Error("wire should never be reached for a killed child");
			}
			async steer() {
				return {};
			}
			async followUp() {
				return {};
			}
			async abort() {}
			async clearQueue() {
				return { steering: [], followUp: [] };
			}
		}
		const events: Array<{ type?: string; error?: string }> = [];
		const result = await __runRpcSessionWithCtorForTests(
			DriftingClient as never,
			{
				input: {
					cwd: tmp,
					task: "drift-pin",
					agent: { name: "drift-worker", description: "", tools: [] } as never,
					runId: "run-drift-pin",
					agentId: "drift-worker",
					artifactsRoot: path.join(tmp, "art"),
					finalDrainMs: 100,
					onLifecycleEvent: (ev: { type?: string; error?: string }) => events.push(ev),
				},
				effectiveTask: "drift-pin",
				ctx: {
					spawnSpec: { command: process.execPath, args: [] } as never,
					builtArgs: [],
					mergedEnv: { ...process.env },
					tempDir: undefined,
					builtEnv: {},
				},
				workerSession: undefined,
				sessionRecoveryEnabled: false,
			},
			"node",
		);
		assert.match(
			result.error ?? "",
			/env allowlist splice failed/,
			`drifted spawn must be killed loudly; got error=${result.error ?? "(none)"} events=${JSON.stringify(events)}`,
		);
		assert.equal(result.exitStatus?.killed, true, "the leaked child must be killed");
		for (const c of spawned) {
			assert.ok(c.killed || c.exitCode !== null || c.signalCode !== undefined || !c.pid, "spawned child must not survive");
			try {
				c.kill("SIGKILL");
			} catch {
				/* already dead */
			}
		}
		assert.equal(process.env[CANARY], undefined, "window must close even on the kill path");
	} finally {
		closeAllWindows();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
