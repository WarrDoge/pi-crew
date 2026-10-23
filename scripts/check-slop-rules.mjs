#!/usr/bin/env node
/**
 * W10-4 (v0.11.38) — LLM-slop lint rules (pi-subagents lesson #21:
 * "slop-as-lint" — custom oxlint rules that catch recurring LLM failure
 * shapes BEFORE a reviewer burns a model call on them).
 *
 * Three high-ROI rules for pi-crew (conservative by design: high precision,
 * low recall — a CI gate that cries wolf gets ignored):
 *
 *  A. no-double-cast (WARN-ONLY today) — `as unknown as T` / `as any as T`
 *     in src/ without an adjacent `// slop-ok: <reason>`. The classic LLM
 *     unfreeze: when types don't line up, widen through unknown instead of
 *     fixing the type relationship. 41 pre-existing sites (baseline
 *     2026-10-22) — flipping to strict is its own cleanup task, exactly like
 *     pisub turned rules on as they cleaned the codebase. The warn count is
 *     RATCHETED (see DOUBLE_CAST_BASELINE below): it may burn DOWN, never
 *     creep UP — new double-casts fail the gate until the baseline is earned
 *     down. This is the only ratcheted rule.
 *  B. no-json-parse-nonnull (STRICT, src+test) — `JSON.parse(...)` result
 *     immediately non-null-asserted. Parsing unknown text and asserting the
 *     RESULT is non-null is always wrong — the parse result can be null,
 *     0, ""…; guard the value instead.
 *  C. no-any-deref (STRICT, src) — `(x as any).member` without slop-ok:
 *     casting to any to silence a type error, then immediately
 *     dereferencing the property the compiler just stopped checking.
 *
 * Escape hatch (all rules): a line with `// slop-ok: <reason>` (same line
 * or the line above) suppresses the finding — the reason is mandatory prose.
 *
 * Scanning is comment/string-AWARE on the TS SOURCE (the `as` casts these
 * rules target are type-level syntax that vanishes after type-stripping, so
 * an AST over stripped JS cannot see them — unlike check-lazy-imports.mjs,
 * whose targets are runtime constructs). A small per-line state machine
 * skips matches inside line/block comments and string/template literals.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

/** @returns {string[]} tracked .ts files under `dir` (git ls-files) */
function listTsFiles(dir) {
	let out = "";
	try {
		out = execFileSync("git", ["ls-files", `${dir}/**/*.ts`, `${dir}/*.ts`], { encoding: "utf-8" });
	} catch {
		out = "";
	}
	return out
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.endsWith(".ts") && fs.existsSync(l));
}

/**
 * Ratchet for the WARN-only no-double-cast rule — the ONLY ratcheted rule
 * (2026-10-22 baseline). Count may go down (burn-down), never up: exceeding
 * the baseline exits 1 so new double-casts cannot silently pile in. Lower
 * the constant as sites are fixed — never raise it.
 */
const DOUBLE_CAST_BASELINE = 41; // 2026-10-22

/** Intentional-fixture exclusions. Every entry MUST carry a reason. */
const EXCLUDE = new Set([
	// none today — keep it that way; use `// slop-ok:` inline instead.
]);

/** Mask comment/string regions so rule regexes only see code tokens. */
function maskNonCode(line, blockComment) {
	let inBlock = blockComment;
	let out = "";
	let quote = null; // "'", '"', "`"
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		const next = line[i + 1];
		if (inBlock) {
			if (c === "*" && next === "/") {
				inBlock = false;
				i++;
			}
			out += "  ";
			continue;
		}
		if (quote) {
			if (c === "\\") {
				out += "  ";
				i++;
				continue;
			}
			if (c === quote) quote = null;
			out += " ";
			continue;
		}
		if (c === "/" && next === "*") {
			inBlock = true;
			out += "  ";
			i++;
			continue;
		}
		if (c === "/" && next === "/") break; // line comment: rest is masked
		if (c === "'" || c === '"' || c === "`") {
			quote = c;
			out += " ";
			continue;
		}
		out += c;
	}
	return { masked: out, inBlock };
}

const RULES = [
	{
		id: "no-double-cast",
		pattern: /\bas\s+(?:unknown|any)\s+as\b/,
		scopes: ["src"],
		strict: false,
		why: "double-cast through unknown/any without a `// slop-ok: <reason>` marker — fix the type relationship instead",
	},
	{
		id: "no-json-parse-nonnull",
		pattern: /\bJSON\.parse\s*\([^()]*\)\s*(?:!\.|!\)|!\s*[;,\n])/,
		scopes: ["src", "test"],
		strict: true,
		why: 'non-null assertion on a JSON.parse result — the parsed value can be null/0/""; guard the value instead',
	},
	{
		id: "no-any-deref",
		pattern: /\(\s*\w+(?:\.\w+)*\s+as\s+any\s*\)\s*\./,
		scopes: ["src"],
		strict: true,
		why: "cast-to-any then immediate member deref — the property the compiler stopped checking is now load-bearing",
	},
];

/**
 * Scan one file's source. Exported for unit tests.
 * @returns {{rule:string,file:string,line:number,why:string,strict:boolean}[]}
 */
export function scanSource(file, source, scopes) {
	const lines = source.split("\n");
	const findings = [];
	let inBlock = false;
	const slopOk = (idx) => {
		const cur = lines[idx] ?? "";
		const prev = lines[idx - 1] ?? "";
		return /\/\/\s*slop-ok:/.test(cur) || /\/\/\s*slop-ok:/.test(prev);
	};
	if (EXCLUDE.has(file)) return findings;
	for (let i = 0; i < lines.length; i++) {
		const { masked, inBlock: ended } = maskNonCode(lines[i], inBlock);
		inBlock = ended;
		for (const rule of RULES) {
			if (!rule.scopes.some((s) => scopes.includes(s))) continue;
			if (rule.pattern.test(masked) && !slopOk(i)) {
				findings.push({ rule: rule.id, file, line: i + 1, why: rule.why, strict: rule.strict !== false });
			}
		}
	}
	return findings;
}

function main() {
	const files = [...new Set([...listTsFiles("src"), ...listTsFiles("test")])];
	const byScope = (f) => (f.startsWith("test/") ? ["test"] : ["src"]);
	const findings = [];
	for (const f of files) {
		const src = fs.readFileSync(f, "utf-8");
		findings.push(...scanSource(f, src, byScope(f)));
	}
	const errors = findings.filter((x) => x.strict);
	const warns = findings.filter((x) => !x.strict);
	if (warns.length > 0) {
		console.log(`⚠ check-slop-rules: ${warns.length} WARN (no-double-cast baseline burn-down — non-fatal):`);
		for (const f of warns) console.log(`  ${f.file}:${f.line}  [${f.rule}]`);
	}
	// Ratchet (no-double-cast only — the sole non-strict rule): the warn count
	// must never EXCEED the baseline. Burn-down is welcome; creep is a red.
	const doubleCastCount = warns.filter((f) => f.rule === "no-double-cast").length;
	if (doubleCastCount > DOUBLE_CAST_BASELINE) {
		console.error(
			`✖ check-slop-rules: no-double-cast ratchet EXCEEDED — baseline ${DOUBLE_CAST_BASELINE}, current ${doubleCastCount}. ` +
				"Fix the new double-cast (or the type relationship) instead of raising the baseline; burn DOWN only.",
		);
		process.exit(1);
	}
	if (errors.length > 0) {
		console.error(`✖ check-slop-rules: ${errors.length} finding(s) — add \`// slop-ok: <reason>\` ONLY with a real justification:`);
		for (const f of errors) console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.why}`);
		process.exit(1);
	}
	console.log(`check-slop-rules: no-double-cast baseline ${DOUBLE_CAST_BASELINE}, current ${doubleCastCount} (burn-down ok)`);
	console.log(`check-slop-rules: clean (${files.length} files scanned, 3 rules; ${warns.length} warn-only baseline)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
