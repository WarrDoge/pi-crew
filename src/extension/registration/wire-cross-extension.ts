/**
 * Cross-extension wiring helper.
 *
 * Two small wires:
 *   • wireRpc — the in-process pi-crew RPC handle (other modules in
 *     the same extension can subscribe via `pi.events`).
 *   • wireGlobalRegistry — the crew registry, lazily loaded from
 *     team-tool.ts (heavy module) and installed in module-scoped state so
 *     the rest of pi-crew can discover pi-crew's RPC handle at runtime
 *     (EXT-9: no longer on globalThis[Symbol.for(...)]).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logInternalError } from "../../utils/internal-error.ts";
import { registerPiCrewRpc } from "../cross-extension-rpc.ts";
import type { RegistrationContext } from "./registration-types.ts";

/**
 * N-6 (DR-04 round 7): shared generation/ownership guard for the late lazy
 * team-tool import. The dynamic import resolves on a LATER tick — a
 * session_shutdown (or session-switch cleanup) may already have torn the
 * runtime down by then, and installing the crew registry after teardown would
 * resurrect extension state for a disposed registration. Skip the install
 * when the registration generation moved on or the context is marked
 * cleaned-up; session_start rebinds the registry via
 * refreshCrossExtensionWiringForSession anyway.
 */
function registryInstallSkipped(ctx: RegistrationContext, installGeneration: number, where: string): boolean {
	if (!ctx.cleanedUp && ctx.sessionGeneration === installGeneration) return false;
	logInternalError(
		"register.wire-cross-extension",
		new Error(`skipped crew registry install (${where}): runtime cleanup already ran before the lazy import resolved`),
		`installGeneration=${installGeneration},currentGeneration=${ctx.sessionGeneration},cleanedUp=${ctx.cleanedUp}`,
		"debug",
	);
	return true;
}

/** Install both wires on the registration context. */
export function installCrossExtensionWiring(pi: ExtensionAPI, ctx: RegistrationContext): void {
	// Wire the in-process RPC handle.
	const getPiEvents = (): Parameters<typeof registerPiCrewRpc>[0] | undefined => {
		if (pi && typeof pi === "object" && "events" in pi) {
			return (pi as { events?: Parameters<typeof registerPiCrewRpc>[0] }).events;
		}
		return undefined;
	};
	ctx.rpcHandle = registerPiCrewRpc(getPiEvents(), () => ctx.currentCtx);

	// Install the crew registry. Lazy import keeps team-tool.ts (which pulls
	// in the entire runtime chain) out of the cold-start module graph. EXT-9:
	// the registry now lives in module-scoped state, not globalThis.
	const installGeneration = ctx.sessionGeneration;
	void import("../team-tool.ts").then(({ installCrewGlobalRegistry }) => {
		// LAZY: defer team-tool until cross-extension wiring fires
		if (registryInstallSkipped(ctx, installGeneration, "install")) return;
		const manifestCacheForRegistry = ctx.getManifestCache(ctx.currentCtx?.cwd ?? process.cwd());
		installCrewGlobalRegistry({
			manifestCache: manifestCacheForRegistry,
			cwdProvider: () => ctx.currentCtx?.cwd ?? process.cwd(),
		});
	});
}

/**
 * F13 (RR-018): refresh the extension-lifetime cross-extension wiring for a
 * new session. Called on every `session_start`.
 *
 * The RPC handle is installed ONCE at registration and survives session
 * switches — its `getCtx` closure resolves the CURRENT session context at
 * request time, so nothing needs reinstalling (re-registering would double
 * the pi-crew:rpc:* subscriptions). The crew global registry IS rebound to
 * the current session's manifest cache so a cross-project switch never
 * leaves it reading a stale project's runs. Idempotent and cheap (a plain
 * object construction — installCrewGlobalRegistry swaps the module-scoped
 * singleton atomically).
 */
export function refreshCrossExtensionWiringForSession(pi: ExtensionAPI, ctx: RegistrationContext): void {
	if (!ctx.rpcHandle) {
		// Edge: registration never installed the handle (or a full shutdown
		// removed it) — install it once, idempotently.
		installCrossExtensionWiring(pi, ctx);
		return;
	}
	const installGeneration = ctx.sessionGeneration;
	void import("../team-tool.ts").then(({ installCrewGlobalRegistry }) => {
		// LAZY: defer team-tool until cross-extension wiring fires
		if (registryInstallSkipped(ctx, installGeneration, "session-refresh")) return;
		installCrewGlobalRegistry({
			manifestCache: ctx.getManifestCache(ctx.currentCtx?.cwd ?? process.cwd()),
			cwdProvider: () => ctx.currentCtx?.cwd ?? process.cwd(),
		});
	});
}
