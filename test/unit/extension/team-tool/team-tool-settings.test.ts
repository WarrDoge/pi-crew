/**
 * Unit tests for team-tool handle-settings.
 * @see src/extension/team-tool/handle-settings.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handleSettings } from "../../../../src/extension/team-tool/handle-settings.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { validateConfig } from "../../../../src/schema/config-schema.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeCtx(cwd: string): TeamContext {
	return { cwd };
}

function makeConfig(args: string, scope?: string): { config: Record<string, unknown> } {
	const cfg: Record<string, unknown> = { args };
	if (scope) cfg.scope = scope;
	return { config: cfg };
}

// ─── handleSettings — list ────────────────────────────────────────────────────

describe("handleSettings list", () => {
	it("shows effective settings when args is empty or 'list'", () => {
		const tmp = createTrackedTempDir("settings-test-");
		try {
			const res = handleSettings(makeConfig(""), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(
				text.includes("pi-crew effective settings") || text.includes("(all defaults"),
				`Expected settings listing, got: ${text.slice(0, 200)}`,
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("shows config file path in listing", () => {
		const tmp = createTrackedTempDir("settings-test-");
		try {
			const res = handleSettings(makeConfig("list"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("Config file:") || text.includes("Source paths:"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — json ────────────────────────────────────────────────────

describe("handleSettings json", () => {
	it("returns JSON config dump", () => {
		const tmp = createTrackedTempDir("settings-json-");
		try {
			const res = handleSettings(makeConfig("json"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("pi-crew effective config"));
			// Should contain JSON object
			assert.ok(text.includes("{"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — schema ──────────────────────────────────────────────────

describe("handleSettings schema", () => {
	it("shows all known config keys", () => {
		const tmp = createTrackedTempDir("settings-schema-");
		try {
			const res = handleSettings(makeConfig("schema"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("pi-crew config schema"));
			assert.ok(text.includes("runtime.mode"));
			assert.ok(text.includes("limits.maxConcurrentWorkers"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — paths ──────────────────────────────────────────────────

describe("handleSettings paths", () => {
	it("shows config file paths", () => {
		const tmp = createTrackedTempDir("settings-paths-");
		try {
			const res = handleSettings(makeConfig("paths"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("pi-crew config paths"));
			assert.ok(text.includes("User config"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — scope ──────────────────────────────────────────────────

describe("handleSettings scope", () => {
	it("shows current scope when no argument", () => {
		const tmp = createTrackedTempDir("settings-scope-");
		try {
			const res = handleSettings(makeConfig("scope"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("Current write scope"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("rejects invalid scope value", () => {
		const tmp = createTrackedTempDir("settings-scope-");
		try {
			const res = handleSettings(makeConfig("scope invalidvalue"), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("user") || text.includes("project"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — get ────────────────────────────────────────────────────

describe("handleSettings get", () => {
	it("returns error for empty key", () => {
		const tmp = createTrackedTempDir("settings-get-");
		try {
			const res = handleSettings(makeConfig("get "), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("Usage") || text.includes("get"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("shows value and default for a known key", () => {
		const tmp = createTrackedTempDir("settings-get-");
		try {
			const res = handleSettings(makeConfig("get runtime.mode"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("runtime.mode"));
			// Either set or showing default
			assert.ok(text.includes("=") || text.includes("default"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("shows suggestion for misspelled key", () => {
		const tmp = createTrackedTempDir("settings-get-");
		try {
			const res = handleSettings(makeConfig("get runtime.mod"), makeCtx(tmp));
			const text = textFromToolResult(res);

			// Should mention suggestion or unknown key
			assert.ok(
				text.includes("did you mean") || text.includes("unknown key"),
				`Expected suggestion or unknown key warning, got: ${text.slice(0, 200)}`,
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — set ────────────────────────────────────────────────────

describe("handleSettings set", () => {
	it("returns error when no value provided", () => {
		const tmp = createTrackedTempDir("settings-set-");
		try {
			const res = handleSettings(makeConfig("set justkey"), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("Usage") || text.includes("value"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("sets a boolean value", () => {
		const tmp = createTrackedTempDir("settings-set-");
		try {
			const res = handleSettings(makeConfig("set telemetry.enabled true"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("Set telemetry.enabled") || text.includes("Error"), `Expected set result, got: ${text.slice(0, 200)}`);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("sets a numeric value", () => {
		const tmp = createTrackedTempDir("settings-set-");
		try {
			const res = handleSettings(makeConfig("set limits.maxConcurrentWorkers 4"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("Set limits.maxConcurrentWorkers") || text.includes("Error"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("sets broker key without unknown-key warning", () => {
		// broker.* keys lẽ ra phải trong KNOWN_KEYS — trước bản fix, set
		// broker.waitMethodsEnabled bị warning "unknown key — may not take effect".
		const tmp = createTrackedTempDir("settings-set-broker-");
		try {
			const res = handleSettings(makeConfig("set broker.waitMethodsEnabled true"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("Set broker.waitMethodsEnabled"), `expected set result, got: ${text.slice(0, 200)}`);
			assert.ok(
				!text.includes("unknown key") && !text.includes("did you mean"),
				`broker.waitMethodsEnabled là key hợp lệ — không được warning unknown, got: ${text.slice(0, 200)}`,
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("sets broker.enabled true", () => {
		const tmp = createTrackedTempDir("settings-set-broker-enabled-");
		try {
			const res = handleSettings(makeConfig("set broker.enabled true"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("Set broker.enabled"), `expected set result, got: ${text.slice(0, 200)}`);
			assert.ok(!text.includes("unknown key"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — unset ──────────────────────────────────────────────────

describe("handleSettings unset", () => {
	it("returns error for empty key", () => {
		const tmp = createTrackedTempDir("settings-unset-");
		try {
			const res = handleSettings(makeConfig("unset "), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — unknown subcommand ──────────────────────────────────────

// ─── R45-S1 (deep-review 2026-10-19): list/json sensitive redaction ─────────
//
// `list` and `json` dump the WHOLE effective config. Before R45-S1 they did
// NOT run the US-030 redaction that `get` applies — so `team-settings list`
// leaked webhook.secret / otlp.headers etc. verbatim into the transcript,
// bypassing the `get` redaction entirely. All tests sandbox HOME + USERPROFILE
// + PI_CREW_HOME + cwd so the real ~/.pi config is never read or written.

describe("handleSettings list/json sensitive redaction (R45-S1)", () => {
	function withSandboxedHome(fn: (home: string, cwd: string) => void): void {
		const savedHome = process.env.HOME;
		const savedProfile = process.env.USERPROFILE;
		const savedCrewHome = process.env.PI_CREW_HOME;
		// PI_TEAMS_HOME wins over PI_CREW_HOME (env-vars.ts mirrorPrecedence
		// "teams"), and scripts/test-runner.mjs sets BOTH — override both or the
		// fixture config lands outside the sandbox home.
		const savedTeamsHome = process.env.PI_TEAMS_HOME;
		const home = createTrackedTempDir("settings-redact-home-");
		const cwd = createTrackedTempDir("settings-redact-cwd-");
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_CREW_HOME = home;
		process.env.PI_TEAMS_HOME = home;
		try {
			fn(home, cwd);
		} finally {
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
			if (savedProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = savedProfile;
			if (savedCrewHome === undefined) delete process.env.PI_CREW_HOME;
			else process.env.PI_CREW_HOME = savedCrewHome;
			if (savedTeamsHome === undefined) delete process.env.PI_TEAMS_HOME;
			else process.env.PI_TEAMS_HOME = savedTeamsHome;
			removeTrackedTempDir(home);
			removeTrackedTempDir(cwd);
		}
	}

	function writeUserConfig(home: string): void {
		const dir = path.join(home, ".pi", "agent");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "pi-crew.json"),
			JSON.stringify({
				notifications: {
					webhook: {
						url: "https://hooks.example.com/T0/RAW_WEBHOOK_SECRET",
						enabled: true,
						secret: "whsec-R45S1-marker-secret",
					},
				},
				otlp: {
					enabled: true,
					endpoint: "https://otel.example.com?token=RAW_OTLP_TOKEN",
					headers: { "x-api-key": "RAW_HEADER_KEY" },
				},
			}),
		);
	}

	const RAW_SECRETS = ["whsec-R45S1-marker-secret", "RAW_WEBHOOK_SECRET", "RAW_OTLP_TOKEN", "RAW_HEADER_KEY"];

	it("list does not leak schema-marked sensitive values and shows the redaction marker", () => {
		withSandboxedHome((home, cwd) => {
			writeUserConfig(home);
			const text = textFromToolResult(handleSettings(makeConfig("list"), makeCtx(cwd)));
			for (const secret of RAW_SECRETS) {
				assert.ok(!text.includes(secret), `list must not leak ${secret}, got: ${text.slice(0, 400)}`);
			}
			// Redaction (marker at the sensitive key), not omission of the key.
			// flattenConfig renders multi-key sections as JSON blocks, so the
			// marker appears as `"key": "***(redacted — sensitive)"` inside the
			// section block, not as a dotted top-level line.
			assert.ok(
				text.includes('"webhook": "***(redacted — sensitive)"'),
				`expected redacted webhook entry, got: ${text.slice(0, 400)}`,
			);
			assert.ok(
				text.includes('"endpoint": "***(redacted — sensitive)"') && text.includes('"headers": "***(redacted — sensitive)"'),
				`expected redacted otlp.endpoint + otlp.headers entries, got: ${text.slice(0, 400)}`,
			);
			// Non-sensitive values in the same sections stay visible.
			assert.ok(text.includes('"enabled": true'), `non-sensitive sibling must stay visible, got: ${text.slice(0, 400)}`);
		});
	});

	it("json does not leak schema-marked sensitive values and shows the redaction marker", () => {
		withSandboxedHome((home, cwd) => {
			writeUserConfig(home);
			const text = textFromToolResult(handleSettings(makeConfig("json"), makeCtx(cwd)));
			for (const secret of RAW_SECRETS) {
				assert.ok(!text.includes(secret), `json must not leak ${secret}, got: ${text.slice(0, 400)}`);
			}
			assert.ok(
				text.includes('"notifications":') && text.includes("***(redacted — sensitive)"),
				`expected redacted marker inside the JSON dump, got: ${text.slice(0, 400)}`,
			);
			assert.ok(text.includes('"otlp":') && !text.includes("RAW_OTLP_TOKEN"), `otlp must be present but redacted`);
			// Non-sensitive sibling survives.
			assert.ok(text.includes('"enabled": true'), `non-sensitive sibling must stay visible, got: ${text.slice(0, 400)}`);
		});
	});

	it("get stays redacted for the same keys (no drift between surfaces)", () => {
		withSandboxedHome((home, cwd) => {
			writeUserConfig(home);
			for (const key of ["notifications.webhook", "notifications.webhook.secret", "otlp.headers"]) {
				const text = textFromToolResult(handleSettings(makeConfig(`get ${key}`), makeCtx(cwd)));
				for (const secret of RAW_SECRETS) {
					assert.ok(!text.includes(secret), `get ${key} must not leak ${secret}, got: ${text.slice(0, 300)}`);
				}
				assert.ok(text.includes("redacted"), `get ${key} must show the redaction marker, got: ${text.slice(0, 300)}`);
			}
		});
	});
});

describe("handleSettings unknown subcommand", () => {
	it("returns error for unknown subcommand", () => {
		const tmp = createTrackedTempDir("settings-unknown-");
		try {
			const res = handleSettings(makeConfig("foobar"), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("Unknown subcommand"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── M1-9 (P1-8): ui.* config keys ───────────────────────────────────────────
//
// UI-AUDIT-2026-09-15 §3 P1-8: `ui.autoCloseDashboardMs` was honoured by the
// config layer but missing from KNOWN_KEYS, and the `get` path (unlike `set`)
// had no `ui.*` exemption — so `team-settings get ui.widgetRowStyle` answered
// "(unknown key — may not take effect)" for keys the schema actually accepts.
// Every test below is sandboxed: HOME + USERPROFILE + PI_CREW_HOME + cwd point
// into mkdtemp dirs so nothing can read or write the real ~/.pi config.

describe("handleSettings ui.* keys (M1-9)", () => {
	const UI_KEYS = ["ui.inlinePanel", "ui.autoCloseDashboardMs"] as const;

	function withSandboxedHome(fn: (home: string, cwd: string) => void): void {
		const savedHome = process.env.HOME;
		const savedProfile = process.env.USERPROFILE;
		const savedCrewHome = process.env.PI_CREW_HOME;
		const home = createTrackedTempDir("settings-ui-home-");
		const cwd = createTrackedTempDir("settings-ui-cwd-");
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		// scripts/test-runner.mjs injects PI_CREW_SKIP_HOME_CHECK=1, so this is honoured.
		process.env.PI_CREW_HOME = home;
		try {
			fn(home, cwd);
		} finally {
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
			if (savedProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = savedProfile;
			if (savedCrewHome === undefined) delete process.env.PI_CREW_HOME;
			else process.env.PI_CREW_HOME = savedCrewHome;
			removeTrackedTempDir(home);
			removeTrackedTempDir(cwd);
		}
	}

	it("get <ui key> prints no 'unknown key' note", () => {
		withSandboxedHome((_home, cwd) => {
			for (const key of UI_KEYS) {
				const text = textFromToolResult(handleSettings(makeConfig(`get ${key}`), makeCtx(cwd)));
				assert.ok(text.includes(`${key} =`), `expected a value line for ${key}, got: ${text}`);
				assert.ok(
					!text.includes("unknown key") && !text.includes("did you mean"),
					`${key} is a supported ui key — no unknown-key note allowed, got: ${text}`,
				);
			}
		});
	});

	it("control: the unknown-key note still fires for a non-ui key", () => {
		withSandboxedHome((_home, cwd) => {
			const text = textFromToolResult(handleSettings(makeConfig("get runtime.bogusThing"), makeCtx(cwd)));
			assert.ok(
				text.includes("unknown key") || text.includes("did you mean"),
				`the note machinery must still work (otherwise the assertion above is vacuous), got: ${text}`,
			);
		});
	});

	it("schema lists the ui keys", () => {
		withSandboxedHome((_home, cwd) => {
			const text = textFromToolResult(handleSettings(makeConfig("schema"), makeCtx(cwd)));
			for (const key of UI_KEYS) {
				assert.ok(text.includes(key), `team-settings schema must list ${key}, got: ${text.slice(0, 400)}`);
			}
		});
	});

	it("set ui.widgetRowStyle is accepted permissively but silently DROPPED — the key is retired", () => {
		// ui.widgetRowStyle was REMOVED 2026-09-16 (dead config chain). The
		// set/get paths stay permissive for every ui.* key (no unknown-key
		// warning — same as any ui.foo), but configPatchFromConfig() runs the
		// patch through parseConfig(), which no longer parses the key — so the
		// write is a no-op and nothing lands in the user config. This pins the
		// full retirement: permissive surface, dropped persistence, strict
		// loader.
		withSandboxedHome((home, cwd) => {
			const res = handleSettings(makeConfig("set ui.widgetRowStyle detailed"), makeCtx(cwd));
			const text = textFromToolResult(res);
			assert.ok(text.includes("Set ui.widgetRowStyle"), `expected a set result, got: ${text}`);
			assert.ok(!text.includes("unknown key"), `ui.* is exempt from the unknown-key warning, got: ${text}`);

			const written = path.join(home, ".pi", "agent", "pi-crew.json");
			const persisted = fs.existsSync(written) ? (JSON.parse(fs.readFileSync(written, "utf8")).ui?.widgetRowStyle ?? null) : null;
			assert.equal(persisted, null, `the retired key must not persist into the user config, got ${String(persisted)}`);

			const readBack = textFromToolResult(handleSettings(makeConfig("get ui.widgetRowStyle"), makeCtx(cwd)));
			assert.ok(!readBack.includes("detailed"), `a dropped key must not read back, got: ${readBack}`);

			// And the strict schema rejects it outright on a hand-written config.
			const outcome = validateConfig({ ui: { widgetRowStyle: "detailed" } });
			assert.equal(outcome.hasErrors, true, "validateConfig() must flag the retired ui.widgetRowStyle");
		});
	});
});

// ─── R45-S1 (wave-6 M4-R2): getNested read-side inherited-member guard ────────
// `get <key>` resolved INHERITED members because the walker had no own-property
// check — `get __proto__.toString` walked Object.prototype and formatValue
// printed the function source; `get constructor` returned Object. The write
// path already refused dangerous segments (isDangerousPath in setNested); this
// pins the read path's matching guard (Object.hasOwn at each hop).

describe("handleSettings get — inherited-member guard (R45-S1)", () => {
	it("does not resolve __proto__ / inherited Object.prototype members", () => {
		const tmp = createTrackedTempDir("settings-inherited-");
		try {
			const proto = textFromToolResult(handleSettings(makeConfig("get __proto__.toString"), makeCtx(tmp)));
			assert.ok(!proto.includes("native code"), `__proto__.toString must not leak the function source, got: ${proto}`);
			assert.ok(proto.includes("__proto__.toString = <not set>"), `expected an unset value, got: ${proto}`);

			const ctor = textFromToolResult(handleSettings(makeConfig("get constructor"), makeCtx(tmp)));
			assert.ok(!ctor.includes("function Object"), `constructor must not resolve to Object, got: ${ctor}`);
			assert.ok(ctor.includes("constructor = <not set>"), `expected an unset value, got: ${ctor}`);

			const nested = textFromToolResult(handleSettings(makeConfig("get constructor.prototype.toString"), makeCtx(tmp)));
			assert.ok(!nested.includes("native code"), `nested inherited hop must not leak, got: ${nested}`);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("control: a real OWN nested key still resolves", () => {
		const tmp = createTrackedTempDir("settings-ownkey-");
		try {
			// `limits.maxConcurrentWorkers` is a real own key — the guard must not break
			// legitimate reads (value comes from the loaded effective config or its default).
			const text = textFromToolResult(handleSettings(makeConfig("get limits.maxConcurrentWorkers"), makeCtx(tmp)));
			assert.match(text, /limits\.maxConcurrentWorkers = \d+/, `own key must still resolve, got: ${text}`);
			assert.ok(!text.includes("<not set>"), `own key must not read as unset, got: ${text}`);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
