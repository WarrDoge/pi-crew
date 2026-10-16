/**
 * K6 + K7 (DR-03 round-6, Cluster 7) — truncation budget accounting and
 * surrogate-safe slicing.
 *
 * K6: the composed truncation result (head + marker + joined important
 * lines + tail) must fit `maxChars` + TRUNCATION_MARKER_ALLOWANCE — the
 * marker/separators/important-line overhead is reserved OUT of the head+tail
 * budget instead of stacking unbudgeted on top (~1.15×maxChars pre-fix),
 * while the stage's monotonic-shrink invariant is preserved.
 *
 * K7: head/tail boundaries and the marker insertion seams never split a
 * surrogate pair — astral characters (emoji, CJK extensions) straddling the
 * 75% boundary survive intact.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { TRUNCATION_MARKER_ALLOWANCE, TruncationStage } from "../../../../src/runtime/compaction/compact-stages/truncation-stage.ts";
import { splitWithImportantLines } from "../../../../src/runtime/compaction/important-line-classifier.ts";

/** Fails when `s` contains a lone (unpaired) UTF-16 surrogate code unit. */
function assertNoLoneSurrogates(s: string, label: string): void {
	for (let i = 0; i < s.length; i++) {
		const unit = s.charCodeAt(i);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const partner = s.charCodeAt(i + 1);
			assert.ok(
				partner >= 0xdc00 && partner <= 0xdfff,
				`${label}: lone HIGH surrogate at index ${i} (astral char split by a truncation boundary — K7)`,
			);
			i += 1; // skip the pair partner
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			assert.fail(`${label}: lone LOW surrogate at index ${i} (astral char split by a truncation boundary — K7)`);
		}
	}
}

// --- K6: budget accounting -------------------------------------------------

test("K6: composed result fits maxChars + marker allowance across fixtures (plain, important lines, astral, readIfSmall config)", () => {
	const fixtures: Array<{
		name: string;
		text: string;
		maxChars: number;
		expect?: string[];
		marker?: { verb: "truncated"; headSeparator: string };
	}> = [
		{ name: "plain repeat", text: "x".repeat(5000), maxChars: 1000 },
		{
			name: "with important lines",
			text: "H".repeat(4000) + "\nError: boom at stage 3\n" + "M".repeat(3000) + "\nWarning  BackOff\n" + "T".repeat(4000),
			maxChars: 2048,
			expect: ["Error: boom at stage 3", "Warning  BackOff"],
		},
		{ name: "barely over budget", text: "y".repeat(1017), maxChars: 1000 },
		{
			name: "readIfSmall marker config",
			text: "f".repeat(90_000),
			maxChars: 32768,
			marker: { verb: "truncated", headSeparator: "\n\n" },
		},
		{ name: "astral middle", text: "x".repeat(600) + "😀".repeat(150) + "y".repeat(600), maxChars: 1000 },
		{ name: "astral everywhere", text: "𝕒".repeat(3000), maxChars: 999 },
		{
			name: "astral + important lines",
			text: "😀".repeat(400) + "\nError: astral boom\n" + "😀".repeat(400),
			maxChars: 800,
			expect: ["Error: astral boom"],
		},
	];
	for (const fixture of fixtures) {
		const stage = new TruncationStage(fixture.maxChars, fixture.marker ? { marker: fixture.marker } : {});
		const out = stage.apply(fixture.text);
		assert.ok(
			out.length <= fixture.maxChars + TRUNCATION_MARKER_ALLOWANCE,
			`${fixture.name}: result ${out.length} must be <= maxChars ${fixture.maxChars} + allowance ${TRUNCATION_MARKER_ALLOWANCE} (K6)`,
		);
		assert.ok(out.length <= fixture.text.length, `${fixture.name}: monotonic-shrink invariant must hold`);
		assertNoLoneSurrogates(out, fixture.name);
		for (const needle of fixture.expect ?? []) {
			assert.ok(out.includes(needle), `${fixture.name}: important line "${needle}" must survive the budgeted truncation`);
		}
	}
});

test("K6: monotonic-shrink invariant holds across a sweep just over maxChars", () => {
	for (let over = 1; over <= 60; over++) {
		const value = "y".repeat(2000 + over);
		const stage = new TruncationStage(2000);
		const out = stage.apply(value);
		assert.ok(out.length <= value.length, `over=${over}: result ${out.length} must be <= input ${value.length}`);
		assert.ok(out.length <= 2000 + TRUNCATION_MARKER_ALLOWANCE, `over=${over}: result must stay within the budget`);
	}
});

test("K6: marker wording is unchanged (backward-compat shape)", () => {
	const stage = new TruncationStage(500);
	const out = stage.apply("k".repeat(2000));
	assert.match(out, /\[pi-crew compacted \d+ chars, head\+tail preserved\]/);
	const truncated = new TruncationStage(500, { marker: { verb: "truncated", headSeparator: "\n\n" } });
	const out2 = truncated.apply("k".repeat(2000));
	assert.match(out2, /\[pi-crew truncated \d+ chars, head\+tail preserved\]/);
});

test("K6 primitive: reserveChars shrinks the head+tail budget; default keeps legacy sizing", () => {
	const value = "z".repeat(1000);
	const reserved = splitWithImportantLines(value, 400, { preserveImportant: false, reserveChars: 100 });
	assert.ok(
		reserved.head.length + reserved.tail.length <= 300,
		`head+tail ${reserved.head.length}+${reserved.tail.length} must be <= 400-100 budget`,
	);
	assert.equal(reserved.baseDropped, 700);
	// No reserve → legacy semantics: head+tail consume the full maxChars.
	const legacy = splitWithImportantLines(value, 400, { preserveImportant: false });
	assert.equal(legacy.head.length, 300);
	assert.equal(legacy.tail.length, 100);
	assert.equal(legacy.baseDropped, 600);
});

// --- K7: surrogate-safe boundaries -----------------------------------------

test("K7: astral char straddling the 75% head boundary survives intact (head backs off)", () => {
	// value layout (code units): 59 'a' | 41 '😀' (82 units, 59..140) | 19 'b'.
	// Raw headLen=60 would slice INSIDE emoji #1 (units 59,60); the tail start
	// (160-20=140) would slice INSIDE emoji #41 (units 139,140).
	const value = "a".repeat(59) + "😀".repeat(41) + "b".repeat(19);
	assert.equal(value.length, 160);
	const split = splitWithImportantLines(value, 80, { preserveImportant: false });
	// Head backed off to 59: no lone surrogate, emoji #1 stays whole in the middle.
	assert.equal(split.head, "a".repeat(59));
	// Tail start advanced to 141: emoji #41 stays whole in the middle.
	assert.equal(split.tail, "b".repeat(19));
	assertNoLoneSurrogates(split.head, "head");
	assertNoLoneSurrogates(split.tail, "tail");
	assert.ok(!split.head.includes("😀"));
	assert.ok(!split.tail.includes("😀"));
});

test("K7: astral char straddling the TAIL boundary survives intact (tail start backs off)", () => {
	// Tail region starts inside the astral run: the raw boundary (125-20=105)
	// lands on the LOW surrogate of emoji #3 (units 104,105) whose HIGH
	// partner precedes it — the boundary must advance so the whole pair stays
	// in the dropped middle, and the tail begins with a WHOLE emoji.
	const value = "x".repeat(100) + "😀".repeat(10) + "y".repeat(5);
	assert.equal(value.length, 125);
	const split = splitWithImportantLines(value, 80, { preserveImportant: false });
	// headLen=60 falls inside the 'x' run — no back-off needed.
	assert.equal(split.head, "x".repeat(60));
	// Tail backs off 105 → 106 (start of whole emoji #4): 7 whole emojis + the 'y' run.
	assert.equal(split.tail, "😀".repeat(7) + "y".repeat(5));
	assertNoLoneSurrogates(split.head, "head");
	assertNoLoneSurrogates(split.tail, "tail");
});

test("K7: composed stage output never splits an astral pair at the marker insertion seams", () => {
	// Astral runs on BOTH sides of the dropped middle — the head end and the
	// tail start are exactly the marker insertion seams.
	const value = "x".repeat(600) + "😀".repeat(150) + "y".repeat(600);
	const stage = new TruncationStage(1000);
	const out = stage.apply(value);
	assertNoLoneSurrogates(out, "stage output");
	// Whatever astral chars survived into head/tail are whole emojis.
	const emojiRun = out.match(/\uD83D\uDE00+/g) ?? [];
	for (const run of emojiRun) {
		assert.equal(run.length % 2, 0, "astral chars in the output must be whole surrogate pairs");
	}
	assert.ok(out.length <= 1000 + TRUNCATION_MARKER_ALLOWANCE, "K6 bound holds for the astral fixture too");
});
