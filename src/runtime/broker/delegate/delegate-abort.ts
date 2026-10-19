/**
 * delegate-abort.ts — in-flight grandchild cancellation (M3-5 / R43-N3).
 *
 * R43-N3 (2026-10-18 round 43, fix-wave 6): the `delegate.request` handler
 * spawned the grandchild inside a detached `void (async () => …)()` with NO
 * abort path — `CrewBroker.stop()` only cleared its token maps, and the
 * team-runner's terminalise path drained its OWN dispatch units only. So a
 * budget abort / run cancel / broker teardown left grandchildren running with
 * a 900s-…-86400s deadline of their own, still burning tokens and still
 * holding nested slots (R43-N3: "orphans keep spending up to 24h").
 *
 * This module is the missing link: the broker registers one AbortController
 * per live grandchild, the spawner subscribes to it (delegate-spawn.ts
 * `signal`), and every terminal path aborts them.
 *
 * Two process-local wiring layers:
 *  1. {@link DelegateAbortRegistry} — owned by the broker instance (one per
 *     root session), keyed by grandchild subId.
 *  2. {@link setActiveDelegateAborter} / {@link abortRunDelegates} — the
 *     process-local singleton the runner side calls without holding a broker
 *     reference (mirrors `broker-issuer.ts`'s issuer/revoker registry: a
 *     function reference only, never a token).
 */

export interface DelegateAbortReason {
	/** Machine-readable cause, recorded on the `delegate.cancelled` event. */
	reason: string;
}

/**
 * Per-broker registry of live grandchild abort controllers.
 *
 * Invariants:
 *  - `register` is called BEFORE the spawner starts (so a terminal event that
 *    lands during the spawn still cancels it);
 *  - `release` is called from the settle `finally` — a settled delegate never
 *    lingers in the map (bounded memory, no double-abort of a reused subId —
 *    subIds are UUIDs, so reuse is impossible anyway);
 *  - `abortAll` is idempotent (AbortController.abort() is idempotent).
 */
export class DelegateAbortRegistry {
	private readonly controllers = new Map<string, { runId: string; controller: AbortController }>();

	/** Number of in-flight grandchildren (diagnostics / tests). */
	get size(): number {
		return this.controllers.size;
	}

	/** Register a controller for `subId` (owned by `runId`) for the spawner. */
	register(subId: string, runId: string): AbortController {
		const controller = new AbortController();
		this.controllers.set(subId, { runId, controller });
		return controller;
	}

	/** Drop the controller (settle path). Never aborts. */
	release(subId: string): void {
		this.controllers.delete(subId);
	}

	/** Abort every in-flight grandchild of ONE run. Returns the count aborted. */
	abortRun(runId: string, reason: DelegateAbortReason): number {
		return this.abortWhere((entry) => entry.runId === runId, reason);
	}

	/** Abort every in-flight grandchild (broker teardown). Returns the count. */
	abortAll(reason: DelegateAbortReason): number {
		return this.abortWhere(() => true, reason);
	}

	private abortWhere(predicate: (entry: { runId: string }) => boolean, reason: DelegateAbortReason): number {
		const victims = [...this.controllers.entries()].filter(([, entry]) => predicate(entry));
		for (const [subId, entry] of victims) {
			// The reason rides the signal so the spawner can tell an owner abort
			// (R43-N3 cancellation) from its own deadline timeout.
			entry.controller.abort(new Error(reason.reason));
			this.controllers.delete(subId);
		}
		return victims.length;
	}
}

/**
 * Process-local aborter: `runId` — abort every in-flight grandchild of that
 * run. A run-scoped signature (not global) keeps a multi-run root session from
 * killing another run's grandchildren; the registry itself is per broker but
 * tracks runId per entry via the closure the lifecycle controller installs.
 */
export type DelegateAborter = (runId: string, reason: string) => number;

let activeAborter: DelegateAborter | undefined;

/** Register the active aborter (called by the broker lifecycle controller). */
export function setActiveDelegateAborter(aborter: DelegateAborter | undefined): void {
	activeAborter = aborter;
}

/** Read the active aborter, if any (undefined = no broker wired). */
export function getActiveDelegateAborter(): DelegateAborter | undefined {
	return activeAborter;
}

/**
 * Abort in-flight grandchildren of `runId` through the active broker.
 *
 * Returns the number aborted (0 when no broker is wired — e.g. a headless
 * runner without a root session). Never throws: this is called from terminal /
 * abort paths that must not fail on a broker hiccup.
 */
export function abortRunDelegates(runId: string, reason: string): number {
	const aborter = activeAborter;
	if (!aborter) return 0;
	try {
		return aborter(runId, reason);
	} catch {
		return 0;
	}
}
