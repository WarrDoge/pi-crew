import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { sharedPath, writeTaskSharedOutput } from "../../../../src/runtime/task-output-context.ts";
import { writeArtifact } from "../../../../src/state/stores/artifact-store.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const team: TeamConfig = {
	name: "security",
	description: "security",
	source: "builtin",
	filePath: "security.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

async function isUsableDirectoryLink(linkPath: string): Promise<boolean> {
	try {
		fs.lstatSync(linkPath);
		fs.realpathSync.native(linkPath);
		return true;
	} catch {
		try {
			fs.unlinkSync(linkPath);
		} catch {
			try {
				await removeDirWithRetry(linkPath);
			} catch {
				/* ignore cleanup failure */
			}
		}
		return false;
	}
}

async function tryDirectorySymlink(target: string, linkPath: string): Promise<boolean> {
	try {
		fs.symlinkSync(target, linkPath, "dir");
		return await isUsableDirectoryLink(linkPath);
	} catch {
		try {
			fs.symlinkSync(target, linkPath, "junction");
			return await isUsableDirectoryLink(linkPath);
		} catch {
			return false;
		}
	}
}

test("artifact and shared output paths reject traversal", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-artifact-traversal-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({
			cwd,
			team,
			goal: "artifact traversal",
		});
		assert.throws(
			() =>
				writeArtifact(manifest.artifactsRoot, {
					kind: "metadata",
					relativePath: "shared/../../escape.txt",
					producer: "test",
					content: "bad",
				}),
			/Invalid artifact path/,
		);
		assert.throws(() => sharedPath(manifest, "../../escape.txt"), /Invalid shared artifact name/);
		const result = writeArtifact(manifest.artifactsRoot, {
			kind: "result",
			relativePath: "results/task.md",
			producer: "task",
			content: "ok",
		});
		const task: TeamTaskState = {
			id: "task",
			runId: manifest.runId,
			title: "Task",
			role: "executor",
			agent: "executor",
			cwd,
			status: "completed",
			dependsOn: [],
			resultArtifact: result,
		};
		assert.throws(
			() =>
				writeTaskSharedOutput(
					manifest,
					{
						id: "task",
						role: "executor",
						task: "do",
						output: "../../escape.txt",
					},
					task,
				),
			/Invalid shared artifact name/,
		);
		assert.equal(fs.existsSync(path.join(manifest.artifactsRoot, "..", "escape.txt")), false);
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("artifact writes reject symlinked artifacts root escapes", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-artifact-root-symlink-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({
			cwd,
			team,
			goal: "artifact symlink root",
		});
		const outside = path.join(cwd, "outside-artifacts");
		fs.mkdirSync(outside, { recursive: true });
		await removeDirWithRetry(manifest.artifactsRoot);
		if (!(await tryDirectorySymlink(outside, manifest.artifactsRoot))) {
			t.skip("directory symlinks unavailable on this platform");
			return;
		}
		assert.throws(
			() =>
				writeArtifact(manifest.artifactsRoot, {
					kind: "result",
					relativePath: "results/task.md",
					producer: "task",
					content: "secret",
				}),
			/symbolic link|Path is outside/,
		);
		assert.equal(fs.existsSync(path.join(outside, "results", "task.md")), false);
	} finally {
		await removeDirWithRetry(cwd);
	}
});
