/**
 * B-1: OSC 7501 program-status wire format (vendored from
 * @earendil-works/pi-tui v1.1.0 `packages/tui/src/program-status.ts`, MIT).
 *
 * These tests pin the vendored format byte-for-byte against the upstream
 * semantics: pair ordering (state, app, kind, msg), base64 msg encoding,
 * control-character scrubbing, the 2048-byte truncation limit, app-pattern
 * validation, kind-gating (only on `blocked`), and the feature-detect
 * query/reply pair. If upstream changes the format, re-vendor + update here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatProgramStatus, isProgramStatusReply, PROGRAM_STATUS_QUERY } from "../../../src/ui/program-status.ts";

const ST = "\x1b\\";
const BEL = "\x07";

function b64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

test("state-only report has exactly one pair", () => {
	assert.equal(formatProgramStatus({ state: "working" }), `\x1b]7501;state=working${ST}`);
	assert.equal(formatProgramStatus({ state: "idle" }), `\x1b]7501;state=idle${ST}`);
	assert.equal(formatProgramStatus({ state: "clear" }), `\x1b]7501;state=clear${ST}`);
});

test("full blocked report orders pairs state, app, kind, msg", () => {
	const seq = formatProgramStatus({ state: "blocked", app: "pi-crew", kind: "question", message: "task t1 waiting" });
	assert.equal(seq, `\x1b]7501;state=blocked:app=pi-crew:kind=question:msg=${b64("task t1 waiting")}${ST}`);
});

test("kind is only emitted for the blocked state", () => {
	const seq = formatProgramStatus({ state: "working", kind: "question" });
	assert.ok(!seq.includes("kind="), `kind must be omitted for working: ${JSON.stringify(seq)}`);
});

test("invalid app values are omitted (APP_PATTERN)", () => {
	const withSpace = formatProgramStatus({ state: "working", app: "pi crew" });
	assert.ok(!withSpace.includes("app="), "app with a space must be dropped");
	const tooLong = formatProgramStatus({ state: "working", app: "a".repeat(33) });
	assert.ok(!tooLong.includes("app="), "33-char app must be dropped");
	const ok = formatProgramStatus({ state: "working", app: "pi-crew" });
	assert.ok(ok.includes("app=pi-crew"), "pi-crew matches [A-Za-z0-9_.+-]{1,32}");
});

test("message control characters become spaces and the result is trimmed", () => {
	const seq = formatProgramStatus({ state: "blocked", kind: "auth", message: "\r\n hi\x00there \t" });
	// Control chars scrubbed to spaces, THEN trimmed.
	assert.ok(seq.includes(`msg=${b64("hi there")}`), `expected scrubbed+trimmed msg: ${JSON.stringify(seq)}`);
});

test("empty/whitespace message omits the msg pair", () => {
	const seq = formatProgramStatus({ state: "blocked", kind: "question", message: " \t\n" });
	assert.ok(!seq.includes("msg="), "empty msg must be omitted");
});

test("message is truncated to 2048 decoded bytes", () => {
	const seq = formatProgramStatus({ state: "blocked", kind: "question", message: "a".repeat(5000) });
	const msgPair = seq.split(":").find((pair) => pair.startsWith("msg="));
	assert.ok(msgPair, "msg pair present");
	const decoded = Buffer.from(msgPair!.slice(4), "base64").toString("utf8");
	assert.equal(Buffer.byteLength(decoded, "utf8"), 2048);
});

test("utf-8 truncation never splits a multibyte char", () => {
	// 3-byte chars: 683 chars = 2049 bytes → must cut to 682 chars (2046 bytes).
	const seq = formatProgramStatus({ state: "blocked", kind: "question", message: "あ".repeat(1000) });
	const msgPair = seq.split(":").find((pair) => pair.startsWith("msg="));
	const decoded = Buffer.from(msgPair!.slice(4), "base64").toString("utf8");
	assert.equal(decoded, "あ".repeat(682));
});

test("PROGRAM_STATUS_QUERY is the feature-detect escape with ST terminator", () => {
	assert.equal(PROGRAM_STATUS_QUERY, `\x1b]7501;?${ST}`);
});

test("isProgramStatusReply matches ST and BEL terminated replies, rejects others", () => {
	assert.equal(isProgramStatusReply(`\x1b]7501;?${ST}`), true);
	assert.equal(isProgramStatusReply(`\x1b]7501;?${BEL}`), true);
	assert.equal(isProgramStatusReply(`\x1b]7501;?state=working${ST}`), true, "later spec revisions may add pairs");
	assert.equal(isProgramStatusReply("\x1b]7501;state=working\x1b\\"), false, "reports are not replies");
	assert.equal(isProgramStatusReply("\x1b]7501;?state=x\x1b[junk"), false, "stray escape breaks the reply");
	assert.equal(isProgramStatusReply("garbage"), false);
});
