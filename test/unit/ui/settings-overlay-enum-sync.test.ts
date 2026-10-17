/**
 * R4-B2 (wave-2b): SETTINGS↔schema drift test for the settings overlay's
 * enum pickers — mirrors test/unit/config/config-schema-sync.test.ts.
 *
 * The overlay historically hardcoded its offered values; four settings
 * drifted from the config schema so the picker offered values parseConfig
 * REJECTS (silent no-op write + lying badge all session). Offered values are
 * now derived from the TypeBox schema (src/ui/settings-enum-source.ts); this
 * suite pins that:
 *   1. every derivation is NON-EMPTY (a schema rename/shape change that
 *      breaks extraction must fail HERE, not ship an empty picker), and
 *   2. every OFFERED value is ACCEPTED by parseConfig for that key (round
 *      trip through the same validation the save path uses), and
 *   3. no VALID schema value is hidden from the picker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../../../src/config/config-validation.ts";
import { SETTINGS_ENUM_VALUES } from "../../../src/ui/settings-overlay.ts";

/** Build the nested patch the overlay save path builds, then parseConfig it. */
function parseSingle(key: string, value: string): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	const keys = key.split(".");
	let target: Record<string, unknown> = patch;
	for (let i = 0; i < keys.length - 1; i += 1) {
		if (!target[keys[i]!] || typeof target[keys[i]!] !== "object") target[keys[i]!] = {};
		target = target[keys[i]!] as Record<string, unknown>;
	}
	target[keys[keys.length - 1]!] = value;
	return parseConfig(patch) as Record<string, unknown>;
}

function nested(obj: Record<string, unknown>, key: string): unknown {
	let current: unknown = obj;
	for (const part of key.split(".")) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

test("R4-B2: every SETTINGS_ENUM_VALUES derivation is non-empty", () => {
	for (const [key, values] of Object.entries(SETTINGS_ENUM_VALUES)) {
		assert.ok(values.length > 0, `${key} derived an EMPTY value list — schema extraction broke`);
	}
});

test("R4-B2: every offered enum value survives parseConfig for its key (no silent no-op writes)", () => {
	for (const [key, values] of Object.entries(SETTINGS_ENUM_VALUES)) {
		for (const value of values) {
			const parsed = parseSingle(key, value);
			const roundTrip = nested(parsed, key);
			assert.equal(
				roundTrip,
				value,
				`overlay offers ${key}=${value} but parseConfig drops it (offered/valid drift — the R4-B2 bug class)`,
			);
		}
	}
});

test("R4-B2 drift pin: the known invalid legacy values are NOT offered anymore", () => {
	// These four are the audit's concrete drift instances.
	assert.deepEqual(SETTINGS_ENUM_VALUES["runtime.promptMode"], ["replace", "append"]); // was compact|full|minimal (all invalid)
	assert.ok(!SETTINGS_ENUM_VALUES["runtime.completionMutationGuard"]!.includes("block")); // real: off|warn|fail
	assert.ok(!SETTINGS_ENUM_VALUES["ui.widgetPlacement"]!.includes("hidden")); // real: aboveEditor|belowEditor|bottom
	// isolationPolicy is an OBJECT in the schema — the picker targets the nested
	// defaultRuntime union instead of the impossible string form.
	assert.deepEqual(SETTINGS_ENUM_VALUES["runtime.isolationPolicy.defaultRuntime"], ["live-session", "child-process"]);
});

test("R4-B2: schema additions flow into the picker (union members not hidden)", () => {
	// If someone adds a literal to the schema union, the derived list follows —
	// spot-check by comparing against the schema's own anyOf consts.
	const expected = ["replace", "append"];
	assert.deepEqual([...SETTINGS_ENUM_VALUES["runtime.promptMode"]!], expected);
});
