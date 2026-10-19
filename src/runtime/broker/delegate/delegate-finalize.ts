/**
 * delegate-finalize.ts — broker-side SETTLE path for a delegate grandchild
 * (ADR-5 §1/§5). Moved out of the `delegate.request` handler's fire-and-forget
 * async IIFE (crew-broker.ts) by fix-wave 6 — behaviour change, not pure code
 * motion: R43-N4 + R44-N4 are fixed here.
 *
 * R43-N4 (2026-10-19): the grandchild's fenced result used to be appended to
 * the PARENT task's mailbox unconditionally. When the parent had already
 * reached a terminal status (cancelled by a budget abort, failed, killed) that
 * row was written into a mailbox nobody reads again — the result was silently
 * dropped, permanently. {@link delegateResultTarget} now decides the
 * destination from the parent record read INSIDE the run lock: a terminal (or
 * missing) parent redirects the result to the RUN-level inbox (the
 * orchestrator/leader channel) with `data.reroutedFrom` + a
 * `delegate.rerouted` event, so a dead parent can no longer swallow an
 * in-flight grandchild's output.
 *
 * R44-N4 (2026-10-19): usage roll-up is now BROKER-SIDE. Before this change
 * the reservation written at admission was reconciled against the CHILD's own
 * `message_end` self-report (`actual = clamp(selfReported, 0, reserved)`), so a
 * child that under-reported refunded almost its whole reservation — the budget
 * charge was self-attested (`probe-n4`: under-report refunded 49 999 of a
 * 50 000 reserve). The charge is now the HOST-decided reservation, full stop:
 * the admission reserve IS the spend, and nothing at settle time can reduce
 * it. The child's number is still recorded on `delegate.rolled_up`
 * (`selfReportedTokens`) for observability only — never as a charge.
 * Consequence: the P2-8c "best-effort refund when finalize fails" path is gone
 * with it (a failed finalize must NOT hand back budget the run may have
 * consumed — the conservative direction).
 */

import { isTerminalTaskStatus } from "../../../state/contracts.ts";
import { withRunLockSync } from "../../../state/coordination/locks.ts";
import { appendMailboxMessageAsync } from "../../../state/coordination/mailbox.ts";
import { loadRunManifestById, saveRunTasks } from "../../../state/stores/state-store.ts";
import type { TeamTaskState } from "../../../state/types.ts";
import { logInternalError } from "../../../utils/internal-error.ts";
import { recordDelegateEvent } from "./delegate-event.ts";

/** Destination of a settled grandchild's fenced result. */
export type DelegateResultTarget = "parent" | "run-mailbox";

export interface DelegateFinalizeInput {
	/** Broker cwd (manifest lookup). */
	brokerCwd: string;
	runId: string;
	parentTaskId: string;
	/** Grandchild shadow-task id (`gc-*`) — also the mailbox `from` suffix. */
	subId: string;
	/** Already-fenced result body (caller neutralizes smuggled fence markers). */
	fenced: string;
	ok: boolean;
	timedOut?: boolean;
	/** Pessimistic reservation written at admission (0 = unmetered request).
	 *  THIS is the broker-side charge — see the R44-N4 note above. */
	reservedTokens: number;
	/** Child-emitted usage, AUDIT ONLY (self-attested, never charged). */
	selfReportedTokens?: number;
}

export interface DelegateFinalizeOutcome {
	/** Where the result went, or "none" when the run record was gone. */
	delivery: DelegateResultTarget | "none";
	/** Broker-side charge applied to the parent allocation (unit: TOKENS). */
	chargedTokens: number;
}

/**
 * R43-N4: pick the result destination from the parent task RECORD.
 *
 * - parent still live (queued/running/waiting) → its own mailbox (unchanged);
 * - parent gone or terminal (completed/failed/cancelled/skipped/…) → the run
 *   mailbox, i.e. the leader channel. Terminal includes `completed`: a parent
 *   that finished before its grandchild settled cannot consume the row either.
 */
export function delegateResultTarget(parentStatus: TeamTaskState["status"] | undefined): DelegateResultTarget {
	if (parentStatus === undefined) return "run-mailbox";
	return isTerminalTaskStatus(parentStatus) ? "run-mailbox" : "parent";
}

/** M3-5/R43-N3: the terminal event for a settled grandchild — owner-abort is
 *  distinct from the grandchild's own deadline in the audit trail. */
export function delegateTerminalEvent(outcome: {
	ok: boolean;
	timedOut?: boolean;
	cancelled?: boolean;
}): "delegate.completed" | "delegate.timed_out" | "delegate.cancelled" {
	if (outcome.cancelled === true) return "delegate.cancelled";
	return outcome.timedOut === true ? "delegate.timed_out" : "delegate.completed";
}

/**
 * Settle a grandchild: deliver the fenced result, charge the budget, terminal-
 * flip the shadow record. All writes happen INSIDE one run lock, computed off
 * a fresh disk read (never a pre-spawn snapshot).
 *
 * Never throws: every failure is logged (the caller is a detached async task —
 * a throw here would become an unhandled rejection).
 */
export function finalizeDelegateResult(input: DelegateFinalizeInput): DelegateFinalizeOutcome {
	try {
		const loaded = loadRunManifestById(input.brokerCwd, input.runId);
		if (!loaded) return { delivery: "none", chargedTokens: 0 };
		// Boxed state — read back AFTER the lock closure (a plain `let` would be
		// narrowed to its initial literal by control-flow analysis).
		const state: { delivery: DelegateResultTarget | "none" } = { delivery: "none" };
		withRunLockSync(loaded.manifest, () => {
			const latest = loadRunManifestById(input.brokerCwd, input.runId);
			if (!latest) return;
			const parent = latest.tasks.find((t) => t.id === input.parentTaskId);
			const delivery = delegateResultTarget(parent?.status);
			state.delivery = delivery;
			// Durable delivery (ADR-5 §1): fenced result into the parent task's
			// mailbox, or into the run inbox when the parent can no longer read
			// it (R43-N4). `appendMailboxMessageAsync` is fire-and-forget here —
			// the append itself takes the mailbox file lock, and blocking the run
			// lock on it would serialize every settle behind disk I/O.
			void appendMailboxMessageAsync(latest.manifest, {
				direction: "inbox",
				from: `delegate:${input.subId}`,
				to: delivery === "parent" ? input.parentTaskId : "leader",
				...(delivery === "parent" ? { taskId: input.parentTaskId } : {}),
				body: input.fenced,
				kind: "response",
				data: {
					subId: input.subId,
					ok: input.ok,
					timedOut: input.timedOut === true,
					...(delivery === "parent" ? {} : { reroutedFrom: input.parentTaskId, reason: "parent-terminal" }),
				},
			}).catch((err) =>
				logInternalError(
					"crew-broker.delegate.mailbox",
					err instanceof Error ? err : new Error(String(err)),
					`runId=${input.runId} subId=${input.subId} delivery=${delivery}`,
				),
			);
			if (delivery === "run-mailbox") {
				recordDelegateEvent(latest.manifest, "delegate.rerouted", input.parentTaskId, {
					subId: input.subId,
					parentStatus: parent?.status ?? "missing",
				});
			}
			// R44-N4: no refund, no reconciliation write — the admission reserve
			// is the charge, so `allocation.tokensSpent` already holds it on disk.
			// Only audit the (untrusted) child number.
			if (input.reservedTokens > 0) {
				recordDelegateEvent(latest.manifest, "delegate.rolled_up", input.parentTaskId, {
					subId: input.subId,
					chargedTokens: input.reservedTokens,
					...(input.selfReportedTokens !== undefined ? { selfReportedTokens: input.selfReportedTokens } : {}),
				});
			}
			// S1#1 (verifier N1): the terminal flip is UNCONDITIONAL — never
			// depends on a reservation. RR-012 F16: onSpawn promoted the record to
			// "running" during execution; this flip terminalizes every settle path.
			saveRunTasks(
				latest.manifest,
				latest.tasks.map((t) =>
					t.id === input.subId
						? {
								...t,
								status: input.ok ? ("completed" as const) : ("failed" as const),
								completedAt: new Date().toISOString(),
							}
						: t,
				),
			);
		});
		return { delivery: state.delivery, chargedTokens: input.reservedTokens };
	} catch (err) {
		logInternalError(
			"crew-broker.delegate.finalize",
			err instanceof Error ? err : new Error(String(err)),
			`runId=${input.runId} subId=${input.subId}`,
		);
		return { delivery: "none", chargedTokens: 0 };
	}
}
