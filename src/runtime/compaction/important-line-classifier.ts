/**
 * Important-Line Classifier (P0-B) — scan middle slice of a truncated value
 * for diagnostic lines worth preserving between head and tail.
 *
 * Ported from Hypa's `ImportantLineClassifier.cs` (5 regexes) and the
 * middle-scanning portion of `Stages/TruncationStage.cs:24-46`, adapted to TS
 * (no `[GeneratedRegex]` AOT) and to pi-crew's head(75%)/tail(25%) split.
 *
 * Design rationale:
 * - Patterns are intentionally OVER-INCLUSIVE. False positives preserve
 *   harmless lines; false negatives drop critical diagnostics, which is
 *   unacceptable (the whole point of this module). Hypa uses the same
 *   over-inclusive design.
 * - Patterns are evaluated against a WHOLE line, not against the raw
 *   truncated slice, so a match at a line boundary is reliable.
 * - The `splitWithImportantLines` helper performs the head/tail split AND
 *   greedily picks whole important lines from the middle that fit inside
 *   `slackFactor * maxChars` (default 15% slack). Callers compose their own
 *   marker using the returned parts — keeping `compactString` (marker
 *   "compacted ... chars, head+tail preserved") and `readIfSmall` (marker
 *   "truncated ... bytes, head+tail preserved") backward-compatible when no
 *   important lines are present.
 *
 * K6/K7 (DR-03 round-6):
 * - `reserveChars` lets the caller (TruncationStage) subtract the composed
 *   marker + separator + joined-important-line overhead from the head+tail
 *   budget, so the FINAL composed result fits `maxChars` + small constant
 *   instead of stacking unbudgeted overhead on top (~1.15×maxChars).
 * - Head/tail/middle boundaries are surrogate-pair-safe: a code-unit index
 *   that would split an astral pair (emoji, CJK extensions) is backed off
 *   so every emitted part contains only whole code points.
 */

/** Default fraction of `maxChars` available for important-line content. */
export const DEFAULT_SLACK_FACTOR = 0.15;
/** Default cap on candidate lines before slack-budget selection. */
export const DEFAULT_MAX_IMPORTANT_LINES = 30;

function isHighSurrogateUnit(codeUnit: number): boolean {
	return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogateUnit(codeUnit: number): boolean {
	return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * K7: back a head-end boundary off while it would split a surrogate pair.
 * `value.slice(0, boundary)` must never end on a lone high surrogate — if the
 * code unit at `boundary - 1` is a high surrogate, its low partner lives at
 * `boundary` and slicing there would orphan both halves; the boundary walks
 * back so the whole pair falls into the (dropped) middle instead.
 */
export function safeHeadBoundary(value: string, end: number): number {
	let boundary = Math.max(0, Math.min(end, value.length));
	while (boundary > 0 && isHighSurrogateUnit(value.charCodeAt(boundary - 1))) boundary -= 1;
	return boundary;
}

/**
 * K7: advance a tail-start boundary while it would split a surrogate pair.
 * `value.slice(boundary)` must never start on a lone low surrogate — if the
 * code unit at `boundary` is a low surrogate, its high partner lives at
 * `boundary - 1` and slicing there would orphan both halves; the boundary
 * walks forward so the whole pair stays in the (dropped) middle instead.
 */
export function safeTailBoundary(value: string, start: number): number {
	let boundary = Math.max(0, Math.min(start, value.length));
	while (boundary < value.length && isLowSurrogateUnit(value.charCodeAt(boundary))) boundary += 1;
	return boundary;
}

/** Diagnostic patterns. Anchored where safe to avoid matching noise. */
export const IMPORTANT_LINE_PATTERNS: readonly RegExp[] = [
	// error keywords — NOTE: "warning" is intentionally excluded here; it has
	// its own case-sensitive pattern below so that the common prose word
	// "warning" does not over-match. (Hypa does the same split.)
	/\b(error|failed|exception|fatal|panic)\b/i,
	// file:line diagnostic — `child-pi.ts:383:`, `App.tsx:42:`
	/\w+\.\w+:\d+:/,
	// HTTP 4xx / 5xx — bounded so it does not match phone numbers etc.
	/\b[45]\d{2}\b/,
	// k8s / linter "Warning" event (case-sensitive so prose is not matched)
	/\bWarning\b/,
	// compiler / linter diagnostic id — `TS2304`, `CS0246`, `ES1234`
	/\b[A-Z]{2,4}\d{3,5}\b/,
];

/** True iff `line` matches at least one important-line pattern. */
export function isImportantLine(line: string): boolean {
	if (!line) return false;
	for (const pattern of IMPORTANT_LINE_PATTERNS) {
		if (pattern.test(line)) return true;
	}
	return false;
}

/**
 * Extract up to `maxLines` important lines from `text`. Lines are split on
 * `\n` (also handles `\r\n`). Order preserved; duplicates kept (callers may
 * want to see the same diagnostic twice if it appears twice — that often
 * signals a recurring failure).
 */
export function extractImportantLines(text: string, maxLines = 30): string[] {
	if (!text || maxLines <= 0) return [];
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (out.length >= maxLines) break;
		if (isImportantLine(line)) out.push(line);
	}
	return out;
}

export interface TruncationSplit {
	/** The first 75% of the value (by char count), verbatim. */
	head: string;
	/** The last 25% of the value (by char count), verbatim. */
	tail: string;
	/**
	 * Important lines from the middle slice, greedily picked (whole lines) so
	 * the joined length fits inside `slackFactor * maxChars`. Empty when
	 * `preserveImportant` is false OR no important lines are present OR none
	 * fit the slack budget.
	 */
	importantLines: string[];
	/** `value.length - headTailBudget` — chars dropped if no important lines
	 * preserved. `headTailBudget` is `maxChars - reserveChars`; with no
	 * reserve (the default) this equals `value.length - maxChars`. */
	baseDropped: number;
}

export interface SplitOptions {
	/** When false, important-line scanning is skipped (assistant-text mode). */
	preserveImportant?: boolean;
	/** Hard cap on candidate lines before slack-budget selection. Default 30. */
	maxImportantLines?: number;
	/**
	 * Fraction of `maxChars` available for important-line content. Default 0.15
	 * ({@link DEFAULT_SLACK_FACTOR}).
	 */
	slackFactor?: number;
	/**
	 * K6: code units the CALLER will compose AROUND head+tail (marker text,
	 * separators, joined important lines). The head+tail budget shrinks by
	 * this reserve so the caller's final composed result fits `maxChars` +
	 * small constant instead of stacking unbudgeted overhead on top. Default
	 * 0 — legacy semantics where head+tail alone consume the full maxChars.
	 */
	reserveChars?: number;
}

/**
 * Split `value` into head + important-middle + tail, returning the parts.
 * The caller is responsible for composing the final result (marker + glue)
 * because the marker wording differs between `compactString` and
 * `readIfSmall`.
 *
 * When no important lines are picked, the returned `importantLines` is `[]`
 * and the marker wording stays bit-identical to the pre-P0-B format.
 */
export function splitWithImportantLines(value: string, maxChars: number, opts: SplitOptions = {}): TruncationSplit {
	if (value.length <= maxChars) {
		return { head: value, tail: "", importantLines: [], baseDropped: 0 };
	}
	// K6: reserve the caller's composed overhead (marker + separators +
	// joined important lines) out of the head+tail budget. Clamped so at
	// least one code unit of budget survives even when the reserve exceeds
	// maxChars (pathologically small budgets — the marker alone dominates).
	const reserve = Math.max(0, Math.min(Math.floor(opts.reserveChars ?? 0), maxChars - 1));
	const headTailBudget = Math.max(1, maxChars - reserve);
	const headLen = Math.floor(headTailBudget * 0.75);
	const tailLen = headTailBudget - headLen;
	// K7: surrogate-safe boundaries. Raw code-unit slices previously split
	// astral pairs at the 75% head boundary and the tail start, emitting
	// lone surrogates (mojibake) into the compacted output. Back off while
	// the boundary would split a pair — the whole pair then falls into the
	// middle (dropped) region instead of being broken across head/tail.
	const headEnd = safeHeadBoundary(value, headLen);
	const tailStart = safeTailBoundary(value, value.length - tailLen);
	const head = value.slice(0, headEnd);
	const tail = value.slice(tailStart);

	if (opts.preserveImportant === false) {
		return {
			head,
			tail,
			importantLines: [],
			baseDropped: value.length - headTailBudget,
		};
	}

	const slackFactor = opts.slackFactor ?? DEFAULT_SLACK_FACTOR;
	const slackChars = Math.max(0, Math.floor(maxChars * slackFactor));
	const maxCandidates = opts.maxImportantLines ?? DEFAULT_MAX_IMPORTANT_LINES;
	const middle = value.slice(headEnd, tailStart);
	const candidates = extractImportantLines(middle, maxCandidates);

	// Greedily pick whole lines that fit in the slack budget.
	const chosen: string[] = [];
	let used = 0;
	for (const line of candidates) {
		const addLen = (chosen.length > 0 ? 1 : 0) + line.length; // '\n' separator
		if (used + addLen > slackChars) break;
		chosen.push(line);
		used += addLen;
	}

	return {
		head,
		tail,
		importantLines: chosen,
		baseDropped: value.length - headTailBudget,
	};
}
