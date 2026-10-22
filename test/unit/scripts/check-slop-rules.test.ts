/**
 * check-slop-rules.test.ts — W10-4 (v0.11.38) pin.
 *
 * Pins the scanner semantics of scripts/check-slop-rules.mjs (imported as a
 * module — the CLI main() is argv-guarded):
 *   (1) no-double-cast fires on `as unknown as` in code, NOT in comments,
 *       strings, or when a `// slop-ok:` marker sits on the line/line-above;
 *       findings are NON-strict today (41-site baseline burn-down).
 *   (2) no-json-parse-nonnull is STRICT and fires on JSON.parse(...)! in both
 *       src and test scopes.
 *   (3) no-any-deref is STRICT and fires on `(x as any).member` but not on a
 *       plain `as any` without the deref.
 *   (4) comment/string masking: block comments and template literals hide
 *       matches; a line comment truncates the scan for that line.
 *   (5) scope filter: rule A never fires in test-scope files.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// @ts-expect-error TS7016 — scripts/check-slop-rules.mjs ships no .d.mts (dev-only
// script, same pattern as analyze-run-decimation.test.ts). The runtime import
// is what matters: main() is argv-guarded, importing runs no scan.
import { scanSource } from "../../../scripts/check-slop-rules.mjs";

type Finding = { rule: string; file: string; line: number; why: string; strict: boolean };

const hit = (src: string, scopes: string[], rule: string): Finding[] =>
	(scanSource("src/x.ts", src, scopes) as Finding[]).filter((f) => f.rule === rule);

describe("W10-4 check-slop-rules scanner", () => {
	it("(1) double-cast: fires in code only; slop-ok escape on line/above; non-strict", () => {
		const src = "const a = b as unknown as C;\nconst d = e as any as F;\n";
		const f = hit(src, ["src"], "no-double-cast");
		assert.equal(f.length, 2);
		assert.ok(f.every((x) => x.strict === false));
		const ok1 = "const a = b as unknown as C; // slop-ok: boundary adapter, schema re-checked below\n";
		assert.equal(hit(ok1, ["src"], "no-double-cast").length, 0);
		const ok2 = "// slop-ok: deliberate test fixture widening\nconst a = b as unknown as C;\n";
		assert.equal(hit(ok2, ["src"], "no-double-cast").length, 0);
	});

	it("(2) JSON.parse non-null: STRICT, both scopes", () => {
		const bad = "const v = JSON.parse(raw)!;\n";
		assert.equal(hit(bad, ["src"], "no-json-parse-nonnull").length, 1);
		assert.equal(hit(bad, ["test"], "no-json-parse-nonnull").length, 1);
		const good = "const v = JSON.parse(raw) as Payload;\n";
		assert.equal(hit(good, ["src"], "no-json-parse-nonnull").length, 0);
	});

	it("(3) any-deref: fires on (x as any).member, not bare as any", () => {
		const bad = "const n = (cfg as any).name;\n";
		assert.equal(hit(bad, ["src"], "no-any-deref").length, 1);
		const good = "const n = cfg as any;\n";
		assert.equal(hit(good, ["src"], "no-any-deref").length, 0);
	});

	it("(4) masking: comments and strings hide matches", () => {
		const block = "/* const a = b as unknown as C; */\nconst keep = 1;\n";
		assert.equal(hit(block, ["src"], "no-double-cast").length, 0);
		const line = "// const a = b as unknown as C;\n";
		assert.equal(hit(line, ["src"], "no-double-cast").length, 0);
		const str = 'const s = "b as unknown as C";\n';
		assert.equal(hit(str, ["src"], "no-double-cast").length, 0);
		const tmpl = "const t = `${b as any}`;\n";
		assert.equal(hit(tmpl, ["src"], "no-double-cast").length, 0);
	});

	it("(5) scope: rule A (src-scoped) never fires for test-scope files", () => {
		const src = "const a = b as unknown as C;\n";
		assert.equal(hit(src, ["test"], "no-double-cast").length, 0);
	});
});
