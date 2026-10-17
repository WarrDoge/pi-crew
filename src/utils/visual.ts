import { visibleWidth as tuiVisibleWidth } from "@earendil-works/pi-tui";

export const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

const WIDTH_CACHE_LIMIT = 256;
const widthCache = new Map<string, number>();
// PERF (2026-08-24): truncateToWidth/wrapHard measure ONE codepoint at a time;
// those 1-2 char keys thrashed the 256-entry LRU, evicting every long-string
// entry that could actually hit. Short keys get their own cache (bounded
// alphabet — hit rate ~100%) so the LRU serves only whole lines/segments.
const SHORT_WIDTH_CACHE_LIMIT = 1024;
const shortWidthCache = new Map<string, number>();

// NOTE: width measurement is delegated to pi-tui's `visibleWidth` (see below).
// pi-tui is the renderer that HARD-ABORTS the session if any line exceeds the
// terminal width by ITS measure, so our truncate/pad/wrap MUST agree with it.
// A previous hand-maintained WIDE_RANGES table diverged from pi-tui's
// grapheme+RGI-emoji model on codepoints like ⏳ U+23F3 (hourglass: we counted
// 1, pi-tui counts 2) → lines we believed fit were rejected →
// "Rendered line N exceeds terminal width (160 > 159)" crash. Delegating makes
// divergence structurally impossible.

export function visibleWidth(value: string): number {
	// Delegate to pi-tui's authoritative width model so our truncate/pad/wrap
	// can never disagree with the renderer's doRender measurement. Keep our own
	// LRU cache on top (pi-tui caches too, but this avoids repeated calls for the
	// hot render path).
	if (value.length > 4096) return tuiVisibleWidth(value);
	if (value.length <= 2) {
		const s = shortWidthCache.get(value);
		if (s !== undefined) return s;
		const w = tuiVisibleWidth(value);
		if (shortWidthCache.size >= SHORT_WIDTH_CACHE_LIMIT) {
			const first = shortWidthCache.keys().next().value;
			if (first !== undefined) shortWidthCache.delete(first);
		}
		shortWidthCache.set(value, w);
		return w;
	}
	const cached = widthCache.get(value);
	if (cached !== undefined) return cached;
	const length = tuiVisibleWidth(value);
	if (widthCache.size >= WIDTH_CACHE_LIMIT) {
		const firstKey = widthCache.keys().next().value;
		if (firstKey !== undefined) widthCache.delete(firstKey);
	}
	widthCache.set(value, length);
	return length;
}

export function __test__clearVisibleWidthCache(): void {
	widthCache.clear();
	shortWidthCache.clear();
}

export function __test__visibleWidthCacheSize(): number {
	return widthCache.size;
}

function consumeAnsi(input: string, index: number): number {
	const char = input[index];
	if (!char || char !== "\u001b") return 0;
	const next = input[index + 1];
	if (next === "[") {
		let i = index + 2;
		while (i < input.length) {
			const code = input.charCodeAt(i);
			if (code >= 0x40 && code <= 0x7e) return i - index + 1;
			i++;
		}
		return 0;
	}
	// R3-9: OSC sequences (`ESC ] … BEL` or `ESC ] … ESC \`) — OSC-8 hyperlinks
	// (pi-tui `hyperlink()`, used by the crew widget) ride this branch. The
	// truncation/wrap/sanitize helpers must treat the whole sequence as ONE
	// zero-width unit, matching pi-tui's `visibleWidth` (which already strips
	// OSC), or a clipped line would slice mid-escape and leak raw bytes into
	// the terminal. Malformed payloads (stray control char) fall back to the
	// pre-existing behaviour of treating the ESC as ordinary data.
	//
	// U6/DR4 (pi 1.0.4 adoption, 2026-10-06): APC sequences (`ESC _ … BEL` or
	// `ESC _ … ESC \`) share the exact same grammar, so they ride the same
	// scanner. pi-tui's `CURSOR_MARKER` — now a documented public contract —
	// is an APC string (`\u001b_pi:c\u0007`) that focused components emit at
	// the cursor position. Without this branch, truncateToWidth/wrapHard
	// walked the marker's `_pi:c` payload as ordinary text (~6 visible
	// columns) and could slice the sequence in half; with it, the whole
	// marker is consumed as ONE zero-width unit, matching pi-tui's
	// `visibleWidth` (which already zero-widths APC). Same malformed fallback:
	// a stray control char cannot belong to an OSC/APC payload either.
	if (next !== "]" && next !== "_") return 0;
	let i = index + 2;
	while (i < input.length) {
		const code = input.charCodeAt(i);
		if (code === 0x07) return i - index + 1; // BEL terminator
		if (code === 0x1b && input[i + 1] === "\\") return i - index + 2; // ST terminator
		if (code < 0x20) return 0; // control char cannot belong to an OSC/APC payload
		i++;
	}
	return 0;
}

function splitGraphemes(value: string): string[] {
	return Array.from(value.replace(ANSI_PATTERN, ""));
}

export function truncateToWidth(value: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	if (visibleWidth(value) <= width) return value;
	if (width <= ellipsis.length) return ellipsis.slice(0, width);
	let output = "";
	let renderedWidth = 0;
	for (let i = 0; i < value.length; ) {
		const ansiLen = consumeAnsi(value, i);
		if (ansiLen) {
			output += value.slice(i, i + ansiLen);
			i += ansiLen;
			continue;
		}
		// Read the codepoint at position i on the FULL string — NOT
		// `value[i].codePointAt(0)`, which for a surrogate pair returns the
		// lone half (≤ 0xFFFF) and slices each half separately. pi-tui's
		// visibleWidth zero-widths lone `\p{Surrogate}` halves, so 🤖 would
		// undercount as 0 and truncation would never cut (latent bug unmasked
		// once visibleWidth delegated to pi-tui).
		const codepoint = value.codePointAt(i) ?? 0;
		const nextIndex = codepoint > 0xffff ? i + 2 : i + 1;
		const segment = value.slice(i, nextIndex);
		const charWidth = visibleWidth(segment);
		if (renderedWidth + charWidth > width - ellipsis.length) {
			return `${output}${ellipsis}`;
		}
		output += segment;
		renderedWidth += charWidth;
		i = nextIndex;
	}
	return output;
}

export const truncate = truncateToWidth;

/**
 * Strip newlines and other terminal-confusing control characters from a
 * single-line label. Without this, embedded `\n`/`\r` in user-provided
 * text (run.goal, run.team, mailbox preview, agent activity, ...) breaks
 * box-drawing rows because the terminal advances to the next line in the
 * middle of a row, leaving the overlay's `│` border misaligned and the
 * dashboard appearing to "duplicate" itself below the original render.
 *
 * Preserves ANSI color/style escape sequences (\u001b[...m) which the
 * caller has already wrapped around the text via the theme adapter.
 */
export function sanitizeLine(value: string): string {
	if (!value) return "";
	let result = "";
	let i = 0;
	while (i < value.length) {
		const ansi = readAnsiCode(value, i);
		if (ansi) {
			result += ansi;
			i += ansi.length;
			continue;
		}
		const code = value.charCodeAt(i);
		// Replace any C0/C1 control char (incl. \n \r \t \v \f and 0x7F-0x9F)
		// with a single space; everything else is passed through verbatim.
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			result += " ";
			i += 1;
			continue;
		}
		result += value[i];
		i += 1;
	}
	return result;
}

/** R4-B1 (2026-10-17): neutralize UNTRUSTED (worker-sourced) single-line
 *  text BEFORE any theme wrap. `sanitizeLine` deliberately preserves ALL
 *  well-formed escape sequences (theme colors ride CSI SGR and pi-tui's
 *  OSC-8/APC contracts), which makes it wrong for worker output/mailbox
 *  bodies/activity text: OSC-52 (clipboard write — paste-to-execute on
 *  kitty/tmux set-clipboard-on), OSC-8 (clickable links — no scheme
 *  allowlist in the open dispatch), title/alt-screen/cursor spoofing and APC
 *  payloads all pass verbatim, and pi-tui zero-widths them so the width
 *  guard never trips (audit PART D). Spec, per line, before theme wrap:
 *  (1) strip ALL OSC, (2) strip ALL APC, (3) strip CSI EXCEPT SGR-shaped
 *  `ESC[…m` (keep colors), (4) strip DCS + bare ESC, (5) remaining C0/C1 →
 *  space. Trusted paths keep sanitizeLine and may re-add their OWN OSC-8
 *  AFTER sanitization. */
export function sanitizeUntrustedLine(value: string): string {
	if (!value) return "";
	let result = "";
	let i = 0;
	while (i < value.length) {
		const char = value[i];
		if (char === "\u001b") {
			const next = value[i + 1];
			// (1)+(2) OSC (`ESC ]`) and APC (`ESC _`) — stripped wholesale when
			// well-formed; malformed (no BEL/ST terminator) falls through to the
			// bare-ESC drop so the payload cannot smuggle through.
			if (next === "]" || next === "_") {
				const len = consumeAnsi(value, i);
				i += len > 0 ? len : 1;
				continue;
			}
			// (3) CSI (`ESC [`) — keep ONLY SGR-shaped sequences (final byte `m`).
			// Non-SGR CSI (screen clear / alt-screen / cursor / mouse-mode / …) is
			// dropped; malformed CSI drops the ESC and the payload hits the C0/C1
			// rule below.
			if (next === "[") {
				const len = consumeAnsi(value, i);
				if (len > 0) {
					const seq = value.slice(i, i + len);
					if (seq.endsWith("m")) result += seq;
					i += len;
					continue;
				}
				i += 1;
				continue;
			}
			// (4) DCS (`ESC P … ST/BEL`) and SOS/PM (`ESC X` / `ESC ^`): strip the
			// WHOLE string sequence (payload included) when terminated; malformed
			// drops introducer+byte. Bare ESC drops just the ESC byte.
			if (next === "P" || next === "X" || next === "^") {
				let j = i + 2;
				let terminated = false;
				while (j < value.length) {
					const c = value.charCodeAt(j);
					if (c === 0x07) {
						j += 1;
						terminated = true;
						break;
					}
					if (c === 0x1b && value[j + 1] === "\\") {
						j += 2;
						terminated = true;
						break;
					}
					if (c < 0x20) break; // malformed — control char cannot be in the payload
					j += 1;
				}
				i = terminated ? j : i + 2;
				continue;
			}
			i += 1;
			continue;
		}
		const code = value.charCodeAt(i);
		// (5) remaining C0/C1 control chars (incl. \n \r \t and 0x7F-0x9F) → space.
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			result += " ";
			i += 1;
			continue;
		}
		result += value[i];
		i += 1;
	}
	return result;
}

export function pad(value: string, width: number): string {
	const current = visibleWidth(value);
	if (current >= width) return value;
	return `${value}${" ".repeat(width - current)}`;
}

function readAnsiCode(input: string, index: number): string | undefined {
	const ansiLength = consumeAnsi(input, index);
	if (ansiLength > 0) return input.slice(index, index + ansiLength);
	return undefined;
}

function takeCodePoint(input: string, index: number): { chunk: string; nextIndex: number } {
	const code = input.codePointAt(index);
	if (code === undefined) return { chunk: "", nextIndex: index + 1 };
	if (code >= 0xd800 && code <= 0xdbff && index + 1 < input.length) {
		return { chunk: input.slice(index, index + 2), nextIndex: index + 2 };
	}
	return { chunk: input[index] ?? "", nextIndex: index + 1 };
}

export function wrapHard(value: string, width: number): string[] {
	if (width <= 0 || !value) return [];
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	let i = 0;
	while (i < value.length) {
		const ansi = readAnsiCode(value, i);
		if (ansi) {
			current += ansi;
			i += ansi.length;
			continue;
		}
		const { chunk, nextIndex } = takeCodePoint(value, i);
		const chunkWidth = visibleWidth(chunk);
		if (chunkWidth > width) {
			lines.push(current ? current + chunk : chunk);
			current = "";
			currentWidth = 0;
			i = nextIndex;
			continue;
		}
		if (currentWidth + chunkWidth > width) {
			if (current) lines.push(current);
			current = chunk;
			currentWidth = chunkWidth;
			i = nextIndex;
			continue;
		}
		current += chunk;
		currentWidth += chunkWidth;
		i = nextIndex;
	}
	if (current) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

export interface VisualTruncateResult {
	visualLines: string[];
	skippedCount: number;
}

export function truncateToVisualLines(text: string, maxVisualLines: number, width: number, paddingX = 0): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}
	const effectiveWidth = Math.max(1, width - paddingX * 2);
	const limit = Math.max(1, maxVisualLines);
	const visualLines = text.split("\n").flatMap((line) => wrapHard(pad(line, Math.max(0, effectiveWidth)).trimEnd(), effectiveWidth));
	if (visualLines.length <= limit) return { visualLines, skippedCount: 0 };
	const truncated = visualLines.slice(-limit);
	return { visualLines: truncated, skippedCount: visualLines.length - limit };
}

/**
 * PERF (2026-08-24): tail-windowed twin of truncateToVisualLines. Wraps lines
 * from the END backwards and stops as soon as `maxVisualLines` visual lines
 * exist — O(visible window) instead of O(whole transcript). `skippedCount`
 * counts skipped SOURCE lines (a lower bound on skipped visual lines; the
 * caller's total display therefore reads "≥ N lines" when scrolled to bottom).
 */
export function truncateToVisualLinesTail(text: string, maxVisualLines: number, width: number, paddingX = 0): VisualTruncateResult {
	if (!text) return { visualLines: [], skippedCount: 0 };
	const effectiveWidth = Math.max(1, width - paddingX * 2);
	const limit = Math.max(1, maxVisualLines);
	const sourceLines = text.split("\n");
	const wrapped: string[][] = [];
	let collected = 0;
	let index = sourceLines.length - 1;
	while (index >= 0 && collected < limit) {
		const w = wrapHard(pad(sourceLines[index]!, Math.max(0, effectiveWidth)).trimEnd(), effectiveWidth);
		wrapped.push(w);
		collected += w.length;
		index -= 1;
	}
	const visualLines = wrapped.reverse().flat().slice(-limit);
	return { visualLines, skippedCount: index + 1 };
}
