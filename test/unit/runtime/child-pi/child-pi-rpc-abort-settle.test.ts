/**
 * L2-1 (upgrade research round 3 §3.2, Wave A item 2): pi 1.1.0 added
 * `aborted: boolean` to the `agent_settled` event (1.0.4 has no such field).
 * pi-crew must FEATURE-DETECT it — a worker-cancelled settle may never be
 * mistaken for a healthy finish, and a pooled rpc process must never re-enter
 * the pool as a healthy reuse candidate after a cancelled settle.
 *
 * Hermetic: same fake-RPC fixture pattern as child-pi-rpc-mode.test.ts
 * (PI_TEAMS_PI_BIN + npm_config_prefix allowlist trick; the REAL SDK RpcClient
 * owns the client side of the wire). The "1.1.0 host" shape is produced by
 * restaging the fixture with every normal settle flipped to aborted:true —
 * no fixture file is modified on disk (the staged copy lives in the tmpdir).
 *
 * Regression BOTH shapes:
 *   - record WITHOUT the field (pre-1.1.0 host): settle stays healthy
 *     (exit 0, aborted falsy) — byte-identical legacy behavior.
 *   - record WITH aborted:true (1.1.0 host): run marked cancelled
 *     (result.aborted true, crashClass "cancelled"), pool entry evicted /
 *     never registered → the NEXT run for the same agent spawns a NEW pid.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { runChildPi } from "../../../../src/runtime/child-pi/child-pi.ts";
import { clearRpcPool } from "../../../../src/runtime/child-pi/child-pi-rpc.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures", import.meta.url));
const RPC_FIXTURE_SRC = path.join(FIXTURES_DIR, "fake-pi-rpc.mjs");

/** Env snapshot keys this suite mutates (restored per-test in finally). */
const MUTATED_ENV_KEYS = [
	"PI_CREW_CHILD_PI_MODE",
	"PI_CREW_CHILD_PI_POOL",
	"PI_TEAMS_PI_BIN",
	"PI_TEAMS_MOCK_CHILD_PI",
	"PI_CREW_ALLOW_MOCK",
	"PI_CREW_DEPTH",
	"PI_TEAMS_DEPTH",
	"npm_config_prefix",
] as const;

interface Harness {
	workRoot: string;
	binDir: string;
	/** Toggle the staged fixture: true = every normal settle carries aborted:true (1.1.0 host shape); false = original. */
	setAbortedSettle: (on: boolean) => void;
	cleanup: () => void;
}

async function makeHarness(): Promise<Harness> {
	const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "l21-abort-settle-"));
	const binDir = path.join(workRoot, "bin");
	fs.mkdirSync(binDir, { recursive: true });

	const saved: Record<string, string | undefined> = {};
	for (const key of MUTATED_ENV_KEYS) saved[key] = process.env[key];
	process.env.npm_config_prefix = binDir; // pi-spawn.ts isWithinAllowedPrefixes
	process.env.PI_TEAMS_PI_BIN = path.join(binDir, "fake-pi-rpc.mjs");
	fs.copyFileSync(RPC_FIXTURE_SRC, process.env.PI_TEAMS_PI_BIN);
	process.env.PI_CREW_CHILD_PI_MODE = "rpc";
	delete process.env.PI_CREW_CHILD_PI_POOL;
	delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	delete process.env.PI_CREW_ALLOW_MOCK;
	// Ambient PI_CREW_* from a pi-crew worker session must not leak in
	// (depth guards would fail-closed the spawn — see .crew/knowledge.md).
	delete process.env.PI_CREW_DEPTH;
	delete process.env.PI_TEAMS_DEPTH;

	const stagedPath = path.join(binDir, "fake-pi-rpc.mjs");
	const originalBody = fs.readFileSync(RPC_FIXTURE_SRC, "utf-8");
	assert.ok(originalBody.split("settleRun(false)").length - 1 >= 2, "fixture must contain the normal-settle call sites");
	const abortedBody = originalBody.split("settleRun(false)").join("settleRun(true)");

	const harness: Harness = {
		workRoot,
		binDir,
		setAbortedSettle: (on) => {
			fs.writeFileSync(stagedPath, on ? abortedBody : originalBody, "utf-8");
			process.env.PI_TEAMS_PI_BIN = stagedPath;
		},
		cleanup: () => {
			for (const key of MUTATED_ENV_KEYS) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
			fs.rmSync(workRoot, { recursive: true, force: true });
		},
	};
	return harness;
}

function makeAgent(): AgentConfig {
	return {
		name: "executor",
		description: "L2-1 abort-settle test agent",
		source: "user",
		filePath: "<test>",
		systemPrompt: "You are an L2-1 test agent.",
		inheritProjectContext: false,
		inheritSkills: false,
		tools: [],
		disableTools: true,
	} as AgentConfig;
}

async function waitForPidGone(pid: number, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
}

test("pre-1.1.0 shape: agent_settled WITHOUT the aborted field settles healthy (legacy behavior)", async () => {
	const h = await makeHarness();
	try {
		const result = await runChildPi({
			cwd: h.workRoot,
			task: "L21-LEGACY-MARKER",
			agent: makeAgent(),
			runId: "l21-legacy",
			agentId: "l21-legacy-worker",
			artifactsRoot: path.join(h.workRoot, "art"),
		});
		assert.equal(result.exitCode, 0, `result=${JSON.stringify({ exitCode: result.exitCode, error: result.error })}`);
		assert.notEqual(result.aborted, true, "a settle without the field must NEVER be marked cancelled");
	} finally {
		h.cleanup();
	}
});

test("1.1.0 shape: aborted:true marks the run cancelled (pool OFF default) and disposes the process", async () => {
	const h = await makeHarness();
	h.setAbortedSettle(true);
	try {
		let pid: number | undefined;
		const result = await runChildPi({
			cwd: h.workRoot,
			task: "L21-ABORTED-MARKER",
			agent: makeAgent(),
			runId: "l21-aborted",
			agentId: "l21-aborted-worker",
			artifactsRoot: path.join(h.workRoot, "art"),
			onSpawn: (p) => {
				pid = p;
			},
		});
		assert.equal(
			result.aborted,
			true,
			`host-aborted settle must mark the run cancelled; result=${JSON.stringify({ exitCode: result.exitCode, error: result.error })}`,
		);
		assert.equal(result.exitStatus?.crashClass, "cancelled", "crash classification must be cancelled, not clean_exit");
		assert.ok(pid, "onSpawn must have fired");
		assert.ok(await waitForPidGone(pid!), `rpc child pid ${pid} must not survive the aborted settle`);
	} finally {
		h.cleanup();
	}
});

test("1.1.0 shape: a cancelled worker NEVER re-enters the rpc pool as healthy (next run = NEW pid)", async () => {
	const h = await makeHarness();
	process.env.PI_CREW_CHILD_PI_POOL = "1";
	h.setAbortedSettle(true);
	try {
		const pids: number[] = [];
		const mkInput = (marker: string) => ({
			cwd: h.workRoot,
			task: marker,
			agent: makeAgent(),
			runId: "l21-pool",
			agentId: "l21-pool-worker", // SAME agent id → same pool key
			artifactsRoot: path.join(h.workRoot, "art"),
			onSpawn: (p: number) => pids.push(p),
		});
		const r1 = await runChildPi(mkInput("L21-POOL-ABORTED"));
		assert.equal(
			r1.aborted,
			true,
			`cancelled settle must surface aborted; result=${JSON.stringify({ exitCode: r1.exitCode, error: r1.error })}`,
		);
		// Restore the HEALTHY fixture for run two: only run one settles cancelled.
		h.setAbortedSettle(false);
		// The healthy-reuse counterfactual is pinned by child-pi-rpc-mode.test.ts
		// ("pool reuses ONE process"). Here the FIRST settle was cancelled, so
		// the entry must have been evicted (or never registered): run two MUST
		// spawn a fresh process — reusing a worker-cancelled process as healthy
		// is exactly the L2-1 hazard.
		const r2 = await runChildPi(mkInput("L21-POOL-NEXT"));
		assert.equal(r2.exitCode, 0, `run2 error=${r2.error ?? "(none)"}`);
		assert.notEqual(r2.aborted, true, "run2 settles normally (restaged fixture only aborts on its own settle knob)");
		assert.equal(pids.length, 2, "onSpawn fires per run");
		assert.notEqual(pids[0], pids[1], `a cancelled worker must NOT be reused (pids ${pids.join(",")})`);
	} finally {
		clearRpcPool(); // stops any live process — nothing may leak past the test
		h.cleanup();
	}
});
