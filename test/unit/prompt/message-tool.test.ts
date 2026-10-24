import assert from "node:assert/strict";
import { test } from "node:test";
import {
	computeMessageRequestId,
	createMessageTool,
	type MessageToolDeps,
	MSG_SEND_TIMEOUT_MS,
	shouldRegisterMessageTool,
} from "../../../src/prompt/message-tool.ts";

type MessageClient = ReturnType<NonNullable<MessageToolDeps["makeBrokerClient"]>>;

function harness() {
	const sent: { method: string; params: Record<string, unknown> }[] = [];
	const tool = createMessageTool({
		makeBrokerClient: () => {
			const client: MessageClient = {
				request: async (method: string, params: Record<string, unknown>) => {
					sent.push({ method, params });
					return { ok: true as const, value: {} };
				},
			};
			return client;
		},
	});
	return { tool, sent };
}

/** harness + injectable clock (rate-limit / sliding-window tests). */
function harness2(now: () => number) {
	const sent: { method: string; params: Record<string, unknown> }[] = [];
	const tool = createMessageTool({
		now,
		makeBrokerClient: () => {
			const client: MessageClient = {
				request: async (method: string, params: Record<string, unknown>) => {
					sent.push({ method, params });
					return { ok: true as const, value: {} };
				},
			};
			return client;
		},
	});
	return { tool, sent };
}

test("message notify parent goes through broker msg.send", async () => {
	const { tool, sent } = harness();
	const r = await tool.execute({ to: "parent", kind: "notify", body: "milestone: parser done" });
	assert.equal(r.status, "sent");
	assert.equal(sent[0]!.method, "msg.send");
	assert.equal(sent[0]!.params.kind, "notify");
});

test("message DM targets a sibling taskId", async () => {
	const { tool, sent } = harness();
	await tool.execute({ to: "03_execute", kind: "message", subject: "api shape", body: "use parseArgs(cmd) not argv" });
	assert.equal(sent[0]!.params.to, "03_execute");
});

test("rate limit: 11th message within window warns instead of sending", async () => {
	// Injectable now() — forces all 11 calls inside the 60s sliding window.
	let clock = 1_000_000;
	const { tool, sent } = harness2(() => clock);
	for (let i = 0; i < 11; i++) {
		const r = await tool.execute({ to: "parent", kind: "notify", body: `n${i}` });
		if (i === 10) {
			assert.equal(r.status, "rate-limited", "11th message is rate-limited");
			assert.match(r.text, /rate-limited/);
		}
	}
	assert.equal(sent.length, 10, "first 10 sent");
	// A message outside the window is allowed again.
	clock = 1_000_000 + 61_000;
	const after = await tool.execute({ to: "parent", kind: "notify", body: "late" });
	assert.equal(after.status, "sent");
	assert.equal(sent.length, 11, "window expiry frees a slot");
});

test("dormant gate: shouldRegisterMessageTool honors PI_CREW_MSG_ENABLED", () => {
	assert.equal(shouldRegisterMessageTool({}), false);
	assert.equal(shouldRegisterMessageTool({ PI_CREW_MSG_ENABLED: "0" }), false);
	assert.equal(shouldRegisterMessageTool({ PI_CREW_MSG_ENABLED: "1" }), true);
});

test("dormant without env + production-like no broker env → structured notice, no hang", async () => {
	// Dormant: env off, no injected client.
	// HERMETICITY (wave 12c-F3): `createMessageTool()` with NO `env` reads the
	// REAL `process.env` (see `get()` in src/prompt/message-tool.ts), so running
	// this file from inside a pi-crew worker shell — where the harness exports
	// PI_CREW_MSG_ENABLED=1 + PI_CREW_BROKER_SOCKET/TOKEN/RUN_ID — built a REAL
	// CrewBrokerClient whose unref'd connect timer let node:test cancel the file
	// (`cancelledByParent`) instead of asserting dormancy. An empty injected env
	// pins the dormant branch on every host: injected env is read EXCLUSIVELY.
	const dormant = await createMessageTool({ env: {} }).execute({ to: "parent", kind: "notify", body: "x" });
	assert.equal(dormant.status, "unavailable");
	assert.match(dormant.text, /dormant/);
	// Env on but broker creds absent (scaffold/mock worker) → broker unavailable,
	// immediate structured notice — never a hang.
	const clientless = createMessageTool({ env: { PI_CREW_MSG_ENABLED: "1" } });
	const r = await clientless.execute({ to: "parent", kind: "notify", body: "x" });
	assert.equal(r.status, "unavailable");
	assert.match(r.text, /broker unavailable/);
});

// ----------------------------------------------------------------------------
// R6-6 (DR-03 round-6 2026-10-16): msg.send idempotency + explicit timeout
// ----------------------------------------------------------------------------

/** R6-6 harness: records params AND the per-request opts (timeoutMs). */
function r66Harness(responses: Array<{ ok: true; value: unknown } | { ok: false; fallback: true; errorCode: string }>) {
	const sent: Array<{ method: string; params: Record<string, unknown>; opts?: { timeoutMs?: number } }> = [];
	let call = 0;
	const tool = createMessageTool({
		env: {
			PI_CREW_MSG_ENABLED: "1",
			PI_CREW_BROKER_RUN_ID: "run-r66",
			PI_CREW_TASK_ID: "task-r66",
			PI_CREW_BROKER_SOCKET: "/tmp/r66.sock",
			PI_CREW_BROKER_TOKEN: "tok-r66",
		},
		makeBrokerClient: () => ({
			request: async (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
				sent.push({ method, params, opts });
				const r = responses[Math.min(call, responses.length - 1)]!;
				call += 1;
				return r;
			},
		}),
	});
	return { tool, sent };
}

test("R6-6: msg.send carries a stable requestId derived from message identity + explicit 60s timeoutMs", async () => {
	const { tool, sent } = r66Harness([{ ok: true, value: {} }]);
	const r = await tool.execute({ to: "parent", kind: "notify", body: "milestone: parser done" });
	assert.equal(r.status, "sent");
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.method, "msg.send");
	// Explicit timeout: the client's 15s default turned slow durable sends into
	// false "NOT sent" reports.
	assert.equal(sent[0]!.opts?.timeoutMs, MSG_SEND_TIMEOUT_MS);
	assert.equal(MSG_SEND_TIMEOUT_MS, 60_000);
	// Stable idempotency key: valid per the broker request-parsers charset.
	const requestId = sent[0]!.params.requestId;
	assert.equal(typeof requestId, "string");
	assert.match(requestId as string, /^[\w:.-]{1,256}$/);
});

test("R6-6: retry after a lost/slow ack reuses the SAME requestId (model-visible retry dedupes server-side)", async () => {
	// First call: broker client reports a request-timeout (the pre-fix false
	// negative). The model retries the tool -> second call succeeds. Both calls
	// must carry the SAME requestId so the broker's U5 idempotent append makes
	// the resend a no-op instead of a duplicate delivery.
	const { tool, sent } = r66Harness([
		{ ok: false, fallback: true, errorCode: "request-timeout" },
		{ ok: true, value: {} },
	]);
	const params = { to: "parent", kind: "notify", body: "risk: schema drift on /v2" } as const;
	const first = await tool.execute(params);
	assert.equal(first.status, "unavailable", "timeout surfaces as the structured unavailable notice");
	const retry = await tool.execute(params);
	assert.equal(retry.status, "sent");
	assert.equal(sent.length, 2);
	assert.equal(sent[0]!.params.requestId, sent[1]!.params.requestId, "stable requestId across retries");
	assert.equal(sent[1]!.opts?.timeoutMs, MSG_SEND_TIMEOUT_MS);
});

test("R6-6: computeMessageRequestId — distinct identities get distinct keys; equal identities are equal", () => {
	const base = { runId: "run-1", taskId: "task-1", to: "parent", kind: "notify", body: "b" };
	const a = computeMessageRequestId(base);
	assert.equal(a, computeMessageRequestId({ ...base }));
	assert.match(a, /^msgtool-[0-9a-f]{32}$/);
	assert.notEqual(a, computeMessageRequestId({ ...base, body: "different" }));
	assert.notEqual(a, computeMessageRequestId({ ...base, to: "group" }));
	assert.notEqual(a, computeMessageRequestId({ ...base, kind: "message" }));
	assert.notEqual(a, computeMessageRequestId({ ...base, subject: "s" }));
	assert.notEqual(a, computeMessageRequestId({ ...base, priority: "urgent" }));
	assert.notEqual(a, computeMessageRequestId({ ...base, runId: "run-2" }));
	assert.notEqual(a, computeMessageRequestId({ ...base, taskId: "task-2" }));
});
