/**
 * TruncationStage — head(75%) + important-middle + tail(25%) compression.
 *
 * Wraps the head/tail/important-line split (from P0-B's `important-line-classifier.ts`)
 * as a pipeline stage so it composes with other stages (ANSI strip, blank
 * collapse, etc.). When the input is at or below `maxChars`, returns the
 * input unchanged (idempotent — the pipeline gate then marks this stage as
 * a no-op).
 *
 * Marker wording is parameterized so the SAME stage serves both `compactString`
 * ("compacted ... chars") and `readIfSmall` ("truncated ... chars") with
 * their distinct separators. Defaults match `compactString`'s pre-P0-A output
 * exactly so that callers that do not opt into additional stages get
 * bit-identical output (L4 backward-compat safety).
 *
 * K6 (DR-03 round-6): budget accounting. The kept important lines are part
 * of the OUTPUT, so their joined length (+ the "\n" seam) is reserved OUT
 * of the head+tail budget (`splitWithImportantLines` `reserveChars`). The
 * composed result therefore fits `maxChars` + {@link TRUNCATION_MARKER_ALLOWANCE}
 * (marker budget) instead of the pre-K6 ~1.15×maxChars, where head+tail
 * alone consumed the full budget and the important-line slack stacked on
 * top unbudgeted. When no important lines are kept, sizing is bit-identical
 * to the legacy behavior (no reserve). The stage's own monotonic-shrink
 * invariant is preserved: if the composed result would be ≥ the input, the
 * input is returned unchanged.
 */
import type { ICompactStage } from "../compact-pipeline.ts";
import { splitWithImportantLines } from "../important-line-classifier.ts";

export interface TruncationMarkerConfig {
	/** "compacted" (compactString default) or "truncated" (readIfSmall default). */
	verb: "compacted" | "truncated";
	/** Unit reported in the marker. Both callers currently use "chars" post-Sprint 1. */
	unit: "chars" | "bytes";
	/** Newline(s) between `head` and the marker line. compactString uses "\n"; readIfSmall uses "\n\n". */
	headSeparator: string;
	/** Newline(s) between the marker (or joined important lines) and `tail`. Both callers use "\n". */
	tailSeparator: string;
}

const DEFAULT_MARKER: TruncationMarkerConfig = {
	verb: "compacted",
	unit: "chars",
	headSeparator: "\n",
	tailSeparator: "\n",
};

/**
 * K6 "small constant" = the marker budget: the longest marker template
 * (with-important-lines variant, 6-digit counters) plus separators plus
 * digit drift. The head+tail budget absorbs the kept-important-line content
 * (joined length + seam), so the composed result exceeds `maxChars` by at
 * most this marker budget — never by the old unbudgeted ~15% slack.
 */
export const TRUNCATION_MARKER_ALLOWANCE = 160;

export class TruncationStage implements ICompactStage {
	readonly id = "truncation";
	private readonly maxChars: number;
	private readonly preserveImportant: boolean;
	private readonly marker: TruncationMarkerConfig;
	constructor(
		maxChars: number,
		opts: {
			preserveImportant?: boolean;
			marker?: Partial<TruncationMarkerConfig>;
		} = {},
	) {
		if (!Number.isFinite(maxChars) || maxChars <= 0) {
			throw new Error(`TruncationStage: maxChars must be a positive finite number, got ${maxChars}`);
		}
		this.maxChars = maxChars;
		this.preserveImportant = opts.preserveImportant !== false;
		this.marker = { ...DEFAULT_MARKER, ...(opts.marker ?? {}) };
	}
	apply(text: string): string {
		if (text.length <= this.maxChars) return text;
		// K6: two-pass budget accounting.
		// Pass 1 (today's semantics, full-budget split) learns which important
		// lines are kept — their joined length is part of the OUTPUT and must be
		// reserved out of the head+tail budget instead of stacking on top.
		const pass1 = splitWithImportantLines(text, this.maxChars, {
			preserveImportant: this.preserveImportant,
		});
		const joined = pass1.importantLines.join("\n");
		// Reserve exactly the kept content (+ the "\n" seam between marker and
		// joined lines). The marker text + separators stay as the tolerated
		// TRUNCATION_MARKER_ALLOWANCE overhead; when no important lines are
		// kept the reserve is 0 and sizing is bit-identical to legacy.
		const reserve = joined.length > 0 ? joined.length + 1 : 0;
		// Pass 2 re-slices head+tail against the shrunken budget. It is a pure
		// budgeted slice: preserveImportant:false skips the (already done)
		// scan, and pass-1's lines are guaranteed to sit inside pass-2's
		// dropped middle — the pass-2 middle is a superset of pass-1's because
		// the shrunken head/tail regions are subsets of pass-1's.
		const { head, tail, baseDropped } = splitWithImportantLines(text, this.maxChars, {
			preserveImportant: false,
			reserveChars: reserve,
		});
		const importantLines = pass1.importantLines;
		let result: string;
		if (importantLines.length === 0) {
			result = `${head}${this.marker.headSeparator}...[pi-crew ${this.marker.verb} ${baseDropped} ${this.marker.unit}, head+tail preserved]...${this.marker.tailSeparator}${tail}`;
		} else {
			const remaining = text.length - head.length - tail.length - joined.length;
			result = `${head}${this.marker.headSeparator}...[pi-crew ${this.marker.verb} ${baseDropped} ${this.marker.unit}, head+tail + ${importantLines.length} important lines preserved, ${remaining} ${this.marker.unit} remaining dropped]...\n${joined}${this.marker.tailSeparator}${tail}`;
		}
		// Defense-in-depth: this stage's own monotonic-shrink invariant. The
		// pipeline gate is a SECOND line of defense. With the K6 budget the
		// composed result is ≤ maxChars + marker budget, so this guard only
		// fires for inputs barely over maxChars (where returning the input
		// verbatim is still within the allowance) or arithmetic bugs.
		if (result.length >= text.length) return text;
		return result;
	}
}
