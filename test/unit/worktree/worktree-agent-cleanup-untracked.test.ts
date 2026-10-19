import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { cleanupAgentWorktree, cleanupAgentWorktreeAsync, prepareAgentWorktree } from "../../../src/worktree/worktree-manager.ts";
import { removeDirWithRetry } from "../../helpers/rm-retry.ts";

/**
 * R36-M1 / R36-M2 (deep-review round 36) — DWF agent-worktree lifecycle pins.
 *
 * R36-M1: `cleanupAgentWorktree` captured `git diff` only (tracked changes) and
 * wrote an artifact ONLY when that diff was non-empty. An agent whose work is
 * NEW FILES (the normal case) therefore produced no artifact at all, and
 * `git worktree remove --force` destroyed the work with zero recovery.
 *
 * R36-M2: `prepareTaskWorkspace{,Async}`'s add-failure catch ran
 * `fs.rmSync(worktreePath)` BEFORE inspecting the error. `git worktree add`
 * fails with "fatal: '<path>' already exists" when a concurrent prepare already
 * won that path — the winner's live worktree (with uncommitted output) was
 * deleted. The only dir a failed add may remove is an EMPTY one.
 *
 * Both files use real git (like the sibling worktree tests) — no mocks.
 */

function makeRepoTemp(prefix: string): string {
	let dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		dir = fs.realpathSync(dir);
	} catch {
		/* keep */
	}
	return dir;
}

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function initGitRepo(dir: string): void {
	execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
	fs.writeFileSync(path.join(dir, ".gitignore"), ".crew\n", "utf-8");
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", ".gitignore"], { cwd: dir });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dir });
}

function dwfManifest(cwd: string, runId: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId,
		team: "direct-executor",
		workflow: "direct-agent",
		goal: "R36 pins",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd,
		stateRoot: path.join(cwd, ".crew", "state"),
		artifactsRoot: path.join(cwd, ".crew", "artifacts"),
		tasksPath: path.join(cwd, ".crew", "state", "tasks.json"),
		eventsPath: path.join(cwd, ".crew", "state", "events.jsonl"),
		artifacts: [],
	} as TeamRunManifest;
}

/** Every .md file written under <artifactsRoot>/worktree-recovery/. */
function recoveryArtifacts(artifactsRoot: string): Array<{ file: string; content: string }> {
	const dir = path.join(artifactsRoot, "worktree-recovery");
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => ({ file: f, content: fs.readFileSync(path.join(dir, f), "utf-8") }));
}

test("R36-M1: cleanupAgentWorktree backs up UNTRACKED files before the force-remove", async (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	const repo = makeRepoTemp("pi-crew-r36-m1-");
	try {
		initGitRepo(repo);
		const manifest = dwfManifest(repo, "r36-m1-run");
		const prepared = prepareAgentWorktree(manifest, "agent-untracked");
		assert.ok(prepared?.worktreePath, "worktree must be created");

		// The agent's entire output = NEW files (no tracked modification) — the
		// exact shape where the pre-fix cleanup wrote no artifact and destroyed it.
		fs.writeFileSync(path.join(prepared.worktreePath, "agent-notes.md"), "UNTRACKED-AGENT-WORK\n", "utf-8");
		fs.mkdirSync(path.join(prepared.worktreePath, "out"), { recursive: true });
		fs.writeFileSync(path.join(prepared.worktreePath, "out", "report.txt"), "NESTED-UNTRACKED\n", "utf-8");

		cleanupAgentWorktree(manifest, prepared.worktreePath, prepared.branch);

		assert.equal(fs.existsSync(prepared.worktreePath), false, "the worktree is still removed (no leak)");
		const artifacts = recoveryArtifacts(manifest.artifactsRoot);
		assert.equal(artifacts.length, 1, `exactly one recovery snapshot expected, got: ${artifacts.map((a) => a.file).join(", ")}`);
		assert.match(artifacts[0].content, /UNTRACKED-AGENT-WORK/, "untracked file content must be recoverable from the artifact");
		assert.match(artifacts[0].content, /NESTED-UNTRACKED/, "untracked files inside new dirs must be captured too");
		assert.match(artifacts[0].content, /worktree-recovery snapshot|Worktree recovery snapshot/);
	} finally {
		await removeDirWithRetry(repo);
	}
});

test("R36-M1: cleanupAgentWorktreeAsync has the same untracked backup (async twin)", async (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	const repo = makeRepoTemp("pi-crew-r36-m1-async-");
	try {
		initGitRepo(repo);
		const manifest = dwfManifest(repo, "r36-m1-async-run");
		const prepared = prepareAgentWorktree(manifest, "agent-untracked-async");
		assert.ok(prepared?.worktreePath, "worktree must be created");
		fs.writeFileSync(path.join(prepared.worktreePath, "async-notes.md"), "ASYNC-UNTRACKED-WORK\n", "utf-8");

		await cleanupAgentWorktreeAsync(manifest, prepared.worktreePath, prepared.branch);

		assert.equal(fs.existsSync(prepared.worktreePath), false, "the worktree is still removed (no leak)");
		const artifacts = recoveryArtifacts(manifest.artifactsRoot);
		assert.equal(artifacts.length, 1, `exactly one recovery snapshot expected, got: ${artifacts.map((a) => a.file).join(", ")}`);
		assert.match(artifacts[0].content, /ASYNC-UNTRACKED-WORK/);
	} finally {
		await removeDirWithRetry(repo);
	}
});

test("R36-M1: a tracked-only change keeps the legacy diff artifact and adds no duplicate snapshot", async (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	const repo = makeRepoTemp("pi-crew-r36-m1-tracked-");
	try {
		initGitRepo(repo);
		const manifest = dwfManifest(repo, "r36-m1-tracked-run");
		const prepared = prepareAgentWorktree(manifest, "agent-tracked");
		assert.ok(prepared?.worktreePath, "worktree must be created");
		// Modify a TRACKED file only (.gitignore is committed by initGitRepo).
		fs.appendFileSync(path.join(prepared.worktreePath, ".gitignore"), "extra-ignored\n", "utf-8");

		cleanupAgentWorktree(manifest, prepared.worktreePath, prepared.branch);

		const wfDir = path.join(manifest.artifactsRoot, "wf");
		const diffs = fs.existsSync(wfDir) ? fs.readdirSync(wfDir).filter((f) => f.startsWith("worktree-diff-")) : [];
		assert.ok(diffs.length > 0, "tracked changes still land in the legacy worktree-diff artifact");
		assert.equal(
			recoveryArtifacts(manifest.artifactsRoot).length,
			0,
			"no untracked entries ⇒ no extra snapshot (no duplicate artifact)",
		);
	} finally {
		await removeDirWithRetry(repo);
	}
});

// ── R36-M2: add-failure isolation ──────────────────────────────────────────

function taskManifest(cwd: string, runId: string): TeamRunManifest {
	return { ...dwfManifest(cwd, runId), workspaceMode: "worktree", stateRoot: path.join(cwd, ".crew", "state", "runs", runId) };
}

test("R36-M2: a failed add whose path already holds foreign work is NOT deleted", async (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	const repo = makeRepoTemp("pi-crew-r36-m2-");
	try {
		initGitRepo(repo);
		// The deterministic task worktree path (runId + taskId sanitized).
		const worktreePath = path.join(repo, ".crew", "worktrees", "r36-m2-run", "task-m2");
		fs.mkdirSync(worktreePath, { recursive: true });
		// A concurrent prepare owns this path: its (live) uncommitted output is here.
		fs.writeFileSync(path.join(worktreePath, "winner-output.txt"), "LIVE-UNCOMMITTED-WORK\n", "utf-8");

		const manifest = taskManifest(repo, "r36-m2-run");
		const task = {
			id: "task-m2",
			agent: "explorer",
			status: "waiting",
			role: "explorer",
			title: "t",
			dependsOn: [],
			cwd: repo,
			runId: "r36-m2-run",
		} as never;

		const { prepareTaskWorkspace } = await import("../../../src/worktree/worktree-manager.ts");
		assert.throws(
			() => prepareTaskWorkspace(manifest, task),
			/already exists|refusing to delete/i,
			"add failure must surface a clear error",
		);
		// The pre-fix code rm -rf'd this directory before even looking at the error.
		assert.equal(
			fs.readFileSync(path.join(worktreePath, "winner-output.txt"), "utf-8"),
			"LIVE-UNCOMMITTED-WORK\n",
			"another run's worktree output must survive a failed add (R36-M2)",
		);
	} finally {
		await removeDirWithRetry(repo);
	}
});

test("R36-M2: the async twin preserves a foreign path too", async (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	const repo = makeRepoTemp("pi-crew-r36-m2-async-");
	try {
		initGitRepo(repo);
		const worktreePath = path.join(repo, ".crew", "worktrees", "r36-m2-async-run", "task-m2a");
		fs.mkdirSync(worktreePath, { recursive: true });
		fs.writeFileSync(path.join(worktreePath, "winner-output.txt"), "LIVE-ASYNC-WORK\n", "utf-8");

		const manifest = taskManifest(repo, "r36-m2-async-run");
		const task = {
			id: "task-m2a",
			agent: "explorer",
			status: "waiting",
			role: "explorer",
			title: "t",
			dependsOn: [],
			cwd: repo,
			runId: "r36-m2-async-run",
		} as never;

		const { prepareTaskWorkspaceAsync } = await import("../../../src/worktree/worktree-manager.ts");
		await assert.rejects(() => prepareTaskWorkspaceAsync(manifest, task), /already exists|refusing to delete/i);
		assert.equal(
			fs.readFileSync(path.join(worktreePath, "winner-output.txt"), "utf-8"),
			"LIVE-ASYNC-WORK\n",
			"async twin must not delete another run's work either (R36-M2)",
		);
	} finally {
		await removeDirWithRetry(repo);
	}
});
