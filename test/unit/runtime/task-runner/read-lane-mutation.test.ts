/**
 * read-lane-mutation.test.ts — W10-8 (v0.11.38) pin.
 *
 * pi-subagents lesson #4 (staged-files guard): a READ-ONLY lane that dirtied
 * its worktree violates the lane contract. pi-crew surfaces it as a note
 * (unexpectedMutation on the task) — evidence in the diff artifact, leader
 * decides; never a hard fail.
 *
 * Pins (real throwaway git repos):
 *   (1) clean tree → undefined;
 *   (2) modified tracked file → note with filesChanged=1;
 *   (3) UNTRACKED file also counts (git diff alone would miss it);
 *   (4) non-git dir → undefined (fail-open, no throw);
 *   (5) permissionForRole gating: read_only roles get the probe, mutating
 *       roles don't (checked via the role classifier directly).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { permissionForRole } from "../../../../src/runtime/role-permission.ts";
import { detectReadLaneMutation, warnReadLaneMutation } from "../../../../src/runtime/task-runner/post-execution.ts";

function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w108-"));
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
	return dir;
}

describe("W10-8 read-lane mutation guard", () => {
	it("(1) clean tree → undefined", async () => {
		const repo = makeRepo();
		assert.equal(await detectReadLaneMutation(repo), undefined);
	});

	it("(2) modified tracked file → note", async () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
		const note = await detectReadLaneMutation(repo);
		assert.ok(note);
		assert.equal(note.filesChanged, 1);
		assert.equal(note.sample.length, 1);
		assert.match(note.sample[0], /a\.txt/);
	});

	it("(3) UNTRACKED file counts too", async () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo, "new.ts"), "export {};\n");
		const note = await detectReadLaneMutation(repo);
		assert.ok(note);
		assert.equal(note.filesChanged, 1);
	});

	it("(4) non-git dir → undefined (fail-open)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
		assert.equal(await detectReadLaneMutation(dir), undefined);
	});

	it("(5) probe is read_only-gated: explorer read-only, executor not", () => {
		assert.equal(permissionForRole("explorer"), "read_only");
		assert.notEqual(permissionForRole("executor"), "read_only");
	});

	it("(6) stamping the note emits exactly one stderr warn line (visibility pin)", () => {
		const original = console.warn;
		const lines: string[] = [];
		console.warn = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};
		try {
			warnReadLaneMutation("task-9", { filesChanged: 3 });
		} finally {
			console.warn = original;
		}
		assert.equal(lines.length, 1);
		assert.equal(lines[0], "[pi-crew:read-lane] unexpected mutation in READ-ONLY lane: task-9 files=3");
	});
});
