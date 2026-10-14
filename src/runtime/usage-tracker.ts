import type { TeamRunManifest, TeamTaskState, UsageState } from "../state/types.ts";

/**
 * P1 (U16 follow-up) — 2-tier usage tracking. `LifetimeUsage` now carries all
 * five ledger fields. The change is ADDITIVE: callers that still pass only
 * input/output/cacheWrite deltas behave exactly as before.
 */
export interface LifetimeUsage {
	input: number;
	output: number;
	cacheWrite: number;
	/** P1: cumulative cache-read tokens (dropped from the ledger pre-P1). */
	cacheRead: number;
	/** P1: D2 aggregate cost — always a NUMBER, never the message-level cost object. */
	cost: number;
}

export function emptyLifetimeUsage(): LifetimeUsage {
	return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
}

/**
 * Usage delta for `addUsage`/`trackTaskUsage` — every field optional, absent
 * fields are skipped. `cost` MUST be a NUMBER (the D2 aggregate tier):
 * message-level cost OBJECTS (`{input, output, cacheRead, cacheWrite, total}`)
 * are NOT handled here — callers must first pass them through the shared
 * parser (`usageFromValue` in session-usage.ts), which extracts `cost.total`.
 */
export interface UsageDelta {
	input?: number;
	output?: number;
	cacheWrite?: number;
	cacheRead?: number;
	cost?: number;
}

export function addUsage(into: LifetimeUsage, delta: UsageDelta): void {
	if (typeof delta.input === "number") into.input += delta.input;
	if (typeof delta.output === "number") into.output += delta.output;
	if (typeof delta.cacheWrite === "number") into.cacheWrite += delta.cacheWrite;
	if (typeof delta.cacheRead === "number") into.cacheRead += delta.cacheRead;
	if (typeof delta.cost === "number") into.cost += delta.cost;
}

/** @internal — exported for unit tests. */
export function lifetimeUsageFromState(state: UsageState | undefined): LifetimeUsage {
	if (!state) return emptyLifetimeUsage();
	return {
		input: state.input ?? 0,
		output: state.output ?? 0,
		cacheWrite: state.cacheWrite ?? 0,
		// P1: legacy persisted states have no cacheRead/cost — both read as 0.
		cacheRead: state.cacheRead ?? 0,
		cost: state.cost ?? 0,
	};
}

export function usageStateFromLifetime(lifetime: LifetimeUsage): UsageState {
	return {
		input: lifetime.input,
		output: lifetime.output,
		cacheWrite: lifetime.cacheWrite,
		// P1: REAL values — the hard-coded `cacheRead: 0` (and the missing
		// `cost` key) are gone. `cost` stays always-present-as-number, matching
		// the stable-ledger convention (session-usage.ts compactUsage Fix D).
		cacheRead: lifetime.cacheRead,
		cost: lifetime.cost,
	};
}

const taskUsageMap = new Map<string, LifetimeUsage>();

export function trackTaskUsage(taskId: string, delta: UsageDelta): void {
	const existing = taskUsageMap.get(taskId) ?? emptyLifetimeUsage();
	addUsage(existing, delta);
	taskUsageMap.set(taskId, existing);
}

export function getTrackedTaskUsage(taskId: string): LifetimeUsage {
	return taskUsageMap.get(taskId) ?? emptyLifetimeUsage();
}

export function clearTrackedTaskUsage(taskId: string): void {
	taskUsageMap.delete(taskId);
}

export function clearAllTrackedTaskUsage(): void {
	taskUsageMap.clear();
}

// Aliases for public API
export const getTaskUsage = getTrackedTaskUsage;
export const getRunUsage = getTrackedTaskUsage;
export const clearAllTaskUsage = clearAllTrackedTaskUsage;

/** @internal — exported for unit tests. */
export function aggregateTrackedUsageForRun(manifest: TeamRunManifest, tasks: TeamTaskState[]): UsageState {
	const total = emptyLifetimeUsage();
	for (const task of tasks) {
		const tracked = getTrackedTaskUsage(task.id);
		addUsage(total, tracked);
		// Also add any usage already stored on the task
		if (task.usage) addUsage(total, task.usage);
	}
	return usageStateFromLifetime(total);
}
