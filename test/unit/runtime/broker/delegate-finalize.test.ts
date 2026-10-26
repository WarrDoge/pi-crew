/**
 * delegate-finalize.test.ts — M3-5/R43-N3+N4 and M3-4/R44-N4 pins
 * (fix-wave 6, rounds 43/44).
 *
 * Contract under test (delegate/delegate-finalize.ts):
 *   - a settled grandchild's fenced result goes to the PARENT task mailbox while
 *     the parent can still read it, and to the RUN mailbox (leader channel) once
 *     the parent is terminal/missing — pre-fix the row was appended to the dead
 *     parent's mailbox and never read again (R43-N4);
 *   - the budget charge is the BROKER-SIDE admission reservation, never the
 *     child's self-report (R44-N4) — no settle-time refund exists;
 *   - the shadow record is terminal-flipped unconditionally;
 *   - owner cancellation (R43-N3) is a DISTINCT terminal event from a deadline.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import {
	delegateResultTarget,
	delegateTerminalEvent,
	finalizeDelegateResult,
} from "../../../../src/runtime/broker/delegate/delegate-finalize.ts";
import type { TeamEvent } from "../../../../src/state/event-log/event-log.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { cleanupStateRoot } from "../../../helpers/rm-retry.ts";

interface Fixture {
	cwd: string;
	runId: string;
	parentTaskId: string;
	eventsPath: string;
	cleanup(): Promise<void>;
}

async function scaffold(prefix: string, parentStatus: TeamTaskState["status"]): Promise<Fixture> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-dfin-${prefix}-`));
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: `dfin-${prefix}` },
		{ cwd },
	);
	const runId = run.details.runId!;
	const loaded = loadRunManifestById(cwd, runId)!;
	const parent = loaded.tasks[0];
	const tasks = loaded.tasks.map((t) =>
		t.id === parent.id
			? {
					...t,
					status: parentStatus,
					startedAt: new Date().toISOString(),
					depth: 1,
					allocation: { tokensGranted: 10_000, tokensSpent: 500 },
				}
			: t,
	);
	saveRunTasks(loaded.manifest, tasks);
	saveRunManifest({ ...loaded.manifest, status: "running", updatedAt: new Date().toISOString() }, { allowTerminalExit: true });
	return {
		cwd,
		runId,
		parentTaskId: parent.id,
		eventsPath: loaded.manifest.eventsPath,
		cleanup: () => cleanupStateRoot(cwd, loaded.manifest.eventsPath),
	};
}

/** Poll for an event type (event append is fire-and-forget). */
async function waitForEvent(eventsPath: string, type: string): Promise<TeamEvent[]> {
	const deadline = Date.now() + 3000;
	for (;;) {
		const events = readEvents(eventsPath);
		if (events.some((e) => e.type === type) || Date.now() > deadline) return events;
		await new Promise((r) => setTimeout(r, 20));
	}
}

function readEvents(eventsPath: string): TeamEvent[] {
	try {
		return fs
			.readFileSync(eventsPath, "utf8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l) as TeamEvent);
	} catch {
		return [];
	}
}

/** Poll for a mailbox row in a given file (append is fire-and-forget). */
async function waitForRows(file: string): Promise<Array<{ body: string; to: string; from: string; data?: Record<string, unknown> }>> {
	const deadline = Date.now() + 3000;
	for (;;) {
		if (fs.existsSync(file)) {
			const rows = fs
				.readFileSync(file, "utf8")
				.split("\n")
				.filter((l) => l.trim().length > 0)
				.map((l) => JSON.parse(l) as { body: string; to: string; from: string; data?: Record<string, unknown> });
			if (rows.length > 0) return rows;
		}
		if (Date.now() > deadline) return [];
		await new Promise((r) => setTimeout(r, 20));
	}
}

// ── pure helpers ─────────────────────────────────────────────────────────────

test("R43-N4: delegateResultTarget routes by parent RECORD status", () => {
	for (const status of ["completed", "failed", "cancelled", "skipped", "needs_attention"] as const) {
		assert.equal(delegateResultTarget(status), "run-mailbox", `${status} parent cannot read its mailbox`);
	}
	for (const status of ["queued", "running", "waiting"] as const) {
		assert.equal(delegateResultTarget(status), "parent", `${status} parent still reads its mailbox`);
	}
	assert.equal(delegateResultTarget(undefined), "run-mailbox", "a missing parent is a dead parent");
});

test("R43-N3: delegateTerminalEvent distinguishes owner cancel from deadline", () => {
	assert.equal(delegateTerminalEvent({ ok: false, cancelled: true }), "delegate.cancelled");
	assert.equal(delegateTerminalEvent({ ok: false, timedOut: true }), "delegate.timed_out");
	assert.equal(delegateTerminalEvent({ ok: true }), "delegate.completed");
	assert.equal(delegateTerminalEvent({ ok: false }), "delegate.completed", "plain failure keeps its own event");
});

// ── finalize: live parent → parent mailbox ───────────────────────────────────

test("R43-N4: live parent receives the fenced result in ITS OWN mailbox", async () => {
	const s = await scaffold("live", "running");
	try {
		const outcome = finalizeDelegateResult({
			brokerCwd: s.cwd,
			runId: s.runId,
			parentTaskId: s.parentTaskId,
			subId: "gc-live-1",
			fenced: "--- delegate gc-live-1 (ok) ---\nbody\n--- end delegate gc-live-1 ---",
			ok: true,
			reservedTokens: 500,
			selfReportedTokens: 42,
		});
		assert.equal(outcome.delivery, "parent");
		// M3-4/R44-N4: the charge is the reservation, not the child's 42.
		assert.equal(outcome.chargedTokens, 500);
		const stateRoot = loadRunManifestById(s.cwd, s.runId)!.manifest.stateRoot;
		const rows = await waitForRows(path.join(stateRoot, "mailbox", "tasks", s.parentTaskId, "inbox.jsonl"));
		assert.equal(rows.length, 1, "one row in the parent task mailbox");
		assert.equal(rows[0]!.from, "delegate:gc-live-1");
		assert.match(rows[0]!.body, /--- delegate gc-live-1/);
		assert.equal(rows[0]!.data?.reroutedFrom, undefined, "not rerouted");
		const events = await waitForEvent(s.eventsPath, "delegate.rolled_up");
		assert.equal(
			events.find((e) => e.type === "delegate.rerouted"),
			undefined,
		);
		const rolled = events.find((e) => e.type === "delegate.rolled_up");
		assert.equal(rolled?.data?.chargedTokens, 500);
		assert.equal(rolled?.data?.selfReportedTokens, 42, "child number kept for audit only");
	} finally {
		await s.cleanup();
	}
});

// ── finalize: terminal parent → run mailbox (the R43-N4 fix) ─────────────────

test("R43-N4: TERMINAL parent → result rerouted to the RUN mailbox with an event (pre-fix: unread forever)", async () => {
	const s = await scaffold("dead", "completed");
	try {
		const outcome = finalizeDelegateResult({
			brokerCwd: s.cwd,
			runId: s.runId,
			parentTaskId: s.parentTaskId,
			subId: "gc-dead-1",
			fenced: "--- delegate gc-dead-1 (ok) ---\nlate body\n--- end delegate gc-dead-1 ---",
			ok: true,
			reservedTokens: 0,
		});
		assert.equal(outcome.delivery, "run-mailbox");
		const manifest = loadRunManifestById(s.cwd, s.runId)!.manifest;
		const runRows = await waitForRows(path.join(manifest.stateRoot, "mailbox", "inbox.jsonl"));
		assert.equal(runRows.length, 1, "the result lands in the run (leader) mailbox");
		assert.equal(runRows[0]!.to, "leader");
		assert.equal(runRows[0]!.data?.reroutedFrom, s.parentTaskId);
		assert.equal(runRows[0]!.data?.reason, "parent-terminal");
		// The dead parent's mailbox is NOT written to.
		assert.equal(fs.existsSync(path.join(manifest.stateRoot, "mailbox", "tasks", s.parentTaskId, "inbox.jsonl")), false);
		// Audited: a terminal parent is never a silent drop.
		const rerouted = (await waitForEvent(s.eventsPath, "delegate.rerouted")).find((e) => e.type === "delegate.rerouted");
		assert.ok(rerouted, "delegate.rerouted must be recorded");
		assert.equal(rerouted!.data?.parentStatus, "completed");
	} finally {
		await s.cleanup();
	}
});

test("R43-N4: the shadow record is terminal-flipped even when the result is rerouted", async () => {
	const s = await scaffold("flip", "cancelled");
	try {
		// Plant the shadow record exactly as the broker's admission write does.
		const loaded = loadRunManifestById(s.cwd, s.runId)!;
		saveRunTasks(loaded.manifest, [
			...loaded.tasks,
			{
				id: "gc-flip-1",
				runId: s.runId,
				role: "explorer",
				agent: "delegate",
				title: "delegate: gc-flip-1",
				status: "running" as const,
				cwd: s.cwd,
				dependsOn: [],
				depth: 2,
			},
		]);
		finalizeDelegateResult({
			brokerCwd: s.cwd,
			runId: s.runId,
			parentTaskId: s.parentTaskId,
			subId: "gc-flip-1",
			fenced: "--- delegate gc-flip-1 (failed) ---\nx\n--- end delegate gc-flip-1 ---",
			ok: false,
			reservedTokens: 0,
		});
		const shadow = loadRunManifestById(s.cwd, s.runId)!.tasks.find((t) => t.id === "gc-flip-1");
		assert.equal(shadow?.status, "failed", "settle terminalizes the shadow unconditionally");
		// NOTE: the shadow flip stamps the SAME `completedAt` field the pre-fix
		// inline code did (TeamTaskState's typed terminal timestamp is
		// `finishedAt`; the extra field is verbatim behavior preservation).
	} finally {
		await s.cleanup();
	}
});

test("finalize is best-effort: an unknown run is a no-op, never a throw", () => {
	const outcome = finalizeDelegateResult({
		brokerCwd: fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dfin-norun-")),
		runId: "does-not-exist",
		parentTaskId: "01_x",
		subId: "gc-x",
		fenced: "x",
		ok: true,
		reservedTokens: 0,
	});
	assert.equal(outcome.delivery, "none");
	assert.equal(outcome.chargedTokens, 0);
});

/** Type-use sentinel so the manifest type import is not unused (fixtures are
 *  structurally typed casts). */
export type _ManifestSentinel = TeamRunManifest;
