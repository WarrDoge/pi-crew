/**
 * OSC 7501 "Program Status" wire format — VENDORED from upstream
 * `@earendil-works/pi-tui` v1.1.0 `packages/tui/src/program-status.ts`
 * (MIT © 2025 Mario Zechner — upstream file is a 53-line pure-declaration
 * module with no imports; spec:
 * https://www.superlogical.com/rex/docs/build/program-status).
 *
 * Vendored instead of imported because:
 *  - pi-crew declares the `@earendil-works/pi-tui` peer as `"*"` with NO
 *    minimum-version floor (see src/ui/pi-ui-compat.ts retention policy), so
 *    any static/deep import could crash hosts older than 1.1.0, and
 *  - cold-verify (upgrade research round 2, item B-1): `PROGRAM_STATUS_QUERY`
 *    is NOT re-exported from `tui/src/index.ts` — only `formatProgramStatus`
 *    and the type are, and only at 1.1.0.
 *
 * pi-crew usage note: we only ever WRITE status REPORTS via
 * `formatProgramStatus` (consumed by src/ui/terminal-status.ts).
 * `PROGRAM_STATUS_QUERY`/`isProgramStatusReply` are vendored for parity with
 * the upstream feature-detect pair but are intentionally NEVER sent: the
 * reply arrives on stdin, which the host TUI owns — an unsolicited reply
 * would be misparsed as user input. Terminals that do not understand OSC
 * 7501 discard the reports (standard OSC behavior), so writing reports
 * unconditionally is safe.
 *
 * Keep this file behavior-free (pure declarations, mirrors upstream) — do not
 * add pi-crew state or I/O here.
 */

export interface ProgramStatus {
	/** `clear` removes the status instead of reporting one. */
	state: "idle" | "working" | "blocked" | "done" | "error" | "clear";
	/** Stable program name, `[A-Za-z0-9_.+-]{1,32}`. Other values are omitted. */
	app?: string;
	/** What a blocked program waits for. Omitted for other states. */
	kind?: "permission" | "question" | "auth";
	/** One human-readable line. Control characters become spaces; longer text is cut to the spec limit. */
	message?: string;
}

/** Feature detection query. A supporting terminal replies with the same body. */
export const PROGRAM_STATUS_QUERY = "\x1b]7501;?\x1b\\";

/** The reply to {@link PROGRAM_STATUS_QUERY}. Later spec revisions may add pairs after the `?`. */
export function isProgramStatusReply(sequence: string): boolean {
	return /^\x1b\]7501;\?[^\x07\x1b]*(?:\x07|\x1b\\)$/.test(sequence);
}

const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;
/** Decoded `msg` limit. Its base64 encoding stays under the 2732-byte encoded limit. */
const MAX_MESSAGE_BYTES = 2048;

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return text.slice(0, end);
}

/** Encode a status report. Terminals discard reports whose text contains control characters, so they are replaced. */
export function formatProgramStatus(status: ProgramStatus): string {
	const pairs = [`state=${status.state}`];
	if (status.app !== undefined && APP_PATTERN.test(status.app)) pairs.push(`app=${status.app}`);
	if (status.state === "blocked" && status.kind) pairs.push(`kind=${status.kind}`);
	const message = truncateUtf8((status.message ?? "").replace(CONTROL_CHARACTERS, " ").trim(), MAX_MESSAGE_BYTES);
	if (message) pairs.push(`msg=${Buffer.from(message, "utf8").toString("base64")}`);
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}
