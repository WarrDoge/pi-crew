import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
// Lazy-loaded: team-tool.ts pulls in entire runtime chain.
import type { handleTeamTool as HandleTeamToolFn } from "../extension/team-tool.ts";
import type { MetricRegistry } from "../observability/metric-registry.ts";

async function handleTeamTool(
	params: Parameters<typeof HandleTeamToolFn>[0],
	ctx: Parameters<typeof HandleTeamToolFn>[1],
): Promise<Awaited<ReturnType<typeof HandleTeamToolFn>>> {
	// LAZY: avoid pulling team-tool.ts (and its entire runtime chain) into module load.
	const mod = await import("../extension/team-tool.ts");
	return mod.handleTeamTool(params, ctx);
}

import { isToolError, textFromToolResult } from "../extension/tool-result.ts";
import { isRunLockBusyError } from "../runtime/broker/protocol/lock-busy.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import { exportDiagnostic } from "../runtime/diagnostic-export.ts";
import { withRunLockSync } from "../state/coordination/locks.ts";
import type { MailboxDirection, MailboxMessage } from "../state/coordination/mailbox.ts";
import { appendEventBuffered } from "../state/event-log/event-log.ts";
import { loadRunManifestById, saveRunTasks } from "../state/stores/state-store.ts";
import type { TeamTaskState } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { formatCount } from "./format-helpers.ts";

export interface RunActionResult {
	ok: boolean;
	message: string;
	data?: unknown;
}

function okFromTool(result: Awaited<ReturnType<typeof handleTeamTool>>): RunActionResult {
	return {
		ok: !isToolError(result),
		message: textFromToolResult(result),
		data: result,
	};
}

function err(error: unknown): RunActionResult {
	return {
		ok: false,
		message: error instanceof Error ? error.message : String(error),
	};
}

async function dispatchApi(ctx: ExtensionContext, runId: string, config: Record<string, unknown>): Promise<RunActionResult> {
	try {
		return okFromTool(await handleTeamTool({ action: "api", runId, config }, ctx));
	} catch (error) {
		return err(error);
	}
}

function parseMailboxMessages(text: string): MailboxMessage[] {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(item): item is MailboxMessage =>
				Boolean(item) && typeof item === "object" && !Array.isArray(item) && typeof (item as { id?: unknown }).id === "string",
		);
	} catch {
		return [];
	}
}

export function dispatchMailboxAck(ctx: ExtensionContext, runId: string, messageId: string): Promise<RunActionResult> {
	return dispatchApi(ctx, runId, { operation: "ack-message", messageId });
}

export function dispatchMailboxNudge(ctx: ExtensionContext, runId: string, agentId: string, message: string): Promise<RunActionResult> {
	return dispatchApi(ctx, runId, {
		operation: "nudge-agent",
		agentId,
		message,
	});
}

export function dispatchMailboxCompose(
	ctx: ExtensionContext,
	runId: string,
	payload: {
		from: string;
		to: string;
		body: string;
		taskId?: string;
		direction: MailboxDirection;
	},
): Promise<RunActionResult> {
	return dispatchApi(ctx, runId, { operation: "send-message", ...payload });
}

export async function dispatchMailboxAckAll(ctx: ExtensionContext, runId: string): Promise<RunActionResult> {
	const listed = await dispatchApi(ctx, runId, {
		operation: "read-mailbox",
		direction: "inbox",
	});
	if (!listed.ok) return listed;
	const messages = parseMailboxMessages(listed.message).filter((message) => message.status !== "acknowledged");
	let count = 0;
	for (const message of messages) {
		const acked = await dispatchMailboxAck(ctx, runId, message.id);
		if (!acked.ok)
			return {
				ok: false,
				message: `Acknowledged ${count}/${messages.length}; failed ${message.id}: ${acked.message}`,
			};
		count += 1;
	}
	return {
		ok: true,
		message: `Acknowledged ${formatCount(count, "message")}.`,
		data: { count },
	};
}

export function dispatchHealthRecovery(ctx: ExtensionContext, runId: string): Promise<RunActionResult> {
	return dispatchApi(ctx, runId, {
		operation: "foreground-interrupt",
		reason: "operator health recovery",
	});
}

/** Staleness window for the kill-stale sweep (R4-6). */
const KILL_STALE_HEARTBEAT_MS = 60_000;

/**
 * R4-6 (DR-02 Wave 2 Cluster C): pure RMW core of the kill-stale sweep —
 * mark running/queued tasks whose heartbeat is older than `staleMs` dead.
 * Exported so the locked dispatcher body stays unit-testable without a
 * harness (repo seam pattern; see state-helpers-cas-contention.test.ts).
 * Predicate is byte-identical to the previous inline map.
 */
export function markStaleWorkerHeartbeatsDead(
	tasks: readonly TeamTaskState[],
	currentMs: number,
	staleMs: number = KILL_STALE_HEARTBEAT_MS,
): { tasks: TeamTaskState[]; count: number } {
	const now = new Date(currentMs).toISOString();
	let count = 0;
	const updated = tasks.map((task) => {
		if ((task.status !== "running" && task.status !== "queued") || !task.heartbeat || task.heartbeat.alive === false) return task;
		const lastSeenMs = Date.parse(task.heartbeat.lastSeenAt);
		if (!Number.isFinite(lastSeenMs) || currentMs - lastSeenMs <= staleMs) return task;
		count += 1;
		return {
			...task,
			heartbeat: { ...task.heartbeat, alive: false, lastSeenAt: now },
		};
	});
	return { tasks: updated, count };
}

export async function dispatchKillStaleWorkers(ctx: ExtensionContext, runId: string): Promise<RunActionResult> {
	try {
		const loaded = loadRunManifestById(ctx.cwd, runId);
		if (!loaded) return { ok: false, message: `Run '${runId}' not found.` };
		// R4-6 (DR-02 Wave 2 Cluster C): this sweep used to be an UNLOCKED
		// load→map→save (":125 no withRunLock - best-effort") — a cross-process
		// writer holding the run lock (leader heartbeats, task claims, delegate
		// flushes) could land a fresh tasks.json between our read and write and
		// get clobbered by the STALE array. Now a run-locked RMW with the fresh
		// re-read INSIDE the lock (R13-S1 canonical pattern, team-tool/api/heartbeat.ts).
		// Best-effort semantics are preserved on contention: the UI never blocks —
		// the sweep is skipped with a warn, never a stale write.
		let applied: { tasks: TeamTaskState[]; count: number } | undefined;
		try {
			applied = withRunLockSync(loaded.manifest, () => {
				const fresh = loadRunManifestById(loaded.manifest.cwd, loaded.manifest.runId);
				if (!fresh) return undefined;
				const result = markStaleWorkerHeartbeatsDead(fresh.tasks, Date.now());
				// count=0 → nothing changed; skip the identical-content rewrite.
				if (result.count > 0) saveRunTasks(fresh.manifest, result.tasks);
				return result;
			});
		} catch (error) {
			if (isRunLockBusyError(error)) {
				logInternalError("run-action-dispatcher.killStale", error, `runId=${runId} skipped: run lock busy`, "warn");
				return {
					ok: false,
					message: `Skipped kill-stale for run '${runId}': another operation holds the run lock. Try again in a moment.`,
				};
			}
			throw error;
		}
		if (!applied) return { ok: false, message: `Run '${runId}' not found.` };
		const message = `Marked ${applied.count} stale worker heartbeat(s) dead.`;
		appendEventBuffered(loaded.manifest.eventsPath, {
			type: "worker.kill_stale",
			runId,
			message,
			data: { count: applied.count },
		}).catch((e) => logInternalError("run_action_dispatcher.buffered", e, "type=worker.kill_stale"));
		return {
			ok: true,
			message,
			data: { count: applied.count },
		};
	} catch (error) {
		return err(error);
	}
}

export async function dispatchDiagnosticExport(
	ctx: ExtensionContext,
	runId: string,
	options: { registry?: MetricRegistry } = {},
): Promise<RunActionResult> {
	try {
		const exported = await exportDiagnostic(ctx, runId, options);
		return {
			ok: true,
			message: `Diagnostic exported to ${exported.path}`,
			data: exported.path,
		};
	} catch (error) {
		return err(error);
	}
}

/** @internal */
function defaultNudgeAgentId(ctx: Pick<ExtensionContext, "cwd">, runId: string): string | undefined {
	const loaded = loadRunManifestById(ctx.cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
	if (!loaded) return undefined;
	return readCrewAgents(loaded.manifest).find((agent) => agent.status === "running" || agent.status === "queued")?.taskId;
}
