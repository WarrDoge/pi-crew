/**
 * delegate-grandchild-policy.test.ts — R43-S1 (fix-wave 6) pin.
 *
 * The delegate grandchild is spawned from a MINIMAL in-memory AgentConfig
 * (no agents/<role>.md frontmatter is read), so the ONLY argv-level tool cut
 * it receives is the effective (min) policy applied by
 * grandchildAgentForRole: intersection of the PARENT task role's policy and
 * the requested grandchild role's policy (spawn-policy.ts
 * effectiveGrandchildToolPolicy).
 *
 * Pin (transcript-u1-s1 conversion): grandchild bash denied when the parent
 * task role is read-only — pi-args derives `--tools`/`--exclude-tools` from
 * agent.tools/disallowedTools, so the assertion surface is exactly those
 * fields.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { grandchildAgentForRole } from "../../../src/runtime/delegate-spawn.ts";

test("R43-S1: read-only parent → executor grandchild agent has bash/edit/write denied (transitive floor)", () => {
	for (const parentRole of ["explorer", "analyst", "planner", "critic", "reviewer", "security-reviewer"]) {
		const agent = grandchildAgentForRole("executor", parentRole);
		assert.ok(agent.disallowedTools?.includes("bash"), `${parentRole} parent: grandchild bash must be denied`);
		assert.ok(agent.disallowedTools?.includes("edit"), `${parentRole} parent: grandchild edit must be denied`);
		assert.ok(agent.disallowedTools?.includes("write"), `${parentRole} parent: grandchild write must be denied`);
		assert.ok(!agent.tools?.includes("bash"), `${parentRole} parent: allowlist must not contain bash`);
	}
});

test("R43-S1: absent parent role → same read-only floor (fail-closed, never upgrades)", () => {
	const agent = grandchildAgentForRole("executor");
	assert.ok(agent.disallowedTools?.includes("bash"));
});

test("R43-S1: write-capable parent → executor grandchild keeps the parent's own policy (no extra cut)", () => {
	// executor parent has NO restrictions → executor grandchild unchanged (today's behavior).
	const agent = grandchildAgentForRole("executor", "executor");
	assert.equal(agent.tools, undefined);
	assert.equal(agent.disallowedTools, undefined);
	// verifier parent (write-capable with its own allowlist) → the min keeps
	// the verifier allowlist; nothing NEW is denied beyond the union of both.
	const verifierAgent = grandchildAgentForRole("executor", "verifier");
	assert.ok(verifierAgent.tools?.includes("bash"), "verifier allows bash — executor grandchild keeps it");
	assert.deepEqual(verifierAgent.disallowedTools, ["edit", "write", "web"]);
});

test("R43-S1: explorer grandchild agent carries its own read-only config regardless of parent", () => {
	const agent = grandchildAgentForRole("explorer", "executor");
	assert.ok(agent.tools?.includes("read"));
	assert.ok(!agent.tools?.includes("bash"));
	assert.ok(agent.disallowedTools?.includes("bash"));
	assert.equal(agent.name, "explorer");
	assert.equal(agent.source, "builtin");
});
