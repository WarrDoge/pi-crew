/**
 * inference-broker.test.ts — v0.11.31 (S-broker PoC) pins.
 *
 * Layers:
 *   (a) AUTH fail-closed: no token / wrong token / revoked token → 401.
 *   (b) SUBSTITUTION: the upstream receives the REAL key (x-api-key) — never
 *       the worker token; anthropic-version preserved; the real key never
 *       appears in any client-visible byte.
 *   (c) PER-WORKER: unique tokens; budget 429; revoke/revokeAll kill-switch;
 *       re-register replaces (kills) the old token.
 *   (d) SCOPED DIR: models.json reroutes anthropic to the broker with
 *       $PI_CREW_INFERENCE_TOKEN interpolation; NO auth.json; 0o600/0o700.
 *   (e) WIRING: buildFinalChildPiSpawnOptions with an active broker passes
 *       PI_CODING_AGENT_DIR + token and NEVER a provider key (even with an
 *       anthropic model chain); broker off keeps the legacy provider-key
 *       behavior (regression pin).
 *   (f) ensure() fail-closed: flag on + no upstream credential → throws.
 *   (g) LIVE e2e (linux + pi binary): a REAL `pi -p` run with the scoped
 *       agent dir + broker + mock upstream completes end-to-end — proving
 *       PI_CODING_AGENT_DIR scoping, models.json provider override, env
 *       interpolation, broker substitution, and SSE relay all work against
 *       the actual SDK.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import test from "node:test";
import { buildFinalChildPiSpawnOptions } from "../../../../src/runtime/child-pi/child-pi-spawn.ts";
import {
	__resetInferenceBrokerForTests,
	getInferenceBrokerSnapshot,
	INFERENCE_BROKER_ENABLE_ENV,
	INFERENCE_TOKEN_ENV,
	inferenceBrokerStats,
	maybeStartInferenceBroker,
	PI_AGENT_DIR_ENV,
	registerInferenceWorker,
	revokeAllInferenceWorkers,
	revokeInferenceWorker,
	stopInferenceBroker,
} from "../../../../src/runtime/child-pi/inference-broker.ts";
import { getPiSpawnCommand } from "../../../../src/runtime/pi-spawn.ts";

const REAL_KEY = "sk-ant-realkey-do-not-leak-0123456789";

interface UpstreamCapture {
	headers: Record<string, string | string[] | undefined>;
	body: string;
	url: string;
	method: string;
}

/** Minimal Anthropic-shaped SSE response the SDK accepts end-to-end. */
function anthropicSse(text: string, usage: { input: number; output: number }): string {
	return [
		'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_broker_1","type":"message","role":"assistant","model":"claude-broker","content":[],"usage":{"input_tokens":' +
			usage.input +
			',"output_tokens":1}}}',
		"",
		'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
		"",
		`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
		"",
		'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
		"",
		'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":' +
			usage.output +
			"}}",
		"",
		'event: message_stop\ndata: {"type":"message_stop"}',
		"",
	].join("\n");
}

interface MockUpstream {
	port: number;
	captures: UpstreamCapture[];
	close(): Promise<void>;
}

function startMockUpstream(opts?: { sse?: string; status?: number; contentType?: string }): Promise<MockUpstream> {
	const captures: UpstreamCapture[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			captures.push({
				headers: { ...req.headers },
				body: Buffer.concat(chunks).toString("utf8"),
				url: req.url ?? "/",
				method: req.method ?? "POST",
			});
			const status = opts?.status ?? 200;
			if (status !== 200) {
				const body = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "mock overloaded" } });
				res.writeHead(status, { "content-type": "application/json" });
				res.end(body);
				return;
			}
			// Compute the body ONCE — content-length must match what res.end()
			// actually sends (a mismatched "0" once silently emptied every
			// default-path response and cost a long debug detour).
			const body = opts?.sse ?? anthropicSse("BROKER-OK", { input: 12, output: 7 });
			res.writeHead(200, {
				"content-type": opts?.contentType ?? "text/event-stream",
				// deliberate framing headers the broker MUST strip:
				"content-encoding": "identity",
				"content-length": String(Buffer.byteLength(body)),
			});
			res.end(body);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				port,
				captures,
				close: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

async function brokerFetch(baseUrl: string, token: string | undefined, body: unknown): Promise<Response> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "text/event-stream",
		"anthropic-version": "2023-06-01",
	};
	if (token !== undefined) headers["x-api-key"] = token;
	return fetch(`${baseUrl}/v1/messages`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** Broker + mock upstream fixture (tests must call stop()). */
async function withBroker(
	run: (fn: { baseUrl: string; token: string; upstream: MockUpstream }) => Promise<void>,
	opts?: { budget?: number; sse?: string },
): Promise<void> {
	const upstream = await startMockUpstream({ sse: opts?.sse });
	const savedEnv: Record<string, string | undefined> = {};
	for (const key of [
		INFERENCE_BROKER_ENABLE_ENV,
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"PI_CREW_INFERENCE_UPSTREAM",
		"PI_CREW_INFERENCE_BUDGET_TOKENS",
	]) {
		savedEnv[key] = process.env[key];
	}
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	process.env.ANTHROPIC_API_KEY = REAL_KEY;
	process.env.PI_CREW_INFERENCE_UPSTREAM = `http://127.0.0.1:${upstream.port}`;
	if (opts?.budget !== undefined) process.env.PI_CREW_INFERENCE_BUDGET_TOKENS = String(opts.budget);
	try {
		__resetInferenceBrokerForTests();
		await maybeStartInferenceBroker();
		const snap = getInferenceBrokerSnapshot();
		assert.equal(snap.active, true, "broker snapshot must be active");
		const token = registerInferenceWorker("test-worker");
		await run({ baseUrl: snap.baseUrl, token, upstream });
	} finally {
		stopInferenceBroker();
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await upstream.close();
	}
}

// ── (a) AUTH fail-closed ────────────────────────────────────────────────

test("(a1) no token → 401, upstream untouched", async () => {
	await withBroker(async (fn) => {
		const res = await brokerFetch(fn.baseUrl, undefined, { model: "claude-broker", messages: [] });
		assert.equal(res.status, 401);
		const text = await res.text();
		assert.ok(!text.includes(REAL_KEY), "401 body must not leak the real key");
		assert.equal(fn.upstream.captures.length, 0, "unauthenticated request must never reach upstream");
	});
});

test("(a2) wrong token → 401, upstream untouched", async () => {
	await withBroker(async (fn) => {
		const res = await brokerFetch(fn.baseUrl, "deadbeef".repeat(8), { model: "claude-broker", messages: [] });
		assert.equal(res.status, 401);
		assert.equal(fn.upstream.captures.length, 0);
	});
});

test("(a3) revoked token → 401 (kill-switch)", async () => {
	await withBroker(async (fn) => {
		revokeInferenceWorker("test-worker");
		const res = await brokerFetch(fn.baseUrl, fn.token, { model: "claude-broker", messages: [] });
		assert.equal(res.status, 401);
		assert.equal(fn.upstream.captures.length, 0);
	});
});

// ── (b) SUBSTITUTION — the real key goes upstream, never to the client ──

test("(b1) upstream receives REAL x-api-key (never the worker token); anthropic-version preserved; body intact", async () => {
	await withBroker(async (fn) => {
		const payload = { model: "claude-broker", messages: [{ role: "user", content: "hi" }], stream: true };
		const res = await brokerFetch(fn.baseUrl, fn.token, payload);
		assert.equal(res.status, 200);
		await res.text(); // drain the SSE relay
		assert.equal(fn.upstream.captures.length, 1, "exactly one upstream request");
		const cap = fn.upstream.captures[0];
		assert.equal(cap.headers["x-api-key"], REAL_KEY, "upstream must see the REAL key");
		assert.notEqual(cap.headers["x-api-key"], fn.token, "upstream must NEVER see the worker token");
		assert.equal(cap.headers.authorization, undefined, "client auth must not leak as bearer");
		assert.equal(cap.headers["anthropic-version"], "2023-06-01");
		assert.deepEqual(JSON.parse(cap.body), payload, "request body must arrive byte-equivalent");
	});
});

test("(b2) SSE response relays byte-accurate; framing headers stripped; usage counted from message_start+message_delta", async () => {
	const sse = anthropicSse("BROKER-OK", { input: 33, output: 21 });
	await withBroker(
		async (fn) => {
			const res = await brokerFetch(fn.baseUrl, fn.token, { model: "claude-broker", messages: [] });
			assert.equal(res.headers.get("content-type"), "text/event-stream");
			assert.equal(res.headers.get("content-encoding"), null, "content-encoding must be stripped");
			assert.equal(res.headers.get("content-length"), null, "content-length must be stripped");
			const text = await res.text();
			assert.equal(text, sse, "SSE body must relay byte-accurate");
			await new Promise((r) => setTimeout(r, 50)); // let the res-close accounting land
			const stats = inferenceBrokerStats();
			assert.equal(stats.length, 1);
			assert.equal(stats[0].inputTokens, 33, "input usage counted from message_start");
			assert.equal(stats[0].outputTokens, 21, "output usage counted from message_delta (cumulative max)");
		},
		{ sse },
	);
});

test("(b3) bearer-token auth style: ANTHROPIC_AUTH_TOKEN upstream uses Authorization header", async () => {
	const upstream = await startMockUpstream();
	const saved: Record<string, string | undefined> = {};
	for (const key of [INFERENCE_BROKER_ENABLE_ENV, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "PI_CREW_INFERENCE_UPSTREAM"])
		saved[key] = process.env[key];
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	delete process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_AUTH_TOKEN = "oauth-bearer-real";
	process.env.PI_CREW_INFERENCE_UPSTREAM = `http://127.0.0.1:${upstream.port}`;
	try {
		__resetInferenceBrokerForTests();
		await maybeStartInferenceBroker();
		const snap = getInferenceBrokerSnapshot();
		const token = registerInferenceWorker("bearer-worker");
		const res = await brokerFetch(snap.baseUrl, token, { model: "x", messages: [] });
		assert.equal(res.status, 200);
		await res.text();
		assert.equal(upstream.captures[0].headers.authorization, "Bearer oauth-bearer-real");
		assert.equal(upstream.captures[0].headers["x-api-key"], undefined);
	} finally {
		stopInferenceBroker();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await upstream.close();
	}
});

// ── (c) PER-WORKER isolation ────────────────────────────────────────────

test("(c1) workers get unique tokens; revoking one leaves the other working", async () => {
	await withBroker(async (fn) => {
		const t2 = registerInferenceWorker("worker-2");
		assert.notEqual(t2, fn.token, "tokens must be per-worker unique");
		revokeInferenceWorker("test-worker");
		const r1 = await brokerFetch(fn.baseUrl, fn.token, { model: "x", messages: [] });
		assert.equal(r1.status, 401);
		const r2 = await brokerFetch(fn.baseUrl, t2, { model: "x", messages: [] });
		assert.equal(r2.status, 200);
		await r2.text();
	});
});

test("(c2) re-registering a workerKey kills the previous token (retry safety)", async () => {
	await withBroker(async (fn) => {
		const old = fn.token;
		const fresh = registerInferenceWorker("test-worker");
		assert.notEqual(fresh, old);
		const rOld = await brokerFetch(fn.baseUrl, old, { model: "x", messages: [] });
		assert.equal(rOld.status, 401, "old token must die on re-register");
		const rNew = await brokerFetch(fn.baseUrl, fresh, { model: "x", messages: [] });
		assert.equal(rNew.status, 200);
		await rNew.text();
	});
});

test("(c3) token budget: usage past the budget → 429 on the NEXT request", async () => {
	await withBroker(
		async (fn) => {
			const r1 = await brokerFetch(fn.baseUrl, fn.token, { model: "x", messages: [] });
			await r1.text();
			const stats = inferenceBrokerStats()[0];
			assert.ok(stats.inputTokens + stats.outputTokens > 0, "usage must have been counted");
		},
		{ budget: 1 },
	); // first response alone (33+21) blows past 1
	await withBroker(
		async (fn) => {
			const r1 = await brokerFetch(fn.baseUrl, fn.token, { model: "x", messages: [] });
			await r1.text();
			const r2 = await brokerFetch(fn.baseUrl, fn.token, { model: "x", messages: [] });
			assert.equal(r2.status, 429, "budget-exhausted worker must be refused");
			assert.ok((await r2.text()).includes("budget"), "429 must explain the budget");
		},
		{ budget: 10 },
	);
});

test("(c4) revokeAll flips every worker off", async () => {
	await withBroker(async (fn) => {
		registerInferenceWorker("worker-b");
		const n = revokeAllInferenceWorkers();
		assert.ok(n >= 2, `revokeAll must report the revoked workers (got ${n})`);
		const res = await brokerFetch(fn.baseUrl, fn.token, { model: "x", messages: [] });
		assert.equal(res.status, 401);
	});
});

// ── (d) SCOPED AGENT DIR ────────────────────────────────────────────────

test("(d1) scoped dir: models.json reroutes anthropic to the broker with $PI_CREW_INFERENCE_TOKEN; NO auth.json; private modes", async () => {
	await withBroker(async (fn) => {
		const snap = getInferenceBrokerSnapshot();
		assert.ok(snap.scopedAgentDir, "scoped agent dir must exist");
		const files = fs.readdirSync(snap.scopedAgentDir);
		assert.deepEqual(files, ["models.json"], "scoped dir must contain ONLY models.json");
		const models = JSON.parse(fs.readFileSync(path.join(snap.scopedAgentDir, "models.json"), "utf8"));
		assert.equal(models.providers.anthropic.baseUrl, snap.baseUrl);
		assert.equal(models.providers.anthropic.apiKey, `$${INFERENCE_TOKEN_ENV}`);
		// POSIX-only contract: Windows fs.statSync().mode is always 0o666
		// regardless of the requested mode (v0.11.21 CI lesson).
		if (process.platform !== "win32") {
			const mode = fs.statSync(path.join(snap.scopedAgentDir, "models.json")).mode & 0o777;
			assert.equal(mode, 0o600, "models.json must be owner-only");
		}
	});
});

// ── (e) WIRING into spawn options ───────────────────────────────────────

test("(e1) WIRING: active broker → child env gets PI_CODING_AGENT_DIR + token and NEVER a provider key", async () => {
	await withBroker(async () => {
		const opts = buildFinalChildPiSpawnOptions(
			process.cwd(),
			{ ...process.env, ANTHROPIC_API_KEY: REAL_KEY, PATH: process.env.PATH ?? "/usr/bin" } as NodeJS.ProcessEnv,
			{ [INFERENCE_TOKEN_ENV]: "worker-token-x", PI_CREW_CONTROL: "1" },
			"anthropic/claude-sonnet-5",
			["anthropic/claude-sonnet-5", "anthropic/claude-opus-4"],
		);
		const childEnv = opts.env ?? {};
		assert.equal(childEnv[PI_AGENT_DIR_ENV], getInferenceBrokerSnapshot().scopedAgentDir);
		assert.equal(childEnv[INFERENCE_TOKEN_ENV], "worker-token-x");
		assert.equal(childEnv.ANTHROPIC_API_KEY, undefined, "broker mode must NOT pass the real provider key");
	});
});

test("(e2) REGRESSION: broker off → provider keys flow per the legacy scoped allowlist; no broker env keys", () => {
	const saved = { [INFERENCE_BROKER_ENABLE_ENV]: process.env[INFERENCE_BROKER_ENABLE_ENV] };
	delete process.env[INFERENCE_BROKER_ENABLE_ENV];
	try {
		const opts = buildFinalChildPiSpawnOptions(
			process.cwd(),
			{ ANTHROPIC_API_KEY: REAL_KEY, PATH: "/usr/bin", HOME: "/home/x" } as NodeJS.ProcessEnv,
			{ PI_CREW_CONTROL: "1" },
			"anthropic/claude-sonnet-5",
		);
		const childEnv = opts.env ?? {};
		assert.equal(childEnv.ANTHROPIC_API_KEY, REAL_KEY, "legacy behavior: model-scoped provider key passes");
		assert.equal(childEnv[PI_AGENT_DIR_ENV], undefined, "no agent-dir override when broker off");
	} finally {
		if (saved[INFERENCE_BROKER_ENABLE_ENV] !== undefined) process.env[INFERENCE_BROKER_ENABLE_ENV] = saved[INFERENCE_BROKER_ENABLE_ENV];
	}
});

// ── (f) ensure() fail-closed ────────────────────────────────────────────

test("(f1) flag on + no upstream credential → throws (never silently falls back to real keys)", async () => {
	const saved: Record<string, string | undefined> = {};
	for (const key of [INFERENCE_BROKER_ENABLE_ENV, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) saved[key] = process.env[key];
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_AUTH_TOKEN;
	try {
		__resetInferenceBrokerForTests();
		await assert.rejects(
			() => maybeStartInferenceBroker(),
			/ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN/,
			"must throw naming the missing credential",
		);
	} finally {
		__resetInferenceBrokerForTests();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

// ── (g) LIVE e2e — REAL pi binary through the broker (linux) ────────────

test("(g1) LIVE: real `pi -p` completes via scoped dir + broker + mock upstream; upstream saw the real key; worker env had no real key", {
	skip: process.platform !== "linux",
}, async () => {
	const piCmd = getPiSpawnCommand([]);
	if (!piCmd.command || !fs.existsSync(piCmd.command)) {
		assert.ok(`pi binary not found (${piCmd.command})` === "skip");
		return;
	}
	await withBroker(async (fn) => {
		const snap = getInferenceBrokerSnapshot();
		const res = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
			const child = spawn(piCmd.command, [...piCmd.args, "--mode", "json", "-p", "Reply with exactly BROKER-LIVE-OK"], {
				env: {
					PATH: process.env.PATH ?? "/usr/bin",
					HOME: process.env.HOME ?? "/home",
					[PI_AGENT_DIR_ENV]: snap.scopedAgentDir ?? "",
					[INFERENCE_TOKEN_ENV]: fn.token,
					// NOTE: deliberately NO ANTHROPIC_API_KEY — the worker must
					// authenticate solely through the broker token.
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
			child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
			child.on("exit", (code) => resolve({ code, stdout, stderr }));
			setTimeout(() => child.kill("SIGKILL"), 90_000).unref?.();
		});
		// The run must complete and the model reply must have come through.
		assert.equal(res.code, 0, `pi exited code=${res.code}\nstdout=${res.stdout.slice(0, 800)}\nstderr=${res.stderr.slice(0, 800)}`);
		assert.ok(res.stdout.includes("BROKER-LIVE-OK"), "model reply must relay through the broker");
		// Upstream proof: the SDK hit the broker (not api.anthropic.com), with the real key.
		assert.ok(fn.upstream.captures.length >= 1, "mock upstream must have received the request");
		assert.equal(fn.upstream.captures[0].headers["x-api-key"], REAL_KEY);
	});
});
