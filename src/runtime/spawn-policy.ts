/**
 * Spawn policy for delegate-driven grandchild admission (ADR-5, WP-5 step 3).
 *
 * Pure evaluation — no I/O, no state mutation. The root-side delegate handler
 * (broker `delegate` method, WP-5 step 5) gathers the inputs and calls
 * `evaluateDelegateAdmission`; on denial it returns the fail-fast message to
 * the worker and logs `delegate.rejected` to events.jsonl (never silent).
 *
 * Gate dimensions (each with a distinct machine-readable reason + fail-fast
 * message; evaluated in this order — cheapest/most-global first):
 *   1. trust-denied       — untrusted escalation context (manual-only trust
 *                           gate; the handler resolves trust, policy enforces)
 *   2. role-denied        — the REQUESTED grandchild role is not one of the
 *                           delegate-tool's allowed roles (the parent role is
 *                           NO LONGER gated — D8: every role may delegate;
 *                           the spawn-side checkCrewDepth cap is the boundary)
 *   2b. parent-role-escalation — R43-S1 transitive role-tier containment:
 *                           the REQUESTED grandchild tier must not exceed the
 *                           PARENT task record's tier (permissionForRole).
 *                           D8 keeps every role free to DELEGATE — but a
 *                           read-only parent is never granted a write-capable
 *                           (executor-class) grandchild. Unknown/absent parent
 *                           roles default-deny to read-only (FIND-12).
 *   3. depth-exceeded     — child depth (parent.depth + 1) exceeds the
 *                           resolved maxDepth (default 4). Depth comes from
 *                           the parent task RECORD, never worker env
 *                           (design §7 rev-2 P0-2)
 *   4. slots-exhausted    — nested-slot budget exhausted ("N/M in flight");
 *                           fail-fast, never queue
 *   5. budget-insufficient— requested budgetTokens exceed the parent task's
 *                           remaining allocation (tokensGranted - tokensSpent)
 *   6. model-invalid      — requested model is not in the resolved model
 *                           catalog (the unvalidated provider/model
 *                           pass-through — model-fallback.ts:282, the
 *                           429-cascade root — must not be reachable here)
 *   7. timeout-invalid    — timeoutSec outside 1..MAX (default 900)
 *   8. workspace-conflict — write-capable grandchild narrowing cwd overlap
 */

import type { ResolvedToolPolicy } from "../agents/agent-config.ts";
import { getToolConfig } from "../config/role-tools.ts";
import { modelRefToString } from "./model/model-fallback.ts";
import { permissionForRole } from "./role-permission.ts";
import type { NestedSlotSnapshot } from "./scheduling/nested-slots.ts";

/** Delegate tool's allowed grandchild roles (design §7 surface). */
export const DELEGATE_ALLOWED_ROLES = ["explorer", "analyst", "executor"] as const;
export type DelegateRole = (typeof DELEGATE_ALLOWED_ROLES)[number];

/**
 * Roles permitted to CALL delegate (executor-class). Read-only/review roles
 * (explorer, analyst, planner, critic, reviewer, verifier, writer,
 * security-reviewer) are denied — delegation is a spawn privilege.
 */
export const EXECUTOR_CLASS_ROLES = ["executor", "test-engineer"] as const;

export const DEFAULT_DELEGATE_TIMEOUT_SEC = 900;
export const MAX_DELEGATE_TIMEOUT_SEC = 86_400;

export type SpawnPolicyDenyReason =
	| "role-denied"
	| "parent-role-escalation"
	| "trust-denied"
	| "depth-exceeded"
	| "slots-exhausted"
	| "budget-insufficient"
	| "model-invalid"
	| "timeout-invalid"
	| "workspace-conflict";

export interface DelegateAdmissionInput {
	/** Resolved max depth (nesting.maxDepth default 4; env clamp mirrors PI_CREW_MAX_DEPTH 1..10). */
	maxDepth: number;
	/** Parent task record fields the policy is allowed to trust. */
	parentTask: {
		taskId: string;
		/** Role for workspace-capability + tier-transitivity evaluation (D8
		 *  opens delegation to every role; R43-S1 keeps the TIER transitive —
		 *  a read-only parent is never granted a write-capable grandchild). */
		role?: string;
		/** Absent on pre-v2 records — treated as depth 1 (a worker). */
		depth?: number;
		allocation?: { tokensGranted?: number; tokensSpent?: number };
	};
	/** Untrusted escalation context — the delegate handler resolves trust. */
	untrusted?: boolean;
	/** Nested-slot budget snapshot (used/max). */
	slots: NestedSlotSnapshot;
	/** Requested grandchild parameters (all optional in the tool surface). */
	requested?: {
		role?: string;
		model?: string;
		budgetTokens?: number;
		timeoutSec?: number;
	};
	/**
	 * Resolved model catalog as canonical `provider/id` strings. When omitted
	 * (catalog unavailable at the call-site) model validation is SKIPPED —
	 * flag this in review; the broker handler must always supply it.
	 */
	modelCatalog?: readonly string[];
	/** ADR-5 §9 workspace interaction: when the requested grandchild role is
	 * write-capable (executor-class), an overlapping in-flight executor can
	 * only be tolerated when serialization is established. `serializeEnabled`
	 * mirrors config `limits.serializeOnPathOverlap`; `overlappingInFlightExecutors`
	 * counts OTHER running executor-class tasks sharing the parent task's cwd. */
	workspace?: {
		serializeEnabled?: boolean;
		overlappingInFlightExecutors?: number;
	};
}

export interface SpawnPolicyDecision {
	allowed: boolean;
	/** Machine-readable deny reason (undefined when allowed). */
	reason?: SpawnPolicyDenyReason;
	/** Fail-fast human message (undefined when allowed). */
	message?: string;
	/** The grandchild's depth (parent depth + 1) on success. */
	childDepth?: number;
	/** Effective timeout in seconds (requested or default 900) on success. */
	timeoutSec?: number;
	/** Effective model (normalized) on success. */
	model?: string;
	/** R43-S1 defense-in-depth: the effective (min-intersected) tool policy
	 *  the spawner must apply to the grandchild — intersection of the parent
	 *  task role's policy and the requested grandchild role's policy
	 *  ({@link effectiveGrandchildToolPolicy}). Present on ALLOW decisions so
	 *  the spawn side never has to re-derive tier logic. */
	effectiveToolPolicy?: ResolvedToolPolicy;
}

export function isExecutorClassRole(role: string): boolean {
	return (EXECUTOR_CLASS_ROLES as readonly string[]).includes(role);
}

/**
 * R43-S1 transitive containment: the parent task's permission tier, with
 * FIND-12 default-deny for unknown/absent roles (an absent parent role can
 * never upgrade to write-capable).
 */
export function parentTaskTier(parentRole: string | undefined): "read_only" | "workspace_write" {
	return permissionForRole(parentRole ?? "") === "workspace_write" ? "workspace_write" : "read_only";
}

/**
 * R43-S1: the mutation-capable pi tool set that defines the read-only tier
 * floor. A read_only-tier parent's grandchild is denied these regardless of
 * either role's own config quirks (e.g. analyst's config excludes only
 * edit/write while its TIER is read-only — the tier, not the config list, is
 * the transitive boundary).
 */
const READ_ONLY_TIER_EXCLUDED_TOOLS: readonly string[] = ["edit", "write", "bash"];

/**
 * R43-S1: effective grandchild tool policy = intersection (min) of the
 * PARENT task role's tool policy and the REQUESTED grandchild role's policy.
 *
 * Semantics (least privilege on both axes):
 *   - TIER FLOOR first: a read_only-tier parent (permissionForRole, FIND-12
 *     default-deny for unknown/absent) denies edit/write/bash to the
 *     grandchild no matter what either role config says — the tier is the
 *     transitive boundary.
 *   - allowlist (`tools`): the NARROWER of the two wins — intersection when
 *     both define one, the single defined one otherwise, none only when
 *     NEITHER restricts (undefined = all built-ins allowed). Empty
 *     intersections (disjoint configs — unreachable with today's
 *     ROLE_TOOL_CONFIGS) fall back to the PARENT list: the parent's
 *     restrictions are the transitive boundary, and an empty `tools: []`
 *     would be silently skipped by the pi argv builder (fail-open).
 *   - denylist (`excludeTools`): ADDITIVE union — it is always safe to
 *     forbid more, and a security exclude from either side can never be
 *     weakened by the other's omission (mirrors resolveToolPolicy's
 *     denylist-merge rule).
 *
 * The spawn side applies this to the delegate grandchild's in-memory agent
 * config (delegate-spawn.ts grandchildAgentForRole) so the pi argv
 * `--tools`/`--exclude-tools` cut reflects the transitive floor even if a
 * future code path reaches the spawner without the admission gate.
 */
export function effectiveGrandchildToolPolicy(parentRole: string | undefined, requestedRole: string): ResolvedToolPolicy {
	const parentConfig = parentRole !== undefined ? getToolConfig(parentRole) : {};
	const requestedConfig = getToolConfig(requestedRole);
	let tools: string[] | undefined;
	if (parentConfig.tools !== undefined && requestedConfig.tools !== undefined) {
		const requestedSet = new Set(requestedConfig.tools);
		const intersection = parentConfig.tools.filter((tool) => !READ_ONLY_TIER_EXCLUDED_TOOLS.includes(tool) && requestedSet.has(tool));
		tools = intersection.length > 0 ? intersection : parentConfig.tools;
	} else {
		tools = parentConfig.tools ?? requestedConfig.tools;
	}
	const excludeTools = [...(parentConfig.excludeTools ?? []), ...(requestedConfig.excludeTools ?? [])];
	// TIER FLOOR — applied AFTER the config intersection so the boundary is
	// the parent's permissionForRole tier, never a config-list accident.
	if (parentTaskTier(parentRole) === "read_only") {
		tools = tools?.filter((tool) => !READ_ONLY_TIER_EXCLUDED_TOOLS.includes(tool));
		excludeTools.push(...READ_ONLY_TIER_EXCLUDED_TOOLS);
	}
	const uniqueExcludeTools = [...new Set(excludeTools)];
	return {
		...(tools !== undefined ? { tools } : {}),
		...(uniqueExcludeTools.length > 0 ? { excludeTools: uniqueExcludeTools } : {}),
	};
}

function deny(reason: SpawnPolicyDenyReason, message: string): SpawnPolicyDecision {
	return { allowed: false, reason, message };
}

export function evaluateDelegateAdmission(input: DelegateAdmissionInput): SpawnPolicyDecision {
	const { maxDepth, parentTask, requested } = input;
	const parentDepth = parentTask.depth ?? 1; // pre-v2 records: workers are depth 1
	const childDepth = parentDepth + 1;

	// 1. Role gate — the REQUESTED grandchild role must be in the tool's allowed
	// set (the PARENT role is no longer gated — D8: every role may delegate;
	// the spawn-side checkCrewDepth cap + slot budget below are the boundary).
	const requestedRole = requested?.role;
	if (requestedRole !== undefined && !(DELEGATE_ALLOWED_ROLES as readonly string[]).includes(requestedRole)) {
		return deny(
			"role-denied",
			`delegate rejected: requested grandchild role '${requestedRole}' is not one of ${DELEGATE_ALLOWED_ROLES.join("/")}`,
		);
	}

	// 1b. R43-S1 transitive role-tier containment — a read-only parent task can
	// never be granted a write-capable (executor-class) grandchild. D8 opens
	// delegation to every role; this gate keeps the TIER transitive: the
	// effective grandchild policy is min(parent, requested), and a
	// min(read_only, workspace_write) request is refused outright instead of
	// silently degraded. Unknown/absent parent roles default-deny to
	// read-only (permissionForRole FIND-12) — never upgrade on missing data.
	const requestedIsExecutorClass = requestedRole !== undefined && (EXECUTOR_CLASS_ROLES as readonly string[]).includes(requestedRole);
	if (requestedIsExecutorClass && parentTaskTier(parentTask.role) === "read_only") {
		return deny(
			"parent-role-escalation",
			`delegate rejected: parent task '${parentTask.taskId}' role '${parentTask.role ?? "<absent>"}' is read-only tier — write-capable grandchild role '${requestedRole}' would escalate beyond the parent's tier (transitive containment, R43-S1); use a read-only grandchild role (explorer/analyst)`,
		);
	}

	// 2. Trust gate — untrusted escalation context never spawns.
	if (input.untrusted) {
		return deny("trust-denied", "delegate rejected: untrusted escalation context (trust gate is manual-only)");
	}

	// 3. Depth gate — computed from the parent RECORD (never worker env).
	if (childDepth > maxDepth) {
		return deny(
			"depth-exceeded",
			`delegate rejected: spawn depth ${childDepth} exceeds maxDepth ${maxDepth} (parent task '${parentTask.taskId}' is at depth ${parentDepth})`,
		);
	}

	// 4. Nested-slot budget — fail-fast, never queue.
	if (input.slots.used >= input.slots.max) {
		return deny(
			"slots-exhausted",
			`delegate rejected: nested spawn budget exhausted; ${input.slots.used}/${input.slots.max} in flight`,
		);
	}

	// 5. Parent allocation sufficiency — reserve up-front or reject.
	if (requested?.budgetTokens !== undefined) {
		const granted = parentTask.allocation?.tokensGranted ?? 0;
		const spent = parentTask.allocation?.tokensSpent ?? 0;
		const remaining = granted - spent;
		if (requested.budgetTokens > remaining) {
			return deny(
				"budget-insufficient",
				`delegate rejected: requested budget ${requested.budgetTokens} tokens exceeds parent task '${parentTask.taskId}' remaining allocation ${remaining} (${granted} granted - ${spent} spent)`,
			);
		}
	}

	// 6. Model validation against the resolved catalog.
	const normalizedModel = requested?.model !== undefined ? modelRefToString(requested.model) : undefined;
	if (normalizedModel !== undefined && input.modelCatalog !== undefined) {
		if (!input.modelCatalog.includes(normalizedModel)) {
			return deny("model-invalid", `delegate rejected: model '${requested?.model}' is not in the resolved model catalog`);
		}
	}

	// 7. Timeout validation (mandatory default 900).
	const timeoutSec = requested?.timeoutSec ?? DEFAULT_DELEGATE_TIMEOUT_SEC;
	if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_DELEGATE_TIMEOUT_SEC) {
		return deny(
			"timeout-invalid",
			`delegate rejected: timeoutSec ${String(requested?.timeoutSec)} is outside 1..${MAX_DELEGATE_TIMEOUT_SEC} (default ${DEFAULT_DELEGATE_TIMEOUT_SEC})`,
		);
	}

	// 8. Workspace interaction (ADR-5 §9): a write-capable grandchild sharing
	// the parent's cwd with ANOTHER in-flight executor is only admitted when
	// serialization is established (limits.serializeOnPathOverlap) — otherwise
	// reject; read-only grandchild roles (explorer/analyst) never conflict.
	if (requestedIsExecutorClass && !input.workspace?.serializeEnabled && (input.workspace?.overlappingInFlightExecutors ?? 0) > 0) {
		return deny(
			"workspace-conflict",
			`delegate rejected: parent task '${parentTask.taskId}' cwd overlaps ${input.workspace?.overlappingInFlightExecutors} in-flight executor(s) and limits.serializeOnPathOverlap is off — use a read-only grandchild role (explorer/analyst) or enable serialization`,
		);
	}

	// R43-S1: thread the effective (min) tool policy so the spawner applies
	// the transitive floor without re-deriving tier logic.
	return {
		allowed: true,
		childDepth,
		timeoutSec,
		...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
		effectiveToolPolicy: effectiveGrandchildToolPolicy(parentTask.role, requestedRole ?? "explorer"),
	};
}
