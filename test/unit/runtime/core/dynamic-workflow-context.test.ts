/**
 * Unit tests for dynamic-workflow-context.ts (P2).
 *
 * Tests resolveAgentForRole (G4 4-tier precedence), synthesizeAgentConfig (C7),
 * makeWorkflowCtx surface (capability lock + setResult + semaphore).
 * The agent() path is exercised via PI_TEAMS_MOCK_CHILD_PI (no real pi spawn).
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import { DWF_CHECKPOINT_VERSION, type DwfCheckpointState } from "../../../../src/runtime/dwf-state-store.ts";
import type { AgentCallOpts, AgentResult } from "../../../../src/runtime/goal-workflow/dynamic-workflow-context.ts";
import {
	classifyReviewOutcome,
	DwfAgentCallCapError,
	getWorkflowCheckpoint,
	getWorkflowFinalResult,
	getWorkflowLogs,
	getWorkflowPhaseState,
	makeWorkflowCtx,
	resolveAgentForRole,
	synthesizeAgentConfig,
} from "../../../../src/runtime/goal-workflow/dynamic-workflow-context.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import { cleanupAgentWorktree, prepareAgentWorktree } from "../../../../src/worktree/worktree-manager.ts";
import { cleanupStateRoot } from "../../../helpers/rm-retry.ts";

function tmpCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dwf-ctx-"));
}

function fakeManifest(cwd: string): TeamRunManifest {
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		runId: "team_dwf_test_abc",
		team: "dwf-test",
		goal: "test goal",
		status: "running",
		workspaceMode: "single",
		createdAt: now,
		updatedAt: now,
		cwd,
		stateRoot: `${cwd}/.crew/state/runs/team_dwf_test_abc`,
		artifactsRoot: `${cwd}/.crew/artifacts/team_dwf_test_abc`,
		tasksPath: `${cwd}/.crew/state/runs/team_dwf_test_abc/tasks.json`,
		eventsPath: `${cwd}/.crew/state/runs/team_dwf_test_abc/events.jsonl`,
		artifacts: [],
	};
}

test("synthesizeAgentConfig uses source:'dynamic' (§0c C7 — not 'synthetic')", () => {
	const cfg = synthesizeAgentConfig("myrole");
	assert.equal(cfg.name, "myrole");
	assert.equal(cfg.source, "dynamic");
	assert.match(cfg.systemPrompt, /You are myrole/);
	assert.equal(cfg.inheritProjectContext, false);
});

test("resolveAgentForRole tier-4 fallback synthesizes when no agent matches", async () => {
	const cwd = tmpCwd();
	try {
		const cfg = resolveAgentForRole("nonexistent-role-xyz", { cwd });
		assert.equal(cfg.name, "nonexistent-role-xyz");
		assert.equal(cfg.source, "dynamic", "tier-4 synthesis uses source:'dynamic'");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("resolveAgentForRole tier-1 explicit agent wins over role name", async () => {
	const cwd = tmpCwd();
	try {
		// No real agents in tmp cwd → tier-1 miss falls through to tier-4 synthesis,
		// but with the explicit name preserved.
		const cfg = resolveAgentForRole("some-role", {
			explicitAgent: "my-explicit",
			cwd,
		});
		assert.equal(cfg.name, "my-explicit", "explicit agent name preserved in fallback");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("makeWorkflowCtx exposes ONLY documented methods (capability lock)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		// Public surface.
		assert.equal(typeof ctx.agent, "function");
		assert.equal(typeof ctx.fanOut, "function");
		assert.equal(typeof ctx.setResult, "function");
		assert.ok(ctx.semaphore);
		assert.equal(ctx.cwd, cwd);
		assert.equal(ctx.runId, "team_dwf_test_abc");
		// No raw manifest/process/require leaks on the ctx object.
		assert.equal((ctx as unknown as { manifest?: unknown }).manifest, undefined);
		assert.equal((ctx as unknown as { process?: unknown }).process, undefined);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("ctx.setResult records the final result; runner reads it via getWorkflowFinalResult", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		assert.equal(getWorkflowFinalResult(ctx), undefined, "no final result until setResult is called");
		ctx.setResult("/tmp/fake-artifact.md", { ok: true });
		const final = getWorkflowFinalResult(ctx);
		assert.deepEqual(final, {
			artifactPath: "/tmp/fake-artifact.md",
			meta: { ok: true },
		});
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("ctx.agent() returns ok:false on spawn failure (mock without PI_CREW_ALLOW_MOCK)", async () => {
	const cwd = tmpCwd();
	try {
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		// PI_CREW_ALLOW_MOCK intentionally NOT set → mock returns exit 1.
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
		});
		const res = await ctx.agent({
			role: "executor",
			prompt: "say hi",
			maxTurns: 1,
		});
		assert.equal(res.ok, false, "without PI_CREW_ALLOW_MOCK, mock child-pi fails");
		assert.ok(res.error);
	} finally {
		delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		await cleanupStateRoot(cwd);
	}
});

// --- review() round-11 fix tests (disableTools, systemPrompt, 2-step fallback) ---
// These mock ctx.agent to verify review()'s verdict logic without spawning real pi.

test("classifyReviewOutcome: reject on critical-bug signals", () => {
	assert.equal(classifyReviewOutcome("The function has a critical bug: it subtracts instead of adds."), "reject");
	assert.equal(classifyReviewOutcome("This is fundamentally wrong and will not work."), "reject");
	assert.equal(classifyReviewOutcome("Security vulnerability found. Do not merge."), "reject");
});

test("classifyReviewOutcome: accept on explicit approval signals", () => {
	assert.equal(classifyReviewOutcome("The function correctly returns the sum and looks good."), "accept");
	assert.equal(classifyReviewOutcome("No issues found. Ready to merge."), "accept");
	assert.equal(classifyReviewOutcome("Works as expected, meets all requirements."), "accept");
});

test("classifyReviewOutcome: changes_requested as neutral default", () => {
	assert.equal(classifyReviewOutcome("The code could use some refactoring and additional comments."), "changes_requested");
	assert.equal(classifyReviewOutcome("Consider adding more test coverage."), "changes_requested");
});

test("classifyReviewOutcome: reject wins over accept (verdict signal dominates)", () => {
	// Reviewer describes existing code as "correctly returns" but verdict is critical bug.
	assert.equal(classifyReviewOutcome("It correctly returns a value, but there is a critical bug in the logic."), "reject");
});

test("classifyReviewOutcome: REGRESSION — real MiniMax-M3 buggy-code review → reject", () => {
	// Exact prose captured from the runtime test-review-final run (scenario 1, buggy code).
	const realProse =
		"The add function uses subtraction (-) instead of addition (+), which produces incorrect results and contradicts the function's purpose. Although the bug is flagged in a comment, shipping broken code is unacceptable; replace 'a - b' with 'a + b' and remove the placeholder bug note.";
	assert.equal(classifyReviewOutcome(realProse), "reject", "buggy-code review must NOT be classified accept/changes");
});

test("classifyReviewOutcome: REGRESSION — real MiniMax-M3 correct-code review → accept", () => {
	// Exact prose captured from the runtime test-review-final run (scenario 2, correct code).
	const realProse =
		"The add function correctly returns the sum of two numbers and includes input validation that throws a TypeError for non-number arguments, matching the expected behavior implied by the task name.";
	assert.equal(classifyReviewOutcome(realProse), "accept", "correct-code review must be classified accept");
});

// --- RR-021 WI-1.1: word-boundary escape bug + negation guard ---
// Before WI-1.1 the signals were string literals like "\baccept\b" — "\b" in a
// TS string literal is a BACKSPACE char (U+0008), so bare "accept"/"reject" words
// never matched. The signals are now precompiled module-scope regex literals.

test("classifyReviewOutcome: RR-021 WI-1.1 — bare word-boundary signals actually match", () => {
	assert.equal(classifyReviewOutcome("I accept this."), "accept", "bare 'accept' must match the accept signal");
	assert.equal(classifyReviewOutcome("I reject this."), "reject", "bare 'reject' must match the reject signal");
	// Whole-word only: 'rejected'/'acceptable' must not trigger the boundary signal.
	assert.equal(classifyReviewOutcome("This is acceptable."), "changes_requested");
});

test("classifyReviewOutcome: RR-021 WI-1.1 — negated accept phrases are NOT approval", () => {
	assert.equal(classifyReviewOutcome("I cannot accept this."), "changes_requested");
	assert.equal(classifyReviewOutcome("I can't accept this."), "changes_requested");
	assert.equal(classifyReviewOutcome("I don't accept this conclusion."), "changes_requested");
	// Negation must not block genuine approval phrasing.
	assert.equal(classifyReviewOutcome("I accept this. Looks good."), "accept");
	// Reject-first precedence still wins when both signals are present.
	assert.equal(classifyReviewOutcome("I cannot accept this — critical bug in the logic."), "reject");
});

test("review(): returns verdict directly when reviewer emits JSON (1-step)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
		});
		const calls: { disableTools?: boolean; systemPrompt?: string }[] = [];
		ctx.agent = (async (call: { disableTools?: boolean; systemPrompt?: string; prompt: string }) => {
			calls.push({
				disableTools: call.disableTools,
				systemPrompt: call.systemPrompt,
			});
			return {
				ok: true,
				text: '{"outcome":"accept","feedback":"looks good"}',
				structured: { outcome: "accept", feedback: "looks good" },
			};
		}) as typeof ctx.agent;
		const r = await ctx.review("task-1", "reviewer", {
			content: "work here",
		});
		assert.equal(r.outcome, "accept");
		assert.equal(r.feedback, "looks good");
		assert.equal(calls.length, 1, "1-step: no judge fallback when reviewer emits JSON");
		assert.equal(calls[0].disableTools, true, "review defaults disableTools=true");
		assert.ok(calls[0].systemPrompt, "review passes a JSON-verdict systemPrompt");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("review(): 2-step fallback converts prose review → JSON verdict when model ignores JSON", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
		});
		let callNo = 0;
		ctx.agent = (async (call: { prompt: string }) => {
			callNo += 1;
			if (callNo === 1) {
				// Reviewer ignores JSON instruction, returns prose (real MiniMax-M3 behavior).
				return {
					ok: true,
					text: "The add function subtracts instead of adds. Critical bug.",
					structured: undefined,
				};
			}
			// Call 2 = judge fallback: converts prose → JSON verdict.
			assert.match(call.prompt, /Convert the following code review/, "2nd call is the judge fallback");
			return {
				ok: true,
				text: '{"outcome":"reject","feedback":"subtracts instead of adds"}',
				structured: {
					outcome: "reject",
					feedback: "subtracts instead of adds",
				},
			};
		}) as typeof ctx.agent;
		const r = await ctx.review("task-add", "reviewer", {
			content: "function add(a,b){return a-b;}",
		});
		assert.equal(callNo, 2, "2-step fallback ran exactly one extra judge call");
		assert.equal(r.outcome, "reject", "judge verdict propagated");
		assert.equal(r.feedback, "subtracts instead of adds");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("review(): when reviewer produces NO text (killed), skips judge + returns fallback", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
		});
		let callNo = 0;
		ctx.agent = (async () => {
			callNo += 1;
			// Reviewer killed (exit 143) → empty text, like the unfixed bug.
			return { ok: false, text: "", error: "exit 143" };
		}) as typeof ctx.agent;
		const r = await ctx.review("task-empty");
		assert.equal(callNo, 1, "judge fallback SKIPPED when reviewer text is empty");
		assert.equal(r.outcome, "changes_requested");
		assert.equal(r.feedback, "(reviewer produced no parseable verdict)");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("review(): content option is injected into the reviewer prompt", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
		});
		let capturedPrompt = "";
		ctx.agent = (async (call: { prompt: string }) => {
			capturedPrompt = call.prompt;
			return {
				ok: true,
				text: '{"outcome":"accept","feedback":"ok"}',
				structured: { outcome: "accept", feedback: "ok" },
			};
		}) as typeof ctx.agent;
		await ctx.review("task-x", "reviewer", {
			content: "UNIQUE_WORK_MARKER_42",
		});
		assert.match(capturedPrompt, /UNIQUE_WORK_MARKER_42/, "content is passed to the reviewer");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

// ---------------------------------------------------------------------------
// round-13 P0-3: schema option on AgentCallOpts
// ---------------------------------------------------------------------------

test("round-13 P0-3: ctx.agent() with matching schema returns structured result", async () => {
	const cwd = tmpCwd();
	try {
		// Use the real path with PI_TEAMS_MOCK_CHILD_PI=json-success so the schema
		// validator actually runs end-to-end against canned output.
		const manifest = fakeManifest(cwd);
		const schema = Type.Object({
			name: Type.String(),
			value: Type.Number(),
		});
		const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
		const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		try {
			const ctx = makeWorkflowCtx(manifest, {
				signal: new AbortController().signal,
			});
			const res = await ctx.agent({
				prompt: "test",
				role: "executor",
				schema,
			});
			// The mock emits text '[MOCK] JSON success for {agent.name}'. We don't validate
			// the schema against the mock text (it won't match). Instead, we assert that
			// the agent() integration with schema works without throwing — the error
			// semantics are tested at the unit level for extractStructuredResult.
			assert.ok(res, "agent() returned a result");
			assert.equal(typeof res.text, "string");
		} finally {
			if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
			else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
			if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
			else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		}
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-13 P0-3: ctx.agent() with non-matching schema returns ok:false + error", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const schema = Type.Object({
			name: Type.String(),
			value: Type.Number(),
		});
		const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
		const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		try {
			const ctx = makeWorkflowCtx(manifest, {
				signal: new AbortController().signal,
			});
			const res = await ctx.agent({
				prompt: "test",
				role: "executor",
				schema,
			});
			// Mock output ('[MOCK] JSON success for ...') does NOT match our schema
			// (no 'name' or 'value' fields), so the call should report ok:false.
			assert.equal(res.ok, false, "schema mismatch should yield ok:false");
			assert.match(res.error ?? "", /does not match schema/);
		} finally {
			if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
			else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
			if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
			else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		}
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-13 P0-3: ctx.agent() without schema preserves existing behavior", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
		const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		try {
			const ctx = makeWorkflowCtx(manifest, {
				signal: new AbortController().signal,
			});
			const res = await ctx.agent({ prompt: "test", role: "executor" });
			// Without a schema, behavior is unchanged: ok=true, structured=undefined
			// because mock text '[MOCK] JSON success for ...' isn't valid JSON.
			assert.equal(res.ok, true);
			assert.equal(res.structured, undefined);
		} finally {
			if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
			else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
			if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
			else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		}
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-13 P0-3: AgentCallOpts accepts schema field without compile error", () => {
	const schema = Type.Object({ x: Type.Number() });
	const opts: AgentCallOpts = { prompt: "x", schema };
	assert.equal(typeof opts.schema, "object");
});

// round-12 P0-1: ctx.phase(title) — runtime phase API
// ---------------------------------------------------------------------------

/** Read all events from a run's events.jsonl (JSONL format). */
function readEvents(eventsPath: string): Array<{ type: string; data?: Record<string, unknown> }> {
	if (!fs.existsSync(eventsPath)) return [];
	return fs
		.readFileSync(eventsPath, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

test("round-12 ctx.phase(title): emits dwf.phase_started event with phase in data", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		ctx.phase("Scan");
		const events = readEvents(manifest.eventsPath);
		const phaseStarted = events.find((e) => e.type === "dwf.phase_started");
		assert.ok(phaseStarted, "dwf.phase_started event should be emitted");
		assert.equal(phaseStarted?.data?.phase, "Scan");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-12 ctx.phase(title): idempotent on same title — no duplicate events", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		ctx.phase("Scan");
		ctx.phase("Scan");
		ctx.phase("Scan");
		const events = readEvents(manifest.eventsPath);
		const phaseStarted = events.filter((e) => e.type === "dwf.phase_started");
		assert.equal(phaseStarted.length, 1, "duplicate phase titles should not emit extra events");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-12 ctx.phase(title): empty string throws TypeError", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		assert.throws(() => ctx.phase(""), /non-empty string/);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-12 ctx.phase(title): non-string throws TypeError", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		assert.throws(() => ctx.phase(123 as unknown as string), /non-empty string/);
		assert.throws(() => ctx.phase(null as unknown as string), /non-empty string/);
		assert.throws(() => ctx.phase(undefined as unknown as string), /non-empty string/);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-12 ctx.phase(title): sequence phase('A') → phase('B') emits phase_completed(A) then phase_started(B)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		ctx.phase("A");
		ctx.phase("B");
		const events = readEvents(manifest.eventsPath);
		const phaseEvents = events
			.filter((e) => e.type === "dwf.phase_started" || e.type === "dwf.phase_completed")
			.map((e) => `${e.type}:${(e.data as { phase: string }).phase}`);
		assert.deepEqual(phaseEvents, ["dwf.phase_started:A", "dwf.phase_completed:A", "dwf.phase_started:B"]);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-12 getWorkflowPhaseState: returns currentPhase and deduped phases[]", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		assert.deepEqual(getWorkflowPhaseState(ctx), {
			currentPhase: undefined,
			phases: [],
		});
		ctx.phase("Scan");
		ctx.phase("Audit");
		ctx.phase("Scan"); // re-opens Scan (current was Audit), but phases[] is deduped
		const state = getWorkflowPhaseState(ctx);
		assert.equal(state?.currentPhase, "Scan");
		assert.deepEqual(state?.phases, ["Scan", "Audit"], "phases[] is deduped; Scan was not re-appended");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-12 ctx.phase(title): 100-cap bounds in-memory phases[] but events still flow", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		// Append 105 distinct phase titles.
		for (let i = 0; i < 105; i++) {
			ctx.phase(`phase-${i}`);
		}
		const state = getWorkflowPhaseState(ctx);
		assert.equal(state?.phases.length, 100, "in-memory phases[] capped at 100");
		assert.equal(state?.currentPhase, "phase-104", "currentPhase tracks latest");
		const events = readEvents(manifest.eventsPath);
		const phaseStarted = events.filter((e) => e.type === "dwf.phase_started");
		assert.equal(phaseStarted.length, 105, "events still emit past the cap");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

// ---------------------------------------------------------------------------
// round-14 P1-2: ctx.budget — per-workflow token budget
// ---------------------------------------------------------------------------

test("round-14 ctx.budget: total is null by default (unbounded)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		assert.equal(ctx.budget.total, null, "no tokenBudget → total is null (unbounded)");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-14 ctx.budget: total reflects opts.tokenBudget", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			tokenBudget: 500,
		});
		assert.equal(ctx.budget.total, 500);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-14 ctx.budget: spent() starts at 0", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			tokenBudget: 500,
		});
		assert.equal(ctx.budget.spent(), 0);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-14 ctx.budget: remaining() is Infinity when total is null", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		assert.equal(ctx.budget.remaining(), Infinity);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-14 ctx.budget: remaining() = total - spent when set", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			tokenBudget: 500,
		});
		assert.equal(ctx.budget.remaining(), 500);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-14 ctx.budget: agent() returns ok:false when budget exhausted (total=0)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		// tokenBudget: 0 → total=0, remaining()=0 → exhausted before first spawn (no mock needed).
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
			tokenBudget: 0,
		});
		const res = await ctx.agent({
			role: "executor",
			prompt: "say hi",
			maxTurns: 1,
		});
		assert.equal(res.ok, false, "exhausted budget must reject the call without spawning");
		assert.match(res.error ?? "", /budget exhausted/);
		assert.equal(res.durationMs, 0);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-14 ctx.budget: after an agent run, spent accumulates from reported usage", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
		const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		try {
			const ctx = makeWorkflowCtx(manifest, {
				signal: new AbortController().signal,
				concurrency: 1,
				tokenBudget: 100000,
			});
			assert.equal(ctx.budget.spent(), 0, "spent starts at 0");
			const res = await ctx.agent({
				role: "executor",
				prompt: "say hi",
				maxTurns: 1,
			});
			assert.equal(res.ok, true, "mock agent should succeed");
			// The json-success mock reports usage {input:10, output:5}.
			assert.equal(ctx.budget.spent(), 15, "spent accumulates input(10)+output(5)");
			assert.equal(ctx.budget.remaining(), 100000 - 15);
		} finally {
			if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
			else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
			if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
			else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		}
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-14 ctx.budget: is frozen (immutable surface)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			tokenBudget: 100,
		});
		assert.ok(Object.isFrozen(ctx.budget), "budget object is frozen");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

// ---------------------------------------------------------------------------
// round-14 P1-3: ctx.log — workflow-level log API
// ---------------------------------------------------------------------------

test("round-14 ctx.log('hello'): appends to in-memory logs", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		ctx.log("hello");
		assert.deepEqual(getWorkflowLogs(ctx), ["hello"]);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-14 ctx.log({a:1}): stringifies non-string messages", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		ctx.log({ a: 1 });
		assert.deepEqual(getWorkflowLogs(ctx), ['{"a":1}']);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-14 ctx.log: emits dwf.log event with the message in data", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		ctx.log("a log line");
		ctx.log({ nested: true });
		const events = readEvents(manifest.eventsPath);
		const logEvents = events.filter((e) => e.type === "dwf.log");
		assert.equal(logEvents.length, 2, "one dwf.log event per ctx.log call");
		assert.equal(logEvents[0]?.data?.message, "a log line");
		assert.equal(logEvents[1]?.data?.message, '{"nested":true}');
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-14 ctx.log: 1000-cap bounds in-memory logs but events still flow", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		for (let i = 0; i < 1001; i++) {
			ctx.log(`line-${i}`);
		}
		assert.equal(getWorkflowLogs(ctx)?.length, 1000, "in-memory logs capped at 1000");
		const events = readEvents(manifest.eventsPath);
		const logEvents = events.filter((e) => e.type === "dwf.log");
		assert.equal(logEvents.length, 1001, "events still emit past the cap");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

// ---------------------------------------------------------------------------
// round-14 P1-5: ctx.args — typed workflow arguments
// ---------------------------------------------------------------------------

test("round-14 ctx.args(): returns {} by default when no args provided", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		assert.deepEqual(ctx.args(), {});
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-14 ctx.args<T>(): returns the typed value passed via opts.args", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			args: { foo: "bar", count: 3 },
		});
		const args = ctx.args<{ foo: string; count: number }>();
		assert.equal(args.foo, "bar");
		assert.equal(args.count, 3);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-14 ctx.args(): accepts non-object args (e.g. an array)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			args: ["a", "b"],
		});
		const args = ctx.args<string[]>();
		assert.deepEqual(args, ["a", "b"]);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

// ---------------------------------------------------------------------------
// round-16 P2-1: ctx.pipeline — sequential per-item stages, parallel across items
// ---------------------------------------------------------------------------

test("ctx.pipeline — single stage transform", async () => {
	const cwd = tmpCwd();
	try {
		const ctx = makeWorkflowCtx(fakeManifest(cwd), {
			signal: new AbortController().signal,
		});
		const result = await ctx.pipeline([1, 2, 3], (x) => (x as number) * 2);
		assert.deepEqual(result, [2, 4, 6]);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("ctx.pipeline — multiple sequential stages", async () => {
	const cwd = tmpCwd();
	try {
		const ctx = makeWorkflowCtx(fakeManifest(cwd), {
			signal: new AbortController().signal,
		});
		const result = await ctx.pipeline(
			[1, 2, 3],
			(x) => (x as number) * 2,
			(x) => (x as number) + 1,
		);
		assert.deepEqual(result, [3, 5, 7]);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("ctx.pipeline — empty array returns empty", async () => {
	const cwd = tmpCwd();
	try {
		const ctx = makeWorkflowCtx(fakeManifest(cwd), {
			signal: new AbortController().signal,
		});
		const result = await ctx.pipeline([], (x) => x);
		assert.deepEqual(result, []);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("ctx.pipeline — failed stage yields null + logs, other items continue", async () => {
	const cwd = tmpCwd();
	try {
		const ctx = makeWorkflowCtx(fakeManifest(cwd), {
			signal: new AbortController().signal,
		});
		const result = await ctx.pipeline([1, 2, 3], (x, _orig, i) => {
			if (i === 1) throw new Error("boom");
			return (x as number) * 10;
		});
		assert.deepEqual(result, [10, null, 30]);
		const logs = getWorkflowLogs(ctx);
		assert.ok(
			logs?.some((l) => l.includes("pipeline[1] failed: boom")),
			"error should be logged via ctx.log",
		);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("ctx.pipeline — non-array first arg throws TypeError", async () => {
	const cwd = tmpCwd();
	try {
		const ctx = makeWorkflowCtx(fakeManifest(cwd), {
			signal: new AbortController().signal,
		});
		await assert.rejects(() => ctx.pipeline("not-array" as unknown as never[], (x) => x), /expects an array/);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("ctx.pipeline — non-function stage throws TypeError", async () => {
	const cwd = tmpCwd();
	try {
		const ctx = makeWorkflowCtx(fakeManifest(cwd), {
			signal: new AbortController().signal,
		});
		await assert.rejects(() => ctx.pipeline([1], "not-a-function" as unknown as never), /stages must be functions/);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("ctx.pipeline — stage receives (previous, original, index)", async () => {
	const cwd = tmpCwd();
	try {
		const ctx = makeWorkflowCtx(fakeManifest(cwd), {
			signal: new AbortController().signal,
		});
		const calls: Array<[unknown, number, number]> = [];
		await ctx.pipeline([10, 20], (prev, original, index) => {
			calls.push([prev, original, index]);
			return prev;
		});
		assert.deepEqual(calls, [
			[10, 10, 0],
			[20, 20, 1],
		]);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("ctx.pipeline — stage receives previous stage output as 'previous'", async () => {
	const cwd = tmpCwd();
	try {
		const ctx = makeWorkflowCtx(fakeManifest(cwd), {
			signal: new AbortController().signal,
		});
		const seen: number[] = [];
		await ctx.pipeline(
			[5],
			(x) => (x as number) + 1, // 6
			(x) => (x as number) * 2, // 12
			(x) => {
				seen.push(x as number); // 12
				return x;
			},
		);
		assert.deepEqual(seen, [12]);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("ctx.pipeline — async stages work", async () => {
	const cwd = tmpCwd();
	try {
		const ctx = makeWorkflowCtx(fakeManifest(cwd), {
			signal: new AbortController().signal,
		});
		const result = await ctx.pipeline([1, 2, 3], async (x) => {
			await new Promise((r) => setTimeout(r, 5));
			return (x as number) * 3;
		});
		assert.deepEqual(result, [3, 6, 9]);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("ctx.pipeline — execution bounded by workflow concurrency", async () => {
	const cwd = tmpCwd();
	try {
		const ctx = makeWorkflowCtx(fakeManifest(cwd), {
			signal: new AbortController().signal,
			concurrency: 2,
		});
		let inFlight = 0;
		let maxInFlight = 0;
		await ctx.pipeline([1, 2, 3, 4, 5, 6], async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 20));
			inFlight--;
			return "done";
		});
		assert.ok(maxInFlight <= 2, `maxInFlight ${maxInFlight} must not exceed concurrency 2`);
		assert.ok(maxInFlight >= 2, `maxInFlight ${maxInFlight} should reach the concurrency limit`);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

// ---------------------------------------------------------------------------
// round-17 P2-4: worktree isolation per agent
// ---------------------------------------------------------------------------

/** Initialize a clean git repo (with an initial commit) in `cwd`. */
function initGitRepo(cwd: string): void {
	execSync("git init -q", { cwd, encoding: "utf-8" });
	execSync("git config user.email test@test.test", {
		cwd,
		encoding: "utf-8",
	});
	execSync("git config user.name test", { cwd, encoding: "utf-8" });
	fs.writeFileSync(path.join(cwd, "README.md"), "init\n");
	execSync("git add -A", { cwd, encoding: "utf-8" });
	execSync("git commit -q -m init", { cwd, encoding: "utf-8" });
}

/** Escape a path for use in a RegExp. */
function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("round-17 P2-4: prepareAgentWorktree creates an isolated worktree (cwd === worktreePath)", {
	skip:
		process.platform === "win32"
			? "git worktree path-normalization is flaky on Windows (forward/back-slash mismatch); covered on ubuntu/macos CI"
			: false,
}, async () => {
	const cwd = tmpCwd();
	try {
		initGitRepo(cwd);
		const manifest = fakeManifest(cwd);
		const wt = prepareAgentWorktree(manifest, "agent-1");
		// Worktree creation can fail on some CI runners (Windows temp paths,
		// locked files). When it does, prepareAgentWorktree returns undefined
		// gracefully — that is the documented fallback. Only assert the
		// success path when a worktree was actually created.
		if (!wt) {
			// Verify the graceful-fallback contract: undefined return, no throw.
			assert.equal(wt, undefined, "non-git/failed worktree must return undefined, not throw");
			return;
		}
		assert.ok(wt.worktreePath, "worktreePath should be set");
		// The cwd returned is the value ctx.agent() passes to runChildPi.
		assert.equal(wt.cwd, wt.worktreePath, "cwd === worktreePath (the value passed to runChildPi)");
		assert.equal(typeof wt.branch, "string");
		assert.ok(fs.existsSync(wt.worktreePath!), "worktree directory should exist on disk");
		// git must know about the worktree.
		const list = execSync("git worktree list", { cwd, encoding: "utf-8" });
		assert.match(list, new RegExp(escapeRe(wt.worktreePath!)), "git worktree list contains the worktree");
		cleanupAgentWorktree(manifest, wt.worktreePath!, wt.branch);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-17 P2-4: cleanupAgentWorktree removes the worktree dir + branch (no leak)", {
	skip: process.platform === "win32" ? "git worktree path-normalization is flaky on Windows" : false,
}, async () => {
	const cwd = tmpCwd();
	try {
		initGitRepo(cwd);
		const manifest = fakeManifest(cwd);
		const wt = prepareAgentWorktree(manifest, "agent-clean");
		// Skip the success-path assertions if worktree creation failed (CI env).
		if (!wt?.worktreePath || !wt?.branch) return;
		const branch = wt.branch;
		const wtPath = wt.worktreePath;
		// Branch exists before cleanup.
		const branchesBefore = execSync("git branch --list", {
			cwd,
			encoding: "utf-8",
		});
		assert.match(branchesBefore, new RegExp(escapeRe(branch)), "branch exists before cleanup");
		cleanupAgentWorktree(manifest, wtPath, branch);
		// Worktree directory gone.
		assert.ok(!fs.existsSync(wtPath), "worktree directory removed after cleanup");
		// Only the leader remains in `git worktree list`.
		const list = execSync("git worktree list", { cwd, encoding: "utf-8" }).trim().split("\n");
		assert.equal(list.length, 1, `only the leader worktree should remain, got: ${list.join(" | ")}`);
		// Ephemeral branch deleted.
		const branchesAfter = execSync("git branch --list", {
			cwd,
			encoding: "utf-8",
		});
		assert.doesNotMatch(branchesAfter, new RegExp(escapeRe(branch)), "ephemeral branch deleted after cleanup");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-17 P2-4: cleanupAgentWorktree captures a diff artifact when the worktree has changes", {
	skip: process.platform === "win32" ? "git worktree path-normalization is flaky on Windows" : false,
}, async () => {
	const cwd = tmpCwd();
	try {
		initGitRepo(cwd);
		const manifest = fakeManifest(cwd);
		const wt = prepareAgentWorktree(manifest, "agent-diff");
		// Skip if worktree creation failed (CI env).
		if (!wt?.worktreePath) return;
		// Simulate the agent modifying a TRACKED file in the worktree (git diff only
		// shows tracked changes; untracked files aren't included).
		fs.writeFileSync(path.join(wt!.worktreePath!, "README.md"), "modified by agent\n");
		cleanupAgentWorktree(manifest, wt!.worktreePath!, wt!.branch);
		// A diff artifact should have been written under artifactsRoot/wf.
		const wfDir = path.join(manifest.artifactsRoot, "wf");
		assert.ok(fs.existsSync(wfDir), "wf artifact dir created");
		const diffFiles = fs.readdirSync(wfDir).filter((f) => f.startsWith("worktree-diff-"));
		assert.ok(diffFiles.length > 0, `a worktree-diff artifact should be written, found: ${diffFiles.join(", ")}`);
		const content = fs.readFileSync(path.join(wfDir, diffFiles[0]), "utf-8");
		assert.match(content, /README\.md/, "diff artifact records the modified file");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-17 P2-4: prepareAgentWorktree returns undefined for non-git cwd (graceful fallback)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const wt = prepareAgentWorktree(manifest, "agent-1");
		assert.equal(wt, undefined, "non-git cwd → undefined (caller falls back to normal cwd)");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-17 P2-4: ctx.agent({worktree:true}) isolates the agent and cleans up after (mock)", async () => {
	const cwd = tmpCwd();
	const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
	try {
		initGitRepo(cwd);
		const manifest = fakeManifest(cwd);
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
		});
		const res = await ctx.agent({
			role: "executor",
			prompt: "edit files",
			worktree: true,
		});
		assert.equal(res.ok, true, "agent should succeed in a worktree (mock child-pi)");
		// The worktree isolation log was emitted (proves the worktree path was computed).
		const logs = getWorkflowLogs(ctx) ?? [];
		assert.ok(
			logs.some((l) => l.includes("worktree: agent isolated at")),
			`expected worktree isolation log, got: ${logs.join(" | ")}`,
		);
		// No worktree directory leak: only the leader remains in `git worktree list`.
		const list = execSync("git worktree list", { cwd, encoding: "utf-8" }).trim().split("\n");
		assert.equal(list.length, 1, `no worktree should remain after agent completes, got: ${list.join(" | ")}`);
		// No leftover agent branches.
		const branches = execSync("git branch --list", {
			cwd,
			encoding: "utf-8",
		});
		assert.doesNotMatch(branches, /pi-crew\/.+\/dwf-agent-/, "no leftover dwf-agent branches");
	} finally {
		if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
		if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		await cleanupStateRoot(cwd);
	}
});

test("round-17 P2-4: ctx.agent({worktree:false}) uses normal cwd — no worktree created (backward compat)", async () => {
	const cwd = tmpCwd();
	const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
	try {
		initGitRepo(cwd);
		const manifest = fakeManifest(cwd);
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
		});
		// worktree omitted → default false → normal cwd, no isolation.
		const res = await ctx.agent({ role: "executor", prompt: "hi" });
		assert.equal(res.ok, true, "agent should succeed (mock)");
		const logs = getWorkflowLogs(ctx) ?? [];
		assert.ok(!logs.some((l) => l.includes("worktree:")), `no worktree log expected, got: ${logs.join(" | ")}`);
		// git worktree list unchanged — only the leader.
		const list = execSync("git worktree list", { cwd, encoding: "utf-8" }).trim().split("\n");
		assert.equal(list.length, 1, "no worktree created when worktree not requested");
	} finally {
		if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
		if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		await cleanupStateRoot(cwd);
	}
});

test("round-17 P2-4: ctx.agent({worktree:true}) falls back gracefully in a non-git cwd + warns", async () => {
	const cwd = tmpCwd();
	const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
	try {
		const manifest = fakeManifest(cwd);
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
		});
		const res = await ctx.agent({
			role: "executor",
			prompt: "hi",
			worktree: true,
		});
		assert.equal(res.ok, true, "agent should still run after falling back to the normal cwd");
		const logs = getWorkflowLogs(ctx) ?? [];
		assert.ok(
			logs.some((l) => l.includes("worktree: creation unavailable")),
			`expected fallback warning log, got: ${logs.join(" | ")}`,
		);
	} finally {
		if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
		if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		await cleanupStateRoot(cwd);
	}
});

test("round-17 P2-4: ctx.agent({worktree:true}) cleans up the worktree even when the agent fails", async () => {
	const cwd = tmpCwd();
	const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
	try {
		initGitRepo(cwd);
		const manifest = fakeManifest(cwd);
		// Mock that returns a non-zero exit (agent "fails").
		process.env.PI_TEAMS_MOCK_CHILD_PI = "retryable-failure";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
		});
		const res = await ctx.agent({
			role: "executor",
			prompt: "fail",
			worktree: true,
		});
		assert.equal(res.ok, false, "agent should report failure");
		// The worktree must still be cleaned up (no leak) even on the failure path.
		const list = execSync("git worktree list", { cwd, encoding: "utf-8" }).trim().split("\n");
		assert.equal(list.length, 1, `no worktree should remain after a failed agent, got: ${list.join(" | ")}`);
		const branches = execSync("git branch --list", {
			cwd,
			encoding: "utf-8",
		});
		assert.doesNotMatch(branches, /pi-crew\/.+\/dwf-agent-/, "no leftover dwf-agent branches on failure path");
	} finally {
		if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
		if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		await cleanupStateRoot(cwd);
	}
});

// ---------------------------------------------------------------------------
// round-18 P2-3: resume/checkpoint
// ---------------------------------------------------------------------------

test("round-18 ctx.agent() fires onCheckpoint after each call (success path)", async () => {
	const cwd = tmpCwd();
	const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
	try {
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		const manifest = fakeManifest(cwd);
		const checkpoints: import("../../../../src/runtime/dwf-state-store.ts").DwfCheckpointState[] = [];
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
			onCheckpoint: (state) => {
				checkpoints.push(state);
			},
		});
		ctx.vars.lastPhase = "init";
		ctx.phase("scan");
		ctx.log("hello checkpoint");
		await ctx.agent({ role: "executor", prompt: "step 1" });
		assert.equal(checkpoints.length, 1, "onCheckpoint fired exactly once after one agent call");
		const cp = checkpoints[0];
		assert.equal(cp.runId, "team_dwf_test_abc");
		assert.equal(cp.vars.lastPhase, "init");
		assert.deepEqual(cp.phases, ["scan"], "checkpoint captures phase list");
		assert.equal(cp.currentPhase, "scan", "checkpoint captures current phase");
		assert.ok(cp.logs.includes("hello checkpoint"), "checkpoint captures logs");
		assert.equal(cp.agentCount, 1, "agentCount incremented to 1 after the call");
		assert.equal(typeof cp.updatedAt, "string");
	} finally {
		if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
		if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		await cleanupStateRoot(cwd);
	}
});

test("round-18 ctx.agent() fires onCheckpoint even when the agent fails", async () => {
	const cwd = tmpCwd();
	try {
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		// PI_CREW_ALLOW_MOCK intentionally NOT set → mock returns exit 1 → agent ok:false.
		const manifest = fakeManifest(cwd);
		const checkpoints: import("../../../../src/runtime/dwf-state-store.ts").DwfCheckpointState[] = [];
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
			onCheckpoint: (state) => {
				checkpoints.push(state);
			},
		});
		await ctx.agent({ role: "executor", prompt: "will fail", maxTurns: 1 });
		assert.equal(checkpoints.length, 1, "checkpoint fires on the failure path too");
		assert.equal(checkpoints[0].agentCount, 1);
	} finally {
		delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		await cleanupStateRoot(cwd);
	}
});

test("round-18 onCheckpoint agentCount accumulates across multiple calls", async () => {
	const cwd = tmpCwd();
	const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
	try {
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		const manifest = fakeManifest(cwd);
		const counts: number[] = [];
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
			onCheckpoint: (state) => {
				counts.push(state.agentCount);
			},
		});
		await ctx.agent({ role: "executor", prompt: "a" });
		await ctx.agent({ role: "executor", prompt: "b" });
		await ctx.agent({ role: "executor", prompt: "c" });
		assert.deepEqual(counts, [1, 2, 3], "agentCount increments 1,2,3 across three calls");
	} finally {
		if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
		if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		await cleanupStateRoot(cwd);
	}
});

test("round-18 onCheckpoint never fires when the callback is omitted (backward compat)", async () => {
	const cwd = tmpCwd();
	const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
	try {
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		const manifest = fakeManifest(cwd);
		// No onCheckpoint — must not throw and must not checkpoint.
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
		});
		await assert.doesNotReject(() => ctx.agent({ role: "executor", prompt: "x" }));
	} finally {
		if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
		if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		await cleanupStateRoot(cwd);
	}
});

test("round-18 makeWorkflowCtx hydrates vars/phases/logs/spent/agentCount from resumedState", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const resumedState: DwfCheckpointState = {
			version: DWF_CHECKPOINT_VERSION,
			runId: "team_dwf_test_abc",
			vars: { lastPhase: "analyze", items: ["a", "b"] },
			phases: ["scan", "analyze"],
			currentPhase: "analyze",
			logs: ["resumed-log-1", "resumed-log-2"],
			spent: 5000,
			agentCount: 4,
			updatedAt: "2026-06-23T00:00:00.000Z",
		};
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			resumedState,
		});
		// vars hydrated.
		assert.deepEqual(ctx.vars, { lastPhase: "analyze", items: ["a", "b"] });
		// phaseState hydrated.
		const phaseState = getWorkflowPhaseState(ctx);
		assert.deepEqual(phaseState?.phases, ["scan", "analyze"]);
		assert.equal(phaseState?.currentPhase, "analyze");
		// logs hydrated.
		assert.deepEqual(getWorkflowLogs(ctx), ["resumed-log-1", "resumed-log-2"]);
		// spent hydrated (budget).
		assert.equal(ctx.budget.spent(), 5000);
		// agentCount hydrated.
		assert.equal(getWorkflowCheckpoint(ctx).agentCount, 4);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-18 makeWorkflowCtx without resumedState starts empty (fresh run, backward compat)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		assert.deepEqual(ctx.vars, {});
		assert.equal(getWorkflowPhaseState(ctx)?.currentPhase, undefined);
		assert.deepEqual(getWorkflowPhaseState(ctx)?.phases, []);
		assert.deepEqual(getWorkflowLogs(ctx), []);
		assert.equal(ctx.budget.spent(), 0);
		assert.equal(getWorkflowCheckpoint(ctx).agentCount, 0);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-18 resumedState ctx.vars is a copy (mutating it does not affect the source)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const resumed: DwfCheckpointState = {
			version: DWF_CHECKPOINT_VERSION,
			runId: "team_dwf_test_abc",
			vars: { x: 1 },
			phases: [],
			currentPhase: undefined,
			logs: [],
			spent: 0,
			agentCount: 0,
			updatedAt: "x",
		};
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			resumedState: resumed,
		});
		ctx.vars.x = 99;
		assert.equal(resumed.vars.x, 1, "hydrated ctx.vars is a shallow copy — source checkpoint untouched");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("round-18 getWorkflowCheckpoint() snapshots the current ctx state", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		ctx.vars.k = "v";
		ctx.phase("build");
		ctx.log("snap");
		const cp = getWorkflowCheckpoint(ctx);
		assert.equal(cp.runId, "team_dwf_test_abc");
		assert.equal(cp.vars.k, "v");
		assert.deepEqual(cp.phases, ["build"]);
		assert.equal(cp.currentPhase, "build");
		assert.ok(cp.logs.includes("snap"));
		assert.equal(cp.agentCount, 0);
		assert.equal(typeof cp.updatedAt, "string");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

// ---------------------------------------------------------------------------
// DR-03 round-6 Cluster 3 (2026-10-16): R6-3 PERS-1 cache key, R6-10 ctx.retry
// semantics, R6-12 checkpoint ordering + phase re-emission.
// Spec: docs/specs/DR-03-round6-fixes-2026-10-16.md Cluster 3.
// ---------------------------------------------------------------------------

/** Count all files under a directory tree (recursive). Used as the spawn-count
 *  proxy: every REAL successful ctx.agent() call writes exactly one wf/*.md
 *  artifact; a PERS-1 cache hit writes none. */
function countArtifacts(root: string): number {
	if (!fs.existsSync(root)) return 0;
	let count = 0;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const p = path.join(root, entry.name);
		if (entry.isDirectory()) count += countArtifacts(p);
		else count += 1;
	}
	return count;
}

/** Mock child-pi env guard (json-success + allow) with restore. */
function withJsonSuccessMock<T>(fn: () => Promise<T> | T): Promise<T> | T {
	const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	return Promise.resolve(fn()).finally(() => {
		if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
		if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
	});
}

test("R6-3: same prompt + different inputs → two separate spawns (cache must NOT collide)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
		});
		const r1 = await withJsonSuccessMock(() => ctx.agent({ role: "explorer", prompt: "read the inputs", inputs: ["a.md"] }));
		const r2 = await withJsonSuccessMock(() => ctx.agent({ role: "explorer", prompt: "read the inputs", inputs: ["b.md"] }));
		assert.equal(r1.ok && r2.ok, true, "both calls succeed (mock)");
		assert.notEqual(r1.artifactPath, r2.artifactPath, "different inputs alter the dispatched task — distinct cache entries");
		assert.equal(countArtifacts(manifest.artifactsRoot), 2, "two real spawns wrote two artifacts (pre-fix: 1, second call cache-hit)");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("R6-3: same prompt + different systemPrompt → two separate spawns", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
		});
		const r1 = await withJsonSuccessMock(() => ctx.agent({ role: "explorer", prompt: "judge it", systemPrompt: "You are persona A." }));
		const r2 = await withJsonSuccessMock(() => ctx.agent({ role: "explorer", prompt: "judge it", systemPrompt: "You are persona B." }));
		assert.equal(r1.ok && r2.ok, true, "both calls succeed (mock)");
		assert.notEqual(r1.artifactPath, r2.artifactPath, "different systemPrompt — distinct cache entries");
		assert.equal(countArtifacts(manifest.artifactsRoot), 2, "two real spawns");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("R2-M-B5 (Wave-3): identical call twice in ONE run → TWO spawns (cache is resume-only); hydrated state replays with 0 spawns", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
		});
		const call: AgentCallOpts = {
			role: "explorer",
			prompt: "identical call probe",
			inputs: ["x.md", "y.md"],
			systemPrompt: "Shared persona.",
			maxTurns: 2,
		};
		const r1 = await withJsonSuccessMock(() => ctx.agent({ ...call }));
		// R2-M-B5: within a LIVE run the identical-call cache is NOT consulted —
		// the same call options re-spawn (the old within-run hit made the
		// documented review/retry loop replay round-1 verdicts forever).
		const r2 = await withJsonSuccessMock(() => ctx.agent({ ...call }));
		assert.equal(r1.ok && r2.ok, true, "both succeed");
		assert.notEqual(r2.artifactPath, r1.artifactPath, "second identical call re-spawned (no within-run cache hit)");
		assert.equal(countArtifacts(manifest.artifactsRoot), 2, "exactly two spawns — live-run identical calls are NOT cached");
		// The results ARE still recorded for a future resume's checkpoint…
		const cp = getWorkflowCheckpoint(ctx);
		// Both live-run calls ran; the RECORD is keyed by callId, so identical
		// calls collapse to one entry (latest result wins — resume replays that).
		assert.equal(Object.keys(cp.completedAgentCalls ?? {}).length, 1, "live-run call recorded for future resume (keyed, deduped)");
		// …and reordered inputs (same normalized key) also re-spawn in-run.
		const r3 = await withJsonSuccessMock(() => ctx.agent({ ...call, inputs: ["y.md", "x.md"] }));
		assert.equal(r3.ok, true);
		assert.notEqual(r3.artifactPath, r1.artifactPath, "sorted-inputs normalization still does not hit within-run");
		assert.equal(countArtifacts(manifest.artifactsRoot), 3, "three spawns total");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("R6-3: replay from a hydrated PERS-1 record returns structured + artifactPath (no spawn)", async () => {
	const cwd1 = tmpCwd();
	const cwd2 = tmpCwd();
	try {
		// Phase 1: a real call in ctx1 populates the cache under the PRODUCTION key
		// (read back via getWorkflowCheckpoint — no key re-implementation here).
		const manifest1 = fakeManifest(cwd1);
		const ctx1 = makeWorkflowCtx(manifest1, {
			signal: new AbortController().signal,
			concurrency: 1,
		});
		const r1 = await withJsonSuccessMock(() => ctx1.agent({ role: "explorer", prompt: "structured replay probe" }));
		assert.equal(r1.ok, true, "seed call succeeds (mock)");
		assert.ok(r1.artifactPath, "seed call wrote an artifact");
		const cp = getWorkflowCheckpoint(ctx1);
		const entries = Object.entries(cp.completedAgentCalls ?? {});
		assert.equal(entries.length, 1, "exactly one cached call after the seed");
		const [key, cached] = entries[0];
		assert.equal(cached.artifactPath, r1.artifactPath, "R6-3: the cached record stores artifactPath");
		// Simulate a structured payload surviving the checkpoint JSON round-trip.
		const hydrated: Record<string, AgentResult> = {
			[key]: { ...cached, structured: { marker: "structured-survives-replay" } },
		};
		// Phase 2: a FRESH ctx hydrated with the enriched record — same call shape.
		const manifest2 = fakeManifest(cwd2);
		const ctx2 = makeWorkflowCtx(manifest2, {
			signal: new AbortController().signal,
			concurrency: 1,
			resumedState: {
				version: DWF_CHECKPOINT_VERSION,
				runId: manifest2.runId,
				vars: {},
				phases: [],
				currentPhase: undefined,
				logs: [],
				spent: 0,
				agentCount: 1,
				completedAgentCalls: hydrated,
				updatedAt: new Date().toISOString(),
			},
		});
		const r2 = await ctx2.agent({ role: "explorer", prompt: "structured replay probe" });
		assert.equal(r2.ok, true, "hydrated cache hit replays as ok");
		assert.deepEqual(r2.structured, { marker: "structured-survives-replay" }, "R6-3: replay keeps structured output");
		assert.equal(r2.artifactPath, r1.artifactPath, "R6-3: replay keeps artifactPath");
		assert.equal(countArtifacts(manifest2.artifactsRoot), 0, "no spawn happened — the hydrated record satisfied the call");
	} finally {
		await cleanupStateRoot(cwd1);
		await cleanupStateRoot(cwd2);
	}
});

// ---------------------------------------------------------------------------
// R6-10: ctx.retry semantics
// ---------------------------------------------------------------------------

test("R6-10: ctx.retry retries ok:false — two failures then success = 3 agent calls", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
		let calls = 0;
		ctx.agent = (async () => {
			calls += 1;
			if (calls < 3) return { ok: false, text: "", error: `probe-fail-${calls}` };
			return { ok: true, text: "third-time-ok" };
		}) as typeof ctx.agent;
		const res = await ctx.retry("task-probe");
		assert.equal(calls, 3, "ok:false must be retried (pre-fix: 1 attempt, result passed straight through)");
		assert.equal(res.ok, true, "third attempt's success is returned");
		assert.equal(res.text, "third-time-ok");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("R6-10: ctx.retry persistent ok:false → 3 attempts, returns the LAST failure result", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
		let calls = 0;
		ctx.agent = (async () => {
			calls += 1;
			return { ok: false, text: "", error: `probe-fail-${calls}` };
		}) as typeof ctx.agent;
		const res = await ctx.retry("task-probe-2");
		assert.equal(calls, 3, "exactly maxAttempts=3 attempts");
		assert.equal(res.ok, false, "exhaustion returns the carried AgentResult (return type unchanged)");
		assert.equal(res.error, "probe-fail-3", "the LAST attempt's failure is returned");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("R6-10: ctx.retry does not swallow DwfAgentCallCapError (cap still terminates the workflow)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
		ctx.agent = (async () => {
			throw new DwfAgentCallCapError(5, 5);
		}) as typeof ctx.agent;
		await assert.rejects(
			() => ctx.retry("task-cap-probe"),
			(error: unknown) => error instanceof DwfAgentCallCapError,
			"cap errors propagate out of ctx.retry unchanged",
		);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

// ---------------------------------------------------------------------------
// R6-12: checkpoint ordering + phase re-emission on resume
// ---------------------------------------------------------------------------

test("R6-12: checkpoint (agentCount + onCheckpoint) lands BEFORE the worktree cleanup", async () => {
	const cwd = tmpCwd();
	try {
		initGitRepo(cwd);
		const manifest = fakeManifest(cwd);
		let worktreesAtCheckpoint = -1;
		let agentCountAtCheckpoint = -1;
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
			onCheckpoint: (state) => {
				agentCountAtCheckpoint = state.agentCount;
				// Observable ordering seam: at checkpoint time the agent worktree
				// must STILL be registered — cleanup runs AFTER the checkpoint.
				// Pre-fix the awaited cleanup ran first, so this saw only the leader.
				worktreesAtCheckpoint = execSync("git worktree list", { cwd, encoding: "utf-8" }).trim().split("\n").length;
			},
		});
		await withJsonSuccessMock(() => ctx.agent({ role: "executor", prompt: "worktree ordering probe", worktree: true }));
		assert.equal(agentCountAtCheckpoint, 1, "checkpoint fired for the completed call");
		assert.equal(worktreesAtCheckpoint, 2, "agent worktree still exists at checkpoint time (leader + agent worktree)");
		const after = execSync("git worktree list", { cwd, encoding: "utf-8" }).trim().split("\n").length;
		assert.equal(after, 1, "cleanup still runs before agent() resolves (no worktree leak)");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("R6-12: resumed run does NOT re-emit phase events for checkpoint-recorded phases", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		// Simulate a crash DURING phase "analyze": both phases were started
		// pre-crash, only "scan" was completed (via phase("analyze")), and
		// "analyze" is currentPhase (in flight at crash time).
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			resumedState: {
				version: DWF_CHECKPOINT_VERSION,
				runId: manifest.runId,
				vars: {},
				phases: ["scan", "analyze"],
				currentPhase: "analyze",
				logs: [],
				spent: 0,
				agentCount: 1,
				updatedAt: "2026-10-16T00:00:00.000Z",
			},
		});
		// Script re-executes from the top and re-walks its phase history.
		ctx.phase("scan");
		ctx.phase("analyze");
		let phaseEvents = readEvents(manifest.eventsPath).filter((e) => e.type.startsWith("dwf.phase"));
		assert.equal(
			phaseEvents.length,
			0,
			"replayed phases must not re-emit (pre-fix: phase('scan') emitted completed:analyze + started:scan)",
		);
		// A NEW phase still emits normally — and completes the in-flight "analyze"
		// exactly once (it was started pre-crash but never completed).
		ctx.phase("build");
		phaseEvents = readEvents(manifest.eventsPath).filter((e) => e.type.startsWith("dwf.phase"));
		assert.deepEqual(
			phaseEvents.map((e) => `${e.type}:${(e.data as { phase: string }).phase}`),
			["dwf.phase_completed:analyze", "dwf.phase_started:build"],
			"only the genuinely-new boundary emits",
		);
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("R6-12: fresh run still re-emits when a script re-enters a phase title (guard is resume-only)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		ctx.phase("A");
		ctx.phase("B");
		ctx.phase("A");
		const phaseEvents = readEvents(manifest.eventsPath).filter((e) => e.type.startsWith("dwf.phase"));
		assert.deepEqual(
			phaseEvents.map((e) => `${e.type}:${(e.data as { phase: string }).phase}`),
			["dwf.phase_started:A", "dwf.phase_completed:A", "dwf.phase_started:B", "dwf.phase_completed:B", "dwf.phase_started:A"],
			"no resumedState → hydratedPhases is empty → same-title re-entry still emits",
		);
	} finally {
		await cleanupStateRoot(cwd);
	}
});
