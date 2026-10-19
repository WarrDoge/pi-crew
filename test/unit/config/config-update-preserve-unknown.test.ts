/**
 * R45-F1 / M3-13 — updateConfig must PRESERVE unknown on-disk keys.
 *
 * `parseConfig` is a strict whitelist builder, so `mergeConfig(parseConfig(current), patch)`
 * dropped every key the whitelist does not know (typos, forward-compat keys
 * written by a newer version, keys owned by another tool) and wrote the
 * stripped shape back — silent permanent data loss on ANY config write.
 *
 * These tests drive the real updateConfig against a temp project scope, then
 * read the RAW file back (parsing would re-apply the whitelist and hide the
 * very defect under test).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { PiTeamsConfig } from "../../../src/config/config.ts";
import { projectConfigPath, updateConfig } from "../../../src/config/config.ts";

function makeCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-config-preserve-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function writeConfig(cwd: string, raw: Record<string, unknown>): string {
	const filePath = projectConfigPath(cwd);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
	return filePath;
}

function readRaw(filePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

describe("R45-F1: updateConfig preserves unknown keys", () => {
	it("keeps unknown top-level and nested keys while applying a known-key patch", () => {
		const cwd = makeCwd();
		try {
			const filePath = writeConfig(cwd, {
				// Known keys (whitelist) + unknown ones at both depths.
				notifierIntervalMs: 1000,
				futureTopLevelFlag: "keep-me",
				anotherUnknown: { nested: [1, 2, 3] },
				runtime: { maxTurns: 7, futureRuntimeKnob: true },
			});

			const saved = updateConfig({ notifierIntervalMs: 4321 } as PiTeamsConfig, { scope: "project", cwd });
			assert.equal(saved.written, true);

			const raw = readRaw(filePath);
			assert.equal(raw.notifierIntervalMs, 4321, "the patch was applied to a known key");
			assert.equal(raw.futureTopLevelFlag, "keep-me", "unknown top-level key survives the write");
			assert.deepEqual(raw.anotherUnknown, { nested: [1, 2, 3] }, "unknown nested value survives intact");
			// NOTE: parseConfig materializes `runtime.inheritContext` whenever a
			// runtime section exists — pre-existing behaviour, unaffected by M3-13.
			assert.deepEqual(
				raw.runtime,
				{ maxTurns: 7, futureRuntimeKnob: true, inheritContext: true },
				"unknown nested key inside a known object survives",
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps unknown keys when a known key is unset, and removes an explicitly unset unknown key", () => {
		const cwd = makeCwd();
		try {
			const filePath = writeConfig(cwd, {
				notifierIntervalMs: 1000,
				futureTopLevelFlag: "keep-me",
				deprecatedUnknown: "remove-me",
			});

			updateConfig({} as PiTeamsConfig, { scope: "project", cwd, unsetPaths: ["notifierIntervalMs"] });
			let raw = readRaw(filePath);
			assert.equal("notifierIntervalMs" in raw, false, "known key unset");
			assert.equal(raw.futureTopLevelFlag, "keep-me", "other unknown key preserved through the unset write");
			assert.equal(raw.deprecatedUnknown, "remove-me", "not touched");

			updateConfig({} as PiTeamsConfig, { scope: "project", cwd, unsetPaths: ["deprecatedUnknown"] });
			raw = readRaw(filePath);
			assert.equal("deprecatedUnknown" in raw, false, "an unknown key CAN still be removed explicitly");
			assert.equal(raw.futureTopLevelFlag, "keep-me", "the other unknown key is still there");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("never preserves prototype-pollution keys (M1-1 boundary still holds)", () => {
		const cwd = makeCwd();
		try {
			// Written as literal JSON so JSON.parse creates OWN __proto__ properties
			// (a JS object literal would set the prototype instead).
			const filePath = projectConfigPath(cwd);
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(
				filePath,
				`${JSON.stringify({
					notifierIntervalMs: 1,
					__proto__: { polluted: true },
					constructor: { polluted: true },
					safeUnknown: "kept",
				})}\n`,
				"utf-8",
			);

			updateConfig({ notifierIntervalMs: 2 } as PiTeamsConfig, { scope: "project", cwd });

			const rawText = fs.readFileSync(filePath, "utf-8");
			assert.ok(!rawText.includes("polluted"), "dangerous keys are not carried into the write");
			const raw = JSON.parse(rawText) as Record<string, unknown>;
			assert.equal(Object.hasOwn(raw, "__proto__"), false, "__proto__ is not written back");
			assert.equal(Object.hasOwn(raw, "constructor"), false, "constructor is not written back");
			assert.equal(raw.safeUnknown, "kept", "a benign unknown key is still preserved");
			assert.equal(({} as { polluted?: boolean }).polluted, undefined, "no prototype pollution happened");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("a no-op patch does not rewrite a file that only contains unknown keys (written:false, bytes unchanged)", () => {
		const cwd = makeCwd();
		try {
			const filePath = writeConfig(cwd, { unknownOnly: { deep: true } });
			const before = fs.readFileSync(filePath, "utf-8");
			const saved = updateConfig({} as PiTeamsConfig, { scope: "project", cwd });
			assert.equal(saved.written, false, "no write for an identical patch");
			assert.equal(fs.readFileSync(filePath, "utf-8"), before, "file bytes are untouched");
			assert.deepEqual(readRaw(filePath), { unknownOnly: { deep: true } }, "unknown keys still present");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("known-key merge semantics are unchanged (per-key user-wins on nested objects)", () => {
		const cwd = makeCwd();
		try {
			const filePath = writeConfig(cwd, {
				runtime: { maxTurns: 7, mode: "child-process" },
				keepMe: "yes",
			});
			updateConfig({ runtime: { maxTurns: 11 } } as PiTeamsConfig, { scope: "project", cwd });
			const raw = readRaw(filePath);
			assert.deepEqual(
				raw.runtime,
				{ maxTurns: 11, mode: "child-process", inheritContext: true },
				"nested known keys merge per-key, not wholesale",
			);
			assert.equal(raw.keepMe, "yes", "unknown sibling preserved");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
