import * as fs from "node:fs";
import type { UsageState } from "../state/types.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function numberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

/**
 * U16 (D2 — two-tier cost): cost arrives EITHER as a session-level aggregate
 * NUMBER (SDK `SessionStats.cost`) OR as a message-level OBJECT with a `total`
 * field (`@earendil-works/pi-ai` `Usage.cost = {input, output, cacheRead,
 * cacheWrite, total}`). Accept both; an object without a finite `total` yields
 * undefined — never NaN.
 */
function costField(obj: Record<string, unknown>): number | undefined {
	for (const key of ["cost", "costUsd", "cost_usd"]) {
		const raw = obj[key];
		if (typeof raw === "number" && Number.isFinite(raw)) return raw;
		const record = asRecord(raw);
		const total = record ? record.total : undefined;
		if (typeof total === "number" && Number.isFinite(total)) return total;
	}
	return undefined;
}

function mergeUsageFields(primary: UsageState, fallback: UsageState): UsageState {
	return {
		input: primary.input ?? fallback.input,
		output: primary.output ?? fallback.output,
		cacheRead: primary.cacheRead ?? fallback.cacheRead,
		cacheWrite: primary.cacheWrite ?? fallback.cacheWrite,
		cost: primary.cost ?? fallback.cost,
		turns: primary.turns ?? fallback.turns,
	};
}

/**
 * U16: the single usage-shape parser (session-level `SessionStats` AND
 * message-level `Usage`). Flat/direct fields win; nested payloads
 * (`usage`/`tokenUsage`/`tokens`/`stats`) fill only the MISSING fields, so the
 * SDK session shape `{tokens: {…}, cost}` maps completely while flat legacy
 * shapes parse unchanged.
 */
export function usageFromValue(value: unknown): UsageState | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const direct: UsageState = {
		input: numberField(obj, ["input", "inputTokens", "input_tokens"]),
		output: numberField(obj, ["output", "outputTokens", "output_tokens"]),
		cacheRead: numberField(obj, ["cacheRead", "cache_read", "cacheReadTokens", "cache_read_tokens"]),
		cacheWrite: numberField(obj, ["cacheWrite", "cache_write", "cacheWriteTokens", "cache_write_tokens"]),
		cost: costField(obj),
		turns: numberField(obj, ["turns", "turnCount", "turn_count"]),
	};
	let merged: UsageState | undefined = Object.values(direct).some((entry) => entry !== undefined) ? direct : undefined;
	for (const key of ["usage", "tokenUsage", "tokens", "stats"]) {
		const nested = usageFromValue(obj[key]);
		if (nested) merged = merged ? mergeUsageFields(merged, nested) : nested;
	}
	if (merged) return merged;
	const message = asRecord(obj.message);
	return message ? usageFromValue(message.usage) : undefined;
}

function addUsage(total: UsageState, usage: UsageState): UsageState {
	return {
		input: (total.input ?? 0) + (usage.input ?? 0),
		output: (total.output ?? 0) + (usage.output ?? 0),
		cacheRead: (total.cacheRead ?? 0) + (usage.cacheRead ?? 0),
		cacheWrite: (total.cacheWrite ?? 0) + (usage.cacheWrite ?? 0),
		cost: (total.cost ?? 0) + (usage.cost ?? 0),
		turns: (total.turns ?? 0) + (usage.turns ?? 0),
	};
}

function compactUsage(total: UsageState, foundKeys: Set<keyof UsageState>): UsageState | undefined {
	if (foundKeys.size === 0) return undefined;
	const compact: UsageState = {};
	for (const key of foundKeys) compact[key] = total[key];
	// U16 (Fix D): stable ledger schema — once ANY usage was seen, `cost` is
	// always present (0 when no source ever reported it) so downstream
	// consumers can rely on `usage.cost` being a number.
	compact.cost = compact.cost ?? 0;
	return compact;
}

export function parseSessionUsageFromJsonlText(text: string): UsageState | undefined {
	let total: UsageState = {};
	const foundKeys = new Set<keyof UsageState>();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const usage = usageFromValue(JSON.parse(trimmed) as unknown);
			if (!usage) continue;
			for (const key of Object.keys(usage) as Array<keyof UsageState>) foundKeys.add(key);
			total = addUsage(total, usage);
		} catch {
			// Session JSONL can contain partial/corrupt lines after interrupted workers.
		}
	}
	return compactUsage(total, foundKeys);
}

export function parseSessionUsage(filePath: string): UsageState | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		return parseSessionUsageFromJsonlText(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return undefined;
	}
}
