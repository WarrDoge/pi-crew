/**
 * settings-enum-source.ts — R4-B2 (wave-2b): single source for the enum
 * values the settings overlay OFFERS.
 *
 * The overlay previously hardcoded its value lists; four of them drifted
 * from the config schema so the picker offered values `parseConfig` REJECTS
 * (promptMode offered all-3-invalid, completionMutationGuard offered "block",
 * widgetPlacement offered "hidden", isolationPolicy offered strings while the
 * schema expects an object) — the operator picked a value, the badge showed
 * it all session, and the write silently dropped it.
 *
 * The offered values are now DERIVED from the TypeBox config schema — the
 * same schema `validateConfig`/`schema.json` are generated from, so a future
 * schema change moves the picker with it (a drift test,
 * test/unit/ui/settings-overlay-enum-sync.test.ts, pins the wiring).
 */

import { PiTeamsRuntimeConfigSchema, PiTeamsUiConfigSchema } from "../schema/config-schema.ts";

/** Extract the literal values of a TypeBox Union-of-Literals node. */
function literalUnionValues(node: unknown): string[] {
	const union = node as { anyOf?: Array<{ const?: unknown }> } | undefined;
	if (!union || !Array.isArray(union.anyOf)) return [];
	const values: string[] = [];
	for (const entry of union.anyOf) {
		if (entry && typeof entry.const === "string") values.push(entry.const);
	}
	return values;
}

function schemaProperty(schema: { properties?: Record<string, unknown> }, key: string): unknown {
	return (schema.properties as Record<string, unknown> | undefined)?.[key];
}

const runtimeProperties = PiTeamsRuntimeConfigSchema.properties as Record<string, unknown> | undefined;
const uiProperties = PiTeamsUiConfigSchema.properties as Record<string, unknown> | undefined;

/** Setting id → schema-derived offered values (empty list = derive bug, fail loud in the drift test). */
export const SETTINGS_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
	"runtime.mode": literalUnionValues(schemaProperty(PiTeamsRuntimeConfigSchema, "mode")),
	"runtime.promptMode": literalUnionValues(runtimeProperties?.promptMode),
	"runtime.completionMutationGuard": literalUnionValues(runtimeProperties?.completionMutationGuard),
	// isolationPolicy is an OBJECT in the schema (isolatedRoles + defaultRuntime)
	// — the old string picker could never round-trip. The picker now targets the
	// nested defaultRuntime union, whose values the schema actually accepts.
	"runtime.isolationPolicy.defaultRuntime": literalUnionValues(
		(schemaProperty(PiTeamsRuntimeConfigSchema, "isolationPolicy") as { properties?: Record<string, unknown> } | undefined)?.properties
			?.defaultRuntime,
	),
	"ui.dashboardPlacement": literalUnionValues(schemaProperty(PiTeamsUiConfigSchema, "dashboardPlacement")),
	"ui.widgetPlacement": literalUnionValues(uiProperties?.widgetPlacement),
};
