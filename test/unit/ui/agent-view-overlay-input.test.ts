/**
 * O-4 (DR-04 round-7, 2026-10-16): surrogate-safe backspace in the agent
 * view's steer input, plus the shared printable-input classifier that
 * R7-14 also wires into mailbox-compose-overlay.
 *
 * The steer round-trip is asserted through `options.steer` — typing into
 * input mode and pressing return sends the text, so no rendering is needed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { backspaceChar, CrewAgentOverlay, isPrintableInput } from "../../../src/ui/inline-panel/agent-view-overlay.ts";
import type { PanelTarget } from "../../../src/ui/inline-panel/panel-selection.ts";
import { setViewedAgent } from "../../../src/ui/inline-panel/panel-store.ts";

const VIEWED: PanelTarget = { runId: "run-dr04-o4", taskId: "task_1" };

function makeOverlay(steered: Array<[PanelTarget, string]>): CrewAgentOverlay {
	const tui = { terminal: { rows: 24, columns: 100 }, requestRender: () => undefined };
	return new CrewAgentOverlay(tui as never, { colors: {} } as never, "/tmp/dr04-w4-agent-view", {
		close: () => undefined,
		steer: (target, message) => steered.push([target, message]),
	});
}

test("isPrintableInput: multi-char paste yes; ESC sequences and control bytes no", () => {
	assert.equal(isPrintableInput("hello world"), true, "paste chunk is printable");
	assert.equal(isPrintableInput("😀"), true, "astral char is printable");
	assert.equal(isPrintableInput(""), false);
	assert.equal(isPrintableInput("\x1b[A"), false, "arrow-key escape must not reach the text");
	assert.equal(isPrintableInput("a\x7fb"), false, "DEL control byte is not printable");
	assert.equal(isPrintableInput("a\nb"), false, "newline is not printable");
});

test("backspaceChar removes full code points — never splits a surrogate pair", () => {
	assert.equal(backspaceChar("hi😀"), "hi");
	assert.equal(backspaceChar("😀"), "");
	assert.equal(backspaceChar("ab"), "a");
	assert.equal(backspaceChar(""), "");
});

test("O-4: steer backspace deletes a WHOLE emoji (astral code point), not half", () => {
	setViewedAgent(VIEWED);
	const steered: Array<[PanelTarget, string]> = [];
	const overlay = makeOverlay(steered);
	overlay.handleInput("i"); // enter steer input mode
	overlay.handleInput("a😀");
	overlay.handleInput("\x7f"); // backspace
	overlay.handleInput("\r"); // send
	assert.equal(steered.length, 1);
	assert.equal(steered[0]?.[1], "a", "backspace must remove the emoji as one unit");
	overlay.dispose();
	setViewedAgent(undefined);
});

test("R7-14 parity: a multi-char paste chunk reaches the steer text whole", () => {
	setViewedAgent(VIEWED);
	const steered: Array<[PanelTarget, string]> = [];
	const overlay = makeOverlay(steered);
	overlay.handleInput("i");
	overlay.handleInput("hello world 😀");
	overlay.handleInput("\r");
	assert.equal(steered.length, 1);
	assert.equal(steered[0]?.[1], "hello world 😀");
	overlay.dispose();
	setViewedAgent(undefined);
});
