/**
 * Unit tests for src/runtime/resilient-edit.ts.
 *
 * R49-F1 (wave-6 M3-15): the module used to read the PHANTOM `pi.tools.edit` /
 * `pi.extensions` keys (absent from the real 1.0.4 extension API), so
 * `wrapEditWithResilientReplace` always returned false in production — the
 * feature was dead code. The wrapper now registers a real `tool_result` hook
 * (`pi.on`), which is the only supported seam: `getAllTools()` returns
 * metadata-only `ToolInfo` with no `execute`.
 *
 * Public API under test:
 *   - wrapEditWithResilientReplace(pi): boolean
 *
 * Coverage:
 *   - REAL loader-created api (probe r50b-s6 d-phantomkey ported here): the api
 *     has no `tools`/`extensions` keys, wrap returns TRUE and registers a hook.
 *   - hook pass-through: success / other tools / other error families return
 *     undefined (native result untouched, file untouched).
 *   - hook retry: not-found failure → cascade retry writes the file and returns
 *     a success result ({content, isError:false}).
 *   - 1.0.4 `{path, edits:[{oldText,newText}]}` input AND legacy flat
 *     `{oldString,newString}` param names.
 *   - multi-edit is ALL-OR-NOTHING (a partial fuzz match must not half-write).
 *   - replaceAll threading.
 *   - pi-diff auto-disable via the REAL getAllTools() listing.
 *   - no `on` on the api → not applied.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { wrapEditWithResilientReplace } from "../../../../src/runtime/resilient-edit.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

/**
 * The real loader is not an exported subpath of the pi package, so it is loaded
 * by resolved file URL (same entry the probe r50b-s6 d-phantomkey drove).
 */
function loaderUrl(): string {
	try {
		return new URL("core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
	} catch {
		// Fallback for layouts where import.meta.resolve cannot see the package.
		return pathToFileURL(path.join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js")).href;
	}
}
type Loader = {
	createExtensionRuntime: () => unknown;
	loadExtensionFromFactory: (
		factory: (pi: unknown) => void,
		cwd: string,
		eventBus: never,
		runtime: unknown,
		extensionPath: string,
	) => Promise<void>;
};

type HandlerResult = { content?: Array<{ type: string; text: string }>; isError?: boolean } | undefined;

interface FakePi {
	on: (event: string, handler: (event: unknown, ctx?: unknown) => Promise<HandlerResult>) => () => void;
	getAllTools: () => unknown[];
}

/** Fake pi capturing registered hooks; mirrors the host's `on(event, handler)` surface. */
function makePi(opts: { allTools?: unknown[]; withOn?: boolean } = {}): {
	pi: FakePi;
	handlers: Array<(event: unknown, ctx?: unknown) => Promise<HandlerResult>>;
	registeredEvents: string[];
} {
	const handlers: Array<(event: unknown, ctx?: unknown) => Promise<HandlerResult>> = [];
	const registeredEvents: string[] = [];
	const allTools = opts.allTools ?? [];
	const pi = {
		allTools,
		on(event: string, handler: (event: unknown, ctx?: unknown) => Promise<HandlerResult>) {
			registeredEvents.push(event);
			handlers.push(handler);
			return () => {
				/* no-op unsubscribe */
			};
		},
		getAllTools: () => allTools,
	} as unknown as FakePi;
	if (opts.withOn === false) delete (pi as unknown as Record<string, unknown>).on;
	return { pi, handlers, registeredEvents };
}

/** Merge handler results the way the host's tool_result runner does. */
async function emitToolResult(
	handlers: Array<(event: unknown, ctx?: unknown) => Promise<HandlerResult>>,
	event: unknown,
): Promise<HandlerResult> {
	let merged: HandlerResult;
	for (const handler of handlers) {
		const result = await handler(event);
		if (!result) continue;
		merged = { ...(merged ?? {}), ...result };
	}
	return merged;
}

function notFoundEvent(
	input: unknown,
	text = "Could not find the exact text in target.txt. The old text must match exactly including all whitespace and newlines.",
) {
	return { type: "tool_result", toolName: "edit", toolCallId: "t1", input, content: [{ type: "text", text }], isError: true };
}

function tmpFile(content: string): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-resilient-edit-"));
	const file = path.join(dir, "target.txt");
	fs.writeFileSync(file, content, "utf8");
	return { dir, file };
}

test("R49-F1 pin (probe r50b-s6 d-phantomkey): real 1.0.4 loader api wraps for real", async () => {
	// loadExtensionFromFactory is the SAME path production extensions go through;
	// the factory receives the real api object.
	let captured: unknown;
	const { createExtensionRuntime, loadExtensionFromFactory } = (await import(loaderUrl())) as unknown as Loader;
	const runtime = createExtensionRuntime();
	const eventBus = {
		emit() {
			/* no listeners in the loader-only probe */
		},
		on() {
			return () => {
				/* nothing to unsubscribe */
			};
		},
	};
	await loadExtensionFromFactory(
		(pi: unknown) => {
			captured = pi;
		},
		os.tmpdir(),
		eventBus as never,
		runtime,
		path.join(os.tmpdir(), "probe-ext"),
	);
	const api = captured as Record<string, unknown>;
	assert.ok(api, "loader handed the factory an api object");
	// The api the module used to read from — these keys do NOT exist.
	assert.equal("tools" in api, false, "api.tools is not a real key");
	assert.equal("extensions" in api, false, "api.extensions is not a real key");
	assert.equal("_extensions" in api, false, "api._extensions is not a real key");
	assert.equal(typeof api.on, "function", "api.on is the real hook seam");
	assert.equal(typeof api.getAllTools, "function", "api.getAllTools is a real key");

	const applied = wrapEditWithResilientReplace(api as never);
	assert.equal(applied, true, "wrap must succeed on the REAL api (was false before R49-F1)");
});

test("hook pass-through: success, other tools and other error families are left alone", async () => {
	const { pi, handlers, registeredEvents } = makePi();
	assert.equal(wrapEditWithResilientReplace(pi as never), true);
	assert.deepEqual(registeredEvents, ["tool_result"], "registers the tool_result hook");

	assert.equal(
		await emitToolResult(handlers, {
			toolName: "edit",
			input: { path: "x" },
			content: [{ type: "text", text: "Edited." }],
			isError: false,
		}),
		undefined,
	);
	assert.equal(
		await emitToolResult(handlers, {
			toolName: "read",
			input: { path: "x" },
			content: [{ type: "text", text: "could not find" }],
			isError: true,
		}),
		undefined,
	);
	assert.equal(
		await emitToolResult(handlers, {
			toolName: "edit",
			input: { path: "x" },
			content: [{ type: "text", text: "permission denied" }],
			isError: true,
		}),
		undefined,
		"non-not-found failures keep their native error",
	);
	assert.equal(
		await emitToolResult(handlers, {
			toolName: "edit",
			input: { path: "x" },
			content: [{ type: "text", text: "Found 2 occurrences of the text in x" }],
			isError: true,
		}),
		undefined,
		"duplicate-match failures are NOT fuzzy-retried",
	);
});

test("hook retry: 1.0.4 {path, edits:[{oldText,newText}]} input rewrites the file", async () => {
	const { file, dir } = tmpFile("function hello() {\n\treturn 1;\n}\n");
	try {
		const { pi, handlers } = makePi();
		wrapEditWithResilientReplace(pi as never);

		const result = await emitToolResult(
			handlers,
			notFoundEvent({ path: file, edits: [{ oldText: "return 1;", newText: "return 2;" }] }),
		);
		assert.ok(result, "hook returned a replacement result");
		assert.equal(result?.isError, false, "the failed result is replaced by a success result");
		const text = result?.content?.[0]?.text ?? "";
		assert.ok(text.includes("resilient cascade"), "result announces the resilient cascade");
		assert.ok(text.includes(file), "result references the edited path");
		const after = fs.readFileSync(file, "utf8");
		assert.ok(after.includes("return 2;"), "new text present in the file");
		assert.ok(!after.includes("return 1;"), "old text replaced in the file");
	} finally {
		await removeDirWithRetry(dir);
	}
});

test("hook retry: legacy flat snake_case params still work", async () => {
	const { file, dir } = tmpFile("const x = 10;\n");
	try {
		const { pi, handlers } = makePi();
		wrapEditWithResilientReplace(pi as never);
		const result = await emitToolResult(handlers, notFoundEvent({ old_string: "x = 10", new_string: "x = 42", path: file }));
		assert.ok(result?.content?.[0]?.text.includes("resilient cascade"), "legacy params retried");
		assert.ok(fs.readFileSync(file, "utf8").includes("x = 42"), "legacy params applied to the file");
	} finally {
		await removeDirWithRetry(dir);
	}
});

test("hook retry is ALL-OR-NOTHING: an unmatched edit leaves the file untouched", async () => {
	const { file, dir } = tmpFile("alpha\nbeta\n");
	try {
		const { pi, handlers } = makePi();
		wrapEditWithResilientReplace(pi as never);
		const result = await emitToolResult(
			handlers,
			notFoundEvent({
				path: file,
				edits: [
					{ oldText: "alpha", newText: "ALPHA" },
					{ oldText: "does-not-exist-anywhere", newText: "x" },
				],
			}),
		);
		assert.equal(result, undefined, "no replacement when one entry cannot be matched");
		assert.equal(fs.readFileSync(file, "utf8"), "alpha\nbeta\n", "file untouched (no half-write)");
	} finally {
		await removeDirWithRetry(dir);
	}
});

test("hook retry: exhausted cascade and unreadable path return undefined (native error stands)", async () => {
	const { file, dir } = tmpFile("unchanged content\n");
	try {
		const { pi, handlers } = makePi();
		wrapEditWithResilientReplace(pi as never);
		assert.equal(
			await emitToolResult(handlers, notFoundEvent({ path: file, edits: [{ oldText: "nowhere-in-file", newText: "x" }] })),
			undefined,
			"exhausted cascade → native error stands",
		);
		assert.equal(fs.readFileSync(file, "utf8"), "unchanged content\n", "file untouched");
		assert.equal(
			await emitToolResult(
				handlers,
				notFoundEvent({ path: path.join(dir, "missing-file.txt"), edits: [{ oldText: "a", newText: "b" }] }),
			),
			undefined,
			"unreadable path → native error stands",
		);
		assert.equal(
			await emitToolResult(handlers, notFoundEvent({ edits: [{ oldText: "a", newText: "b" }] })),
			undefined,
			"no path → no retry",
		);
	} finally {
		await removeDirWithRetry(dir);
	}
});

test("hook retry: replaceAll threads through the cascade", async () => {
	const { file, dir } = tmpFile("dup\ndup\ndup\n");
	try {
		const { pi, handlers } = makePi();
		wrapEditWithResilientReplace(pi as never);
		const result = await emitToolResult(
			handlers,
			notFoundEvent({ path: file, edits: [{ oldText: "dup ", newText: "ok", replaceAll: true }] }),
		);
		assert.ok(result?.content?.[0]?.text.includes("resilient cascade"), "cascade ran");
		const after = fs.readFileSync(file, "utf8");
		assert.equal((after.match(/ok/g) ?? []).length, 3, "all occurrences replaced via replaceAll");
	} finally {
		await removeDirWithRetry(dir);
	}
});

test("auto-disables when pi-diff is present in the REAL getAllTools() listing", () => {
	for (const entry of [
		{ name: "edit", namespace: { name: "pi-diff-tools" } },
		{
			name: "edit",
			sourceInfo: { path: "/home/u/.pi/extensions/pi-diff/index.js", source: "package", scope: "user", origin: "package" },
		},
	]) {
		const { pi, handlers, registeredEvents } = makePi({ allTools: [entry] });
		assert.equal(wrapEditWithResilientReplace(pi as never), false, `pi-diff entry must disable the wrapper: ${JSON.stringify(entry)}`);
		assert.equal(handlers.length, 0, "no hook registered");
		assert.deepEqual(registeredEvents, [], "on() never called");
	}
});

test("not applied when the api exposes no on() (nothing to hook)", () => {
	const { pi } = makePi({ withOn: false });
	assert.equal(wrapEditWithResilientReplace(pi as never), false);
});

test("getAllTools() throwing does not break the wrap decision", () => {
	const { pi, handlers } = makePi();
	(pi as unknown as { getAllTools: () => unknown[] }).getAllTools = () => {
		throw new Error("not ready");
	};
	assert.equal(wrapEditWithResilientReplace(pi as never), true, "detection failure degrades to 'pi-diff absent'");
	assert.equal(handlers.length, 1);
});
