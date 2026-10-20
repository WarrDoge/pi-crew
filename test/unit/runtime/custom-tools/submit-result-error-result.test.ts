/**
 * submit-result-error-result.test.ts — R2-L-B1 PIN (wave 8).
 *
 * Records the wave-2b fix: a THROWING onYield previously still returned the
 * "Result submitted successfully" text — the model believed its result was
 * recorded and ended the turn, silently dropping the yield (enforcement loop
 * hangs / wastes turns). The tool must return an ERROR tool-result when the
 * yield callback throws so the worker retries or falls back to plain text.
 *
 * Mutation check (2026-10-20): removing the try/catch (letting onYield throw
 * out of execute, or re-adding the unconditional success text) flips the
 * throw-path assertion — these tests fail. Restoring turns them green.
 *
 * (Record 2026-10-16 line 821 flagged this fix as mutation-proven UNPINNED —
 * closed here.)
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createSubmitResultTool } from "../../../../src/runtime/custom-tools/submit-result-tool.ts";

const OK_PARAMS = { summary: "did the thing" } as never;

test("B1 PIN: throwing onYield → error tool-result, NOT the success text", async () => {
	let calls = 0;
	const tool = createSubmitResultTool(() => {
		calls++;
		throw new Error("yield sink exploded");
	});
	const result = (await tool.execute("tc-1", OK_PARAMS, undefined, undefined, {} as never)) as {
		content: Array<{ type: string; text: string }>;
	};
	assert.equal(calls, 1, "onYield must have been invoked exactly once");
	const text = result.content.map((c) => c.text).join("\n");
	assert.match(text, /FAILED/);
	assert.match(text, /NOT recorded/);
	assert.doesNotMatch(text, /successfully/, "the success text must not survive a throwing onYield");
	assert.match(text, /yield sink exploded/, "the error message must surface to the model");
});

test("B1 PIN: healthy onYield → success text (unchanged contract)", async () => {
	let calls = 0;
	const tool = createSubmitResultTool(() => {
		calls++;
	});
	const result = (await tool.execute("tc-2", OK_PARAMS, undefined, undefined, {} as never)) as {
		content: Array<{ type: string; text: string }>;
	};
	assert.equal(calls, 1);
	const text = result.content.map((c) => c.text).join("\n");
	assert.match(text, /successfully/);
});
