/**
 * worker-cache-retention.test.ts — W10-1 (v0.11.38) pin.
 *
 * pi-subagents lesson #10 (child-cache-retention.ts): single-run worker
 * processes should opt into SHORT prompt-cache retention — long-retention
 * cache writes carry a higher per-write surcharge, wasted on a worker that
 * exits after one task. Surface panes and RPC warm sessions keep the parent
 * default (their sessions persist and benefit from long-lived cache).
 *
 * Wiring under test:
 *   - buildFinalChildPiSpawnOptions(..., workerCacheSplit?: boolean) sets
 *     PI_CACHE_RETENTION=short ONLY when the flag is true (headless worker
 *     branch, child-pi.ts spawn site passes true).
 *   - Default (surface :493 caller, rpc child-pi-rpc.ts :490 caller) does NOT
 *     set the key at all — the allowlist base never carries it, so absence is
 *     the parent default, not an inherited leak.
 *
 * Mutation pin: removing the `if (workerCacheSplit)` block in
 * child-pi-spawn.ts flips case (1) red (key missing); passing `true` at the
 * surface/rpc call sites would flip case (2) red (key present).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFinalChildPiSpawnOptions } from "../../../../src/runtime/child-pi/child-pi-spawn.ts";

const CONTROL_KEYS: Record<string, string> = {
	PI_CREW_KIND: "subagent",
	PI_CREW_ROLE: "executor",
};

const STD_ENV: Record<string, string> = {
	PATH: "/usr/local/bin:/usr/bin:/bin",
	HOME: "/home/user",
	USER: "user",
	SHELL: "/bin/bash",
	TERM: "xterm-256color",
	LANG: "en_US.UTF-8",
};

const CWD = "/tmp/project";

describe("W10-1 worker cache retention split (PI_CACHE_RETENTION)", () => {
	it("(1) workerCacheSplit=true → child env carries PI_CACHE_RETENTION=short", () => {
		const opts = buildFinalChildPiSpawnOptions(CWD, STD_ENV, CONTROL_KEYS, undefined, undefined, true);
		assert.equal(opts.env?.PI_CACHE_RETENTION, "short");
	});

	it("(2) default (surface/rpc call sites) → key ABSENT, not inherited from merged env", () => {
		// Even if the PARENT process env carried a stale value, the allowlist
		// base strips it and the flag is off → child sees no key at all.
		const mergedWithStale = { ...STD_ENV, PI_CACHE_RETENTION: "long" };
		const opts = buildFinalChildPiSpawnOptions(CWD, mergedWithStale, CONTROL_KEYS);
		assert.equal("PI_CACHE_RETENTION" in (opts.env ?? {}), false);
	});

	it("(3) flag value 'short' is literal (never configurable per-call)", () => {
		const opts = buildFinalChildPiSpawnOptions(CWD, STD_ENV, CONTROL_KEYS, undefined, undefined, true);
		assert.equal(opts.env?.PI_CACHE_RETENTION, "short");
		// workerCacheSplit is boolean — ensure no string leakage via builtEnv:
		// Non-control key in builtEnv is rejected by the canary — this is the
		// guard that keeps the injection site the ONLY path for the key.
		assert.throws(() => buildFinalChildPiSpawnOptions(CWD, STD_ENV, { ...CONTROL_KEYS, PI_CACHE_RETENTION: "1h" }));
	});
});
