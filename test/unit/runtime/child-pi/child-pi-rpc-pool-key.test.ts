/**
 * R2-M-A5 (Wave-3 cheap parts): the rpc pool key is RUN-SCOPED — two runs
 * with the same agent id must NEVER share a pooled entry (worker env/session/
 * transcript state is run-scoped). Flags stay default-off; this pins the key
 * + requesting-run derivation only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { poolKeyFor, requestingRunIdFor } from "../../../../src/runtime/child-pi/child-pi-rpc.ts";

const agent: AgentConfig = {
	name: "executor",
	description: "d",
	source: "project",
	filePath: "/x/executor.md",
	systemPrompt: "",
};

function inputFor(runId: string | undefined, agentId = "t1:01") {
	return { cwd: "/tmp", task: "t", agent, runId, agentId };
}

test("poolKeyFor: two runs, same agent id → DIFFERENT keys", () => {
	const a = poolKeyFor(inputFor("run_a"));
	const b = poolKeyFor(inputFor("run_b"));
	assert.notEqual(a, b, "run-scoped key must not collide across runs");
	assert.equal(a, "run_a:t1:01:executor");
	assert.equal(b, "run_b:t1:01:executor");
});

test("poolKeyFor: same run + agent → stable key; agentName disambiguates", () => {
	assert.equal(poolKeyFor(inputFor("run_a")), poolKeyFor(inputFor("run_a")));
	const otherAgent = poolKeyFor({ ...inputFor("run_a"), agent: { ...agent, name: "writer" } });
	assert.notEqual(poolKeyFor(inputFor("run_a")), otherAgent);
});

test("requestingRunIdFor: undefined runId uses the 'untracked' sentinel consistently", () => {
	assert.equal(requestingRunIdFor(inputFor(undefined)), "untracked");
	assert.equal(requestingRunIdFor(inputFor(undefined)), poolKeyFor(inputFor(undefined)).split(":")[0]);
	assert.equal(requestingRunIdFor(inputFor("run_x")), "run_x");
});
