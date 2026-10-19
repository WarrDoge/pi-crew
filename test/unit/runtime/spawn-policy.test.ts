/**
 * Spawn-policy admission matrix (ADR-5, WP-5 step 3; D8 refresh).
 *
 * Every gate dimension × its fail-fast message; the PARENT role is no longer
 * gated (D8 — every role may delegate), the requested grandchild role stays
 * inside the tool surface; depth-3 blocked by default; maxDepth config raise
 * → depth-3 admitted. Pure unit tests — no I/O.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_DELEGATE_TIMEOUT_SEC,
	DELEGATE_ALLOWED_ROLES,
	type DelegateAdmissionInput,
	effectiveGrandchildToolPolicy,
	evaluateDelegateAdmission,
	parentTaskTier,
} from "../../../src/runtime/spawn-policy.ts";
import { READ_ONLY_ROLE_SAMPLE, WRITE_ROLE_SAMPLE } from "./spawn-policy-role-samples.ts";

function baseInput(overrides?: Partial<DelegateAdmissionInput>): DelegateAdmissionInput {
	return {
		maxDepth: 2,
		parentTask: { taskId: "01_impl", role: "executor", depth: 1 },
		slots: { used: 0, max: 2 },
		modelCatalog: ["zai/glm-5.3", "deepseek/deepseek-v4-flash"],
		...overrides,
	};
}

test("happy path: depth-1 executor delegates → depth-2 grandchild admitted", () => {
	const d = evaluateDelegateAdmission(
		baseInput({
			parentTask: { taskId: "01_impl", role: "executor", depth: 1, allocation: { tokensGranted: 1000, tokensSpent: 0 } },
			requested: { role: "explorer", model: "zai/glm-5.3", budgetTokens: 100, timeoutSec: 300 },
		}),
	);
	assert.equal(d.allowed, true);
	assert.equal(d.reason, undefined);
	assert.equal(d.childDepth, 2);
	assert.equal(d.timeoutSec, 300);
	assert.equal(d.model, "zai/glm-5.3");
});

test("D8: parent role no longer gated — ANY role (incl. read-only) may delegate", () => {
	for (const role of [
		"executor",
		"test-engineer",
		"explorer",
		"analyst",
		"planner",
		"critic",
		"reviewer",
		"verifier",
		"writer",
		"security-reviewer",
	]) {
		const d = evaluateDelegateAdmission(baseInput({ parentTask: { taskId: "t", role, depth: 1 } }));
		assert.equal(d.allowed, true, `${role} parent must be allowed to delegate (D8)`);
	}
});

test("gate 1 role-denied: requested grandchild role outside the tool surface rejected", () => {
	const d = evaluateDelegateAdmission(baseInput({ requested: { role: "security-reviewer" } }));
	assert.equal(d.allowed, false);
	assert.equal(d.reason, "role-denied");
	assert.match(d.message ?? "", /requested grandchild role 'security-reviewer'/);
	assert.deepEqual([...DELEGATE_ALLOWED_ROLES], ["explorer", "analyst", "executor"]);
});

test("gate 2 trust-denied: untrusted escalation context rejected", () => {
	const d = evaluateDelegateAdmission(baseInput({ untrusted: true }));
	assert.equal(d.allowed, false);
	assert.equal(d.reason, "trust-denied");
	assert.match(d.message ?? "", /trust gate is manual-only/);
});

test("gate 3 depth-exceeded: depth-3 blocked at default maxDepth=2", () => {
	const d = evaluateDelegateAdmission(baseInput({ parentTask: { taskId: "02_child", role: "executor", depth: 2 } }));
	assert.equal(d.allowed, false);
	assert.equal(d.reason, "depth-exceeded");
	assert.match(d.message ?? "", /depth 3 exceeds maxDepth 2/);
});

test("gate 3 depth-exceeded: maxDepth config raise → depth-3 admitted (ADR-5 §4 generalized gate)", () => {
	const d = evaluateDelegateAdmission(baseInput({ maxDepth: 3, parentTask: { taskId: "02_child", role: "executor", depth: 2 } }));
	assert.equal(d.allowed, true);
	assert.equal(d.childDepth, 3);
});

test("gate 3 depth: parent depth absent (pre-v2 record) treated as depth 1", () => {
	const d = evaluateDelegateAdmission(baseInput({ parentTask: { taskId: "legacy", role: "executor" } }));
	assert.equal(d.allowed, true);
	assert.equal(d.childDepth, 2);
});

test("gate 4 slots-exhausted: fail-fast with N/M in flight, never queue", () => {
	const d = evaluateDelegateAdmission(baseInput({ slots: { used: 2, max: 2 } }));
	assert.equal(d.allowed, false);
	assert.equal(d.reason, "slots-exhausted");
	assert.match(d.message ?? "", /nested spawn budget exhausted; 2\/2 in flight/);
});

test("gate 5 budget-insufficient: requested budget exceeds parent remaining allocation", () => {
	const d = evaluateDelegateAdmission(
		baseInput({
			parentTask: { taskId: "01_impl", role: "executor", depth: 1, allocation: { tokensGranted: 1000, tokensSpent: 400 } },
			requested: { budgetTokens: 700 },
		}),
	);
	assert.equal(d.allowed, false);
	assert.equal(d.reason, "budget-insufficient");
	assert.match(d.message ?? "", /700 tokens exceeds parent task '01_impl' remaining allocation 600/);
});

test("gate 5 budget: exactly-remaining budget admitted (boundary)", () => {
	const d = evaluateDelegateAdmission(
		baseInput({
			parentTask: { taskId: "01_impl", role: "executor", depth: 1, allocation: { tokensGranted: 1000, tokensSpent: 400 } },
			requested: { budgetTokens: 600 },
		}),
	);
	assert.equal(d.allowed, true);
});

test("gate 5 budget: no allocation recorded → any positive budgetTokens rejected (fail-closed)", () => {
	const d = evaluateDelegateAdmission(baseInput({ requested: { budgetTokens: 1 } }));
	assert.equal(d.allowed, false);
	assert.equal(d.reason, "budget-insufficient");
});

test("gate 6 model-invalid: unvalidated provider/model pass-through rejected at admission", () => {
	const d = evaluateDelegateAdmission(baseInput({ requested: { model: "attacker/exfiltrate" } }));
	assert.equal(d.allowed, false);
	assert.equal(d.reason, "model-invalid");
	assert.match(d.message ?? "", /not in the resolved model catalog/);
});

test("gate 6 model: catalog member admitted with normalized ref", () => {
	const d = evaluateDelegateAdmission(baseInput({ requested: { model: "zai/glm-5.3" } }));
	assert.equal(d.allowed, true);
	assert.equal(d.model, "zai/glm-5.3");
});

test("gate 6 model: catalog omitted → validation skipped (handler must supply it; documented gap)", () => {
	const d = evaluateDelegateAdmission(baseInput({ modelCatalog: undefined, requested: { model: "anything/else" } }));
	assert.equal(d.allowed, true);
	assert.equal(d.model, "anything/else");
});

test("gate 7 timeout-invalid: zero / negative / non-finite / over-max rejected", () => {
	for (const timeoutSec of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 86_401]) {
		const d = evaluateDelegateAdmission(baseInput({ requested: { timeoutSec } }));
		assert.equal(d.allowed, false, `timeoutSec=${String(timeoutSec)} must be rejected`);
		assert.equal(d.reason, "timeout-invalid");
	}
});

test("gate 7 timeout: absent → mandatory default 900 (design §7)", () => {
	const d = evaluateDelegateAdmission(baseInput());
	assert.equal(d.allowed, true);
	assert.equal(d.timeoutSec, DEFAULT_DELEGATE_TIMEOUT_SEC);
	assert.equal(DEFAULT_DELEGATE_TIMEOUT_SEC, 900);
});

test("gate ORDER: requested-role gate precedes trust/depth/slots (cheapest surface check first)", () => {
	const d = evaluateDelegateAdmission(
		baseInput({ requested: { role: "security-reviewer" }, untrusted: true, slots: { used: 5, max: 5 } }),
	);
	assert.equal(d.reason, "role-denied");
});

test("gate 8 workspace-conflict: write-capable grandchild + overlapping in-flight executor + no serialization → rejected (ADR-5 §9)", () => {
	const d = evaluateDelegateAdmission(
		baseInput({ requested: { role: "executor" }, workspace: { serializeEnabled: false, overlappingInFlightExecutors: 1 } }),
	);
	assert.equal(d.allowed, false);
	assert.equal(d.reason, "workspace-conflict");
	assert.match(d.message ?? "", /overlaps 1 in-flight executor/);
	assert.match(d.message ?? "", /serializeOnPathOverlap is off/);
});

test("gate 8 workspace: read-only grandchild roles never conflict (explorer/analyst)", () => {
	for (const role of ["explorer", "analyst"]) {
		const d = evaluateDelegateAdmission(
			baseInput({ requested: { role }, workspace: { serializeEnabled: false, overlappingInFlightExecutors: 3 } }),
		);
		assert.equal(d.allowed, true, `${role} must pass the workspace gate`);
	}
});

test("gate 8 workspace: serialization established (serializeOnPathOverlap=true) admits the overlap", () => {
	const d = evaluateDelegateAdmission(
		baseInput({ requested: { role: "executor" }, workspace: { serializeEnabled: true, overlappingInFlightExecutors: 2 } }),
	);
	assert.equal(d.allowed, true);
});

test("gate 8 workspace: no overlap → executor grandchild admitted even without serialization", () => {
	const d = evaluateDelegateAdmission(
		baseInput({ requested: { role: "executor" }, workspace: { serializeEnabled: false, overlappingInFlightExecutors: 0 } }),
	);
	assert.equal(d.allowed, true);
});

// ---------------------------------------------------------------------------
// R43-S1 (fix-wave 6): transitive role-tier containment. D8 keeps delegation
// open to every role, but the TIER must be transitive — a read-only parent
// task is never granted a write-capable (executor-class) grandchild, and the
// effective grandchild tool policy is min(parent, requested).
// ---------------------------------------------------------------------------

test("R43-S1 gate 1b parent-role-escalation: read-only parent cannot request an executor grandchild", () => {
	for (const role of READ_ONLY_ROLE_SAMPLE) {
		const d = evaluateDelegateAdmission(baseInput({ parentTask: { taskId: "t", role, depth: 1 }, requested: { role: "executor" } }));
		assert.equal(d.allowed, false, `${role} parent must not spawn an executor grandchild`);
		assert.equal(d.reason, "parent-role-escalation");
		assert.match(d.message ?? "", /read-only tier/);
		assert.match(d.message ?? "", /transitive containment/);
	}
});

test("R43-S1 gate 1b: unknown or absent parent role default-denies to read-only (never upgrades)", () => {
	for (const role of [undefined, "totally-unknown-role", ""]) {
		const d = evaluateDelegateAdmission(
			baseInput({ parentTask: { taskId: "t", ...(role !== undefined ? { role } : {}), depth: 1 }, requested: { role: "executor" } }),
		);
		assert.equal(d.allowed, false, `parent role ${String(role)} must default-deny to read-only`);
		assert.equal(d.reason, "parent-role-escalation");
	}
	assert.equal(parentTaskTier(undefined), "read_only");
	assert.equal(parentTaskTier("executor"), "workspace_write");
});

test("R43-S1 gate 1b: write-capable parent may request an executor grandchild (no false positives)", () => {
	for (const role of WRITE_ROLE_SAMPLE) {
		const d = evaluateDelegateAdmission(baseInput({ parentTask: { taskId: "t", role, depth: 1 }, requested: { role: "executor" } }));
		assert.equal(d.allowed, true, `${role} parent spawning executor must stay admissible`);
	}
});

test("R43-S1 gate 1b: read-only parent may still delegate to read-only grandchildren (D8 preserved)", () => {
	for (const requested of ["explorer", "analyst"]) {
		for (const parentRole of READ_ONLY_ROLE_SAMPLE) {
			const d = evaluateDelegateAdmission(
				baseInput({ parentTask: { taskId: "t", role: parentRole, depth: 1 }, requested: { role: requested } }),
			);
			assert.equal(d.allowed, true, `${parentRole} → ${requested} must stay admissible (D8)`);
		}
	}
});

test("R43-S1 gate ORDER: parent-role-escalation precedes trust/depth/slots (role-surface checks first)", () => {
	const d = evaluateDelegateAdmission(
		baseInput({
			parentTask: { taskId: "t", role: "explorer", depth: 99 },
			requested: { role: "executor" },
			untrusted: true,
			slots: { used: 5, max: 5 },
		}),
	);
	assert.equal(d.reason, "parent-role-escalation");
});

test("R43-S1 effectiveToolPolicy on ALLOW: min(parent, requested) is threaded for the spawner", () => {
	const d = evaluateDelegateAdmission(
		baseInput({ parentTask: { taskId: "t", role: "explorer", depth: 1 }, requested: { role: "explorer" } }),
	);
	assert.equal(d.allowed, true);
	assert.ok(d.effectiveToolPolicy);
	assert.ok(d.effectiveToolPolicy.tools?.includes("read"));
	assert.ok(!d.effectiveToolPolicy.tools?.includes("bash"));
	assert.ok(d.effectiveToolPolicy.excludeTools?.includes("bash"));
});

test("R43-S1 effectiveGrandchildToolPolicy: read-only parent floor applies even to executor requests (defense-in-depth)", () => {
	const policy = effectiveGrandchildToolPolicy("explorer", "executor");
	// explorer allowlist wins (intersection with executor's undefined = parent's)
	assert.deepEqual(policy.tools, ["read", "grep", "find", "ls", "glob", "ask"]);
	assert.deepEqual(policy.excludeTools, ["edit", "write", "bash", "web"]);
	assert.ok(!policy.tools?.includes("bash"), "grandchild bash must be denied when parent is read-only");
});

test("R43-S1 effectiveGrandchildToolPolicy: denylists union across parent and requested", () => {
	// Reachable surface pair: analyst parent (read-only TIER, config excludes
	// only edit/write) → executor grandchild — the TIER floor adds bash.
	const analystToExecutor = effectiveGrandchildToolPolicy("analyst", "executor");
	assert.deepEqual(analystToExecutor.excludeTools, ["edit", "write", "bash"], "tier floor completes the read-only denylist");
	assert.equal(analystToExecutor.tools, undefined);
	// Generic pair (both sides declare): union of both denylists + tier floor
	// cuts edit/write from writer's own allowlist (analyst parent is read-only tier).
	const policy = effectiveGrandchildToolPolicy("analyst", "writer");
	assert.deepEqual([...(policy.excludeTools ?? [])].sort(), ["bash", "edit", "web", "write"]);
	assert.deepEqual(
		policy.tools,
		["read", "ls", "ask"],
		"parent has no allowlist → requested role's own allowlist, minus the read-only tier floor",
	);
});

test("R43-S1 effectiveGrandchildToolPolicy: unrestricted parent (executor) → requested role's own policy", () => {
	const policy = effectiveGrandchildToolPolicy("executor", "explorer");
	assert.deepEqual(policy.tools, ["read", "grep", "find", "ls", "glob", "ask"]);
	assert.deepEqual(policy.excludeTools, ["edit", "write", "bash", "web"]);
	const unrestricted = effectiveGrandchildToolPolicy("executor", "executor");
	assert.equal(unrestricted.tools, undefined);
	assert.equal(unrestricted.excludeTools, undefined);
});

test("R43-S1 effectiveGrandchildToolPolicy: absent parent role → read-only floor (fail-closed)", () => {
	const policy = effectiveGrandchildToolPolicy(undefined, "executor");
	assert.ok(!policy.tools?.includes("bash"));
	assert.ok(policy.excludeTools?.includes("bash"), "absent parent role must not upgrade the grandchild to write-capable");
});
