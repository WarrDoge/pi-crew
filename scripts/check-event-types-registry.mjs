#!/usr/bin/env node
/**
 * CI lint: detect drift between emitted event `type:` literals and the
 * `TEAM_EVENT_TYPES` registry in `src/state/contracts.ts`.
 *
 * Background (improvement-plan-2026-08-10 G11): `TeamEvent.type` is typed
 * `string`, not the exported `TeamEventType` union. As of 2026-08-10 there
 * are ~132 unique `type:` strings emitted via `appendEvent*` across `src/`
 * that are NOT in the 65-entry registry. A typo in any of them silently
 * breaks dedupe filters, SIEM export, and `event-to-metric` mapping.
 *
 * Phase 1 (this script): REPORT-ONLY. Prints a drift table and exits 0 so
 * the existing backlog can be triaged without breaking CI. New additions
 * are visible in the report.
 *
 * Phase 2 (future): once the backlog is migrated, run with `--enforce` to
 * fail CI on any unregistered type. After that, tighten `TeamEvent.type`
 * to `TeamEventType` so the compiler catches drift at the call site.
 *
 * Usage:
 *   node scripts/check-event-types-registry.mjs            # report (exit 0)
 *   node scripts/check-event-types-registry.mjs --enforce  # fail on drift
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// R18-2: `--root <dir>` fixture seam (mirrors scripts/check-lazy-imports.mjs) so
// the gate's own behavior can be pinned by a throwaway tree.
const rootArgIndex = process.argv.indexOf("--root");
const root =
	rootArgIndex !== -1 && process.argv[rootArgIndex + 1]
		? path.resolve(process.argv[rootArgIndex + 1])
		: path.resolve(import.meta.dirname, "..");
const enforce = process.argv.includes("--enforce");

// 1. Parse TEAM_EVENT_TYPES from src/state/contracts.ts (single source of truth).
const contractsPath = path.join(root, "src", "state", "contracts.ts");
const contractsSrc = readFileSync(contractsPath, "utf-8");
const contractsBlock = contractsSrc.match(/export const TEAM_EVENT_TYPES\s*=\s*\[([\s\S]*?)\] as const/);
if (!contractsBlock) {
	console.error("check-event-types-registry: could not find TEAM_EVENT_TYPES in src/state/contracts.ts");
	process.exit(2);
}
const registered = new Set(
	(contractsBlock[1].match(/"([a-z][a-z0-9_.]+)"/g) || []).map((s) => s.replace(/"/g, "")),
);

// 2. Scan src/ for appendEvent* call sites and extract `type:` string literals.
//    Most emit sites span multiple lines:
//        appendEvent(eventsPath, {
//            type: "agent.nudged",
//            ...
//        });
//    so a line-based grep cannot see the `type:` literal. We walk the source
//    in JS, find each `appendEvent<A>*(` token, then scan forward up to a
//    bounded window (15 lines / 800 chars) for `type:` keys.
//
//    2026-09-17 fix: the old pattern `type:\s*"..."` required the literal to
//    immediately follow the colon, so CONDITIONAL emit sites were invisible:
//        type: error ? "task.failed" : noYield ? "task.needs_attention" : "task.completed",
//        type: record.version === 1 ? "plan.created" : "plan.revised",
//    That produced false entries in BOTH lists (8 verified false "unused",
//    e.g. task.completed/task.failed/plan.*). We now capture the whole value
//    expression (up to the first top-level `,` / unbalanced closer / cap)
//    and treat EVERY dotted string literal in it as an emitted type — each
//    branch of a conditional is a type this site can emit.
//    Dynamic types from variables remain out of scope; the eventual
//    type-tightening (Phase 2) catches those at compile time.
const APPEND_RE = /\bappendEvent[A-Za-z]*\s*\(/g;
const TYPE_ANCHOR_RE = /\btype:\s*/g;
const DOTTED_LITERAL_RE = /"([a-z][a-z0-9_.]+)"/g;
const WINDOW_LINES = 15;
const TYPE_EXPR_MAX_CHARS = 300;
/** R18-2: static head of a template-literal type, e.g. ``type: `run.${status}` ``
 *  → `run.` — the ONLY part a registry check can reason about. */
const TEMPLATE_HEAD_RE = /^`((?:[^`$\\]|\\.)*)\$\{/;
/** Any backtick in the value expression means the emitted type is assembled at
 *  runtime (template literal). */
const TEMPLATE_ANY_RE = /`/;

/**
 * R18-2 (deep-review round 18): the scanner used to see ONLY string literals in
 * the `type:` value expression — template-literal and variable emits were
 * invisible, so `--enforce` reported "clean" while LIVE dynamic emitters
 * existed (`state-store.ts` `type: \`run.${status}\``,
 * `child-executor.ts` `type: \`worker.${event.type}\``). A dynamic emit cannot
 * be enumerated, but it CAN be classified:
 *   - template with a static prefix → every possible type shares that prefix, so
 *     the registry must contain the namespace (checked in enforce mode);
 *   - template with no static head, or a bare identifier/expression → fully
 *     unverifiable, reported (and failed on) rather than silently dropped.
 * The regex/window scanning itself is unchanged (structural AST scoping stays
 * the Phase-2 durable fix — see the header note).
 */
function classifyDynamicExpr(expr) {
	const trimmed = expr.trim();
	if (!trimmed) return undefined;
	if (TEMPLATE_ANY_RE.test(trimmed)) {
		const head = trimmed.match(TEMPLATE_HEAD_RE);
		const prefix = head ? head[1] : "";
		return { kind: "template", prefix };
	}
	// No string literal anywhere in the value expression → the type comes from a
	// variable/constant (`type: teammateEvent`) — unverifiable statically.
	if (!/["']/.test(trimmed)) return { kind: "variable", prefix: "" };
	return undefined;
}

/** Extract every dotted string literal in the value expression that follows a
 *  `type:` key. Stops at the first top-level `,` (next property), an unbalanced
 *  closer (end of the enclosing object), or a char cap — newlines are allowed
 *  so a multi-line ternary still parses. */
function typeValueExpr(text) {
	let depth = 0;
	let end = text.length;
	for (let i = 0; i < Math.min(text.length, TYPE_EXPR_MAX_CHARS); i++) {
		const ch = text[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
			if (depth < 0) {
				end = i;
				break;
			}
		} else if (ch === "," && depth === 0) {
			end = i;
			break;
		}
	}
	return text.slice(0, end);
}

function extractTypeLiterals(text) {
	const expr = typeValueExpr(text);
	const out = [];
	for (const m of expr.matchAll(DOTTED_LITERAL_RE)) out.push(m[1]);
	return out;
}

function listTsFiles(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) listTsFiles(full, out);
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

const emitted = new Map(); // type → [{ file, line }]
const dynamicSites = new Map(); // `${kind}|${prefix}|${file}:${line}` → site
const tsFiles = listTsFiles(path.join(root, "src"));
for (const file of tsFiles) {
	const src = readFileSync(file, "utf-8");
	const lines = src.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		if (!APPEND_RE.test(lines[i])) continue;
		APPEND_RE.lastIndex = 0;
		const slice = lines.slice(i, i + WINDOW_LINES).join("\n");
		const rel = path.relative(root, file);
		for (const anchor of slice.matchAll(TYPE_ANCHOR_RE)) {
			const after = slice.slice(anchor.index + anchor[0].length);
			for (const t of extractTypeLiterals(after)) {
				// `type:` may belong to a nested object (e.g. a tool def inside
				// the data payload). Heuristic: only keep dotted names that look
				// like events (one or more dots, lowercase, no slashes).
				if (!t.includes(".")) continue;
				if (!emitted.has(t)) emitted.set(t, []);
				emitted.get(t).push(`${rel}:${i + 1}`);
			}
			// R18-2: template-literal / variable emits are NOT enumerable, but they
			// must not vanish from the report (they made --enforce a false green).
			const dynamic = classifyDynamicExpr(typeValueExpr(after));
			if (dynamic) {
				const key = `${dynamic.kind}|${dynamic.prefix}|${rel}:${i + 1}`;
				if (!dynamicSites.has(key)) dynamicSites.set(key, { ...dynamic, file: rel, line: i + 1 });
			}
		}
	}
}

// 3. Compute drift.
const unregistered = [...emitted.keys()].filter((t) => !registered.has(t)).sort();
const unused = [...registered].filter((t) => !emitted.has(t)).sort();

// R18-2: an unregistered NAMESPACE on a template emit is drift too — every type
// the site can emit is provably outside the registry (e.g. `type: \`bogus.${x}\``).
const dynamicList = [...dynamicSites.values()];
const unregisteredNamespaces = dynamicList
	.filter((d) => d.kind === "template" && d.prefix.length > 0 && ![...registered].some((t) => t.startsWith(d.prefix)))
	.sort((a, b) => a.prefix.localeCompare(b.prefix));
const unverifiable = dynamicList.filter((d) => d.kind === "variable" || d.prefix.length === 0);

// 4. Report.
console.log(`event-types-registry: ${registered.size} registered, ${emitted.size} emitted (literal types only).`);
if (dynamicList.length > 0) {
	console.log(
		`\nDYNAMIC — ${dynamicList.length} emit site(s) whose type is assembled at runtime (not enumerable; a template prefix is checked against the registry namespace):`,
	);
	for (const d of dynamicList.slice(0, 20))
		console.log(
			`  ${d.file}:${d.line}  ${d.kind === "template" ? `template, static prefix '${d.prefix || "(none)"}'` : "variable expression"}`,
		);
	if (dynamicList.length > 20) console.log(`  ... and ${dynamicList.length - 20} more.`);
}
if (unregistered.length > 0) {
	console.log(`\nDRIFT — ${unregistered.length} emitted types NOT in TEAM_EVENT_TYPES (silent to consumers):`);
	for (const t of unregistered.slice(0, 50)) {
		const sites = emitted.get(t);
		console.log(`  ${t}  (${sites.length} site${sites.length === 1 ? "" : "s"}, e.g. ${sites[0]})`);
	}
	if (unregistered.length > 50) console.log(`  ... and ${unregistered.length - 50} more.`);
}
if (unused.length > 0) {
	console.log(`\nSTALE — ${unused.length} registered types have no literal emit site (may be dynamic, dead, or legacy):`);
	for (const t of unused.slice(0, 20)) console.log(`  ${t}`);
	if (unused.length > 20) console.log(`  ... and ${unused.length - 20} more.`);
}

if (enforce && unregistered.length > 0) {
	console.error(`\ncheck-event-types-registry: --enforce failed (${unregistered.length} unregistered types).`);
	console.error("  Add them to TEAM_EVENT_TYPES in src/state/contracts.ts, or fix the typo.");
	process.exit(1);
}

if (enforce && unregisteredNamespaces.length > 0) {
	console.error(
		`\ncheck-event-types-registry: --enforce failed (${unregisteredNamespaces.length} dynamic emit site(s) whose static prefix matches NO registered type).`,
	);
	for (const d of unregisteredNamespaces) console.error(`  ${d.file}:${d.line}  prefix '${d.prefix}'`);
	console.error("  Register the namespace in TEAM_EVENT_TYPES, or emit a literal type.");
	process.exit(1);
}

if (enforce && unverifiable.length > 0) {
	// R18-2: NOT fatal. These sites are typed indirections (a `TeamEvent` value
	// from a typed map, a channel item's `type`) — enforcing them here would
	// demand an inline allowlist, which is exactly the escape hatch this gate
	// exists to prevent. The durable fix is Phase-2 type tightening
	// (`TeamEvent.type` → `TeamEventType`), which catches them at the call site.
	// What must NOT happen (the round-18 finding) is silence: they are listed.
	console.error(
		`\ncheck-event-types-registry: WARNING — ${unverifiable.length} emit site(s) whose type cannot be verified statically (Phase-2 type tightening is the durable fix):`,
	);
	for (const d of unverifiable)
		console.error(`  ${d.file}:${d.line}  ${d.kind === "variable" ? "variable expression" : "template with no static prefix"}`);
}

console.log(`\ncheck-event-types-registry: ${enforce ? "ENFORCE mode — clean." : "REPORT mode (run with --enforce to fail CI)."} Exit 0.`);
