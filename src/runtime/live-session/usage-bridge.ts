import type { UsageState } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { usageFromValue } from "../session-usage.ts";
import { trackTaskUsage } from "../usage-tracker.ts";

/**
 * m5 (P1): the live-session usage bridge, extracted from
 * live-session-runtime.ts (1963 → ≤2000-line wc-gate relief). Owns every pure
 * shape/parser helper that maps pi SDK session surfaces onto pi-crew's usage
 * ledger — the runtime module keeps only the call sites.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function isString(value: unknown): value is string {
	return typeof value === "string";
}

/**
 * U16: SDK AgentSession session-level stats surface (aggregate tokens + cost);
 * shaped like live-agent-manager's LiveSessionHandle so the session can be
 * registered there without a cast (extra SDK fields like cost pass structurally).
 */
export interface SessionStatsLike {
	tokens?: { input?: number; output?: number; cacheWrite?: number; cacheRead?: number };
	contextUsage?: { percent?: number | null; window?: number };
}

/**
 * Type-safe extractor for message role from streaming events.
 * Handles the case where message may be a Record with a role field.
 */
function extractMessageRole(obj: Record<string, unknown> | undefined): string | undefined {
	const message = obj?.message ? asRecord(obj.message) : undefined;
	return isString(message?.role) ? message.role : undefined;
}

/**
 * Type-safe extractor for message usage from streaming events.
 * Handles the case where message may be a Record with usage data.
 */
function extractMessageUsage(obj: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	const message = obj?.message ? asRecord(obj.message) : undefined;
	return message?.usage && typeof message.usage === "object" ? (message.usage as Record<string, unknown>) : undefined;
}

/** U16 (Fix B): thin adapter — session-stats parsing is delegated to the single
 *  shared parser (`usageFromValue`), which accepts BOTH the nested SDK
 *  `SessionStats` shape (`tokens.{input,output,cacheRead,cacheWrite}` + `cost`)
 *  and flat legacy shapes. Re-exported by live-session-runtime.ts to keep its
 *  historical import surface green. */
export function usageFromStats(stats: unknown): UsageState | undefined {
	return usageFromValue(stats);
}

/** Minimal session surface the completion site needs. */
interface SessionWithStats {
	getSessionStats?: () => unknown;
}

/**
 * U16 (Fix A): the SDK surface is getSessionStats() — the old getStats()
 * name and session.stats fallback were both dead against the real SDK.
 */
export function usageFromSessionStats(session: SessionWithStats | undefined): UsageState | undefined {
	return usageFromStats(session?.getSessionStats?.());
}

/**
 * P1 (AC4): accumulate lifetime usage that survives compaction from one
 * streaming event. Only assistant `message_end` events contribute. The
 * message-level usage object is parsed by the SHARED parser so the new
 * `cacheRead` field and the message-level cost OBJECT (`{…, total}`) both land
 * as NUMBERS in the tracker — usage-tracker deltas accept numeric cost only
 * (D2 aggregate tier). Non-finite fields parse to undefined and are skipped
 * (pre-P1 the raw `typeof` check passed 0 — same arithmetic result).
 */
export function trackUsageFromMessageEndEvent(taskId: string, event: unknown): void {
	const obj = asRecord(event);
	if (obj?.type !== "message_end" || extractMessageRole(obj) !== "assistant") return;
	const raw = extractMessageUsage(obj);
	if (!raw) return;
	const usage = usageFromValue(raw);
	if (!usage) return;
	trackTaskUsage(taskId, {
		input: usage.input,
		output: usage.output,
		cacheWrite: usage.cacheWrite,
		cacheRead: usage.cacheRead,
		cost: usage.cost,
	});
}

/**
 * R6-9 (DR-03 round-6): best-effort usage extraction for the fault/watchdog
 * escape returns. The success return reports usageFromSessionStats(session as SessionWithStats | undefined),
 * but the fault/watchdog catch paths previously carried NO usage — whenever
 * embeddedWorkers routed work to the embedded tier and the task faulted, the
 * burned turns vanished from the budget (under-count). The session may be
 * disposed or partially unusable after the fault, so stats collection is
 * guarded — it can never turn a fault into a crash. Returns undefined when no
 * usable stats surface exists.
 */
export function faultPathUsage(session: SessionWithStats | undefined): UsageState | undefined {
	try {
		return usageFromSessionStats(session as SessionWithStats | undefined);
	} catch (error) {
		logInternalError("live-session.fault-usage-stats", error, "session stats unavailable on fault path");
		return undefined;
	}
}

/**
 * Type-safe extractor for tool name from streaming events.
 * Handles various event structures: { tool: { name } }, { toolName }, { name }.
 */
export function extractToolName(obj: Record<string, unknown> | undefined): string | undefined {
	if (!obj) return undefined;
	const tool = asRecord(obj.tool);
	if (isString(tool?.name)) return tool.name;
	if (isString(obj.toolName)) return obj.toolName;
	if (isString(obj.name)) return obj.name;
	return undefined;
}

export function textFromContent(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => {
		const obj = asRecord(part);
		if (!obj) return [];
		if (obj.type === "text" && typeof obj.text === "string") return [obj.text];
		if (typeof obj.content === "string") return [obj.content];
		return [];
	});
}

export function eventText(event: unknown): string[] {
	const obj = asRecord(event);
	if (!obj) return [];
	const text: string[] = [];
	if (typeof obj.text === "string") text.push(obj.text);
	text.push(...textFromContent(obj.content));
	const message = asRecord(obj.message);
	if (message) text.push(...textFromContent(message.content));
	return text.filter((entry) => entry.trim());
}

export function finalAssistantText(event: unknown): string[] {
	const obj = asRecord(event);
	if (obj?.type !== "message_end") return [];
	const message = asRecord(obj.message);
	if (message?.role !== "assistant") return [];
	return textFromContent(message.content);
}
