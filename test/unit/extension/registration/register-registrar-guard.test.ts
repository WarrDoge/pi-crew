/**
 * R49-F5 (wave-6 M4-R2) — registrar guard.
 *
 * register.ts ran ~17 registrar calls in a flat sequence: ANY throw aborted the
 * remaining registrars and left a partial extension with no diagnostic. The
 * guard catches per-registrar, counts + logs the failure, CONTINUES, and emits
 * ONE consolidated warning. This pins: (1) a throwing registrar does not abort
 * later registrars, and (2) the failure is surfaced (counted + named).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { registerPiTeams } from "../../../../src/extension/register.ts";

function createEventBus() {
	const handlers = new Map<string, Set<(payload: unknown) => void>>();
	return {
		on(event: string, handler: (payload: unknown) => void) {
			const set = handlers.get(event) ?? new Set<(payload: unknown) => void>();
			set.add(handler);
			handlers.set(event, set);
			return () => {
				set.delete(handler);
			};
		},
		emit(event: string, payload: unknown) {
			for (const handler of handlers.get(event) ?? []) handler(payload);
		},
		off(event: string, handler: (payload: unknown) => void) {
			handlers.get(event)?.delete(handler);
		},
	};
}

/**
 * Fake Pi whose `registerTool` throws for the `team` tool ONLY — that call is
 * made by the `piTools` registrar, so `registerPiTools` throws while every
 * other registrar (and the later `piCommands` one) must still run.
 */
function createThrowingPi() {
	const eventHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
	const registeredTools: Array<{ name?: string }> = [];
	const registeredCommands: string[] = [];
	const registeredShortcuts: Array<{ key: unknown }> = [];
	const registeredRenderers: string[] = [];
	const registeredProviders: string[] = [];
	let sessionName: string | undefined;
	return {
		events: createEventBus(),
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			const list = eventHandlers.get(event) ?? [];
			list.push(handler);
			eventHandlers.set(event, list);
		},
		registeredTools,
		registeredCommands,
		registeredShortcuts,
		registeredRenderers,
		registeredProviders,
		registerTool(tool: { name?: string }) {
			if (tool?.name === "team") throw new Error("simulated registrar failure");
			registeredTools.push({ name: tool?.name });
		},
		registerCommand(name: string, _options: unknown) {
			registeredCommands.push(name);
		},
		registerShortcut(key: unknown, _options: unknown) {
			registeredShortcuts.push({ key });
		},
		registerMessageRenderer(customType: string, _renderer: unknown) {
			registeredRenderers.push(customType);
		},
		registerProvider(name: string, _config: unknown) {
			registeredProviders.push(name);
		},
		appendEntry(_type: string, _data?: unknown) {
			/* no-op fake */
		},
		getSessionName() {
			return sessionName;
		},
		setSessionName(name: string) {
			sessionName = name;
		},
	};
}

test("a throwing registrar does not abort later registrars and is surfaced (R49-F5)", async () => {
	const pi = createThrowingPi();
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
	};
	try {
		// (1) the failure must NOT propagate — extension load stays resilient.
		await assert.doesNotReject(registerPiTeams(pi as unknown as Parameters<typeof registerPiTeams>[0]));
	} finally {
		console.warn = originalWarn;
	}

	// (2) later registrars ran despite the piTools failure (proves continue).
	assert.ok(
		pi.registeredCommands.includes("teams"),
		`piCommands runs AFTER piTools — its command must still register, got: ${pi.registeredCommands.join(", ")}`,
	);

	// (3) the failure was counted + named in ONE consolidated warning.
	const consolidated = warnings.find((w) => w.includes("subsystem(s) failed to register"));
	assert.ok(consolidated, `expected a consolidated registrar-failure warning, got: ${JSON.stringify(warnings)}`);
	assert.ok(consolidated!.includes("piTools"), `warning must name the failing subsystem, got: ${consolidated}`);
	assert.ok(consolidated!.includes("simulated registrar failure"), `warning must carry the error detail, got: ${consolidated}`);
});

test("happy path: no registrar-failure warning is emitted", async () => {
	const pi = createThrowingPi();
	// Replace the throwing registerTool with a passthrough so every registrar runs.
	(pi as unknown as { registerTool: (tool: { name?: string }) => void }).registerTool = (tool: { name?: string }) => {
		pi.registeredTools.push({ name: tool?.name });
	};
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
	};
	try {
		await registerPiTeams(pi as unknown as Parameters<typeof registerPiTeams>[0]);
	} finally {
		console.warn = originalWarn;
	}
	assert.ok(
		!warnings.some((w) => w.includes("subsystem(s) failed to register")),
		`a clean registration must emit no failure warning, got: ${JSON.stringify(warnings)}`,
	);
	assert.ok(pi.registeredCommands.includes("teams"), "clean registration still registers commands");
});
