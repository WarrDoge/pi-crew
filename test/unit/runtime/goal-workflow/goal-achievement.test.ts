import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	applyGoalAchievement,
	assessGoalAchievement,
	goalDeclaresReadOnly,
	MUTATING_ROLES,
	workflowIsMutating,
} from "../../../../src/runtime/goal-workflow/goal-achievement.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

/** Make a tmpdir that is a REAL git repo (git init) so `git status` works. */
function gitRepoTmp(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	execSync("git init -q", { cwd: dir });
	execSync('git config user.email "test@test"', { cwd: dir });
	execSync('git config user.name "test"', { cwd: dir });
	fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
	return dir;
}

function plainTmp(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
	return dir;
}

function manifest(cwd: string, status: TeamRunManifest["status"] = "completed"): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "run_ga_test",
		stateRoot: path.join(cwd, ".crew"),
		artifactsRoot: path.join(cwd, ".crew"),
		tasksPath: path.join(cwd, ".crew", "tasks.json"),
		eventsPath: path.join(cwd, ".crew", "events.jsonl"),
		cwd,
		team: "t",
		workflow: "w",
		goal: "g",
		workspaceMode: "single",
		status,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		artifacts: [],
	};
}

function task(id: string, role: string, status: TeamTaskState["status"]): TeamTaskState {
	return {
		id,
		runId: "run_ga_test",
		stepId: id,
		role,
		agent: role,
		title: id,
		status,
		dependsOn: [],
		cwd: "/",
		graph: { taskId: id, children: [], dependencies: [], queue: "done" },
	};
}

const mutatingWorkflow = {
	name: "impl",
	description: "",
	steps: [{ id: "exec", role: "executor" }],
	source: "test",
	filePath: "builtin",
} as unknown as WorkflowConfig;
const readOnlyWorkflow = {
	name: "review",
	description: "",
	steps: [{ id: "rev", role: "reviewer" }],
	source: "test",
	filePath: "builtin",
} as unknown as WorkflowConfig;

test("MUTATING_ROLES = executor + test-engineer (NOT writer/verifier — they write to gitignored .crew)", () => {
	assert.ok(MUTATING_ROLES.has("executor"));
	assert.ok(MUTATING_ROLES.has("test-engineer"));
	assert.ok(!MUTATING_ROLES.has("writer"));
	assert.ok(!MUTATING_ROLES.has("verifier"));
	assert.ok(!MUTATING_ROLES.has("reviewer"));
});

test("workflowIsMutating: executor/test-engineer → true; reviewer/writer-only → false", () => {
	assert.equal(workflowIsMutating(mutatingWorkflow), true);
	assert.equal(workflowIsMutating(readOnlyWorkflow), false);
});

test("#2 read-only workflow is NEVER accused — returns unknown (conservative)", () => {
	const cwd = gitRepoTmp("ga-readonly-");
	try {
		// clean git tree, read-only workflow → must NOT be flagged false-green
		const a = assessGoalAchievement(manifest(cwd), [task("rev", "reviewer", "completed")], readOnlyWorkflow);
		assert.equal(a.achieved, "unknown");
		assert.match(a.reason, /read-only/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("#2 mutating workflow + CLEAN tree + NO failed task → false-green FLAGGED but NOT downgraded", () => {
	const cwd = gitRepoTmp("ga-cleanflag-");
	try {
		// executor completed but left zero diff → false-green signature
		const a = assessGoalAchievement(manifest(cwd), [task("exec", "executor", "completed")], mutatingWorkflow);
		assert.equal(a.achieved, false);
		assert.match(a.reason, /false-green|no project edits/);
		// apply: goalAchieved=false exposed, but status stays completed (no corroborating failure)
		const applied = applyGoalAchievement(manifest(cwd), a);
		assert.equal(applied.manifest.goalAchieved, false);
		assert.equal(applied.downgraded, false);
		assert.equal(applied.manifest.status, "completed"); // NOT broken
		assert.match(applied.manifest.goalAchievementNote ?? "", /FALSE-GREEN/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("#2 mutating + CLEAN tree + FAILED task → false-green AND status downgraded completed→failed", () => {
	const cwd = gitRepoTmp("ga-downgrade-");
	try {
		const a = assessGoalAchievement(manifest(cwd), [task("exec", "executor", "failed")], mutatingWorkflow);
		assert.equal(a.achieved, false);
		assert.ok(
			a.signals.some((s) => s.startsWith("corroborating failed task")),
			"must surface corroborating signal",
		);
		const applied = applyGoalAchievement(manifest(cwd, "completed"), a);
		assert.equal(applied.downgraded, true);
		assert.equal(applied.manifest.status, "failed"); // the lie is corrected
		assert.equal(applied.manifest.goalAchieved, false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("#2 mutating + DIRTY tree (edits made) → achieved true (genuine success)", () => {
	const cwd = gitRepoTmp("ga-dirty-");
	try {
		// create a source file → working tree dirty
		fs.writeFileSync(path.join(cwd, "src.ts"), "export const x = 1;\n");
		const a = assessGoalAchievement(manifest(cwd), [task("exec", "executor", "completed")], mutatingWorkflow);
		assert.equal(a.achieved, true);
		const applied = applyGoalAchievement(manifest(cwd), a);
		assert.equal(applied.manifest.goalAchieved, true);
		assert.equal(applied.downgraded, false);
		assert.equal(applied.manifest.status, "completed");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("#2 non-git cwd → unknown (no git repo to inspect)", () => {
	const cwd = plainTmp("ga-nogit-");
	try {
		const a = assessGoalAchievement(manifest(cwd), [task("exec", "executor", "completed")], mutatingWorkflow);
		assert.equal(a.achieved, "unknown");
		assert.match(a.reason, /not a git repo|git unavailable/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("#2 goal-declared-read-only: mutating workflow + clean tree + 'read-only task' goal → unknown, NOT false", () => {
	const cwd = gitRepoTmp("ga-goalro-");
	try {
		// battery-style goal (run team_20261014010550): read README + explicit
		// read-only declaration, but the workflow shape is mutating (executor step)
		const m: TeamRunManifest = {
			...manifest(cwd),
			goal: "Read README.md and summarize the architecture. Do NOT modify, create, or delete any files — read-only task.",
		};
		const a = assessGoalAchievement(m, [task("exec", "executor", "completed")], mutatingWorkflow);
		assert.equal(a.achieved, "unknown"); // clean tree is EXPECTED — never accused
		assert.notEqual(a.achieved, false);
		assert.match(a.reason, /declared read-only|no edits expected/);
		assert.deepEqual(a.signals, []);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("#2 goal-declared-read-only: 'Do NOT modify, create, or delete any files' marker → unknown", () => {
	const cwd = gitRepoTmp("ga-goalro2-");
	try {
		const m: TeamRunManifest = {
			...manifest(cwd),
			goal: "Audit the config. Do NOT modify, create, or delete any files.",
		};
		const a = assessGoalAchievement(m, [task("exec", "executor", "completed")], mutatingWorkflow);
		assert.equal(a.achieved, "unknown");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("#2 goal-declared-read-only: Vietnamese marker 'không sửa file nào' → unknown", () => {
	const cwd = gitRepoTmp("ga-goalro3-");
	try {
		const m: TeamRunManifest = {
			...manifest(cwd),
			goal: "Đọc README và báo cáo tóm tắt — không sửa file nào.",
		};
		const a = assessGoalAchievement(m, [task("exec", "executor", "completed")], mutatingWorkflow);
		assert.equal(a.achieved, "unknown");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("#2 mutating + clean tree + goal WITHOUT read-only marker → false (false-green pinned, regression)", () => {
	const cwd = gitRepoTmp("ga-nomarker-");
	try {
		const m: TeamRunManifest = {
			...manifest(cwd),
			goal: "Refactor the parser and fix every lint error in src/.",
		};
		const a = assessGoalAchievement(m, [task("exec", "executor", "completed")], mutatingWorkflow);
		assert.equal(a.achieved, false); // real mutating goal → false-green as before
		assert.match(a.reason, /false-green|no project edits/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("goalDeclaresReadOnly: undefined → false; case-insensitive 'READ-ONLY' → true", () => {
	assert.equal(goalDeclaresReadOnly(undefined), false);
	assert.equal(goalDeclaresReadOnly(""), false);
	assert.equal(goalDeclaresReadOnly("READ-ONLY"), true);
	assert.equal(goalDeclaresReadOnly("Make it   Read   Only  please"), true); // whitespace-collapsed, case-insensitive
	assert.equal(goalDeclaresReadOnly("rewrite the module and add tests"), false);
});
