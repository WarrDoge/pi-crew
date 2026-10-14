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
