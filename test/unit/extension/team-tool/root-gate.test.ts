/**
 * Wave-3 root-gate tests (R2-M-B1, R3-SEC-1, R5-M-B1, R5-M-B2).
 *
 * Mirrors the round-6 probe (R5-M-B1): a WORKER session is simulated with
 * env PI_CREW_KIND=subagent + PI_CREW_DEPTH=1 (+ redirected HOME so nothing
 * can touch the real user tier even if a gate ever regresses); the root
 * session is the same process env minus those keys.
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
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";

const WORKER_ENV = { PI_CREW_KIND: "subagent", PI_CREW_DEPTH: "1" } as const;
const ROOT_ENV = { PI_CREW_KIND: "", PI_CREW_DEPTH: "0" } as const;

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
});

describe("handleTeamTool root-gate (end-to-end, round-6 probe env)", () => {
	let savedEnv: NodeJS.ProcessEnv;
	let savedHome: string | undefined;
	let homeDir: string;

	beforeEach(() => {
		savedEnv = { ...process.env };
		savedHome = process.env.HOME;
		homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "root-gate-home-"));
		process.env.HOME = homeDir; // redirected HOME — user tier stays hermetic
		process.env.PI_CREW_KIND = "subagent";
		process.env.PI_CREW_DEPTH = "1";
	});

	afterEach(() => {
		process.env.PI_CREW_KIND = savedEnv.PI_CREW_KIND;
		process.env.PI_CREW_DEPTH = savedEnv.PI_CREW_DEPTH;
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
});
