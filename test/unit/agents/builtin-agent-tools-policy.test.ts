/**
 * Wave-3 attack-chain A (R2-M-B1 companion): the "read-only" discovery roles
 * (explorer, librarian) must NOT carry `bash` in their ENFORCED frontmatter
 * tools allowlist — their bodies advertise read-only/no-web, and bash was the
 * gap that let repo content run arbitrary commands as the user. verifier and
 * executor intentionally KEEP bash.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

// The custom test-runner rewrites import.meta paths — resolve from cwd (the
// package root when the runner is invoked) and fall back to walking up.
function findAgentsDir(): string {
	let dir = process.cwd();
	for (let i = 0; i < 6; i++) {
		const candidate = path.join(dir, "agents", "explorer.md");
		if (fs.existsSync(candidate)) return path.join(dir, "agents");
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("agents/ dir not found from cwd");
}
const agentsDir = findAgentsDir();

function readTools(name: string): string[] {
	const raw = fs.readFileSync(path.join(agentsDir, `${name}.md`), "utf-8");
	const match = /^tools:\s*(.+)$/m.exec(raw);
	assert.ok(match, `${name}.md must have a tools: frontmatter line`);
	return match[1]
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
}

test("explorer + librarian frontmatter tools exclude bash (read-only enforced)", () => {
	for (const name of ["explorer", "librarian"]) {
		const tools = readTools(name);
		assert.ok(!tools.includes("bash"), `${name}.md must not expose bash (got: ${tools.join(",")})`);
		assert.ok(tools.includes("read"), `${name}.md keeps its read tools`);
	}
});

test("verifier + executor keep bash (write-capable roles, untouched by Wave-3)", () => {
	assert.ok(readTools("verifier").includes("bash"));
	assert.ok(readTools("executor").includes("bash"));
});
