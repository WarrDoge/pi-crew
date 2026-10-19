import type { TeamTaskState, UsageState } from "./types.ts";

/**
 * Usage aggregation helpers for the run ledger and cost reporting.
 *
 * The ledger (aggregateUsage / RoleUsage) carries the FULL 5-field usage set
 * (input, output, cacheRead, cacheWrite, cost) for accurate cost attribution.
 * The canonical 5-field `LifetimeUsage` type lives in `src/runtime/usage-tracker.ts`.
 *
 * Token-sum displays and the budget proxy deliberately EXCLUDE cacheRead:
 * each turn's cacheRead is the cumulative cached prefix re-read on that one
 * call — summing across turns would count it N times.
 * See: https://github.com/nichekate/pi-subagents3/issues/38 and
 * docs/archive/pi-subagents3-deep-analysis.md
 *
 * M3-4 / R43-N2 (2026-10-19 fix-wave 6): the ledger above covers a task's OWN
 * work. DELEGATE spend is booked on the PARENT task record
 * (`allocation.tokensSpent`, written by the broker at delegate admission —
 * see crew-broker.ts and delegate/delegate-finalize.ts) and is therefore NOT
 * part of `aggregateUsage`. Budget enforcement must add it explicitly through
 * {@link taskTokenTotal} / {@link sumDelegateTokensSpent}; pre-fix nothing read
 * `allocation.tokensSpent`, so a nested delegate storm was invisible to
 * `budgetTotal` and bypassed the abort entirely (probe-verified round 43).
 */

export function aggregateUsage(tasks: TeamTaskState[]): UsageState | undefined {
	const total: UsageState = {};
	let found = false;
	for (const task of tasks) {
		if (!task.usage) continue;
		found = true;
		total.input = (total.input ?? 0) + (task.usage.input ?? 0);
		total.output = (total.output ?? 0) + (task.usage.output ?? 0);
		total.cacheRead = (total.cacheRead ?? 0) + (task.usage.cacheRead ?? 0);
		total.cacheWrite = (total.cacheWrite ?? 0) + (task.usage.cacheWrite ?? 0);
		total.cost = (total.cost ?? 0) + (task.usage.cost ?? 0);
		total.turns = (total.turns ?? 0) + (task.usage.turns ?? 0);
	}
	return found ? total : undefined;
}

/** M3-4 / R43-N2: DELEGATE spend booked on one task record, in TOKENS —
 *  the same unit as `UsageState.input/output/cacheWrite`. Sourced from the
 *  broker-side tally (`allocation.tokensSpent`), which since M3-4/R44-N4 is
 *  the host-decided ADMISSION RESERVATION, never the child's self-reported
 *  `message_end` usage. Values are clamped at 0 so a corrupt record can never
 *  subtract from the run total. */
export function delegateTokensSpent(task: TeamTaskState): number {
	const spent = task.allocation?.tokensSpent ?? 0;
	return Number.isFinite(spent) && spent > 0 ? spent : 0;
}

/** M3-4 / R43-N2: total delegate spend across the run, in TOKENS. */
export function sumDelegateTokensSpent(tasks: TeamTaskState[]): number {
	let total = 0;
	for (const task of tasks) total += delegateTokensSpent(task);
	return total;
}

/** M3-4 / R43-N2: A TASK'S FULL COST in TOKENS — its own work
 *  (`input + output + cacheWrite`, the budget proxy's rule) PLUS the delegate
 *  spend it booked. This is THE per-task number budget enforcement must use;
 *  `aggregateUsage` alone cannot see grandchildren.
 *
 *  No double count: a grandchild is a shadow task (`gc-*`, no stepId) that
 *  never runs under the scheduler, so its usage never lands in a
 *  `task.usage` — its cost exists ONLY as the parent's reservation. */
export function taskTokenTotal(task: TeamTaskState): number {
	const usage = task.usage;
	const own = (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
	return own + delegateTokensSpent(task);
}

export function formatUsage(usage: UsageState | undefined): string {
	if (!usage) return "(none)";
	const parts: string[] = [];
	if (usage.input !== undefined) parts.push(`input=${usage.input}`);
	if (usage.output !== undefined) parts.push(`output=${usage.output}`);
	if (usage.cacheRead !== undefined) parts.push(`cacheRead=${usage.cacheRead}`);
	if (usage.cacheWrite !== undefined) parts.push(`cacheWrite=${usage.cacheWrite}`);
	if (usage.cost !== undefined && Number.isFinite(usage.cost)) parts.push(`cost=${usage.cost.toFixed(6)}`);
	if (usage.turns !== undefined) parts.push(`turns=${usage.turns}`);
	return parts.join(", ") || "(none)";
}

/** Human-readable compact token count (12345 -> "12.3k"). */
export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Human-readable cost ($0.001234 -> "$0.001234", $1.5 -> "$1.50"). */
export function formatCost(cost: number | undefined): string {
	if (cost === undefined || !Number.isFinite(cost)) return "$0.00";
	if (cost === 0) return "$0.00";
	if (cost < 0.01) return `$${cost.toFixed(6)}`;
	return `$${cost.toFixed(cost < 1 ? 4 : 2)}`;
}

export interface RoleUsage {
	role: string;
	input: number;
	output: number;
	/** Ledger field — full cacheRead sum for cost attribution (not shown in token-sum displays). */
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	taskCount: number;
}

/** Aggregate usage per-role (and per-task) for cost attribution. */
export function aggregateUsageByRole(tasks: TeamTaskState[]): RoleUsage[] {
	const byRole = new Map<string, RoleUsage>();
	for (const task of tasks) {
		const role = task.role || "unknown";
		let bucket = byRole.get(role);
		if (!bucket) {
			bucket = {
				role,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turns: 0,
				taskCount: 0,
			};
			byRole.set(role, bucket);
		}
		bucket.taskCount++;
		if (!task.usage) continue;
		bucket.input += task.usage.input ?? 0;
		bucket.output += task.usage.output ?? 0;
		bucket.cacheRead += task.usage.cacheRead ?? 0;
		bucket.cacheWrite += task.usage.cacheWrite ?? 0;
		bucket.cost += task.usage.cost ?? 0;
		bucket.turns += task.usage.turns ?? 0;
	}
	return [...byRole.values()].sort((a, b) => b.cost - a.cost);
}

/**
 * Build a multi-line cost report with per-role attribution.
 * Used by the `summary` action for cost visibility (roadmap T1.1).
 */
export function formatCostReport(tasks: TeamTaskState[]): string {
	const usage = aggregateUsage(tasks);
	if (!usage) return "Cost: (no usage data recorded)";
	const byRole = aggregateUsageByRole(tasks);
	const totalTokens = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0);
	const lines: string[] = [];
	lines.push("═══ Cost Report ═══");
	lines.push(
		`Tokens: ${formatTokens(totalTokens)} (in ${formatTokens(usage.input ?? 0)}, out ${formatTokens(usage.output ?? 0)}, cache-write ${formatTokens(usage.cacheWrite ?? 0)})`,
	);
	lines.push(`Cost: ${formatCost(usage.cost)}${usage.turns ? ` across ${usage.turns} turn(s)` : ""}`);
	if (byRole.length > 1) {
		lines.push("");
		lines.push("By role:");
		for (const r of byRole) {
			const pct = usage.cost && usage.cost > 0 ? Math.round((r.cost / usage.cost) * 100) : 0;
			const tok = r.input + r.output + r.cacheWrite;
			lines.push(
				`  ${r.role} (${r.taskCount} task${r.taskCount === 1 ? "" : "s"}): ${formatCost(r.cost)}${pct ? ` — ${pct}%` : ""}, ${formatTokens(tok)} tok, ${r.turns} turns`,
			);
		}
	}
	lines.push("");
	lines.push("Track budget via budgetTotal/budgetWarning/budgetAbort on team run.");
	return lines.join("\n");
}
