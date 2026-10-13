/**
 * PHASE 4 (U13-ADJ, upgrade 2026-10-13): layer-3 determinism rerun tests.
 *
 * Covers:
 *   - resolveVerifyDeterminismEnabled env/explicit precedence (default OFF)
 *   - the pure layer: flaky rerun → INCONCLUSIVE (never FAILED) + note,
 *     rerun executor death → INCONCLUSIVE (soft-degrade), deterministic
 *     rerun confirm → PASS, budget rule (no rerun on FAILED / no critical
 *     pass), rerun target = the most critical check (test-critical)
 *   - the spawn-site wiring (runVerifierGatePreGate): flag ON downgrades a
 *     flaky green gate to INCONCLUSIVE + spawns WITH context; flag OFF is
 *     bit-for-bit pre-U13-ADJ (no third check — pinned via marker counts
 *     and the exact decision/promptContext shapes)
 *   - prompt-bias gap: executor-death context says UNKNOWN (no "ground
 *     truth"), real exit≠0 keeps the original wording bit-for-bit
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { createMetricRegistry } from "../../../../src/observability/metric-registry.ts";
import {
	applyVerifyGateDeterminismLayer,
	evaluateVerifyGateResults,
	renderVerifyGateContext,
	resolveVerifyDeterminismEnabled,
	runVerifierGatePreGate,
	runVerifyGate,
	type VerifyGateCheck,
	type VerifyGateExecutor,
} from "../../../../src/runtime/verification/verify-gate.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

/** Executor stub: scripted exit codes per command substring. */
function scriptedExecutor(
	behavior: Record<string, { exitCode: number | null; output?: string; error?: string }>,
): VerifyGateExecutor & { calls: Array<{ command: string; cwd: string }> } {
	const calls: Array<{ command: string; cwd: string }> = [];
	const exec: VerifyGateExecutor = async (command, opts) => {
		calls.push({ command, cwd: opts.cwd });
		for (const [needle, result] of Object.entries(behavior)) {
			if (command.includes(needle))
				return { exitCode: result.exitCode, output: result.output ?? "", ...(result.error ? { error: result.error } : {}) };
		}
		return { exitCode: 0, output: "" };
	};
	return Object.assign(exec, { calls });
}

/** Deterministic-fresh env for the flag under test (worker shells may leak
 *  ambient PI_CREW_* — knowledge.md env-scoping gotcha). ASYNC-aware: the env
 *  must stay set until the awaited fn resolves — the pre-gate reads the flag
 *  lazily INSIDE the async engine (after the first run), not at call time. */
async function withDeterminismEnvAsync<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
	const saved = process.env.PI_CREW_VERIFY_DETERMINISM;
	if (value === undefined) delete process.env.PI_CREW_VERIFY_DETERMINISM;
	else process.env.PI_CREW_VERIFY_DETERMINISM = value;
	try {
		return await fn();
	} finally {
		if (saved === undefined) delete process.env.PI_CREW_VERIFY_DETERMINISM;
		else process.env.PI_CREW_VERIFY_DETERMINISM = saved;
	}
}

const DEFAULT_CHECKS: VerifyGateCheck[] = [
	{ name: "typecheck", command: "npm run --silent typecheck", critical: true },
	{ name: "test-critical", command: "npm run --silent test:critical", critical: true },
];

/** A flaky check driven through an ALLOWLISTED gate command (`npm run` —
 *  validateGateCommand rejects raw `node <script>`/`node -e`): the npm
 *  script runs a stateful node helper that PASSES the first invocation and
 *  FAILS the second. The marker line count = invocation count. */
function makeFlakyNpmRepo(dir: string): { checks: VerifyGateCheck[]; marker: string } {
	const marker = path.join(dir, "flaky-marker.txt");
	fs.writeFileSync(
		path.join(dir, "flaky-once.mjs"),
		[
			'import { appendFileSync, readFileSync } from "node:fs";',
			"const marker = process.argv[2];",
			"let runs = 0;",
			"try {",
			'\truns = readFileSync(marker, "utf8").split("\\n").filter(Boolean).length;',
			"} catch {}",
			'appendFileSync(marker, (runs + 1) + "\\n");',
			"process.exit(runs === 0 ? 0 : 1);",
			"",
		].join("\n"),
		"utf8",
	);
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({
			name: "flaky-repo",
			scripts: { "test:critical": "node flaky-once.mjs flaky-marker.txt" },
		}),
		"utf8",
	);
	return {
		checks: [{ name: "test-critical", command: "npm run --silent test:critical", critical: true }],
		marker,
	};
}

function markerRuns(marker: string): number {
	try {
		return fs.readFileSync(marker, "utf8").split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

test("resolveVerifyDeterminismEnabled: default OFF, env beats explicit", () => {
	const saved = process.env.PI_CREW_VERIFY_DETERMINISM;
	const withDeterminismEnv = (value: string | undefined, fn: () => void): void => {
		if (value === undefined) delete process.env.PI_CREW_VERIFY_DETERMINISM;
		else process.env.PI_CREW_VERIFY_DETERMINISM = value;
		try {
			fn();
		} finally {
			if (saved === undefined) delete process.env.PI_CREW_VERIFY_DETERMINISM;
			else process.env.PI_CREW_VERIFY_DETERMINISM = saved;
		}
	};
	withDeterminismEnv(undefined, () => {
		assert.equal(resolveVerifyDeterminismEnabled(), false); // default OFF
		assert.equal(resolveVerifyDeterminismEnabled(true), true);
		assert.equal(resolveVerifyDeterminismEnabled(false), false);
	});
	withDeterminismEnv("1", () => {
		assert.equal(resolveVerifyDeterminismEnabled(), true);
		assert.equal(resolveVerifyDeterminismEnabled(false), true); // env beats explicit
	});
	withDeterminismEnv("0", () => {
		assert.equal(resolveVerifyDeterminismEnabled(true), false); // env beats explicit
	});
});

test("layer 3: flaky rerun (run1 PASS, run2 FAIL) → INCONCLUSIVE + note, never FAILED", async () => {
	const firstRun = await runVerifyGate(DEFAULT_CHECKS, scriptedExecutor({}), { cwd: "/tmp" });
	assert.equal(firstRun.verdict, "PASS");
	const rerun = scriptedExecutor({ "test:critical": { exitCode: 1, output: "flake" } });
	const layer = await applyVerifyGateDeterminismLayer(DEFAULT_CHECKS, firstRun, rerun, { cwd: "/tmp" });
	assert.equal(layer.ran, true);
	assert.equal(layer.result, "flaky");
	assert.equal(layer.outcome.verdict, "INCONCLUSIVE"); // NOT FAILED
	assert.equal(layer.note, "deterministic-check: flaky test-critical");
	assert.ok(layer.outcome.evidenceLines.includes(layer.note), "note is an evidence line");
	// The rerun is recorded as its own `determinism:` check for evidence.
	assert.equal(layer.outcome.checks.length, 3);
	assert.equal(layer.outcome.checks[2]?.name, "determinism:test-critical");
	assert.equal(layer.outcome.checks[2]?.passed, false);
	assert.equal(layer.outcome.determinismNote, layer.note);
	// FAILED↔spawn logic untouched: INCONCLUSIVE resolves to a spawn (below).
});

test("layer 3: rerun target = the most critical check (test-critical), not typecheck", async () => {
	const firstRun = await runVerifyGate(DEFAULT_CHECKS, scriptedExecutor({}), { cwd: "/tmp" });
	const rerun = scriptedExecutor({}); // agrees → deterministic
	const layer = await applyVerifyGateDeterminismLayer(DEFAULT_CHECKS, firstRun, rerun, { cwd: "/tmp" });
	assert.equal(rerun.calls.length, 1);
	assert.match(rerun.calls[0]!.command, /test:critical/); // LAST critical, not typecheck
	assert.equal(layer.result, "deterministic");
	assert.equal(layer.outcome.verdict, "PASS"); // agreement keeps the green verdict
	assert.equal(layer.outcome.checks.length, 3);
	assert.equal(layer.outcome.checks[2]?.name, "determinism:test-critical");
	assert.equal(layer.outcome.checks[2]?.passed, true);
	assert.equal(layer.note, "");
});

test("layer 3: rerun executor death (exitCode null) → INCONCLUSIVE soft-degrade, not FAILED", async () => {
	const firstRun = await runVerifyGate(DEFAULT_CHECKS, scriptedExecutor({}), { cwd: "/tmp" });
	const dead = scriptedExecutor({ "test:critical": { exitCode: null, error: "spawn ENOENT" } });
	const layer = await applyVerifyGateDeterminismLayer(DEFAULT_CHECKS, firstRun, dead, { cwd: "/tmp" });
	assert.equal(layer.ran, true);
	assert.equal(layer.result, "rerun_error");
	assert.equal(layer.outcome.verdict, "INCONCLUSIVE"); // NOT FAILED
	assert.equal(layer.note, "deterministic-check: rerun executor error (test-critical)");
	// Rejecting executor (contract violation) must degrade the same way.
	const throwing: VerifyGateExecutor = async () => {
		throw new Error("boom");
	};
	const layer2 = await applyVerifyGateDeterminismLayer(DEFAULT_CHECKS, firstRun, throwing, { cwd: "/tmp" });
	assert.equal(layer2.outcome.verdict, "INCONCLUSIVE");
	assert.equal(layer2.result, "rerun_error");
});

test("layer 3 budget rule: NO rerun when the default checks already FAILED", async () => {
	const firstRun = await runVerifyGate(DEFAULT_CHECKS, scriptedExecutor({ typecheck: { exitCode: 2 } }), { cwd: "/tmp" });
	assert.equal(firstRun.verdict, "FAILED");
	const rerun = scriptedExecutor({});
	const layer = await applyVerifyGateDeterminismLayer(DEFAULT_CHECKS, firstRun, rerun, { cwd: "/tmp" });
	assert.equal(layer.ran, false);
	assert.equal(layer.result, "verdict_failed");
	assert.equal(layer.outcome, firstRun, "outcome passed through unchanged");
	assert.equal(rerun.calls.length, 0, "no pointless rerun");
});

test("layer 3 budget rule: NO rerun when no critical check passed", async () => {
	const nonCritical: VerifyGateCheck[] = [{ name: "grep-evidence", command: "grep -c marker dist", critical: false }];
	const firstRun = await runVerifyGate(nonCritical, scriptedExecutor({}), { cwd: "/tmp" });
	assert.equal(firstRun.verdict, "PASS");
	const rerun = scriptedExecutor({});
	const layer = await applyVerifyGateDeterminismLayer(nonCritical, firstRun, rerun, { cwd: "/tmp" });
	assert.equal(layer.ran, false);
	assert.equal(layer.result, "no_critical_pass");
	assert.equal(rerun.calls.length, 0);
});

test("wiring: flag ON + flaky critical check → INCONCLUSIVE + spawn with determinism context", async () => {
	const dir = createTrackedTempDir("pi-crew-u13adj-on-");
	const { checks, marker } = makeFlakyNpmRepo(dir);
	const registry = createMetricRegistry();
	const result = await withDeterminismEnvAsync("1", () =>
		runVerifierGatePreGate({
			cwd: dir,
			checks,
			metricRegistry: registry,
		}),
	);
	// The critical check ran TWICE (default run + layer-3 rerun).
	assert.equal(markerRuns(marker), 2, "check executed exactly twice (layer 3 reran it)");
	assert.equal(result.outcome.verdict, "INCONCLUSIVE");
	assert.ok(result.outcome.evidenceLines.includes("deterministic-check: flaky test-critical"));
	// Spawn decision unchanged in KIND: a flaky gate may NOT skip the verifier.
	assert.equal(result.decision.skipVerifier, false);
	assert.equal(result.decision.reason, "inconclusive_no_classifier");
	// The context render states the nondeterminism explicitly (no "ground truth").
	assert.match(result.promptContext, /NONDETERMINISM/);
	assert.match(result.promptContext, /deterministic-check: flaky test-critical/);
	assert.ok(!result.promptContext.includes("ground truth"), "flaky context must not assert ground truth");
	const metric = registry.snapshot().find((m) => m.name === "crew.verification.verify_gate_determinism_runs_total");
	assert.ok(metric, "determinism metric exists");
});

test("wiring: flag OFF → bit-for-bit pre-U13-ADJ (no third check, same decision/context)", async () => {
	// (a) Green gate: identical decision + no rerun (marker proves 1 invocation).
	const dir = createTrackedTempDir("pi-crew-u13adj-off-");
	const { checks, marker } = makeFlakyNpmRepo(dir);
	const result = await withDeterminismEnvAsync(undefined, () => runVerifierGatePreGate({ cwd: dir, checks }));
	assert.equal(markerRuns(marker), 1, "flag OFF ⇒ exactly one invocation (no layer-3 rerun)");
	assert.equal(result.outcome.checks.length, 1, "no determinism check appended");
	assert.deepEqual(result.decision, { skipVerifier: true, reason: "deterministic_pass", attachGateContext: false });
	assert.equal(result.promptContext, "");
	assert.equal(result.outcome.determinismNote, undefined);

	// (b) Real exit≠0 failure: bit-for-bit OLD context wording (ground truth).
	// `false` is allowlisted by validateGateCommand — a REAL exit 1 (not an
	// executor-death exit=err), which must keep the original trailer.
	const dir2 = createTrackedTempDir("pi-crew-u13adj-off2-");
	const failed = await withDeterminismEnvAsync(undefined, () =>
		runVerifierGatePreGate({
			cwd: dir2,
			checks: [{ name: "test-critical", command: "false", critical: true }],
		}),
	);
	assert.equal(failed.outcome.verdict, "FAILED");
	assert.equal(failed.outcome.checks[0]?.exitCode, 1, "real exit code (not executor death)");
	assert.deepEqual(failed.decision, { skipVerifier: false, reason: "deterministic_failed", attachGateContext: true });
	assert.equal(failed.promptContext, renderVerifyGateContext(failed.outcome));
	assert.match(
		failed.promptContext,
		/The deterministic gate already ran these commands — do NOT re-run them; verify the WORK \(diff, files, acceptance\), using these results as ground truth for build\/test state\./,
	);
	assert.ok(!failed.outcome.evidenceLines.some((l) => l.includes("deterministic-check")), "no determinism notes flag-off");
});

test("wiring: flag ON but default checks FAILED → layer skipped, verdict stays FAILED", async () => {
	const dir = createTrackedTempDir("pi-crew-u13adj-budget-");
	const result = await withDeterminismEnvAsync("1", () =>
		runVerifierGatePreGate({
			cwd: dir,
			checks: [
				{ name: "typecheck", command: "false", critical: true },
				{ name: "test-critical", command: "true", critical: true },
			],
		}),
	);
	assert.equal(result.outcome.verdict, "FAILED"); // budget rule: no rerun, no downgrade
	assert.equal(result.outcome.checks[0]?.exitCode, 1, "real exit (not executor death)");
	assert.equal(result.outcome.checks.length, 1, "gate stopped on critical failure; no determinism check");
	assert.ok(!result.outcome.evidenceLines.some((l) => l.includes("deterministic-check")));
	assert.equal(result.decision.skipVerifier, false);
	assert.equal(result.decision.reason, "deterministic_failed");
});

test("prompt-bias gap: executor-death context says UNKNOWN — no ground-truth assertion", async () => {
	// Executor death = exitCode null (spawn/timer error) — NOT a real exit≠0.
	const dead: VerifyGateExecutor = async () => {
		throw new Error("spawn failed");
	};
	const outcome = await runVerifyGate([{ name: "typecheck", command: "npm run typecheck", critical: true }], dead, {
		cwd: "/tmp",
	});
	assert.equal(outcome.verdict, "FAILED"); // layer-1 semantics unchanged
	assert.equal(outcome.checks[0]?.exitCode, null);
	const block = renderVerifyGateContext(outcome);
	assert.match(block, /exit=err/);
	assert.match(block, /could not run \(executor error/);
	assert.match(block, /UNKNOWN/);
	assert.ok(!block.includes("ground truth"), "executor death must not be framed as ground truth");
	// Sanity via the pure evaluator too (skipped checks never count as death).
	const manual = renderVerifyGateContext(
		evaluateVerifyGateResults([{ name: "x", command: "c", exitCode: null, passed: false, durationMs: 0, outputTail: "" }]),
	);
	assert.match(manual, /UNKNOWN/);
	assert.ok(!manual.includes("ground truth"));
});

test("prompt-bias gap: real exit≠0 KEEPS the original ground-truth wording", () => {
	const block = renderVerifyGateContext(
		evaluateVerifyGateResults([{ name: "typecheck", command: "c", exitCode: 1, passed: false, durationMs: 0, outputTail: "err" }]),
	);
	assert.match(block, /ground truth for build\/test state/);
	assert.ok(!block.includes("UNKNOWN"));
});
