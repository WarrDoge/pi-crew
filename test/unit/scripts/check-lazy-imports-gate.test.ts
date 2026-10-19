/**
 * Δ2 (2026-10-11) — fixture tests for the AST declared-deps/lazy-import gate
 * (`scripts/check-lazy-imports.mjs`).
 *
 * The gate type-strips each file with esbuild, parses with acorn, and checks:
 *   1. every value import resolves to a declared dep (port of upstream
 *      check-runtime-deps.mjs semantics),
 *   2. every runtime `import()` carries a `// LAZY:` marker (±1 line),
 *   3. entry budgets {maxFiles, forbid[]} (port of upstream
 *      check-entry-graphs.mjs),
 *   4. dist/index.mjs has no hoisted heavy-external imports.
 *
 * These tests build throwaway fixture trees under tmpdir and drive the REAL
 * script through its `--root` seam, so the pass/fail behavior asserted here is
 * the exact behavior CI runs on the repo tree. Case 3 specifically pins the
 * RR-021 round-3 residual gap the old regex gate self-documented as accepted
 * (object-property-value `import()` positions) — the AST walk must catch them.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GATE = join(REPO_ROOT, "scripts", "check-lazy-imports.mjs");

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

function makeFixture(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `check-lazy-gate-${name}-`));
	tmpDirs.push(dir);
	mkdirSync(join(dir, "src"), { recursive: true });
	return dir;
}

function writeFixturePkg(dir: string, deps: Record<string, string>): void {
	writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "fixture-pkg", dependencies: deps }, null, "\t")}\n`, "utf8");
}

interface GateResult {
	status: number;
	stdout: string;
	stderr: string;
}

function runGate(dir: string): GateResult {
	const res = spawnSync(process.execPath, [GATE, "--root", dir], {
		encoding: "utf8",
		timeout: 60_000,
	});
	return {
		status: typeof res.status === "number" ? res.status : -1,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
	};
}

test("undeclared static import is caught (exit 1, file:line reported)", () => {
	const dir = makeFixture("undeclared");
	writeFixturePkg(dir, {});
	writeFileSync(join(dir, "src", "main.ts"), ['import { thing } from "leftpad";', "export const x = thing;", ""].join("\n"), "utf8");
	const result = runGate(dir);
	assert.equal(result.status, 1, `gate output:\n${result.stdout}\n${result.stderr}`);
	const all = result.stdout + result.stderr;
	assert.match(all, /src[\\/]main\.ts:1/); // separator-agnostic: Windows gate output uses backslashes
	assert.match(all, /leftpad is not declared in fixture-pkg's dependencies/);
});

test("undeclared require() is caught through the esbuild require-rename", () => {
	const dir = makeFixture("require");
	writeFixturePkg(dir, {});
	writeFileSync(
		join(dir, "src", "main.ts"),
		[
			'import { createRequire } from "node:module";',
			"const require = createRequire(import.meta.url);",
			'export const r = () => require("rightpad");',
			"",
		].join("\n"),
		"utf8",
	);
	const result = runGate(dir);
	assert.equal(result.status, 1, `gate output:\n${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout + result.stderr, /rightpad is not declared/);
});

test("unmarked runtime import() in an object-property position (old regex blind spot) is caught", () => {
	const dir = makeFixture("objprop");
	writeFixturePkg(dir, {});
	writeFileSync(join(dir, "src", "main.ts"), ["export const loaders = {", '\tmain: import("./late.ts"),', "};", ""].join("\n"), "utf8");
	const result = runGate(dir);
	assert.equal(result.status, 1, `gate output:\n${result.stdout}\n${result.stderr}`);
	const all = result.stdout + result.stderr;
	assert.match(all, /src[\\/]main\.ts:2/); // separator-agnostic: Windows gate output uses backslashes
	assert.match(all, /without `\/\/ LAZY:` marker/);
});

test("clean fixture passes: declared deps, LAZY-marked dynamic import, type-position import", () => {
	const dir = makeFixture("clean");
	writeFixturePkg(dir, { "some-declared-pkg": "^1.0.0" });
	writeFileSync(join(dir, "src", "types.ts"), ["export type Shape = { kind: string };", ""].join("\n"), "utf8");
	writeFileSync(join(dir, "src", "lazy-mod.ts"), ["export const ready = true;", ""].join("\n"), "utf8");
	writeFileSync(
		join(dir, "src", "main.ts"),
		[
			'import { helper } from "some-declared-pkg";',
			'import type { Shape } from "./types.ts";',
			'const t: import("./types.ts").Shape = { kind: "x" };',
			"export const boot = async () => {",
			'\tconst m = await import("./lazy-mod.ts"); // LAZY: deferred heavy module',
			"\treturn { helper, t, m };",
			"};",
			"",
		].join("\n"),
		"utf8",
	);
	const result = runGate(dir);
	assert.equal(result.status, 0, `gate output:\n${result.stdout}\n${result.stderr}`);
});

// ── R18-1 / R18-3: git-tracked mixed tree + `.js`-suffixed specifiers ───────
//
// Both pins need a MIXED tree: a real git index with nested `src/**` files, so
// the old `git ls-files -- "src/**/*.ts"` pathspec returns a NON-empty list and
// the fs-walk fallback (which DOES see depth-1 files) never runs — exactly the
// repo shape where the CI blind spot existed.

function initGitFixture(name: string): string {
	const dir = makeFixture(name);
	const run = (...args: string[]): void => {
		const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
	};
	run("init", "-q");
	return dir;
}

/** Stage the fixture files so `git ls-files` sees them (index-only: no commit,
 *  no identity required). Called AFTER the files are written. */
function stageAll(dir: string): void {
	const res = spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
	assert.equal(res.status, 0, `git add failed: ${res.stderr}`);
}

test("R18-1: a depth-1 file (src/errors.ts) is dep-checked in a git-tracked mixed tree", () => {
	const dir = initGitFixture("depth1-mixed");
	writeFixturePkg(dir, {});
	// A NESTED file keeps the tracked list non-empty — `src/**/*.ts` needs a
	// directory level, so the pre-fix pathspec returned ONLY this file and the
	// fs-walk fallback (which does see depth-1) never fired. This is the exact
	// repo shape (545 of 547 files seen).
	mkdirSync(join(dir, "src", "nested"), { recursive: true });
	writeFileSync(join(dir, "src", "nested", "deep.ts"), ["export const ok = 1;", ""].join("\n"), "utf8");
	// depth-1 violation: undeclared import at the src/ root
	writeFileSync(join(dir, "src", "errors.ts"), ['import { pad } from "leftpad";', "export const x = pad;", ""].join("\n"), "utf8");
	stageAll(dir);
	const result = runGate(dir);
	assert.equal(result.status, 1, `depth-1 file must be scanned. gate output:\n${result.stdout}\n${result.stderr}`);
	const all = result.stdout + result.stderr;
	assert.match(all, /src[\\/]errors\.ts:1/);
	assert.match(all, /leftpad is not declared/);
});

test("R18-1: a depth-1 file with an unmarked runtime import() is LAZY-checked too", () => {
	const dir = initGitFixture("depth1-lazy");
	writeFixturePkg(dir, {});
	mkdirSync(join(dir, "src", "nested"), { recursive: true });
	writeFileSync(join(dir, "src", "nested", "deep.ts"), ["export const ok = 1;", ""].join("\n"), "utf8");
	writeFileSync(
		join(dir, "src", "i18n.ts"),
		["export const boot = async () => {", '\tconst m = await import("./nested/deep.ts");', "\treturn m;", "};", ""].join("\n"),
		"utf8",
	);
	stageAll(dir);
	const result = runGate(dir);
	assert.equal(result.status, 1, `gate output:\n${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout + result.stderr, /src[\\/]i18n\.ts:2/);
});

test("R18-3: a `.js`-suffixed relative import resolves to its `.ts` file (forbid + budget see the edge)", () => {
	const dir = initGitFixture("js-suffix");
	writeFixturePkg(dir, {});
	mkdirSync(join(dir, "src", "test"), { recursive: true });
	writeFileSync(join(dir, "src", "test", "evil.ts"), ["export const evil = 1;", ""].join("\n"), "utf8");
	// TS ESM style: the emitted specifier is `.js`, the file on disk is `.ts`.
	writeFileSync(join(dir, "src", "a.ts"), ['export { evil } from "./test/evil.js";', ""].join("\n"), "utf8");
	writeFileSync(join(dir, "index.bundle.ts"), ['export * from "./src/a.js";', ""].join("\n"), "utf8");
	stageAll(dir);
	const result = runGate(dir);
	assert.equal(result.status, 1, `the .js edge must enter the graph. gate output:\n${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout + result.stderr, /must not reach test\//);
});
