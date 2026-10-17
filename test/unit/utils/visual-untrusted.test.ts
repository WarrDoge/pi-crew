/**
 * visual-untrusted.test.ts — R4-B1 + R5-M-A3 (2026-10-17 wave-2a) pinning
 * tests for `sanitizeUntrustedLine` (src/utils/visual.ts, audit PART D spec).
 *
 * `sanitizeLine` deliberately preserves ALL well-formed escape sequences
 * (theme colors / pi-tui OSC-8 / APC contracts) — correct for trusted text,
 * an injection hole for worker-sourced text: OSC-52 (clipboard write),
 * OSC-8 (clickable link, no scheme allowlist), title/alt-screen spoofing,
 * non-SGR CSI, APC. The untrusted variant must neutralize all of those while
 * KEEPING SGR color sequences so themes survive on worker output.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { renderTranscriptPane } from "../../../src/ui/dashboard-panes/transcript-pane.ts";
import type { RunUiSnapshot } from "../../../src/ui/snapshot-types.ts";
import { sanitizeLine, sanitizeUntrustedLine } from "../../../src/utils/visual.ts";

const ESC = "\u001b";

test("sanitizeUntrustedLine: OSC-52 clipboard payload renders INERT (R4-B1 chain B)", () => {
	const poison = `${ESC}]52;c;${Buffer.from("rm -rf ~").toString("base64")}${ESC}\\`;
	const out = sanitizeUntrustedLine(poison);
	assert.ok(!out.includes("]52"), `OSC-52 must be stripped, got ${JSON.stringify(out)}`);
	assert.ok(!out.includes(ESC), `no escape bytes may survive, got ${JSON.stringify(out)}`);
});

test("sanitizeUntrustedLine: OSC-8 file:// hyperlink renders INERT", () => {
	const link = `${ESC}]8;;file:///etc/passwd${ESC}\\click me${ESC}]8;;${ESC}\\`;
	const out = sanitizeUntrustedLine(link);
	assert.ok(!out.includes("]8"), `OSC-8 must be stripped, got ${JSON.stringify(out)}`);
	assert.ok(!out.includes(ESC), `no escape bytes may survive, got ${JSON.stringify(out)}`);
	assert.ok(out.includes("click me"), "the visible label text survives");
});

test("sanitizeUntrustedLine: BEL-terminated OSC and APC are stripped too", () => {
	assert.ok(!sanitizeUntrustedLine(`${ESC}]0;pwned-title\u0007rest`).includes(ESC));
	assert.ok(!sanitizeUntrustedLine(`${ESC}_pi:c\u0007rest`).includes(ESC));
	assert.ok(sanitizeUntrustedLine(`${ESC}_pi:c\u0007rest`).includes("rest"));
});

test("sanitizeUntrustedLine: keeps SGR (colors), drops non-SGR CSI", () => {
	const sgr = `${ESC}[31mred${ESC}[0m`;
	assert.equal(sanitizeUntrustedLine(sgr), sgr);
	// screen clear / alt-screen / cursor-report CSI are dropped entirely
	for (const csi of [`${ESC}[2J`, `${ESC}[?1049h`, `${ESC}[6n`, `${ESC}[1;1H`]) {
		const out = sanitizeUntrustedLine(`a${csi}b`);
		assert.equal(out, "ab", `non-SGR CSI ${JSON.stringify(csi)} must be dropped`);
		assert.ok(!out.includes(ESC));
	}
});

test("sanitizeUntrustedLine: DCS, bare ESC, remaining C0/C1 → space/drop (PART D 4-5)", () => {
	assert.equal(sanitizeUntrustedLine(`a${ESC}P1;2q data${ESC}\\b`), "ab");
	assert.equal(sanitizeUntrustedLine(`a${ESC}b`), "ab");
	assert.equal(sanitizeUntrustedLine("a\u0000b\u0007c"), "a b c");
	assert.equal(sanitizeUntrustedLine("a\u009fb"), "a b");
});

test("sanitizeUntrustedLine: contrast with sanitizeLine (which preserves OSC by design)", () => {
	const osc52 = `${ESC}]52;c;aGk=${ESC}\\`;
	assert.ok(sanitizeLine(osc52).includes("]52"), "sanitizeLine keeps OSC (trusted contract) — the reason the untrusted variant exists");
	assert.ok(!sanitizeUntrustedLine(osc52).includes("]52"));
});

test("pane-level: transcript pane renders worker output through the untrusted sanitizer", () => {
	const poison = `done ${ESC}]52;c;aGk=${ESC}\\ ${ESC}]8;;file:///tmp/x${ESC}\\link${ESC}]8;;${ESC}\\`;
	const snapshot = { recentOutputLines: [poison], tasks: [] } as unknown as RunUiSnapshot;
	const lines = renderTranscriptPane(snapshot).join("\n");
	assert.ok(!lines.includes("]52"), `pane leaked OSC-52: ${JSON.stringify(lines)}`);
	assert.ok(!lines.includes("]8"), `pane leaked OSC-8: ${JSON.stringify(lines)}`);
	assert.ok(!lines.includes(ESC), `pane leaked escape bytes: ${JSON.stringify(lines)}`);
	assert.ok(lines.includes("link"), "visible link label survives");
});
