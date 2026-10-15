import assert from "node:assert/strict";
import test from "node:test";
import { applyLiveAgentControlRequest } from "../../../../src/runtime/live-session/live-agent-control.ts";
import {
	__test__BoundedSeenControlRequestIdSet,
	MAX_SEEN_CONTROL_REQUEST_IDS,
} from "../../../../src/runtime/live-session/live-session-runtime.ts";

test("live agent control dedupes realtime and durable delivery by request id", async () => {
	const seenRequestIds = new Set<string>();
	const steers: string[] = [];
	const request = {
		id: "ctrl_same",
		runId: "run",
		taskId: "task",
		agentId: "run:task",
		operation: "steer" as const,
		message: "once",
		createdAt: new Date().toISOString(),
	};
	const session = {
		steer: async (text: string) => {
			steers.push(text);
		},
	};
	assert.equal(
		await applyLiveAgentControlRequest({
			request,
			taskId: "task",
			agentId: "run:task",
			session,
			seenRequestIds,
		}),
		true,
	);
	assert.equal(
		await applyLiveAgentControlRequest({
			request,
			taskId: "task",
			agentId: "run:task",
			session,
			seenRequestIds,
		}),
		false,
	);
	assert.deepEqual(steers, ["once"]);
});

test("follow-up control routes through prompt instead of steer", async () => {
	const prompts: string[] = [];
	const steers: string[] = [];
	const request = {
		id: "ctrl_followup",
		runId: "run",
		taskId: "task",
		agentId: "run:task",
		operation: "follow-up" as const,
		message: "continue after stop",
		createdAt: new Date().toISOString(),
	};
	const session = {
		steer: async (text: string) => {
			steers.push(text);
		},
		prompt: async (text: string) => {
			prompts.push(text);
		},
	};
	assert.equal(
		await applyLiveAgentControlRequest({
			request,
			taskId: "task",
			agentId: "run:task",
			session,
		}),
		true,
	);
	assert.deepEqual(prompts, ["continue after stop"]);
	assert.deepEqual(steers, []);
});

test("DR-02 C1: seenControlRequestIds set is FIFO-capped at MAX_SEEN_CONTROL_REQUEST_IDS", () => {
	const seen = new __test__BoundedSeenControlRequestIdSet();
	const total = Math.floor(MAX_SEEN_CONTROL_REQUEST_IDS * 1.5); // 15_000 = 1.5x cap
	for (let i = 0; i < total; i++) seen.add(`ctrl-${i}`);
	assert.equal(seen.size, MAX_SEEN_CONTROL_REQUEST_IDS, "set must be capped at MAX_SEEN_CONTROL_REQUEST_IDS");
	assert.equal(seen.has("ctrl-0"), false, "oldest (first-inserted) id must be evicted");
	const firstKept = total - MAX_SEEN_CONTROL_REQUEST_IDS;
	assert.equal(seen.has(`ctrl-${firstKept - 1}`), false, "exactly the first (total-cap) ids must be evicted");
	assert.equal(seen.has(`ctrl-${firstKept}`), true, "eviction margin: first kept id survives");
	assert.equal(seen.has(`ctrl-${total - 1}`), true, "newest id survives");
	// Dedupe semantics unchanged: re-adding an already-present id is a no-op
	// and must not evict anything extra.
	assert.equal(seen.add(`ctrl-${total - 1}`).size, MAX_SEEN_CONTROL_REQUEST_IDS);
	assert.equal(seen.has(`ctrl-${firstKept}`), true, "re-add must not evict additional entries");
});

test("DR-02 C1: bounded set is a drop-in Set — dedupe behavior via applyLiveAgentControlRequest still holds", async () => {
	// End-to-end: the bounded set flows through the SAME consumer the runtime
	// uses (applyLiveAgentControlRequest seenRequestIds seam).
	const seenRequestIds: Set<string> = new __test__BoundedSeenControlRequestIdSet();
	const steers: string[] = [];
	const request = {
		id: "ctrl_c1",
		runId: "run",
		taskId: "task",
		agentId: "run:task",
		operation: "steer" as const,
		message: "once-only",
		createdAt: new Date().toISOString(),
	};
	const session = {
		steer: async (text: string) => {
			steers.push(text);
		},
	};
	assert.equal(await applyLiveAgentControlRequest({ request, taskId: "task", agentId: "run:task", session, seenRequestIds }), true);
	assert.equal(await applyLiveAgentControlRequest({ request, taskId: "task", agentId: "run:task", session, seenRequestIds }), false);
	assert.deepEqual(steers, ["once-only"]);
	assert.equal(seenRequestIds.size, 1, "dedupe id recorded exactly once");
});
