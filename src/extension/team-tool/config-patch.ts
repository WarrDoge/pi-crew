import { effectiveAutonomousConfig, type PiTeamsAutonomousConfig, type PiTeamsConfig, parseConfig } from "../../config/config.ts";
import { stripDangerousKeysDeep } from "../../config/config-validation.ts";
import { collectSensitiveConfigPaths } from "../../schema/sensitive-config-paths.ts";

/**
 * Recursively strip dangerous prototype-pollution keys from all levels of an
 * object. M1-1: delegates to the shared proto-safe helpers (config-validation.ts,
 * case-insensitive
 * DANGEROUS_OBJECT_KEYS superset) so every config-patch parse boundary applies
 * ONE canonical drop rule — config patch, autonomy patch, and
 * effectiveRunConfig all flow through here or through parseConfig's asRecord.
 */
export function sanitizeObject<T>(obj: T): T {
	return stripDangerousKeysDeep(obj);
}

export function autonomousPatchFromConfig(config: unknown): PiTeamsAutonomousConfig {
	const rootPatch = parseConfig(config).autonomous;
	if (rootPatch) return rootPatch;
	return parseConfig({ autonomous: config }).autonomous ?? {};
}

export function configPatchFromConfig(config: unknown): PiTeamsConfig {
	return parseConfig(config);
}

/**
 * M1-8 (R45-S2): drop the schema's sensitive-marked config paths from the
 * RUN-PARAM tier. `params.config` is worker/LLM-influenced tool input — the
 * same fields a project file may not set (user-only kill-switches and
 * execution-shaping knobs: executeWorkers, runtime.mode/isolationPolicy,
 * worktree.setupHook/seedPaths, agents.overrides, otlp.*, policy.*,
 * autonomous.*, goalWrap, …) must not be settable through run params either.
 *
 * Drops mutate the FRESH parseConfig output only — never the caller's input
 * and never `base` (the loaded user/project config, already project-tier
 * sanitized at load). Sensitive keys are dropped SILENTLY: the drop is the
 * contract, and the persisted `manifest.runConfig` records the effective
 * (post-drop) config for audit. Precedence note (P4 pin): with
 * `executeWorkers` dropped from the patch, a user's `executeWorkers:false`
 * survives untouched — the kill-switch cannot be flipped back on via run
 * params (runtime-resolver reads the merged effective config).
 *
 * Conditional carve-out (mirrors the project tier's CONDITIONAL_PROJECT_DROPS
 * doctrine: loosening values dropped, tightening values survive): a run param
 * may still TIGHTEN `runtime.mode` to "scaffold" — the documented params
 * dry-run channel ("Set runtime.mode=scaffold … only for dry runs", run tool
 * banner) spawns no workers and is the SAFE direction. Loosening modes
 * (auto/child-process/live-session — the R45-S2 escalation threat) are
 * dropped like every other sensitive value.
 */
const RUNPARAM_CONDITIONAL_KEEP: Record<string, (value: unknown) => boolean> = {
	"runtime.mode": (value) => value === "scaffold",
};

function dropSensitivePatchPaths(patch: Record<string, unknown>): void {
	for (const dotted of collectSensitiveConfigPaths()) {
		const parts = dotted.split(".");
		let node: Record<string, unknown> | undefined = patch;
		for (let i = 0; node !== undefined && i < parts.length - 1; i++) {
			const next: unknown = node[parts[i]!];
			node = next !== null && typeof next === "object" && !Array.isArray(next) ? (next as Record<string, unknown>) : undefined;
		}
		if (node === undefined) continue;
		const leaf = parts[parts.length - 1]!;
		if (RUNPARAM_CONDITIONAL_KEEP[dotted]?.(node[leaf])) continue;
		delete node[leaf];
	}
}

export function effectiveRunConfig(base: PiTeamsConfig, rawOverride: unknown): PiTeamsConfig {
	const patch = sanitizeObject(parseConfig(rawOverride));
	dropSensitivePatchPaths(patch as Record<string, unknown>);
	return {
		...base,
		...patch,
		limits: patch.limits ? { ...(base.limits ?? {}), ...patch.limits } : base.limits,
		runtime: patch.runtime ? { ...(base.runtime ?? {}), ...patch.runtime } : base.runtime,
		control: patch.control ? { ...(base.control ?? {}), ...patch.control } : base.control,
		worktree: patch.worktree ? { ...(base.worktree ?? {}), ...patch.worktree } : base.worktree,
	};
}

export function formatAutonomyStatus(config: PiTeamsAutonomousConfig | undefined, pathValue: string, updated: boolean): string {
	const effective = effectiveAutonomousConfig(config);
	return [
		updated ? "Updated pi-crew autonomous mode." : "pi-crew autonomous mode:",
		`Path: ${pathValue}`,
		`Profile: ${effective.profile}`,
		`Enabled: ${effective.enabled}`,
		`Inject policy: ${effective.injectPolicy}`,
		`Prefer async for long tasks: ${effective.preferAsyncForLongTasks}`,
		`Allow worktree suggestion: ${effective.allowWorktreeSuggestion}`,
	].join("\n");
}
