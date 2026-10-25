/**
 * WP-1/R1 (H6) — live one-shot steer: `steer_subagent` becomes real.
 *
 * Regression test for the real steer path (previously a registered STUB that
 * emitted "Steering request noted" + "not available yet" and wrote NOTHING).
 *
 * Flow (mock-worker pattern from `resume-cancel.test.ts` + the Agent-tool
 * background recipe from `subagent-tools-integration.test.ts`):
 *   1. Dispatch a one-shot background subagent through the real Agent tool with
 *      the mock child-process runtime (`PI_TEAMS_MOCK_CHILD_PI=json-success`).
 *   2. The runner resolves → the spawn route writes the identity link
 *      (record.taskId/depth) + the ownership-map entry (task ⇄ subagentId ⇄
 *      artifactsDir). Poll until the in-memory record carries taskId.
 *   3. Steer mid-run via `steer_subagent` → must resolve → append
 *      `<artifactsRoot>/steering/<taskId>.jsonl` with the exact `team steer`
 *      JSONL schema `{type:"steer", message, ts}`.
 *   4. Negative: steering a record owned by another session is refused (P2.3
 *      cross-session guard precedent, subagent-tools.ts).
 *
 * Regression discriminators (both FAIL on pre-fix code):
 *   - pre-fix spawn route never sets record.taskId → the poll times out;
 *   - pre-fix steer stub never writes the steering file → the file assertion
 *     fails (and the stub emits "not available yet", which we assert is absent).
 *
 * Teardown: resume-cancel retry-rmSync helper (ENOTEMPTY race on macOS CI) +
 * best-effort run cancel so the manager's poll loop does not linger + wave
 * 13-F4 deterministic reap of the detached background-runner process itself
 * (see the "Wave 13-F4" section below — cancel alone does not reach a wedged
 * runner, and 13 such orphans were killed by hand on 2026-10-24/25).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { registerSubagentTools } from "../../../../src/extension/registration/subagent-tools.ts";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { readProcIdentity, reapGroup } from "../../../../src/runtime/process/reap-group.ts";
import type { SubagentRecord } from "../../../../src/runtime/subagent-manager.ts";
import { SubagentManager, savePersistedSubagentRecord } from "../../../../src/runtime/subagent-manager.ts";
import { atomicWriteJson } from "../../../../src/state/atomic-write.ts";
import { resolveEntryBySubagentId } from "../../../../src/state/stores/ownership-map.ts";
import { createRunManifest, loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import { sleepSync } from "../../../../src/utils/sleep.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";
import { firstText, textFromToolResult } from "../../../fixtures/tool-result-helpers.ts";

// Minimal team for createRunManifest-backed tests (no workflow → zero starter
// tasks; the terminal-guard test seeds its own task state directly).
const testTeam: TeamConfig = {
	name: "test-team",
	description: "Test team",
	source: "builtin",
	filePath: "test.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

// ── Harness (subagent-cross-session.test.ts pattern) ──────────────────────

/** Minimal fake pi with just enough to register tools. */
function createFakePi() {
	const tools = new Map<string, any>();
	return {
		tools,
		api: {
			events: {
				on: () => () => undefined,
				emit: (_event?: unknown, _data?: unknown) => undefined,
			},
			on: () => () => undefined,
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand: () => undefined,
			sendMessage: () => undefined,
			sendUserMessage: () => undefined,
		},
	};
}

/** Fake tool-execution ctx with a sessionManager returning a fixed id. */
function fakeCtx(cwd: string, sessionId: string | undefined): any {
	const ctx: Record<string, unknown> = {
		cwd,
		hasUI: false,
		ui: {
			notify() {
				/* no-op */
			},
			setWidget() {
				/* no-op */
			},
			setStatus() {
				/* no-op */
			},
		},
	};
	if (sessionId !== undefined) {
		ctx.sessionManager = { getSessionId: () => sessionId };
	}
	return ctx;
}

/**
 * macOS-CI teardown hardening (resume-cancel.test.ts pattern): the spawned
 * mock worker's final writes can race the recursive rmdir — rimrafSync throws
 * ENOTEMPTY (not swallowed by force:true) when a file lands between its unlink
 * pass and a directory rmdir. Retry briefly; the worker has exited by then, so
 * the next attempt succeeds. Best-effort: a persistent ENOTEMPTY is NOT a test
 * failure — the assertions already passed, and /tmp is swept by the OS.
 */
function removeDirWithRetry(dir: string): void {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if ((code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM") || attempt === 4) {
				console.error(`subagent-steer-live teardown: unable to remove ${dir}: ${String(error)}`);
				return;
			}
			sleepSync(200);
		}
	}
}

/** Best-effort: cancel a run so the manager's poll loop does not linger. */
async function cancelRunBestEffort(cwd: string, runId: string | undefined): Promise<void> {
	if (!runId) return;
	try {
		await handleTeamTool({ action: "cancel", runId, force: true }, { cwd });
	} catch {
		/* best-effort — the test already asserted what it needed */
	}
}

// ── Wave 13-F4: detached background-runner teardown ──────────────────────
//
// The dispatch below spawns a REAL background-runner process through the SUT
// (`handleTeamTool` → `spawnBackgroundTeamRun`): setsid + detached + unref'd,
// own process group (pgid === pid), deliberately SIGTERM-swallowing, and — in
// the test env — with NO parent guard (PI_CREW_PARENT_PID is unset, so the env
// allowlist forwards nothing and the runner never self-terminates when the
// test process exits). The test holds NO handle on it. The mock run normally
// completes in seconds and the runner exits on its own; when it wedges instead
// (live evidence 2026-10-25: pid 809878, run team_20261025040215, stuck 49 min
// in futex_wait with its tmpdir already deleted; 13 such orphans killed by
// hand across 2026-10-24/25, 5 of them born AFTER v0.11.40), nothing in the old
// teardown could reach it — `cancelRunBestEffort` only mutates run state the
// runner may never read again. Reap it deterministically from the pids the SUT
// itself persists (wave-12 SUT-spawned pattern, retrieval-orchestrator.test.ts).

/** One fixture's leak candidates for the after() safety net. */
interface RunnerLeakScope {
	/** The fixture tmpdir: manifest root, pgrep scope, and /proc cwd proof. */
	cwd: string;
	/** Runner pids resolved during the test — re-checked by the after() net. */
	pids: Set<number>;
}

const runnerLeakScopes: RunnerLeakScope[] = [];

function trackRunnerLeakScope(cwd: string): RunnerLeakScope {
	const existing = runnerLeakScopes.find((scope) => scope.cwd === cwd);
	if (existing) return existing;
	const scope: RunnerLeakScope = { cwd, pids: new Set() };
	runnerLeakScopes.push(scope);
	return scope;
}

/** `kill(pid, 0)` liveness — EPERM means alive, just not ours. */
function runnerPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Linux reuse guard: the runner is spawned with `cwd` = the fixture tmpdir and
 * never chdirs, so a live pid whose /proc/<pid>/cwd points elsewhere is a
 * recycled stranger, never our runner. `undefined` = unreadable (non-Linux or
 * gone) — no evidence either way; the reap ladder below still applies.
 */
function runnerCwdMatches(pid: number, cwd: string): boolean | undefined {
	try {
		const procCwd = fs.readlinkSync(`/proc/${pid}/cwd`);
		if (procCwd === cwd || procCwd === `${cwd} (deleted)`) return true;
		return false;
	} catch {
		return undefined;
	}
}

/** Is `pid` a plausible runner pid (integer, not init, not OURSELVES)? */
function plausibleRunnerPid(pid: unknown): pid is number {
	// `pid === process.pid` means the inline async seam (PI_CREW_TEST_ASYNC_INLINE)
	// executed the "runner" in-process — killing it would kill this test file.
	return Number.isInteger(pid) && (pid as number) > 1 && (pid as number) !== process.pid;
}

/**
 * Resolve the runner pid from the state the SUT persists under the fixture cwd
 * (createTrackedTempDir seeds `.git` ⇒ project state ⇒ `<cwd>/.crew/state/runs`):
 *  1. `manifest.async.pid` — written by the SPAWNING process the moment
 *     `spawnBackgroundTeamRun` returns, so it exists even while the runner is
 *     still booting jiti (before the runner writes its own marker).
 *  2. the runner's own startup marker `<stateRoot>/async.pid` ({pid, startedAt}).
 *  3. any run's manifest in the fixture tree — a fresh tmpdir can only contain
 *     THIS test's runs, which covers the red-test case where the record poll
 *     timed out and `runIdToCancel` was never linked.
 */
function resolveRunnerPidFromState(cwd: string, runId: string | undefined): number | undefined {
	if (runId) {
		try {
			const pid = loadRunManifestById(cwd, runId)?.manifest.async?.pid;
			if (plausibleRunnerPid(pid)) return pid;
		} catch {
			/* best-effort */
		}
	}
	const runsRoot = path.join(cwd, ".crew", "state", "runs");
	let runDirs: string[];
	try {
		runDirs = runId ? [path.join(runsRoot, runId)] : fs.readdirSync(runsRoot).map((entry) => path.join(runsRoot, entry));
	} catch {
		return undefined; // tree gone / never created — nothing to read
	}
	for (const runDir of runDirs) {
		// async.pid first: cheaper and it survives a manifest rewrite race.
		for (const file of ["async.pid", "manifest.json"]) {
			try {
				const parsed = JSON.parse(fs.readFileSync(path.join(runDir, file), "utf-8")) as {
					pid?: unknown;
					async?: { pid?: unknown };
				};
				const pid = file === "async.pid" ? parsed.pid : parsed.async?.pid;
				if (plausibleRunnerPid(pid)) return pid;
			} catch {
				/* best-effort */
			}
		}
	}
	return undefined;
}

/**
 * Last resort when state yields no pid: `pgrep -f` scoped to the fixture's
 * unique tmpdir name (the runner command line carries `--cwd <tmpdir>`, so the
 * mkdtemp suffix is collision-proof). Evidence-first: every match is logged
 * before it is signalled and still has to pass the /proc cwd proof (where
 * readable). Quiet when nothing matches (pgrep exits 1).
 */
function pkillScopedByCwdBestEffort(cwd: string): void {
	if (process.platform === "win32") return; // no pgrep there
	const scope = path.basename(cwd);
	let stdout: string;
	try {
		stdout = execFileSync("pgrep", ["-f", scope], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return; // no match (or pgrep missing) — exactly what we want
	}
	const pids = stdout
		.split("\n")
		.map((line) => Number(line.trim()))
		.filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
	if (pids.length === 0) return;
	console.warn(`[subagent-steer-live] teardown fallback: pgrep -f ${scope} matched [${pids.join(", ")}] — killing`);
	for (const pid of pids) {
		if (runnerCwdMatches(pid, cwd) === false) {
			console.warn(`[subagent-steer-live] teardown fallback: pid ${pid} cwd mismatch — skipping (pid reuse suspected)`);
			continue;
		}
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}
}

/**
 * Kill the detached background-runner for one dispatch, from state-recorded
 * pids (wave-12 SUT-spawned pattern): group reap via `reapGroup` when the pid
 * provably leads its own group (`pgid === pid`, Linux — the setsid spawn
 * guarantees it), pid-only SIGKILL otherwise. NEVER throws: it runs in
 * `finally`, where a throw would mask the failure under test.
 */
async function reapBackgroundRunnerBestEffort(scope: RunnerLeakScope, runId: string | undefined): Promise<void> {
	try {
		const pid = resolveRunnerPidFromState(scope.cwd, runId);
		if (pid !== undefined) scope.pids.add(pid);
		if (pid !== undefined && runnerPidAlive(pid)) {
			const cwdOk = runnerCwdMatches(pid, scope.cwd);
			if (cwdOk === false) {
				console.warn(
					`[subagent-steer-live] teardown: runner pid ${pid} alive but its cwd is not ${scope.cwd} — pid reuse suspected, NOT killing`,
				);
				return;
			}
			if (process.platform === "linux") {
				const identity = readProcIdentity(pid);
				if (identity?.pgid === pid) {
					const result = reapGroup(pid, pid, {
						expected: identity,
						gracefulMs: 250,
						capMs: 2_000,
						name: `steer-live-runner:${pid}`,
					});
					if (result.outcome !== "refused") {
						// keep-alive: the escalation's poll timers are unref'd on purpose
						const keepAlive = setInterval(() => undefined, 25);
						try {
							await result.pending;
						} finally {
							clearInterval(keepAlive);
						}
						if (!runnerPidAlive(pid)) return;
					}
				}
			}
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already gone */
			}
			const deadline = Date.now() + 1_000;
			while (runnerPidAlive(pid) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			if (runnerPidAlive(pid)) {
				console.warn(`[subagent-steer-live] teardown: runner pid ${pid} still alive after SIGKILL — leaving it to the OS`);
			}
			return;
		}
		// No live pid from state. Second chance for pids remembered from an
		// earlier pass (after() runs once the tmp tree is already deleted), then
		// the pgrep-scoped fallback.
		for (const remembered of scope.pids) {
			if (!runnerPidAlive(remembered) || runnerCwdMatches(remembered, scope.cwd) === false) continue;
			try {
				process.kill(remembered, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
		pkillScopedByCwdBestEffort(scope.cwd);
	} catch (error) {
		console.warn(`[subagent-steer-live] teardown: background-runner reap failed: ${String(error)}`);
	}
}

// Second net (wave-12 rule: finally AND after()): the finally above runs even
// on assertion throw, and this hook re-checks every scope after the whole
// file. By then the tmp trees are deleted, so this pass leans on remembered
// pids and the pgrep scope — exactly the paths a failed finally leaves open.
after(async () => {
	for (const scope of runnerLeakScopes) {
		await reapBackgroundRunnerBestEffort(scope, undefined);
	}
});

// ── Live one-shot steer ───────────────────────────────────────────────────

test("dispatch one-shot → identity link → steer resolves → steering file appended", async () => {
	// Mock child-process runtime recipe (subagent-tools-integration.test.ts):
	// real Agent tool dispatch, but workers are mocked to "json-success" so the
	// background run completes quickly and the spawn-route identity link lands.
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousAllowMock = process.env.PI_CREW_ALLOW_MOCK;
	const previousCrewRole = process.env.PI_CREW_ROLE;
	const previousTeamsRole = process.env.PI_TEAMS_ROLE;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-slow-success";
	delete process.env.PI_CREW_ROLE;
	delete process.env.PI_TEAMS_ROLE;

	const cwd = createTrackedTempDir("pi-crew-steer-live-");
	const runnerScope = trackRunnerLeakScope(cwd);
	const manager = new SubagentManager();
	let fake: ReturnType<typeof createFakePi> | undefined;
	let runIdToCancel: string | undefined;
	try {
		fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const agentTool = fake.tools.get("Agent");
		const steerTool = fake.tools.get("steer_subagent");
		assert.ok(agentTool, "Agent tool must be registered");
		assert.ok(steerTool, "steer_subagent tool must be registered");

		const ctx = fakeCtx(cwd, "session-A");
		const launched = await agentTool.execute(
			"call-1",
			{
				prompt: "Explore edge cases in the render pipeline",
				description: "Explore edge cases",
				subagent_type: "explorer",
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		);
		const launchText = firstText(launched);
		assert.match(launchText, /Agent ID:/);
		const agentId = launchText.match(/Agent ID: (\S+)/)?.[1];
		assert.ok(agentId, "agent id must be returned by the Agent tool");

		// Wait for the runner to resolve and the identity link to land:
		// record.taskId is only written by the spawn route once the run
		// manifest resolves (mock run completes in a few seconds; under CI/load
		// the detached background process can take longer). Pre-fix, this never
		// happens → the poll times out → test FAILS.
		const deadline = Date.now() + 45_000;
		let record = manager.getRecord(agentId);
		while ((!record?.taskId || !record.runId) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			record = manager.getRecord(agentId);
		}
		assert.ok(record, "record must exist after spawn");
		assert.ok(
			record.runId,
			`runId must be linked (taskId=${record.taskId ?? "unset"}, status=${record?.status}, error=${record?.error ?? "(none)"})`,
		);
		assert.ok(
			record.taskId,
			`taskId must be linked by the one-shot spawn route (status=${record?.status}, error=${record?.error ?? "(none)"})`,
		);
		assert.equal(record.depth, 0, "root one-shot depth must be 0");
		runIdToCancel = record.runId;

		// Ownership map: the one-shot writer recorded task ⇄ subagentId ⇄ artifactsDir.
		const loaded = loadRunManifestById(cwd, record.runId);
		assert.ok(loaded, "run manifest must resolve for the linked runId");
		// (flake P3) The ownership upsert is best-effort with a bounded lock-retry
		// budget and can transiently lose the run-lock race to the run's terminal
		// writes; poll for it like taskId above instead of asserting on first read.
		const ownDeadline = Date.now() + 15_000;
		let ownership = resolveEntryBySubagentId(loaded.manifest, agentId);
		while ((!ownership || ownership.taskId !== record.taskId) && Date.now() < ownDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			ownership = resolveEntryBySubagentId(loaded.manifest, agentId);
		}
		assert.ok(ownership, "ownership-map entry must exist for the subagent");
		assert.equal(ownership?.taskId, record.taskId);
		assert.equal(ownership?.runId, record.runId);
		assert.equal(ownership?.artifactsDir, loaded.manifest.artifactsRoot);

		// Steer mid-run (tool-side): resolve → append artifacts/steering/<taskId>.jsonl.
		const steered = await steerTool.execute("call-2", { agent_id: agentId, message: "Focus on edge cases" }, undefined, undefined, ctx);
		assert.equal(
			steered.isError,
			false,
			`steer on a linked record must not error (taskStatus debug: steerText=${firstText(steered).slice(0, 300)})`,
		);
		const steerText = firstText(steered);
		assert.match(steerText, /Steering request noted/);
		assert.doesNotMatch(steerText, /not available yet/, "linked record must not hit the 'not linked' branch");
		assert.match(steerText, new RegExp(record.taskId as string));

		// Delivered at turn boundary (tool-side contract): the child worker
		// polls this file every 500ms; assert the exact `team steer` JSONL schema
		// {type:"steer", message, ts} (handleSteer / appendSteeringAsync format).
		const steeringPath = path.join(loaded.manifest.artifactsRoot, "steering", `${record.taskId}.jsonl`);
		assert.ok(fs.existsSync(steeringPath), `steering file must exist at ${steeringPath}`);
		const lines = fs.readFileSync(steeringPath, "utf-8").trim().split("\n").filter(Boolean);
		assert.equal(lines.length, 1, "exactly one steering line expected");
		const entry = JSON.parse(lines[0]) as { type?: unknown; message?: unknown; ts?: unknown };
		assert.equal(entry.type, "steer");
		assert.equal(entry.message, "Focus on edge cases");
		assert.equal(typeof entry.ts, "string");
	} finally {
		await cancelRunBestEffort(cwd, runIdToCancel);
		// Wave 13-F4: kill the detached background-runner itself BEFORE the tree
		// is removed (pid resolution reads manifest.json/async.pid under cwd, and
		// a live runner keeps writing into the tree the rmSync below deletes).
		// Cancel alone is NOT enough — the runner may be wedged past the point
		// where it reads run state (see the module notes above).
		await reapBackgroundRunnerBestEffort(runnerScope, runIdToCancel);
		void manager.abortAll();
		fake?.api.events.emit("session_shutdown", {});
		// Drain in-flight background-agent I/O before deletion (Windows FS latency).
		await new Promise((resolve) => setTimeout(resolve, 200));
		if (previousExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = previousExecute;
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		if (previousAllowMock === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = previousAllowMock;
		if (previousCrewRole === undefined) delete process.env.PI_CREW_ROLE;
		else process.env.PI_CREW_ROLE = previousCrewRole;
		if (previousTeamsRole === undefined) delete process.env.PI_TEAMS_ROLE;
		else process.env.PI_TEAMS_ROLE = previousTeamsRole;
		removeDirWithRetry(cwd);
	}
});

test("steer refuses a record owned by another session (P2.3 cross-session guard)", async () => {
	const cwd = createTrackedTempDir("pi-crew-steer-session-");
	const manager = new SubagentManager();
	try {
		// A linked record (taskId present) but owned by session-A: the guard must
		// refuse before any resolve/append happens.
		savePersistedSubagentRecord(cwd, {
			id: "agent_other_session",
			type: "explorer",
			description: "Other session agent",
			prompt: "Do work",
			status: "running",
			startedAt: Date.now(),
			background: true,
			ownerSessionId: "session-A",
			taskId: "01_01-agent",
		});
		const fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const steer = fake.tools.get("steer_subagent");
		assert.ok(steer, "steer_subagent tool must be registered");

		const result = await steer.execute(
			"call",
			{ agent_id: "agent_other_session", message: "STOP" },
			undefined,
			undefined,
			fakeCtx(cwd, "session-B"),
		);
		assert.equal(result.isError, true, "cross-session steer must be refused");
		assert.match(firstText(result), /belongs to another session/);
	} finally {
		void manager.abortAll();
		removeDirWithRetry(cwd);
	}
});

test("steer on a missing message returns the requires-prompt error (no throw)", async () => {
	const cwd = createTrackedTempDir("pi-crew-steer-nomsg-");
	const manager = new SubagentManager();
	try {
		savePersistedSubagentRecord(cwd, {
			id: "agent_msgless",
			type: "explorer",
			description: "Message-less agent",
			prompt: "Do work",
			status: "running",
			startedAt: Date.now(),
			background: true,
			ownerSessionId: "session-A",
			taskId: "01_01-agent",
		});
		const fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const steer = fake.tools.get("steer_subagent");
		assert.ok(steer, "steer_subagent tool must be registered");

		const result = await steer.execute(
			"call",
			{ agent_id: "agent_msgless", message: "   " },
			undefined,
			undefined,
			fakeCtx(cwd, "session-A"),
		);
		assert.equal(result.isError, true);
		assert.ok(textFromToolResult(result).length > 0, "must return a prompt-required message");
	} finally {
		void manager.abortAll();
		removeDirWithRetry(cwd);
	}
});

test("steer refuses a terminal task (T-S1 parity with handleSteer, no file write)", async () => {
	// Security review (T1/WP-1 round 1, security-2): the new steer tool must
	// mirror handleSteer's terminal-task refusal and task-existence validation —
	// steering a completed/failed/cancelled task would otherwise append a
	// permanent line that poisons the task's file for a later retry.
	const cwd = createTrackedTempDir("pi-crew-steer-terminal-");
	try {
		const { manifest } = createRunManifest({ cwd, team: testTeam, goal: "terminal steer test" });
		// Seed a single terminal task directly (no-workflow team → empty tasks).
		const task: TeamTaskState = {
			id: "01-ter",
			runId: manifest.runId,
			stepId: "01",
			role: "executor",
			agent: "executor",
			title: "terminal task",
			status: "completed", // terminal — steer must refuse
			dependsOn: [],
			cwd: "/tmp",
		};
		atomicWriteJson(manifest.tasksPath, [task]);
		const manager = new SubagentManager();
		const fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const steer = fake.tools.get("steer_subagent");
		assert.ok(steer, "steer_subagent tool must be registered");
		// needs a real persisted record linked to the run
		const record: SubagentRecord = {
			id: "agent_term",
			runId: manifest.runId,
			taskId: "01-ter",
			depth: 0,
			type: "explorer",
			description: "t",
			prompt: "p",
			status: "running",
			background: false,
			startedAt: Date.now(),
			ownerSessionId: "session-A",
		};
		savePersistedSubagentRecord(cwd, record);
		const ctx = fakeCtx(cwd, "session-A");
		const result = await steer.execute("call", { agent_id: "agent_term", message: "STOP" }, undefined, undefined, ctx);
		assert.equal(result.isError, true, "terminal task must refuse steer");
		const text = textFromToolResult(result);
		assert.match(text, /completed; cannot steer/, `expected terminal refusal in: ${text}`);
		// no steering file written
		const steeringPath = path.join(manifest.artifactsRoot, "steering", "01-ter.jsonl");
		assert.equal(fs.existsSync(steeringPath), false, "no steering file must be written for a terminal task");
	} finally {
		removeDirWithRetry(cwd);
	}
});
