/**
 * U11 — embedded-tier mitigations for the live-session (in-process) worker path.
 *
 * DEFAULT-OFF CONTRACT: nothing in this module runs unless the hybrid
 * orchestration layer passes `LiveSessionSpawnInput.embeddedMitigations` for a
 * role that opted into the embedded tier. With default config the
 * live-session path must behave byte-identically to the pre-U11 path (pinned
 * by `embedded-tier.test.ts` "default-off" regression).
 *
 * Spec anchors (pi-crew-upgrade-spec-2026-10-09.md U11 + U4 lessons):
 *  (a) builtin-tools-only — no MCP/extension tools on the embedded path
 *      (fail-closed with a structured event on degradation);
 *  (b) provider `timeoutMs` — a hung provider HTTP call cannot hold a slot
 *      forever;
 *  (c) turn-count watchdog → dispose() the in-process session;
 *  (d) embedded concurrency cap N (fail-fast reject, never queue — mirrors
 *      nested-slots.ts deadlock-avoidance rationale; the hybrid layer routes
 *      the rejected task to the subprocess tier immediately).
 * Named risks mitigated here:
 *  - blast radius: ref-counted process-level `uncaughtException` guard
 *    (installed ONLY while embedded sessions are in flight) that quarantines
 *    (dispose + unregister) every embedded session and keeps the host alive;
 *  - memory: bounded (ring-capped, rate-limited) memory metrics emission;
 *  - global state: factory/global-state asserts in the U4 evals-harness
 *    style (post-condition asserts + loud structured events on drift).
 *
 * OWNERSHIP (adaptive-2-2): this file + its unit tests are owned by the
 * live-session lane. The hybrid orchestration layer (task-runner dispatch,
 * config, scheduling) is a parallel lane — cross-boundary interface changes
 * must go through the leader, not through edits here.
 */

import type { AgentConfig } from "../../agents/agent-config.ts";
import { resolveToolPolicy } from "../../agents/agent-config.ts";
import { DEFAULT_LIVE_SESSION } from "../../config/defaults.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { providerOfModelRef } from "../model/model-fallback.ts";
import { dropLiveAgentReference } from "./live-agent-manager.ts";

/**
 * Structured-event sink shared by all embedded-tier helpers. The runtime
 * builds one closure per task that injects runId/taskId and appends through
 * the fire-and-forget event log.
 */
export type EmbeddedEventSink = (type: string, data: Record<string, unknown>, message?: string) => void;

/**
 * Build the per-task structured-event sink the runtime hands to every
 * embedded-tier helper (injects runId/taskId, fire-and-forget append).
 */
export function buildEmbeddedEventSink<T>(
	append: (eventsPath: string, event: T) => void,
	eventsPath: string,
	runId: string,
	taskId: string,
): EmbeddedEventSink {
	return (type, data, message) => {
		append(eventsPath, {
			type,
			runId,
			taskId,
			...(message ? { message } : {}),
			data,
		} as unknown as T);
	};
}

/** Mitigation knobs the hybrid layer passes for an embedded-tier task. */
export interface LiveSessionEmbeddedMitigations {
	/** Hard cap on concurrently-active embedded sessions. Default {@link EMBEDDED_DEFAULT_MAX_CONCURRENT}. */
	maxConcurrentEmbedded?: number;
	/** Provider HTTP request timeout injected into every stream call (ms). Default DEFAULT_LIVE_SESSION.responseTimeoutMs. */
	providerTimeoutMs?: number;
	/** Grace after the turn-watchdog abort before the session is disposed (ms). Default {@link EMBEDDED_DEFAULT_WATCHDOG_GRACE_MS}. */
	watchdogGraceMs?: number;
	/** Opaque tier label echoed in structured events (hybrid-layer diagnostics). */
	tier?: string;
}

/** Conservative default cap when the caller omits one — never unbounded by accident. */
export const EMBEDDED_DEFAULT_MAX_CONCURRENT = 2;
/** Default grace for the turn-count watchdog (matches DEFAULT_LIVE_SESSION.hungToolGraceMs). */
export const EMBEDDED_DEFAULT_WATCHDOG_GRACE_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// Fault classification (Phase 1 interface contract for the hybrid layer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * U11 fault kinds. Superset of the Phase 1 agreed contract
 * (`hung-tool | response-timeout | recursion-guard | session-error | aborted | nonzero-exit`);
 * the extra kinds exist so the hybrid layer can distinguish the embedded-tier
 * mitigation escapes (turn-watchdog, builtin-tools-degraded, factory-assert,
 * global-state-drift) from the routing signal (capacity-rejected).
 */
export type LiveSessionFaultKind =
	| "hung-tool"
	| "response-timeout"
	| "turn-watchdog"
	| "recursion-guard"
	| "builtin-tools-degraded"
	| "factory-assert"
	| "global-state-drift"
	| "session-error"
	| "aborted"
	| "nonzero-exit"
	| "capacity-rejected";

/** One classified fault. `countAsFault`=false entries are routing signals, not worker faults. */
export interface LiveSessionFault {
	kind: LiveSessionFaultKind;
	detail?: string;
	/** Present for timeout-family faults. */
	timeoutMs?: number;
	/** Hybrid-layer counting gate: false ⇒ do NOT count toward the 2-fault fallback budget. */
	countAsFault: boolean;
}

/** Structural probe shape — `LiveSessionRunResult` satisfies this. */
export interface LiveSessionFaultProbe {
	exitCode: number | null;
	error?: string;
	stderr?: string;
	/** Pre-attached fault from the live-session runtime (embedded path). */
	fault?: LiveSessionFault;
}

/**
 * Classify a live-session task result into a fault the hybrid layer can count.
 * Returns undefined for a clean result. When the runtime attached a `fault`
 * (embedded path) it is returned as-is; otherwise the kind is derived from the
 * error/stderr message shape (works for pre-U11 and non-embedded results).
 */
export function classifyLiveSessionFault(probe: LiveSessionFaultProbe): LiveSessionFault | undefined {
	if (probe.fault) return probe.fault;
	const message = probe.error ?? probe.stderr ?? "";
	if (message.includes("escape hatch")) return { kind: "hung-tool", detail: message, countAsFault: true };
	if (message.includes("turn watchdog")) return { kind: "turn-watchdog", detail: message, countAsFault: true };
	if (message.includes("recursion guard")) return { kind: "recursion-guard", detail: message, countAsFault: true };
	if (message.includes("embedded-capacity") || message.includes("Embedded tier at capacity"))
		return { kind: "capacity-rejected", detail: message, countAsFault: false };
	if (probe.exitCode === 0 && !probe.error) return undefined;
	if (message.includes("timed out")) return { kind: "response-timeout", detail: message, countAsFault: true };
	return { kind: probe.exitCode === 0 ? "session-error" : "nonzero-exit", detail: message, countAsFault: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// (d) Embedded concurrency cap — fail-fast, never queue
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbeddedCapacityDecision {
	admitted: boolean;
	/** Active session count AFTER the decision. */
	active: number;
	limit: number;
}

const embeddedActiveSessions = new Set<string>();

/** Default-limit resolution (validates caller input). */
export function resolveEmbeddedConcurrencyLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return EMBEDDED_DEFAULT_MAX_CONCURRENT;
	return Math.floor(limit);
}

/**
 * Acquire one embedded-tier slot. Fail-fast: at/over the limit the decision is
 * `admitted:false` and the caller must immediately route the task to the
 * subprocess tier — NEVER queue (an embedded worker waiting on a slot while
 * holding scheduler concurrency is the MAJ#3-shaped starvation the nested
 * budget already avoids; see scheduling/nested-slots.ts rationale).
 */
export function acquireEmbeddedTierSlot(agentId: string, limit: number | undefined): EmbeddedCapacityDecision {
	const resolvedLimit = resolveEmbeddedConcurrencyLimit(limit);
	if (embeddedActiveSessions.has(agentId)) return { admitted: true, active: embeddedActiveSessions.size, limit: resolvedLimit };
	if (embeddedActiveSessions.size >= resolvedLimit) return { admitted: false, active: embeddedActiveSessions.size, limit: resolvedLimit };
	embeddedActiveSessions.add(agentId);
	return { admitted: true, active: embeddedActiveSessions.size, limit: resolvedLimit };
}

/** Release a slot (idempotent — safe against double-release in finally paths). */
export function releaseEmbeddedTierSlot(agentId: string): void {
	embeddedActiveSessions.delete(agentId);
}

/** Observability for tests + the hybrid layer. */
export function embeddedTierCapacityState(): { active: string[]; limit: number | undefined } {
	return { active: [...embeddedActiveSessions], limit: undefined };
}

/** Test seam: reset capacity state between hermetic tests. */
export function clearEmbeddedTierCapacityForTest(): void {
	embeddedActiveSessions.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Blast-radius guard: ref-counted process-level uncaughtException handler
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbeddedSessionGuardMeta {
	runId: string;
	taskId: string;
	role?: string;
}

export interface EmbeddedGuardFaultInfo {
	agentId: string;
	error: unknown;
	origin?: string;
}

interface EmbeddedGuardEntry extends EmbeddedSessionGuardMeta {
	agentId: string;
	registeredAtMs: number;
	onFault?: (info: EmbeddedGuardFaultInfo) => void;
	emit?: EmbeddedEventSink;
}

/**
 * Bound everything the guard can do: without caps a pathological stream of
 * uncaught exceptions would spam the event log or keep a broken host alive
 * forever. After MAX_GUARD_QUARANTINES the listener stops reinstalling and the
 * process default (crash) is restored — the guard is a mitigation, not a
 * substitute for a healthy process.
 */
const MAX_GUARD_EVENTS_PER_PROCESS = 50;
const MAX_GUARD_QUARANTINES_PER_PROCESS = 20;

const embeddedGuardSessions = new Map<string, EmbeddedGuardEntry>();
let processGuardListener: ((error: unknown, origin?: string) => void) | undefined;
let guardQuarantinesTotal = 0;
let guardEventsEmitted = 0;

function installProcessGuardIfNeeded(): void {
	if (processGuardListener) return;
	if (guardQuarantinesTotal >= MAX_GUARD_QUARANTINES_PER_PROCESS) return; // circuit breaker: restore default crash behavior
	processGuardListener = (error, origin) => handleEmbeddedUncaughtException(error, origin);
	process.on("uncaughtException", processGuardListener);
}

function uninstallProcessGuard(): void {
	if (!processGuardListener) return;
	process.off("uncaughtException", processGuardListener);
	processGuardListener = undefined;
}

/**
 * Register an embedded session with the process-level guard. The listener is
 * installed while ≥1 embedded session is in flight and removed when the last
 * one leaves — with no embedded sessions the host's uncaughtException
 * behavior is untouched (DEFAULT-OFF, byte-identical).
 */
export function registerEmbeddedSessionGuard(
	agentId: string,
	meta: EmbeddedSessionGuardMeta,
	hooks: { onFault?: (info: EmbeddedGuardFaultInfo) => void; emit?: EmbeddedEventSink } = {},
): void {
	embeddedGuardSessions.set(agentId, { agentId, ...meta, registeredAtMs: Date.now(), ...hooks });
	installProcessGuardIfNeeded();
}

/** Unregister a session; removes the process listener when the last one leaves. */
export function unregisterEmbeddedSessionGuard(agentId: string): void {
	embeddedGuardSessions.delete(agentId);
	if (embeddedGuardSessions.size === 0) uninstallProcessGuard();
}

/**
 * Quarantine handler (installed as the process `uncaughtException` listener;
 * also exported so tests can drive it deterministically). One embedded-worker
 * fault must not kill the host AND every other team: dispose + unregister all
 * in-flight embedded sessions (blast origin unknown → quarantine all), emit
 * ONE bounded structured event, notify each session's fault hook, and swallow
 * the exception so the host survives. NOTE: swallowing an uncaught exception
 * leaves the process in an undefined state by Node's contract — this is the
 * deliberate U11 trade-off (bounded by MAX_GUARD_QUARANTINES), taken only
 * while embedded sessions are in flight.
 */
export function handleEmbeddedUncaughtException(error: unknown, origin?: string): void {
	const entries = [...embeddedGuardSessions.values()];
	if (entries.length === 0) return;
	guardQuarantinesTotal += entries.length;
	const emit = entries.find((entry) => entry.emit)?.emit;
	if (emit && guardEventsEmitted < MAX_GUARD_EVENTS_PER_PROCESS) {
		guardEventsEmitted += 1;
		emit(
			"live-session.embedded_uncaught_fault",
			{
				agentIds: entries.map((entry) => entry.agentId),
				runIds: [...new Set(entries.map((entry) => entry.runId))],
				errorName: error instanceof Error ? error.name : typeof error,
				errorMessage: String((error as Error | undefined)?.message ?? error).slice(0, 500),
				origin: origin ?? "uncaughtException",
				quarantined: entries.length,
				quarantinesTotal: guardQuarantinesTotal,
			},
			`Embedded-tier uncaught exception quarantined: ${entries.length} session(s) disposed, host kept alive.`,
		);
	}
	for (const entry of entries) {
		embeddedGuardSessions.delete(entry.agentId); // idempotent re-entry guard
		try {
			dropLiveAgentReference(entry.agentId);
		} catch (disposeError) {
			logInternalError("live-session.embedded-guard.dispose", disposeError, `agentId=${entry.agentId}`);
		}
		try {
			entry.onFault?.({ agentId: entry.agentId, error, origin });
		} catch (hookError) {
			logInternalError("live-session.embedded-guard.onFault", hookError, `agentId=${entry.agentId}`);
		}
	}
	logInternalError(
		"live-session.embedded-uncaught-guard",
		error instanceof Error ? error : new Error(String(error)),
		`quarantined ${entries.length} embedded session(s); host kept alive`,
	);
	if (embeddedGuardSessions.size === 0) uninstallProcessGuard();
	else if (guardQuarantinesTotal >= MAX_GUARD_QUARANTINES_PER_PROCESS) uninstallProcessGuard(); // circuit breaker
}

/** Test seam: hermetic reset (unregister every session + remove the listener). */
export function clearEmbeddedGuardForTest(): void {
	embeddedGuardSessions.clear();
	uninstallProcessGuard();
}

/** Test/observability seam. */
export function embeddedGuardStateForTest(): {
	active: string[];
	listenerInstalled: boolean;
	quarantinesTotal: number;
	eventsEmitted: number;
} {
	return {
		active: [...embeddedGuardSessions.keys()],
		listenerInstalled: processGuardListener !== undefined,
		quarantinesTotal: guardQuarantinesTotal,
		eventsEmitted: guardEventsEmitted,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounded memory metrics emission
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbeddedMemorySample {
	rssBytes: number;
	heapUsedBytes: number;
	heapTotalBytes: number;
	externalBytes: number;
	activeEmbedded: number;
	sampledAtMs: number;
}

const MAX_EMBEDDED_MEMORY_SAMPLES = 100;
const EMBEDDED_MEMORY_MIN_INTERVAL_MS = 5_000;
const memoryRing: EmbeddedMemorySample[] = [];
let lastMemoryEmitMs = 0;

/** Take one process.memoryUsage sample (bounded ring, capped at 100 entries). */
export function sampleEmbeddedMemoryMetrics(now = Date.now()): EmbeddedMemorySample {
	const usage = process.memoryUsage();
	const sample: EmbeddedMemorySample = {
		rssBytes: usage.rss,
		heapUsedBytes: usage.heapUsed,
		heapTotalBytes: usage.heapTotal,
		externalBytes: usage.external,
		activeEmbedded: embeddedGuardSessions.size,
		sampledAtMs: now,
	};
	memoryRing.push(sample);
	if (memoryRing.length > MAX_EMBEDDED_MEMORY_SAMPLES) memoryRing.splice(0, memoryRing.length - MAX_EMBEDDED_MEMORY_SAMPLES);
	return sample;
}

/**
 * Rate-limited memory-metrics emission (≥5s between events; `force` bypasses
 * the interval for admission/teardown samples). Bounded: ring cap + interval
 * cap — a long-running embedded tier cannot flood the event log.
 */
export function maybeEmitEmbeddedMemoryMetrics(
	emit: EmbeddedEventSink,
	opts: { force?: boolean; now?: number } = {},
): EmbeddedMemorySample | undefined {
	const now = opts.now ?? Date.now();
	if (!opts.force && now - lastMemoryEmitMs < EMBEDDED_MEMORY_MIN_INTERVAL_MS) return undefined;
	lastMemoryEmitMs = now;
	const sample = sampleEmbeddedMemoryMetrics(now);
	emit("live-session.embedded_memory", { ...sample });
	return sample;
}

/** Test seam: read the bounded ring. */
export function embeddedMemoryRingForTest(): readonly EmbeddedMemorySample[] {
	return memoryRing;
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) Turn-count watchdog escape error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown by the turn-count watchdog after `maxTurns + graceTurns` turns AND a
 * bounded grace with no settle following the cooperative abort — the session
 * is turn-spinning (fast model turns, never hitting the response timeout) or
 * holding the turn past abort. The runtime drops the session reference
 * (dispose + unregister) and fails the task; the hybrid layer counts this as a
 * `turn-watchdog` fault.
 */
export class LiveSessionTurnWatchdogError extends Error {
	readonly maxTurns: number;
	readonly graceTurns: number;
	readonly watchdogGraceMs: number;
	readonly turnCount: number;

	constructor(maxTurns: number, graceTurns: number, watchdogGraceMs: number, turnCount: number) {
		super(
			`Live-session turn watchdog: turn ${turnCount} exceeded the hard limit ${maxTurns}+${graceTurns} and the prompt did not settle within ${watchdogGraceMs}ms after the cooperative abort — disposing the in-process session (U11 mitigation c).`,
		);
		this.maxTurns = maxTurns;
		this.graceTurns = graceTurns;
		this.watchdogGraceMs = watchdogGraceMs;
		this.turnCount = turnCount;
		this.name = "LiveSessionTurnWatchdogError";
	}
}

export interface TurnWatchdogHandle {
	/** Cancel the pending watchdog (task settled cooperatively — no dispose). */
	cancel: () => void;
}

/**
 * U11 mitigation (c) mechanism: arm the bounded watchdog that fires when the
 * turn hard limit was hit but the prompt did not settle within
 * `watchdogGraceMs` after the cooperative abort. On fire: dispose + unregister
 * the in-process session (drop-reference — the stuck session must not hold an
 * embedded slot) and reject the task's escape signal with the watchdog error.
 * The runtime MUST `cancel()` in its finally so a cooperative settle never
 * leaves a late timer to drop a completed handle.
 */
export function armTurnWatchdog(input: {
	agentId: string;
	maxTurns: number;
	graceTurns: number;
	watchdogGraceMs: number;
	turnCount: number;
	escalate: (error: Error) => void;
}): TurnWatchdogHandle {
	const timer = setTimeout(() => {
		dropLiveAgentReference(input.agentId);
		input.escalate(new LiveSessionTurnWatchdogError(input.maxTurns, input.graceTurns, input.watchdogGraceMs, input.turnCount));
	}, input.watchdogGraceMs);
	timer.unref?.();
	return {
		cancel: () => {
			clearTimeout(timer);
		},
	};
}

/** Thrown when (a) builtin-tools-only enforcement cannot be verified — fail-closed. */
export class LiveSessionEmbeddedEnforcementError extends Error {
	readonly reason: string;
	readonly activeTools: string[];

	constructor(reason: string, activeTools: string[]) {
		super(`Embedded builtin-tools-only enforcement degraded (${reason}) — failing closed (U11 mitigation a).`);
		this.reason = reason;
		this.activeTools = activeTools;
		this.name = "LiveSessionEmbeddedEnforcementError";
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) builtin-tools-only enforcement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Embedded-tier tool floor. Mirrors `filterActiveTools`'s builtin floor in
 * live-session-runtime.ts EXCEPT that no `mcp__*` name is ever admitted —
 * the embedded tier is builtin-tools-only even for MCP-permitted (write)
 * roles. Keep the two floors in sync (the runtime one is unchanged for the
 * default path).
 */
const EMBEDDED_RECURSIVE_TOOLS = new Set(["team", "Team", "Agent", "get_subagent_result", "steer_subagent"]);
const EMBEDDED_BUILTIN_FLOOR = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "submit_result", "irc"]);

export interface EmbeddedToolSurface {
	getActiveToolNames?: () => string[];
	setActiveToolsByName?: (names: string[]) => void;
}

export type EmbeddedEnforcementResult =
	| { ok: true; active: string[] }
	| { ok: false; kind: "builtin-tools-degraded"; reason: string; active?: string[] };

/**
 * Enforce builtin-tools-only on an embedded-tier session and VERIFY it took
 * effect (fail-closed):
 *  1. session must expose the tool surface at all — a missing surface is a
 *     silent fail-open today (filterActiveTools no-ops); on the embedded path
 *     it fails the task;
 *  2. apply role/agent tool policy + recursive-tool removal + builtin floor
 *     (no MCP names, no extension drift);
 *  3. re-read the active set — `setActiveToolsByName` is best-effort in the
 *     SDK; if a non-builtin name survived, enforcement degraded → fail closed.
 */
export function enforceEmbeddedBuiltinTools(
	session: EmbeddedToolSurface | undefined,
	agent: AgentConfig,
	role: string | undefined,
): EmbeddedEnforcementResult {
	if (typeof session?.getActiveToolNames !== "function" || typeof session?.setActiveToolsByName !== "function")
		return { ok: false, kind: "builtin-tools-degraded", reason: "session-tool-surface-missing" };
	const policy = resolveToolPolicy(agent, role);
	const disallowed = policy.excludeTools?.length ? new Set(policy.excludeTools) : undefined;
	const allowed = policy.tools?.length ? new Set(policy.tools) : undefined;
	const before = session.getActiveToolNames();
	const active = before.filter(
		(name) =>
			!EMBEDDED_RECURSIVE_TOOLS.has(name) &&
			!disallowed?.has(name) &&
			(!allowed || allowed.has(name)) &&
			EMBEDDED_BUILTIN_FLOOR.has(name),
	);
	session.setActiveToolsByName(active);
	const after = session.getActiveToolNames();
	const illegal = after.filter((name) => !EMBEDDED_BUILTIN_FLOOR.has(name));
	if (illegal.length > 0) return { ok: false, kind: "builtin-tools-degraded", reason: "post-enforcement-verify-failed", active: after };
	return { ok: true, active };
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) Provider timeoutMs plumbing
// ─────────────────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Build a delegating provider whose stream calls CLAMP the request timeout to
 * the embedded-tier bound: `timeoutMs = min(options.timeoutMs ?? ∞, timeoutMs)`.
 * The SDK passes its own default (300s) on every call, so fill-only would never
 * apply the configured bound; min() keeps a SMALLER caller timeout intact and
 * caps larger ones (mitigation (b): a hung call cannot hold a slot forever).
 * Prototypal wrapper preserves auth/models/metadata; only `stream`/`streamSimple`
 * are overridden. The wrapper carries a NON-ENUMERABLE base marker (erased from
 * Object.assign copies) so the ref-counted registration below can chase any
 * wrapper found at apply time back to its true base provider instead of
 * stacking wrapper-on-wrapper.
 */
export function wrapProviderStreamTimeout(provider: Record<string, unknown>, timeoutMs: number): Record<string, unknown> {
	const wrapper: Record<string, unknown> = Object.create(Object.getPrototypeOf(provider) ?? null);
	Object.assign(wrapper, provider);
	Object.defineProperty(wrapper, EMBEDDED_PROVIDER_WRAPPER_BASE, {
		value: provider,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	for (const method of ["stream", "streamSimple"]) {
		const original = provider[method];
		if (typeof original !== "function") continue;
		wrapper[method] = (model: unknown, context: unknown, options?: Record<string, unknown>) =>
			(original as (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown).call(provider, model, context, {
				...(options ?? {}),
				timeoutMs: Math.min((options as { timeoutMs?: number } | undefined)?.timeoutMs ?? Number.POSITIVE_INFINITY, timeoutMs),
			});
	}
	return wrapper;
}

/** Non-enumerable marker a wrapper carries pointing at the provider it wraps. */
const EMBEDDED_PROVIDER_WRAPPER_BASE = Symbol("pi-crew.embeddedProviderWrapperBase");

/** Read a wrapper's base marker (undefined on a base provider). */
function embeddedWrapperBase(provider: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!provider) return undefined;
	return asRecord((provider as unknown as Record<PropertyKey, unknown>)[EMBEDDED_PROVIDER_WRAPPER_BASE]);
}

/** Ref-counted registration state per (modelRuntime, providerId) — see below. */
interface EmbeddedProviderTimeoutEntry {
	/** The UNWRAPPED base provider the registered wrapper delegates to. */
	base: Record<string, unknown>;
	/** Clamps of every in-flight apply (multiset — duplicates count). */
	activeTimeoutMs: number[];
	/** Clamp of the CURRENTLY registered wrapper; undefined once the base is re-registered. */
	registeredTimeoutMs: number | undefined;
}

/**
 * Per-runtime registration ledger. KEYED BY THE RUNTIME OBJECT on purpose:
 * concurrent embedded sessions in one mode share a single services bundle →
 * a single ModelRuntime, while a different mode bundle gets its own runtime
 * object and must not share bookkeeping.
 */
const embeddedProviderTimeoutEntries = new WeakMap<object, Map<string, EmbeddedProviderTimeoutEntry>>();

export interface EmbeddedProviderTimeoutApplication {
	/** Restore the original provider registration; returns a drift label on failure. Idempotent. */
	restore?: () => string | undefined;
	degraded?: string;
}

/**
 * Apply mitigation (b) on a live session: register the resolved model's
 * provider wrapped with a default `timeoutMs` so a hung provider HTTP call
 * cannot outlive the slot. Best-effort-with-loud-degradation: a missing
 * surface emits a structured `live-session.embedded_provider_timeout_degraded`
 * event and returns (the response-timeout + hung-tool escape still bound the
 * slot).
 *
 * CONCURRENCY-SAFE REGISTRATION (fix round 2026-10-11, P1): embedded sessions
 * in the same mode share ONE ModelRuntime, and the pre-fix code captured
 * whatever was registered at apply time as the "original" — so two in-flight
 * sessions STACKED wrappers (B captured A's wrapper) and FIFO restore order
 * (A leaving first) re-registered A's wrapper PERMANENTLY: the embedded clamp
 * silently leaked onto every later session on that shared runtime, including
 * non-embedded ones, and restore still reported success. The registration is
 * now ref-counted per (runtime, providerId): every apply pushes its clamp into
 * the active multiset, the registered wrapper always delegates to the chased
 * BASE provider at the MIN of the active clamps (re-registered only when that
 * min changes), and the base is re-registered exactly when the LAST session
 * leaves — any restore order is safe. A wrapper found already registered at
 * apply time (stale restore from an earlier process phase, foreign wrapper) is
 * chased to its base via the non-enumerable marker instead of re-wrapped, so
 * clamps never nest.
 */
export function applyEmbeddedProviderTimeout(input: {
	session: { modelRuntime?: unknown } | undefined;
	modelRef: string | undefined;
	timeoutMs?: number;
	emit: EmbeddedEventSink;
}): EmbeddedProviderTimeoutApplication {
	const timeoutMs = input.timeoutMs ?? DEFAULT_LIVE_SESSION.responseTimeoutMs;
	const runtime = asRecord(input.session?.modelRuntime);
	const register = runtime?.registerNativeProvider;
	if (!runtime || typeof register !== "function") {
		input.emit(
			"live-session.embedded_provider_timeout_degraded",
			{ reason: "model-runtime-missing", timeoutMs },
			"Embedded provider timeoutMs NOT applied: session exposes no registerNativeProvider surface.",
		);
		return { degraded: "model-runtime-missing" };
	}
	const providerId = providerOfModelRef(input.modelRef);
	if (!providerId) {
		input.emit(
			"live-session.embedded_provider_timeout_degraded",
			{ reason: "provider-id-unresolvable", modelRef: input.modelRef ?? null, timeoutMs },
			"Embedded provider timeoutMs NOT applied: resolved model has no provider segment.",
		);
		return { degraded: "provider-id-unresolvable" };
	}
	const current =
		(typeof runtime.getRegisteredNativeProvider === "function"
			? asRecord(runtime.getRegisteredNativeProvider(providerId))
			: undefined) ?? (typeof runtime.getProvider === "function" ? asRecord(runtime.getProvider(providerId)) : undefined);
	if (!current || typeof current.streamSimple !== "function") {
		input.emit(
			"live-session.embedded_provider_timeout_degraded",
			{ reason: "provider-unresolvable", providerId, timeoutMs },
			`Embedded provider timeoutMs NOT applied: provider "${providerId}" not resolvable on the session runtime.`,
		);
		return { degraded: "provider-unresolvable" };
	}
	// Chase wrapper markers to the true base (bounded — defensive against a
	// pathological cycle): never wrap a wrapper, clamps must not nest.
	let base = current;
	for (let hop = 0, next = embeddedWrapperBase(base); next && hop < 8; hop++, next = embeddedWrapperBase(base)) base = next;
	const registerFn = register as (provider: unknown) => void;
	let perRuntime = embeddedProviderTimeoutEntries.get(runtime);
	if (!perRuntime) {
		perRuntime = new Map();
		embeddedProviderTimeoutEntries.set(runtime, perRuntime);
	}
	let entry = perRuntime.get(providerId);
	if (!entry) {
		entry = { base, activeTimeoutMs: [], registeredTimeoutMs: undefined };
		perRuntime.set(providerId, entry);
	}
	entry.activeTimeoutMs.push(timeoutMs);
	const effective = Math.min(...entry.activeTimeoutMs);
	if (entry.registeredTimeoutMs !== effective) {
		try {
			registerFn.call(runtime, wrapProviderStreamTimeout(entry.base, effective));
			entry.registeredTimeoutMs = effective;
		} catch (error) {
			// Roll this apply back out of the multiset (keep other sessions' state).
			const pushed = entry.activeTimeoutMs.lastIndexOf(timeoutMs);
			if (pushed !== -1) entry.activeTimeoutMs.splice(pushed, 1);
			if (entry.activeTimeoutMs.length === 0) perRuntime.delete(providerId);
			input.emit(
				"live-session.embedded_provider_timeout_degraded",
				{ reason: "register-failed", providerId, timeoutMs, error: String((error as Error)?.message ?? error).slice(0, 300) },
				`Embedded provider timeoutMs NOT applied: registerNativeProvider rejected the wrapper for "${providerId}".`,
			);
			return { degraded: "register-failed" };
		}
	}
	let restored = false;
	return {
		restore: (): string | undefined => {
			if (restored) return undefined;
			restored = true;
			const index = entry.activeTimeoutMs.indexOf(timeoutMs);
			if (index === -1) return undefined; // unknown ledger state — nothing safe to do
			entry.activeTimeoutMs.splice(index, 1);
			if (entry.activeTimeoutMs.length > 0) {
				// Sessions remain in flight: keep a wrapper registered at the new min
				// (the shared runtime must not drop the clamp while anyone needs it).
				const next = Math.min(...entry.activeTimeoutMs);
				if (entry.registeredTimeoutMs === next) return undefined;
				try {
					registerFn.call(runtime, wrapProviderStreamTimeout(entry.base, next));
					entry.registeredTimeoutMs = next;
					return undefined;
				} catch (error) {
					logInternalError("live-session.embedded-provider-timeout.restore", error, `providerId=${providerId}`);
					return "provider-restore-failed";
				}
			}
			// Last session out: restore the true base and drop the ledger entry.
			try {
				registerFn.call(runtime, entry.base);
				entry.registeredTimeoutMs = undefined;
				perRuntime.delete(providerId);
				return undefined;
			} catch (error) {
				logInternalError("live-session.embedded-provider-timeout.restore", error, `providerId=${providerId}`);
				return "provider-restore-failed";
			}
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory / global-state asserts (U4 evals-harness pattern)
// ─────────────────────────────────────────────────────────────────────────────

/** SDK factory exports the embedded tier hard-depends on (U4 fast path). */
const EMBEDDED_REQUIRED_FACTORY_EXPORTS = [
	"createAgentSession",
	"createAgentSessionServices",
	"createAgentSessionFromServices",
	"getAgentDir",
] as const;

export interface EmbeddedFactorySurface {
	ok: boolean;
	missing: string[];
}

/**
 * Assert the loaded pi SDK still exports the factories the embedded tier
 * depends on (version drift guard — the U4 lesson: rely on surface, verify
 * surface). Missing exports fail the embedded admission closed.
 */
export function assertEmbeddedFactorySurface(mod: Record<string, unknown>): EmbeddedFactorySurface {
	const missing: string[] = EMBEDDED_REQUIRED_FACTORY_EXPORTS.filter((name) => typeof mod?.[name] !== "function");
	const sessionManager = mod?.SessionManager as Record<string, unknown> | undefined;
	if (typeof sessionManager?.inMemory !== "function") missing.push("SessionManager.inMemory");
	return { ok: missing.length === 0, missing };
}

export interface EmbeddedGlobalStateBaseline {
	servicesCacheKeys: string[];
	takenAtMs: number;
}

/** Snapshot the observable global state before an embedded session runs. */
export function captureEmbeddedGlobalState(servicesCacheKeys: string[]): EmbeddedGlobalStateBaseline {
	return { servicesCacheKeys: [...servicesCacheKeys], takenAtMs: Date.now() };
}

export interface EmbeddedGlobalStateDrift {
	/** Hard violations — fail/fault-worthy global-state drift. */
	violations: string[];
	/** Soft observations (legitimate concurrent multi-tier behavior) — watch events only. */
	watch: string[];
}

/**
 * Post-condition global-state assert (U4 pattern: assert, don't hope):
 *  - the embedded session's own per-(cwd, mcp-mode, context) services-cache key
 *    must still be present (someone replacing/clearing shared factories is a
 *    host-integrity violation);
 *  - cache size must still be within its bound;
 *  - sibling-axis keys added during the session (e.g. a concurrent
 *    write-capable role legitimately building the mcp bundle in the same cwd)
 *    are reported as `watch` only — U11 runs BOTH tiers in one process by
 *    design, so cross-axis additions are not violations.
 *
 * `setDefaultStreamFn` note: the SDK exports only the SETTER (identity read is
 * not importable — pi-agent-core root exports `setDefaultStreamFn` alone), so
 * identity-asserting the global default stream fn is impossible; the admission
 * path asserts the export's presence instead (shape drift), documented as a
 * residual risk in the U11 notes.
 */
export function detectEmbeddedGlobalStateDrift(
	baseline: EmbeddedGlobalStateBaseline | undefined,
	currentKeys: string[],
	cap: number,
): EmbeddedGlobalStateDrift {
	if (!baseline) return { violations: [], watch: [] };
	const current = new Set(currentKeys);
	const violations: string[] = [];
	const watch: string[] = [];
	for (const key of baseline.servicesCacheKeys) {
		if (!current.has(key)) violations.push(`services-cache-key-missing:${key}`);
	}
	if (currentKeys.length > cap) violations.push(`services-cache-bound:${currentKeys.length}>${cap}`);
	const baselinePrefixes = new Set(
		baseline.servicesCacheKeys.map((key) => {
			const parts = key.split("|");
			return parts.length >= 2 ? `${parts[0]}|${parts[1]}` : key;
		}),
	);
	for (const key of currentKeys) {
		if (baseline.servicesCacheKeys.includes(key)) continue;
		const parts = key.split("|");
		const prefix = parts.length >= 2 ? `${parts[0]}|${parts[1]}` : key;
		if (baselinePrefixes.has(prefix)) watch.push(`services-cache-sibling-axis:${key}`);
	}
	return { violations, watch };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime orchestration helpers (keep live-session-runtime.ts inside the
// 2000-line wc-gate: the admission/teardown/classification sequences live here)
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbeddedAdmissionRejection {
	status: "rejected";
	event: { type: string; data: Record<string, unknown>; message: string };
	result: { stderr: string; error: string; fault: LiveSessionFault };
}

export interface EmbeddedAdmissionHandle {
	status: "admitted";
	/** Rejects when a mitigation escape fires (turn watchdog arms it lazily; the process guard escalates it). */
	escapeSignal: Promise<never>;
	/** Escalate an out-of-band fault (process guard, watchdog) onto the escape signal. */
	escalate: (error: Error) => void;
	/** Exactly-once teardown: unregister guard, release capacity slot, final memory sample. */
	teardown: () => void;
	/** Global-state baseline captured at admission (for the post-condition assert). */
	baseline: EmbeddedGlobalStateBaseline;
}

/**
 * U11 admission sequence (all-or-nothing, fail-closed): factory-surface assert
 * → concurrency cap (fail-fast reject, never queue) → process fault guard →
 * global-state baseline → bounded memory sample. Returns either a rejection
 * descriptor (the runtime fails the task and the hybrid layer routes it to the
 * subprocess tier) or a handle whose teardown the runtime MUST call in its
 * finally.
 */
export function admitEmbeddedSession(input: {
	mod: Record<string, unknown>;
	agentId: string;
	runId: string;
	taskId: string;
	role?: string;
	mitigations: LiveSessionEmbeddedMitigations;
	emit: EmbeddedEventSink;
	servicesCacheKeys: string[];
}): EmbeddedAdmissionRejection | EmbeddedAdmissionHandle {
	const surface = assertEmbeddedFactorySurface(input.mod);
	if (!surface.ok) {
		return {
			status: "rejected",
			event: {
				type: "live-session.embedded_factory_assert",
				data: { missing: surface.missing, role: input.role ?? null },
				message: `Embedded tier factory assert failed: pi SDK no longer exports ${surface.missing.join(", ")} — failing closed.`,
			},
			result: {
				stderr: `Embedded tier factory assert failed: missing ${surface.missing.join(", ")}.`,
				error: "embedded-factory-assert",
				fault: { kind: "factory-assert", detail: surface.missing.join(","), countAsFault: true },
			},
		};
	}
	const capacity = acquireEmbeddedTierSlot(input.agentId, input.mitigations.maxConcurrentEmbedded);
	if (!capacity.admitted) {
		return {
			status: "rejected",
			event: {
				type: "live-session.embedded_capacity_rejected",
				data: { active: capacity.active, limit: capacity.limit, tier: input.mitigations.tier ?? "embedded" },
				message: `Embedded tier at capacity (${capacity.active}/${capacity.limit}) — routing this task to the subprocess tier.`,
			},
			result: {
				stderr: `Embedded tier at capacity: ${capacity.active}/${capacity.limit} sessions active.`,
				error: "embedded-capacity",
				fault: { kind: "capacity-rejected", detail: `${capacity.active}/${capacity.limit}`, countAsFault: false },
			},
		};
	}
	let escapeReject: ((error: Error) => void) | undefined;
	const escapeSignal = new Promise<never>((_, reject) => {
		escapeReject = reject;
	});
	// Raced against the prompt; a pre-race rejection must not surface as an
	// unhandled rejection (which would trip our own process guard).
	escapeSignal.catch(() => {
		/* intentional UR-guard — see comment above */
	});
	let tornDown = false;
	registerEmbeddedSessionGuard(
		input.agentId,
		{ runId: input.runId, taskId: input.taskId, role: input.role },
		{
			emit: input.emit,
			onFault: (info) => {
				escapeReject?.(
					new Error(
						`Embedded session quarantined by process-level uncaught-exception guard: ${String((info.error as Error | undefined)?.message ?? info.error)}`,
					),
				);
			},
		},
	);
	input.emit(
		"live-session.embedded_admitted",
		{
			tier: input.mitigations.tier ?? "embedded",
			active: capacity.active,
			limit: capacity.limit,
			providerTimeoutMs: input.mitigations.providerTimeoutMs ?? null,
			watchdogGraceMs: input.mitigations.watchdogGraceMs ?? EMBEDDED_DEFAULT_WATCHDOG_GRACE_MS,
		},
		`Embedded tier admitted (${capacity.active}/${capacity.limit}).`,
	);
	maybeEmitEmbeddedMemoryMetrics(input.emit, { force: true });
	return {
		status: "admitted",
		escapeSignal,
		escalate: (error: Error) => escapeReject?.(error),
		teardown: () => {
			if (tornDown) return;
			tornDown = true;
			unregisterEmbeddedSessionGuard(input.agentId);
			releaseEmbeddedTierSlot(input.agentId);
			maybeEmitEmbeddedMemoryMetrics(input.emit, { force: true });
		},
		baseline: captureEmbeddedGlobalState(input.servicesCacheKeys),
	};
}

/**
 * U11 post-condition check at task completion: aborted classification (not a
 * worker fault) or global-state drift (hard violation — the hybrid layer
 * counts it). Soft observations become watch events.
 */
export function finalizeEmbeddedFaultCheck(input: {
	baseline: EmbeddedGlobalStateBaseline | undefined;
	signalAborted: boolean;
	servicesCacheKeys: string[];
	servicesCacheCap: number;
	emit: EmbeddedEventSink | undefined;
}): LiveSessionFault | undefined {
	if (input.signalAborted) return { kind: "aborted", detail: "signal aborted before completion", countAsFault: false };
	const drift = detectEmbeddedGlobalStateDrift(input.baseline, input.servicesCacheKeys, input.servicesCacheCap);
	if (!input.emit)
		return drift.violations.length > 0
			? { kind: "global-state-drift", detail: drift.violations.join(";"), countAsFault: true }
			: undefined;
	for (const axis of drift.watch)
		input.emit("live-session.embedded_global_state_watch", { axis }, `Embedded global-state watch: ${axis}.`);
	if (drift.violations.length === 0) return undefined;
	input.emit(
		"live-session.embedded_global_state_drift",
		{ violations: drift.violations },
		`Embedded session global-state drift: ${drift.violations.join("; ")}.`,
	);
	return { kind: "global-state-drift", detail: drift.violations.join(";"), countAsFault: true };
}

/** U11 catch-path classification for a failed embedded task (fault attached to the result). */
export function classifyEmbeddedCatchFault(input: { error: unknown; message: string; quarantined: boolean }): LiveSessionFault {
	if (input.error instanceof LiveSessionEmbeddedEnforcementError)
		return {
			kind: "builtin-tools-degraded",
			detail: `${input.error.reason} [${input.error.activeTools.join(",")}]`,
			countAsFault: true,
		};
	if (input.message.includes("recursion guard")) return { kind: "recursion-guard", detail: input.message, countAsFault: true };
	if (input.quarantined) return { kind: "session-error", detail: `embedded-uncaught-quarantine: ${input.message}`, countAsFault: true };
	return { kind: "session-error", detail: input.message, countAsFault: true };
}
