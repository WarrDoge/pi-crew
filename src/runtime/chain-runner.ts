/**
 * ChainRunner - Execute sequential chains with `->` syntax support.
 *
 * Based on pi-boomerang's parseChain pattern:
 * - Parses "teamA -> teamB -> teamC" syntax
 * - Supports per-step overrides for model, skill, thinking
 * - Accumulates handoffs between steps
 * - Executes steps sequentially with context passing
 */

import { errorMessage } from "../utils/guards.ts";
import type { ChainStep as DSLChainStep } from "./chain-parser.ts";
import { parseChainDSL } from "./chain-parser.ts";
import type { HandoffManager, HandoffSummary, TaskPacket, TaskResult } from "./handoff-manager.ts";

/**
 * Single step in a chain.
 */
export interface ChainStep {
	/** Step name/identifier */
	name: string;
	/** Team to execute (if using team reference) */
	team?: string;
	/** Workflow to execute (if using workflow reference) */
	workflow?: string;
	/** Template to execute (if using template reference) */
	template?: string;
	/** Inline goal text (for literal goals) */
	inlineGoal?: string;

	/** Per-step model override */
	model?: string;
	/** Per-step skill override */
	skill?: string;
	/** Thinking mode */
	thinking?: "fast" | "standard" | "deep";

	/** Step-specific context */
	context?: Record<string, unknown>;
	/** Step timeout in milliseconds */
	timeout?: number;

	/** Whether to continue chain on failure */
	continueOnError?: boolean;
}

/**
 * Parsed chain specification.
 */
export interface ChainSpec {
	/** Ordered steps in the chain */
	steps: ChainStep[];
	/** Global arguments applied to all steps */
	globalArgs?: Record<string, unknown>;
	/** Global model override */
	globalModel?: string;
	/** Global skill override */
	globalSkill?: string;
	/** Global thinking mode */
	globalThinking?: "fast" | "standard" | "deep";
	/** Continue chain on step failure */
	continueOnError?: boolean;
}

/**
 * Result of a single chain step execution.
 */
export interface ChainStepResult {
	step: number;
	name: string;
	outcome: "success" | "failure" | "skipped" | "partial";
	result?: TaskResult;
	handoff?: HandoffSummary;
	duration: number;
	error?: string;
}

/**
 * Final chain execution result.
 */
export interface ChainResult {
	steps: ChainStepResult[];
	totalDuration: number;
	success: boolean;
	/** Total tokens used across all steps */
	totalTokens?: number;
	/** All handoffs generated during chain */
	totalHandoffs: HandoffSummary[];
}

/**
 * Task runner interface for chain execution.
 */
export interface ChainTaskRunner {
	runTask(packet: TaskPacket): Promise<TaskResult>;
}

/**
 * ChainRunner executes sequential chains with context passing.
 */
export class ChainRunner {
	/** Maximum number of chain history entries to prevent memory leaks */
	private static readonly MAX_CHAIN_HISTORY_SIZE = 100;

	/** Maximum size per handoff entry to prevent memory issues from large artifacts */
	private static readonly MAX_HANDOFF_ENTRY_SIZE = 5000; // bytes per entry

	/** v0.11.27: `--with-context` full-output cap (default history carries only
	 * 5000-char summaries; this is the explicit full-output channel, bounded). */
	private static readonly MAX_WITH_CONTEXT_OUTPUT_CHARS = 20000; // chars

	private taskRunner: ChainTaskRunner;
	private handoffManager: HandoffManager;

	constructor(taskRunner: ChainTaskRunner, handoffManager: HandoffManager) {
		this.taskRunner = taskRunner;
		this.handoffManager = handoffManager;
	}

	/**
	 * Parse chain syntax: step1 -> step2 -> step3
	 *
	 * Supports multiple syntaxes:
	 * - Team reference: @teamName
	 * - Workflow reference: workflow:name
	 * - Template reference: template:name
	 * - Inline goal: "goal description"
	 *
	 * @example
	 * parseChain("@research -> @implement -> @review")
	 * parseChain('"Research AI trends" -> "Analyze findings"')
	 * parseChain("@step1 --model claude-opus-3 -> @step2")
	 *
	 * Also supports DSL syntax from chain-parser for advanced constructs:
	 * parseChain("step1 -> parallel(step2, step3) -> step4")
	 * parseChain("step1:3 -> step2 --with-context -> step3")
	 *
	 * @param chainString - The chain string to parse
	 * @returns Parsed chain specification
	 */
	parseChain(chainString: string): ChainSpec {
		// Try DSL parser first for advanced syntax (parallel groups, loop counts, flags)
		// Falls back to the simple split parser if DSL parsing fails
		if (this.hasDSLConstructs(chainString)) {
			try {
				const dslSteps = parseChainDSL(chainString);
				return this.dslToChainSpec(dslSteps, chainString);
			} catch {
				// DSL parse failed; fall through to simple parser
			}
		}

		const stepStrings = this.splitChainSteps(chainString).map((s) => s.trim());

		const steps: ChainStep[] = stepStrings.map((step, index) => {
			return this.parseStep(step, index);
		});

		// Extract global overrides
		const globalModel = this.extractGlobalFlag(chainString, "global-model");
		const globalSkill = this.extractGlobalFlag(chainString, "global-skill");
		const globalThinking = this.extractGlobalFlag(chainString, "global-thinking") as "fast" | "standard" | "deep" | undefined;
		const continueOnError = this.extractGlobalFlag(chainString, "continue-on-error") === "true";

		return {
			steps,
			globalModel,
			globalSkill,
			globalThinking,
			continueOnError,
		};
	}

	/**
	 * Execute chain sequentially.
	 * Each step receives handoff from previous step.
	 *
	 * @param spec - Parsed chain specification
	 * @param initialContext - Initial context for the chain
	 * @param eventsPath - Optional event log path for events
	 * @returns Final chain result
	 */
	async runChain(spec: ChainSpec, initialContext: Record<string, unknown> = {}, eventsPath?: string): Promise<ChainResult> {
		const stepResults: ChainStepResult[] = [];
		let accumulatedContext = { ...initialContext };
		const startTime = Date.now();
		let totalTokens = 0;
		const allHandoffs: HandoffSummary[] = [];
		// R14-C5: a break leaves later steps UNEXECUTED. Tracked explicitly so the
		// success predicate cannot report a truncated chain as complete.
		let brokeEarly = false;

		// v0.11.27 (R14-C1 tail): expand `:N` loop steps into an execution plan —
		// one entry per ITERATION. Each iteration is its own ChainStepResult
		// (name#k for k>1) so a failing iteration stays visible; the success
		// predicate counts planned EXECUTIONS, so a chain that broke inside a
		// loop cannot pass unexecuted iterations off as done (R14-C5 class).
		const plan = this.buildExecutionPlan(spec);
		const plannedExecutions = plan.length;

		for (const entry of plan) {
			const { step, stepIndex: i, displayName, iterations } = entry;
			const stepStart = Date.now();

			try {
				// Resolve effective config (step overrides global)
				const effectiveConfig = this.getEffectiveConfig(step, spec);

				// Enrich context with previous handoffs
				const stepContext = this.enrichContextFromHandoffs(accumulatedContext, stepResults);

				// Execute step
				const result = await this.executeStep(effectiveConfig, stepContext, stepResults);

				// Track tokens
				if (result.usage?.totalTokens) {
					totalTokens += result.usage.totalTokens;
				}

				// Generate handoff for next step
				const handoff = await this.handoffManager.generateSummary(this.createMinimalPacket(step, i), result);

				stepResults.push({
					step: i + 1,
					name: displayName,
					outcome: result.outcome,
					result,
					handoff,
					duration: Date.now() - stepStart,
				});

				if (handoff !== null) {
					allHandoffs.push(handoff);
				}

				// Update accumulated context on success
				if (result.outcome === "success") {
					accumulatedContext = {
						...accumulatedContext,
						[`step_${i}_result`]: result,
						[`step_${i}_handoff`]: handoff,
					};
				} else {
					// Stop chain on step failure unless configured to continue
					if (!spec.continueOnError && !step.continueOnError) {
						brokeEarly = true;
						break;
					}
				}

				// Emit progress event if eventsPath provided
				if (eventsPath) {
					// LAZY: defer dynamic import of ../state/event-log/event-log.ts to its call site.
					const { appendEventAsync } = await import("../state/event-log/event-log.ts");
					await appendEventAsync(eventsPath, {
						type: "chain.step_completed",
						runId: "chain",
						taskId: iterations > 1 ? `step-${i + 1}#${entry.iter}` : `step-${i + 1}`,
						data: {
							step: i + 1,
							name: displayName,
							outcome: result.outcome,
							duration: Date.now() - stepStart,
						},
					});
				}
			} catch (error) {
				const errMsg = errorMessage(error);

				stepResults.push({
					step: i + 1,
					name: displayName,
					outcome: "failure",
					duration: Date.now() - stepStart,
					error: errMsg,
				});

				// Stop chain on failure unless configured to continue
				if (!spec.continueOnError && !step.continueOnError) {
					brokeEarly = true;
					break;
				}
			}
		}

		// R14-C5 (false-green): the old predicate was `every(outcome !== "failure")`,
		// so a `partial` step — which breaks the chain exactly like a failure — still
		// produced success:true, and dispatch printed "Chain completed" + status ok
		// for a chain whose remaining steps never ran. An empty spec was vacuously
		// green for the same reason. Success now requires: at least one step, no
		// early break, every planned step executed, and every outcome `success`.
		const allStepsExecuted = stepResults.length === plannedExecutions;
		const allOutcomesSuccessful = stepResults.every((s) => s.outcome === "success");

		return {
			steps: stepResults,
			totalDuration: Date.now() - startTime,
			success: spec.steps.length > 0 && !brokeEarly && allStepsExecuted && allOutcomesSuccessful,
			totalTokens: totalTokens > 0 ? totalTokens : undefined,
			totalHandoffs: allHandoffs,
		};
	}

	/**
	 * Split a chain string on top-level `->` arrows, ignoring arrows inside
	 * quotes.  Prevents inline goals containing `->` (e.g. "Change A -> B")
	 * from being incorrectly split into separate steps.
	 */
	private splitChainSteps(chainString: string): string[] {
		const parts: string[] = [];
		let current = "";
		let inQuote = false;
		let quoteChar = "";

		for (let i = 0; i < chainString.length; i++) {
			const ch = chainString[i]!;

			// Handle escape sequences inside quotes (e.g. \" or \')
			if (inQuote && ch === "\\" && i + 1 < chainString.length) {
				current += ch + (chainString[i + 1] ?? "");
				i++;
				continue;
			}

			// Toggle quote state on unescaped quote characters
			if (ch === '"' || ch === "'") {
				if (!inQuote) {
					inQuote = true;
					quoteChar = ch;
				} else if (ch === quoteChar) {
					inQuote = false;
				}
				current += ch;
				continue;
			}

			// Split on -> only when not inside quotes
			if (!inQuote && ch === "-" && chainString[i + 1] === ">") {
				parts.push(current);
				current = "";
				i++; // skip the '>'
				continue;
			}

			current += ch;
		}
		parts.push(current);
		return parts;
	}

	/**
	 * Parse a single step from the chain string.
	 * Includes type safety checks for ChainStep parsing (H3).
	 */
	private parseStep(step: string, index: number): ChainStep {
		// Parse team reference: @teamName
		const teamMatch = step.match(/^@([a-zA-Z][a-zA-Z0-9_]*)/);

		// Parse workflow reference: workflow:name
		const workflowMatch = step.match(/^workflow:([a-zA-Z][a-zA-Z0-9_]*)/);

		// Parse template reference: template:name
		const templateMatch = step.match(/^template:([a-zA-Z][a-zA-Z0-9_]*)/);

		// Parse inline goal: "goal description" (can follow other patterns)
		const inlineMatch = step.match(/"([^"]{1,10000})"/);

		const nameParts = step.split(/\s+/);
		const name = nameParts[0] && nameParts[0].length > 0 && nameParts[0].length <= 100 ? nameParts[0] : `step-${index}`;

		const parsed: ChainStep = {
			name,
		};

		// Set step type based on matching pattern with type safety
		if (teamMatch?.[1]) {
			parsed.team = this.sanitizeIdentifier(teamMatch[1]);
		}
		if (workflowMatch?.[1]) {
			parsed.workflow = this.sanitizeIdentifier(workflowMatch[1]);
		}
		if (templateMatch?.[1]) {
			parsed.template = this.sanitizeIdentifier(templateMatch[1]);
		}
		if (inlineMatch?.[1]) {
			parsed.inlineGoal = this.sanitizeInlineGoal(inlineMatch[1]);
		}

		// Parse per-step overrides with type safety
		const modelVal = this.extractFlag(step, "model");
		if (modelVal && this.isValidModelName(modelVal)) {
			parsed.model = modelVal;
		}

		const skillVal = this.extractFlag(step, "skill");
		if (skillVal && this.isValidIdentifier(skillVal)) {
			parsed.skill = skillVal;
		}

		const thinkingVal = this.extractFlag(step, "thinking");
		if (thinkingVal && this.isValidThinkingMode(thinkingVal)) {
			parsed.thinking = thinkingVal;
		}

		// Parse step timeout
		const timeoutStr = this.extractFlag(step, "timeout");
		if (timeoutStr) {
			// v0.11.27 (R14-C2): the flag is SECONDS — the old bound compared the
			// seconds value against 86400000 (a 1000-day ms bound) before
			// multiplying, so `--timeout 99999999` was silently accepted. Now
			// 1..86400 s (1 day), and the value is actually CONSUMED (chain-executor
			// forwards it as runParams.timeoutMs).
			const timeoutSec = parseInt(timeoutStr, 10);
			if (!Number.isNaN(timeoutSec) && timeoutSec > 0 && timeoutSec <= 86400) {
				parsed.timeout = timeoutSec * 1000;
			}
		}

		// Parse continueOnError for step
		if (this.extractFlag(step, "continue-on-error") === "true") {
			parsed.continueOnError = true;
		}

		return parsed;
	}

	/**
	 * Detect if chainString uses DSL constructs that require chain-parser.
	 * DSL features: parallel(...), :loopCount, --with-context flag
	 */
	private hasDSLConstructs(chainString: string): boolean {
		// v0.11.27 (probe-caught): `:\d+` no longer requires a leading \w — a
		// QUOTED goal followed by `:2` (`"polish":2`) must route to the DSL
		// parser too. Broadening is safe: time-like false positives
		// ("deploy at 10:30") still throw inside the DSL parser and fall back to
		// the simple splitter exactly as before.
		return /\bparallel\s*\(/.test(chainString) || /:\d+\b/.test(chainString) || /--with-context/.test(chainString);
	}

	/**
	 * Convert DSL AST steps (from chain-parser) to ChainSpec.
	 *
	 * R14-C1: `parallel(...)` groups are FLATTENED into ordered steps. They used to
	 * be parked in `step.context.parallel`, which no consumer ever read — the whole
	 * group collapsed into one step literally named "parallel" and never ran its
	 * members. Chain execution is sequential by contract (see runChain), so the
	 * members run in source order and each keeps its own step result, which means a
	 * failing member stays visible instead of vanishing into a dropped group.
	 */
	private dslToChainSpec(dslSteps: DSLChainStep[], chainString: string): ChainSpec {
		const steps: ChainStep[] = [];

		// Recursive so nested groups (parallel(a, parallel(b, c))) flatten too.
		const pushStep = (dslStep: DSLChainStep): void => {
			if (dslStep.parallel) {
				for (const member of dslStep.parallel) pushStep(member);
				return;
			}

			const step: ChainStep = { name: dslStep.name };

			// '@team' reference — same resolution the simple parser applies to @refs.
			if (dslStep.name.startsWith("@")) {
				const team = this.sanitizeIdentifier(dslStep.name.slice(1));
				if (team.length > 0) step.team = team;
			}

			if (dslStep.loopCount) step.context = { ...step.context, loopCount: dslStep.loopCount };
			if (dslStep.withContext) step.context = { ...step.context, withContext: true };
			if (dslStep.args && dslStep.args.length > 0) step.context = { ...step.context, args: dslStep.args };
			steps.push(step);
		};

		for (const dslStep of dslSteps) pushStep(dslStep);

		// Extract global overrides using existing logic
		const globalModel = this.extractGlobalFlag(chainString, "global-model");
		const globalSkill = this.extractGlobalFlag(chainString, "global-skill");
		const globalThinking = this.extractGlobalFlag(chainString, "global-thinking") as "fast" | "standard" | "deep" | undefined;
		const continueOnError = this.extractGlobalFlag(chainString, "continue-on-error") === "true";

		return {
			steps,
			globalModel,
			globalSkill,
			globalThinking,
			continueOnError,
		};
	}

	/**
	 * Sanitize identifier to prevent injection.
	 */
	private sanitizeIdentifier(value: string): string {
		return value.replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 100);
	}

	/**
	 * Sanitize inline goal to prevent injection.
	 */
	private sanitizeInlineGoal(value: string): string {
		// Remove control characters and limit length
		return value.replace(/[\x00-\x1F\x7F]/g, "").substring(0, 10000);
	}

	/**
	 * Validate model name format.
	 */
	private isValidModelName(value: string): boolean {
		return /^[a-zA-Z][a-zA-Z0-9_-]{0,50}$/.test(value);
	}

	/**
	 * Validate identifier format.
	 */
	private isValidIdentifier(value: string): boolean {
		return /^[a-zA-Z][a-zA-Z0-9_]{0,50}$/.test(value);
	}

	/**
	 * Validate thinking mode value.
	 */
	private isValidThinkingMode(value: string): value is "fast" | "standard" | "deep" {
		return ["fast", "standard", "deep"].includes(value);
	}

	/**
	 * Extract a flag from step string.
	 * Uses escaped flag name to prevent regex injection.
	 */
	private extractFlag(input: string, flag: string): string | undefined {
		// Escape regex special characters in flag name to prevent injection
		const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = input.match(new RegExp(`--${escapedFlag}\\s+(\\S+)`));
		return match?.[1];
	}

	/**
	 * Extract a global flag from the chain string.
	 * Global flags can appear anywhere in the chain string.
	 * Uses escaped flag name to prevent regex injection.
	 */
	private extractGlobalFlag(input: string, flag: string): string | undefined {
		// Escape regex special characters in flag name to prevent injection
		const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const patternEq = "--" + escapedFlag + "=\\s*(\\S+)";
		const match = input.match(new RegExp(patternEq, "i"));
		if (match) return match[1];

		const patternNoEq = "--" + escapedFlag + "\\s+(\\S+)";
		const matchNoEq = input.match(new RegExp(patternNoEq, "i"));
		if (matchNoEq) return matchNoEq[1];

		return undefined;
	}

	/**
	 * Get effective config with step overrides global.
	 */
	private getEffectiveConfig(step: ChainStep, spec: ChainSpec): ChainStep {
		return {
			...step,
			model: step.model ?? spec.globalModel,
			skill: step.skill ?? spec.globalSkill,
			thinking: step.thinking ?? spec.globalThinking,
		};
	}

	/**
	 * Enrich context with previous handoffs.
	 * Limits history size to prevent memory leaks.
	 */
	private enrichContextFromHandoffs(context: Record<string, unknown>, previousResults: ChainStepResult[]): Record<string, unknown> {
		const handoffs = previousResults.filter((r) => r.handoff).map((r) => r.handoff!);

		if (handoffs.length === 0) {
			return context;
		}

		const notes: string[] = [];

		// Limit history size to prevent memory leak (H2). Emit a marker so a dropped
		// entry does not vanish silently — this was the only silent-loss path in the
		// output-handling machinery (see research-findings/output-handling-deep-dive.md §F).
		let limitedHandoffs = handoffs;
		if (handoffs.length > ChainRunner.MAX_CHAIN_HISTORY_SIZE) {
			const dropped = handoffs.length - ChainRunner.MAX_CHAIN_HISTORY_SIZE;
			notes.push(
				`[chain history limited to last ${ChainRunner.MAX_CHAIN_HISTORY_SIZE} entries; ${dropped} older entr${dropped === 1 ? "y" : "ies"} omitted]`,
			);
			limitedHandoffs = handoffs.slice(-ChainRunner.MAX_CHAIN_HISTORY_SIZE);
		}

		// Limit per-entry size to prevent memory issues from large artifacts.
		const filteredHandoffs = limitedHandoffs.filter((h) => {
			const size = JSON.stringify(h).length;
			return size <= ChainRunner.MAX_HANDOFF_ENTRY_SIZE;
		});
		const oversizedDropped = limitedHandoffs.length - filteredHandoffs.length;
		if (oversizedDropped > 0) {
			notes.push(
				`[${oversizedDropped} handoff entr${oversizedDropped === 1 ? "y" : "ies"} omitted (> ${ChainRunner.MAX_HANDOFF_ENTRY_SIZE} bytes each)]`,
			);
		}

		// Track array-cap drops so capped lists do not vanish silently. Each field
		// over its cap records the full count so a reader knows data was elided.
		const arrayCapNotes: string[] = [];
		const mapped = filteredHandoffs.map((h) => {
			const over: string[] = [];
			if (h.filesCreated && h.filesCreated.length > 50) over.push(`filesCreated=${h.filesCreated.length}`);
			if (h.filesModified && h.filesModified.length > 50) over.push(`filesModified=${h.filesModified.length}`);
			if (h.decisions && h.decisions.length > 20) over.push(`decisions=${h.decisions.length}`);
			if (h.nextSteps && h.nextSteps.length > 20) over.push(`nextSteps=${h.nextSteps.length}`);
			if (over.length > 0) arrayCapNotes.push(`step ${h.taskId}: ${over.join(", ")} (capped)`);
			return {
				step: h.taskId,
				outcome: h.outcome,
				filesCreated: h.filesCreated?.slice(0, 50), // Limit array size
				filesModified: h.filesModified?.slice(0, 50), // Limit array size
				decisions: h.decisions?.slice(0, 20), // Limit array size
				nextSteps: h.nextSteps?.slice(0, 20), // Limit array size
				...(h.outputText ? { outputText: h.outputText.slice(0, 5000) } : {}), // Size-capped worker output
			};
		});
		if (arrayCapNotes.length > 0) notes.push(`[list caps applied: ${arrayCapNotes.join("; ")}]`);

		return {
			...context,
			__chainHistory: mapped,
			...(notes.length > 0 ? { __chainHistoryNotes: notes } : {}),
		};
	}

	/**
	 * Execute a single step.
	 */
	private async executeStep(
		config: ChainStep,
		context: Record<string, unknown>,
		previousResults: ChainStepResult[],
	): Promise<TaskResult> {
		// v0.11.27 (R14-C1 tail): DSL `args` append to the goal — positional goal
		// arguments (`"research" "topic X"` -> goal "research topic X").
		const dslArgs = Array.isArray(config.context?.args) ? (config.context.args as string[]) : undefined;
		const baseGoal = config.inlineGoal ?? config.name;
		const goal = dslArgs && dslArgs.length > 0 ? [baseGoal, ...dslArgs].join(" ") : baseGoal;

		// v0.11.27 (R14-C1 tail): DSL `--with-context` passes the PREVIOUS step's
		// full worker output (capped) — distinct from the default __chainHistory,
		// which carries only size-capped handoff summaries.
		const withContext = config.context?.withContext === true;
		let chainPrevOutput: string | undefined;
		if (withContext) {
			const prev = [...previousResults].reverse().find((r) => r.outcome === "success" && r.result?.outputText);
			if (prev?.result?.outputText) {
				chainPrevOutput = prev.result.outputText.slice(0, ChainRunner.MAX_WITH_CONTEXT_OUTPUT_CHARS);
			}
		}

		// Pass step config (team/workflow/model) into the packet context so the
		// concrete ChainTaskRunner can resolve which team/workflow to run. Without
		// this, a step parsed to a @teamName reference would lose its team because
		// the only channel from executeStep to runTask is the TaskPacket. Purely
		// additive — adds sibling keys alongside __chainHistory/Notes.
		const packet: TaskPacket = {
			taskId: `chain-${Date.now()}-${config.name}`,
			runId: "chain",
			goal,
			summarizeThreshold: 3000,
			collapseContext: true,
			context: {
				...context,
				__chainStepTeam: config.team,
				__chainStepWorkflow: config.workflow,
				__chainStepModel: config.model,
				...(chainPrevOutput !== undefined ? { __chainPrevOutput: chainPrevOutput } : {}),
				// v0.11.27 (R14-C2): wire the previously-dead `--timeout` flag into
				// the step run's deadline (ms; consumed by chain-executor as
				// runParams.timeoutMs -> CORE-8 resolveRunDeadline).
				...(config.timeout !== undefined ? { __chainStepTimeoutMs: config.timeout } : {}),
			},
		};

		return this.taskRunner.runTask(packet);
	}

	/** v0.11.27: iterations planned for a step — `:N` DSL (parser-clamped 1..10). */
	private plannedIterations(step: ChainStep): number {
		const n = step.context?.loopCount;
		return typeof n === "number" && Number.isInteger(n) && n >= 1 ? Math.min(10, n) : 1;
	}

	/** v0.11.27: expand steps into per-iteration plan entries. */
	private buildExecutionPlan(spec: ChainSpec): Array<{
		step: ChainStep;
		stepIndex: number;
		iter: number;
		iterations: number;
		displayName: string;
	}> {
		const plan: Array<{
			step: ChainStep;
			stepIndex: number;
			iter: number;
			iterations: number;
			displayName: string;
		}> = [];
		spec.steps.forEach((step, stepIndex) => {
			const iterations = this.plannedIterations(step);
			for (let iter = 1; iter <= iterations; iter++) {
				plan.push({
					step,
					stepIndex,
					iter,
					iterations,
					displayName: iter > 1 ? `${step.name}#${iter}` : step.name,
				});
			}
		});
		return plan;
	}

	/**
	 * Create minimal packet for handoff generation.
	 */
	private createMinimalPacket(step: ChainStep, index: number): TaskPacket {
		return {
			taskId: `chain-step-${index}`,
			runId: "chain",
			sessionId: "chain",
			goal: step.inlineGoal ?? step.name,
		};
	}
}

/**
 * Create a ChainRunner with default dependencies.
 */
export function createChainRunner(taskRunner: ChainTaskRunner, handoffManager: HandoffManager): ChainRunner {
	return new ChainRunner(taskRunner, handoffManager);
}

/**
 * Parse chain from string shorthand.
 */
export function parseChainString(chainString: string): ChainSpec {
	const runner = new ChainRunner(
		{
			runTask: () => Promise.reject(new Error("Not initialized")),
		} as ChainTaskRunner,
		{} as HandoffManager,
	);
	return runner.parseChain(chainString);
}
