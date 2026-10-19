/**
 * Resilient edit wrapper — uses the cascading replace() engine as a fallback
 * when the native edit tool fails to find `oldText`.
 *
 * Multi-agent runs (crew workers) often provide slightly-wrong oldText:
 *   - indentation drift (tabs vs spaces)
 *   - trailing whitespace differences
 *   - line-ending normalization (\r\n vs \n)
 *
 * The native edit tool matches (near-)exactly and fails hard on these. This
 * module hooks the tool result and retries with the cascading engine, which
 * tries (in order): exact → escape-normalized → line-trimmed → block-anchor →
 * whitespace-normalized → trimmed-boundary.
 *
 * R49-F1 (wave-6 M3-15) — REAL API ONLY. The previous implementation read
 * `pi.tools.edit` / `pi.extensions` / `pi._extensions`, none of which exist on
 * the 1.0.4 extension API (the loader-created api object has no such keys), so
 * `wrapEditWithResilientReplace()` always returned false in production and the
 * whole feature was dead code (the call site in register.ts ignores the
 * return value). `pi.getAllTools()` cannot replace it either: it returns
 * metadata-only `ToolInfo` (Pick<ToolDefinition, name|description|parameters|
 * promptGuidelines>) with NO `execute`, so there is nothing to monkey-patch.
 * The supported seam is the `tool_result` hook: a handler may return
 * `{ content, isError }` to replace the failed result — the resilient retry
 * performs the file write itself, so a success result can be substituted.
 *
 * CONFLICT AWARENESS: pi-diff (`@heyhuynhgiabuu/pi-diff`) also overrides the
 * edit tool with its own replace() integration. To avoid double-wrapping, this
 * module is OPT-IN via the `CREW_RESILIENT_EDIT=1` env var, and auto-disables
 * when pi-diff is detected in the session's tool listing (getAllTools).
 *
 * Usage (in register.ts, guarded):
 *   if (process.env.CREW_RESILIENT_EDIT === "1") {
 *       wrapEditWithResilientReplace(pi);
 *   }
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ReplaceResult, replace } from "../runtime/replace.ts";

/** One replacement as the 1.0.4 edit tool models it (`{ path, edits: [...] }`). */
interface EditEntry {
	oldText: string;
	newText: string;
	replaceAll?: boolean;
}

/** Flat edit arguments (1.0.4 single-edit form and pre-1.0 legacy names). */
interface LegacyEditParams {
	path?: string;
	filePath?: string;
	oldText?: string;
	newText?: string;
	oldString?: string;
	old_string?: string;
	newString?: string;
	new_string?: string;
	replaceAll?: boolean;
	replace_all?: boolean;
}

interface ToolResultEventLike {
	toolName?: unknown;
	input?: unknown;
	content?: unknown;
	isError?: unknown;
}

interface ToolResultEventResultLike {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
}

interface ToolInfoLike {
	name?: unknown;
	namespace?: { name?: unknown } | unknown;
	sourceInfo?: { path?: unknown; source?: unknown } | unknown;
}

const NOT_FOUND_PATTERNS = [/old_string not found/i, /oldstring not found/i, /no match/i, /could not find/i, /string not found/i];

function isNotFoundResult(content: unknown): boolean {
	const text = JSON.stringify(content ?? "");
	return NOT_FOUND_PATTERNS.some((re) => re.test(text));
}

function stringField(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : undefined;
}

/**
 * Detect whether pi-diff is loaded (to avoid double-wrapping edit).
 *
 * R49-F1: reads the REAL `getAllTools()` listing (the phantom
 * `pi.extensions` / `pi._extensions` are simply not on the api). A tool's
 * owning extension shows up in `namespace.name` (e.g. `mcp__docs`) and
 * `sourceInfo.path`/`sourceInfo.source`.
 */
function isPiDiffLoaded(pi: ExtensionAPI): boolean {
	try {
		const getAllTools = (pi as unknown as { getAllTools?: () => unknown }).getAllTools;
		if (typeof getAllTools !== "function") return false;
		const tools = getAllTools.call(pi);
		if (!Array.isArray(tools)) return false;
		return (tools as ToolInfoLike[]).some((tool) => {
			if (!tool || typeof tool !== "object") return false;
			const namespaceName = tool.namespace && typeof tool.namespace === "object" ? stringField(tool.namespace, "name") : undefined;
			const sourcePath = tool.sourceInfo && typeof tool.sourceInfo === "object" ? stringField(tool.sourceInfo, "path") : undefined;
			const sourceName = tool.sourceInfo && typeof tool.sourceInfo === "object" ? stringField(tool.sourceInfo, "source") : undefined;
			return [namespaceName, sourcePath, sourceName].some((value) => typeof value === "string" && value.includes("pi-diff"));
		});
	} catch {
		return false;
	}
}

/**
 * Normalize the edit tool input into one or more replacements.
 *
 * 1.0.4 shape is `{ path, edits: [{ oldText, newText }] }`; older hosts (and
 * the module's own history) used `{ path|filePath, oldString|old_string,
 * newString|new_string, replaceAll }`. Both are accepted so the hook keeps
 * working across hosts.
 */
function toEditEntries(input: unknown): { filePath: string; entries: EditEntry[] } | undefined {
	if (!input || typeof input !== "object") return undefined;
	const params = input as Record<string, unknown>;
	const filePath = stringField(params, "path") ?? stringField(params, "filePath");
	if (!filePath) return undefined;

	const rawEdits = params.edits;
	if (Array.isArray(rawEdits)) {
		const entries: EditEntry[] = [];
		for (const raw of rawEdits) {
			const oldText = stringField(raw, "oldText") ?? stringField(raw, "old_string") ?? stringField(raw, "oldString");
			const newText = stringField(raw, "newText") ?? stringField(raw, "new_string") ?? stringField(raw, "newString");
			if (oldText === undefined || newText === undefined) return undefined;
			const flag = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
			entries.push({ oldText, newText, replaceAll: flag.replaceAll === true || flag.replace_all === true });
		}
		return entries.length > 0 ? { filePath, entries } : undefined;
	}

	const legacy = params as LegacyEditParams;
	const oldText = legacy.oldText ?? legacy.oldString ?? legacy.old_string;
	const newText = legacy.newText ?? legacy.newString ?? legacy.new_string;
	if (oldText === undefined || newText === undefined) return undefined;
	return { filePath, entries: [{ oldText, newText, replaceAll: legacy.replaceAll ?? legacy.replace_all ?? false }] };
}

/**
 * Apply the resilient cascade to the edit retry. All-or-nothing: the file is
 * written ONLY when every requested replacement matched, so a partially
 * fuzz-matched multi-edit can never leave the file half-edited (the native
 * tool has the same guarantee, and a hook that wrote partially would be worse
 * than the failure it replaces).
 *
 * @returns the replacement result, or undefined when nothing could be applied
 */
async function retryWithReplace(input: unknown): Promise<ToolResultEventResultLike | undefined> {
	const target = toEditEntries(input);
	if (!target) return undefined;
	const { filePath, entries } = target;

	// LAZY: defer dynamic import of node:fs/promises to its call site.
	const fs = await import("node:fs/promises");
	let original: string;
	try {
		original = await fs.readFile(filePath, "utf8");
	} catch {
		return undefined; // unreadable file — leave the original tool failure in place
	}

	const strategies: string[] = [];
	let content = original;
	for (const entry of entries) {
		const result: ReplaceResult = replace(content, entry.oldText, entry.newText, {
			replaceAll: entry.replaceAll ?? false,
		});
		if (!result.changed) return undefined; // any unmatched edit → no write at all
		content = result.content;
		strategies.push(result.strategy);
	}
	if (content === original) return undefined;

	await fs.writeFile(filePath, content, "utf8");
	return {
		content: [
			{
				type: "text",
				text: `Edited ${filePath} via resilient cascade (strategy: ${strategies.join(", ")}).`,
			},
		],
		isError: false,
	};
}

/**
 * Hook the native `edit` tool result so that "old text not found" failures are
 * retried with the cascading replace() engine (lenient matching).
 *
 * @param pi the Pi extension API
 * @returns true if the hook was registered, false if skipped
 */
export function wrapEditWithResilientReplace(pi: ExtensionAPI): boolean {
	// Auto-disable if pi-diff is present (it has its own replace integration).
	if (isPiDiffLoaded(pi)) return false;

	const on = (pi as unknown as { on?: (event: string, handler: unknown) => unknown }).on;
	if (typeof on !== "function") return false;

	on.call(pi, "tool_result", async (event: ToolResultEventLike) => {
		if (event?.toolName !== "edit") return undefined;
		// Only the not-found family is retryable: a duplicate / overlap /
		// invalid-input failure keeps its original error (the cascade cannot fix
		// those and a fuzzy retry would be unsafe). The check covers both a
		// thrown tool error surfaced as isError:true and a not-found result.
		if (!isNotFoundResult(event.content)) return undefined;
		try {
			return await retryWithReplace(event.input);
		} catch {
			// A retry failure must never turn a clean tool error into a thrown
			// extension error — fall back to the native result.
			return undefined;
		}
	});

	return true;
}
