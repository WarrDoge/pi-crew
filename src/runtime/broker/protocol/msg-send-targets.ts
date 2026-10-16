/**
 * Pure recipient resolution for the broker's `msg.send` handler.
 *
 * Extracted from crew-broker.ts (DR-03 wave, wc-gate: no module over 2000
 * lines — same precedent as live-session/usage-bridge.ts): the worker/
 * orchestrator recipient matrices are pure functions of
 * {role, taskId, parsed.to, taskIds} — no broker state involved.
 *
 * Worker constraints (D9/§15.2): from is always the authenticated taskId;
 * to is limited to `parent` | valid sibling taskId | `group`; kind limited
 * to notify|message (checked by the caller BEFORE resolution).
 * Orchestrator keeps the full prior surface (arrays / "all" / arbitrary
 * recipient sets).
 */

export type MsgSendTarget = { label: string; mailboxTaskId: string | undefined };

export type MsgSendTargetResolution =
	| { ok: true; targets: MsgSendTarget[]; sentToParent: boolean }
	| { ok: false; code: "forbidden" | "bad-params"; message: string };

/** Max recipients per send (both roles) — matches the historical inline check. */
export const MSG_SEND_MAX_RECIPIENTS = 64;

/**
 * Resolve `parsed.to` into mailbox targets.
 *
 * Each target is `{label, mailboxTaskId}`: `label` is echoed in the ack and
 * message id; `mailboxTaskId` is the mailbox file the append lands in
 * (undefined = run-level inbox, which the orchestrator consumes).
 * `sentToParent` is set when a worker addresses the parent — the durable
 * write alone would sit unread in the run-level inbox (spec §15.2 wake).
 */
export function resolveMsgSendTargets(input: {
	isWorker: boolean;
	connTaskId: string | undefined;
	to: unknown;
	taskIds: string[];
}): MsgSendTargetResolution {
	const { isWorker, connTaskId, taskIds } = input;

	if (isWorker) {
		// Worker constraint (1): from is ALWAYS the authenticated taskId.
		if (!connTaskId) {
			return { ok: false, code: "forbidden", message: "msg.send worker requires a task-scoped identity" };
		}
		// Worker constraint (2): to is limited to parent | valid sibling
		// taskId | group.
		const to = typeof input.to === "string" ? input.to : undefined;
		let targets: MsgSendTarget[];
		let sentToParent = false;
		if (to === "parent") {
			// Run-level inbox (taskId undefined) → the orchestrator session.
			targets = [{ label: "parent", mailboxTaskId: undefined }];
			sentToParent = true;
		} else if (to === "group") {
			targets = taskIds.map((t) => ({ label: t, mailboxTaskId: t }));
		} else if (to !== undefined && taskIds.includes(to)) {
			targets = [{ label: to, mailboxTaskId: to }];
		} else {
			return { ok: false, code: "forbidden", message: `msg.send: worker cannot target '${to}'` };
		}
		if (targets.length === 0 || targets.length > MSG_SEND_MAX_RECIPIENTS) {
			return { ok: false, code: "bad-params", message: "msg.send: recipient count out of range" };
		}
		return { ok: true, targets, sentToParent };
	}

	const recipients: string[] = Array.isArray(input.to) ? (input.to as string[]) : input.to === "all" ? taskIds : [input.to as string];
	if (recipients.length === 0 || recipients.length > MSG_SEND_MAX_RECIPIENTS) {
		return { ok: false, code: "bad-params", message: "msg.send: recipient count out of range" };
	}
	return { ok: true, targets: recipients.map((recipient) => ({ label: recipient, mailboxTaskId: recipient })), sentToParent: false };
}
