/**
 * pi-crew extension entry point.
 *
 * Single import surface Pi calls during extension load: `registerPiTeams(pi)`.
 * Delegates to focused modules under `./registration/`:
 *   • registration-types        — shared RegistrationContext
 *   • context-builder           — buildRegistrationContext (state init)
 *   • subagent-manager-setup    — SubagentManager + callbacks
 *   • foreground-run-controller — start/abort/openLiveSidebar
 *   • runtime-cleanup           — cleanupRuntime + cleanupSwitch
 *   • lazy-configurers          — notifications/observability/delivery
 *   • lifecycle-handlers        — session_start/shutdown/before_switch
 *   • hook-registration         — tool_call/tool_result/resources_discover
 *   • tool-registration         — registerTeamTool + registerSubagentTools
 *   • command-registration      — registerTeamCommands
 *   • crash-recovery-cache      — lazy importCrashRecovery
 *   • wire-cross-extension      — RPC handle + global registry install
 *   • terminal-status-wiring — tab title + Ghostty progress (runEventBus)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/config.ts";
import { validateEnv } from "../config/migration-validator.ts";
import { startRuntimeWarmup } from "../runtime/model/runtime-warmup.ts";
import { primePeerDep } from "../runtime/peer-dep.ts";
import { deployBundledThemes } from "../ui/deploy-bundled-themes.ts";
import { installChildProcessAbortShield } from "../utils/child-process-shield.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { resetTimings, time } from "../utils/timings.ts";
import { registerAutonomousPolicy } from "./autonomous-policy.ts";
import { registerContextStatusInjection } from "./context-status-injection.ts";
import { registerCrewInputRouter } from "./crew-input-router.ts";
import { registerCrewShortcuts } from "./crew-shortcuts.ts";
import { registerCrewVibes } from "./crew-vibes/index.ts";
import { registerKnowledgeInjection } from "./knowledge-injection.ts";
import { registerCrewMessageRenderers } from "./message-renderers.ts";
import { runPostInitSkillCheck } from "./post-init-skill-check.ts";
import { registerPiCommands } from "./registration/command-registration.ts";
import { buildRegistrationContext } from "./registration/context-builder.ts";
import { importCrashRecovery, purgeStaleActiveRunIndexSyncIfLoaded } from "./registration/crash-recovery-cache.ts";
import { installForegroundRunController } from "./registration/foreground-run-controller.ts";
import { installPiHooks } from "./registration/hook-registration.ts";
import { installLazyConfigurers } from "./registration/lazy-configurers.ts";
import { installCrewBrokerLifecycleController, installSessionLifecycleHandlers } from "./registration/lifecycle-handlers.ts";
import { installRuntimeCleanup } from "./registration/runtime-cleanup.ts";
import { __test__subagentSpawnParams } from "./registration/subagent-helpers.ts";
import { installSubagentManager } from "./registration/subagent-manager-setup.ts";
import { installTerminalStatus } from "./registration/terminal-status-wiring.ts";
import { registerPiTools } from "./registration/tool-registration.ts";
import { installCrossExtensionWiring } from "./registration/wire-cross-extension.ts";

export { __test__subagentSpawnParams };

/**
 * Pi extension entry point. See module-level docstring for the full pipeline.
 */
export async function registerPiTeams(pi: ExtensionAPI): Promise<void> {
	resetTimings();
	time("register:start");

	// MUST run before any team run can start: guarantees every signal-spawned
	// child in the process has an 'error' listener so Node's abort-after-exit
	// AbortError dispatches instead of being rethrown on the next tick as an
	// uncaughtException that kills pi (see child-process-shield.ts for the
	// full crash chain — /crew-view mid-run crash).
	installChildProcessAbortShield();

	// WI-5.6 wiring (review remediation 2026-09-10): surface deprecated /
	// removed / reverted PI_CREW_* env keys as ONE consolidated startup
	// warning — warn, never fail (spec M5 acceptance). validateEnv is a pure
	// scanner over the env-registry (env-vars.ts) and never throws.
	const envWarnings = validateEnv(process.env);
	if (envWarnings.warnings.length > 0) {
		console.warn(
			`[pi-crew] ${envWarnings.warnings.length} deprecated env var(s) in use:\n` +
				envWarnings.warnings.map((w) => `  ${w.name}: ${w.message}`).join("\n"),
		);
	}

	// Wave-3 (attack-chain A / R2-M-B1 hardening): hermeticWorkers is DEFAULT
	// ON; runtime.hermeticWorkers=false is a deliberate trust downgrade (worker
	// pi sessions load ambient extensions/skills — the parity state where a
	// repo-planted worker can reach the `team` tool's user-tier persistence).
	// Emit ONE prominent warning at extension init so the operator sees it.
	try {
		if (loadConfig(process.cwd()).config.runtime?.hermeticWorkers === false) {
			console.warn(
				"[pi-crew] ⚠ SECURITY: runtime.hermeticWorkers=false — workers will load ambient extensions/skills (non-default trust posture). Worker sessions can then persist user-tier config/agents (every future session). Re-enable hermetic spawns unless parity mode is specifically required.",
			);
		}
	} catch {
		/* config read failures surface through their own channel */
	}

	startRuntimeWarmup();
	primePeerDep().catch(() => undefined);
	deployBundledThemes();

	const ctx = buildRegistrationContext(pi);
	ctx.importCrashRecovery = importCrashRecovery;
	ctx.purgeStaleActiveRunIndexSyncIfLoaded = purgeStaleActiveRunIndexSyncIfLoaded;

	// R49-F5 (wave-6 M4-R2) — registrar guard. The registrars below run in a
	// flat sequence; before this guard ANY throw aborted the remaining
	// registrars and left a PARTIAL extension with no diagnostic (Pi's loader
	// discards the rejection). Guard each call: on throw, record the subsystem
	// name, log it through the internal-error channel, and CONTINUE — extension
	// load must never break the session, but a failed subsystem must be
	// visible. ONE consolidated warning is surfaced before the skill check.
	const registrarFailures: string[] = [];
	const withRegistrar = <T>(name: string, fn: () => T): T | undefined => {
		try {
			return fn();
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			registrarFailures.push(`${name} (${detail})`);
			logInternalError(`register.${name}`, err, "extension registration subsystem");
			return undefined;
		}
	};

	withRegistrar("runtimeCleanup", () => installRuntimeCleanup(pi, ctx));
	withRegistrar("foregroundRunController", () => installForegroundRunController(pi, ctx));
	withRegistrar("subagentManager", () => installSubagentManager(pi, ctx));
	withRegistrar("lazyConfigurers", () => installLazyConfigurers(pi, ctx));
	withRegistrar("crossExtensionWiring", () => installCrossExtensionWiring(pi, ctx));

	time("register.policy");
	withRegistrar("autonomousPolicy", () => registerAutonomousPolicy(pi));
	withRegistrar("knowledgeInjection", () => registerKnowledgeInjection(pi));

	withRegistrar("piTools", () => registerPiTools(pi, ctx));
	withRegistrar("piCommands", () => registerPiCommands(pi, ctx));
	withRegistrar("piHooks", () => installPiHooks(pi, ctx));
	withRegistrar("sessionLifecycleHandlers", () => installSessionLifecycleHandlers(pi, ctx));
	// Phase 0 inter-pi broker: install the lifecycle controller immediately
	// after the session handlers. The controller's gate (broker.enabled AND
	// root-session only) decides whether anything is actually done; for
	// subagents or when the flag is off, it returns a no-op controller.
	ctx.brokerController = withRegistrar("crewBrokerLifecycle", () => installCrewBrokerLifecycleController(pi, ctx));

	// M3-1 (UI-AUDIT P0-2/P1-1): wire the tab-title + Ghostty progress
	// controller to runEventBus. Before this the controller was never
	// constructed (dead since v0.8.3). Registers the dispose hook that the
	// SIGTERM/SIGHUP handler calls (crew-cleanup.ts).
	withRegistrar("terminalStatus", () => installTerminalStatus(pi, ctx));
	withRegistrar("compactionGuard", () =>
		registerCompactionGuard(pi, {
			foregroundControllers: ctx.foregroundControllers,
			foregroundTeamRunControllers: ctx.foregroundTeamRunControllers,
		}),
	);

	if (process.env.CREW_RESILIENT_EDIT === "1") {
		// R49-F5: do NOT swallow the outcome. `wrapEditWithResilientReplace`
		// returns false when the hook was NOT registered (pi-diff present or the
		// host lacks the tool_result seam) and the dynamic import can reject;
		// both were previously discarded, so an operator who set
		// CREW_RESILIENT_EDIT=1 got a silent no-op.
		// LAZY: resilient-edit only loads when the opt-in env var is set.
		import("../runtime/resilient-edit.ts")
			.then(({ wrapEditWithResilientReplace }) => {
				if (!wrapEditWithResilientReplace(pi)) {
					console.warn(
						"[pi-crew] CREW_RESILIENT_EDIT=1 but the resilient-edit wrapper did NOT register " +
							"(pi-diff detected or the host lacks the tool_result seam) — the opt-in is a no-op this session.",
					);
				}
			})
			.catch((err: unknown) => {
				logInternalError("register.resilientEdit", err, "CREW_RESILIENT_EDIT=1");
				console.warn(`[pi-crew] resilient-edit failed to load: ${err instanceof Error ? err.message : String(err)}`);
			});
	}

	withRegistrar("crewMessageRenderers", () => registerCrewMessageRenderers(pi));
	withRegistrar("crewInputRouter", () => registerCrewInputRouter(pi));
	withRegistrar("crewShortcuts", () => registerCrewShortcuts(pi));
	withRegistrar("contextStatusInjection", () =>
		registerContextStatusInjection(pi, {
			enabled: loadConfig(process.cwd()).config.reliability?.ambientStatusInjection !== false,
		}),
	);

	withRegistrar("crewVibes", () => registerCrewVibes(pi));

	if (registrarFailures.length > 0) {
		console.warn(`[pi-crew] ${registrarFailures.length} subsystem(s) failed to register: ${registrarFailures.join(", ")}`);
	}

	const skillCheck = await runPostInitSkillCheck(process.cwd());
	if (skillCheck.severity === "error") {
		console.error(`[pi-crew] ${skillCheck.message}`);
	} else if (skillCheck.severity === "warn") {
		console.warn(`[pi-crew] ${skillCheck.message}`);
	}
}

// Bottom-of-file import: keeps compaction-guard out of the top-level
// import surface to avoid pulling its heavy transitive deps.
import { registerCompactionGuard } from "./registration/compaction-guard.ts";
