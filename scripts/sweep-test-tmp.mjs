#!/usr/bin/env node
/**
 * CLI wrapper for the post-suite tmp sweep implemented (and unit-tested) in
 * test-runner.mjs — `node scripts/sweep-test-tmp.mjs [ageMinutes]` (default 30).
 * The implementation lives in the runner so a copied runner stays
 * self-contained (tests copy it into bare fixture dirs).
 */
import { sweepStaleTestTmpdirs } from "./test-runner.mjs";

if (process.argv[1] && process.argv[1].endsWith("sweep-test-tmp.mjs")) {
	const rawAge = process.argv[2] ?? "30";
	const ageMin = Number(rawAge);
	// wave-2b (sweep guard): `Number("0.5h")` → NaN silently swept with a
	// NEGATIVE threshold (Date.now() - NaN = NaN → every compare false → 0
	// removed, or worse, a typo'd "2" vs 2 wiping fresh dirs is fine but a
	// 0/negative age would match EVERYTHING). Reject non-finite and <1 min.
	if (!Number.isFinite(ageMin) || ageMin < 1) {
		console.error(`[tmp-sweep] invalid age minutes: ${JSON.stringify(rawAge)} (must be a number >= 1)`);
		process.exit(2);
	}
	const out = sweepStaleTestTmpdirs({ thresholdMs: Date.now() - ageMin * 60 * 1000 });
	console.log(`[tmp-sweep] removed=${out.removed} skipped=${out.skipped} errors=${out.errors}`);
}
