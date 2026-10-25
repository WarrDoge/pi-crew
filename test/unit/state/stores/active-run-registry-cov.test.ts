import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	activeRunEntries,
	activeRunRoots,
	readActiveRunRegistry,
	registerActiveRun,
	unregisterActiveRun,
} from "../../../../src/state/stores/active-run-registry.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { cleanupStateRoot, removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const team: TeamConfig = {
	name: "test-team",
	description: "Test team",
	source: "builtin",
	filePath: "test.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const workflow: WorkflowConfig = {
	name: "test-workflow",
	description: "Test workflow",
	source: "builtin",
	filePath: "test.workflow.md",
	steps: [{ id: "step1", role: "executor", task: "Do work" }],
};

async function withIsolatedHome<T>(fn: () => T | Promise<T>): Promise<T> {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ar-reg-cov-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		await removeDirWithRetry(home);
	}
}

describe("readActiveRunRegistry", () => {
	it("returns empty array when no registry exists", async () => {
		await withIsolatedHome(async () => {
			assert.deepEqual(readActiveRunRegistry(), []);
		});
	});

	it("returns empty array for corrupt registry file", async () => {
		await withIsolatedHome(async () => {
			const runsDir = path.join(process.env.PI_TEAMS_HOME!, "state", "runs");
			fs.mkdirSync(runsDir, { recursive: true });
			fs.writeFileSync(path.join(runsDir, "active-run-index.json"), "not json");
			assert.deepEqual(readActiveRunRegistry(), []);
		});
	});

	it("returns empty array for non-array registry content", async () => {
		await withIsolatedHome(async () => {
			const runsDir = path.join(process.env.PI_TEAMS_HOME!, "state", "runs");
			fs.mkdirSync(runsDir, { recursive: true });
			fs.writeFileSync(path.join(runsDir, "active-run-index.json"), '{"not":"array"}');
			assert.deepEqual(readActiveRunRegistry(), []);
		});
	});
});

describe("registerActiveRun + unregisterActiveRun", () => {
	it("registers and reads back a run", async () => {
		await withIsolatedHome(async () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ar-reg-cwd-"));
			const { manifest } = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "test",
			});
			registerActiveRun(manifest);
			const entries = readActiveRunRegistry();
			assert.ok(entries.length >= 1);
			assert.ok(entries.some((e) => e.runId === manifest.runId));
			await cleanupStateRoot(cwd);
		});
	});

	it("unregisters a run by id", async () => {
		await withIsolatedHome(async () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ar-unreg-cwd-"));
			const { manifest } = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "test",
			});
			registerActiveRun(manifest);
			unregisterActiveRun(manifest.runId);
			const entries = readActiveRunRegistry();
			assert.ok(!entries.some((e) => e.runId === manifest.runId));
			await cleanupStateRoot(cwd);
		});
	});

	it("unregisterActiveRun ignores invalid run IDs", async () => {
		await withIsolatedHome(async () => {
			// Should not throw
			unregisterActiveRun("../../etc/passwd");
			unregisterActiveRun("");
		});
	});

	it("registering the same runId twice deduplicates", async () => {
		await withIsolatedHome(async () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ar-dedup-cwd-"));
			const { manifest } = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "test",
			});
			registerActiveRun(manifest);
			registerActiveRun(manifest);
			const entries = readActiveRunRegistry();
			const count = entries.filter((e) => e.runId === manifest.runId).length;
			assert.equal(count, 1);
			await cleanupStateRoot(cwd);
		});
	});
});

describe("activeRunEntries", () => {
	it("returns empty when no runs exist", async () => {
		await withIsolatedHome(async () => {
			assert.deepEqual(activeRunEntries(), []);
		});
	});

	it("returns entries for active runs", async () => {
		await withIsolatedHome(async () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ar-entries-cwd-"));
			const { manifest } = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "test active entries",
			});
			registerActiveRun(manifest);
			const entries = activeRunEntries();
			assert.ok(entries.some((e) => e.runId === manifest.runId));
			await cleanupStateRoot(cwd);
		});
	});
});

describe("activeRunRoots", () => {
	it("returns empty when no runs exist", async () => {
		await withIsolatedHome(async () => {
			assert.deepEqual(activeRunRoots(), []);
		});
	});

	it("returns deduplicated state root parents", async () => {
		await withIsolatedHome(async () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ar-roots-cwd-"));
			const { manifest } = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "test roots",
			});
			registerActiveRun(manifest);
			const roots = activeRunRoots();
			assert.ok(roots.length >= 1);
			await cleanupStateRoot(cwd);
		});
	});
});
