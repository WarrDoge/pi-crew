/**
 * U13 (upgrade spec 2026-10-09 §U13): DETERMINISTIC VERIFIER PRE-GATE ENGINE.
 *
 * The spec's probe (round 10, 13/13 checks) proved extension tools can run
 * other tools deterministically in the host process via
 * `ctx.executeTool("bash", ...)` — the 5th parameter of ToolDefinition.execute
 * (nested id `<parent>/1`, errors arrive as isError VALUES not throws,
 * `exit_code` readable in structuredContent; limits 256 nested calls / 8KB
 * per call / 32KB total args). That unlocks running the verifier's
 * deterministic checks (typecheck / test:critical / grep evidence lines) for
 * FREE before deciding whether the expensive LLM verifier worker must spawn.
 *
 * TWO ENTRY POINTS share this pure engine:
 *   1. the `verify_gate` TOOL (src/extension/registration/verify-gate-tool.ts)
 *      — runs checks via ctx.executeTool("bash", ...) in the host process,
 *      exposure "codemode" (hidden from the model, callable by other tools);
 *   2. the verifier SPAWN SITE (task-runner.ts runTeamTask) — runs the same
 *      engine through the hardened subprocess runner already exported by
 *      verification-gates.ts (executeCommand: command validation, sanitized
 *      env, process-group kill, output cap, timeout).
 *
 * TWO-LAYER DECISION (spec: "kết hợp classifier pre-gate U6-B — deterministic
 * trước, classifier sau"):
 *   - Layer 1 (deterministic, this module): gate PASS → SKIP the LLM verifier
 *     (U13 acceptance: "một run verification với gate xanh không spawn LLM
 *     verifier"); gate FAILED → spawn the LLM verifier WITH the gate results
 *     in its prompt (it must diagnose/report, not re-derive exit codes).
 *   - Layer 2 (classifier, U6B classifier-pre-gate.ts): consulted ONLY when
 *     layer 1 is INCONCLUSIVE (no checks resolved — e.g. a repo without
 *     typecheck/test:critical scripts). A decisively-high classifier score
 *     over the STRUCTURED verdict state may block the spawn; every other
 *     outcome escalates. A FAILED gate never reaches the classifier — a cheap
 *     classifier may never rubber-stamp a failure (U6B escalation policy),
 *     so consulting it there would only burn a call.
 *   - Layer 3 (PHASE 4, U13-ADJ determinism, DEFAULT OFF): when
 *     PI_CREW_VERIFY_DETERMINISM=1 and the default checks are all green, the
 *     most critical check (test-critical in the default preset) is RERUN
 *     once; a disagreement (flaky) or a rerun executor failure downgrades
 *     the verdict to INCONCLUSIVE — never FAILED, never a task failure. It
 *     never changes the FAILED↔spawn logic; flag off keeps the gate
 *     bit-for-bit identical to pre-U13-ADJ.
 *
 * SAFETY: a gate that cannot run (disabled by env, no checks resolved,
 * executor failure) degrades to "spawn the LLM verifier as today" — the
 * pre-gate can only SAVE a spawn on positive deterministic evidence, never
 * fail a task on its own.
 *
 * Metrics (spec acceptance: "metrics số verifier job tiết kiệm"):
 *   - crew.verification.verify_gate_runs_total{verdict} — gate executions;
 *   - crew.verification.verifier_spawns_skipped_total{reason} — LLM verifier
 *     spawns saved (the "tiết kiệm" counter);
 *   - crew.verification.verifier_spawns_total{reason} — spawns that still
 *     happened, labeled by which layer let them through.
 */
import * as fs from "node:fs";
import { getCrewEnvBool, getCrewEnvInt } from "../../config/env-vars.ts";
import type { MetricRegistry } from "../../observability/metric-registry.ts";
import type { VerifierPreGateResult } from "./classifier-pre-gate.ts";
import { classifyVerifierPreGate } from "./classifier-pre-gate.ts";
import { executeCommand } from "./verification-gates.ts";

/** One deterministic check to run. Mirrors the phase-gate shape
 *  (verification-gates.ts) but kept local so the tool schema can reuse it. */
export interface VerifyGateCheck {
	/** Short check name (metrics/events/evidence lines). */
	name: string;
	/** Shell command; exit code 0 = pass. */
	command: string;
	/** Stop the gate on the first failure of this check (default true). */
	critical?: boolean;
}

/** Result of one executed check. */
export interface VerifyGateCheckResult {
	name: string;
	command: string;
	exitCode: number | null;
	passed: boolean;
	durationMs: number;
	/** Tail of the command output (bounded) — evidence for humans/LLM. */
	outputTail: string;
	skipped?: boolean;
	error?: string;
}

/** Overall gate verdict. */
export type VerifyGateVerdict = "PASS" | "FAILED" | "INCONCLUSIVE";

export interface VerifyGateOutcome {
	verdict: VerifyGateVerdict;
	checks: VerifyGateCheckResult[];
	/** Compact structured evidence lines (exit codes + commands). */
	evidenceLines: string[];
	allPassed: boolean;
	totalDurationMs: number;
	/** PHASE 4 (U13-ADJ): set ONLY by the layer-3 determinism rerun when it
	 *  detected flakiness or a rerun executor failure — the note is also
	 *  appended to evidenceLines and shapes the rendered context trailer. */
	determinismNote?: string;
}

/** Injected command executor. The TOOL path wraps ctx.executeTool("bash");
 *  the spawn-site path wraps verification-gates executeCommand (subprocess).
 *  Must resolve (never reject) — failures come back as exitCode null/error. */
export type VerifyGateExecutor = (command: string, opts: VerifyGateExecutorOpts) => Promise<VerifyGateExecutorResult>;

export interface VerifyGateExecutorOpts {
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface VerifyGateExecutorResult {
	exitCode: number | null;
	output: string;
	error?: string;
}

/** Default per-check timeout — mirrors runPhaseGates (verification-gates.ts). */
export const DEFAULT_VERIFY_GATE_TIMEOUT_MS = 120_000;
/** Evidence tail budget per check (chars). */
const OUTPUT_TAIL_MAX_CHARS = 2_000;

/** U13 gate enable resolution: PI_CREW_VERIFY_GATE beats default ON. */
export function resolveVerifyGateEnabled(explicit?: boolean): boolean {
	const env = getCrewEnvBool("PI_CREW_VERIFY_GATE");
	if (env !== undefined) return env;
	return explicit ?? true;
}

/** U13 per-check timeout resolution: PI_CREW_VERIFY_GATE_TIMEOUT_MS beats
 *  default 120000 (mirrors runPhaseGates). Invalid/≤0 → default. */
export function resolveVerifyGateTimeoutMs(explicit?: number): number {
	const env = getCrewEnvInt("PI_CREW_VERIFY_GATE_TIMEOUT_MS");
	const raw = env ?? explicit ?? DEFAULT_VERIFY_GATE_TIMEOUT_MS;
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_VERIFY_GATE_TIMEOUT_MS;
}

/** PHASE 4 (U13-ADJ, upgrade 2026-10-13) layer-3 toggle:
 *  PI_CREW_VERIFY_DETERMINISM beats the explicit arg; default OFF (unset →
 *  explicit ?? false). Flag off ⇒ the gate runs exactly as pre-U13-ADJ
 *  (no third check, no rerun, no verdict downgrade — bit-for-bit). */
export function resolveVerifyDeterminismEnabled(explicit?: boolean): boolean {
	const env = getCrewEnvBool("PI_CREW_VERIFY_DETERMINISM");
	if (env !== undefined) return env;
	return explicit ?? false;
}

/**
 * Default check preset — the spec's "check cấu hình" set, resolved from the
 * target repo's package.json scripts so the gate adapts instead of failing:
 *   - `typecheck` script present → `npm run --silent typecheck` (critical);
 *   - `test:critical` script present → `npm run --silent test:critical`
 *     (critical);
 *   - grep evidence lines: no universal marker exists, so they are provided
 *     explicitly via the tool's `checks` param (e.g. the bundle-marker rule
 *     `grep -c "<marker>" dist/index.mjs`) rather than defaulted.
 * Repos without either script resolve ZERO checks → INCONCLUSIVE → the
 * classifier layer (when enabled) or the LLM verifier spawn runs as today.
 */
export function defaultVerifyGateChecks(dir: string): VerifyGateCheck[] {
	let scripts: Record<string, unknown> = {};
	try {
		const raw = fs.readFileSync(`${dir}/package.json`, "utf8");
		const parsed = raw ? (JSON.parse(raw) as { scripts?: Record<string, unknown> }) : undefined;
		scripts = parsed?.scripts ?? {};
	} catch {
		scripts = {};
	}
	const checks: VerifyGateCheck[] = [];
	if (typeof scripts.typecheck === "string") {
		checks.push({ name: "typecheck", command: "npm run --silent typecheck", critical: true });
	}
	if (typeof scripts["test:critical"] === "string") {
		checks.push({ name: "test-critical", command: "npm run --silent test:critical", critical: true });
	}
	return checks;
}

function tailOutput(output: string): string {
	if (output.length <= OUTPUT_TAIL_MAX_CHARS) return output;
	return `…${output.slice(-OUTPUT_TAIL_MAX_CHARS)}`;
}

/** Cap the number of evidence lines (prompt/metric hygiene). */
const EVIDENCE_MAX_LINES = 12;

export function evaluateVerifyGateResults(checks: VerifyGateCheckResult[]): VerifyGateOutcome {
	const ran = checks.filter((c) => !c.skipped);
	const allPassed = ran.length > 0 && ran.every((c) => c.passed);
	const verdict: VerifyGateVerdict = ran.length === 0 ? "INCONCLUSIVE" : allPassed ? "PASS" : "FAILED";
	const evidenceLines = checks
		.slice(0, EVIDENCE_MAX_LINES)
		.map((c) =>
			c.skipped
				? `${c.name}: SKIPPED — ${c.command}`
				: `${c.name}: exit=${c.exitCode ?? "err"} ${c.passed ? "PASS" : "FAIL"} — ${c.command}${c.error ? ` (error: ${c.error})` : ""}`,
		);
	return {
		verdict,
		checks,
		evidenceLines,
		allPassed,
		totalDurationMs: checks.reduce((sum, c) => sum + c.durationMs, 0),
	};
}

/** Run the gate checks sequentially through the injected executor.
 *  Mirrors runPhaseGates semantics: stop on first critical failure; abort
 *  signal between checks marks the rest skipped. NEVER rejects. */
export async function runVerifyGate(
	checks: VerifyGateCheck[],
	exec: VerifyGateExecutor,
	opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<VerifyGateOutcome> {
	const timeoutMs = resolveVerifyGateTimeoutMs(opts.timeoutMs);
	const results: VerifyGateCheckResult[] = [];
	for (const check of checks) {
		if (opts.signal?.aborted) {
			results.push({
				name: check.name,
				command: check.command,
				exitCode: null,
				passed: false,
				durationMs: 0,
				outputTail: "",
				skipped: true,
				error: "Aborted",
			});
			continue;
		}
		const start = Date.now();
		let execResult: VerifyGateExecutorResult;
		try {
			execResult = await exec(check.command, { cwd: opts.cwd, timeoutMs, signal: opts.signal });
		} catch (error) {
			// Executor contract says never-reject; defend anyway — an executor
			// blowup must degrade the CHECK, not the host.
			execResult = { exitCode: null, output: "", error: error instanceof Error ? error.message : String(error) };
		}
		results.push({
			name: check.name,
			command: check.command,
			exitCode: execResult.exitCode,
			passed: execResult.exitCode === 0,
			durationMs: Date.now() - start,
			outputTail: tailOutput(execResult.output ?? ""),
			...(execResult.error ? { error: execResult.error } : {}),
		});
		// Stop on critical failure (default critical) — mirrors runPhaseGates.
		if (execResult.exitCode !== 0 && check.critical !== false) break;
	}
	return evaluateVerifyGateResults(results);
}

/** Spawn-site executor: the hardened subprocess runner the verifier flow
 *  already uses (validateGateCommand + sanitized env + group kill + caps). */
export function createSubprocessVerifyGateExecutor(): VerifyGateExecutor {
	return async (command, opts) => {
		if (opts.signal?.aborted) return { exitCode: null, output: "", error: "Aborted" };
		const { exitCode, output } = await executeCommand(command, opts.cwd, opts.timeoutMs);
		return { exitCode, output };
	};
}

/** PHASE 4 (U13-ADJ) layer-3 result — one entry per pre-gate execution. */
export interface DeterminismLayerResult {
	/** false → the layer did not run (budget rule / no eligible target). */
	ran: boolean;
	/** Metric label: "deterministic" | "flaky" | "rerun_error" when ran;
	 *  the skip reason ("verdict_failed" | "verdict_inconclusive" |
	 *  "no_critical_pass") otherwise. */
	result: string;
	/** The gate outcome AFTER the layer (the layer-1 outcome when !ran). */
	outcome: VerifyGateOutcome;
	/** Non-empty iff the rerun disagreed (flaky) or its executor failed. */
	note: string;
}

/** Pick the layer-3 rerun target: the MOST critical check — the LAST check
 *  with critical !== false that ran and PASSED (default preset order puts
 *  test-critical last: tests are the strongest determinism signal). Checks
 *  that failed are never rerun (pointless — a failure already escalates). */
function pickDeterminismRerunTarget(
	checks: VerifyGateCheck[],
	results: VerifyGateCheckResult[],
): { check: VerifyGateCheck; result: VerifyGateCheckResult } | undefined {
	let target: { check: VerifyGateCheck; result: VerifyGateCheckResult } | undefined;
	for (let i = 0; i < checks.length; i++) {
		const check = checks[i];
		const result = results[i];
		if (!check || !result || result.skipped || !result.passed) continue;
		if (check.critical === false) continue; // critical undefined = critical
		target = { check, result };
	}
	return target;
}

/** PHASE 4 (U13-ADJ) layer 3 — the determinism rerun. Runs ONLY when the
 *  layer-1 verdict is PASS (budget rule: never rerun an already-FAILED gate)
 *  AND at least one critical check passed. Semantics:
 *  - rerun exit 0 (agrees with run 1) → verdict stays PASS, the rerun is
 *    recorded as a passing `determinism:<name>` check for evidence;
 *  - rerun exit ≠ 0 (DISAGREES — flaky) → verdict INCONCLUSIVE (never
 *    FAILED) + note "deterministic-check: flaky <name>";
 *  - rerun executor failure (exitCode null) → INCONCLUSIVE (soft-degrade,
 *    never FAILED) + note "deterministic-check: rerun executor error".
 *  The layer can ONLY downgrade its own rerun check to INCONCLUSIVE — it
 *  never changes the FAILED↔spawn decision logic. NEVER rejects. */
export async function applyVerifyGateDeterminismLayer(
	checks: VerifyGateCheck[],
	outcome: VerifyGateOutcome,
	exec: VerifyGateExecutor,
	opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<DeterminismLayerResult> {
	// Budget rule: no pointless rerun when the gate already failed / resolved
	// nothing — layer 3 only re-tests a GREEN gate for hidden nondeterminism.
	if (outcome.verdict !== "PASS") {
		return { ran: false, result: `verdict_${outcome.verdict.toLowerCase()}`, outcome, note: "" };
	}
	const target = pickDeterminismRerunTarget(checks, outcome.checks);
	if (!target) {
		return { ran: false, result: "no_critical_pass", outcome, note: "" };
	}
	const timeoutMs = resolveVerifyGateTimeoutMs(opts.timeoutMs);
	const start = Date.now();
	let rerun: VerifyGateExecutorResult;
	try {
		rerun = await exec(target.check.command, { cwd: opts.cwd, timeoutMs, signal: opts.signal });
	} catch (error) {
		// Executor contract says never-reject; defend anyway (soft-degrade).
		rerun = { exitCode: null, output: "", error: error instanceof Error ? error.message : String(error) };
	}
	const rerunCheck: VerifyGateCheckResult = {
		name: `determinism:${target.check.name}`,
		command: target.check.command,
		exitCode: rerun.exitCode,
		passed: rerun.exitCode === 0,
		durationMs: Date.now() - start,
		outputTail: tailOutput(rerun.output ?? ""),
		...(rerun.error ? { error: rerun.error } : {}),
	};
	const base = evaluateVerifyGateResults([...outcome.checks, rerunCheck]);
	if (rerun.exitCode === 0) {
		return { ran: true, result: "deterministic", outcome: base, note: "" };
	}
	const note =
		rerun.exitCode === null
			? `deterministic-check: rerun executor error (${target.check.name})`
			: `deterministic-check: flaky ${target.check.name}`;
	return {
		ran: true,
		result: rerun.exitCode === null ? "rerun_error" : "flaky",
		// The rerun check's failure would otherwise read as gate FAILED — the
		// ONLY thing layer 3 may do is downgrade ITS OWN rerun to INCONCLUSIVE.
		outcome: {
			...base,
			verdict: "INCONCLUSIVE",
			evidenceLines: [...base.evidenceLines, note],
			determinismNote: note,
		},
		note,
	};
}

export interface VerifierSpawnDecision {
	/** true → do NOT spawn the LLM verifier; the gate verdict stands. */
	skipVerifier: boolean;
	/** Which layer + branch decided (metric label). */
	reason: string;
	/** true → append the gate outcome block to the verifier's prompt. */
	attachGateContext: boolean;
}

/** TWO-LAYER decision (deterministic first, classifier second). */
export function resolveVerifierSpawnDecision(outcome: VerifyGateOutcome, preGate?: VerifierPreGateResult): VerifierSpawnDecision {
	if (outcome.verdict === "PASS") {
		return { skipVerifier: true, reason: "deterministic_pass", attachGateContext: false };
	}
	if (outcome.verdict === "FAILED") {
		// The LLM verifier gets the failing evidence in its prompt — it must
		// diagnose/report the failure, not re-derive exit codes.
		return { skipVerifier: false, reason: "deterministic_failed", attachGateContext: true };
	}
	// INCONCLUSIVE: classifier layer (U6B) may block on a decisively good
	// structured state; disabled/soft-fail/low-confidence all escalate.
	if (preGate?.blockVerifier) {
		return { skipVerifier: true, reason: "classifier_blocked", attachGateContext: false };
	}
	return {
		skipVerifier: false,
		reason: preGate ? `classifier_${preGate.action}` : "inconclusive_no_classifier",
		attachGateContext: false,
	};
}

/** Render the gate outcome as a compact prompt block for the LLM verifier. */
export function renderVerifyGateContext(outcome: VerifyGateOutcome): string {
	const lines = [
		"## Deterministic verify_gate results (U13 pre-gate)",
		`Gate verdict: ${outcome.verdict}`,
		...outcome.evidenceLines.map((line) => `- ${line}`),
	];
	for (const check of outcome.checks) {
		if (!check.skipped && !check.passed && check.outputTail.trim().length > 0) {
			const tail = check.outputTail.trim().split("\n").slice(-5).join("\n");
			lines.push(`### ${check.name} output tail`, "```", tail, "```");
		}
	}
	// PHASE 4 gap 2 (U13-ADJ): distinguish "executor died" (exit=err — spawn /
	// timer failure, NO exit code) from a real exit≠0. An executor death is
	// NOT evidence the build is broken — asserting it as ground truth would
	// bias the LLM verifier against a possibly-fine build. Real exit≠0 keeps
	// the original wording bit-for-bit; a flaky rerun (layer 3) gets its own
	// trailer because "do NOT re-run / ground truth" would be provably wrong.
	const executorDeath = outcome.checks.some((c) => !c.skipped && c.exitCode === null);
	const trailer = executorDeath
		? "A verification command could not run (executor error — exit=err). Treat the build/test state as UNKNOWN; run the build/tests yourself before concluding."
		: outcome.determinismNote
			? "The gate rerun detected NONDETERMINISM (a check passed once and failed on rerun). These gate results are NOT reliable — re-run the affected command yourself and treat the build/test state as UNKNOWN."
			: "The deterministic gate already ran these commands — do NOT re-run them; verify the WORK (diff, files, acceptance), using these results as ground truth for build/test state.";
	lines.push("", trailer);
	return lines.join("\n");
}

/** Human/one-line summary used for the skip path's synthetic result artifact. */
export function renderVerifyGateSummary(outcome: VerifyGateOutcome, reason: string): string {
	return [`verify_gate: ${outcome.verdict} (skip reason: ${reason})`, ...outcome.evidenceLines].join("\n");
}

export interface VerifierGatePreGateInput {
	cwd: string;
	/** Explicit checks override the default preset (tool path / tests). */
	checks?: VerifyGateCheck[];
	signal?: AbortSignal;
	timeoutMs?: number;
	/** U6B classifier layer args — consulted ONLY on INCONCLUSIVE. */
	classifier?: {
		enabled: boolean;
		modelRegistry: unknown;
		classifierModel: string;
		eventsPath: string;
		runId: string;
		taskId?: string;
	};
	metricRegistry?: MetricRegistry;
	/** PHASE 4 (U13-ADJ): explicit layer-3 determinism toggle — env
	 *  PI_CREW_VERIFY_DETERMINISM beats this; both default OFF. */
	determinism?: boolean;
}

export interface VerifierGatePreGateResult {
	outcome: VerifyGateOutcome;
	decision: VerifierSpawnDecision;
	preGate?: VerifierPreGateResult;
	/** Prompt block to append when the verifier still spawns ("" otherwise). */
	promptContext: string;
}

function incMetric(registry: MetricRegistry | undefined, name: string, help: string, labels: Record<string, string>): void {
	try {
		registry?.counter(name, help).inc(labels);
	} catch {
		/* metrics are best-effort; never break the gate */
	}
}

/**
 * Spawn-site orchestration: run the deterministic gate, optionally the U13-ADJ
 * layer-3 determinism rerun (flag-gated, default OFF), consult the U6B
 * classifier layer when inconclusive, resolve the two-layer spawn decision,
 * and emit the acceptance metrics. NEVER rejects — executor failures degrade
 * to INCONCLUSIVE checks, which escalate to the LLM verifier.
 */
export async function runVerifierGatePreGate(input: VerifierGatePreGateInput): Promise<VerifierGatePreGateResult> {
	const checks = input.checks ?? defaultVerifyGateChecks(input.cwd);
	const exec = createSubprocessVerifyGateExecutor();
	let outcome = await runVerifyGate(checks, exec, {
		cwd: input.cwd,
		signal: input.signal,
		timeoutMs: input.timeoutMs,
	});
	// ── PHASE 4 (U13-ADJ) layer 3: determinism rerun (DEFAULT OFF) ──────────
	// Only re-tests a GREEN gate: a flaky critical check or a rerun executor
	// failure downgrades PASS→INCONCLUSIVE (never FAILED), so a nondeterministic
	// green gate can no longer skip the LLM verifier. Flag off ⇒ skipped
	// entirely (bit-for-bit pre-U13-ADJ behavior).
	let determinismNote = "";
	if (resolveVerifyDeterminismEnabled(input.determinism)) {
		const layer = await applyVerifyGateDeterminismLayer(checks, outcome, exec, {
			cwd: input.cwd,
			signal: input.signal,
			timeoutMs: input.timeoutMs,
		});
		outcome = layer.outcome;
		determinismNote = layer.note;
		incMetric(
			input.metricRegistry,
			"crew.verification.verify_gate_determinism_runs_total",
			"Layer-3 determinism reruns (U13-ADJ) by result",
			{ result: layer.result },
		);
	}
	let preGate: VerifierPreGateResult | undefined;
	if (outcome.verdict === "INCONCLUSIVE" && input.classifier?.enabled) {
		try {
			preGate = await classifyVerifierPreGate({
				enabled: true,
				modelRegistry: input.classifier.modelRegistry,
				classifierModel: input.classifier.classifierModel,
				verdict: {
					verdict: outcome.verdict,
					evidenceLines: outcome.evidenceLines,
					changedFiles: [],
				},
				eventsPath: input.classifier.eventsPath,
				runId: input.classifier.runId,
				...(input.classifier.taskId !== undefined ? { taskId: input.classifier.taskId } : {}),
				metricRegistry: input.metricRegistry,
			});
		} catch {
			preGate = undefined; // soft: escalate to the LLM verifier
		}
	}
	const decision = resolveVerifierSpawnDecision(outcome, preGate);
	incMetric(input.metricRegistry, "crew.verification.verify_gate_runs_total", "Deterministic verify_gate executions by verdict", {
		verdict: outcome.verdict,
	});
	if (decision.skipVerifier) {
		incMetric(
			input.metricRegistry,
			"crew.verification.verifier_spawns_skipped_total",
			"LLM verifier spawns saved by the U13 deterministic pre-gate",
			{ reason: decision.reason },
		);
	} else {
		incMetric(
			input.metricRegistry,
			"crew.verification.verifier_spawns_total",
			"LLM verifier spawns that still ran, labeled by the deciding layer",
			{ reason: decision.reason },
		);
	}
	return {
		outcome,
		decision,
		...(preGate ? { preGate } : {}),
		promptContext:
			decision.attachGateContext || (determinismNote !== "" && !decision.skipVerifier) ? renderVerifyGateContext(outcome) : "",
	};
}
