/**
 * DR-04 W5 / R7-15 (2026-10-16).
 *
 * The PID liveness probe comment says "EPERM means process is alive but
 * protected; treat as alive" — but BOTH `filterAliveEntries` and
 * `activeRunEntries` returned false / `continue`d on every error code,
 * silently dropping live EPERM entries from the registry. Only
 * ESRCH/ENOENT (process gone) may prune. process.kill is stubbed to make
 * the errno deterministic (real EPERM needs a foreign security context).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { activeRunEntries, readActiveRunRegistry, registerActiveRun } from "../../../../src/state/stores/active-run-registry.ts";
import { createRunManifest, saveRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { cleanupStateRoot, removeDirWithRetry } from "../../../helpers/rm-retry.ts";

// Use realpath to resolve symlinks (macOS /var/folders → /private/var/folders).
const realTmp = fs.realpathSync(os.tmpdir());

const team: TeamConfig = {
	name: "eperm",
	description: "eperm",
	source: "builtin",
	filePath: "eperm.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "eperm",
	description: "eperm",
	source: "builtin",
	filePath: "eperm.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

async function withIsolatedHome<T>(fn: () => T | Promise<T>): Promise<T> {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(realTmp, "pi-crew-eperm-home-"));
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	process.env.PI_TEAMS_HOME = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		await removeDirWithRetry(home);
	}
}

/** Stub process.kill to throw a chosen errno (Node validates the real signal;
 *  pid 0 style probes are what the registry performs). */
function withKillCode<T>(code: string, fn: () => T): T {
	const originalKill = process.kill;
	process.kill = ((_pid: number, _signal?: number | string) => {
		const err = new Error(`mock kill failure (${code})`) as NodeJS.ErrnoException;
		err.code = code;
		throw err;
	}) as typeof process.kill;
	try {
		return fn();
	} finally {
		process.kill = originalKill;
	}
}

function makeAsyncManifest() {
	const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-eperm-run-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const { manifest } = createRunManifest({ cwd, team, workflow, goal: "eperm probe" });
	// Model an async run whose pid exists but belongs to a protected security
	// context (EPERM on signal-0 probe).
	const asyncManifest = {
		...manifest,
		async: { pid: 4242, logPath: "pi-crew-eperm-mock.log", spawnedAt: new Date().toISOString() },
		updatedAt: new Date().toISOString(),
	};
	saveRunManifest(asyncManifest);
	return { cwd, manifest: asyncManifest };
}

test("R7-15: EPERM entry is kept — registerActiveRun succeeds (filterAliveEntries)", async () => {
	await withIsolatedHome(async () => {
		const { cwd, manifest } = makeAsyncManifest();
		try {
			// Before the fix, filterAliveEntries returned false for the EPERM
			// branch and registerActiveRun THREW "Cannot register run ...".
			withKillCode("EPERM", () => {
				assert.doesNotThrow(() => registerActiveRun(manifest), "EPERM entry must be treated as alive");
			});
			const entries = readActiveRunRegistry();
			assert.equal(entries.length, 1, "EPERM run stays in the registry");
			assert.equal(entries[0]?.runId, manifest.runId);
		} finally {
			await cleanupStateRoot(cwd);
		}
	});
});

test("R7-15: EPERM entry is surfaced by activeRunEntries; ESRCH prunes it", async () => {
	await withIsolatedHome(async () => {
		const { cwd, manifest } = makeAsyncManifest();
		try {
			// Register under EPERM semantics too — without the stub the real probe
			// for the nonexistent pid 4242 throws ESRCH and registerActiveRun
			// legitimately refuses the dead entry.
			withKillCode("EPERM", () => registerActiveRun(manifest));

			withKillCode("EPERM", () => {
				const eperm = activeRunEntries();
				assert.ok(
					eperm.some((e) => e.runId === manifest.runId),
					"EPERM entry must be surfaced",
				);
			});

			withKillCode("ESRCH", () => {
				const esrch = activeRunEntries();
				assert.equal(
					esrch.some((e) => e.runId === manifest.runId),
					false,
					"ESRCH entry must be pruned",
				);
			});
		} finally {
			await cleanupStateRoot(cwd);
		}
	});
});
