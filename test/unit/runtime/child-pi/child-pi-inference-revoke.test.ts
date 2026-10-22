/**
 * child-pi-inference-revoke.test.ts — v0.11.36 exit-revoke WIRING pin.
 *
 * The revoke helper semantics are pinned in inference-broker.test.ts (k1).
 * THIS file pins the WIRING: the runChildPi wrapper revokes the task's
 * inference token when the run settles — normal exit, crash, or abort.
 *
 * Probe path: prepareSpawnContext registers `inference:<agentId>` BEFORE its
 * B5 pre-spawn abort check, so an already-aborted runChildPi (a) registers a
 * token, (b) never spawns, (c) returns an aborted result — and the wrapper's
 * finally must still revoke. Observable via inferenceBrokerStats(): with the
 * revoke wired, no entry for the key remains; with the revoke removed
 * (mutation), the orphan entry is right there in the table.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { runChildPi } from "../../../../src/runtime/child-pi/child-pi.ts";
import {
	INFERENCE_BROKER_ENABLE_ENV,
	inferenceBrokerStats,
	inferenceWorkerKeyForAgent,
	maybeStartInferenceBroker,
	stopInferenceBroker,
} from "../../../../src/runtime/child-pi/inference-broker.ts";

const agent: AgentConfig = {
	name: "executor",
	description: "executor",
	source: "builtin",
	filePath: "executor.md",
	systemPrompt: "executor",
};

test("runChildPi wrapper revokes the task inference token on abort-before-spawn (wiring pin)", async () => {
	// Mock upstream so the broker can start (credential resolution requires
	// an upstream-credentialed provider; the mock never serves a request).
	const upstream = http.createServer((_req, res) => {
		res.writeHead(500);
		res.end();
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	const upstreamPort = (upstream.address() as { port: number }).port;
	const saved: Record<string, string | undefined> = {};
	for (const key of [INFERENCE_BROKER_ENABLE_ENV, "ANTHROPIC_API_KEY", "PI_CREW_INFERENCE_UPSTREAM"]) saved[key] = process.env[key];
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	process.env.ANTHROPIC_API_KEY = "sk-ant-revoke-wiring-probe";
	process.env.PI_CREW_INFERENCE_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-revoke-"));
	const controller = new AbortController();
	controller.abort();
	let spawned = false;
	try {
		await maybeStartInferenceBroker();
		const result = await runChildPi({
			cwd,
			task: "never runs",
			agent,
			agentId: "task-revoke-probe-1",
			signal: controller.signal,
			onSpawn: () => {
				spawned = true;
			},
		});
		assert.equal(spawned, false, "B5: no child may spawn on an already-aborted signal");
		assert.equal(result.aborted, true, "inner run reports the abort");
		// THE wiring assertion: registration happened (prepareSpawnContext
		// registers before its B5 check) and the wrapper's finally must have
		// revoked it. No orphan entry may remain.
		const key = inferenceWorkerKeyForAgent("task-revoke-probe-1");
		const orphan = inferenceBrokerStats().find((s) => s.workerKey === key);
		assert.equal(orphan, undefined, "no live token may outlive the runChildPi call (exit-revoke wired)");
	} finally {
		stopInferenceBroker();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(cwd, { recursive: true, force: true });
		upstream.close();
	}
});
