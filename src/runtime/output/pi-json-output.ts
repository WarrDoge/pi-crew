import { usageFromValue } from "../session-usage.ts";

export interface ParsedPiUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	turns?: number;
}

export interface ParsedPiJsonOutput {
	jsonEvents: number;
	textEvents: string[];
	finalText?: string;
	usage?: ParsedPiUsage;
	/** Unified patches extracted from tool_result events (edit tool patch field) */
	patches?: string[];
	/** Model/provider error messages extracted from message_end events (e.g.
	 * "429 ... overloaded"). Used to detect runs that exited 0 but produced
	 * nothing because the model was rate-limited — see task-runner 429 fix. */
	errorMessages?: string[];
	/** DR-01 (deep review 2026-10-14): true when the LAST assistant
	 * `message_end` event in the stream carried no non-empty text — the
	 * session settled without a final answer. Upstream 429 exhaustion
	 * manifests as a chain of EMPTY assistant message_end events (content [],
	 * usage 0) between auto-retry cycles — never as stopReason:"error" — so
	 * `errorMessages` stays empty and `finalText` keeps an early pre-outage
	 * sentence. undefined when no assistant message_end was parsed at all. */
	settledWithoutAnswer?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function mergeUsage(target: ParsedPiUsage, source: ParsedPiUsage): ParsedPiUsage {
	return {
		input: source.input ?? target.input,
		output: source.output ?? target.output,
		cacheRead: source.cacheRead ?? target.cacheRead,
		cacheWrite: source.cacheWrite ?? target.cacheWrite,
		cost: source.cost ?? target.cost,
		turns: source.turns ?? target.turns,
	};
}

/**
 * U16: usage extraction is delegated to the single shared parser
 * (`usageFromValue` in session-usage.ts) so the subprocess tier accepts BOTH
 * cost shapes — the session-level aggregate NUMBER and the message-level
 * OBJECT with `total` (@earendil-works/pi-ai `Usage.cost`) — instead of
 * silently dropping the object form. Same field aliases as before
 * (inputTokens/input_tokens/cost_usd/…) and same nested fallbacks
 * (usage/message/tokenUsage/tokens/stats).
 */
function extractUsage(value: unknown): ParsedPiUsage | undefined {
	return usageFromValue(value);
}

function textFromContent(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const text: string[] = [];
	for (const part of content) {
		const obj = asRecord(part);
		if (!obj) continue;
		if (obj.type === "text" && typeof obj.text === "string") text.push(obj.text);
		else if (typeof obj.content === "string") text.push(obj.content);
	}
	return text;
}

/** Extract assistant-text fragments from a parsed Pi JSON event.
 *  Exported so {@link ChildPiLineObserver} can capture the RAW (uncapped)
 *  assistant text for the authoritative result, mirroring the extraction
 *  order this function uses inside {@link parsePiJsonOutput}. */
export function extractText(value: unknown): string[] {
	const obj = asRecord(value);
	if (!obj) return [];
	const message = asRecord(obj.message);
	if (message?.role !== undefined && message.role !== "assistant") return [];
	const text: string[] = [];
	if (typeof obj.text === "string") text.push(obj.text);
	if (typeof obj.output === "string") text.push(obj.output);
	if (typeof obj.finalOutput === "string") text.push(obj.finalOutput);
	if (typeof obj.final_output === "string") text.push(obj.final_output);
	if (!message) text.push(...textFromContent(obj.content));
	if (message) text.push(...textFromContent(message.content));
	return text.filter((entry) => entry.trim().length > 0);
}

/** True for `message_end` events whose message is assistant-role. Feeds the
 *  settledWithoutAnswer flag (DR-01): see ParsedPiJsonOutput.settledWithoutAnswer. */
function isAssistantMessageEnd(event: unknown): boolean {
	const obj = asRecord(event);
	if (obj?.type !== "message_end") return false;
	const message = asRecord(obj.message);
	return message?.role === "assistant";
}

export function parsePiJsonOutput(stdout: string): ParsedPiJsonOutput {
	let jsonEvents = 0;
	const textEvents: string[] = [];
	const patches: string[] = [];
	const errorMessages: string[] = [];
	let usage: ParsedPiUsage | undefined;
	let sawAssistantMessageEnd = false;
	let lastAssistantMessageHadText = false;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed) as unknown;
		} catch {
			continue;
		}
		jsonEvents++;
		const eventTexts = extractText(event);
		textEvents.push(...eventTexts);
		if (isAssistantMessageEnd(event)) {
			sawAssistantMessageEnd = true;
			lastAssistantMessageHadText = eventTexts.length > 0;
		}
		// Extract unified patches from tool_result events
		extractPatch(event, patches);
		// Extract provider/model error messages from message_end events (429 fix).
		const errMsg = extractErrorMessage(event);
		if (errMsg) errorMessages.push(errMsg);
		const eventUsage = extractUsage(event);
		if (eventUsage) usage = mergeUsage(usage ?? {}, eventUsage);
	}
	return {
		jsonEvents,
		textEvents,
		finalText: textEvents.length > 0 ? textEvents[textEvents.length - 1] : undefined,
		usage,
		patches: patches.length > 0 ? patches : undefined,
		errorMessages: errorMessages.length > 0 ? errorMessages : undefined,
		settledWithoutAnswer: sawAssistantMessageEnd ? !lastAssistantMessageHadText : undefined,
	};
}

/**
 * Pull the provider/model error message out of a `message_end` event. The shape
 * is `{type:"message_end", message:{role:"assistant", content:[], errorMessage:"429 ...", stopReason:"error"}}`.
 * Returns undefined for events without an errorMessage.
 */
function extractErrorMessage(event: unknown): string | undefined {
	const obj = asRecord(event);
	if (!obj) return undefined;
	// message_end events carry the error on the nested message object.
	const message = asRecord(obj.message) ?? obj;
	const errorMessage = message.errorMessage;
	return typeof errorMessage === "string" && errorMessage.trim() ? errorMessage.trim() : undefined;
}

/**
 * Extract unified patches from a tool_result event.
 * pi's edit tool now includes a `patch` field (standard unified diff format).
 * We detect it by looking for lines starting with "---" or "+++" which indicate
 * unified diff format.
 */
function extractPatch(event: unknown, patches: string[]): void {
	const obj = asRecord(event);
	if (obj?.type !== "tool_result") return;

	const content = obj.content;
	if (!Array.isArray(content)) return;

	for (const item of content) {
		const part = asRecord(item);
		if (part?.type !== "text") continue;
		const text = typeof part.text === "string" ? part.text : "";

		// Check if this looks like a unified patch (starts with "---" or "+++")
		if (text.includes("--- a/") || text.includes("diff ---")) {
			patches.push(text);
		}
	}
}
