/**
 * Nested-slot budget for delegate-spawned grandchildren (ADR-5 §2, WP-5 step 3).
 *
 * Grandchildren NEVER ride the global worker semaphore — a waiting parent
 * worker keeps holding its own global slot, so ride-along spawn is the
 * permanent-deadlock shape the repo already records for the judge
 * (`scheduling/global-worker-cap.ts:14-19` MAJ#3). Instead the root-side
 * delegate handler draws from THIS separate budget:
 *
 *   max = max(1, floor(globalSem / 2))    (or an explicit config override)
 *
 * FAIL-FAST, NEVER QUEUE: when the budget is exhausted, `tryAcquire` returns
 * false immediately — the caller rejects the delegate with a policy message
 * ("nested spawn budget exhausted; N/M in flight"). No waiting, no queueing.
 *
 * The budget is owned by the single root-side delegate handler process, so an
 * in-memory id-keyed map is the source of truth (no disk state).
 */

export interface NestedSlotSnapshot {
	used: number;
	max: number;
}

/** Compute the nested-slot budget from the global worker semaphore. */
export function defaultNestedSlotBudget(globalWorkerSemaphore: number): number {
	return Math.max(1, Math.floor(globalWorkerSemaphore / 2));
}

/**
 * U11 (hybrid 2-tier worker model): default ceiling for concurrently
 * in-flight EMBEDDED sessions — the same conservative half-of-cap heuristic
 * as the nested-slot budget. This is the blast-radius bound (spec U11 risk
 * #2: "1 worker exception/OOM hạ host + mọi team" — mitigation: limit N
 * embedded đồng thời), NOT a throughput bound: total tier concurrency is
 * bounded by the SHARED global worker semaphore; this ceiling only caps how
 * much of that budget may be embedded at once.
 */
export function defaultEmbeddedSlotCeiling(globalWorkerSemaphore: number): number {
	return Math.max(1, Math.floor(globalWorkerSemaphore / 2));
}

/**
 * U11: build the embedded-session ceiling. Reuses the NestedSlotBudget
 * fail-fast shape on purpose (budget extension per spec: "slot budget toàn
 * cục chung 2 tier (nested-slots mở rộng)"): id-keyed, idempotent
 * re-acquire, exhausted → tryAcquire returns false and the caller reroutes
 * the task to the subprocess tier IMMEDIATELY (never queues on the ceiling
 * — a rerouted task still queues on the shared global worker budget like
 * any other subprocess task).
 */
export function createEmbeddedSlotBudget(globalWorkerSemaphore: number, maxConcurrent?: number): NestedSlotBudget {
	return new NestedSlotBudget(globalWorkerSemaphore, maxConcurrent ?? defaultEmbeddedSlotCeiling(globalWorkerSemaphore));
}

export class NestedSlotBudget {
	private readonly held = new Set<string>();
	readonly max: number;

	constructor(globalWorkerSemaphore: number, override?: number) {
		if (override !== undefined && (!Number.isFinite(override) || override < 1)) {
			throw new TypeError(`nesting.maxSlots must be a positive integer, got ${String(override)}`);
		}
		this.max = override ?? defaultNestedSlotBudget(globalWorkerSemaphore);
	}

	/**
	 * Try to reserve one nested slot for the given grandchild id.
	 * Fail-fast: returns false when the budget is exhausted — the caller MUST
	 * reject the delegate immediately (never queue).
	 */
	tryAcquire(grandchildId: string): boolean {
		if (this.held.has(grandchildId)) return true; // idempotent re-acquire
		if (this.held.size >= this.max) return false;
		this.held.add(grandchildId);
		return true;
	}

	/** Release the slot held by a finished/dead grandchild. Idempotent. */
	release(grandchildId: string): void {
		this.held.delete(grandchildId);
	}

	get used(): number {
		return this.held.size;
	}

	/** Human-facing status line for policy messages: "N/M in flight". */
	get statusLine(): string {
		return `${this.held.size}/${this.max} in flight`;
	}

	snapshot(): NestedSlotSnapshot {
		return { used: this.held.size, max: this.max };
	}
}
