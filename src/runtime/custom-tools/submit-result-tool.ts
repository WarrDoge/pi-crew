/**
 * G1: Custom tool — submit_result.
 *
 * Registers a real `submit_result` tool in the Pi SDK session so that
 * live-session workers can yield their result by calling a tool (instead of
 * relying solely on prompt-based reminders).
 *
 * Adapted from oh-my-pi's `YieldTool` pattern. Uses Pi SDK's `defineTool()`
 * and TypeBox schemas for validation.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { logInternalError } from "../../utils/internal-error.ts";
import type { YieldResult } from "../yield-handler.ts";

const SubmitResultParams = Type.Object({
	summary: Type.String({ description: "Summary of completed work." }),
	artifacts: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Key-value map of artifact labels to file paths or content.",
		}),
	),
	structuredData: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Structured key-value data to pass back to the orchestrator.",
		}),
	),
});

type SubmitResultParams = Static<typeof SubmitResultParams>;

interface SubmitResultDetails {
	summary: string;
	artifacts?: Record<string, string>;
	structuredData?: Record<string, unknown>;
}

/**
 * Create a `submit_result` tool definition that calls `onYield` when invoked.
 *
 * The tool is injected into the session via `createAgentSession({ customTools: [...] })`.
 * When the model calls it, the result is captured via the `onYield` callback
 * and the yield enforcement loop terminates.
 */
export function createSubmitResultTool(
	onYield: (result: YieldResult) => void,
): ToolDefinition<typeof SubmitResultParams, SubmitResultDetails> {
	return defineTool({
		name: "submit_result",
		label: "Submit Result",
		description:
			"Submit final task result. Call when task complete. " +
			"Provide summary, optional artifacts (file paths/content), optional structured data.",
		parameters: SubmitResultParams,
		promptSnippet: "Submit your task result when done using submit_result",
		promptGuidelines: [
			"Always call submit_result when your task is complete, even if you were unable to finish.",
			"Include a clear summary of what was accomplished.",
		],
		async execute(
			toolCallId: string,
			params: SubmitResultParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: SubmitResultDetails;
		}> {
			const result: YieldResult = {
				summary: params.summary,
				toolCallId,
				...(params.artifacts ? { artifacts: params.artifacts } : {}),
				...(params.structuredData ? { structuredData: params.structuredData } : {}),
			};
			// Build response first so the model always gets confirmation
			const response: {
				content: Array<{ type: "text"; text: string }>;
				details: SubmitResultDetails;
			} = {
				content: [
					{
						type: "text",
						text: "Result submitted successfully. Thank you.",
					},
				],
				details: {
					summary: params.summary,
					artifacts: params.artifacts,
					structuredData: params.structuredData,
				},
			};
			// R2-L-B1 (wave-2b): a THROWING onYield previously still returned the
			// success text — the model believed its result was recorded and ended
			// the turn, silently dropping it. The error tool-result makes the
			// failure visible so the worker retries or falls back to plain text.
			try {
				onYield(result);
			} catch (error) {
				logInternalError("submit-result-tool.yield", error, toolCallId);
				return {
					content: [
						{
							type: "text",
							text: `Result submission FAILED: ${error instanceof Error ? error.message : String(error)} — the result was NOT recorded. Try again or state the result in your final message.`,
						},
					],
					details: {
						summary: params.summary,
						...(params.artifacts ? { artifacts: params.artifacts } : {}),
						...(params.structuredData ? { structuredData: params.structuredData } : {}),
					},
				};
			}
			return response;
		},
	});
}
