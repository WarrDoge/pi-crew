import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChildPiRunResult } from "../../../../src/runtime/child-pi/child-pi.ts";
import { type ParsedPiJsonOutput, parsePiJsonOutput } from "../../../../src/runtime/output/pi-json-output.ts";
import { attemptErrorFor } from "../../../../src/runtime/task-runner/child-executor.ts";
import { detectRetryableModelFailureFromOutput } from "../../../../src/runtime/task-runner.ts";

/**
 * 429/rate-limit fix (PI_CREW_TOOLING_429_NOTE.md). A worker can exit code 0
 * with no hard error, but the transcript is full of `message_end` events with
 * `errorMessage: "429 ... overloaded"` and empty content. The model never
 * produced a tool call → worker "completed" without doing anything → pi-crew
 * treated it as success. This fix detects that case and surfaces it as an error
 * so the model-fallback chain retries on another model.
 */

// A real Z.AI 429 message_end event (from the bug report).
const event429 = JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		content: [],
		model: "glm-5.2",
		errorMessage: "429 The service may be temporarily overloaded, please try again later",
		stopReason: "error",
	},
});

const eventRateLimit = JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		content: [],
		errorMessage: "rate_limit_error: too many requests",
	},
});

const eventAuth = JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		content: [],
		errorMessage: "401 unauthorized: invalid api key",
	},
});

const eventText = JSON.stringify({
	type: "message",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "I will now edit the file." }],
	},
});

describe("parsePiJsonOutput — errorMessages extraction", () => {
	it("extracts errorMessage from message_end events", () => {
		const parsed = parsePiJsonOutput(event429);
		assert.ok(parsed.errorMessages);
		assert.equal(parsed.errorMessages!.length, 1);
		assert.match(parsed.errorMessages![0]!, /429.*overloaded/i);
	});

	it("collects multiple error messages", () => {
		const parsed = parsePiJsonOutput(`${event429}\n${eventRateLimit}`);
		assert.equal(parsed.errorMessages!.length, 2);
	});

	it("returns undefined errorMessages when no error events", () => {
		const parsed = parsePiJsonOutput(eventText);
		assert.equal(parsed.errorMessages, undefined);
	});
});

describe("detectRetryableModelFailureFromOutput — 429-only run detection", () => {
	it("surfaces error when transcript has retryable 429 messages AND no real output", () => {
		const parsed = parsePiJsonOutput(event429); // empty content, no text
		const err = detectRetryableModelFailureFromOutput(parsed);
		assert.ok(err, "must surface the 429 as an error");
		assert.match(err!, /429.*overloaded/i);
		assert.match(err!, /no output/i);
	});

	it("surfaces error for rate_limit_error too", () => {
		const parsed = parsePiJsonOutput(eventRateLimit);
		const err = detectRetryableModelFailureFromOutput(parsed);
		assert.ok(err);
		assert.match(err!, /rate_limit_error/i);
	});

	it("returns undefined when there's real output (model recovered despite transient 429s)", () => {
		// 429 then a successful text response — the run recovered, don't fail it.
		const parsed = parsePiJsonOutput(`${event429}\n${eventText}`);
		const err = detectRetryableModelFailureFromOutput(parsed);
		assert.equal(err, undefined, "recovered run must not be flagged");
	});

	it("returns undefined for non-retryable errors (auth/billing) — those shouldn't trigger fallback", () => {
		// Auth errors are NON_RETRYABLE — isRetryableModelFailure returns false.
		// We should NOT surface them here (they'd be caught by other layers /
		// would loop the fallback chain forever).
		const parsed = parsePiJsonOutput(eventAuth);
		const err = detectRetryableModelFailureFromOutput(parsed);
		assert.equal(err, undefined, "non-retryable auth errors must not trigger this path");
	});

	it("returns undefined when no error messages at all (normal successful run)", () => {
		const parsed = parsePiJsonOutput(eventText);
		assert.equal(detectRetryableModelFailureFromOutput(parsed), undefined);
	});

	it("returns undefined for empty transcript", () => {
		const parsed = parsePiJsonOutput("");
		assert.equal(detectRetryableModelFailureFromOutput(parsed), undefined);
	});
});

describe("detectRetryableModelFailureFromOutput — secondary messageEndEvents signal (FIX 3)", () => {
	// FIX 3 (task packet 01_01-agent): the detector also inspects a raw
	// `messageEndEvents` (or `transcript`) array on the parsed output as a
	// secondary signal. The ParsedPiJsonOutput type does not currently declare
	// this field, so the function reads it through a local extension cast. This
	// block exercises that secondary path: callers that bypass the
	// errorMessages extraction (e.g. a test, or a future parser that captures
	// the full event stream) still get the retryable failure surfaced.

	it("surfaces retryable error from messageEndEvents when errorMessages is absent", () => {
		const parsed = {
			jsonEvents: 1,
			textEvents: [],
			finalText: undefined,
			patches: undefined,
			errorMessages: undefined,
			messageEndEvents: [
				{
					stopReason: "error",
					errorMessage: "Provider error: api_error",
				},
			],
		} as unknown as ParsedPiJsonOutput;
		const err = detectRetryableModelFailureFromOutput(parsed);
		assert.ok(err, "must surface the api_error from messageEndEvents");
		assert.match(err!, /api_error/i);
		assert.match(err!, /no output/i);
	});

	it("accepts the alternative `transcript` field name for the event stream", () => {
		const parsed = {
			jsonEvents: 1,
			textEvents: [],
			finalText: undefined,
			patches: undefined,
			errorMessages: undefined,
			transcript: [{ stopReason: "error", errorMessage: "upstream timeout" }],
		} as unknown as ParsedPiJsonOutput;
		const err = detectRetryableModelFailureFromOutput(parsed);
		assert.ok(err);
		assert.match(err!, /upstream timeout/i);
	});

	it("ignores messageEndEvents without stopReason='error'", () => {
		const parsed = {
			jsonEvents: 1,
			textEvents: [],
			finalText: undefined,
			patches: undefined,
			errorMessages: undefined,
			messageEndEvents: [
				{
					stopReason: "stop",
					errorMessage: "Provider error: api_error",
				},
			],
		} as unknown as ParsedPiJsonOutput;
		assert.equal(detectRetryableModelFailureFromOutput(parsed), undefined);
	});

	it("ignores messageEndEvents with empty/non-string errorMessage", () => {
		const parsed = {
			jsonEvents: 1,
			textEvents: [],
			finalText: undefined,
			patches: undefined,
			errorMessages: undefined,
			messageEndEvents: [{ stopReason: "error", errorMessage: "" }, { stopReason: "error" /* no errorMessage field */ }],
		} as unknown as ParsedPiJsonOutput;
		assert.equal(detectRetryableModelFailureFromOutput(parsed), undefined);
	});

	it("ignores non-retryable messageEndEvents (auth/billing) and falls through", () => {
		const parsed = {
			jsonEvents: 1,
			textEvents: [],
			finalText: undefined,
			patches: undefined,
			errorMessages: undefined,
			messageEndEvents: [
				{
					stopReason: "error",
					errorMessage: "401 unauthorized: invalid api key",
				},
			],
		} as unknown as ParsedPiJsonOutput;
		assert.equal(detectRetryableModelFailureFromOutput(parsed), undefined);
	});

	it("returns undefined for messageEndEvents when real output is present (recovered)", () => {
		const parsed = {
			jsonEvents: 2,
			textEvents: ["I will now edit the file."],
			finalText: "I will now edit the file.",
			patches: undefined,
			errorMessages: undefined,
			messageEndEvents: [
				{
					stopReason: "error",
					errorMessage: "Provider error: api_error",
				},
			],
		} as unknown as ParsedPiJsonOutput;
		assert.equal(detectRetryableModelFailureFromOutput(parsed), undefined);
	});

	it("primary errorMessages signal still wins over secondary messageEndEvents", () => {
		// errorMessages carries a 429; messageEndEvents carries a different
		// retryable error. The function must return the 429 (primary) — not
		// whichever secondary event comes first.
		const parsed = {
			jsonEvents: 2,
			textEvents: [],
			finalText: undefined,
			patches: undefined,
			errorMessages: ["429 The service may be temporarily overloaded"],
			messageEndEvents: [
				{
					stopReason: "error",
					errorMessage: "Provider error: api_error",
				},
			],
		} as unknown as ParsedPiJsonOutput;
		const err = detectRetryableModelFailureFromOutput(parsed);
		assert.ok(err);
		assert.match(err!, /429.*overloaded/i);
	});
});

// ───────────────────────────────────────────────────────────────────────────
// DR-01 (deep review 2026-10-14, P0 false-green): the 429 shape the legacy
// detector cannot see. Reconstructed byte-for-byte in structure from run
// team_20261014082741 (task 04_explore-runtime): opening assistant text,
// tool results, then EMPTY assistant message_end events (content [], usage 0)
// between auto-retry cycles, ending agent_settled. No stopReason:"error", no
// errorMessage — errorMessages stays undefined, so the legacy detector above
// returns undefined and the attempt used to count as SUCCESS. The new
// settledWithoutAnswer flag + attemptErrorFor close that hole.
// ───────────────────────────────────────────────────────────────────────────
describe("DR-01 empty-settle detection (429 exhaustion without stopReason error)", () => {
	const emptySettleTranscript = [
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "I'll start by reading the skill and key architecture docs." }],
				usage: { input: 2100, output: 144 },
			},
		}),
		JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "SKILL.md contents" }] } }),
		JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "AGENTS.md contents" }] } }),
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [], usage: { input: 0, output: 0, totalTokens: 0 } },
		}),
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [], usage: { input: 0, output: 0, totalTokens: 0 } },
		}),
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [], usage: { input: 0, output: 0, totalTokens: 0 } },
		}),
		JSON.stringify({ type: "auto_retry_start" }),
		JSON.stringify({ type: "auto_retry_end" }),
		JSON.stringify({ type: "agent_settled" }),
	].join("\n");

	it("parser flags settledWithoutAnswer; legacy errorMessages signal is absent", () => {
		const parsed = parsePiJsonOutput(emptySettleTranscript);
		assert.equal(parsed.settledWithoutAnswer, true);
		assert.equal(parsed.errorMessages, undefined, "the legacy detector's blind spot: no errorMessage is ever emitted");
	});

	it("legacy detector misses this shape; attemptErrorFor catches it (regression pin)", () => {
		const parsed = parsePiJsonOutput(emptySettleTranscript);
		assert.equal(
			detectRetryableModelFailureFromOutput(parsed),
			undefined,
			"legacy detector must still return undefined — its contract is unchanged",
		);
		const childResult = {
			exitCode: 0,
			exitStatus: undefined,
			stdout: "",
			stderr: "",
			rawFinalText: undefined,
			intermediateFindings: undefined,
		} as ChildPiRunResult;
		const err = attemptErrorFor(childResult, parsed, "04_explore-runtime");
		assert.ok(err, "attemptErrorFor must surface the empty settle");
		assert.match(err!, /settled without a final answer/i);
		assert.match(err!, /rate-limit\/429/i, "message must carry retryable keywords for the fallback chain");
	});

	it("the pre-fix false-green counterfactual: without the flag this shape produced NO error", () => {
		// Same transcript parsed by the OLD contract (settledWithoutAnswer absent)
		// must yield no error — pinning WHY the flag had to exist.
		const legacyParsed = {
			finalText: "I'll start by reading the skill and key architecture docs.",
			textEvents: ["I'll start by reading the skill and key architecture docs."],
		} as ParsedPiJsonOutput;
		const childResult = {
			exitCode: 0,
			exitStatus: undefined,
			stdout: "",
			stderr: "",
			rawFinalText: undefined,
			intermediateFindings: undefined,
		} as ChildPiRunResult;
		assert.equal(attemptErrorFor(childResult, legacyParsed, "t1"), undefined);
	});
});
