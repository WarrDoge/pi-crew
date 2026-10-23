/**
 * main-guard-platform-safety.test.ts — W10 Windows-safety regression pin
 * (v0.11.38; CI matrix caught a BUG CLASS, not one site).
 *
 * A CLI "main guard" that derives a file URL by string-manipulating
 * `process.argv[1]` only ever matches on POSIX:
 *   - building a URL by prefixing "file://" onto argv[1] is never equal to
 *     `import.meta.url` on win32 (argv[1] there is `D:\a\repo\scripts\x.mjs`);
 *   - taking the basename with `argv[1].split("/").pop()` fails the same way
 *     (`\` separators mean there is no "/" to split on).
 *
 * Either shape turns a shipped gate into a SILENT no-op: exit 0, empty stdout,
 * a green CI step that proves nothing (this is exactly how `check:slop-rules`
 * went false-green on the Windows runners). The behavioral pin on one real CLI
 * lives in check-slop-rules-cli.test.ts; THIS file pins the whole class by
 * scanning every shipped script, so a new script cannot reintroduce it.
 *
 * Fix pattern (single source of truth): route argv[1] through
 * `pathToFileURL()` / `fileURLToPath()` — see scripts/analyze-run.mjs,
 * scripts/check-slop-rules.mjs.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

/** Antipattern 1: a hand-built URL — template literal form. */
const HAND_BUILT_URL_TEMPLATE = /`file:\/\/\$\{\s*process\.argv\[1\]\s*\}`/;
/** Antipattern 2: a hand-built URL — string concatenation form. */
const HAND_BUILT_URL_CONCAT = /(["'])file:\/\/\1\s*\+/;
/** Antipattern 3: basename via "/" split of argv[1] (breaks on `\`). */
const BASENAME_VIA_POSIX_SPLIT = /process\.argv\[1\]\s*\.\s*split\(\s*["']\/["']/;

const ANTIPATTERNS: ReadonlyArray<{ name: string; re: RegExp; hint: string }> = [
	{ name: "hand-built file URL (template)", re: HAND_BUILT_URL_TEMPLATE, hint: "use pathToFileURL(process.argv[1]).href" },
	{ name: "hand-built file URL (concat)", re: HAND_BUILT_URL_CONCAT, hint: "use pathToFileURL(process.argv[1]).href" },
	{
		name: 'basename via argv[1].split("/")',
		re: BASENAME_VIA_POSIX_SPLIT,
		hint: "use pathToFileURL/path.basename — `\\` separators on win32",
	},
];

/** Recursively collect the script surfaces that ship as CLIs. */
function collectScripts(dir: string, out: string[] = []): string[] {
	if (!fs.existsSync(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) collectScripts(full, out);
		else if (/\.(?:mjs|cjs|js)$/.test(entry.name)) out.push(full);
	}
	return out;
}

function shippedScripts(): string[] {
	const files = [
		...fs
			.readdirSync(REPO_ROOT, { withFileTypes: true })
			.filter((e) => e.isFile() && /\.(?:mjs|cjs|js)$/.test(e.name))
			.map((e) => path.join(REPO_ROOT, e.name)),
		...collectScripts(path.join(REPO_ROOT, "scripts")),
		...collectScripts(path.join(REPO_ROOT, "skills")),
	];
	return files.sort();
}

/**
 * Repo-relative label with POSIX separators. `path.relative` yields `scripts\\x.mjs`
 * on win32 — comparing raw separators against a literal is exactly the
 * platform-footgun this whole file exists to prevent (my own first version
 * failed on the Windows runner for that reason).
 */
function relLabel(abs: string): string {
	return path.relative(REPO_ROOT, abs).split(path.sep).join("/");
}

/** Offending `file:line` strings for one script (empty ⇒ clean). */
function antipatternHits(file: string): string[] {
	const hits: string[] = [];
	const lines = fs.readFileSync(file, "utf8").split("\n");
	lines.forEach((line, idx) => {
		for (const { name, re, hint } of ANTIPATTERNS) {
			if (re.test(line)) hits.push(`${relLabel(file)}:${idx + 1}  [${name}] ${hint}  →  ${line.trim()}`);
		}
	});
	return hits;
}

describe("main-guard platform safety (win32 silent no-op class)", () => {
	it("scan is not vacuous — every shipped script surface is covered", () => {
		const files = shippedScripts();
		// Sanity floor: the repo ships dozens of scripts; a broken walker must
		// fail here instead of vacuously "passing" the real assertion below.
		assert.ok(files.length >= 20, `expected ≥20 shipped scripts, walked ${files.length}: ${files.slice(0, 5).join(", ")}`);
		for (const must of ["scripts/analyze-run.mjs", "scripts/check-slop-rules.mjs", "scripts/gh-pr-comment.mjs", "install.mjs"]) {
			assert.ok(
				files.some((f) => relLabel(f) === must),
				`walker missed ${must} (walked: ${files.map(relLabel).join(", ")})`,
			);
		}
	});

	it("no script derives a file URL or basename by string-manipulating argv[1]", () => {
		const offenders = shippedScripts().flatMap(antipatternHits);
		assert.deepEqual(
			offenders,
			[],
			`Windows-unsafe main guard(s) — they are silent no-ops on win32 (exit 0, empty stdout, false-green gate):\n${offenders.join("\n")}`,
		);
	});

	it("the known entry points compare through pathToFileURL/fileURLToPath", () => {
		// Positive control for the fix pattern: if someone "fixes" the guards
		// again by hand (or drops the import), this fails even when the
		// antipattern regexes above happen to stay silent.
		for (const rel of ["scripts/check-slop-rules.mjs", "scripts/gh-pr-comment.mjs", "scripts/analyze-run.mjs"]) {
			const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
			assert.match(src, /pathToFileURL|fileURLToPath/, `${rel} must resolve argv[1] via node:url (cross-platform main guard)`);
		}
	});
});
