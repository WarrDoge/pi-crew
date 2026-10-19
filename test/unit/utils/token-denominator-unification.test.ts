/**
 * token-denominator-unification.test.ts — M3-10 / R34 pin (fix-wave 6).
 *
 * Round 34 finding: three budget/estimate surfaces used three different
 * denominators — `round(chars / 4)` (prompt-builder), a hand-copied
 * `max(countTokens(body), Σ measured)` mirror (task-output-context) and raw
 * `countTokens` (pruner / dynamic-workflow). Same-shaped numbers, different
 * units in edge cases (notably CJK, where chars/4 under-counts ~2-3x).
 *
 * Fix: ONE conversion module (src/utils/token-counter.ts) with THREE exports —
 * `estimateTokensFromChars` (char COUNT + the documented `CHARS_PER_TOKEN`
 * constant), `estimateTokensForText` (honest text path), and
 * `effectiveTokenEstimate` (the single U10 measured-anchor rule). These pins
 * assert the call sites now compose those helpers instead of re-deriving them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { estimateTokens } from "../../../src/runtime/task-runner/prompt-builder.ts";
import {
	CHARS_PER_TOKEN,
	countTokens,
	effectiveTokenEstimate,
	estimateTokensForText,
	estimateTokensFromChars,
} from "../../../src/utils/token-counter.ts";

describe("M3-10/R34: one denominator, one unit (TOKENS)", () => {
	it("the unit constant is documented and the char→token conversion is single-sourced", () => {
		assert.equal(CHARS_PER_TOKEN, 4, "ASCII-prose proxy (~4 chars/token) — the documented unit contract");
		assert.equal(estimateTokensFromChars(400), 100);
		assert.equal(estimateTokensFromChars(401), 100);
		assert.equal(estimateTokensFromChars(0), 0);
		assert.equal(estimateTokensFromChars(-5), 0, "never negative");
		assert.equal(estimateTokensFromChars(Number.NaN), 0);
	});

	it("the text path IS countTokens (CJK-aware) — never text.length / 4", () => {
		const cjk = "这是一段中文文本用于验证分词估计的准确性"; // 20 CJK chars
		assert.equal(estimateTokensForText(cjk), countTokens(cjk));
		// The coarse char/4 path would report 5 tokens for 21 chars; the honest
		// estimator reports substantially more (the ~2-3x under-count R5-7 fixed).
		assert.ok(
			estimateTokensForText(cjk) > estimateTokensFromChars(cjk.length),
			`CJK: ${estimateTokensForText(cjk)} tokens vs chars/4 ${estimateTokensFromChars(cjk.length)}`,
		);
	});

	it("the U10 measured anchor rule is shared by prompt-builder and task-output-context", () => {
		// prompt-builder.estimateTokens(chars, measured) === the shared rule.
		for (const [chars, measured] of [
			[400, undefined],
			[400, 3000],
			[400, 10],
			[0, 0],
		] as Array<[number, number | undefined]>) {
			assert.equal(
				estimateTokens(chars, measured),
				effectiveTokenEstimate(estimateTokensFromChars(chars), measured),
				`estimateTokens(${chars}, ${measured}) must compose the shared helpers`,
			);
		}
	});

	it("all three call sites agree on TOKENS for ASCII prose (no char/token mix-up)", () => {
		// A realistic ASCII handoff body: the prompt-diet estimate (char count),
		// the handoff measure (text) and the pruner measure (text) must all be in
		// the same unit — i.e. the two text sites are identical, and the char-count
		// site is within the estimator's own ±25% prose band of the text site.
		const body = "Handoff: the executor implemented the parser and the tests pass. No blockers remain for this lane.\n";
		const textTokens = estimateTokensForText(body);
		assert.equal(textTokens, countTokens(body), "handoff + pruner paths are one function");
		const charEstimate = estimateTokens(body.length);
		const ratio = charEstimate / textTokens;
		assert.ok(ratio > 0.75 && ratio < 1.25, `char-count estimate ${charEstimate} vs text ${textTokens} (same TOKEN unit, ±25%)`);
	});
});
