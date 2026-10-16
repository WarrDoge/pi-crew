import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	acquireEmbeddedTierSlot,
	admitEmbeddedSession,
	applyEmbeddedProviderTimeout,
	armTurnWatchdog,
	assertEmbeddedFactorySurface,
	captureEmbeddedGlobalState,
	classifyEmbeddedCatchFault,
	classifyLiveSessionFault,
	clearEmbeddedGuardForTest,
	clearEmbeddedTierCapacityForTest,
	detectEmbeddedGlobalStateDrift,
	EMBEDDED_DEFAULT_MAX_CONCURRENT,
	embeddedGuardStateForTest,
	embeddedMemoryRingForTest,
	embeddedTierCapacityState,
	enforceEmbeddedBuiltinTools,
	handleEmbeddedUncaughtException,
	LiveSessionEmbeddedEnforcementError,
	type LiveSessionFault,
	maybeEmitEmbeddedMemoryMetrics,
	registerEmbeddedSessionGuard,
	releaseEmbeddedTierSlot,
	sampleEmbeddedMemoryMetrics,
	unregisterEmbeddedSessionGuard,
	wrapProviderStreamTimeout,
} from "../../../../src/runtime/live-session/embedded-tier.ts";
import { clearLiveAgentsForTest, getLiveAgent, registerLiveAgent } from "../../../../src/runtime/live-session/live-agent-manager.ts";
import { clearLiveSessionServicesCacheForTest, runLiveSessionTask } from "../../../../src/runtime/live-session/live-session-runtime.ts";
import { flushEventLogBuffer } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

/**
 * U11 — embedded-tier mitigations (lane B): builtin-tools-only enforcement,
 * provider timeoutMs plumbing, turn-count watchdog, embedded concurrency cap,
 * process-level uncaughtException guard, bounded memory metrics,
 * factory/global-state asserts, and the fault-classification interface for the
 * hybrid layer. Real-path tests follow the U3/U4 faux E2E pattern; the
 * DEFAULT-OFF contract (default path byte-identical) is pinned by the last
 * test.
 */

const team: TeamConfig = {
	name: "u11-test",
	description: "u11 test",
	source: "builtin",
	filePath: "u11-test.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const workflow: WorkflowConfig = {
	name: "u11-test",
	description: "u11 test",
	source: "builtin",
	filePath: "u11-test.workflow.md",
	steps: [{ id: "execute", role: "executor", task: "do" }],
};

type FauxHandle = ReturnType<typeof fauxProvider>;
type FauxResponses = Parameters<FauxHandle["setResponses"]>[0];

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

interface U11Scenario {
	cwd: string;
	agentDir: string;
	faux: FauxHandle;
	events: Array<Record<string, unknown>>;
	run: (options?: { runtimeConfig?: Record<string, unknown>; embeddedMitigations?: Record<string, unknown> }) => Promise<{
		exitCode: number | null;
		error?: string;
		stderr: string;
		fault?: LiveSessionFault;
		/** R6-9: usage must also be present on FAULT returns (budget under-count fix). */
		usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; turns?: number };
	}>;
	manifest: { runId: string; stateRoot: string; eventsPath: string };
	taskId: string;
	agentId: string;
	readLoggedEvents: (expect?: { type: string; minCount?: number }, timeoutMs?: number) => Promise<Array<Record<string, unknown>>>;
}

function setupU11Scenario(responses: FauxResponses): U11Scenario {
	const cwd = createTrackedTempDir("pi-crew-u11-");
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const agentDir = path.join(cwd, "u11-agent-home");
	fs.mkdirSync(agentDir, { recursive: true });
	const faux = fauxProvider({ models: [{ id: "crew-u11-faux", name: "Crew U11 Faux" }] });
	faux.setResponses(responses);
	const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "u11" });
	const task = { ...tasks[0]!, startedAt: new Date().toISOString() };
	const events: Array<Record<string, unknown>> = [];
	const run = (options?: { runtimeConfig?: Record<string, unknown>; embeddedMitigations?: Record<string, unknown> }) =>
		runLiveSessionTask({
			manifest,
			task,
			step: { id: "execute", role: "executor", task: "u11 task" },
			agent: { name: "executor", description: "Executor", source: "builtin", filePath: "executor.md", systemPrompt: "Do it" },
			prompt: "Run the U11 task",
			workspaceId: cwd,
			parentModel: faux.models[0],
			modelProviderOverride: faux.provider,
			runtimeConfig: { yield: { enabled: false }, ...(options?.runtimeConfig ?? {}) } as never,
			embeddedMitigations: options?.embeddedMitigations as never,
			isCurrent: () => true,
			transcriptPath: path.join(cwd, "u11-transcript.jsonl"),
			onEvent: (event) => events.push(event as Record<string, unknown>),
		});
	const readLoggedEvents = async (
		expect?: { type: string; minCount?: number },
		timeoutMs = 3_000,
	): Promise<Array<Record<string, unknown>>> => {
		const parse = (): Array<Record<string, unknown>> => {
			try {
				const text = fs.readFileSync(manifest.eventsPath, "utf-8");
				return text
					.split("\n")
					.filter(Boolean)
					.flatMap((line) => {
						try {
							return [JSON.parse(line) as Record<string, unknown>];
						} catch {
							return [];
						}
					});
			} catch {
				return [];
			}
		};
		await flushEventLogBuffer();
		if (!expect) return parse();
		const want = expect.minCount ?? 1;
		const deadline = Date.now() + timeoutMs;
		let logged = parse();
		while (Date.now() < deadline && logged.filter((event) => event?.type === expect.type).length < want) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			logged = parse();
		}
		return logged;
	};
	return {
		cwd,
		agentDir,
		faux,
		events,
		run,
		manifest,
		taskId: task.id,
		agentId: `${manifest.runId}:${task.id}`,
		readLoggedEvents,
	};
}

/** Activate the hermetic real-session environment (empty agent home). */
function activateRealSessionEnv(agentDir: string): void {
	delete process.env.PI_CREW_MOCK_LIVE_SESSION;
	delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_CODING_AGENT_DIR = agentDir;
}

test.beforeEach(() => {
	clearEmbeddedTierCapacityForTest();
});

test.afterEach(() => {
	clearLiveAgentsForTest();
	clearEmbeddedGuardForTest();
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) Embedded concurrency cap — fail-fast, never queue
// ─────────────────────────────────────────────────────────────────────────────

test("U11 (d): capacity semaphore rejects fail-fast beyond the cap and defaults to 2", () => {
	assert.equal(acquireEmbeddedTierSlot("a", undefined).admitted, true);
	assert.equal(acquireEmbeddedTierSlot("b", undefined).admitted, true, "default cap must be EMBEDDED_DEFAULT_MAX_CONCURRENT");
	assert.equal(EMBEDDED_DEFAULT_MAX_CONCURRENT, 2);
	const rejected = acquireEmbeddedTierSlot("c", undefined);
	assert.equal(rejected.admitted, false, "third concurrent embedded session must be rejected, never queued");
	assert.equal(rejected.limit, 2);
	// Idempotent re-acquire of the SAME agent never double-counts.
	const again = acquireEmbeddedTierSlot("a", undefined);
	assert.equal(again.admitted, true);
	assert.deepEqual(embeddedTierCapacityState().active.sort(), ["a", "b"]);
	releaseEmbeddedTierSlot("a");
	const admitted = acquireEmbeddedTierSlot("c", undefined);
	assert.equal(admitted.admitted, true, "released slot must be reusable immediately");
	// Explicit limit 1.
	clearEmbeddedTierCapacityForTest();
	assert.equal(acquireEmbeddedTierSlot("x", 1).admitted, true);
	assert.equal(acquireEmbeddedTierSlot("y", 1).admitted, false);
	// Invalid limits fall back to the default (never unbounded by accident).
	clearEmbeddedTierCapacityForTest();
	assert.equal(acquireEmbeddedTierSlot("x", 0).admitted, true);
	assert.equal(acquireEmbeddedTierSlot("y", 0).admitted, true);
	assert.equal(acquireEmbeddedTierSlot("z", 0).admitted, false);
	clearEmbeddedTierCapacityForTest();
});

// ─────────────────────────────────────────────────────────────────────────────
// Blast-radius guard: ref-counted process-level uncaughtException handler
// ─────────────────────────────────────────────────────────────────────────────

test("U11 guard: installs a process listener only while embedded sessions are in flight and quarantines on fault", () => {
	const events: Array<Record<string, unknown>> = [];
	const emit = (type: string, data: Record<string, unknown>) => events.push({ type, ...data });
	const faults: string[] = [];
	const before = process.listenerCount("uncaughtException");
	registerLiveAgent({
		agentId: "u11-run:guard-task",
		runId: "u11-run",
		taskId: "guard-task",
		role: "executor",
		agent: "executor",
		session: { dispose: () => undefined },
		status: "running",
		workspaceId: "ws-u11",
	});
	registerEmbeddedSessionGuard(
		"u11-run:guard-task",
		{ runId: "u11-run", taskId: "guard-task", role: "executor" },
		{ emit: emit as never, onFault: (info) => faults.push(info.agentId) },
	);
	assert.equal(process.listenerCount("uncaughtException"), before + 1, "guard listener must be installed");
	assert.equal(embeddedGuardStateForTest().listenerInstalled, true);
	// Simulate the embedded-worker blast. NOTE: driven through the exported
	// handler, NOT process.emit — node:test installs its own uncaughtException
	// listener which would turn the synthetic blast into a test failure; the
	// installed-listener wiring is separately asserted above.
	handleEmbeddedUncaughtException(new Error("U11-BLAST embedded worker exploded"), "uncaughtException");
	const state = embeddedGuardStateForTest();
	assert.equal(state.listenerInstalled, false, "listener removed after the last session was quarantined");
	assert.equal(state.quarantinesTotal, 1);
	assert.deepEqual(faults, ["u11-run:guard-task"], "onFault hook must fire for the quarantined session");
	assert.equal(events.length, 1, "exactly ONE structured event per quarantine");
	assert.equal(events[0]?.type, "live-session.embedded_uncaught_fault");
	assert.deepEqual(events[0]?.agentIds, ["u11-run:guard-task"]);
	assert.equal(getLiveAgent("u11-run:guard-task"), undefined, "quarantined handle must be dropped (dispose + unregister)");
	// Host survived (we are still executing) — and re-registration re-arms the guard.
	registerEmbeddedSessionGuard("u11-run:guard-task", { runId: "u11-run", taskId: "guard-task" });
	assert.equal(process.listenerCount("uncaughtException"), before + 1);
	unregisterEmbeddedSessionGuard("u11-run:guard-task");
	assert.equal(process.listenerCount("uncaughtException"), before, "no listener leaks after unregister");
	// Handler with no active sessions is a no-op.
	handleEmbeddedUncaughtException(new Error("no embedded sessions"));
	assert.equal(embeddedGuardStateForTest().quarantinesTotal, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bounded memory metrics
// ─────────────────────────────────────────────────────────────────────────────

test("U11 memory: bounded ring + rate-limited emission", () => {
	const emitted: Array<Record<string, unknown>> = [];
	const emit = (type: string, data: Record<string, unknown>) => emitted.push({ type, ...data });
	const first = maybeEmitEmbeddedMemoryMetrics(emit as never, { force: true, now: 1_000 });
	assert.ok(first, "forced sample must emit");
	assert.equal(emitted[0]?.type, "live-session.embedded_memory");
	assert.equal(typeof first?.rssBytes, "number");
	// Within the 5s window: suppressed even when forced? (force bypasses interval —
	// verify the RATE LIMIT via a non-forced call.)
	assert.equal(maybeEmitEmbeddedMemoryMetrics(emit as never, { now: 1_500 }), undefined, "rate limit must suppress");
	assert.equal(maybeEmitEmbeddedMemoryMetrics(emit as never, { now: 5_999 }), undefined, "4999ms since last emit is still suppressed");
	assert.ok(maybeEmitEmbeddedMemoryMetrics(emit as never, { now: 6_001 }), "≥5s window re-opens emission");
	assert.equal(maybeEmitEmbeddedMemoryMetrics(emit as never, { now: 6_002 }), undefined, "suppressed again after emitting");
	// Ring bound: 100 entries max.
	for (let i = 0; i < 120; i++) sampleEmbeddedMemoryMetrics(1_000_000 + i);
	assert.equal(embeddedMemoryRingForTest().length, 100, "ring must be capped at 100 samples");
});

// ─────────────────────────────────────────────────────────────────────────────
// Fault classification interface (Phase 1 contract for the hybrid layer)
// ─────────────────────────────────────────────────────────────────────────────

test("U11 classifier: fault kinds, countAsFault gate, and clean results", () => {
	assert.equal(classifyLiveSessionFault({ exitCode: 0 }), undefined);
	assert.equal(classifyLiveSessionFault({ exitCode: 0, stderr: "model fallback notice" }), undefined);
	const attached = classifyLiveSessionFault({ exitCode: 1, fault: { kind: "turn-watchdog", countAsFault: true } });
	assert.equal(attached?.kind, "turn-watchdog", "attached fault wins");
	assert.equal(classifyLiveSessionFault({ exitCode: 1, error: "...escape hatch (mitigation)." })?.kind, "hung-tool");
	assert.equal(classifyLiveSessionFault({ exitCode: 1, stderr: "Live-session timed out after 500ms" })?.kind, "response-timeout");
	assert.equal(classifyLiveSessionFault({ exitCode: 1, error: "live-session recursion guard: ..." })?.kind, "recursion-guard");
	const capacity = classifyLiveSessionFault({ exitCode: 1, error: "embedded-capacity" });
	assert.equal(capacity?.kind, "capacity-rejected");
	assert.equal(capacity?.countAsFault, false, "capacity rejection is a routing signal, not a worker fault");
	const nonzero = classifyLiveSessionFault({ exitCode: 3, stderr: "boom" });
	assert.equal(nonzero?.kind, "nonzero-exit");
	assert.equal(nonzero?.countAsFault, true);
	const abort = classifyLiveSessionFault({ exitCode: 1, fault: { kind: "aborted", countAsFault: false } });
	assert.equal(abort?.countAsFault, false, "aborted is never counted toward the 2-fault budget");
	assert.equal(
		classifyEmbeddedCatchFault({
			error: new LiveSessionEmbeddedEnforcementError("post-enforcement-verify-failed", ["mcp__x"]),
			message: "x",
			quarantined: false,
		}).kind,
		"builtin-tools-degraded",
	);
	assert.equal(
		classifyEmbeddedCatchFault({ error: new Error("e"), message: "recursion guard tripped", quarantined: false }).kind,
		"recursion-guard",
	);
	assert.equal(
		classifyEmbeddedCatchFault({ error: new Error("e"), message: "anything", quarantined: true }).detail?.startsWith(
			"embedded-uncaught-quarantine",
		),
		true,
	);
	assert.equal(classifyEmbeddedCatchFault({ error: new Error("e"), message: "plain failure", quarantined: false }).kind, "session-error");
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) builtin-tools-only enforcement (fail-closed)
// ─────────────────────────────────────────────────────────────────────────────

const u11Agent = { name: "executor", description: "E", source: "builtin", filePath: "executor.md" } as never;

test("U11 (a): enforcement prunes MCP/extension/recursive tools and verifies, fail-closed on degradation", () => {
	let active = ["read", "bash", "mcp__fs__list", "team", "Agent", "submit_result", "irc", "write"];
	const session = {
		getActiveToolNames: () => active,
		setActiveToolsByName: (names: string[]) => {
			active = names;
		},
	};
	const ok = enforceEmbeddedBuiltinTools(session as never, u11Agent, "executor");
	assert.equal(ok.ok, true);
	if (ok.ok) assert.deepEqual(ok.active, ["read", "bash", "submit_result", "irc", "write"], "only builtin-floor names survive");
	// Missing surface = silent fail-open today → must FAIL CLOSED here.
	const degraded = enforceEmbeddedBuiltinTools({} as never, u11Agent, "executor");
	assert.equal(degraded.ok, false);
	if (!degraded.ok) assert.equal(degraded.reason, "session-tool-surface-missing");
	// Verify failure: setActiveToolsByName is a no-op (SDK drift) → fail closed.
	const drift: string[] = ["read", "mcp__leak"];
	const stubborn = {
		getActiveToolNames: () => drift,
		setActiveToolsByName: () => undefined,
	};
	const verify = enforceEmbeddedBuiltinTools(stubborn as never, u11Agent, "executor");
	assert.equal(verify.ok, false, "a surviving non-builtin name must fail the task");
	if (!verify.ok) assert.equal(verify.reason, "post-enforcement-verify-failed");
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Provider timeoutMs plumbing
// ─────────────────────────────────────────────────────────────────────────────

test("U11 (b): provider wrapper injects default timeoutMs, preserves explicit values, and restores the original", () => {
	const seen: Array<{ timeoutMs?: number; [key: string]: unknown }> = [];
	const provider: Record<string, unknown> = {
		id: "u11-probe",
		name: "U11 Probe",
		auth: { type: "apiKey" },
		getModels: () => [],
		streamSimple: (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
			seen.push(options as { timeoutMs?: number });
		},
	};
	const registered: unknown[] = [];
	const runtime = {
		registerNativeProvider: (p: unknown) => registered.push(p),
		getRegisteredNativeProvider: () => undefined,
		getProvider: () => provider,
	};
	const events: Array<Record<string, unknown>> = [];
	const application = applyEmbeddedProviderTimeout({
		session: { modelRuntime: runtime },
		modelRef: "u11-probe/model",
		timeoutMs: 12_345,
		emit: (type, data) => events.push({ type, ...data }),
	});
	assert.equal(application.degraded, undefined, "must not degrade with a full surface");
	assert.equal(registered.length, 1, "wrapped provider registered once");
	const wrapped = registered[0] as Record<string, unknown>;
	assert.equal(wrapped.id, "u11-probe", "metadata preserved");
	(wrapped.streamSimple as (m: unknown, c: unknown, o?: Record<string, unknown>) => unknown)({}, {}, undefined);
	(wrapped.streamSimple as (m: unknown, c: unknown, o?: Record<string, unknown>) => unknown)({}, {}, { timeoutMs: 99, signal: "keep" });
	(wrapped.streamSimple as (m: unknown, c: unknown, o?: Record<string, unknown>) => unknown)({}, {}, { timeoutMs: 300_000 });
	assert.deepEqual(
		seen.map((entry) => entry.timeoutMs),
		[12_345, 99, 12_345],
		"missing→bound, smaller caller value kept, larger SDK default clamped",
	);
	assert.equal(seen[1]?.signal, "keep", "other options passed through untouched");
	assert.equal(application.restore?.(), undefined, "restore succeeds");
	assert.equal(registered.length, 2);
	assert.equal(registered[1], provider, "restore re-registers the ORIGINAL provider");
});

test("U11 fix (b): concurrent embedded sessions never leak a stale clamp after FIFO restore", () => {
	// P1 regression (fix round 2026-10-11): two embedded sessions share ONE
	// ModelRuntime. Pre-fix, B captured A's wrapper as its "original" and A's
	// FIFO restore re-registered A's wrapper permanently — the embedded clamp
	// leaked onto every later session on that runtime and restore still
	// reported success.
	const seen: Array<{ timeoutMs?: number }> = [];
	const provider: Record<string, unknown> = {
		id: "u11-probe2",
		streamSimple: (_m: unknown, _c: unknown, options?: Record<string, unknown>) => {
			seen.push(options as { timeoutMs?: number });
		},
	};
	const registered: unknown[] = [];
	let current: unknown = provider;
	const runtime = {
		registerNativeProvider: (p: unknown) => {
			current = p;
			registered.push(p);
		},
		getRegisteredNativeProvider: () => current,
		getProvider: () => provider,
	};
	const emitLog: Array<Record<string, unknown>> = [];
	const emit = (type: string, data: Record<string, unknown>) => {
		emitLog.push({ type, ...data });
	};
	const sessionA = applyEmbeddedProviderTimeout({
		session: { modelRuntime: runtime },
		modelRef: "u11-probe2/model",
		timeoutMs: 30_000,
		emit: emit as never,
	});
	assert.equal(sessionA.degraded, undefined);
	assert.equal(registered.length, 1, "first apply registers one wrapper");
	const wrapperA = registered[0] as Record<string, unknown>;
	const sessionB = applyEmbeddedProviderTimeout({
		session: { modelRuntime: runtime },
		modelRef: "u11-probe2/model",
		timeoutMs: 60_000,
		emit: emit as never,
	});
	assert.equal(sessionB.degraded, undefined);
	assert.equal(registered.length, 1, "second apply at a LOOSER clamp must not re-register (min unchanged)");
	assert.equal(current, wrapperA, "the shared registration stays the min-clamped wrapper — B never captured its own original");
	// A leaves FIRST (FIFO — the exact pre-fix leak order).
	assert.equal(sessionA.restore?.(), undefined, "A restore succeeds");
	assert.equal(registered.length, 2, "clamp re-registered at the remaining session's bound");
	seen.length = 0;
	((current as Record<string, unknown>).streamSimple as (m: unknown, c: unknown, o?: Record<string, unknown>) => unknown)(
		{},
		{},
		{
			timeoutMs: 90_000,
		},
	);
	assert.equal(seen[0]?.timeoutMs, 60_000, "while B is in flight the clamp follows B's bound");
	// B leaves — the true base must come back, identity-preserved, clamp gone.
	assert.equal(sessionB.restore?.(), undefined, "B restore succeeds");
	assert.equal(current, provider, "FINAL registration is the ORIGINAL base provider (no stale wrapper)");
	seen.length = 0;
	(provider.streamSimple as (m: unknown, c: unknown, o?: Record<string, unknown>) => unknown)({}, {}, { timeoutMs: 90_000 });
	assert.equal(seen[0]?.timeoutMs, 90_000, "no clamp survives the last restore");
	// Idempotent restore: a second call is a no-op.
	assert.equal(sessionB.restore?.(), undefined);
	assert.equal(current, provider, "double-restore does not re-register anything");
});

test("U11 fix (b): a stale wrapper already registered at apply time is chased to its base, clamps never nest", () => {
	const seen: Array<{ timeoutMs?: number }> = [];
	const emitLog2: Array<Record<string, unknown>> = [];
	const provider: Record<string, unknown> = {
		id: "u11-probe3",
		streamSimple: (_m: unknown, _c: unknown, options?: Record<string, unknown>) => {
			seen.push(options as { timeoutMs?: number });
		},
	};
	// Simulate a leaked/foreign wrapper left registered on the shared runtime.
	const stale = wrapProviderStreamTimeout(provider, 10_000);
	let current: unknown = stale;
	const registered: unknown[] = [];
	const runtime = {
		registerNativeProvider: (p: unknown) => {
			current = p;
			registered.push(p);
		},
		getRegisteredNativeProvider: () => current,
		getProvider: () => provider,
	};
	const application = applyEmbeddedProviderTimeout({
		session: { modelRuntime: runtime },
		modelRef: "u11-probe3/model",
		timeoutMs: 30_000,
		emit: ((type: string, data: Record<string, unknown>) => {
			emitLog2.push({ type, ...data });
		}) as never,
	});
	assert.equal(application.degraded, undefined);
	assert.notEqual(current, stale, "apply replaced the stale wrapper instead of wrapping it");
	((current as Record<string, unknown>).streamSimple as (m: unknown, c: unknown, o?: Record<string, unknown>) => unknown)(
		{},
		{},
		{
			timeoutMs: 90_000,
		},
	);
	assert.equal(seen[0]?.timeoutMs, 30_000, "clamp is exactly the applied bound — no nested min(10s, 30s)");
	assert.equal(application.restore?.(), undefined);
	assert.equal(current, provider, "restore re-registers the BASE, not the stale wrapper");
});

test("U11 (b): provider plumbing degrades loudly on missing surfaces", () => {
	const events: Array<Record<string, unknown>> = [];
	const emit = (type: string, data: Record<string, unknown>) => events.push({ type, ...data });
	const noRuntime = applyEmbeddedProviderTimeout({ session: {}, modelRef: "p/m", emit: emit as never });
	assert.equal(noRuntime.degraded, "model-runtime-missing");
	assert.equal(events[0]?.type, "live-session.embedded_provider_timeout_degraded");
	const bare = applyEmbeddedProviderTimeout({
		session: { modelRuntime: { registerNativeProvider: () => {} } },
		modelRef: "bare-model",
		emit: emit as never,
	});
	assert.equal(bare.degraded, "provider-id-unresolvable");
	const noProvider = applyEmbeddedProviderTimeout({
		session: { modelRuntime: { registerNativeProvider: () => {}, getProvider: () => undefined } },
		modelRef: "p/m",
		emit: emit as never,
	});
	assert.equal(noProvider.degraded, "provider-unresolvable");
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Turn-count watchdog mechanism
// ─────────────────────────────────────────────────────────────────────────────

test("U11 (c): turn watchdog disposes the session and escalates after the grace window", async () => {
	let disposed = false;
	registerLiveAgent({
		agentId: "u11-run:watchdog-task",
		runId: "u11-run",
		taskId: "watchdog-task",
		role: "executor",
		agent: "executor",
		session: { dispose: () => (disposed = true) },
		status: "running",
		workspaceId: "ws-u11",
	});
	const escalated: Error[] = [];
	const handle = armTurnWatchdog({
		agentId: "u11-run:watchdog-task",
		maxTurns: 2,
		graceTurns: 1,
		watchdogGraceMs: 60,
		turnCount: 3,
		escalate: (error) => escalated.push(error),
	});
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.ok(disposed, "watchdog fire must dispose the in-process session");
	assert.equal(getLiveAgent("u11-run:watchdog-task"), undefined, "handle dropped — a stuck session holds no embedded slot");
	assert.equal(escalated.length, 1);
	const error = escalated[0] as { name: string; message: string; maxTurns: number; turnCount: number };
	assert.equal(error.name, "LiveSessionTurnWatchdogError");
	assert.ok(error.message.includes("turn watchdog"));
	assert.equal(error.maxTurns, 2);
	assert.equal(error.turnCount, 3);
	handle.cancel(); // idempotent after fire
	// Cancel path: an armed-but-cancelled watchdog never fires.
	let disposedTwo = false;
	registerLiveAgent({
		agentId: "u11-run:watchdog-two",
		runId: "u11-run",
		taskId: "watchdog-two",
		role: "executor",
		agent: "executor",
		session: { dispose: () => (disposedTwo = true) },
		status: "running",
		workspaceId: "ws-u11",
	});
	const cancelled = armTurnWatchdog({
		agentId: "u11-run:watchdog-two",
		maxTurns: 1,
		graceTurns: 0,
		watchdogGraceMs: 60,
		turnCount: 2,
		escalate: () => assert.fail("cancelled watchdog must never escalate"),
	});
	cancelled.cancel();
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(disposedTwo, false);
	assert.ok(getLiveAgent("u11-run:watchdog-two"), "cooperatively-settled session keeps its handle");
});

// ─────────────────────────────────────────────────────────────────────────────
// Factory / global-state asserts
// ─────────────────────────────────────────────────────────────────────────────

test("U11 asserts: factory surface + global-state drift detection", () => {
	const full = {
		createAgentSession: () => {},
		createAgentSessionServices: () => {},
		createAgentSessionFromServices: () => {},
		getAgentDir: () => "/x",
		SessionManager: { inMemory: () => {} },
	};
	assert.deepEqual(assertEmbeddedFactorySurface(full), { ok: true, missing: [] });
	const broken = { createAgentSession: () => {}, SessionManager: {} };
	const surface = assertEmbeddedFactorySurface(broken);
	assert.equal(surface.ok, false);
	assert.ok(surface.missing.includes("createAgentSessionServices"));
	assert.ok(surface.missing.includes("SessionManager.inMemory"));

	const baseline = captureEmbeddedGlobalState(["/cwd|/agents|nomcp|noctx"]);
	assert.deepEqual(detectEmbeddedGlobalStateDrift(baseline, ["/cwd|/agents|nomcp|noctx"], 8), { violations: [], watch: [] });
	const replaced = detectEmbeddedGlobalStateDrift(baseline, ["/cwd|/agents|mcp|noctx"], 8);
	assert.equal(replaced.violations.length, 1, "embedded key disappearing is a hard violation");
	assert.ok(replaced.violations[0]?.startsWith("services-cache-key-missing"));
	const sibling = detectEmbeddedGlobalStateDrift(baseline, ["/cwd|/agents|nomcp|noctx", "/cwd|/agents|mcp|noctx"], 8);
	assert.deepEqual(sibling.violations, [], "sibling-axis additions are legitimate multi-tier behavior");
	assert.equal(sibling.watch.length, 1);
	const overCap = detectEmbeddedGlobalStateDrift(baseline, ["/a", "/b", "/c"], 2);
	assert.ok(overCap.violations.some((entry) => entry.startsWith("services-cache-bound")));
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E: embedded happy path, capacity rejection, quarantine, DEFAULT-OFF pin
// ─────────────────────────────────────────────────────────────────────────────

test("U11 E2E: embedded admission enforces the cap, emits structured events, and releases cleanly", async () => {
	const providerOptions: Array<{ timeoutMs?: number }> = [];
	const scenario = setupU11Scenario([
		(_context, options) => {
			providerOptions.push(options as { timeoutMs?: number });
			return fauxAssistantMessage([fauxText("U11-EMBEDDED-OK")]);
		},
	]);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	clearLiveSessionServicesCacheForTest();
	try {
		activateRealSessionEnv(scenario.agentDir);
		const listenersBefore = process.listenerCount("uncaughtException");
		const result = await scenario.run({ embeddedMitigations: { maxConcurrentEmbedded: 2, providerTimeoutMs: 7_777 } });
		assert.equal(result.exitCode, 0, `embedded run failed: ${result.stderr}`);
		assert.equal(result.fault, undefined, "clean run carries no fault");
		const logged = await scenario.readLoggedEvents({ type: "live-session.embedded_admitted" });
		const admitted = logged.find((event) => event?.type === "live-session.embedded_admitted") as
			| { data?: { limit?: number; active?: number; providerTimeoutMs?: number } }
			| undefined;
		assert.ok(admitted, "expected live-session.embedded_admitted event");
		assert.equal(admitted?.data?.limit, 2);
		assert.equal(admitted?.data?.providerTimeoutMs, 7_777);
		assert.ok(
			(await scenario.readLoggedEvents({ type: "live-session.embedded_memory" })).some(
				(event) => event?.type === "live-session.embedded_memory",
			),
			"bounded memory metrics must be emitted at admission/teardown",
		);
		// The builtin-only informational event is EXPECTED for a write-capable
		// role — poll for it (fire-and-forget buffer), THEN parse the full log.
		const withBuiltin = await scenario.readLoggedEvents({ type: "live-session.embedded_builtin_only" });
		assert.ok(
			withBuiltin.some((event) => event?.type === "live-session.embedded_builtin_only"),
			"write-capable role must get the builtin-only-forced notice",
		);
		const degradationTypes = [
			"live-session.embedded_enforcement_degraded",
			"live-session.embedded_provider_timeout_degraded",
			"live-session.embedded_global_state_drift",
			"live-session.embedded_factory_assert",
			"live-session.embedded_capacity_rejected",
			"live-session.embedded_uncaught_fault",
			"live-session.turn_watchdog_escape",
		];
		const allLogged = await scenario.readLoggedEvents();
		const degradations = allLogged.filter((event) => degradationTypes.includes(String(event?.type)));
		assert.deepEqual(degradations, [], "no degradation/drift events on the happy path");
		// (b): the provider saw the injected default timeoutMs.
		assert.ok(providerOptions.length > 0, "faux provider must have been called");
		assert.equal(
			providerOptions.every((options) => options?.timeoutMs === 7_777),
			true,
			`provider timeoutMs not plumbed: ${JSON.stringify(providerOptions)}`,
		);
		// Teardown: capacity released, guard unregistered, no listener leak.
		assert.deepEqual(embeddedTierCapacityState().active, []);
		assert.equal(embeddedGuardStateForTest().listenerInstalled, false);
		assert.equal(process.listenerCount("uncaughtException"), listenersBefore);
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
		removeTrackedTempDir(scenario.cwd);
	}
});

test("U11 E2E: capacity exhaustion rejects fail-fast with a routing-signal fault (never queues)", async () => {
	const scenario = setupU11Scenario([fauxAssistantMessage([fauxText("never reached")])]);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		activateRealSessionEnv(scenario.agentDir);
		// Occupy the only slot for this agent's id space (a DIFFERENT agent holds it).
		const squatter = `${scenario.manifest.runId}:other-task`;
		assert.equal(acquireEmbeddedTierSlot(squatter, 1).admitted, true);
		const result = await scenario.run({ embeddedMitigations: { maxConcurrentEmbedded: 1 } });
		assert.equal(result.exitCode, 1);
		assert.equal(result.fault?.kind, "capacity-rejected");
		assert.equal(result.fault?.countAsFault, false, "capacity rejection must not consume the 2-fault budget");
		const logged = await scenario.readLoggedEvents({ type: "live-session.embedded_capacity_rejected" });
		assert.ok(logged.some((event) => event?.type === "live-session.embedded_capacity_rejected"));
		assert.deepEqual(embeddedTierCapacityState().active, [squatter], "the running session keeps its slot; nothing queued");
		releaseEmbeddedTierSlot(squatter);
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
		removeTrackedTempDir(scenario.cwd);
	}
});

test("U11 E2E: process-level uncaughtException quarantines the embedded session and fails the task without killing the host", async () => {
	const scenario = setupU11Scenario([
		() =>
			new Promise(() => {
				/* never settles — provider hangs; response timeout deliberately long */
			}),
	]);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		activateRealSessionEnv(scenario.agentDir);
		const runPromise = scenario.run({
			runtimeConfig: { liveSession: { responseTimeoutMs: 60_000, hungToolGraceMs: 60_000 } },
			embeddedMitigations: { maxConcurrentEmbedded: 2 },
		});
		// Let the session reach streaming, then simulate the embedded-worker blast
		// (drive the exported handler — process.emit would trip node:test's own
		// uncaughtException listener; listener wiring is asserted in the unit test).
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		handleEmbeddedUncaughtException(new Error("U11-E2E-BLAST"), "uncaughtException");
		const result = await runPromise;
		assert.equal(result.exitCode, 1, "quarantined task must fail");
		assert.equal(result.fault?.kind, "session-error");
		assert.ok(result.fault?.detail?.includes("quarantined"), `fault detail was: ${result.fault?.detail}`);
		assert.ok(result.error?.includes("uncaught-exception guard"), `error was: ${result.error}`);
		const logged = await scenario.readLoggedEvents({ type: "live-session.embedded_uncaught_fault" });
		const blast = logged.find((event) => event?.type === "live-session.embedded_uncaught_fault") as
			| { data?: { agentIds?: string[]; errorMessage?: string } }
			| undefined;
		assert.ok(blast, "expected live-session.embedded_uncaught_fault event");
		assert.deepEqual(blast?.data?.agentIds, [scenario.agentId]);
		assert.ok(String(blast?.data?.errorMessage).includes("U11-E2E-BLAST"));
		assert.equal(getLiveAgent(scenario.agentId), undefined, "quarantined handle dropped");
		assert.deepEqual(embeddedTierCapacityState().active, [], "slot released despite the fault");
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
		removeTrackedTempDir(scenario.cwd);
	}
});

test("R6-9: faulted embedded run still reports usage > 0 for burned turns", async () => {
	// DR-03 round-6 R6-9: the embedded-tier usage was only reported on the
	// SUCCESS return — fault/watchdog catch paths carried none, so any faulted
	// embedded run under-counted the budget. Turn 1 burns real usage (the faux
	// provider estimates tokens per assistant message), turn 2's provider call
	// hangs, and the uncaught-exception guard quarantines the session; the FAULT
	// return must still carry the partial usage (guarded stats extraction).
	const scenario = setupU11Scenario([
		fauxAssistantMessage([fauxToolCall("read", { path: "/nonexistent-r69" })]),
		() =>
			new Promise(() => {
				/* never settles — provider hangs so the fault path fires */
			}),
	]);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		activateRealSessionEnv(scenario.agentDir);
		const runPromise = scenario.run({
			runtimeConfig: { liveSession: { responseTimeoutMs: 60_000, hungToolGraceMs: 60_000 } },
			embeddedMitigations: { maxConcurrentEmbedded: 2 },
		});
		// Let turn 1 complete (assistant message + tool round-trip) before the blast.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		handleEmbeddedUncaughtException(new Error("R6-9-BLAST"), "uncaughtException");
		const result = await runPromise;
		assert.equal(result.exitCode, 1, "quarantined task must fail");
		assert.equal(result.fault?.kind, "session-error");
		assert.ok(result.usage, "fault return must carry usage (R6-9)");
		const tokens =
			(result.usage.input ?? 0) + (result.usage.output ?? 0) + (result.usage.cacheRead ?? 0) + (result.usage.cacheWrite ?? 0);
		assert.ok(tokens > 0, `usage must be > 0 after burned turns (got ${JSON.stringify(result.usage)})`);
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
		removeTrackedTempDir(scenario.cwd);
	}
});

test("U11 DEFAULT-OFF pin: without embeddedMitigations the live path emits no embedded events and attaches no fault", async () => {
	const scenario = setupU11Scenario([fauxAssistantMessage([fauxText("U11-DEFAULT-OFF-OK")])]);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	clearLiveSessionServicesCacheForTest();
	try {
		activateRealSessionEnv(scenario.agentDir);
		const listenersBefore = process.listenerCount("uncaughtException");
		const quarantinesBefore = embeddedGuardStateForTest().quarantinesTotal;
		const result = await scenario.run(); // NO embeddedMitigations
		assert.equal(result.exitCode, 0, `default run failed: ${result.stderr}`);
		assert.equal(result.fault, undefined);
		const logged = await scenario.readLoggedEvents({ type: "live-session.session_created" });
		const embeddedEvents = logged.filter((event) => String(event?.type).startsWith("live-session.embedded_"));
		assert.deepEqual(embeddedEvents, [], "default path must emit ZERO embedded-tier events");
		assert.ok(
			logged.some((event) => event?.type === "live-session.session_created"),
			"normal live-session events still flow",
		);
		assert.deepEqual(embeddedTierCapacityState().active, []);
		assert.equal(embeddedGuardStateForTest().listenerInstalled, false);
		assert.equal(process.listenerCount("uncaughtException"), listenersBefore, "no process listener delta on the default path");
		assert.equal(embeddedGuardStateForTest().quarantinesTotal, quarantinesBefore, "no quarantine on the default path");
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
		removeTrackedTempDir(scenario.cwd);
	}
});

test("U11 E2E: turn-spinning session settles after the cooperative abort and the watchdog timer is cancelled (no late drop)", async () => {
	// Probe-verified ordering (temp/u11-probe-order.mjs): abort issued at a
	// turn_end stops the loop before the next provider call, so the prompt
	// settles — the watchdog must then be CANCELLED (a late fire would drop a
	// completed handle). The dispose path itself is unit-tested above.
	const spin: FauxResponses = [
		fauxAssistantMessage([fauxToolCall("read", { path: "/nonexistent-u11-a" })]),
		fauxAssistantMessage([fauxToolCall("read", { path: "/nonexistent-u11-b" })]),
	];
	const scenario = setupU11Scenario([...spin, fauxAssistantMessage([fauxText("never needed")])]);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		activateRealSessionEnv(scenario.agentDir);
		const result = await scenario.run({
			runtimeConfig: { maxTurns: 1, graceTurns: 0 },
			embeddedMitigations: { maxConcurrentEmbedded: 2, watchdogGraceMs: 150 },
		});
		assert.notEqual(result.exitCode, null);
		assert.ok(result.exitCode === 0 || result.fault?.kind === "turn-watchdog", `spin run must terminate: ${result.error ?? "ok"}`);
		// The session never hangs forever; the watchdog leaves no late drop.
		await new Promise((resolve) => setTimeout(resolve, 400));
		const escapeLogged = (await scenario.readLoggedEvents()).some((event) => event?.type === "live-session.turn_watchdog_escape");
		if (result.exitCode === 0) {
			assert.equal(escapeLogged, false, "cooperative settle must NOT fire the watchdog escape");
			assert.ok(getLiveAgent(scenario.agentId), "completed handle must survive the cancelled watchdog timer");
		} else {
			assert.ok(escapeLogged, "watchdog escape event must accompany the turn-watchdog fault");
			assert.equal(getLiveAgent(scenario.agentId), undefined);
		}
		assert.deepEqual(embeddedTierCapacityState().active, []);
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
		removeTrackedTempDir(scenario.cwd);
	}
});

test("U11 admission: factory-surface drift fails closed", () => {
	const events: Array<Record<string, unknown>> = [];
	const emit = (type: string, data: Record<string, unknown>, message?: string) => events.push({ type, data, message });
	const admission = admitEmbeddedSession({
		mod: { createAgentSession: () => {} }, // missing createAgentSessionServices/FromServices/getAgentDir/SessionManager
		agentId: "u11-run:factory-task",
		runId: "u11-run",
		taskId: "factory-task",
		mitigations: { maxConcurrentEmbedded: 1 },
		emit,
		servicesCacheKeys: [],
	});
	assert.equal(admission.status, "rejected");
	if (admission.status === "rejected") {
		assert.equal(admission.event.type, "live-session.embedded_factory_assert");
		assert.equal(admission.result.fault.kind, "factory-assert");
		assert.equal(admission.result.fault.countAsFault, true);
		assert.ok(admission.result.error.includes("embedded-factory-assert"));
	}
});
