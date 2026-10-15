/**
 * Handoff budget: effective-token cap on the dynamic.dependencyContext
 * layer. `renderDependencyOutputContext(context, { budgetTokens })` trims
 * dependencies when the rendered body exceeds the budget — R5-5 (DR-02,
 * 2026-10-15): the trim order now gives failed/needs-attention deps the same
 * +1000 priority the 96KB L4 layer uses (they keep their FULL form longest;
 * completed deps are compacted first, latest-declared first within a
 * bucket), and the compact form preserves the summary tail + important
 * error/failed/exception lines (important-line-classifier) instead of a
 * plain 240-char head slice. Resolution precedence:
 * env PI_CREW_HANDOFF_BUDGET_TOKENS > opts.budgetTokens (runtime config) >
 * default 1800. A resolved budget ≤0 or >1_000_000 is the OFF-switch
 * (untrimmed render).
 *
 * Estimator (R5-7, DR-02): the layer measures tokens with countTokens
 * (utils/token-counter.ts — CJK-aware; Vietnamese diacritics over-estimate
 * via the punctuation path, the safe direction), replacing the chars/4
 * heuristic that under-counted CJK ~4x. The U10 max(heuristic, measured)
 * anchor semantics are unchanged.
 *
 * Env hygiene: the worker harness exports PI_CREW_* vars into this shell
 * (known gotcha) — the budget var is scrubbed/restored around every test so
 * default-value and precedence assertions are honest.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	applyHandoffBudget,
	DEFAULT_HANDOFF_BUDGET_TOKENS,
	type DependencyContextEntry,
	type DependencyOutputContext,
	HANDOFF_BUDGET_CEILING_TOKENS,
	HANDOFF_SUMMARY_HEAD_CHARS,
	renderDependencyOutputContext,
} from "../../../../src/runtime/task-output-context.ts";
import { renderTaskPrompt } from "../../../../src/runtime/task-runner/prompt-builder.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { countTokens } from "../../../../src/utils/token-counter.ts";
import type { WorkflowStep } from "../../../../src/workflows/workflow-config.ts";

const BUDGET_ENV = "PI_CREW_HANDOFF_BUDGET_TOKENS";
const BREAKDOWN_ENV = "PI_CREW_PROMPT_BREAKDOWN";

const savedBudgetEnv = process.env[BUDGET_ENV];
beforeEach(() => {
	delete process.env[BUDGET_ENV];
});
afterEach(() => {
	if (savedBudgetEnv === undefined) delete process.env[BUDGET_ENV];
	else process.env[BUDGET_ENV] = savedBudgetEnv;
});

function dep(id: string, summaryChars: number, extra: Partial<DependencyContextEntry> = {}): DependencyContextEntry {
	return {
		taskId: id,
		role: "executor",
		status: "completed",
		resultSummary: `${id}-`.repeat(Math.ceil(summaryChars / (id.length + 1))).slice(0, summaryChars),
		structuredResults: { key: "value", taskId: id },
		usage: { inputTokens: 100, outputTokens: 200, durationMs: 300 },
		...extra,
	};
}

function context(deps: DependencyContextEntry[], runId?: string): DependencyOutputContext {
	return { dependencies: deps, sharedReads: [], ...(runId ? { runId } : {}) };
}

/** Rendered effective tokens of `text` (same countTokens estimator the
 * layer uses — R5-7). */
function est(text: string): number {
	return countTokens(text);
}

describe("handoff budget — budget enforcement", () => {
	test("fat 4-dep fixture: capped render fits the budget, uncapped does not", () => {
		const ctx = context([dep("dep-1", 8000), dep("dep-2", 8000), dep("dep-3", 8000), dep("dep-4", 8000)], "run-fat");
		const uncapped = renderDependencyOutputContext(ctx, { budgetTokens: 0 });
		const capped = renderDependencyOutputContext(ctx, { budgetTokens: 1800 });
		assert.ok(est(uncapped) > 1800, `uncapped render must exceed the budget (est ${est(uncapped)})`);
		assert.ok(est(capped) <= 1800, `capped render must fit the budget (est ${est(capped)} chars ${capped.length})`);
		assert.ok(capped.includes("[trimmed, 8000 chars total]"), "truncation markers present");
		assert.ok(capped.includes("full output: artifacts/run-fat/results/dep-4.txt"), "pointer line present");
		assert.ok(est(capped) < est(uncapped), "capped est strictly below uncapped est");
	});

	test("long sharedRead bodies are dropped when over budget, short ones kept", () => {
		const ctx: DependencyOutputContext = {
			dependencies: [dep("dep-1", 8000)],
			sharedReads: [
				{ name: "big.md", path: "/abs/shared/big.md", content: "y".repeat(5000) },
				{ name: "small.md", path: "/abs/shared/small.md", content: "short body" },
			],
			runId: "run-shared",
		};
		const out = renderDependencyOutputContext(ctx, { budgetTokens: 600 });
		assert.ok(out.includes("[content trimmed, 5000 chars total"), "big shared read body replaced by marker");
		assert.ok(out.includes("Path: /abs/shared/big.md"), "shared read Path pointer retained");
		assert.ok(out.includes("short body"), "short shared read kept verbatim");
	});
});

describe("handoff budget — declaration order + priority", () => {
	test("declaration order preserved; earlier deps keep full output, later ones trimmed", () => {
		// dep-1 fat, dep-2 fat, dep-3/4 small: budget admits dep-1 full, trims the rest.
		const ctx = context([dep("dep-1", 2500), dep("dep-2", 2500), dep("dep-3", 100), dep("dep-4", 100)], "run-order");
		const out = renderDependencyOutputContext(ctx, { budgetTokens: 1800 });
		const order = ["dep-1", "dep-2", "dep-3", "dep-4"].map((id) => out.indexOf(`## ${id} (executor)`));
		assert.deepEqual(
			[...order].sort((a, b) => a - b),
			order,
			"headers must appear in declaration order",
		);
		assert.ok(
			order.every((i) => i >= 0),
			"all four headers present",
		);
		// priority: dep-1 keeps its FULL summary (tail chunk intact + structured results)
		assert.ok(out.includes("dep-1-".repeat(50).slice(0, 100)), "dep-1 keeps full summary body");
		assert.ok(out.includes("Structured results:"), "dep-1 keeps structuredResults");
		assert.ok(!out.includes("full output: artifacts/run-order/results/dep-1.txt"), "full dep gets no pointer");
		// later deps: trimmed form
		assert.ok(out.includes("[trimmed, 2500 chars total]"), "dep-2 trimmed with marker");
		assert.ok(!out.includes("[trimmed, 100 chars total]"), "short summaries get no truncation marker");
		assert.ok(out.includes("full output: artifacts/run-order/results/dep-2.txt"), "dep-2 pointer");
		assert.ok(out.includes("full output: artifacts/run-order/results/dep-3.txt"), "dep-3 pointer");
		assert.ok(out.includes("full output: artifacts/run-order/results/dep-4.txt"), "dep-4 pointer");
	});
});

describe("handoff budget — pointer path", () => {
	test("pointer built from manifest runId + taskId (context.runId)", () => {
		const ctx = context([dep("dep-9", 4000)], "team_20261003_abcd1234");
		const out = renderDependencyOutputContext(ctx, { budgetTokens: 400 });
		assert.ok(out.includes("full output: artifacts/team_20261003_abcd1234/results/dep-9.txt"), "exact pointer format");
	});

	test("applyHandoffBudget runId param fills a context without runId", () => {
		const trimmed = applyHandoffBudget(context([dep("dep-9", 4000)]), 400, "run-param");
		const out = renderDependencyOutputContext(trimmed, { budgetTokens: 0 });
		assert.ok(out.includes("full output: artifacts/run-param/results/dep-9.txt"), "pointer from runId param");
	});

	test("no runId → compact form omits the pointer (backward-compat)", () => {
		const out = renderDependencyOutputContext(context([dep("dep-9", 4000)]), { budgetTokens: 400 });
		assert.ok(out.includes("[trimmed, 4000 chars total]"), "trim fired");
		assert.ok(!out.includes("full output: artifacts/"), "no pointer without runId");
	});
});

describe("handoff budget — off-switch + default + precedence", () => {
	test("off-switch: ≤0 and huge budgets render untrimmed", () => {
		const ctx = context([dep("dep-1", 8000), dep("dep-2", 8000)], "run-off");
		for (const off of [0, -5, HANDOFF_BUDGET_CEILING_TOKENS + 1, Number.NaN]) {
			const out = renderDependencyOutputContext(ctx, { budgetTokens: off });
			assert.ok(!out.includes("[trimmed,"), `budget ${off} must disable the trim`);
			assert.ok(!out.includes("full output: artifacts/"), `budget ${off} must not emit pointers`);
		}
	});

	test("env '0' wins over an active config budget (env-expressed off)", () => {
		process.env[BUDGET_ENV] = "0";
		const ctx = context([dep("dep-1", 8000)], "run-envoff");
		const out = renderDependencyOutputContext(ctx, { budgetTokens: 1800 });
		assert.ok(!out.includes("[trimmed,"), "env 0 = off-switch, beats config");
	});

	test("default budget is exactly DEFAULT_HANDOFF_BUDGET_TOKENS (1800)", () => {
		assert.equal(DEFAULT_HANDOFF_BUDGET_TOKENS, 1800);
		// R5-7: the layer measures with countTokens, so the trim boundary no
		// longer has a closed-form chars/4 expression — binary-search the largest
		// untrimmed summary length for the "x"-run fixture (countTokens is
		// monotone in n: "x"-runs cost 0.25 token/char) and pin the boundary
		// step (N untrimmed ⇒ N+4 trimmed = +1 token).
		const plain = (n: number): DependencyOutputContext =>
			context([{ taskId: "probe", role: "r", status: "completed", resultSummary: "x".repeat(n) }]);
		let lo = 1;
		let hi = 20_000;
		assert.ok(!renderDependencyOutputContext(plain(lo)).includes("[trimmed,"), "probe invariant: small renders untrimmed");
		while (lo < hi) {
			const mid = Math.ceil((lo + hi + 1) / 2);
			if (renderDependencyOutputContext(plain(mid)).includes("[trimmed,")) hi = mid - 1;
			else lo = mid;
		}
		const fitsN = lo;
		const spillsN = fitsN + 4; // +4 chars = +1 token ("x"-run: 0.25 token/char)
		assert.ok(fitsN > 0, `boundary probe must find a positive boundary (got ${fitsN})`);
		assert.ok(!renderDependencyOutputContext(plain(fitsN)).includes("[trimmed,"), "boundary N must render untrimmed");
		assert.ok(
			renderDependencyOutputContext(plain(spillsN)).includes(`[trimmed, ${spillsN} chars total]`),
			"N+4 must cross the trim boundary",
		);
	});

	test("env override beats config; invalid env falls back to config", () => {
		const ctx = context([dep("dep-1", 5000), dep("dep-2", 5000), dep("dep-3", 100), dep("dep-4", 100)], "run-prec");
		// config 6000 alone would NOT trim (countTokens of the full render is
		// ~5.3k ≤ 6000 — R5-7 raised the measured size vs the old chars/4 2.7k);
		// env 500 forces it.
		process.env[BUDGET_ENV] = "500";
		assert.ok(renderDependencyOutputContext(ctx, { budgetTokens: 6000 }).includes("[trimmed,"), "env beats config");
		// config 300 alone WOULD trim; env 6000 disables it (countTokens of the
		// full render is ~5.3k — 5000 no longer clears it post-R5-7).
		process.env[BUDGET_ENV] = "6000";
		assert.ok(!renderDependencyOutputContext(ctx, { budgetTokens: 300 }).includes("[trimmed,"), "env disables where config would trim");
		// invalid env strings never throw and defer to config (6000 does not
		// trim the ~5.3k-token render on its own).
		for (const bad of ["abc", "12abc", "1e3", ""]) {
			process.env[BUDGET_ENV] = bad;
			assert.ok(
				!renderDependencyOutputContext(ctx, { budgetTokens: 6000 }).includes("[trimmed,"),
				`invalid env '${bad}' defers to config`,
			);
		}
	});
});

describe("handoff budget — purity / L4 composition", () => {
	test("applyHandoffBudget returns the same reference when off or already fitting", () => {
		const ctx = context([dep("dep-1", 100)], "run-pure");
		assert.equal(applyHandoffBudget(ctx, 0), ctx, "off-switch returns input reference");
		assert.equal(applyHandoffBudget(ctx, 1_000_000), ctx, "fitting context returns input reference");
	});

	test("compacts after L4: path-only (empty-summary) deps still render a header + pointer", () => {
		// L4 downgrades low-priority deps to resultSummary:"" — the handoff trim
		// must still render their header/status + pointer (never drop the dep).
		const l4downgraded = dep("dep-l4", 8000, { resultSummary: "", inlineBytes: 0 });
		const out = renderDependencyOutputContext(context([dep("dep-keep", 8000), l4downgraded], "run-l4"), { budgetTokens: 500 });
		assert.ok(out.includes("## dep-l4 (executor)"), "L4-downgraded dep keeps its header");
		assert.ok(out.includes("Status: completed"), "status line kept");
		assert.ok(out.includes("full output: artifacts/run-l4/results/dep-l4.txt"), "pointer still emitted");
	});

	test("summary head+tail budget is capped at HANDOFF_SUMMARY_HEAD_CHARS chars (R5-5)", () => {
		const out = renderDependencyOutputContext(context([dep("dep-1", 10000)], "run-head"), { budgetTokens: 400 });
		const marker = out.indexOf("[trimmed, 10000 chars total]");
		assert.ok(marker > 0, "marker present");
		// R5-5: the compact body is a 75/25 head+tail split (splitWithImportantLines)
		// — head = floor(240*0.75) = 180 chars, tail = 60 chars, each followed by
		// one newline before the marker (no important lines in this "x"-run
		// fixture). Pre-R5-5 this was a plain 240-char head slice.
		const headStart = out.indexOf("\n", out.indexOf("Status: completed")) + 1;
		const headChars = Math.floor(HANDOFF_SUMMARY_HEAD_CHARS * 0.75);
		const tailChars = HANDOFF_SUMMARY_HEAD_CHARS - headChars;
		assert.equal(marker - headStart, headChars + 1 + tailChars + 1, "head(180) + \n + tail(60) + \n before marker");
		// the last 60 chars of the summary (the failed-dep error tail slot) survive
		const summary = "dep-1-".repeat(2000).slice(0, 10000);
		assert.ok(
			out.slice(headStart, marker).replace(/\n$/, "").endsWith(summary.slice(-tailChars)),
			"tail slice present immediately before the marker",
		);
	});
});

describe("handoff budget — U10 measured-token anchor", () => {
	// U10 (spec 2026-10-09): when a dep carries measured usage (message_end
	// usage persisted on TeamTaskState.usage → aggregateUsage → entry.usage),
	// the budget measures EFFECTIVE tokens = max(chars/4 heuristic, Σ measured
	// outputTokens of FULL-form deps). Measured can only TIGHTEN (never
	// loosen); absent usage falls back to the pure heuristic unchanged.

	test("budget-overflow: measured usage > heuristic forces the trim and keeps the render within budget", () => {
		// 1800-char summary renders ≈ 1050 countTokens ≤ 1200 budget (R5-7):
		// the heuristic alone would NOT trim. The worker reports 3000 measured
		// output tokens → effective 3000 > 1200 → the trim MUST fire and the
		// final render must fit the budget by BOTH measures.
		const fatMeasured = dep("dep-m", 1800, { usage: { inputTokens: 900, outputTokens: 3000, durationMs: 1000 } });
		const ctx = context([fatMeasured], "run-u10a");
		const heuristicOnly = renderDependencyOutputContext(context([dep("dep-m", 1800, { usage: undefined })], "run-u10a"), {
			budgetTokens: 1200,
		});
		assert.ok(!heuristicOnly.includes("[trimmed,"), "precondition: without usage the heuristic does not trim");
		const out = renderDependencyOutputContext(ctx, { budgetTokens: 1200 });
		assert.ok(out.includes("[trimmed, 1800 chars total]"), "measured > heuristic must trigger the trim");
		assert.ok(out.includes("full output: artifacts/run-u10a/results/dep-m.txt"), "compact pointer emitted");
		// The pinned acceptance: the budget is NEVER exceeded in the measured
		// direction — after the trim no full-form dep remains, so the effective
		// measure collapses to the (small) heuristic of the compact render.
		assert.ok(countTokens(out) <= 1200, `render est ${countTokens(out)} must fit`);
		assert.ok(countTokens(out) <= 1200, "effective measure (no full-form deps left) fits");
		// ...while the WOULD-BE uncapped render exceeds the budget on the
		// effective measure (max(heuristic, measured) = 3000).
		const uncapped = renderDependencyOutputContext(ctx, { budgetTokens: 0 });
		assert.ok(Math.max(countTokens(uncapped), 3000) > 1200, "uncapped render exceeds budget once measured usage is counted");
	});

	test("before/after token distribution: measured anchor moves the layer under the budget", () => {
		// Three deps, 1500 chars each (full dep ≈ 850 countTokens incl.
		// structuredResults/usage lines; 3-full ≈ 2.6k > 2000, 2-full + 1-compact
		// ≈ 1.8k ≤ 2000). Budget 2000. Baseline (BEFORE, heuristic
		// decision): the trim keeps dep-1+dep-2 full, compacts dep-3
		// — note dep() stamps a default 200-token usage on
		// deps 1 and 3, which stays far below the heuristic and changes nothing.
		// AFTER (measured anchor on dep-2):
		//  - dep-2 reports 1500 → Σ measured (200+1500=1700) ≤ 2000 → SAME
		//    render as before (the anchor never loosens, never over-trims below
		//    the heuristic slack);
		//  - dep-2 reports 1900 → Σ measured (200+1900=2100) > 2000 → the
		//    distribution shifts DOWN one notch (dep-2 also compacted) — the
		//    measured token count, not countTokens alone, now governs.
		const mk = (dep2OutputTokens?: number): DependencyContextEntry[] => [
			dep("dep-1", 1500),
			dep(
				"dep-2",
				1500,
				dep2OutputTokens === undefined
					? { usage: undefined }
					: { usage: { inputTokens: 10, outputTokens: dep2OutputTokens, durationMs: 5 } },
			),
			dep("dep-3", 1500),
		];
		const before = renderDependencyOutputContext(context(mk(), "run-u10b"), { budgetTokens: 2000 });
		const afterWithinSlack = renderDependencyOutputContext(context(mk(1500), "run-u10b"), { budgetTokens: 2000 });
		const afterOver = renderDependencyOutputContext(context(mk(1900), "run-u10b"), { budgetTokens: 2000 });
		// Baseline distribution: dep-1/dep-2 full, dep-3 compacted.
		assert.ok(before.includes("[trimmed, 1500 chars total]"), "baseline trims the last dep (declaration order)");
		assert.ok(!before.includes("full output: artifacts/run-u10b/results/dep-1.txt"), "dep-1 stays full (baseline)");
		assert.ok(!before.includes("full output: artifacts/run-u10b/results/dep-2.txt"), "dep-2 stays full (baseline)");
		// Measured within the heuristic slack: identical TRIM DECISION (the only
		// byte difference is dep-2's own Usage metadata line — strip it and the
		// renders are byte-identical: dep-1/dep-2 full, dep-3 compacted).
		const stripUsage = (s: string): string => s.replace(/^Usage: .*\n\n/gm, "");
		assert.equal(stripUsage(afterWithinSlack), stripUsage(before), "measured ≤ heuristic slack must not change the trim decision");
		// Measured past the slack: the anchor compacts dep-2 as well.
		assert.ok(afterOver.includes("full output: artifacts/run-u10b/results/dep-2.txt"), "Σ measured > budget compacts dep-2");
		assert.ok(afterOver.includes("full output: artifacts/run-u10b/results/dep-3.txt"), "dep-3 stays compacted");
		assert.ok(countTokens(afterOver) <= 2000, `shifted-down render fits (est ${countTokens(afterOver)})`);
		assert.ok(afterOver.length < before.length, "over-slack measured shrinks the injected layer");
	});

	test("fallback: absent usage keeps the pure countTokens heuristic path", () => {
		const noUsage = dep("dep-f", 1800, { usage: undefined });
		const out = renderDependencyOutputContext(context([noUsage], "run-u10c"), { budgetTokens: 1200 });
		assert.ok(!out.includes("[trimmed,"), "no usage → heuristic-only decision (est ~1050 ≤ 1200, untrimmed)");
		const spills = renderDependencyOutputContext(context([dep("dep-f", 5000, { usage: undefined })], "run-u10c"), {
			budgetTokens: 1200,
		});
		assert.ok(spills.includes("[trimmed, 5000 chars total]"), "no usage → heuristic still trims when est spills");
	});

	test("measured smaller than heuristic never loosens the budget (max floor)", () => {
		// est ≈ 2000 > budget 1500, worker reports only 100 output tokens —
		// the render must be trimmed EXACTLY like the heuristic-only case.
		const withSmallUsage = renderDependencyOutputContext(
			context([dep("dep-s", 8000, { usage: { inputTokens: 50, outputTokens: 100, durationMs: 5 } })], "run-u10d"),
			{ budgetTokens: 1500 },
		);
		const heuristicOnly = renderDependencyOutputContext(context([dep("dep-s", 8000, { usage: undefined })], "run-u10d"), {
			budgetTokens: 1500,
		});
		assert.ok(withSmallUsage.includes("[trimmed, 8000 chars total]"), "trim fires despite small measured usage");
		assert.equal(withSmallUsage, heuristicOnly, "max() floor: measured < heuristic cannot admit more content");
	});

	test("compact (budgetTrimmed) deps are not charged measured usage — trim always terminates in a fit", () => {
		// dep-huge has a TINY inline body (200 chars) but reports 500_000
		// measured output tokens; dep-fat is 4000 chars with 3000 measured.
		// Budget 1200: the anchor must compact BOTH (500k > any budget), and the
		// all-compact render must fit — compact deps are never charged.
		const ctx = context(
			[
				dep("dep-huge", 200, { usage: { inputTokens: 1, outputTokens: 500_000, durationMs: 1 } }),
				dep("dep-fat", 4000, { usage: { inputTokens: 900, outputTokens: 3000, durationMs: 1000 } }),
			],
			"run-u10e",
		);
		const out = renderDependencyOutputContext(ctx, { budgetTokens: 1200 });
		assert.ok(out.includes("full output: artifacts/run-u10e/results/dep-huge.txt"), "dep-huge compacted");
		assert.ok(out.includes("[trimmed, 4000 chars total]"), "dep-fat compacted");
		assert.ok(countTokens(out) <= 1200, `all-compact render fits (est ${countTokens(out)})`);
		assert.ok(!out.includes("Structured results:"), "compact form drops structuredResults");
	});
});

describe("handoff budget — R5-5 failed-priority + important-line compact form", () => {
	test("failed deps keep FULL form longer than completed deps (both declaration orders)", () => {
		// Same-shaped deps, budget 1600: ONE full dep fits (~1420) but two do
		// not (~2830). The trim must compact the COMPLETED dep and keep the
		// FAILED dep full — the downstream worker must see the failure — in
		// BOTH declaration orders (failed declared second and first).
		const failedLast = context([dep("dep-done", 3000), dep("dep-fail", 3000, { status: "failed" })], "run-r55a");
		const outLast = renderDependencyOutputContext(failedLast, { budgetTokens: 1600 });
		assert.ok(!outLast.includes("full output: artifacts/run-r55a/results/dep-fail.txt"), "failed dep keeps FULL form (no pointer)");
		assert.ok(outLast.includes("full output: artifacts/run-r55a/results/dep-done.txt"), "completed dep compacted first");
		assert.ok(outLast.includes("dep-fail-".repeat(40).slice(0, 40)), "failed dep keeps its full summary body");
		const failedFirst = context([dep("dep-fail", 3000, { status: "failed" }), dep("dep-done", 3000)], "run-r55b");
		const outFirst = renderDependencyOutputContext(failedFirst, { budgetTokens: 1600 });
		assert.ok(!outFirst.includes("full output: artifacts/run-r55b/results/dep-fail.txt"), "failed dep full even when declared first");
		assert.ok(
			outFirst.includes("full output: artifacts/run-r55b/results/dep-done.txt"),
			"completed dep compacted even when declared last",
		);
	});

	test("needs-attention deps keep FULL form longer too (same +1000 bucket)", () => {
		const ctx = context([dep("dep-done", 3000), dep("dep-need", 3000, { status: "needs-attention" })], "run-r55n");
		const out = renderDependencyOutputContext(ctx, { budgetTokens: 1600 });
		assert.ok(!out.includes("full output: artifacts/run-r55n/results/dep-need.txt"), "needs-attention dep keeps FULL form");
		assert.ok(out.includes("full output: artifacts/run-r55n/results/dep-done.txt"), "completed dep compacted first");
	});

	test("compact form preserves important error lines from ANYWHERE in the summary", () => {
		// The two diagnostic lines sit at chars ~300 and ~660 — far beyond the
		// old 240-char head slice and outside head+tail. R5-5: the compact form
		// runs the summary through splitWithImportantLines so they survive.
		const summary = [
			"x".repeat(300),
			"Error: EACCES permission denied /etc/shadow",
			"y".repeat(300),
			"FATAL: disk full",
			"z".repeat(1000),
		].join("\n");
		const ctx = context([dep("dep-e", 0, { resultSummary: summary, usage: undefined, structuredResults: undefined })], "run-imp");
		const out = renderDependencyOutputContext(ctx, { budgetTokens: 200 });
		assert.ok(out.includes("Error: EACCES permission denied /etc/shadow"), "mid-summary Error line preserved");
		assert.ok(out.includes("FATAL: disk full"), "second important line preserved");
		assert.ok(out.includes("[trimmed, "), "trim marker present");
		assert.ok(out.includes("Status: completed"), "Status line kept");
	});

	test("compact form preserves the summary TAIL (the failed-dep error tail)", () => {
		const summary = `${"a".repeat(1500)}\nfinal error line at the very end: boom\n`;
		const ctx = context([dep("dep-t", 0, { resultSummary: summary, usage: undefined, structuredResults: undefined })], "run-tail");
		const out = renderDependencyOutputContext(ctx, { budgetTokens: 200 });
		assert.ok(out.includes("final error line at the very end: boom"), "the summary's last line survives the compact form");
	});
});

describe("handoff budget — R5-7 countTokens estimator (CJK-aware)", () => {
	test("CJK summaries measure ~1 token/char and trip the budget the chars/4 heuristic missed", () => {
		// '配' (U+914D) is a single BMP char: countTokens charges 1 token (the
		// punctuation path), chars/4 charged 0.25 — a 4x under-count. A 800-char
		// CJK summary is 800 real-ish tokens, NOT 200: budget 300 must compact
		// it (the pre-R5-7 layer would have rendered it full).
		const cjk = "配".repeat(800);
		assert.equal(countTokens(cjk), 800, "countTokens charges 1 token per CJK char");
		const ctx = context([dep("dep-cjk", 0, { resultSummary: cjk, usage: undefined, structuredResults: undefined })], "run-cjk");
		const out = renderDependencyOutputContext(ctx, { budgetTokens: 300 });
		assert.ok(out.includes("[trimmed, 800 chars total]"), "CJK summary compacted under the countTokens measure");
		assert.ok(out.includes("full output: artifacts/run-cjk/results/dep-cjk.txt"), "pointer emitted");
	});
});

describe("handoff budget — integration with prompt breakdown", () => {
	test("sections['dynamic.dependencyContext'] reflects the capped render", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-budget-"));
		const stateRoot = path.join(cwd, ".crew", "state", "runs", "team_handoff_int");
		const manifest = {
			runId: "team_handoff_int",
			schemaVersion: 1,
			status: "running",
			stateRoot,
			tasksPath: path.join(stateRoot, "tasks.json"),
			eventsPath: path.join(stateRoot, "events.jsonl"),
			artifactsRoot: path.join(cwd, ".crew", "artifacts", "team_handoff_int"),
			team: "default",
			workflow: "default",
			goal: "ship the handoff budget",
			cwd,
			workspaceMode: "single",
			createdAt: new Date().toISOString(),
		} as unknown as TeamRunManifest;
		fs.mkdirSync(stateRoot, { recursive: true });
		fs.writeFileSync(manifest.eventsPath, "");
		const step: WorkflowStep = { id: "execute", role: "executor", task: "Do the thing for {goal}" };
		const fatCtx = context([dep("dep-1", 8000), dep("dep-2", 8000), dep("dep-3", 8000), dep("dep-4", 8000)], manifest.runId);
		const cappedText = renderDependencyOutputContext(fatCtx, { budgetTokens: 1800 });
		const uncappedText = renderDependencyOutputContext(fatCtx, { budgetTokens: 0 });
		const task = {
			id: "02_execute",
			role: "executor",
			agent: "executor",
			status: "running",
			dependsOn: ["dep-1", "dep-2", "dep-3", "dep-4"],
			cwd,
			dependencyContextText: cappedText,
		} as unknown as TeamTaskState;
		const savedBreakdown = process.env[BREAKDOWN_ENV];
		process.env[BREAKDOWN_ENV] = "1";
		try {
			const rendered = await renderTaskPrompt(manifest, step, task, undefined, "", undefined, []);
			const layerChars = rendered.sections?.["dynamic.dependencyContext"];
			assert.ok(layerChars !== undefined, "breakdown section present");
			assert.ok(layerChars! > 0, "layer non-empty");
			assert.ok(layerChars! <= 1800 * 4, `layer chars ${layerChars} must be ≤ budget*4 (${1800 * 4})`);
			// the cap actually bound the layer versus the uncapped render
			const uncappedLayer = uncappedText.length + (layerChars! - cappedText.length);
			assert.ok(layerChars! < uncappedLayer, "capped layer smaller than uncapped layer would be");
		} finally {
			if (savedBreakdown === undefined) delete process.env[BREAKDOWN_ENV];
			else process.env[BREAKDOWN_ENV] = savedBreakdown;
		}
	});
});
