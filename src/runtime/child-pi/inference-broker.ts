/**
 * inference-broker.ts — v0.11.31 (S-broker PoC): loopback inference broker.
 *
 * WHY (the A7 endgame continuation): S\* (v0.11.30) made the child env EXACT
 * the intended allowlisted set, but the intended set still must include a
 * credential the child can USE to call its LLM — and any real provider key
 * in the child is a reusable secret a prompt-injected worker could exfiltrate.
 * The broker removes that requirement entirely: the child's ONLY credential
 * is a per-worker token valid exclusively at this process's loopback proxy,
 * which substitutes the real upstream key after the request leaves the
 * worker. The real key never exists in any surface the worker can reach —
 * env (S\* shadows it), auth.json (scoped agent dir has none), or process
 * memory. Same pattern Docker Sandboxes/OpenShell sell as "credential
 * substitution", self-hosted in-process (zero infrastructure).
 *
 * Model routing: the scoped agent dir's models.json overrides ONLY the
 * built-in "anthropic" provider endpoint + apiKey (pi preserves built-in
 * model metadata when a models.json provider entry supplies just baseUrl —
 * docs/models.md "Configure a compatible endpoint"), so `--model
 * anthropic/<id>` and bare `<id>` resolve exactly as before, but every
 * request goes to 127.0.0.1:<port> with `x-api-key: $PI_CREW_INFERENCE_TOKEN`
 * interpolated from the CHILD's env at request time. No model metadata is
 * mirrored, no ids are rewritten, fallback chains inside anthropic work.
 *
 * Credential sources (parent side): ANTHROPIC_API_KEY (x-api-key upstream)
 * or ANTHROPIC_AUTH_TOKEN (Authorization: Bearer upstream) — the documented
 * env-var credential path (models.md "provide an API key through the
 * provider's environment variable… useful in CI"). auth.json-only users are
 * NOT supported by this PoC (reading the parent's auth.json into the broker
 * is a separate, sensitive workstream). FAIL-CLOSED: PI_CREW_INFERENCE_BROKER=1
 * with neither env var present THROWS at the first spawn — never silently
 * falls back to passing real keys to workers.
 *
 * Enforcement: per-worker random 256-bit token; per-worker request budget
 * (PI_CREW_INFERENCE_BUDGET_TOKENS, 0 = unlimited) counted from streamed
 * Anthropic usage events; per-worker in-flight cap; revoke(workerKey) /
 * revokeAll() kill-switch (revoked token → 401 on the NEXT request; in-flight
 * requests are allowed to drain — killing sockets mid-stream corrupts
 * transcripts without adding security, the token is already dead).
 *
 * Honest boundary: the broker protects the REUSABLE CREDENTIAL channel only.
 * A worker can still read other host files (~/.ssh, ~/.aws, ~/.pi/agent/
 * auth.json via bash) and make arbitrary network egress — those need an OS
 * boundary (container/bwrap), which is a separate documented workstream.
 *
 * Version history: v0.11.30 (S\*) made env exact; THIS module removes the
 * need for any real credential to be in the env at all.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { getCrewEnv, getCrewEnvBool, getCrewEnvInt } from "../../config/env-vars.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { createSafeTempDir, getPiTempBase } from "../model/pi-args.ts";

// ── Env contract ─────────────────────────────────────────────────────────
// All child-side vars are control-namespace (PI_CREW_*) except
// PI_CODING_AGENT_DIR, which is pi's OWN native override (read by the SDK
// config loader) — it is injected at the spawn-options layer, never through
// built.env, so assertOnlyControlEnvKeys' contract is untouched.
export const INFERENCE_BROKER_ENABLE_ENV = "PI_CREW_INFERENCE_BROKER";
export const INFERENCE_TOKEN_ENV = "PI_CREW_INFERENCE_TOKEN";
export const INFERENCE_BUDGET_ENV = "PI_CREW_INFERENCE_BUDGET_TOKENS";
/** pi-native agent-dir override (SDK config.js ENV_AGENT_DIR) — set on the child. */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";
const MAX_BODY_BYTES = 64 * 1024 * 1024; // generous: image attachments
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INFLIGHT_PER_WORKER = 4;

/** Upstream headers we forward (client auth headers are NEVER forwarded). */
const FORWARD_REQUEST_HEADERS = new Set([
	"content-type",
	"accept",
	"anthropic-version",
	"anthropic-beta",
	"user-agent",
	"x-stainless-retry-count",
	"x-stainless-timeout",
	"x-request-id",
]);
/** Response headers we must NOT copy (undici already decoded the body). */
const STRIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

interface WorkerEntry {
	workerKey: string;
	token: string;
	revoked: boolean;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	inFlight: number;
	maxTokens: number;
}

export interface InferenceBrokerSnapshot {
	active: boolean;
	baseUrl: string;
	port: number;
	scopedAgentDir: string | undefined;
}

interface BrokerState {
	server: http.Server;
	port: number;
	upstream: string;
	/** x-api-key value OR Authorization bearer for the upstream. */
	upstreamAuth: { header: "x-api-key" | "authorization"; value: string };
	workers: Map<string, WorkerEntry>; // by token
	byKey: Map<string, WorkerEntry>; // by workerKey
	scopedAgentDir: string;
}

// Module-level singleton (same pattern as the env-splice canary window).
// Started lazily by ensureInferenceBroker() from prepareSpawnContext;
// stopped by stopInferenceBroker() (extension teardown / tests).
let broker: BrokerState | undefined;

function resolveUpstreamAuth(): { header: "x-api-key" | "authorization"; value: string } | undefined {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (apiKey && apiKey.length > 0) return { header: "x-api-key", value: apiKey };
	const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
	if (authToken && authToken.length > 0) return { header: "authorization", value: `Bearer ${authToken}` };
	return undefined;
}

/**
 * Idempotent lazy start (ASYNC — http listen needs an event-loop turn; call
 * sites: child-pi.ts run() BEFORE prepareSpawnContext, which stays sync).
 * Returns the live snapshot, or `{active:false}` when the feature flag is
 * off. FAIL-CLOSED: flag on + no upstream credential → THROWS (the run fails
 * loudly; workers must never silently fall back to receiving real provider
 * keys).
 */
export async function maybeStartInferenceBroker(env: NodeJS.ProcessEnv = process.env): Promise<InferenceBrokerSnapshot> {
	if (broker)
		return { active: true, baseUrl: `http://127.0.0.1:${broker.port}`, port: broker.port, scopedAgentDir: broker.scopedAgentDir };
	if (!getCrewEnvBool(INFERENCE_BROKER_ENABLE_ENV)) return { active: false, baseUrl: "", port: 0, scopedAgentDir: undefined };

	const upstreamAuth = resolveUpstreamAuth();
	if (!upstreamAuth) {
		throw new Error(
			`${INFERENCE_BROKER_ENABLE_ENV}=1 but neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set in the parent environment — the inference broker refuses to start (fail-closed: workers would otherwise receive no usable credential, or worse, fall back to real provider keys). Set the provider env key or unset ${INFERENCE_BROKER_ENABLE_ENV}.`,
		);
	}
	const upstream = getCrewEnv("PI_CREW_INFERENCE_UPSTREAM", env) || DEFAULT_UPSTREAM; // tests inject a local mock
	broker = await createBrokerServer(upstream, upstreamAuth);
	return { active: true, baseUrl: `http://127.0.0.1:${broker.port}`, port: broker.port, scopedAgentDir: broker.scopedAgentDir };
}

/**
 * SYNC guard for the spawn path: when the flag is on, the broker MUST already
 * be running (child-pi.ts run() awaits maybeStartInferenceBroker() first).
 * Direct prepareSpawnContext callers under an active flag without a started
 * broker get a loud programming error instead of a keyless worker.
 */
export function requireInferenceBrokerIfEnabled(): InferenceBrokerSnapshot {
	if (broker)
		return { active: true, baseUrl: `http://127.0.0.1:${broker.port}`, port: broker.port, scopedAgentDir: broker.scopedAgentDir };
	if (!getCrewEnvBool(INFERENCE_BROKER_ENABLE_ENV)) return { active: false, baseUrl: "", port: 0, scopedAgentDir: undefined };
	throw new Error(
		`${INFERENCE_BROKER_ENABLE_ENV}=1 but the broker is not started — run() must await maybeStartInferenceBroker() before prepareSpawnContext()`,
	);
}

/** Read-only view for spawn-option builders. Never starts anything. */
export function getInferenceBrokerSnapshot(): InferenceBrokerSnapshot {
	if (!broker) return { active: false, baseUrl: "", port: 0, scopedAgentDir: undefined };
	return { active: true, baseUrl: `http://127.0.0.1:${broker.port}`, port: broker.port, scopedAgentDir: broker.scopedAgentDir };
}

async function createBrokerServer(
	upstream: string,
	upstreamAuth: { header: "x-api-key" | "authorization"; value: string },
): Promise<BrokerState> {
	const workers = new Map<string, WorkerEntry>();
	const byKey = new Map<string, WorkerEntry>();

	const server = http.createServer((req, res) => {
		void handleRequest(req, res, { upstream, upstreamAuth, workers });
	});
	server.unref(); // never hold the parent's event loop open
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("inference broker failed to bind a loopback port");
	const port = address.port;

	const scopedAgentDir = buildScopedAgentDir(port);

	return { server, port, upstream, upstreamAuth, workers, byKey, scopedAgentDir };
}

/**
 * Scoped agent dir for workers: models.json ONLY — no auth.json, no
 * extensions, no skills, no settings. The single override reroutes the
 * built-in anthropic provider to the broker with per-worker token
 * interpolation at request time. Mode 0o600 file / 0o700 dir.
 */
function buildScopedAgentDir(port: number): string {
	const dir = createSafeTempDir(getPiTempBase(), "pi-crew-inference-");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const models = {
		$schema: "https://pi.dev/schemas/models.schema.json",
		providers: {
			anthropic: {
				baseUrl: `http://127.0.0.1:${port}`,
				apiKey: `$${INFERENCE_TOKEN_ENV}`,
			},
		},
	};
	const file = path.join(dir, "models.json");
	fs.writeFileSync(file, `${JSON.stringify(models, null, "\t")}\n`, { mode: 0o600 });
	return dir;
}

/** Extract the caller token from x-api-key or Authorization: Bearer. */
function extractToken(req: http.IncomingMessage): string | undefined {
	const apiKey = req.headers["x-api-key"];
	if (typeof apiKey === "string" && apiKey.length > 0) return apiKey;
	const auth = req.headers.authorization;
	if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
	return undefined;
}

function deny(res: http.ServerResponse, status: number, message: string): void {
	const body = JSON.stringify({ type: "error", error: { type: "pi_crew_broker_error", message } });
	res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
	res.end(body);
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	ctx: { upstream: string; upstreamAuth: { header: string; value: string }; workers: Map<string, WorkerEntry> },
): Promise<void> {
	try {
		// (1) Auth — fail-closed, generic errors (never echo tokens).
		const token = extractToken(req);
		const worker = token ? ctx.workers.get(token) : undefined;
		if (!worker || worker.revoked) {
			deny(res, 401, "invalid or revoked inference token");
			return;
		}
		// (2) Budget + concurrency (per worker).
		if (worker.maxTokens > 0 && worker.inputTokens + worker.outputTokens >= worker.maxTokens) {
			deny(res, 429, "worker inference token budget exhausted");
			return;
		}
		if (worker.inFlight >= MAX_INFLIGHT_PER_WORKER) {
			deny(res, 429, "too many concurrent inference requests for this worker");
			return;
		}
		// (3) Read the request body (bounded).
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > MAX_BODY_BYTES) {
				deny(res, 413, "request body too large");
				return;
			}
			chunks.push(chunk as Buffer);
		}
		const body = Buffer.concat(chunks);
		// (4) Forward — client auth headers DROPPED, real key substituted.
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(req.headers)) {
			if (!FORWARD_REQUEST_HEADERS.has(name.toLowerCase())) continue;
			if (typeof value === "string") headers[name.toLowerCase()] = value;
		}
		headers[ctx.upstreamAuth.header] = ctx.upstreamAuth.value;
		const upstreamRes = await fetch(`${ctx.upstream}${req.url ?? "/v1/messages"}`, {
			// eslint-disable-next-line
			method: req.method ?? "POST",
			headers,
			body: body.length > 0 ? body : undefined,
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
		});
		// (5) Relay the response — strip transport framing, stream through,
		//     count usage from Anthropic SSE events / JSON bodies on the way.
		const outHeaders: Record<string, string> = {};
		upstreamRes.headers.forEach((value, name) => {
			if (!STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) outHeaders[name.toLowerCase()] = value;
		});
		res.writeHead(upstreamRes.status, outHeaders);
		worker.requests += 1;
		const usage = new UsageCounter();
		const finish = () => {
			worker.inFlight -= 1;
			worker.inputTokens += usage.input;
			worker.outputTokens += usage.output;
		};
		res.on("close", finish);
		if (!upstreamRes.body) {
			res.end();
			return;
		}
		const nodeStream = Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream);
		nodeStream.on("error", (e) => {
			console.error("[ib-debug] nodeStream error:", e?.message);
			res.destroy();
		});
		nodeStream.pipe(usage.tee).pipe(res);
	} catch (error) {
		logInternalError("inference-broker.forward", undefined, error instanceof Error ? error.message : String(error), "warn");
		if (!res.headersSent) deny(res, 502, "inference broker upstream failure");
		else res.destroy();
	}
}

/**
 * Count Anthropic usage from a streamed response without buffering it:
 * SSE `message_start` carries usage.input_tokens; `message_delta` carries
 * usage.output_tokens (cumulative — take max). Non-stream JSON bodies carry a
 * top-level usage object (also scanned — `data:`-less lines are parsed
 * defensively). `message_start` nests usage under evt.message.usage.
 */
class UsageCounter {
	input = 0;
	output = 0;
	private leftover = "";
	// NB: named `tee` — a field named `transform` would SHADOW the Transform
	// base class method slot and silently break piping.
	readonly tee = new Transform({
		transform: (chunk: Buffer, _enc: string, cb: (e: Error | null, d?: Buffer) => void) => {
			this.scan(chunk);
			cb(null, chunk);
		},
	});

	private scan(chunk: Buffer): void {
		const text = this.leftover + chunk.toString("utf8");
		const lines = text.split("\n");
		this.leftover = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed.startsWith("{") ? trimmed : "";
			if (!payload || payload === "[DONE]") continue;
			try {
				const evt = JSON.parse(payload);
				// SSE message_start: usage nested under evt.message.usage.
				// SSE message_delta: evt.usage.output_tokens is CUMULATIVE (take max).
				// Non-stream JSON body: top-level evt.usage, both absolute.
				const usage = evt?.message?.usage ?? evt?.usage;
				if (!usage || typeof usage !== "object") continue;
				if (typeof usage.input_tokens === "number" && evt.type !== "message_delta")
					this.input = Math.max(this.input, usage.input_tokens);
				if (typeof usage.output_tokens === "number") this.output = Math.max(this.output, usage.output_tokens);
			} catch {
				// non-JSON line — ignore
			}
		}
	}
}

/**
 * Issue a per-worker token. Re-registering the same workerKey REPLACES the
 * old token (old one dies immediately) — retries of one task must never
 * accumulate live tokens.
 */
export function registerInferenceWorker(workerKey: string): string {
	if (!broker) throw new Error("inference broker not started");
	const existing = broker.byKey.get(workerKey);
	if (existing) {
		existing.revoked = true;
		broker.workers.delete(existing.token);
		broker.byKey.delete(workerKey);
	}
	const token = crypto.randomBytes(32).toString("hex");
	const maxTokens = getCrewEnvInt(INFERENCE_BUDGET_ENV) ?? 0;
	const entry: WorkerEntry = { workerKey, token, revoked: false, requests: 0, inputTokens: 0, outputTokens: 0, inFlight: 0, maxTokens };
	broker.workers.set(token, entry);
	broker.byKey.set(workerKey, entry);
	return token;
}

/** Kill-switch for one worker: its token dies on the NEXT request. */
export function revokeInferenceWorker(workerKey: string): boolean {
	if (!broker) return false;
	const entry = broker.byKey.get(workerKey);
	if (!entry) return false;
	entry.revoked = true;
	broker.workers.delete(entry.token);
	broker.byKey.delete(workerKey);
	return true;
}

export function revokeAllInferenceWorkers(): number {
	if (!broker) return 0;
	const n = broker.byKey.size;
	for (const entry of broker.byKey.values()) entry.revoked = true;
	broker.workers.clear();
	broker.byKey.clear();
	return n;
}

/** Redacted per-worker stats (never includes tokens). */
export function inferenceBrokerStats(): Array<{ workerKey: string; requests: number; inputTokens: number; outputTokens: number }> {
	if (!broker) return [];
	return [...broker.byKey.values()].map((e) => ({
		workerKey: e.workerKey,
		requests: e.requests,
		inputTokens: e.inputTokens,
		outputTokens: e.outputTokens,
	}));
}

/** Stop the broker: revoke every token, close the server, remove the scoped dir. */
export function stopInferenceBroker(): void {
	if (!broker) return;
	revokeAllInferenceWorkers();
	broker.server.close();
	try {
		fs.rmSync(broker.scopedAgentDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup (tracked temp cleaner will catch it)
	}
	broker = undefined;
}

/** @internal Reset module state — TESTS ONLY (never call in production paths). */
export function __resetInferenceBrokerForTests(): void {
	stopInferenceBroker();
}
