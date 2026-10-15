/**
 * A3 (upgrade plan 2026-09-29): docs truth-sync gate for the `team` tool
 * action surface.
 *
 * History: the schema action arrays grew to 56 actions (10 run + 16 status +
 * 7 control + 17 manage — MANAGE gained `compare` in US-021 — + 6 automate)
 * while the docs kept claiming 53/54/55, CLAUDE.md still carried a legacy
 * "28 total" table, and docs/actions-reference.md omitted `compare`.
 * `allActionLiterals` (src/schema/team-tool-schema.ts) is the single source
 * of truth; this test fails whenever docs drift from it:
 *
 *  - docs/actions-reference.md Quick Reference table (set-compare, both
 *    directions, duplicate detection);
 *  - CLAUDE.md Tool Actions domain table (set-compare + per-domain counts +
 *    counts sum);
 *  - every numeric action-count claim in README.md and CLAUDE.md
 *    ("<N> actions", "<N> schema actions", "(N total)").
 *
 * If this test fails after you changed an `*_ACTIONS` array in the schema:
 * update docs/actions-reference.md, the CLAUDE.md domain table, and the
 * count claims — do NOT relax this test.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { allActionLiterals } from "../../../src/schema/team-tool-schema.ts";

const readRepoFile = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), "utf-8");

const schemaActions: readonly string[] = allActionLiterals.map((literal) => literal.const as string);
const schemaSet = new Set(schemaActions);

/** Human-readable drift report between a docs listing and the schema truth. */
const describeDrift = (docName: string, docActions: readonly string[]): string => {
	const missing = schemaActions.filter((action) => !docActions.includes(action));
	const extra = docActions.filter((action) => !schemaSet.has(action));
	const duplicated = docActions.filter((action, index) => docActions.indexOf(action) !== index);
	const parts: string[] = [];
	if (missing.length > 0) parts.push(`in schema but missing from ${docName}: ${missing.join(", ")}`);
	if (extra.length > 0) parts.push(`listed in ${docName} but unknown to the schema: ${extra.join(", ")}`);
	if (duplicated.length > 0) parts.push(`duplicated in ${docName}: ${duplicated.join(", ")}`);
	return parts.join("; ");
};

describe("team-tool docs sync (A3)", () => {
	it("docs/actions-reference.md Quick Reference lists exactly allActionLiterals", () => {
		const md = readRepoFile("docs/actions-reference.md");
		const start = md.indexOf("## Quick Reference");
		assert.notEqual(start, -1, "docs/actions-reference.md lost its '## Quick Reference' section");
		const end = md.indexOf("\n---", start);
		const section = md.slice(start, end === -1 ? undefined : end);
		// Rows look like `| \`recommend\` | ... |` (v0.9.0 additions are bolded:
		// `| **\`goal\`** | ... |`).
		const rows = [...section.matchAll(/^\|\s*(?:\*\*)?`([a-zA-Z_-]+)`(?:\*\*)?\s*\|/gm)].map((match) => match[1]);
		assert.ok(rows.length > 0, "Quick Reference parser produced 0 action rows — table format or parser is broken");
		const drift = describeDrift("docs/actions-reference.md", rows);
		assert.equal(drift, "", `action drift (schema has ${schemaActions.length}): ${drift}`);
	});

	it("CLAUDE.md Tool Actions domain table lists exactly allActionLiterals", () => {
		const md = readRepoFile("CLAUDE.md");
		const start = md.indexOf("### Tool Actions (");
		assert.notEqual(start, -1, "CLAUDE.md lost its '### Tool Actions' section");
		const end = md.indexOf("\n### ", start + 1);
		const section = md.slice(start, end === -1 ? undefined : end);
		// Rows look like `| run | 10 | run, parallel, ... |`.
		const rows = [...section.matchAll(/^\|\s*([a-z]+)\s*\|\s*(\d+)\s*\|\s*([^|]+)\|/gm)].map((match) => ({
			domain: match[1],
			count: Number(match[2]),
			actions: match[3]
				.split(",")
				.map((name) => name.trim())
				.filter((name) => name.length > 0),
		}));
		assert.ok(rows.length > 0, "CLAUDE.md domain-table parser produced 0 rows — table format or parser is broken");
		const listed = rows.flatMap((row) => row.actions);
		const drift = describeDrift("CLAUDE.md", listed);
		assert.equal(drift, "", `action drift (schema has ${schemaActions.length}): ${drift}`);
		const total = rows.reduce((acc, row) => acc + row.count, 0);
		assert.equal(total, schemaActions.length, `CLAUDE.md per-domain counts sum to ${total}, schema has ${schemaActions.length}`);
		for (const row of rows) {
			assert.equal(
				row.actions.length,
				row.count,
				`CLAUDE.md domain '${row.domain}' claims ${row.count} but lists ${row.actions.length}`,
			);
		}
	});

	it("numeric action-count claims in README.md and CLAUDE.md equal allActionLiterals.length", () => {
		const expected = schemaActions.length;
		for (const rel of ["README.md", "CLAUDE.md"]) {
			const md = readRepoFile(rel);
			const claims: { text: string; value: number }[] = [];
			for (const match of md.matchAll(/(\d+)\s+(?:schema\s+)?actions?\b/gi)) {
				claims.push({ text: match[0], value: Number(match[1]) });
			}
			for (const match of md.matchAll(/\((\d+)\s+total\)/gi)) {
				claims.push({ text: match[0], value: Number(match[1]) });
			}
			assert.ok(
				claims.length > 0,
				`${rel} no longer states any action count — keep at least one, docs drift would otherwise go undetected`,
			);
			for (const claim of claims) {
				assert.equal(claim.value, expected, `${rel} claims '${claim.text}' but allActionLiterals.length is ${expected}`);
			}
		}
	});
});

// ───────────────────────────────────────────────────────────────────────────
// DR-01 (deep review 2026-10-14): source-comment + dispatch-map truth gate.
// History: the schema arrays grew to 57 actions while src comments kept
// claiming "54-action" (team-tool-schema.ts, dispatch/index.ts header) and
// the dispatch header listed run with 9 actions (missing `plans`), manage
// with 16. Docs were already gated; the SOURCE comments were not. This block
// fails whenever src comments or the ACTION_TO_DOMAIN map drift from the
// schema arrays. If it fails after changing an `*_ACTIONS` array: update the
// numeric claims AND the per-domain listing in dispatch/index.ts — do NOT
// relax this test.
// ───────────────────────────────────────────────────────────────────────────
describe("team tool source-comment action-surface truth (DR-01)", () => {
	const SCHEMA_REL = "src/schema/team-tool-schema.ts";
	const DISPATCH_REL = "src/extension/team-tool/dispatch/index.ts";

	/** Parse the five `const X_ACTIONS = [...] as const` arrays from schema source. */
	const domainArraysFromSchemaSource = (): Record<string, string[]> => {
		const src = readRepoFile(SCHEMA_REL);
		const out: Record<string, string[]> = {};
		for (const match of src.matchAll(/const ([A-Z]+)_ACTIONS = \[([^\]]*)\] as const/g)) {
			const domain = match[1].toLowerCase();
			const items = match[2]
				.split(",")
				.map((entry) => entry.trim().replace(/^"|"$/g, ""))
				.filter((entry) => entry.length > 0);
			out[domain] = items;
		}
		return out;
	};

	/** Parse ACTION_TO_DOMAIN entries from dispatch source. */
	const actionToDomainFromDispatchSource = (): Record<string, string> => {
		const src = readRepoFile(DISPATCH_REL);
		const start = src.indexOf("const ACTION_TO_DOMAIN");
		assert.ok(start >= 0, `${DISPATCH_REL}: ACTION_TO_DOMAIN map not found`);
		const body = src.slice(start, src.indexOf("};", start));
		const out: Record<string, string> = {};
		for (const match of body.matchAll(/^\t(?:"([a-z0-9-]+)"|([a-z0-9_]+)):\s*"(run|status|control|manage|automate)",/gm)) {
			const action = match[1] ?? match[2];
			out[action] = match[3];
		}
		return out;
	};

	it("allActionLiterals holds exactly 57 unique actions (surface tripwire)", () => {
		assert.equal(
			schemaActions.length,
			57,
			"action surface changed — update docs/actions-reference.md, CLAUDE.md, README.md, and the numeric claims in team-tool-schema.ts + dispatch/index.ts",
		);
		assert.equal(schemaSet.size, schemaActions.length, "allActionLiterals contains duplicates");
	});

	it("numeric action-count claims in src comments equal allActionLiterals.length", () => {
		const expected = schemaActions.length;
		for (const rel of [SCHEMA_REL, DISPATCH_REL]) {
			const src = readRepoFile(rel);
			const claims: { text: string; value: number }[] = [];
			for (const match of src.matchAll(/(\d+)-action/g)) claims.push({ text: match[0], value: Number(match[1]) });
			for (const match of src.matchAll(/(\d+) action strings/g)) claims.push({ text: match[0], value: Number(match[1]) });
			for (const match of src.matchAll(/(\d+)→(\d+) mapping/g)) claims.push({ text: match[0], value: Number(match[1]) });
			assert.ok(
				claims.length > 0,
				`${rel} no longer states any action count — keep at least one claim so comment drift stays detectable`,
			);
			for (const claim of claims) {
				assert.equal(claim.value, expected, `${rel} claims '${claim.text}' but allActionLiterals.length is ${expected}`);
			}
		}
	});

	it("ACTION_TO_DOMAIN map matches the schema domain arrays exactly", () => {
		const domains = domainArraysFromSchemaSource();
		const map = actionToDomainFromDispatchSource();
		const total = Object.values(domains).reduce((sum, list) => sum + list.length, 0);
		assert.equal(
			total,
			schemaActions.length,
			"parsed *_ACTIONS arrays no longer cover allActionLiterals — parser regex needs updating",
		);
		for (const [domain, actions] of Object.entries(domains)) {
			for (const action of actions) {
				assert.equal(
					map[action],
					domain,
					`dispatch map: '${action}' expected domain '${domain}' but got '${map[action] ?? "<missing>"}'`,
				);
			}
		}
		const mapActions = Object.keys(map);
		assert.equal(
			mapActions.length,
			schemaActions.length,
			`dispatch map has ${mapActions.length} entries but schema has ${schemaActions.length} — map and schema drifted`,
		);
	});
});
