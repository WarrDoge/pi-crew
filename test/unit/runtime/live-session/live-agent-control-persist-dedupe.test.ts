/**
 * R41-1 / M3-11 — durable control-request dedupe.
 *
 * Before the fix, `processedAt` lived only on the in-memory request object and
 * the dedupe set (BoundedSeenControlRequestIdSet) was re-created per runtime
 * invocation, with the read cursor starting at {offset: 0}. After a crash or a
 * resume, every already-applied control request (stop / steer / follow-up) was
 * read back and re-applied.
 *
 * These tests drive the REAL `applyLiveAgentControlRequests` / reader pair and
 * simulate the resume by using a COLD cursor + a COLD seen-set, which is
 * exactly what live-session-runtime.ts:1415-1416 does on a new invocation.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import {
	appendLiveAgentControlRequest,
	applyLiveAgentControlRequests,
	type LiveAgentControlRequest,
	liveAgentControlPath,
	readLiveAgentControlRequests,
} from "../../../../src/runtime/live-session/live-agent-control.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeManifest(tmp: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "run-persist",
		team: "default",
		workflow: "default",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: tmp,
		stateRoot: `${tmp}/.crew/state`,
		artifactsRoot: `${tmp}/.crew/artifacts`,
		tasksPath: `${tmp}/tasks.json`,
		eventsPath: `${tmp}/events.jsonl`,
		artifacts: [],
	};
}

/** A cold runtime invocation: fresh cursor + fresh seen-set (post-resume state). */
function coldInvocation() {
	return { cursor: { offset: 0 }, seenRequestIds: new Set<string>() };
}

function makeSession(log: string[]) {
	return {
		steer: async (text: string) => {
			log.push(`steer:${text}`);
		},
		prompt: async (text: string, _options?: Record<string, unknown>) => {
			log.push(`prompt:${text}`);
		},
		abort: async () => {
			log.push("abort");
		},
	};
}

describe("R41-1: control requests are not replayed after crash/resume", () => {
	it("a consumed steer is NOT re-delivered when the runtime restarts with a cold cursor", async () => {
		const tmp = createTrackedTempDir("pi-crew-lc-persist-");
		try {
			const manifest = makeManifest(tmp);
			appendLiveAgentControlRequest(manifest, { taskId: "task1", operation: "steer", message: "wrap up" });

			const log: string[] = [];
			const session = makeSession(log);
			const first = coldInvocation();
			await applyLiveAgentControlRequests({
				manifest,
				taskId: "task1",
				agentId: "run-persist:task1",
				session,
				cursor: first.cursor,
				seenRequestIds: first.seenRequestIds,
			});
			assert.deepEqual(log, ["steer:wrap up"], "first pass delivers the steer");

			// --- crash + resume: brand-new cursor AND brand-new seen-set ---
			const second = coldInvocation();
			const resumedCursor = await applyLiveAgentControlRequests({
				manifest,
				taskId: "task1",
				agentId: "run-persist:task1",
				session,
				cursor: second.cursor,
				seenRequestIds: second.seenRequestIds,
			});

			assert.deepEqual(log, ["steer:wrap up"], "cold resume must NOT replay the consumed steer");
			assert.ok(resumedCursor.offset > 0, "cursor advanced past the consumed request");
			// The reader itself filters consumed requests, so a resumed runtime never
			// even sees them (this is what makes the fix independent of the caller's
			// per-invocation dedupe set).
			const { requests } = readLiveAgentControlRequests(manifest, "task1", { offset: 0 });
			assert.equal(requests.length, 0, "reader returns no already-processed request");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("persists an append-only processed marker next to the request (no rewrite)", async () => {
		const tmp = createTrackedTempDir("pi-crew-lc-persist-");
		try {
			const manifest = makeManifest(tmp);
			const request = appendLiveAgentControlRequest(manifest, { taskId: "task1", operation: "stop" });
			const log: string[] = [];
			await applyLiveAgentControlRequests({
				manifest,
				taskId: "task1",
				agentId: "run-persist:task1",
				session: makeSession(log),
				...coldInvocation(),
			});
			const lines = fs
				.readFileSync(liveAgentControlPath(manifest, "task1"), "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			assert.equal(lines.length, 2, "request line + marker line (append-only)");
			assert.equal(lines[0]!.id, request.id, "the request line is untouched");
			assert.equal(lines[1]!.type, "processed");
			assert.equal(lines[1]!.requestId, request.id);
			assert.equal(lines[1]!.runId, manifest.runId);
			assert.equal(lines[1]!.taskId, "task1");
			assert.equal(typeof lines[1]!.processedAt, "string");
			assert.deepEqual(log, ["abort"], "the stop was applied once");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("a request that was never applied is still delivered (no false dedupe)", async () => {
		const tmp = createTrackedTempDir("pi-crew-lc-persist-");
		try {
			const manifest = makeManifest(tmp);
			// Simulate a crash BEFORE the first poll: request appended, never consumed.
			appendLiveAgentControlRequest(manifest, { taskId: "task1", operation: "steer", message: "late" });
			const log: string[] = [];
			await applyLiveAgentControlRequests({
				manifest,
				taskId: "task1",
				agentId: "run-persist:task1",
				session: makeSession(log),
				...coldInvocation(),
			});
			assert.deepEqual(log, ["steer:late"], "unconsumed request is delivered on resume");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("marks a request the REALTIME path already consumed (via the shared seen-set) so it cannot replay", async () => {
		const tmp = createTrackedTempDir("pi-crew-lc-persist-");
		try {
			const manifest = makeManifest(tmp);
			const request = appendLiveAgentControlRequest(manifest, { taskId: "task1", operation: "follow-up", message: "go" });
			const log: string[] = [];
			const session = makeSession(log);
			// Realtime subscription consumed it in-process (no manifest → no marker).
			const seen = new Set<string>([request.id]);
			await applyLiveAgentControlRequests({
				manifest,
				taskId: "task1",
				agentId: "run-persist:task1",
				session,
				cursor: { offset: 0 },
				seenRequestIds: seen,
			});
			assert.deepEqual(log, [], "seen-set dedupe suppressed a second delivery");

			// Fresh process after crash/resume: cold seen-set, cold cursor.
			const after = coldInvocation();
			await applyLiveAgentControlRequests({
				manifest,
				taskId: "task1",
				agentId: "run-persist:task1",
				session,
				cursor: after.cursor,
				seenRequestIds: after.seenRequestIds,
			});
			assert.deepEqual(log, [], "realtime-consumed request must not replay after resume either");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("a request addressed to a DIFFERENT agent is left for its owner and not marked processed", async () => {
		const tmp = createTrackedTempDir("pi-crew-lc-persist-");
		try {
			const manifest = makeManifest(tmp);
			const request = appendLiveAgentControlRequest(manifest, {
				taskId: "task1",
				agentId: "other-agent",
				operation: "stop",
			});
			const log: string[] = [];
			await applyLiveAgentControlRequests({
				manifest,
				taskId: "task1",
				agentId: "run-persist:task1",
				session: makeSession(log),
				...coldInvocation(),
			});
			assert.deepEqual(log, [], "not ours to apply");
			const lines = fs.readFileSync(liveAgentControlPath(manifest, "task1"), "utf-8").split("\n").filter(Boolean);
			assert.equal(lines.length, 1, "no marker written for a request owned by another agent");
			assert.equal((JSON.parse(lines[0]!) as LiveAgentControlRequest).id, request.id);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("a failing operation is still marked processed (poisoned request cannot loop)", async () => {
		const tmp = createTrackedTempDir("pi-crew-lc-persist-");
		try {
			const manifest = makeManifest(tmp);
			appendLiveAgentControlRequest(manifest, { taskId: "task1", operation: "steer", message: "boom" });
			let calls = 0;
			const session = {
				steer: async () => {
					calls += 1;
					throw new Error("session is gone");
				},
			};
			await applyLiveAgentControlRequests({
				manifest,
				taskId: "task1",
				agentId: "run-persist:task1",
				session,
				...coldInvocation(),
			});
			await applyLiveAgentControlRequests({
				manifest,
				taskId: "task1",
				agentId: "run-persist:task1",
				session,
				...coldInvocation(),
			});
			assert.equal(calls, 1, "the poisoned request is consumed, not retried forever");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("markers for another run/task do not suppress this task's request", async () => {
		const tmp = createTrackedTempDir("pi-crew-lc-persist-");
		try {
			const manifest = makeManifest(tmp);
			appendLiveAgentControlRequest(manifest, { taskId: "task1", operation: "steer", message: "mine" });
			// Two foreign markers: another taskId and another runId.
			fs.appendFileSync(
				liveAgentControlPath(manifest, "task1"),
				`${JSON.stringify({ type: "processed", requestId: "ctrl_other", runId: manifest.runId, taskId: "task2", processedAt: new Date().toISOString() })}\n`,
				"utf-8",
			);
			fs.appendFileSync(
				liveAgentControlPath(manifest, "task1"),
				`${JSON.stringify({ type: "processed", requestId: "ctrl_other", runId: "another-run", taskId: "task1", processedAt: new Date().toISOString() })}\n`,
				"utf-8",
			);
			const log: string[] = [];
			await applyLiveAgentControlRequests({
				manifest,
				taskId: "task1",
				agentId: "run-persist:task1",
				session: makeSession(log),
				...coldInvocation(),
			});
			assert.deepEqual(log, ["steer:mine"], "foreign markers are scoped out");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("tolerates an unparseable line and still dedupes", async () => {
		const tmp = createTrackedTempDir("pi-crew-lc-persist-");
		try {
			const manifest = makeManifest(tmp);
			appendLiveAgentControlRequest(manifest, { taskId: "task1", operation: "steer", message: "once" });
			fs.appendFileSync(liveAgentControlPath(manifest, "task1"), "{not json\n", "utf-8");
			const log: string[] = [];
			await applyLiveAgentControlRequests({
				manifest,
				taskId: "task1",
				agentId: "run-persist:task1",
				session: makeSession(log),
				...coldInvocation(),
			});
			await applyLiveAgentControlRequests({
				manifest,
				taskId: "task1",
				agentId: "run-persist:task1",
				session: makeSession(log),
				...coldInvocation(),
			});
			assert.deepEqual(log, ["steer:once"], "one delivery despite the corrupt line");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
