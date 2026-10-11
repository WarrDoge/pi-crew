/**
 * b13 (perf round 3): retrieval latency regression guard.
 *
 * Baseline context (2026-08-26, machine bom, cwd /home/bom/source/my_pi —
 * 77k rg files, ~57k post-ext-filter): runRetrievalCycle took 5266ms cold /
 * 4278ms warm (shortened-goal variant used by this bench; the full-length
 * real-run goal measured 7055/3335ms — see the erratum in
 * docs/real-test/reports/perf-round3-probe.md) before the single-pass +
 * stopword + discovery-cache fixes.
 * Budgets below are deliberately generous (4x the post-fix expectation) so
 * slower CI machines stay green while a regression to the 3-cycle behavior
 * (which triples the cost) fails loudly.
 */

import * as path from "node:path";
import { performance } from "node:perf_hooks";
import * as url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const { runRetrievalCycle, __test_resetDiscoveredCache } = await import("../src/runtime/task-runner/retrieval-orchestrator.ts");

const GOAL =
	"Smoke-verify pi-crew on this session: run `npm run test:critical` ONCE, cache the output to .crew/cache/, then report the exact pass/fail counts.";
const TASK = `Find the likely source of the issue: ${GOAL}`;

function ms(t0: number): number {
	return Math.round(performance.now() - t0);
}

const cases: Record<string, { wallMs: number; budgetMs: number; pass: boolean; note: string }> = {};

{
	__test_resetDiscoveredCache();
	const t0 = performance.now();
	const r = await runRetrievalCycle(TASK, GOAL, repoRoot);
	const wallMs = ms(t0);
	cases.retrievalColdRepoRoot = {
		wallMs,
		budgetMs: 2000,
		pass: wallMs < 2000 && r.files.length > 0,
		note: "single-pass over the pi-crew repo itself (~5k relevant files); must stay <2s and still suggest files",
	};
}
{
	// Warm: same cwd, DIFFERENT keywords — discovery must come from cache,
	// only scoring re-runs. This is the per-task steady state inside a run.
	//
	// R3-2 (2026-10-11): the previous warm query ("verify package exports
	// typecheck bundle" — 5 abstract tokens) was retired. Under the G23b
	// floor (MIN_SUGGEST_SCORE=0.5) its best repo file scores 0.42 — a single
	// keyword hit, (1/5)*0.6 + 0.3 — TIED with 40+ runtime-state grazers
	// (state/runs/**/03_verify/status.json matching "verify"), so the old
	// pre-G23b PASS was satisfied by exactly the junk suggestions G23b
	// deliberately blocks, with no ordering signal to separate gold from
	// junk in the tie. Measured: NO floor value separates the bands (real
	// 1-hit gold 0.42 ≤ grazer junk 0.45–0.47), so the floor stays and the
	// query moves to the regime real per-task queries live in: module-path
	// vocabulary that multi-hits genuinely relevant paths (G23b's own note:
	// "useful path-only scores reach ~0.64"). This replacement models the
	// session's next task; measured 2026-10-11 it puts the true gold first
	// (test/unit/runtime/task-runner/retrieval-orchestrator.test.ts 0.60,
	// src/runtime/task-runner/retrieval-orchestrator.ts 0.56; 28 files ≥
	// floor). Unit-pinned in retrieval-orchestrator.test.ts ("R3-2: warm
	// cache … non-empty") — see CHANGELOG 0.11.17 and
	// pi-crew-upgrade-research-round3-deep.md §4.2.
	const t0 = performance.now();
	const r = await runRetrievalCycle(
		"Fix the retrieval orchestrator floor in the task runner module, then re-run the retrieval orchestrator test",
		"Adjust the retrieval orchestrator min score floor and keep the task runner test suite green",
		repoRoot,
	);
	const wallMs = ms(t0);
	cases.retrievalWarmCacheHit = {
		wallMs,
		budgetMs: 400,
		pass: wallMs < 400 && r.files.length > 0,
		note: "discovery cache hit (same cwd, new keywords); must stay <400ms",
	};
}

const failures = Object.values(cases).filter((c) => !c.pass).length;
for (const [name, c] of Object.entries(cases)) {
	console.log(`b13 ${name}: ${c.wallMs}ms (budget <${c.budgetMs}ms — ${c.note}) ${c.pass ? "PASS" : "FAIL"}`);
}
console.log(
	JSON.stringify({
		name: "b13.retrieval-latency",
		unit: "ms",
		cases: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, { wallMs: v.wallMs, budgetMs: v.budgetMs, pass: v.pass }])),
		failures,
	}),
);
if (failures > 0) {
	console.log("b13 FAILED");
	process.exitCode = 1;
} else {
	console.log("b13 PASSED");
}
