import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChainDSL } from "../../../src/runtime/chain-parser.ts";

describe("chain-parser: parseChainDSL", () => {
	it("parses a simple single-step chain", () => {
		const result = parseChainDSL("step1");
		assert.deepEqual(result, [{ name: "step1" }]);
	});

	it("parses a two-step chain with arrow", () => {
		const result = parseChainDSL("step1 -> step2");
		assert.deepEqual(result, [{ name: "step1" }, { name: "step2" }]);
	});

	it("parses a chain with parallel group", () => {
		const result = parseChainDSL("step1 -> parallel(step2, step3) -> step4");
		assert.deepEqual(result, [
			{ name: "step1" },
			{
				name: "parallel",
				parallel: [{ name: "step2" }, { name: "step3" }],
			},
			{ name: "step4" },
		]);
	});

	it("parses nested parallel groups", () => {
		const result = parseChainDSL("parallel(a, parallel(b, c)) -> d");
		assert.deepEqual(result, [
			{
				name: "parallel",
				parallel: [
					{ name: "a" },
					{
						name: "parallel",
						parallel: [{ name: "b" }, { name: "c" }],
					},
				],
			},
			{ name: "d" },
		]);
	});

	it("parses loop count modifier with colon", () => {
		const result = parseChainDSL("step1:3 -> step2");
		assert.deepEqual(result, [{ name: "step1", loopCount: 3 }, { name: "step2" }]);
	});

	it("parses --with-context flag", () => {
		const result = parseChainDSL("step1 --with-context -> step2");
		assert.deepEqual(result, [{ name: "step1", withContext: true }, { name: "step2" }]);
	});

	it("parses quoted arguments", () => {
		const result = parseChainDSL('step1 "arg1" "arg2"');
		assert.deepEqual(result, [{ name: "step1", args: ["arg1", "arg2"] }]);
	});

	it("parses quoted arguments with escape sequences", () => {
		const result = parseChainDSL('step1 "arg\\"1"');
		assert.deepEqual(result, [{ name: "step1", args: ['arg"1'] }]);
	});

	it("parses single-quoted arguments", () => {
		const result = parseChainDSL("step1 'hello world'");
		assert.deepEqual(result, [{ name: "step1", args: ["hello world"] }]);
	});

	it("parses complex chain with all modifiers", () => {
		const result = parseChainDSL('explore:2 --with-context "target" -> parallel(a, b) -> verify');
		assert.equal(result.length, 3);
		assert.equal(result[0].name, "explore");
		assert.equal(result[0].loopCount, 2);
		assert.equal(result[0].withContext, true);
		assert.deepEqual(result[0].args, ["target"]);
		assert.equal(result[1].name, "parallel");
		assert.equal(result[1].parallel!.length, 2);
		assert.equal(result[2].name, "verify");
	});

	it("handles extra whitespace gracefully", () => {
		const result = parseChainDSL("  step1   ->   step2  ");
		assert.deepEqual(result, [{ name: "step1" }, { name: "step2" }]);
	});

	it("throws on unclosed parenthesis", () => {
		assert.throws(() => parseChainDSL("parallel(step1, step2"), /Expected RPAREN|end of chain/);
	});

	it("throws on unclosed quoted string", () => {
		assert.throws(() => parseChainDSL('step1 "unterminated'), /Unclosed quoted/);
	});

	it("throws on unexpected character", () => {
		assert.throws(() => parseChainDSL("step1 @ step2"), /Unexpected character/);
	});

	it("throws on empty parallel group", () => {
		// parallel() with no args would fail because NAME is expected
		assert.throws(() => parseChainDSL("parallel()"), /Expected NAME/);
	});

	it("parses step names with dots and hyphens", () => {
		const result = parseChainDSL("my-step.v2 -> other_step");
		assert.deepEqual(result, [{ name: "my-step.v2" }, { name: "other_step" }]);
	});
});

// ─── v0.11.27 (R14-C1 tail): loopCount clamp ─────────────────────────────

describe("chain-parser: loopCount clamp (v0.11.27)", () => {
	it("chain-parser: `:N` loopCount clamped to 1..10 (clamp-not-throw)", () => {
		// Clamp-not-throw is deliberate: a throw would make chain-runner fall back
		// to the simple splitter and turn `step:99` into ONE literal step named
		// "step:99" — the R14-C1 silent-corruption class this parser prevents.
		const zero = parseChainDSL("step:0")[0];
		assert.equal(zero?.loopCount, 1, ":0 clamps up to 1 (never silently skip)");

		const five = parseChainDSL("step:5")[0];
		assert.equal(five?.loopCount, 5, "in-range values pass through unchanged");

		const huge = parseChainDSL("step:99")[0];
		assert.equal(huge?.loopCount, 10, ":99 clamps down to 10 (bounded sequential runs)");
	});
});

describe("chain-parser: quoted step names with modifiers (v0.11.27 probe-caught gap)", () => {
	it("parses a quoted inline goal with `:2` + --with-context + positional args", () => {
		const result = parseChainDSL('"polish the output":2 --with-context "final-report.md"');
		assert.deepEqual(result, [
			{
				name: "polish the output",
				loopCount: 2,
				withContext: true,
				args: ["final-report.md"],
			},
		]);
	});

	it("parses a bare quoted goal with modifiers inside parallel()", () => {
		const result = parseChainDSL('parallel("do a", "do b":3) -> finish');
		assert.equal(result[0]?.parallel?.length, 2);
		assert.equal(result[0]?.parallel?.[1]?.loopCount, 3);
		assert.equal(result[1]?.name, "finish");
	});
});
