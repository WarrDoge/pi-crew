/**
 * W10-3 (2026-10-22, lesson #22) — strict replyTo routing enforced at the
 * ask-resolution point (prompt-runtime findAskResponse).
 *
 * The parked `ask` tool polls for a `kind:"response"` row with its exact
 * questionId. W10-3 adds the A→B→C gate: when that row carries a `replyTo`,
 * the original it points at must have been opened by the SAME requester the
 * response is addressed to. Pinned end-to-end through createAskTool with a
 * REAL temp run mailbox (the same seam ask-tool-lifecycle.test.ts uses):
 *
 *  (a) A→B→C mismatch — a response whose replyTo points at B's request but is
 *      addressed to C (the parked task) does NOT resolve the park: the tool
 *      times out and the foreign answer never surfaces.
 *  (b) right pair — replyTo → an original opened by the parked requester
 *      resolves normally (answered, fenced answer).
 *  (c) legacy rows (no reason, no replyTo) keep resolving — no crash, no
 *      behavior change for pre-W10-3 streams.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionToolContext } from "../../../src/extension/pi-api.ts";
import { type AskBrokerClientSurface, type AskToolDefinition, createAskTool } from "../../../src/prompt/prompt-runtime.ts";
import { appendMailboxMessageAsync } from "../../../src/state/coordination/mailbox.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";

interface TempAskState {
	stateRoot: string;
	runId: string;
	taskId: string;
	manifest: TeamRunManifest;
	env: NodeJS.ProcessEnv;
	cleanup(): void;
}

function makeTempAskState(): TempAskState {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ask-replyto-"));
	const stateRoot = path.join(root, ".crew", "state", "runs", "run-1");
	fs.mkdirSync(stateRoot, { recursive: true });
	const runId = "run-1";
	const taskId = "task-C";
	return {
		stateRoot,
		runId,
		taskId,
		manifest: { runId, stateRoot } as unknown as TeamRunManifest,
		env: {
			PI_CREW_ASK_ENABLED: "1",
			PI_CREW_TASK_ID: taskId,
			PI_CREW_BROKER_RUN_ID: runId,
			PI_CREW_STATE_ROOT: stateRoot,
			PI_CREW_BROKER_SOCKET: "/nonexistent/broker.sock",
			PI_CREW_BROKER_TOKEN: "test-token",
		},
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

function makeMockBrokerClient(deadlineMs: number): { surface: AskBrokerClientSurface; calls: Array<{ method: string; params: unknown }> } {
	const calls: Array<{ method: string; params: unknown }> = [];
	const surface: AskBrokerClientSurface = {
		async request(method: string, params: unknown) {
			calls.push({ method, params });
			if (method === "wait.request") {
				return {
					ok: true,
					value: {
						ok: true,
						questionId: "33333333-3333-4333-8333-333333333333",
						askedAt: new Date().toISOString(),
						deadline: Date.now() + deadlineMs,
						timeoutSec: Math.ceil(deadlineMs / 1000),
						clamped: false,
					},
				};
			}
			if (method === "wait.resolve") return { ok: true, value: {} };
			return { ok: false, fallback: true, errorCode: "not-implemented" };
		},
		async close() {
			/* no socket in tests */
		},
	};
	return { surface, calls };
}

async function runAsk(tool: AskToolDefinition, params: { question: string; timeoutSec?: number }) {
	return tool.execute("tc-1", params, undefined, undefined, undefined as unknown as ExtensionToolContext);
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	assert.equal(first?.type, "text");
	return (first as { text: string }).text;
}

describe("ask tool strict replyTo routing (W10-3)", () => {
	it("(a) A→B→C mismatch: reply to B's request does NOT resolve C's park", async () => {
		const state = makeTempAskState();
		try {
			const { surface, calls } = makeMockBrokerClient(700);
			// B (a different lane) opened a request to the leader.
			const bRequest = await appendMailboxMessageAsync(state.manifest, {
				direction: "outbox",
				from: "task-B",
				to: "leader",
				body: "B's question",
				kind: "message",
			});
			// The parked task is C — a response tagged with C's questionId but
			// replying to B's request must not resolve C's park.
			await appendMailboxMessageAsync(state.manifest, {
				direction: "inbox",
				from: "leader",
				to: state.taskId,
				taskId: state.taskId,
				body: "answer that belongs to B",
				kind: "response",
				questionId: "33333333-3333-4333-8333-333333333333",
				replyTo: bRequest.id,
			});
			const tool = createAskTool({ env: state.env, makeBrokerClient: () => surface });
			const result = await runAsk(tool, { question: "C's question", timeoutSec: 1 });
			// Park NOT resolved by the mismatched response → deadline rules.
			assert.equal(result.details.status, "timed-out");
			const text = resultText(result);
			assert.ok(!text.includes("answer that belongs to B"), "the foreign answer must never surface");
			// The terminal resolve reports timed-out (not answered).
			const resolves = calls.filter((c) => c.method === "wait.resolve");
			assert.equal(resolves.length, 1);
			const resolveParams = resolves[0]?.params as { outcome?: string } | undefined;
			assert.equal(resolveParams?.outcome, "timed-out");
		} finally {
			state.cleanup();
		}
	});

	it("(b) right pair: replyTo → original opened by the parked requester resolves normally", async () => {
		const state = makeTempAskState();
		try {
			const { surface, calls } = makeMockBrokerClient(10_000);
			// The parked task's OWN earlier request (from task-C).
			const ownRequest = await appendMailboxMessageAsync(state.manifest, {
				direction: "outbox",
				from: state.taskId,
				to: "leader",
				body: "C's earlier message",
				kind: "message",
			});
			await appendMailboxMessageAsync(state.manifest, {
				direction: "inbox",
				from: "leader",
				to: state.taskId,
				taskId: state.taskId,
				body: "legit answer for C",
				kind: "response",
				questionId: "33333333-3333-4333-8333-333333333333",
				replyTo: ownRequest.id,
				reason: "need_decision",
			});
			const tool = createAskTool({ env: state.env, makeBrokerClient: () => surface });
			const result = await runAsk(tool, { question: "C's question" });
			assert.equal(result.details.status, "answered");
			assert.ok(resultText(result).includes("legit answer for C"));
			const resolves = calls.filter((c) => c.method === "wait.resolve");
			assert.equal(resolves.length, 1);
			const resolveParams = resolves[0]?.params as { outcome?: string } | undefined;
			assert.equal(resolveParams?.outcome, "answered");
		} finally {
			state.cleanup();
		}
	});

	it("(c) legacy response rows (no reason, no replyTo) keep resolving — no crash", async () => {
		const state = makeTempAskState();
		try {
			const { surface } = makeMockBrokerClient(10_000);
			// Pre-W10-3 row shape: no reason field, no replyTo.
			const legacy = {
				id: "msg_legacy_answer",
				runId: state.runId,
				direction: "inbox",
				from: "leader",
				to: state.taskId,
				body: "legacy answer",
				createdAt: new Date().toISOString(),
				status: "queued",
				kind: "response",
				questionId: "33333333-3333-4333-8333-333333333333",
			};
			fs.mkdirSync(path.join(state.stateRoot, "mailbox"), { recursive: true });
			fs.writeFileSync(path.join(state.stateRoot, "mailbox", "inbox.jsonl"), `${JSON.stringify(legacy)}\n`, "utf-8");
			const tool = createAskTool({ env: state.env, makeBrokerClient: () => surface });
			const result = await runAsk(tool, { question: "legacy stream question" });
			assert.equal(result.details.status, "answered");
			assert.ok(resultText(result).includes("legacy answer"));
		} finally {
			state.cleanup();
		}
	});
});
