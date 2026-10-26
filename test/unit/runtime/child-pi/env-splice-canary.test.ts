/**
 * env-splice-canary.test.ts — MINOR-4 → R2-L-A7 → S* (v0.11.30) pins.
 *
 * HISTORY:
 *  - wave-2b: /proc canary, Linux-only, marker deleted too early (dead window).
 *  - wave-8 (v0.11.29): refcounted marker window spanning the await; the
 *    process.env swap + canary DETECTED a drifted (post-await) spawn and
 *    killed the child loudly.
 *  - S* (v0.11.30): the swap is GONE. `buildExactEnvShadowOptions` puts
 *    `undefined` in the RpcClient env option for EVERY parent key outside the
 *    intended allowlisted set; the SDK's own merge
 *    `{...process.env, ...options.env}` then yields undefined for those keys
 *    and Node's spawn DROPS undefined entries — the child receives EXACTLY
 *    the intended set on every OS, deterministically, REGARDLESS of when the
 *    spawn fires. SDK drift is structurally INERT now (nothing to leak), and
 *    the canary stays as a production TRIPWIRE proving the invariant.
 *
 * Test layers:
 *  (a) S* mechanism pins: spread-override semantics, Node spawn dropping
 *      undefined env values (real spawn), the shadow builder unit.
 *  (b) Canary window pins: refcounted open/close.
 *  (c) Detector pins: /proc + ps formats, exact-key matching, unobservable
 *      platform signal (win32) — all via injected readers.
 *  (d) LIVE exactness (linux): a child spawned with REAL SDK-merge semantics
 *      during an open window receives the exact set (no canary, no probes).
 *  (e) WIRING pin (linux): runRpcSession + a drifting mock client (spawn
 *      after start()'s first await, real merge semantics) → NOT killed, env
 *      exact, run proceeds to prompt delivery. Mutation check 2026-10-20:
 *      removing the shadow loop in buildExactEnvShadowOptions flips this red
 *      (drifted child then inherits the parent env incl. the canary marker →
 *      verifyRpcSpawnEnvSplice kills it).
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import {
	buildExactEnvShadowOptions,
	closeRpcEnvSpliceWindow,
	openRpcEnvSpliceWindow,
	verifyRpcSpawnEnvSplice,
} from "../../../../src/runtime/child-pi/child-pi-rpc.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const CANARY = "PI_CREW_RPC_ENV_SPLICE_CANARY";

/** Close until the marker is gone (self-healing cleanup for failed tests). */
function closeAllWindows(): void {
	for (let i = 0; i < 8 && process.env[CANARY] !== undefined; i++) closeRpcEnvSpliceWindow();
}

// ---------------------------------------------------------------------------
// (a) S* mechanism pins — the two JS/Node behaviors the whole design rests on
// ---------------------------------------------------------------------------

test("S* pin 1: spread semantics — a later {K: undefined} OVERRIDES the earlier key", () => {
	const merged = { ...{ SECRET: "real-key", OTHER: "x" }, ...{ SECRET: undefined, WANTED: "yes" } };
	assert.equal("SECRET" in merged, true, "the key must still be present (as undefined), not removed by spread");
	assert.equal(merged.SECRET, undefined, "undefined in the LATER object wins — the merge result is undefined, not the parent value");
	assert.equal(merged.OTHER, "x", "parent keys not shadowed survive the merge (that is why they MUST be shadowed explicitly)");
	assert.equal(merged.WANTED, "yes");
});

test('S* pin 2: Node spawn DROPS env entries with undefined values (child sees ABSENT, not "undefined"/"")', () => {
	const r = spawnSync(
		process.execPath,
		[
			"-e",
			"process.stdout.write(JSON.stringify({absent: process.env.S_STAR_PROBE_SECRET === undefined, fallback: process.env.S_STAR_PROBE_WANTED ?? null}))",
		],
		{ env: { ...process.env, S_STAR_PROBE_SECRET: undefined, S_STAR_PROBE_WANTED: "yes" }, encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(r.status, 0, `probe child failed: ${r.stderr}`);
	const seen = JSON.parse(r.stdout.trim()) as { absent: boolean; fallback: string | null };
	assert.equal(seen.absent, true, 'undefined-valued env entry must be ABSENT from the child env (not the string "undefined")');
	assert.equal(seen.fallback, "yes", "defined entries pass through");
});

test("S* pin 3: buildExactEnvShadowOptions — parent keys outside the intended set are shadowed undefined; intended keys pass through", () => {
	const prevProbe = process.env.PI_CREW_S_STAR_UNIT_PROBE;
	process.env.PI_CREW_S_STAR_UNIT_PROBE = "parent-leak";
	try {
		const intended: Record<string, string | undefined> = { PATH: "/usr/bin", HOME: "/root", OPTIONAL_UNDEF: undefined };
		const shadow = buildExactEnvShadowOptions(intended);
		assert.equal(shadow.PI_CREW_S_STAR_UNIT_PROBE, undefined, "parent-only key must be shadowed to undefined");
		assert.equal("PI_CREW_S_STAR_UNIT_PROBE" in shadow, true, "shadowed key PRESENT in the map (spread-override requirement)");
		assert.equal(shadow.PATH, "/usr/bin");
		assert.equal(shadow.HOME, "/root");
		assert.equal(shadow.OPTIONAL_UNDEF, undefined, "undefined-valued intended entries stay undefined (absent in child)");
		// Prove the end-to-end merge with the exact SDK expression:
		const merged = { ...process.env, ...shadow };
		assert.equal(merged.PI_CREW_S_STAR_UNIT_PROBE, undefined);
		assert.equal(merged.PATH, "/usr/bin");
	} finally {
		if (prevProbe === undefined) delete process.env.PI_CREW_S_STAR_UNIT_PROBE;
		else process.env.PI_CREW_S_STAR_UNIT_PROBE = prevProbe;
	}
});

// ---------------------------------------------------------------------------
// (b) canary window pins (unchanged role: the marker feeds the verifier)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// (c) detector pins — the canary is now a production TRIPWIRE for the S*
//     invariant "child env == intended set"; these pin the detector itself.
// ---------------------------------------------------------------------------

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
	assert.equal(leaked, false, "canary entry in child environ → INVARIANT BROKEN");
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
	assert.equal(leaked, false, "canary in the ps-appended environment → INVARIANT BROKEN");
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
	const ok = verifyRpcSpawnEnvSplice(fakeProc, { platform: "linux", reader: () => undefined, onUnobservable: (p) => seen.push(p) });
	assert.equal(ok, true);
	assert.deepEqual(seen, [], "an unobservable PID is NOT the same as an unobservable PLATFORM");
});

// ---------------------------------------------------------------------------
// (d) LIVE exactness (linux): a child spawned with REAL SDK-merge semantics
//     during an open canary window receives EXACTLY the intended set.
// ---------------------------------------------------------------------------

test("LIVE exactness (linux): SDK-merge spawn during the window → child env is the exact intended set", {
	skip: process.platform !== "linux",
}, async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-sstar-"));
	const PROBE = "PI_CREW_S_STAR_LIVE_PROBE";
	const prev = process.env[PROBE];
	process.env[PROBE] = "would-leak";
	openRpcEnvSpliceWindow();
	let child: ReturnType<typeof spawn> | undefined;
	try {
		const intended: Record<string, string | undefined> = { PATH: process.env.PATH, PI_CREW_S_STAR_WANTED: "yes" };
		const shadow = buildExactEnvShadowOptions(intended);
		// EXACT SDK semantics: RpcClient spawns with the merged env, possibly
		// DELAYED (drift) — simulate the worst case by awaiting first.
		await new Promise((r) => setTimeout(r, 10));
		child = spawn(
			process.execPath,
			["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).sort())); setInterval(() => {}, 1e6)"],
			{ stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...shadow } },
		);
		const keysRaw = await new Promise<string>((resolve) => {
			child?.stdout?.once("data", (d) => resolve(d.toString()));
			child?.once("exit", () => resolve(""));
		});
		const keys = new Set(JSON.parse(keysRaw || "[]") as string[]);
		assert.equal(keys.has(CANARY), false, "canary marker must NOT reach the child despite the open window + drift");
		assert.equal(keys.has(PROBE), false, "arbitrary parent-only key must be shadowed away");
		assert.equal(keys.has("PI_CREW_S_STAR_WANTED"), true, "intended key present");
		assert.equal(keys.has("PATH"), true, "plumbing key present");
		// Tripwire agrees: the merged-env child must verify clean.
		assert.equal(verifyRpcSpawnEnvSplice(child), true, "canary tripwire must verify the exact env as clean");
	} finally {
		child?.kill("SIGKILL");
		closeAllWindows();
		if (prev === undefined) delete process.env[PROBE];
		else process.env[PROBE] = prev;
		await removeDirWithRetry(tmp);
	}
});

// ---------------------------------------------------------------------------
// (e) WIRING pin (runRpcSession): SDK drift is INERT under S* — a client
//     whose spawn lands after start()'s first await still receives the exact
//     intended env; the run is NOT killed and proceeds to prompt delivery.
// ---------------------------------------------------------------------------

test("WIRING S*: drifted (post-await) spawn via runRpcSession → env EXACT, NOT killed, run proceeds", {
	skip: process.platform !== "linux",
}, async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const { __runRpcSessionWithCtorForTests } = await import("../../../../src/runtime/child-pi/child-pi-rpc.ts");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-drift-"));
	const PROBE = "PI_CREW_W8_SHADOW_PROBE";
	const prevProbe = process.env[PROBE];
	process.env[PROBE] = "would-leak";
	const envProbeFile = path.join(tmp, "child-env-keys.json");
	try {
		const spawned: Array<import("node:child_process").ChildProcess> = [];
		let ctorEnv: Record<string, string | undefined> | undefined;
		class DriftingClient {
			process: import("node:child_process").ChildProcess | null = null;
			constructor(opts: { env?: Record<string, string | undefined> }) {
				ctorEnv = opts.env;
			}
			async start() {
				// SDK DRIFT: the spawn happens AFTER an await — outside the
				// synchronous prefix. The client applies REAL SDK merge
				// semantics: {...process.env, ...options.env}.
				await new Promise((r) => setTimeout(r, 25));
				const child = spawn(
					process.execPath,
					[
						"-e",
						"process.stdout.write('up'); require('node:fs').writeFileSync(process.env.PI_CREW_ENVPROBE_FILE, JSON.stringify(Object.keys(process.env).sort())); setInterval(() => {}, 1e6)",
					],
					{
						stdio: ["ignore", "pipe", "ignore"],
						env: { ...process.env, ...(ctorEnv ?? {}), PI_CREW_ENVPROBE_FILE: envProbeFile },
					},
				);
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
				// Reached ONLY when the run was not killed at verification —
				// the signal that drift was inert. Failing here is the
				// expected terminal state for this mock.
				throw new Error("wire reached (drift inert) — mock terminal");
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
		assert.equal(
			(result.error ?? "").includes("env allowlist splice failed"),
			false,
			`drift must be INERT under S* (no kill); got error=${result.error ?? "(none)"} events=${JSON.stringify(events)}`,
		);
		assert.match(result.error ?? "", /wire reached/, "the run must have proceeded PAST verification to prompt delivery");
		assert.equal(result.exitStatus?.killed, false, "the drifted child must NOT be killed");
		// The child writes its env probe asynchronously — poll for the file
		// (bounded), never a fixed sleep (wave-7 discipline).
		let probeJson = "";
		for (let waited = 0; waited < 50 && probeJson === ""; waited++) {
			try {
				probeJson = fs.readFileSync(envProbeFile, "utf8");
			} catch {
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		assert.notEqual(probeJson, "", "child env probe file must appear (spawned child should have written its env keys)");
		const keys = new Set(JSON.parse(probeJson) as string[]);
		assert.equal(keys.has(CANARY), false, "canary must not reach the drifted child");
		assert.equal(keys.has(PROBE), false, "parent-only PI_CREW_* probe must be shadowed away");
		assert.equal(keys.has("PATH"), true, "allowlisted plumbing key present");
		for (const c of spawned) {
			try {
				c.kill("SIGKILL");
			} catch {
				/* already dead */
			}
		}
		assert.equal(process.env[CANARY], undefined, "window must close even when the run proceeds");
	} finally {
		closeAllWindows();
		if (prevProbe === undefined) delete process.env[PROBE];
		else process.env[PROBE] = prevProbe;
		await removeDirWithRetry(tmp);
	}
});
