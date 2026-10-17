/**
 * live-agent-control-rejection.test.ts — R3A-M1 (2026-10-17 wave-2a): a
 * rejecting steer/prompt/abort inside applyLiveAgentControlRequest used to
 * escape into fire-and-forget call sites → unhandledRejection → host session
 * crash (runtime-proven). The applier must catch, record `request.error`
 * (field exists on the request), and consume the request — no rejection may
 * reach the process level.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { LiveAgentControlRequest } from "../../../../src/runtime/live-session/live-agent-control.ts";
import { applyLiveAgentControlRequest } from "../../../../src/runtime/live-session/live-agent-control.ts";

const baseRequest = (operation: LiveAgentControlRequest["operation"]): LiveAgentControlRequest => ({
	id: `ctrl_${operation}`,
	runId: "run_r3a",
	taskId: "task-1",
	operation,
	message: "please wrap up",
	createdAt: new Date().toISOString(),
});

test("R3A-M1: rejecting steer → request.error recorded, NO unhandledRejection", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		const request = baseRequest("steer");
		const applied = await applyLiveAgentControlRequest({
			request,
			taskId: "task-1",
			agentId: "agent-1",
			session: {
				steer: () => Promise.reject(new Error("steer channel closed")),
			},
		});
		assert.equal(applied, true, "request is consumed either way");
		assert.equal(request.error, "steer channel closed");
		assert.ok(request.processedAt, "processedAt recorded for observability");
		// Give the microtask queue a turn so a stray rejection would surface.
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(unhandled.length, 0, `no unhandledRejection may fire, got ${unhandled.length}`);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("R3A-M1: rejecting prompt (follow-up) and abort are also contained", async () => {
	for (const operation of ["follow-up", "resume", "stop"] as const) {
		const request = baseRequest(operation);
		const applied = await applyLiveAgentControlRequest({
			request,
			taskId: "task-1",
			agentId: "agent-1",
			session: {
				prompt: () => Promise.reject(new Error("prompt failed")),
				abort: () => Promise.reject(new Error("abort failed")),
			},
		});
		assert.equal(applied, true);
		assert.ok(request.error, `${operation} failure must be recorded`);
	}
});

test("R3A-M1: successful operations record no error and set processedAt", async () => {
	const request = baseRequest("steer");
	const applied = await applyLiveAgentControlRequest({
		request,
		taskId: "task-1",
		agentId: "agent-1",
		session: { steer: async (text) => assert.ok(text.length > 0) },
	});
	assert.equal(applied, true);
	assert.equal(request.error, undefined);
	assert.ok(request.processedAt);
});
