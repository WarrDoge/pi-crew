/**
 * BatchBarrier — Rule 1 (no-wait batch grouping).
 *
 * When a leader launches several background subagents with the SAME `batchId`
 * and does NOT join them immediately (`get_subagent_result(wait:true)`), the
 * completion notifications are coalesced: instead of N individual
 * "changed state" wake-ups, the leader receives ONE consolidated notification
 * once ALL members of the batch have reached a terminal state.
 *
 * Semantics:
 * - `register(batchId, agentId)` is called at spawn time (synchronous within a
 *   leader turn). All members of a batch are therefore known by the time the
 *   first completion fires (completion is observed via the 1000ms poll loop).
 * - `markTerminal(batchId, agentId)` returns whether THIS completion made every
 *   registered member terminal ("allDone"). When allDone, the caller emits a
 *   single consolidated notification and calls `markNotified`.
 * - If a member reaches terminal after the batch already notified (late spawn
 *   edge case), `markTerminal` returns allDone=false for the straggler path is
 *   NOT covered — but `alreadyNotified` lets the caller suppress stray
 *   individual notifications once the consolidated one fired.
 *
 * Thread-safety: single-threaded JS event loop. No locks needed.
 */

export interface BatchMember {
	id: string;
	description?: string;
	type?: string;
	status: string;
}

export interface BatchSnapshot {
	batchId: string;
	members: BatchMember[];
	terminal: BatchMember[];
	/** true when every registered member has reached a terminal state. */
	allDone: boolean;
	/** true once the consolidated notification has been emitted. */
	notified: boolean;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "error", "stopped"]);

export function isTerminalStatus(status: string): boolean {
	return TERMINAL_STATUSES.has(status);
}

export class BatchBarrier {
	private readonly batches = new Map<
		string,
		{
			members: Map<string, BatchMember>;
			terminal: Map<string, BatchMember>;
			notified: boolean;
		}
	>();

	/** R2-L-B6 (SEV-10): consolidated-notified batches are FREED (member maps
	 * dropped) and remembered here as tombstones so `alreadyNotified` stays
	 * true and late `markTerminal`/`register` calls never re-notify. Bounded
	 * (evict-oldest) — previously every batchId leaked its member maps for the
	 * session lifetime (zero production callers of dispose()). */
	private readonly notifiedTombstones = new Map<string, number>();
	private static readonly TOMBSTONE_CAP = 256;

	/** Register a member at spawn time. Idempotent per (batchId, agentId).
	 * R2-L-B6: no-op for a tombstoned (already notified) batch — the member
	 * map is intentionally gone and must not resurrect a re-notifiable batch. */
	register(batchId: string, agentId: string, meta?: { description?: string; type?: string }): void {
		if (this.notifiedTombstones.has(batchId)) return;
		let batch = this.batches.get(batchId);
		if (!batch) {
			batch = {
				members: new Map(),
				terminal: new Map(),
				notified: false,
			};
			this.batches.set(batchId, batch);
		}
		if (!batch.members.has(agentId)) {
			batch.members.set(agentId, {
				id: agentId,
				description: meta?.description,
				type: meta?.type,
				status: "running",
			});
		}
	}

	/**
	 * Record that a member reached a terminal state. Returns the batch snapshot.
	 * `snapshot.allDone` is true iff every registered member is now terminal.
	 * If the batch was never seen (defensive edge case), the member is registered
	 * on-the-fly as a batch-of-one so its terminal state is not silently lost.
	 */
	markTerminal(batchId: string, member: BatchMember): BatchSnapshot {
		// R2-L-B6: the batch already fired its consolidated notification and was
		// freed — report notified:true so the caller NEVER re-notifies a late
		// member (documented late-spawn semantics), without resurrecting the map.
		if (this.notifiedTombstones.has(batchId)) {
			return {
				batchId,
				members: [{ ...member }],
				terminal: [{ ...member }],
				allDone: true,
				notified: true,
			};
		}
		let batch = this.batches.get(batchId);
		if (!batch) {
			batch = {
				members: new Map(),
				terminal: new Map(),
				notified: false,
			};
			this.batches.set(batchId, batch);
		}
		// Ensure the member is known (auto-register for the defensive case).
		if (!batch.members.has(member.id)) {
			batch.members.set(member.id, { ...member, status: member.status });
		}
		if (isTerminalStatus(member.status)) {
			batch.terminal.set(member.id, { ...member });
			const existing = batch.members.get(member.id);
			if (existing)
				batch.members.set(member.id, {
					...existing,
					status: member.status,
				});
		}
		const allDone = batch.members.size > 0 && [...batch.members.keys()].every((id) => batch.terminal.has(id));
		return {
			batchId,
			members: [...batch.members.values()],
			terminal: [...batch.terminal.values()],
			allDone,
			notified: batch.notified,
		};
	}

	/** Has the consolidated notification already been emitted for this batch? */
	alreadyNotified(batchId: string): boolean {
		return this.batches.get(batchId)?.notified ?? this.notifiedTombstones.has(batchId);
	}

	/** Mark the consolidated notification as emitted. No-op if already set.
	 * R2-L-B6: DISPOSE the batch here — once the consolidated notify fired, the
	 * member maps are dead weight; keep only a bounded tombstone so
	 * `alreadyNotified`/late `markTerminal` preserve their answers. */
	markNotified(batchId: string): void {
		const batch = this.batches.get(batchId);
		if (batch) batch.notified = true;
		this.batches.delete(batchId);
		this.notifiedTombstones.set(batchId, Date.now());
		if (this.notifiedTombstones.size > BatchBarrier.TOMBSTONE_CAP) {
			const oldest = this.notifiedTombstones.keys().next().value;
			if (oldest !== undefined) this.notifiedTombstones.delete(oldest);
		}
	}

	/** Read-only snapshot (for tests / debugging). */
	snapshot(batchId: string): BatchSnapshot | undefined {
		const batch = this.batches.get(batchId);
		if (!batch) return undefined;
		return {
			batchId,
			members: [...batch.members.values()],
			terminal: [...batch.terminal.values()],
			allDone: batch.members.size > 0 && [...batch.members.keys()].every((id) => batch.terminal.has(id)),
			notified: batch.notified,
		};
	}

	/** Drop a batch (used on cleanup / test reset). */
	dispose(batchId?: string): void {
		if (batchId === undefined) {
			this.batches.clear();
			this.notifiedTombstones.clear();
		} else {
			this.batches.delete(batchId);
			this.notifiedTombstones.delete(batchId);
		}
	}
}
