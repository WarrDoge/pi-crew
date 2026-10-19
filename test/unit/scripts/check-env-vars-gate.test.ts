/**
 * R26-F1 (deep-review round 26) — pin for `scripts/check-env-vars.mjs`.
 *
 * The gate readable only `process.env.PI_CREW_X` shapes: an env object passed
 * as a PARAMETER (`function isRootSession(env: NodeJS.ProcessEnv = process.env)`
 * → `env.PI_CREW_KIND`) is the same raw read with zero gate signal (24 such
 * lines in src/ at filing time, including the security-relevant root-session
 * gates). These tests drive the REAL script through its `<dir>` fixture seam
 * (documented in the script header), so the asserted behavior is exactly what CI
 * runs on src/.
 *
 * Mutation probe: dropping the alias classification (ENV_ALIAS_RE /
 * aliasFindings) turns cases 1, 2 and 4 green again.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GATE = join(REPO_ROOT, "scripts", "check-env-vars.mjs");

const tmpDirs: string[] = [];
after(() => {
	for (const dir of tmpDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

function makeFixture(name: string, files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), `check-env-vars-${name}-`));
	tmpDirs.push(dir);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content, "utf8");
	}
	return dir;
}

function runGate(dir: string): { status: number; all: string } {
	const res = spawnSync(process.execPath, [GATE, dir], { encoding: "utf8", timeout: 60_000 });
	return { status: typeof res.status === "number" ? res.status : -1, all: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const ALIAS_DEFAULT_PARAM = [
	"export function isRootSession(env: NodeJS.ProcessEnv = process.env): boolean {",
	'\tif (env.PI_CREW_KIND === "subagent") return false;',
	"\treturn true;",
	"}",
	"",
].join("\n");
const ALIAS_CONST = ["const env = process.env;", "export const kind = env.PI_CREW_KIND;", ""].join("\n");

test("R26-F1: an env-param alias read (env.PI_CREW_KIND) is a violation", () => {
	const dir = makeFixture("alias-param", { "src/a.ts": ALIAS_DEFAULT_PARAM });
	const result = runGate(dir);
	assert.equal(result.status, 1, `gate output:\n${result.all}`);
	assert.match(result.all, /raw read of 'PI_CREW_KIND'/);
});

test("R26-F1: a `const env = process.env` alias read is a violation too", () => {
	const dir = makeFixture("alias-const", { "src/b.ts": ALIAS_CONST });
	const result = runGate(dir);
	assert.equal(result.status, 1, `gate output:\n${result.all}`);
	assert.match(result.all, /raw read of 'PI_CREW_KIND'/);
});

test("R26-F1: an alias const-indirect bracket read (env[PI_CREW_TASK_ID_ENV]) is a violation", () => {
	const dir = makeFixture("alias-const-bracket", {
		"src/c.ts": [
			'const PI_CREW_TASK_ID_ENV = "PI_CREW_TASK_ID";',
			"export function f(env: NodeJS.ProcessEnv = process.env) {",
			"\treturn env[PI_CREW_TASK_ID_ENV];",
			"}",
			"",
		].join("\n"),
	});
	const result = runGate(dir);
	assert.equal(result.status, 1, `gate output:\n${result.all}`);
	assert.match(result.all, /raw read of 'PI_CREW_TASK_ID'/);
});

test("R26-F1: routing the alias read through getCrewEnv(name, env) clears it", () => {
	const dir = makeFixture("alias-clean", {
		"src/d.ts": [
			'import { getCrewEnv } from "../config/env-vars.ts";',
			"export function isRootSession(env: NodeJS.ProcessEnv = process.env): boolean {",
			'\treturn getCrewEnv("PI_CREW_KIND", env) !== "subagent";',
			"}",
			"",
		].join("\n"),
	});
	const result = runGate(dir);
	assert.equal(result.status, 0, `gate output:\n${result.all}`);
});

test("R26-F1: alias WRITES and non-alias objects are not flagged (no false positives)", () => {
	const dir = makeFixture("alias-writes", {
		"src/e.ts": [
			"export function spawn(env: NodeJS.ProcessEnv = process.env) {",
			'\tenv.PI_CREW_KIND = "subagent";',
			"\tconst built = { env: {} as NodeJS.ProcessEnv };",
			'\tbuilt.env.PI_CREW_TASK_ID = "t1";',
			"\tif (built.env.PI_CREW_TASK_ID) return true;",
			"\treturn false;",
			"}",
			"",
		].join("\n"),
	});
	const result = runGate(dir);
	assert.equal(result.status, 0, `writes + foreign objects must stay clean. gate output:\n${result.all}`);
});

test("R26-F1: the registry file itself stays exempt", () => {
	const dir = makeFixture("registry-exempt", {
		"config/env-vars.ts": [
			"export function getCrewEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {",
			"\treturn env[name];",
			"}",
			"",
		].join("\n"),
	});
	const result = runGate(dir);
	assert.equal(result.status, 0, `gate output:\n${result.all}`);
});
