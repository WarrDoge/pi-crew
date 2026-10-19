/**
 * R18-2 (deep-review round 18) — pin for `scripts/check-event-types-registry.mjs`.
 *
 * The gate used to see ONLY string literals in a `type:` value expression, so
 * template-literal and variable emits were invisible: `--enforce` reported
 * "clean" while live dynamic emitters existed (`state-store.ts`
 * ``type: `run.${status}` ``, `child-executor.ts`
 * ``type: `worker.${event.type}` ``). A new drift class could therefore be
 * introduced with zero signal.
 *
 * These tests drive the REAL script through its `--root` seam (a throwaway
 * fixture tree), so the asserted behavior is the exact behavior CI runs.
 * Mutation probe: removing the template classification turns case 1 green
 * again (asserted by hand, see the fix-wave log).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GATE = join(REPO_ROOT, "scripts", "check-event-types-registry.mjs");

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

/** Fixture root with a `TEAM_EVENT_TYPES` registry and a src tree. */
function makeFixture(name: string, registry: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), `check-event-types-${name}-`));
	tmpDirs.push(dir);
	mkdirSync(join(dir, "src", "state"), { recursive: true });
	const entries = registry.map((t) => `\t"${t}",`).join("\n");
	writeFileSync(
		join(dir, "src", "state", "contracts.ts"),
		[
			"export const TEAM_EVENT_TYPES = [",
			entries,
			"] as const;",
			"export type TeamEventType = (typeof TEAM_EVENT_TYPES)[number];",
			"",
		].join("\n"),
		"utf8",
	);
	return dir;
}

function writeEmitSite(dir: string, relPath: string, typeExpr: string): void {
	const file = join(dir, relPath);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(
		file,
		[
			"export function emit(eventsPath: string) {",
			"\tappendEvent(eventsPath, {",
			`\t\ttype: ${typeExpr},`,
			'\t\trunId: "r1",',
			"\t});",
			"}",
			"",
		].join("\n"),
		"utf8",
	);
}

/** `${` inside a PLAIN string is what the fixture file contains (it is literal
 *  template-literal source) — biome's noTemplateCurlyInString forbids writing it
 *  inline, so compose the sequence instead. */
const TEMPLATE_OPEN = "$" + "{";

function runGate(dir: string): { status: number; all: string } {
	const res = spawnSync(process.execPath, [GATE, "--root", dir, "--enforce"], { encoding: "utf8", timeout: 60_000 });
	return { status: typeof res.status === "number" ? res.status : -1, all: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

test("R18-2: a template emit whose static prefix matches NO registered type fails --enforce", () => {
	const dir = makeFixture("template-drift", ["run.created"]);
	// `bogus.` is not a registered namespace → every type this site can emit is
	// outside the registry.
	writeEmitSite(dir, "src/state/stores/state-store.ts", `\`bogus.${TEMPLATE_OPEN}status}\``);
	const result = runGate(dir);
	assert.equal(result.status, 1, `gate output:\n${result.all}`);
	assert.match(result.all, /static prefix matches NO registered type|prefix 'bogus\.'/);
	assert.match(result.all, /state-store\.ts/);
});

test("R18-2: a template emit with a REGISTERED prefix is clean (the live `run.<status>` shape)", () => {
	const dir = makeFixture("template-ok", ["run.created", "run.completed"]);
	writeEmitSite(dir, "src/state/stores/state-store.ts", `\`run.${TEMPLATE_OPEN}status}\``);
	const result = runGate(dir);
	assert.equal(result.status, 0, `gate output:\n${result.all}`);
	// Not silent: the dynamic site is still surfaced in the report.
	assert.match(result.all, /DYNAMIC — 1 emit site/);
	assert.match(result.all, /static prefix 'run\.'/);
});

test("R18-2: a variable emit is reported (never silently dropped) but stays non-fatal", () => {
	const dir = makeFixture("variable", ["run.created"]);
	writeEmitSite(dir, "src/runtime/task-runner/post-execution.ts", "terminalEventType");
	const result = runGate(dir);
	assert.equal(result.status, 0, `a typed indirection must not fail the gate. output:\n${result.all}`);
	assert.match(result.all, /variable expression/, "the site must be listed, not invisible");
});

test("R18-2: a literal unregistered type still fails --enforce (pre-existing rule unchanged)", () => {
	const dir = makeFixture("literal-drift", ["run.created"]);
	writeEmitSite(dir, "src/runtime/x.ts", '"run.unregistered_kind"');
	const result = runGate(dir);
	assert.equal(result.status, 1, `gate output:\n${result.all}`);
	assert.match(result.all, /unregistered types/);
});
