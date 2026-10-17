import type { CrewRuntimeConfig } from "../../config/config.ts";
import type { CrewRuntimeKind } from "../crew-agent-runtime.ts";
import { currentCrewDepth } from "./pi-args.ts";

/**
 * U11 (hybrid 2-tier worker model): routing input for the embedded tier
 * (in-process live-session workers). Optional fifth parameter of
 * resolveTaskRuntimeKind — every pre-U11 call site omits it and gets the
 * exact pre-U11 resolution (DEFAULT-OFF no-op).
 */
export interface EmbeddedRoutingInput {
	/** Validated `runtime.embeddedWorkers` policy block (enabled flag checked here). */
	policy: CrewRuntimeConfig["embeddedWorkers"];
	/** Persisted embedded-fault count for THIS task — drives the sticky
	 *  fault-threshold downgrade to subprocess (task.diagnostics ledger). */
	faultCount?: number;
}

/** Default embedded-fault threshold before rerouting a task to subprocess (spec U11: "fault 2 lần"). */
export const DEFAULT_EMBEDDED_FAULT_THRESHOLD = 2;

/** Resolve the effective fault threshold from the policy block (>= 1; invalid → default). */
export function resolveEmbeddedFaultThreshold(policy: CrewRuntimeConfig["embeddedWorkers"]): number {
	const raw = policy?.faultThreshold;
	if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
	return DEFAULT_EMBEDDED_FAULT_THRESHOLD;
}

/**
 * Resolve the effective runtime kind for a given task role using isolation policy.
 * - scaffold is never overridden — scaffold stays scaffold.
 * - If already nested (PI_CREW_DEPTH > 0), force child-process to avoid live-session nesting issues.
 * - If the role appears in `isolationPolicy.isolatedRoles`, use child-process (crash isolation).
 * - U11 (optional `embedded` input): when the embedded tier policy is enabled
 *   AND the role explicitly opted in AND the task has not exhausted its
 *   embedded-fault budget AND we are not nested, upgrade the task to
 *   live-session (the embedded tier). The upgrade can only turn a
 *   child-process resolution INTO live-session — it can never override
 *   scaffold, never bypass isolatedRoles, and never weaken the depth guard
 *   (the same depth>0 rule is applied to the embedded upgrade itself).
 * - Otherwise, use `isolationPolicy.defaultRuntime` when configured, then fall back to globalKind.
 */
/**
 * wave-2b (mock double-gate): PI_CREW_MOCK_LIVE_SESSION is a test seam that
 * flips production runtime selection (policy + resolver) and fabricates a
 * mock session — single-gated, an env var inherited from a hostile parent
 * would silently downgrade a worker to a mock. Mirror the existing
 * double-gated seams (PI_CREW_TEST_ASYNC_INLINE + PI_CREW_ALLOW_MOCK in
 * async-runner.ts; PI_TEAMS_MOCK_CHILD_PI + PI_CREW_ALLOW_MOCK in
 * mock-fixtures.ts): the mock only engages when PI_CREW_ALLOW_MOCK is ALSO
 * set, and PI_CREW_ALLOW_MOCK is filtered from child envs.
 */
export function mockLiveSessionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.PI_CREW_MOCK_LIVE_SESSION !== "success") return false;
	return env.PI_CREW_ALLOW_MOCK === "1" || env.PI_CREW_ALLOW_MOCK === "true";
}

export function resolveTaskRuntimeKind(
	globalKind: CrewRuntimeKind,
	role: string,
	isolationPolicy: CrewRuntimeConfig["isolationPolicy"],
	env: NodeJS.ProcessEnv = process.env,
	embedded?: EmbeddedRoutingInput,
): CrewRuntimeKind {
	if (globalKind === "scaffold") return "scaffold";
	// Safety: when already inside a pi-crew worker (depth > 0), never nest live-session.
	// Live-session creates in-process Pi agent sessions, which would recursively
	// try to use pi-crew, leading to "Cannot read properties of undefined" errors.
	// Exception: the double-gated mock seam (mockLiveSessionEnabled) — forcing
	// child-process would spawn a real pi process and hang the test harness.
	if (globalKind === "live-session" && currentCrewDepth(env) > 0 && !mockLiveSessionEnabled(env)) return "child-process";
	const isolatedRoles = isolationPolicy?.isolatedRoles ?? [];
	if (isolatedRoles.includes(role)) return "child-process";
	// U11 embedded-tier upgrade (DEFAULT-OFF). Guards mirror the depth guard
	// above: an in-process embedded session has the SAME nesting hazard, so
	// depth>0 keeps the task on child-process regardless of which kind the
	// caller resolved — the guard is EXTENDED to the embedded path, never
	// weakened (the double-gated mock seam keeps its test-harness exception).
	if (
		embedded?.policy?.enabled === true &&
		(embedded.policy.roles ?? []).includes(role) &&
		(embedded.faultCount ?? 0) < resolveEmbeddedFaultThreshold(embedded.policy) &&
		(currentCrewDepth(env) <= 0 || mockLiveSessionEnabled(env))
	) {
		return "live-session";
	}
	return isolationPolicy?.defaultRuntime ?? globalKind;
}
