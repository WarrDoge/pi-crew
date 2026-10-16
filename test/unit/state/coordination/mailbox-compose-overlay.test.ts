import assert from "node:assert/strict";
import test from "node:test";
import { MailboxComposeOverlay, type MailboxComposeResult } from "../../../../src/ui/overlays/mailbox-compose-overlay.ts";

test("MailboxComposeOverlay validates body and submits payload", () => {
	const results: MailboxComposeResult[] = [];
	const overlay = new MailboxComposeOverlay({
		done: (result) => results.push(result),
		initial: { to: "worker" },
	});
	overlay.handleInput("\r");
	overlay.handleInput("\r");
	assert.ok(overlay.render(80).some((line) => line.includes("Body is required")));
	for (const char of "hello") overlay.handleInput(char);
	overlay.handleInput("\r");
	assert.equal(results[0]?.type, "submit");
	if (results[0]?.type === "submit") assert.equal(results[0].payload.body, "hello");
});

test("MailboxComposeOverlay toggles preview and confirms long discard", () => {
	const results: MailboxComposeResult[] = [];
	const overlay = new MailboxComposeOverlay({
		done: (result) => results.push(result),
		initial: { body: "x".repeat(60), to: "worker" },
	});
	overlay.handleInput("P");
	assert.ok(overlay.render(100).some((line) => line.includes("Preview")));
	overlay.handleInput("\u001b");
	assert.ok(overlay.render(100).some((line) => line.includes("Discard draft")));
	overlay.handleInput("N");
	assert.equal(results.length, 0);
	overlay.handleInput("\u001b");
	overlay.handleInput("Y");
	assert.equal(results[0]?.type, "cancel");
});

test("MailboxComposeOverlay toggles direction with space on direction field", () => {
	const results: MailboxComposeResult[] = [];
	const overlay = new MailboxComposeOverlay({
		done: (result) => results.push(result),
		initial: { body: "hello", to: "worker" },
	});
	for (let index = 0; index < 3; index += 1) overlay.handleInput("\t");
	overlay.handleInput(" ");
	overlay.handleInput("\r");
	assert.equal(results[0]?.type, "submit");
	if (results[0]?.type === "submit") assert.equal(results[0].payload.direction, "outbox");
});

test("R7-14: a multi-char paste chunk is appended whole to the active field", () => {
	const results: MailboxComposeResult[] = [];
	const overlay = new MailboxComposeOverlay({
		done: (result) => results.push(result),
		initial: { to: "worker" },
	});
	// One bracketed-paste chunk (multi-char) — the old `data.length === 1`
	// passthrough guard dropped this entirely. The first \r moves the focus
	// from the preset "to" field onto "body".
	overlay.handleInput("\r");
	overlay.handleInput("hello world");
	overlay.handleInput(" 😀"); // paste chunks can carry spaces too
	overlay.handleInput("\r");
	assert.equal(results[0]?.type, "submit");
	if (results[0]?.type === "submit") assert.equal(results[0].payload.body, "hello world 😀");
});

test("R7-14: ESC sequences and control-byte chunks never reach the field", () => {
	const results: MailboxComposeResult[] = [];
	const overlay = new MailboxComposeOverlay({
		done: (result) => results.push(result),
		initial: { to: "worker" },
	});
	overlay.handleInput("\x1b[A"); // arrow up — unbound action, not printable
	overlay.handleInput("a\x7fb"); // control byte inside a chunk
	overlay.handleInput("a\nb"); // newline inside a chunk
	overlay.handleInput("\r"); // focus "to" → "body" (no submit — body empty)
	overlay.handleInput("\r"); // submit on an empty body → validation error
	assert.equal(results.length, 0, "nothing printable was appended — submit must fail validation");
	assert.ok(overlay.render(80).some((line) => line.includes("Body is required")));
});

test("O-4: backspace removes a whole surrogate pair (emoji), not half", () => {
	const results: MailboxComposeResult[] = [];
	const overlay = new MailboxComposeOverlay({
		done: (result) => results.push(result),
		initial: { to: "worker" },
	});
	overlay.handleInput("\r"); // focus "to" → "body"
	overlay.handleInput("hi😀");
	overlay.handleInput("\x7f"); // KeyId "backspace" byte
	overlay.handleInput("\r");
	assert.equal(results[0]?.type, "submit");
	if (results[0]?.type === "submit") {
		assert.equal(results[0].payload.body, "hi");
		assert.ok(
			!Array.from(results[0].payload.body).some((c) => c.length === 1 && /[\uD800-\uDFFF]/.test(c)),
			"no lone surrogate may remain after backspace",
		);
	}
});
