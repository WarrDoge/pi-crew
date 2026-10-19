/**
 * M3-28 (R47-V2, fix-wave 6) — census pin for the DEAD U6B classifier
 * pre-gate branch.
 *
 * Finding (R47-V2): the verifier pre-gate was consulted ONLY under
 * `outcome.verdict === "INCONCLUSIVE"` and was fed the literal gate verdict
 * (`verify-gate.ts` → `classifyVerifierPreGate({ verdict: { verdict: outcome.verdict } })`).
 * `classifyVerifierPreGate` blocks only when `isPassShapedVerdict(...)` is true
 * (PASS vocabulary AND no failure vocabulary); "INCONCLUSIVE" can never satisfy
 * it, so the call could only ever resolve to `escalate_verdict_failed`
 * (`blockVerifier: false`) — the same spawn decision the no-classifier branch
 * yields. Net effect: one classifier model call, one `task.verifier_pre_gate`
 * event and one `decisions_total` counter for a decision that could never
 * differ, plus a misleading `classifier_*` spawn-reason label.
 *
 * Fix under test: the consult is REMOVED from the gate (it cannot be "wired
 * properly" — an INCONCLUSIVE state is not conclusive evidence of a pass).
 *
 * Census pins:
 *  1. STATIC: no source file except `classifier-pre-gate.ts` (its own
 *     definition/doc) references `classifyVerifierPreGate`; `verify-gate.ts`
 *     does not reference it at all.
 *  2. BEHAVIORAL: `runVerifierGatePreGate` with `classifier.enabled = true` and
 *     a registry instrumented to record ANY property access never touches the
 *     registry, returns `preGate === undefined`, and never labels the decision
 *     `classifier_*`.
 *
 * Mutation proof: restoring the consult call fails both pins.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

import { runVerifierGatePreGate } from "../../../../src/runtime/verification/verify-gate.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

const SRC_ROOT = path.join(import.meta.dirname, "..", "..", "..", "..", "src");
const VERIFY_GATE = path.join(SRC_ROOT, "runtime", "verification", "verify-gate.ts");

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** Census reads CODE, not prose: the removal itself is documented in comments
 *  that name the symbol, so block/line comments are stripped before scanning. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("M3-28 — classifier pre-gate census", () => {
	test("STATIC: classifyVerifierPreGate has no production caller outside its own module", () => {
		const offenders: string[] = [];
		for (const file of walk(SRC_ROOT)) {
			const source = stripComments(fs.readFileSync(file, "utf8"));
			if (!source.includes("classifyVerifierPreGate")) continue;
			const rel = path.relative(SRC_ROOT, file);
			if (rel === path.join("runtime", "verification", "classifier-pre-gate.ts")) continue;
			offenders.push(rel);
		}
		assert.deepEqual(offenders, [], `dead pre-gate mount is back in: ${offenders.join(", ")}`);
	});

	test("STATIC: verify-gate.ts neither imports nor calls the classifier pre-gate", () => {
		const source = stripComments(fs.readFileSync(VERIFY_GATE, "utf8"));
		assert.ok(!source.includes("classifyVerifierPreGate"), "verify-gate must not reference the classifier pre-gate");
		assert.ok(source.includes("const preGate: VerifierPreGateResult | undefined = undefined;"), "the removal must be explicit");
	});

	test("BEHAVIORAL: classifier.enabled=true on an INCONCLUSIVE gate never touches the model registry", async () => {
		const dir = createTrackedTempDir("pi-crew-m3-28-census-");
		let registryTouches = 0;
		const countingRegistry = new Proxy(
			{},
			{
				get(_target, prop) {
					registryTouches += 1;
					throw new Error(`registry touched via ${String(prop)} — the dead classifier consult is back`);
				},
			},
		);
		try {
			const result = await runVerifierGatePreGate({
				cwd: dir,
				classifier: {
					enabled: true,
					modelRegistry: countingRegistry,
					classifierModel: "opencode/test",
					eventsPath: path.join(dir, "events.jsonl"),
					runId: "r-census",
					taskId: "t-census",
				},
			});
			assert.equal(result.outcome.verdict, "INCONCLUSIVE", "no host spec + no explicit checks ⇒ INCONCLUSIVE");
			assert.equal(registryTouches, 0, "the classifier layer must not be consulted at all");
			assert.equal(result.preGate, undefined, "no pre-gate result is produced anymore");
			assert.equal(result.decision.skipVerifier, false, "an inconclusive gate always escalates to the LLM verifier");
			assert.equal(result.decision.reason, "inconclusive_no_classifier");
			assert.ok(!result.decision.reason.startsWith("classifier_"), "no classifier_* label may be produced");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("BEHAVIORAL: a FAILED gate (pass-shaped verdict impossible) also never consults the classifier", async () => {
		const dir = createTrackedTempDir("pi-crew-m3-28-failed-");
		let registryTouches = 0;
		const countingRegistry = new Proxy(
			{},
			{
				get() {
					registryTouches += 1;
					return undefined;
				},
			},
		);
		try {
			const result = await runVerifierGatePreGate({
				cwd: dir,
				checks: [{ name: "always-red", command: "false" }],
				classifier: {
					enabled: true,
					modelRegistry: countingRegistry,
					classifierModel: "opencode/test",
					eventsPath: path.join(dir, "events.jsonl"),
					runId: "r-census-red",
				},
			});
			assert.equal(result.outcome.verdict, "FAILED");
			assert.equal(registryTouches, 0);
			assert.equal(result.decision.reason, "deterministic_failed");
			assert.equal(result.decision.skipVerifier, false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
