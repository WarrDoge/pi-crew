import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { parsePiJsonOutput } from "../../src/runtime/output/pi-json-output.ts";

test("parsePiJsonOutput extracts final text and usage", () => {
	const stdout = [
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
			},
		}),
		JSON.stringify({
			type: "message",
			content: [{ type: "text", text: "final" }],
		}),
		JSON.stringify({
			type: "message_end",
			usage: {
				input: 12,
				output: 5,
				cache_read_tokens: 2,
				cost_usd: 0.03,
				turns: 1,
			},
		}),
	].join("\n");
	const parsed = parsePiJsonOutput(stdout);
	assert.equal(parsed.jsonEvents, 3);
	assert.equal(parsed.finalText, "final");
	assert.equal(parsed.usage?.input, 12);
	assert.equal(parsed.usage?.output, 5);
	assert.equal(parsed.usage?.cacheRead, 2);
	assert.equal(parsed.usage?.cost, 0.03);
});

test("parsePiJsonOutput ignores user prompt text when extracting final output", () => {
	const stdout = [
		JSON.stringify({
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "secret prompt" }],
			},
		}),
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "clean answer" }],
			},
		}),
	].join("\n");
	const parsed = parsePiJsonOutput(stdout);
	assert.equal(parsed.finalText, "clean answer");
	assert.equal(parsed.textEvents.includes("secret prompt"), false);
});

test("parsePiJsonOutput handles fixture JSONL", () => {
	const fixture = fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "pi-json-output.jsonl"), "utf-8");
	const parsed = parsePiJsonOutput(fixture);
	assert.equal(parsed.finalText, "Final answer from Pi");
	assert.equal(parsed.usage?.input, 10);
	assert.equal(parsed.usage?.output, 5);
});

// ───────────────────────────────────────────────────────────────────────────
// DR-01 (deep review 2026-10-14, P0 false-green): settledWithoutAnswer — the
// empty-settle signal. Real-world shape (run team_20261014082741, task
// 04_explore-runtime): opening assistant text + tool results, then a CHAIN of
// EMPTY assistant message_end events (content [], usage 0) between auto-retry
// cycles, ending agent_settled. No stopReason:"error", no errorMessage — the
// legacy 429 detector never fires, and finalText keeps the early sentence.
// ───────────────────────────────────────────────────────────────────────────
test("DR-01 settledWithoutAnswer: empty-settle transcript → true (finalText keeps early text)", () => {
	const assistantText = JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "I'll start by exploring the runtime shard." }] },
	});
	const toolResult = JSON.stringify({
		type: "message_end",
		message: { role: "toolResult", content: [{ type: "text", text: "<file contents>" }] },
	});
	const emptyAssistant = JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [], usage: { input: 0, output: 0, totalTokens: 0 } },
	});
	const parsed = parsePiJsonOutput([assistantText, toolResult, emptyAssistant, emptyAssistant].join("\n"));
	assert.equal(parsed.settledWithoutAnswer, true, "final assistant message_end is empty");
	assert.equal(
		parsed.finalText,
		"I'll start by exploring the runtime shard.",
		"finalText keeps the LAST NON-EMPTY text — exactly why it cannot be the settled signal",
	);
});

test("DR-01 settledWithoutAnswer: healthy run (final assistant has text) → false", () => {
	const stdout = [
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working..." }] } }),
		JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "data" }] } }),
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } }),
	].join("\n");
	assert.equal(parsePiJsonOutput(stdout).settledWithoutAnswer, false);
});

test("DR-01 settledWithoutAnswer: no assistant message_end at all → undefined", () => {
	const parsed = parsePiJsonOutput(JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [] } }));
	assert.equal(parsed.settledWithoutAnswer, undefined);
	assert.equal(parsePiJsonOutput("").settledWithoutAnswer, undefined);
});

test("DR-01 settledWithoutAnswer: whitespace-only final text counts as empty", () => {
	const stdout = [
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "real" }] } }),
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "   " }] } }),
	].join("\n");
	assert.equal(parsePiJsonOutput(stdout).settledWithoutAnswer, true, "extractText drops whitespace-only fragments");
});

test("DR-01 settledWithoutAnswer: string content form handled", () => {
	const stdout = [
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: "answer" } }),
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: "" } }),
	].join("\n");
	assert.equal(parsePiJsonOutput(stdout).settledWithoutAnswer, true);
});
