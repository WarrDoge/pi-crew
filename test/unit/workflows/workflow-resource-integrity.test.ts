/**
 * R28-M1 pin (wave-6 M3-24): a `.workflow.md` whose `##` headings are prose is a
 * DOCUMENT, not a workflow.
 *
 * The shipped `chain.workflow.md` doc used to parse into 10 phantom steps
 * (ids "Overview", "Chain Syntax", "Error Handling", …) because
 * `discover-workflows.ts` fell back to "all headings" when no heading carried a
 * step-config line. Any dispatch of that workflow then failed with
 * ResourceNotFound. The doc now lives at `docs/chain-workflow.md`, and the
 * parser rejects prose headings so a doc dropped into a workflows dir yields
 * zero steps instead of phantom ones.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { packageRoot, projectCrewRoot } from "../../../src/utils/paths.ts";
import { discoverWorkflows } from "../../../src/workflows/discover-workflows.ts";
import { createTrackedTempDir } from "../../fixtures/test-tempdir.ts";

const SLUG = /^[a-z][a-z0-9-]*$/;

function freshCwd(): string {
	// A cwd with no .crew/workflows of its own in a temp dir (unique per test so
	// the 5 s discovery cache never leaks between tests).
	const cwd = createTrackedTempDir("wf-integrity-");
	fs.mkdirSync(path.join(cwd, ".crew", "state", "runs"), { recursive: true });
	return cwd;
}

test("R28-M1: every SHIPPED workflow parses to >= 1 step with slug-shaped ids", () => {
	const discovery = discoverWorkflows(freshCwd());
	const shipped = discovery.builtin;
	assert.ok(shipped.length > 0, "builtin workflows must be discoverable");

	for (const workflow of shipped) {
		assert.ok(workflow.steps.length >= 1, `workflow '${workflow.name}' must expose at least one step (${workflow.filePath})`);
		for (const step of workflow.steps) {
			assert.match(step.id, SLUG, `workflow '${workflow.name}' step id '${step.id}' is prose, not a step slug`);
		}
	}
});

test("R28-M1: the shipped 'chain' filename no longer exists as a workflow resource", () => {
	const builtinDir = path.join(packageRoot(), "workflows");
	const entries = fs.readdirSync(builtinDir);
	assert.equal(entries.includes("chain.workflow.md"), false, "the chain doc must not live in workflows/ (it is docs/chain-workflow.md)");

	const names = discoverWorkflows(freshCwd()).builtin.map((w) => w.name);
	assert.equal(names.includes("chain"), false, "no phantom 'chain' workflow may be discoverable");
});

test("R28-M1: a doc dropped into a project workflows dir parses to 0 steps (no phantom headings)", () => {
	const cwd = freshCwd();
	const wfDir = path.join(projectCrewRoot(cwd), "workflows");
	fs.mkdirSync(wfDir, { recursive: true });
	// The real former resource, verbatim: prose `##` headings, no step-config lines.
	const docSource = fs.readFileSync(path.join(packageRoot(), "docs", "chain-workflow.md"), "utf-8");
	fs.writeFileSync(path.join(wfDir, "chain.workflow.md"), docSource, "utf-8");

	const project = discoverWorkflows(cwd).project;
	const chain = project.find((w) => w.name === "chain");
	assert.ok(chain, "the file is still discovered as a resource");
	assert.equal(chain.steps.length, 0, `prose headings must not become steps — got ${JSON.stringify(chain.steps.map((s) => s.id))}`);
});

test("R28-M1: a legacy slug-heading workflow (no step-config lines) still parses", () => {
	const cwd = freshCwd();
	const wfDir = path.join(projectCrewRoot(cwd), "workflows");
	fs.mkdirSync(wfDir, { recursive: true });
	fs.writeFileSync(
		path.join(wfDir, "legacy.workflow.md"),
		[
			"---",
			"name: legacy",
			"---",
			"",
			"# Legacy",
			"",
			"## explore",
			"",
			"Do the exploring.",
			"",
			"## write",
			"",
			"Do the writing.",
			"",
		].join("\n"),
		"utf-8",
	);

	const legacy = discoverWorkflows(cwd).project.find((w) => w.name === "legacy");
	assert.ok(legacy);
	assert.deepEqual(
		legacy.steps.map((s) => s.id),
		["explore", "write"],
	);
});
