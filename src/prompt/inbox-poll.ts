/**
 * inbox-poll.ts — Task 5 (SDD 2026-08-26-loadout-nesting-messaging) worker
 * inbox pickup.
 *
 * The worker-side `message` tool (D9 / §15.2) writes durable mailbox
 * entries (`kind:"message"` | `"notify"`). This module is the RECEIVE side:
 * the poll loop that shares the ask/delegate cadence picks up new
 * `kind:"message"` entries addressed to THIS task and surfaces them as
 * fenced context at the next turn boundary via `pi.sendMessage` with
 * `deliverAs:"steer"`.
 *
 * Contract (mirrors the broker's recipient resolution in handleMsgSend):
 *   - only `kind:"message"` enters the pickup (notify → fire-and-forget,
 *     steer/response/follow-up → other channels);
 *   - only entries whose mailbox task is THIS worker (`taskId === this`):
 *     sibling DMs are written to the sibling's task mailbox, group-broadcast
 *     recipient copies are written to each recipient's task mailbox, and
 *     `to:"parent"` reports land in the run-level inbox (taskId undefined)
 *     which is ORCHESTRATOR territory — a worker must never read it;
 *   - a worker must never pick up a message whose `from` is itself (§15.3
 *     anti-spoof / self-echo: the broker overrides `from` to the sender's
 *     authenticated taskId, so a group broadcast returns to its sender and
 *     must be dropped at consume time);
 *   - dedup by message id across polls via a caller-owned seen-set and/or a
 *     `sinceTs` watermark — one message delivers once;
 *   - U5 (2026-10-10): dedup is ALSO durable across restarts — delivered
 *     rows are recorded in delivery.json (`messages[id]="acknowledged"` +
 *     `${direction}:${requestId}` index) and re-read on the next poll, so a
 *     worker that restarts mid-run (fresh process, EMPTY seen-set) never
 *     re-delivers. A resend carrying the same requestId is dropped by the
 *     same index; duplicate rows under one requestId deliver exactly once.
 *   - R5-1 (DR-02, 2026-10-15): the durable record is written in TWO PHASES.
 *     `pollWorkerInbox` only picks rows and marks the IN-MEMORY seen-set;
 *     the durable "acknowledged" write lives in
 *     `acknowledgeWorkerInboxDelivery`, which the delivery loop calls ONLY
 *     after `pi.sendMessage` succeeded. A send that throws must instead call
 *     `unmarkSeenInboxIds` so the next tick re-picks the batch — at-least-once
 *     beats the pre-fix at-most-once-with-a-false-"delivered"-audit-record.
 */
import * as path from "node:path";
import {
	type MailboxDeliveryState,
	type MailboxMessage,
	readAllMailboxMessages,
	readDeliveryState,
	recordMailboxRequestIdDelivery,
} from "../state/coordination/mailbox.ts";
import { appendEventFireAndForget } from "../state/event-log/event-log.ts";
import type { TeamRunManifest } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";

export interface WorkerInboxPickup {
	stateRoot: string;
	runId: string;
	taskId: string;
	/** Watermark: only messages with `createdAt > sinceTs` are considered. */
	sinceTs?: string;
	/** Mutable seen-id set for cross-poll dedup (the poll loop owns it). */
	seenIds?: Set<string>;
}

/** U5: requestId of a row — the U5 top-level field with the legacy
 *  `data.requestId` shape (group_join) as fallback. */
function messageIdempotencyKey(message: MailboxMessage): string | undefined {
	if (message.requestId) return message.requestId;
	const fromData = message.data?.requestId;
	return typeof fromData === "string" ? fromData : undefined;
}

// U5: in-process throttle for `mailbox.pickup_deduped` audit events — a
// restarted worker re-scans the same durable rows on EVERY 500ms tick, so an
// un-throttled per-skip event would spam the log (2/s/row). One event per
// (run, task, key) per process lifetime is the audit signal ("redelivery was
// prevented by the durable record"); bounded FIFO like the parse caches.
const DEDUP_EVENT_KEYS_MAX = 512;
const dedupEventKeys = new Map<string, true>();

function shouldEmitDedupEvent(runId: string, taskId: string, key: string): boolean {
	const mapKey = `${runId}:${taskId}:${key}`;
	if (dedupEventKeys.has(mapKey)) return false;
	dedupEventKeys.set(mapKey, true);
	while (dedupEventKeys.size > DEDUP_EVENT_KEYS_MAX) {
		const oldest = dedupEventKeys.keys().next().value;
		if (oldest === undefined) break;
		dedupEventKeys.delete(oldest);
	}
	return true;
}

/** U5: audit event for a redelivery that the DURABLE record prevented (the
 *  in-memory seen-set alone could not — this is exactly the restart window). */
function emitPickupDedupedEvent(stateRoot: string, runId: string, taskId: string, message: MailboxMessage, layer: string): void {
	if (!shouldEmitDedupEvent(runId, taskId, `${layer}:${message.id}`)) return;
	try {
		appendEventFireAndForget(path.join(stateRoot, "events.jsonl"), {
			type: "mailbox.pickup_deduped",
			runId,
			taskId,
			message: `Dropped duplicate inbox delivery (${layer}) for task ${taskId}.`,
			data: {
				layer,
				messageId: message.id,
				requestId: messageIdempotencyKey(message),
				from: message.from,
				kind: message.kind,
			},
		});
	} catch (error) {
		logInternalError("inbox-poll.pickup-deduped-event", error, `runId=${runId} taskId=${taskId}`);
	}
}

/** U5: audit event for a successful pickup — with the requestId, the event
 *  log is sufficient to audit the dedup chain end-to-end (broker
 *  `mailbox.send` → worker `mailbox.pickup` → `mailbox.pickup_deduped`). */
function emitPickupEvent(stateRoot: string, runId: string, taskId: string, picked: MailboxMessage[]): void {
	try {
		appendEventFireAndForget(path.join(stateRoot, "events.jsonl"), {
			type: "mailbox.pickup",
			runId,
			taskId,
			message: `Picked up ${picked.length} inbox message(s) for task ${taskId}.`,
			data: {
				messageIds: picked.map((m) => m.id),
				requestIds: picked.map((m) => messageIdempotencyKey(m) ?? null),
			},
		});
	} catch (error) {
		logInternalError("inbox-poll.pickup-event", error, `runId=${runId} taskId=${taskId}`);
	}
}

/**
 * Read the worker's inbox mailbox and return the messages that should be
 * surfaced as fenced context on the next turn. PICKUP PHASE ONLY (R5-1):
 * picked rows are marked in the caller-owned in-memory seen-set, but the
 * durable delivery record is NOT written here — the caller must run
 * {@link acknowledgeWorkerInboxDelivery} after its send succeeded, and
 * {@link unmarkSeenInboxIds} when the send threw.
 *
 * `limit` (R5-2, DR-02): pick at most this many rows per call (callers pass
 * their per-tick batch cap). Leftover rows are simply not picked — not
 * marked, in memory or durably — and flow on a later tick.
 *
 * Stateless apart from the optional caller-owned `seenIds`/`sinceTs` — safe
 * to call on every 500ms poll tick. U5: the durable dedup-read checks
 * (acknowledged rows / delivered requestIds) still run here so dedup
 * survives a restart.
 */
export function pollWorkerInbox(pickup: WorkerInboxPickup, limit?: number): MailboxMessage[] {
	const { stateRoot, runId, taskId } = pickup;
	if (!stateRoot || !runId || !taskId) return [];
	const manifest = { stateRoot, runId } as unknown as TeamRunManifest;
	let messages: MailboxMessage[];
	let delivery: MailboxDeliveryState;
	try {
		// readAllMailboxMessages already merges run-level inbox + every task
		// mailbox; we route TO this worker below (never trust a caller-scoped
		// file path).
		messages = readAllMailboxMessages(manifest, "inbox");
		// U5: the durable delivery record (mtime-cached read — cheap on the
		// 500ms tick) is the restart-safe dedup source of truth.
		delivery = readDeliveryState(manifest);
	} catch {
		// Transient read error (lock contention, rotated file) — never throw
		// out of a poll tick; the next 500ms tick retries.
		return [];
	}

	const seen = pickup.seenIds;
	const deliveredRequestIds = delivery.requestIds ?? {};
	const picked: MailboxMessage[] = [];
	const byId = new Set<string>();
	const byRequestId = new Set<string>();
	for (const m of messages) {
		// R5-2 (DR-02): enforce the batch cap AT PICKUP, not at the send site —
		// every picked row must also be a row the caller can actually send (and
		// later acknowledge). The pre-fix shape picked N rows, durably acked all
		// N, then sliced 8 for the send — the surplus was never re-delivered.
		if (limit !== undefined && picked.length >= limit) break;
		// Kind gate: only durable `message`s (per §15.2). Notify is
		// fire-and-forget (its own channel), steer/response/follow-up are
		// other delivery paths.
		if (m.kind !== "message") continue;
		// §15.3 self-echo: a broadcast the worker itself sent must not
		// re-surface on its own next turn.
		if (m.from === taskId) continue;
		// Routing: the entry must be in THIS task's mailbox — never the
		// run-level inbox (orchestrator's parent channel) nor a sibling's.
		if (m.taskId !== taskId) continue;
		if (m.status === "acknowledged") continue;
		// sinceTs watermark (ISO string compare).
		if (pickup.sinceTs !== undefined && m.createdAt <= pickup.sinceTs) continue;
		// Cross-call seen-set dedup.
		if (seen?.has(m.id)) continue;
		// Within-call id dedup (duplicate file rows → one delivery).
		if (byId.has(m.id)) continue;
		// ── U5 durable dedup (2026-10-10) ──────────────────────────────────
		// These two layers survive a worker restart (delivery.json); the
		// in-memory gates above cannot. Every skip here is a redelivery that
		// was PREVENTED — audited via mailbox.pickup_deduped (once per key
		// per process so the 500ms re-scan cannot spam the event log).
		const requestId = messageIdempotencyKey(m);
		const dedupKey = requestId !== undefined ? `${m.direction}:${requestId}` : undefined;
		if (dedupKey !== undefined) {
			// (direction, requestId) index — catches resends carrying the same
			// requestId AND duplicate rows under one requestId.
			if (deliveredRequestIds[dedupKey] !== undefined) {
				emitPickupDedupedEvent(stateRoot, runId, taskId, m, "requestId");
				continue;
			}
			// Within-call requestId dedup (two rows, one requestId → first wins).
			if (byRequestId.has(dedupKey)) continue;
		}
		// Acknowledged delivery entry = the F09 durable "handled" record; the
		// inbox line itself keeps `status:"queued"` forever, so WITHOUT this
		// check a restarted worker re-delivers every already-consumed row
		// (legacy rows without a requestId land here too).
		if (delivery.messages[m.id] === "acknowledged") {
			emitPickupDedupedEvent(stateRoot, runId, taskId, m, "acknowledged");
			continue;
		}
		byId.add(m.id);
		if (dedupKey !== undefined) byRequestId.add(dedupKey);
		seen?.add(m.id);
		picked.push(m);
	}
	// Deterministic delivery order (same sort readAllMailboxMessages applies).
	return picked;
}

/**
 * R5-1 (DR-02, 2026-10-15): durable-ack phase of the pickup, split OUT of
 * `pollWorkerInbox`. The caller invokes this ONLY after the picked rows were
 * successfully delivered (`pi.sendMessage` returned) — the durable
 * "acknowledged" record and the pickup audit event must never precede a send
 * that can fail (the pre-fix bug wrote them BEFORE the send, so a send
 * failure produced a permanent false "delivered" record plus silent message
 * loss). Mid-batch all-or-nothing: recordMailboxRequestIdDelivery is a single
 * locked RMW, so acks are atomic per call.
 *
 * Best-effort on failure (never throws into the poll tick): the in-memory
 * seen-set still dedups within THIS process, and logInternalError makes the
 * lost-durability window visible.
 */
export function acknowledgeWorkerInboxDelivery(
	pickup: Pick<WorkerInboxPickup, "stateRoot" | "runId" | "taskId">,
	picked: MailboxMessage[],
): void {
	const { stateRoot, runId, taskId } = pickup;
	if (!stateRoot || !runId || !taskId || picked.length === 0) return;
	const manifest = { stateRoot, runId } as unknown as TeamRunManifest;
	try {
		// U5: persist the delivery — the durable record that powers the two
		// dedup layers above after a restart.
		recordMailboxRequestIdDelivery(
			manifest,
			picked.map((m) => ({
				direction: m.direction,
				messageId: m.id,
				requestId: messageIdempotencyKey(m),
			})),
		);
		emitPickupEvent(stateRoot, runId, taskId, picked);
	} catch (error) {
		logInternalError("inbox-poll.record-delivery", error, `runId=${runId} taskId=${taskId}`);
	}
}

/**
 * R5-1 (DR-02): release the in-memory seen marks for a batch whose
 * `pi.sendMessage` THREW, so the next poll tick re-picks and re-delivers it
 * (at-least-once beats at-most-once with a false "delivered" audit record).
 * Mirrors the steer channel's `seenSteers.unmark` + offset-rewind
 * compensation in prompt-runtime.ts pollSteering.
 */
export function unmarkSeenInboxIds(seen: Set<string> | undefined, picked: MailboxMessage[]): void {
	if (!seen) return;
	for (const m of picked) seen.delete(m.id);
}
