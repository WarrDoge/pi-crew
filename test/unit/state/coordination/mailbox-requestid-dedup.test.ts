/**
 * U5 (2026-10-10, upgrade-spec pi-crew-upgrade-spec-2026-10-09.md) — mailbox
 * `requestId` dedup.
 *
 * Invariants under test:
 *  - every mailbox send carries a unique requestId (auto-stamped uuid when
 *    the caller omits one);
 *  - `appendMailboxMessageIdempotent[Async]` enforces (direction, requestId)
 *    idempotency per target mailbox file — a resend appends nothing and
 *    returns the existing row (the durable analog of pi-durable's
 *    `tx.submissionByRequest()` exactly-once root-submit);
 *  - the worker inbox pickup's dedup survives a RESTART (persisted in
 *    delivery.json: `messages[id]="acknowledged"` + `${direction}:${requestId}`
 *    index), unlike the caller-owned in-memory seen-set;
 *  - ACCEPTANCE: send → worker picks up once → "restart" (fresh process, EMPTY
 *    seen-set) → resume replay + resend with the same requestId → the worker
 *    still received it EXACTLY ONCE;
 *  - audit: the events log records the chain (mailbox.send → mailbox.pickup →
 *    mailbox.pickup_deduped).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { acknowledgeWorkerInboxDelivery, pollWorkerInbox } from "../../../../src/prompt/inbox-poll.ts";
import {
	appendMailboxMessage,
	appendMailboxMessageIdempotent,
	appendMailboxMessageIdempotentAsync,
	findMailboxMessageByRequestId,
	readDeliveryState,
	readMailbox,
	replayPendingMailboxMessages,
} from "../../../../src/state/coordination/mailbox.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const RUN_ID = "u5-dedup-run";

interface Fixture {
	manifest: TeamRunManifest;
	stateRoot: string;
	cleanup(): void | Promise<void>;
}

function makeFixture(prefix: string): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-u5-${prefix}-`));
	const stateRoot = path.join(root, ".crew", "state", "runs", RUN_ID);
	fs.mkdirSync(stateRoot, { recursive: true });
	const manifest = {
		schemaVersion: 1,
		runId: RUN_ID,
		team: "test-team",
		workflow: "test",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: os.tmpdir(),
		stateRoot,
		artifactsRoot: path.join(stateRoot, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	} as unknown as TeamRunManifest;
	// Best-effort teardown: an async mailbox/event writer can still be flushing
	// when cleanup fires (ENOTEMPTY/EBUSY rmdir — live-caught Nightly 2026-10-12,
	// passes 3× isolated); the dir is pi-crew-* prefixed so the runner's debris
	// sweep removes leftovers. A passed test must not fail on teardown.
	return {
		manifest,
		stateRoot,
		cleanup: async () => {
			try {
				await removeDirWithRetry(root);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY" && code !== "EACCES") throw err;
				console.warn(`[test] tmpdir locked (${code}): ${root} — left for debris sweep`);
			}
		},
	};
}

function readEvents(stateRoot: string): Array<{ type: string; data?: Record<string, unknown> }> {
	const file = path.join(stateRoot, "events.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf-8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> });
}

/** Drain fire-and-forget event writes so cleanup never races a pending
 *  append (and --test-force-exit sees no dangling promises). */
async function drainEvents(): Promise<void> {
	await new Promise((r) => setTimeout(r, 30));
}

/** Wait (bounded) until the events log contains `count` events of `type` —
 *  fire-and-forget appends are fsync'd, which can exceed a fixed sleep under
 *  load (a 30ms drain flaked once in CI-like conditions). */
async function waitForEvents(stateRoot: string, type: string, count: number, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (readEvents(stateRoot).filter((e) => e.type === type).length >= count) return;
		await new Promise((r) => setTimeout(r, 25));
	}
}

test("U5: every mailbox send carries a unique auto-stamped requestId", async () => {
	const { manifest, cleanup } = makeFixture("autostamp");
	try {
		const a = appendMailboxMessage(manifest, {
			direction: "inbox",
			from: "leader",
			to: "task-1",
			taskId: "task-1",
			body: "no explicit id",
			kind: "message",
		});
		const b = appendMailboxMessage(manifest, {
			direction: "inbox",
			from: "leader",
			to: "task-1",
			taskId: "task-1",
			body: "second",
			kind: "message",
		});
		assert.ok(a.requestId, "auto-stamped requestId must be present");
		assert.ok(b.requestId);
		assert.notEqual(a.requestId, b.requestId, "auto-stamped ids must be unique per send");
		// The durable row carries it too (survives restart by construction).
		const row = readMailbox(manifest, "inbox", "task-1").find((m) => m.id === a.id);
		assert.equal(row?.requestId, a.requestId);
	} finally {
		await cleanup();
	}
});

test("U5: appendMailboxMessageIdempotent — same (direction, requestId) reuses the row, per target mailbox", async () => {
	const { manifest, cleanup } = makeFixture("idem");
	try {
		const first = appendMailboxMessageIdempotent(manifest, {
			direction: "inbox",
			from: "task-2",
			to: "task-1",
			taskId: "task-1",
			body: "dm",
			kind: "message",
			requestId: `${RUN_ID}:task-2:1`,
		});
		assert.equal(first.deduped, false, "fresh requestId appends");
		const resend = appendMailboxMessageIdempotent(manifest, {
			direction: "inbox",
			from: "task-2",
			to: "task-1",
			taskId: "task-1",
			body: "dm (retried)",
			kind: "message",
			requestId: `${RUN_ID}:task-2:1`,
		});
		assert.equal(resend.deduped, true, "same requestId in the same mailbox is a dedup no-op");
		assert.equal(resend.message.id, first.message.id, "the existing row is returned");
		assert.equal(readMailbox(manifest, "inbox", "task-1").length, 1, "no duplicate row was appended");
		// Different requestId → new row.
		const other = appendMailboxMessageIdempotent(manifest, {
			direction: "inbox",
			from: "task-2",
			to: "task-1",
			taskId: "task-1",
			body: "different logical send",
			kind: "message",
			requestId: `${RUN_ID}:task-2:2`,
		});
		assert.equal(other.deduped, false);
		assert.equal(readMailbox(manifest, "inbox", "task-1").length, 2);
		// Same requestId in a DIFFERENT target's mailbox → its own row (per-target
		// dedup: a partially failed fan-out retry must still reach missing targets).
		const sibling = appendMailboxMessageIdempotent(manifest, {
			direction: "inbox",
			from: "task-2",
			to: "task-3",
			taskId: "task-3",
			body: "dm to sibling",
			kind: "message",
			requestId: `${RUN_ID}:task-2:1`,
		});
		assert.equal(sibling.deduped, false, "requestId dedup is scoped to the target mailbox file");
	} finally {
		await cleanup();
	}
});

test("U5: appendMailboxMessageIdempotentAsync — async twin dedups the same way", async () => {
	const { manifest, cleanup } = makeFixture("idem-async");
	try {
		const first = await appendMailboxMessageIdempotentAsync(manifest, {
			direction: "inbox",
			from: "task-2",
			to: "task-1",
			taskId: "task-1",
			body: "async dm",
			kind: "message",
			requestId: `${RUN_ID}:task-2:async-1`,
		});
		const resend = await appendMailboxMessageIdempotentAsync(manifest, {
			direction: "inbox",
			from: "task-2",
			to: "task-1",
			taskId: "task-1",
			body: "async dm (retried)",
			kind: "message",
			requestId: `${RUN_ID}:task-2:async-1`,
		});
		assert.equal(first.deduped, false);
		assert.equal(resend.deduped, true);
		assert.equal(resend.message.id, first.message.id);
		assert.equal(readMailbox(manifest, "inbox", "task-1").length, 1);
	} finally {
		await cleanup();
	}
});

test("U5: findMailboxMessageByRequestId — scoped lookup + legacy data.requestId compat", async () => {
	const { manifest, cleanup } = makeFixture("lookup");
	try {
		appendMailboxMessageIdempotent(manifest, {
			direction: "inbox",
			from: "task-2",
			to: "task-1",
			taskId: "task-1",
			body: "scoped row",
			kind: "message",
			requestId: `${RUN_ID}:scope:1`,
		});
		const scoped = findMailboxMessageByRequestId(manifest, `${RUN_ID}:scope:1`, {
			direction: "inbox",
			taskId: "task-1",
		});
		assert.ok(scoped, "scoped lookup finds the task mailbox row");
		assert.equal(scoped.body, "scoped row");
		assert.equal(
			findMailboxMessageByRequestId(manifest, `${RUN_ID}:scope:1`, { direction: "inbox", taskId: "task-9" }),
			undefined,
			"a different task's mailbox must not match",
		);
		// Legacy shape: group_join rows keep `data.requestId` in the run-level
		// outbox — the unscoped lookup must keep finding them.
		appendMailboxMessage(manifest, {
			direction: "outbox",
			from: "group-join",
			to: "leader",
			body: "group join completed",
			status: "delivered",
			data: { kind: "group_join", requestId: `${RUN_ID}:group-join:completed:b1` },
		});
		const legacy = findMailboxMessageByRequestId(manifest, `${RUN_ID}:group-join:completed:b1`);
		assert.ok(legacy, "legacy data.requestId still matches (group_join compatibility)");
		assert.equal(legacy.data?.kind, "group_join");
	} finally {
		await cleanup();
	}
});

test("U5 ACCEPTANCE: restart mid-run + resume replay + resend → the worker receives EXACTLY ONCE", async () => {
	const { manifest, stateRoot, cleanup } = makeFixture("acceptance");
	try {
		const requestId = `${RUN_ID}:task-2:resume-1`;
		// ── Send (broker-style idempotent append to the task mailbox). ──
		const sent = appendMailboxMessageIdempotent(manifest, {
			direction: "inbox",
			from: "task-2",
			to: "task-1",
			taskId: "task-1",
			body: "api shape: parseArgs(cmd)",
			kind: "message",
			requestId,
		});
		assert.equal(sent.deduped, false);

		// ── Worker process #1 picks it up (fresh seen-set). ──
		const firstPickup = pollWorkerInbox({ stateRoot, runId: RUN_ID, taskId: "task-1", seenIds: new Set() });
		assert.equal(firstPickup.length, 1, "first delivery lands");
		assert.equal(firstPickup[0]!.requestId, requestId);
		// R5-1 (DR-02 2026-10-15): the durable ack is a separate phase the
		// delivery loop runs AFTER a successful send — mirror it here so the
		// restart assertions below exercise the real post-delivery state.
		acknowledgeWorkerInboxDelivery({ stateRoot, runId: RUN_ID, taskId: "task-1" }, firstPickup);

		// ── RESTART: a brand-new worker process — EMPTY seen-set, exactly the
		// state prompt-runtime.ts would build after a crash/resume. ──
		const afterRestart = pollWorkerInbox({ stateRoot, runId: RUN_ID, taskId: "task-1", seenIds: new Set() });
		assert.equal(afterRestart.length, 0, "durable dedup must survive the restart (the U5 hazard)");

		// ── RESUME: replayPendingMailboxMessages re-marks pending inbox rows —
		// the consumed row must NOT come back (delivery.json says acknowledged). ──
		const replay = replayPendingMailboxMessages(manifest);
		assert.equal(
			replay.messages.some((m) => m.id === sent.message.id),
			false,
			"resume replay must not re-queue the consumed message",
		);

		// ── RESEND: the same logical send retried with the SAME requestId. ──
		const resend = appendMailboxMessageIdempotent(manifest, {
			direction: "inbox",
			from: "task-2",
			to: "task-1",
			taskId: "task-1",
			body: "api shape: parseArgs(cmd) (retried)",
			kind: "message",
			requestId,
		});
		assert.equal(resend.deduped, true, "the resend is a no-op (existing row returned)");
		assert.equal(readMailbox(manifest, "inbox", "task-1").length, 1, "still exactly one row");

		// ── Worker process #2 (another restart) polls again. ──
		const afterResend = pollWorkerInbox({ stateRoot, runId: RUN_ID, taskId: "task-1", seenIds: new Set() });
		assert.equal(afterResend.length, 0, "resend must not re-deliver to a restarted worker");

		// EXACTLY ONCE in total: 1 delivery across all pickups.
		const totalDeliveries = firstPickup.length + afterRestart.length + afterResend.length;
		assert.equal(totalDeliveries, 1, "worker received the message EXACTLY ONCE");

		// ── The durable record backs both dedup layers. ──
		const delivery = readDeliveryState(manifest);
		assert.equal(delivery.messages[sent.message.id], "acknowledged");
		// M3-9 / R33-1: the index key is RECIPIENT-scoped (direction:taskId:requestId)
		// so a group fan-out requestId acked by one recipient never starves siblings.
		assert.equal(delivery.requestIds?.[`inbox:task-1:${requestId}`], sent.message.id);
		await drainEvents();
	} finally {
		await cleanup();
	}
});

test("U5: duplicate rows under one requestId (pre-U5 duplicates) deliver exactly once", async () => {
	const { manifest, stateRoot, cleanup } = makeFixture("dup-rows");
	try {
		const requestId = `${RUN_ID}:task-2:dup`;
		// Simulate legacy duplicate rows: plain appends bypassing the
		// idempotent wrapper, different ids, SAME requestId.
		for (const id of ["msg_dup_a", "msg_dup_b"]) {
			appendMailboxMessage(manifest, {
				id,
				direction: "inbox",
				from: "task-2",
				to: "task-1",
				taskId: "task-1",
				body: `duplicate ${id}`,
				kind: "message",
				requestId,
			});
		}
		const first = pollWorkerInbox({ stateRoot, runId: RUN_ID, taskId: "task-1", seenIds: new Set() });
		assert.equal(first.length, 1, "within-call requestId dedup — first row wins");
		assert.equal(first[0]!.id, "msg_dup_a");
		// R5-1: durable ack after the (successful) delivery.
		acknowledgeWorkerInboxDelivery({ stateRoot, runId: RUN_ID, taskId: "task-1" }, first);
		// Restart: the requestId index drops the second row too.
		const second = pollWorkerInbox({ stateRoot, runId: RUN_ID, taskId: "task-1", seenIds: new Set() });
		assert.equal(second.length, 0, "the sibling duplicate row never delivers");
		await drainEvents();
	} finally {
		await cleanup();
	}
});

test("U5 audit: events log the dedup chain (mailbox.pickup → mailbox.pickup_deduped)", async () => {
	const { manifest, stateRoot, cleanup } = makeFixture("audit");
	try {
		const requestId = `${RUN_ID}:task-2:audit-1`;
		appendMailboxMessageIdempotent(manifest, {
			direction: "inbox",
			from: "task-2",
			to: "task-1",
			taskId: "task-1",
			body: "audited dm",
			kind: "message",
			requestId,
		});
		const pickupOne = pollWorkerInbox({ stateRoot, runId: RUN_ID, taskId: "task-1", seenIds: new Set() });
		// R5-1: the pickup event is emitted by the post-send durable ack, not
		// by the poll itself — ack to complete the audited delivery.
		acknowledgeWorkerInboxDelivery({ stateRoot, runId: RUN_ID, taskId: "task-1" }, pickupOne);
		// "Restart": the next poll drops the row via the durable record and
		// logs ONE pickup_deduped event per key per process.
		pollWorkerInbox({ stateRoot, runId: RUN_ID, taskId: "task-1", seenIds: new Set() });
		pollWorkerInbox({ stateRoot, runId: RUN_ID, taskId: "task-1", seenIds: new Set() });
		// appendEventFireAndForget is async — wait for the audited chain.
		await waitForEvents(stateRoot, "mailbox.pickup", 1);
		await waitForEvents(stateRoot, "mailbox.pickup_deduped", 1);
		const events = readEvents(stateRoot);
		const pickups = events.filter((e) => e.type === "mailbox.pickup");
		assert.equal(pickups.length, 1, "one pickup event for the single delivery");
		assert.deepEqual(pickups[0]!.data?.requestIds, [requestId], "pickup event carries the requestId");
		const dedups = events.filter((e) => e.type === "mailbox.pickup_deduped");
		assert.equal(dedups.length, 1, "deduped skips log once per key per process (no 500ms-tick spam)");
		assert.equal(dedups[0]!.data?.requestId, requestId);
		assert.ok(["requestId", "acknowledged"].includes(String(dedups[0]!.data?.layer)), "layer is audited");
	} finally {
		await cleanup();
	}
});

/**
 * M3-9 / R33-1 (fix-wave 6, round-33 probe "1/0/0") — a group fan-out mints ONE
 * requestId and reuses it for every recipient (crew-broker handleMsgSend), so the
 * pickup dedup key MUST be recipient-scoped. Run-scoped, the first acking
 * recipient suppressed every sibling row at its own pickup: the probe observed
 * 1 delivered / 0 / 0 out of three recipients.
 *
 * Invariant under test: N recipients sharing one requestId each receive the
 * row exactly once, and each gets its OWN delivery-index entry.
 */
test("M3-9/R33-1: one group-fanout requestId delivers to ALL recipients (no 1/0/0 collapse)", async () => {
	const { manifest, stateRoot, cleanup } = makeFixture("fanout");
	const recipients = ["gc-a", "gc-b", "gc-c"];
	// The broker's fan-out shape: same requestId, one row per recipient mailbox.
	const requestId = `${RUN_ID}:leader:fanout-1`;
	for (const recipient of recipients) {
		appendMailboxMessage(manifest, {
			id: `msg_fanout_${recipient}`,
			direction: "inbox",
			from: "leader",
			to: recipient,
			taskId: recipient,
			body: `group broadcast for ${recipient}`,
			kind: "message",
			requestId,
		});
	}
	try {
		for (const recipient of recipients) {
			const picked = pollWorkerInbox({ stateRoot, runId: RUN_ID, taskId: recipient, seenIds: new Set() });
			assert.equal(picked.length, 1, `recipient ${recipient} must receive its copy`);
			assert.equal(picked[0]!.taskId, recipient);
			// Durable ack, exactly as the worker's post-send path does.
			acknowledgeWorkerInboxDelivery({ stateRoot, runId: RUN_ID, taskId: recipient }, picked);
		}
		// Each recipient owns a recipient-scoped index entry for the SHARED requestId.
		const delivery = readDeliveryState(manifest);
		for (const recipient of recipients) {
			assert.equal(
				delivery.requestIds?.[`inbox:${recipient}:${requestId}`],
				`msg_fanout_${recipient}`,
				`recipient-scoped delivery key for ${recipient}`,
			);
		}
		// Restart each worker: the durable record still prevents a SECOND delivery
		// to anyone (exactly-once is not weakened by the scoping).
		for (const recipient of recipients) {
			const afterRestart = pollWorkerInbox({ stateRoot, runId: RUN_ID, taskId: recipient, seenIds: new Set() });
			assert.equal(afterRestart.length, 0, `${recipient} must not re-deliver after restart`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	} finally {
		await cleanup();
	}
});
