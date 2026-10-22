/**
 * post-execution-drift-block.test.ts — W10-5 (v0.11.38) pin.
 *
 * pi-subagents lesson #20 (oracle/drift-guardian): a reviewer/critic/oracle
 * that flags a contradiction with an inherited run decision (`DRIFT-BLOCK:`)
 * while ALSO emitting a PASS verdict is self-contradictory — the runtime must
 * not let that pass count. extractVerifierVerdict degrades it to "none"
 * (not verified → the existing self-attested downgrade path demands leader
 * review). FAIL still wins over everything.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractVerifierVerdict } from "../../../../src/runtime/task-runner/post-execution.ts";

describe("W10-5 DRIFT-BLOCK downgrade in extractVerifierVerdict", () => {
	it("(1) PASS + DRIFT-BLOCK in same source → 'none' (not verified)", () => {
		const src =
			"DRIFT-BLOCK: SPEC §2 pinned process-per-worker — recommendation contradicts it\nPASS: everything else checks out — evidence A";
		assert.equal(extractVerifierVerdict(src), "none");
	});

	it("(2) plain PASS (no marker) → 'pass' unchanged", () => {
		assert.equal(extractVerifierVerdict("PASS: gates green — 3/3 exit 0"), "pass");
	});

	it("(3) FAIL + DRIFT-BLOCK → 'fail' (fail still wins)", () => {
		const src = "DRIFT-BLOCK: SPEC §2\nFAIL: typecheck exit 1";
		assert.equal(extractVerifierVerdict(src), "fail");
	});

	it("(4) marker without any verdict line → 'none' as before", () => {
		assert.equal(extractVerifierVerdict("DRIFT-BLOCK: SPEC §2\nsome prose report"), "none");
	});

	it("(5) marker in an EARLIER source sticks (fail-closed: a later truncated source must not launder it)", () => {
		const poisoned = "DRIFT-BLOCK: decision-1\nPASS: ok";
		const clean = "PASS: ok";
		// The raw/earlier source is the authoritative one; if it flags a drift,
		// a cleaner LATER source (e.g. compaction-truncated copy that lost the
		// marker line) must NOT upgrade the verdict back to pass.
		assert.equal(extractVerifierVerdict(poisoned, clean), "none");
		assert.equal(extractVerifierVerdict(clean, poisoned), "pass");
		assert.equal(extractVerifierVerdict(poisoned), "none");
	});

	it("(6) markdown-decorated verdicts still hit the downgrade", () => {
		const src = "**PASS:** ok\n> DRIFT-BLOCK: decision-2";
		assert.equal(extractVerifierVerdict(src), "none");
	});
});
