/**
 * N-6 (DR-04 round 7): the crew global registry is installed from a LAZY
 * `import("../team-tool.ts")` continuation. If the runtime is torn down
 * (session_shutdown / session-switch cleanup) before that import resolves,
 * the late `.then` must NOT install the registry — that would resurrect
 * extension state for a disposed registration. Guard: skip install when the
 * registration generation moved on or ctx.cleanedUp is set (debug log).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildRegistrationContext } from "../../../../src/extension/registration/context-builder.ts";
import { installRuntimeCleanup } from "../../../../src/extension/registration/runtime-cleanup.ts";
import { installCrossExtensionWiring } from "../../../../src/extension/registration/wire-cross-extension.ts";
import { getCrewGlobalRegistry, uninstallCrewGlobalRegistry } from "../../../../src/extension/team-tool.ts";

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
			for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
		},
	};
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("N-6: late team-tool import after cleanupRuntime does NOT install the crew registry", async () => {
	uninstallCrewGlobalRegistry();
	const events = createEventBus();
	const pi = { events };
	const ctx = buildRegistrationContext(pi as never);
	installRuntimeCleanup(pi as never, ctx);

	// Wiring kicks off the lazy import; full shutdown runs SYNCHRONOUSLY in the
	// same tick, so the import continuation is guaranteed to observe the
	// disposed registration (import() always resolves on a later microtask).
	installCrossExtensionWiring(pi as never, ctx);
	ctx.cleanupRuntime();

	// Let the import + its .then continuation run.
	await sleep(300);

	assert.equal(
		getCrewGlobalRegistry(),
		undefined,
		"late install must be skipped when cleanupRuntime already ran (no registry resurrection)",
	);
});

test("N-6 (control): without cleanup the lazy import installs the crew registry", async () => {
	uninstallCrewGlobalRegistry();
	const events = createEventBus();
	const pi = { events };
	const ctx = buildRegistrationContext(pi as never);
	installRuntimeCleanup(pi as never, ctx);

	installCrossExtensionWiring(pi as never, ctx);

	// First load of the heavy team-tool chain can take a while — poll.
	let installed = false;
	for (let i = 0; i < 100 && !installed; i++) {
		await sleep(100);
		installed = getCrewGlobalRegistry() !== undefined;
	}
	assert.ok(installed, "control: the lazy import must install the registry when no cleanup raced it");

	uninstallCrewGlobalRegistry();
	ctx.rpcHandle?.unsubscribe();
});
