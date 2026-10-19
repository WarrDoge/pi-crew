import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadConfig, updateConfig } from "../../../src/config/config.ts";
import { isDangerousKey, isDangerousPath, stripDangerousKeysDeep } from "../../../src/config/config-validation.ts";
import type { TeamContext } from "../../../src/extension/team-tool/context.ts";
import { handleSettings } from "../../../src/extension/team-tool/handle-settings.ts";
import { __test__resetI18n, addTranslations, listLocales } from "../../../src/i18n.ts";

/**
 * M1-1 (R24-H1/H2 + R46-7) — shared proto-safe key-drop pins.
 *
 * Runtime pins from the deep-review repro:
 * - `team-settings set __proto__.polluted 1` → dropped/rejected, and
 *   Object.prototype is UNCHANGED (own-property descriptor deep-equal).
 * - `team-settings unset __proto__.toString` → rejected,
 *   Object.prototype.toString intact.
 * - `addTranslations("__proto__", …)` must never reach the prototype
 *   (locale-axis pollution, R46-7).
 * Nested-path cases (`__proto__.polluted`, `constructor.prototype.x`, case
 * variants) are first-class: the dotted-path walkers hit `obj["__proto__"]`
 * (the [[Prototype]] getter) long before the final segment is written.
 *
 * Env discipline (project-scope settings + isolated PI_TEAMS_HOME): the
 * facade root-gate is bypassed by calling handleSettings directly, and the
 * real user config is never read or written.
 */

// --- helpers ---

/**
 * Own-property descriptor snapshot of Object.prototype.
 *
 * Deliberately a Map: the own names INCLUDE "__proto__" (an own accessor of
 * Object.prototype itself), and filing them into a plain object would route
 * that one key through the [[Prototype]] SETTER — reassigning the snapshot's
 * prototype instead of recording the entry (the exact R24-H1 mechanism this
 * suite pins; hit live by the first draft of this helper).
 */
function objectPrototypeSnapshot(): Map<string, PropertyDescriptor> {
	const snapshot = new Map<string, PropertyDescriptor>();
	for (const name of Object.getOwnPropertyNames(Object.prototype)) {
		snapshot.set(name, Object.getOwnPropertyDescriptor(Object.prototype, name)!);
	}
	return snapshot;
}

/**
 * Run `fn` with a fresh temp cwd and an isolated PI_TEAMS_HOME. All calls
 * here are synchronous (handleSettings/updateConfig/loadConfig) — keep it
 * that way (test env-scoping hazard: sync wrapper around async fn).
 */
function withIsolatedEnv(fn: (cwd: string) => void): void {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-proto-cwd-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-proto-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	try {
		fn(cwd);
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
	}
}

/** Invoke the team-settings handler at project scope inside the given cwd. */
function runSettings(args: string, cwd: string) {
	return handleSettings({ config: { args, scope: "project" } }, { cwd } as TeamContext);
}

// --- shared helper unit tests ---

test("isDangerousPath: catches nested pollution vectors", () => {
	assert.equal(isDangerousPath("__proto__.polluted"), true);
	assert.equal(isDangerousPath("constructor.prototype.x"), true);
	assert.equal(isDangerousPath("__proto__"), true);
	assert.equal(isDangerousPath("constructor"), true);
	assert.equal(isDangerousPath("prototype"), true);
	assert.equal(isDangerousPath("toString"), true);
});

test("isDangerousPath: case-insensitive on any segment", () => {
	assert.equal(isDangerousPath("__Proto__.polluted"), true);
	assert.equal(isDangerousPath("CONSTRUCTOR.prototype.x"), true);
	assert.equal(isDangerousPath("runtime.__PROTO__"), true);
});

test("isDangerousPath: safe dotted paths pass", () => {
	assert.equal(isDangerousPath("runtime.mode"), false);
	assert.equal(isDangerousPath("agents.overrides.worker.model"), false);
	assert.equal(isDangerousPath("otlp.headers.X-Api-Key"), false);
	assert.equal(isDangerousPath("notifications.dedupWindowMs"), false);
	assert.equal(isDangerousPath("prototypal.setting"), false); // prefix, not segment
});

test("isDangerousKey: case-insensitive membership", () => {
	assert.equal(isDangerousKey("__proto__"), true);
	assert.equal(isDangerousKey("__PROTO__"), true);
	assert.equal(isDangerousKey("valueOf"), true);
	assert.equal(isDangerousKey("runtime.mode"), false);
});

test("stripDangerousKeysDeep: drops own __proto__ (JSON.parse vector) deeply", () => {
	const input = JSON.parse('{"__proto__":{"polluted":1},"safe":"yes","nested":{"constructor":"x","deep":{"prototype":"y"}}}');
	const result = stripDangerousKeysDeep(input) as Record<string, unknown>;
	assert.equal(Object.hasOwn(result, "__proto__"), false);
	assert.equal(result.safe, "yes");
	const nested = result.nested as Record<string, unknown>;
	assert.equal(Object.hasOwn(nested, "constructor"), false);
	assert.equal(Object.hasOwn(nested.deep as Record<string, unknown>, "prototype"), false);
	// And the prototype was never touched:
	assert.equal((Object.prototype as unknown as Record<string, unknown>).polluted, undefined);
});

test("stripDangerousKeysDeep: passes through primitives and arrays, preserves safe keys", () => {
	assert.equal(stripDangerousKeysDeep("hello"), "hello");
	assert.equal(stripDangerousKeysDeep(42), 42);
	assert.equal(stripDangerousKeysDeep(null), null);
	assert.equal(stripDangerousKeysDeep(undefined), undefined);
	assert.equal(stripDangerousKeysDeep(true), true);
	const input = { a: 1, b: ["x", { c: 2 }], d: { e: 3 } };
	assert.deepEqual(stripDangerousKeysDeep(input), input);
});

// --- team-settings set/unset boundary pins (R24-H1/H2) ---

test("team-settings set __proto__.polluted 1 → rejected, Object.prototype unchanged (R24-H1)", () => {
	withIsolatedEnv((cwd) => {
		const before = objectPrototypeSnapshot();
		const res = runSettings("set __proto__.polluted 1", cwd);
		assert.equal(res.isError, true, "reserved key path must be rejected");
		assert.equal((Object.prototype as unknown as Record<string, unknown>).polluted, undefined);
		assert.deepEqual(objectPrototypeSnapshot(), before, "Object.prototype must be unchanged");
	});
});

test("team-settings set constructor.prototype.x → rejected (nested vector)", () => {
	withIsolatedEnv((cwd) => {
		const before = objectPrototypeSnapshot();
		const res = runSettings("set constructor.prototype.x 1", cwd);
		assert.equal(res.isError, true, "nested constructor.prototype path must be rejected");
		assert.deepEqual(objectPrototypeSnapshot(), before, "Object.prototype must be unchanged");
	});
});

test("team-settings set __Proto__.polluted (case variant) → rejected", () => {
	withIsolatedEnv((cwd) => {
		const before = objectPrototypeSnapshot();
		const res = runSettings("set __Proto__.polluted 1", cwd);
		assert.equal(res.isError, true, "case-variant reserved path must be rejected");
		assert.deepEqual(objectPrototypeSnapshot(), before, "Object.prototype must be unchanged");
	});
});

test("team-settings unset __proto__.toString → rejected, toString intact (R24-H2)", () => {
	withIsolatedEnv((cwd) => {
		const before = objectPrototypeSnapshot();
		const res = runSettings("unset __proto__.toString", cwd);
		assert.equal(res.isError, true, "reserved key path must be rejected");
		assert.equal(typeof Object.prototype.toString, "function", "Object.prototype.toString must survive");
		assert.deepEqual(objectPrototypeSnapshot(), before, "Object.prototype must be unchanged");
	});
});

test("team-settings unset constructor.prototype.x → rejected (nested vector)", () => {
	withIsolatedEnv((cwd) => {
		const before = objectPrototypeSnapshot();
		const res = runSettings("unset constructor.prototype.x", cwd);
		assert.equal(res.isError, true, "nested constructor.prototype path must be rejected");
		assert.deepEqual(objectPrototypeSnapshot(), before, "Object.prototype must be unchanged");
	});
});

// --- config-layer walker pin (covers every unsetPaths consumer, incl. team `config` action) ---

test("updateConfig unsetPaths with __proto__.toString → walker no-op, toString intact", () => {
	withIsolatedEnv((cwd) => {
		const before = objectPrototypeSnapshot();
		const saved = updateConfig({}, { cwd, scope: "project", unsetPaths: ["__proto__.toString"] });
		assert.equal(saved.written, false, "nothing should be written for a dropped unset path");
		assert.equal(typeof Object.prototype.toString, "function", "Object.prototype.toString must survive");
		assert.deepEqual(objectPrototypeSnapshot(), before, "Object.prototype must be unchanged");
	});
});

test("updateConfig unsetPaths still unsets legit nested keys", () => {
	withIsolatedEnv((cwd) => {
		updateConfig({ telemetry: { enabled: true } }, { cwd, scope: "project" });
		assert.equal(loadConfig(cwd).config.telemetry?.enabled, true);
		const saved = updateConfig({}, { cwd, scope: "project", unsetPaths: ["telemetry.enabled"] });
		assert.equal(saved.written, true);
		assert.equal(loadConfig(cwd).config.telemetry?.enabled, undefined);
	});
});

// --- safe-path regression: guard must not over-block normal settings ---

test("team-settings set/unset of safe keys still works", () => {
	withIsolatedEnv((cwd) => {
		const res = runSettings("set telemetry.enabled true", cwd);
		assert.equal(res.isError, false, "safe key set must succeed");
		assert.equal(loadConfig(cwd).config.telemetry?.enabled, true);
		const res2 = runSettings("unset telemetry.enabled", cwd);
		assert.equal(res2.isError, false, "safe key unset must succeed");
		assert.equal(loadConfig(cwd).config.telemetry?.enabled, undefined);
	});
});

// --- i18n addTranslations locale axis (R46-7) ---

test("addTranslations __proto__ locale → not registered, Object.prototype unchanged (R46-7)", () => {
	__test__resetI18n();
	const before = objectPrototypeSnapshot();
	addTranslations("__proto__", { "agent.started": "polluted" } as never);
	assert.ok(!listLocales().includes("__proto__"), "reserved locale must not be registered");
	assert.deepEqual(objectPrototypeSnapshot(), before, "Object.prototype must be unchanged");
});

test("addTranslations CONSTRUCTOR locale (case variant) → not registered", () => {
	__test__resetI18n();
	const before = objectPrototypeSnapshot();
	addTranslations("CONSTRUCTOR", { "agent.started": "polluted" } as never);
	assert.ok(!listLocales().includes("CONSTRUCTOR"), "case-variant reserved locale must not be registered");
	assert.deepEqual(objectPrototypeSnapshot(), before, "Object.prototype must be unchanged");
});

test("addTranslations safe locale, dangerous bundle keys (own __proto__ via JSON) → stripped, prototype unchanged", () => {
	__test__resetI18n();
	const before = objectPrototypeSnapshot();
	// JSON.parse creates an OWN enumerable "__proto__" property (the true
	// on-the-wire vector; a literal `{__proto__: "bad"}` only trips the setter).
	const bundle = JSON.parse('{"__proto__":"bad","constructor":"bad","prototype":"bad","__PROTO__":"bad","agent.started":"ok"}');
	addTranslations("proto-test-locale", bundle as never);
	assert.ok(listLocales().includes("proto-test-locale"), "safe locale must be registered");
	assert.deepEqual(objectPrototypeSnapshot(), before, "Object.prototype must be unchanged");
});
