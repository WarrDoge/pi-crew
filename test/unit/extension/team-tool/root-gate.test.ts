/**
 * Wave-3 root-gate tests (R2-M-B1, R3-SEC-1, R5-M-B1, R5-M-B2).
 *
 * Mirrors the round-6 probe (R5-M-B1): a WORKER session is simulated with
 * env PI_CREW_KIND=subagent + PI_CREW_DEPTH=1 (+ redirected HOME so nothing
 * can touch the real user tier even if a gate ever regresses); the root
 * session is the same process env minus those keys.
 *
 * Fix-wave 6 additions: R11-S1 (workflow-create/save/delete + import/export
 * root-gated) and R11-F1 (config.scope is the single canonical scope carrier
 * — divergent top-level scope must not bypass the gate).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { assertRootOnlyAction, isRootSession, rootGateBlockReason } from "../../../../src/extension/team-tool/destructive-gate.ts";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { userPiRoot } from "../../../../src/utils/paths.ts";
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";

const WORKER_ENV = { PI_CREW_KIND: "subagent", PI_CREW_DEPTH: "1" } as const;
const ROOT_ENV = { PI_CREW_KIND: "", PI_CREW_DEPTH: "0" } as const;

const CLEAN_SCRIPT = `export default async function (ctx) { await ctx.agent({ role: "executor", prompt: "hi" }); ctx.setResult("/tmp/x"); }\n`;

function tmpCtx(): { ctx: TeamContext; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "root-gate-test-"));
	return { ctx: { cwd: dir }, dir };
}

describe("isRootSession / assertRootOnlyAction (pure)", () => {
	it("worker env (subagent + depth 1) is NOT root; root env IS", () => {
		assert.equal(isRootSession(WORKER_ENV), false);
		assert.equal(isRootEnvSafe(), true);
	});

	it("assertRootOnlyAction returns a RootSessionRequiredError for gated combos, undefined for allowed", () => {
		const e1 = assertRootOnlyAction("schedule", "add", undefined, WORKER_ENV);
		assert.ok(e1 instanceof Error);
		assert.match(e1.message, /root-session required/);
		assert.equal(e1.name, "RootSessionRequiredError");
		// root session: everything allowed
		assert.equal(assertRootOnlyAction("schedule", "add", undefined, ROOT_ENV), undefined);
		assert.equal(assertRootOnlyAction("goal", "start", undefined, ROOT_ENV), undefined);
		assert.equal(assertRootOnlyAction("config", undefined, "user", ROOT_ENV), undefined);
		// worker: project scope allowed where the policy says so
		assert.equal(assertRootOnlyAction("config", undefined, "project", WORKER_ENV), undefined);
		assert.equal(assertRootOnlyAction("create", undefined, "project", WORKER_ENV), undefined);
		assert.equal(assertRootOnlyAction("update", undefined, "project", WORKER_ENV), undefined);
		// worker: user scope / always-user-tier actions rejected
		assert.ok(assertRootOnlyAction("goal", "start", undefined, WORKER_ENV));
		assert.ok(assertRootOnlyAction("config", undefined, "user", WORKER_ENV));
		assert.ok(assertRootOnlyAction("settings", "set", "user", WORKER_ENV));
		assert.ok(assertRootOnlyAction("settings", "theme", undefined, WORKER_ENV));
		assert.ok(assertRootOnlyAction("autonomy", undefined, undefined, WORKER_ENV));
		assert.ok(assertRootOnlyAction("create", undefined, "user", WORKER_ENV));
		assert.ok(assertRootOnlyAction("update", undefined, "user", WORKER_ENV));
		// ungated actions stay open
		assert.equal(assertRootOnlyAction("status", undefined, undefined, WORKER_ENV), undefined);
		// R11-S1 (fix-wave 6): workflow writes/deletes are unconditionally
		// worker-gated (.dwf.ts = arbitrary code auto-loaded by future sessions);
		// import/export gated at user scope only (project default open).
		assert.ok(assertRootOnlyAction("workflow-create", undefined, "project", WORKER_ENV));
		assert.ok(assertRootOnlyAction("workflow-save", undefined, undefined, WORKER_ENV));
		assert.ok(assertRootOnlyAction("workflow-delete", undefined, "project", WORKER_ENV));
		assert.ok(assertRootOnlyAction("import", undefined, "user", WORKER_ENV));
		assert.equal(assertRootOnlyAction("import", undefined, "project", WORKER_ENV), undefined);
		assert.ok(assertRootOnlyAction("export", undefined, "user", WORKER_ENV));
		assert.equal(assertRootOnlyAction("export", undefined, undefined, WORKER_ENV), undefined);
		// root session: all of the above allowed
		assert.equal(assertRootOnlyAction("workflow-create", undefined, "user", ROOT_ENV), undefined);
		assert.equal(assertRootOnlyAction("workflow-delete", undefined, "project", ROOT_ENV), undefined);
		assert.equal(assertRootOnlyAction("import", undefined, "user", ROOT_ENV), undefined);
	});
});

function isRootEnvSafe(): boolean {
	return isRootSession(ROOT_ENV);
}

describe("rootGateBlockReason (raw params resolution)", () => {
	it("goal: start and force:true gated; status/pause open", () => {
		assert.ok(rootGateBlockReason({ action: "goal", config: { subAction: "start" } }, WORKER_ENV));
		assert.ok(rootGateBlockReason({ action: "goal", config: { subAction: "stop", goalId: "g" }, force: true }, WORKER_ENV));
		assert.ok(rootGateBlockReason({ action: "goal", config: { subAction: "stop", goalId: "g", force: true } }, WORKER_ENV));
		assert.equal(rootGateBlockReason({ action: "goal", config: { subAction: "status" } }, WORKER_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "goal", config: { subAction: "stop", goalId: "g" } }, WORKER_ENV), undefined);
	});

	it("config: write at user scope gated (default), project + reads open", () => {
		assert.ok(rootGateBlockReason({ action: "config", config: { broker: { enabled: true } } }, WORKER_ENV));
		assert.ok(rootGateBlockReason({ action: "config", config: { unset: ["broker"] } }, WORKER_ENV));
		assert.equal(
			rootGateBlockReason({ action: "config", config: { broker: { enabled: true }, scope: "project" } }, WORKER_ENV),
			undefined,
		);
		assert.equal(rootGateBlockReason({ action: "config", config: {} }, WORKER_ENV), undefined);
	});

	it("RT24-F1: config/autonomy reads carrying non-schema keys stay open (args must not count as patch)", () => {
		// Live battery 2026-10-18: worker sent `config {args:"show"}` (a read);
		// the old exclusion-list miscounted `args` as a patch key and blocked it.
		assert.equal(rootGateBlockReason({ action: "config", config: { args: "show" } }, WORKER_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "config", config: { args: "status" } }, WORKER_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "autonomy", config: { args: "status" } }, WORKER_ENV), undefined);
		// Real writes hidden behind the same junk key are still gated (handler
		// predicate sees them too — gate and handler share the projection fns).
		assert.ok(rootGateBlockReason({ action: "config", config: { args: "show", unset: ["broker"] } }, WORKER_ENV));
		assert.ok(rootGateBlockReason({ action: "autonomy", config: { args: "status", autoApprove: true } }, WORKER_ENV));
	});

	it("settings: set/unset at user scope + theme gated; reads/project open", () => {
		assert.ok(rootGateBlockReason({ action: "settings", config: { args: "set broker.enabled true" } }, WORKER_ENV));
		assert.ok(rootGateBlockReason({ action: "settings", config: { args: "unset broker.enabled" } }, WORKER_ENV));
		assert.ok(rootGateBlockReason({ action: "settings", config: { args: "theme dark" } }, WORKER_ENV));
		assert.equal(
			rootGateBlockReason({ action: "settings", config: { args: "set broker.enabled true", scope: "project" } }, WORKER_ENV),
			undefined,
		);
		assert.equal(rootGateBlockReason({ action: "settings", config: { args: "list" } }, WORKER_ENV), undefined);
	});

	it("autonomy: patch gated, status read open", () => {
		assert.ok(rootGateBlockReason({ action: "autonomy", config: { autoApprove: true } }, WORKER_ENV));
		assert.equal(rootGateBlockReason({ action: "autonomy", config: {} }, WORKER_ENV), undefined);
	});

	it("R11-S1: workflow-create/save/delete gated for workers regardless of scope or confirm", () => {
		// .dwf.ts is an arbitrary-code surface auto-loaded by every future session
		// (the planted "pwn.dwf.ts"). Blocked for workers at EVERY scope; confirm:true
		// is caller-controlled and must NOT bypass the root-gate.
		assert.ok(rootGateBlockReason({ action: "workflow-create", confirm: true, config: { name: "pwn", script: "x" } }, WORKER_ENV));
		assert.ok(
			rootGateBlockReason({ action: "workflow-create", confirm: true, scope: "project", config: { name: "pwn", script: "x", scope: "project" } }, WORKER_ENV),
		);
		assert.ok(rootGateBlockReason({ action: "workflow-create", confirm: true, config: { name: "pwn", script: "x", scope: "user" } }, WORKER_ENV));
		assert.ok(rootGateBlockReason({ action: "workflow-save", confirm: true, config: { name: "pwn", script: "x" } }, WORKER_ENV));
		assert.ok(rootGateBlockReason({ action: "workflow-delete", confirm: true, config: { name: "x" } }, WORKER_ENV));
		// reads stay open
		assert.equal(rootGateBlockReason({ action: "workflow-get", config: { name: "x" } }, WORKER_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "workflow-list" }, WORKER_ENV), undefined);
		// root session: allowed
		assert.equal(rootGateBlockReason({ action: "workflow-create", confirm: true, config: { name: "pwn", script: "x" } }, ROOT_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "workflow-delete", confirm: true, config: { name: "x" } }, ROOT_ENV), undefined);
	});

	it("R11-S1: import/export gated at user scope only (project default open)", () => {
		assert.ok(rootGateBlockReason({ action: "import", config: { path: "/tmp/b.json", scope: "user" } }, WORKER_ENV));
		assert.ok(rootGateBlockReason({ action: "import", scope: "project", config: { path: "/tmp/b.json", scope: "user" } }, WORKER_ENV));
		assert.ok(rootGateBlockReason({ action: "export", config: { runId: "team_x", scope: "user" } }, WORKER_ENV));
		// project/default stay worker-reachable (mirrors handleImport's project default)
		assert.equal(rootGateBlockReason({ action: "import", config: { path: "/tmp/b.json" } }, WORKER_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "import", scope: "user", config: { path: "/tmp/b.json", scope: "project" } }, WORKER_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "export", config: { runId: "team_x" } }, WORKER_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "export", scope: "user", config: { runId: "team_x", scope: "project" } }, WORKER_ENV), undefined);
		// root session: user scope allowed
		assert.equal(rootGateBlockReason({ action: "import", config: { path: "/tmp/b.json", scope: "user" } }, ROOT_ENV), undefined);
	});

	it("R11-F1: config.scope is the single canonical carrier — divergent top-level scope cannot bypass", () => {
		// create: cfg user + top-level "project" (the R11-F1 plant shape) → BLOCKED
		assert.ok(rootGateBlockReason({ action: "create", scope: "project", config: { scope: "user", name: "evil" } }, WORKER_ENV));
		// create: carrier absent → user default (fail-closed; matches the handler)
		assert.ok(rootGateBlockReason({ action: "create", scope: "project", config: { name: "evil" } }, WORKER_ENV));
		// create: cfg "project" wins even when top-level says "user" → open (project-tier write)
		assert.equal(rootGateBlockReason({ action: "create", scope: "user", config: { scope: "project", name: "ok" } }, WORKER_ENV), undefined);
		// settings
		assert.ok(rootGateBlockReason({ action: "settings", scope: "project", config: { args: "set broker.enabled true", scope: "user" } }, WORKER_ENV));
		assert.equal(
			rootGateBlockReason({ action: "settings", scope: "user", config: { args: "set broker.enabled true", scope: "project" } }, WORKER_ENV),
			undefined,
		);
		// config
		assert.ok(rootGateBlockReason({ action: "config", scope: "project", config: { broker: { enabled: true }, scope: "user" } }, WORKER_ENV));
		assert.equal(rootGateBlockReason({ action: "config", scope: "user", config: { broker: { enabled: true }, scope: "project" } }, WORKER_ENV), undefined);
		// update (facade scope is a pre-filter; management.ts gates the resolved resource's tier)
		assert.ok(rootGateBlockReason({ action: "update", scope: "project", config: { scope: "user", name: "x" } }, WORKER_ENV));
		assert.equal(rootGateBlockReason({ action: "update", scope: "user", config: { scope: "project", name: "x" } }, WORKER_ENV), undefined);
		// import (project default — only an explicit cfg "user" is gated)
		assert.ok(rootGateBlockReason({ action: "import", scope: "project", config: { path: "x", scope: "user" } }, WORKER_ENV));
		assert.equal(rootGateBlockReason({ action: "import", scope: "user", config: { path: "x", scope: "project" } }, WORKER_ENV), undefined);
	});
});

describe("handleTeamTool root-gate (end-to-end, round-6 probe env)", () => {
	let savedEnv: NodeJS.ProcessEnv;
	let savedHome: string | undefined;
	let homeDir: string;

	/** User-tier path under the HERMETIC home (see beforeEach). */
	const userTierPath = (...parts: string[]) => path.join(userPiRoot(), ...parts);

	beforeEach(() => {
		savedEnv = { ...process.env };
		savedHome = process.env.HOME;
		homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "root-gate-home-"));
		process.env.HOME = homeDir; // redirected HOME — user tier stays hermetic
		// R11 wave: userPiRoot() resolves via PI_TEAMS_HOME (mirrorPrecedence
		// "teams"), which the test runner points at ITS isolated home — redirect
		// both mirrors to our per-test home so user-tier assertions are real
		// (previously absence checks passed vacuously against the wrong root).
		process.env.PI_TEAMS_HOME = homeDir;
		process.env.PI_CREW_HOME = homeDir;
		process.env.PI_CREW_KIND = "subagent";
		process.env.PI_CREW_DEPTH = "1";
	});

	afterEach(() => {
		process.env.PI_CREW_KIND = savedEnv.PI_CREW_KIND;
		process.env.PI_CREW_DEPTH = savedEnv.PI_CREW_DEPTH;
		process.env.PI_TEAMS_HOME = savedEnv.PI_TEAMS_HOME;
		process.env.PI_CREW_HOME = savedEnv.PI_CREW_HOME;
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		fs.rmSync(homeDir, { recursive: true, force: true });
	});

	async function run(params: TeamToolParamsValue, ctx: TeamContext) {
		const res = await handleTeamTool(params, ctx);
		return { isError: res.isError === true, text: textFromToolResult(res) ?? "" };
	}

	it("worker config→user-scope write REJECTED with root-session required", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			const r = await run({ action: "config", config: { broker: { enabled: true } } } as TeamToolParamsValue, ctx);
			assert.equal(r.isError, true);
			assert.match(r.text, /root-session required/);
			// nothing reached the user tier
			assert.equal(fs.existsSync(path.join(homeDir, ".pi")), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("worker config→project-scope write allowed past the gate", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			const r = await run({ action: "config", config: { broker: { enabled: true }, scope: "project" } } as TeamToolParamsValue, ctx);
			assert.doesNotMatch(r.text, /root-session required/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("worker schedule REJECTED (default add)", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			const r = await run({ action: "schedule", goal: "x", cron: "0 9 * * *" } as TeamToolParamsValue, ctx);
			assert.equal(r.isError, true);
			assert.match(r.text, /root-session required/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("worker schedule remove/run-now also rejected; scheduled list open", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			const r1 = await run({ action: "schedule", subAction: "remove", jobId: "j" } as TeamToolParamsValue, ctx);
			assert.match(r1.text, /root-session required/);
			const r2 = await run({ action: "schedule", subAction: "run-now", jobId: "j" } as TeamToolParamsValue, ctx);
			assert.match(r2.text, /root-session required/);
			const r3 = await run({ action: "scheduled" } as TeamToolParamsValue, ctx);
			assert.doesNotMatch(r3.text, /root-session required/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("root schedule ALLOWED (job persisted in project cwd)", async () => {
		delete process.env.PI_CREW_KIND;
		process.env.PI_CREW_DEPTH = "0";
		const { ctx, dir } = tmpCtx();
		try {
			const r = await run({ action: "schedule", goal: "probe", cron: "17 3 * * *" } as TeamToolParamsValue, ctx);
			assert.doesNotMatch(r.text, /root-session required/);
			assert.notEqual(r.isError, true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("worker goal start REJECTED; goal status open", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			const r = await run(
				{
					action: "goal",
					config: { subAction: "start", objective: "o", evaluatorModel: "m", budgetUnlimited: true },
				} as TeamToolParamsValue,
				ctx,
			);
			assert.equal(r.isError, true);
			assert.match(r.text, /root-session required/);
			const r2 = await run({ action: "goal", config: { subAction: "status" } } as TeamToolParamsValue, ctx);
			assert.doesNotMatch(r2.text, /root-session required/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("worker create→project allowed past the gate; create→user (default) rejected", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			const rProj = await run(
				{
					action: "create",
					resource: "agent",
					config: { name: "gate-probe", description: "d", scope: "project", systemPrompt: "p" },
				} as TeamToolParamsValue,
				ctx,
			);
			assert.doesNotMatch(rProj.text, /root-session required/);
			const rUser = await run(
				{
					action: "create",
					resource: "agent",
					config: { name: "gate-probe", description: "d", systemPrompt: "p" },
				} as TeamToolParamsValue,
				ctx,
			);
			assert.equal(rUser.isError, true);
			assert.match(rUser.text, /root-session required/);
			assert.equal(fs.existsSync(path.join(homeDir, ".pi", "agent", "agents", "gate-probe.md")), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("R11-S1 pin: worker workflow-create (pwn.dwf.ts) REJECTED even with confirm:true — nothing written", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			// Divergent carriers + explicit project scope in BOTH carriers +
			// confirm:true — the root-gate must still block (worker origin).
			const r = await run(
				{
					action: "workflow-create",
					confirm: true,
					scope: "project",
					config: { name: "pwn", script: CLEAN_SCRIPT, scope: "project" },
				} as TeamToolParamsValue,
				ctx,
			);
			assert.equal(r.isError, true);
			assert.match(r.text, /root-session required/);
			// nothing written in either tier
			assert.equal(fs.existsSync(path.join(dir, ".crew", "workflows", "pwn.dwf.ts")), false);
			assert.equal(fs.existsSync(userTierPath("workflows", "pwn.dwf.ts")), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("R11-S1 pin: root workflow-create ALLOWED — project default + user tier via canonical config.scope", async () => {
		delete process.env.PI_CREW_KIND;
		process.env.PI_CREW_DEPTH = "0";
		const { ctx, dir } = tmpCtx();
		try {
			const rProj = await run(
				{ action: "workflow-create", confirm: true, config: { name: "ok-wf", script: CLEAN_SCRIPT } } as TeamToolParamsValue,
				ctx,
			);
			assert.doesNotMatch(rProj.text, /root-session required/);
			assert.notEqual(rProj.isError, true);
			assert.ok(fs.existsSync(path.join(dir, ".crew", "workflows", "ok-wf.dwf.ts")), "project-tier write");
			// user tier via the CANONICAL carrier (config.scope) — handler and gate
			// now read the same key (R11-F1 parity)
			const rUser = await run(
				{
					action: "workflow-create",
					confirm: true,
					config: { name: "ok-user-wf", script: CLEAN_SCRIPT, scope: "user" },
				} as TeamToolParamsValue,
				ctx,
			);
			assert.doesNotMatch(rUser.text, /root-session required/);
			assert.notEqual(rUser.isError, true);
			assert.ok(fs.existsSync(userTierPath("workflows", "ok-user-wf.dwf.ts")), "user-tier write via config.scope");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("R11-F1 pin: divergent-scope create cannot plant a user-tier agent (both carrier directions)", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			// Direction A: top-level "project" + config "user" — the R11-F1 bypass
			// shape. The gate reads the canonical carrier (user) → BLOCKED.
			const rA = await run(
				{
					action: "create",
					resource: "agent",
					scope: "project",
					config: { name: "evil", description: "d", scope: "user", systemPrompt: "p" },
				} as TeamToolParamsValue,
				ctx,
			);
			assert.equal(rA.isError, true);
			assert.match(rA.text, /root-session required/);
			assert.equal(fs.existsSync(userTierPath("agents", "evil.md")), false);
			// Direction B: top-level "user" + config "project" — passes the gate and
			// lands in the PROJECT tier (canonical carrier wins in gate AND handler).
			const rB = await run(
				{
					action: "create",
					resource: "agent",
					scope: "user",
					config: { name: "evil", description: "d", scope: "project", systemPrompt: "p" },
				} as TeamToolParamsValue,
				ctx,
			);
			assert.doesNotMatch(rB.text, /root-session required/);
			assert.notEqual(rB.isError, true);
			assert.ok(fs.existsSync(path.join(dir, ".crew", "agents", "evil.md")), "project-tier write");
			// the user tier stays clean in BOTH directions
			assert.equal(fs.existsSync(userTierPath("agents", "evil.md")), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
