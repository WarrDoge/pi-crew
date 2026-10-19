import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { agentStateFile, ensureAgentStateDir } from "../crew-agent-records.ts";

export type LiveAgentControlOperation = "steer" | "follow-up" | "stop" | "resume";

export interface LiveAgentControlRequest {
	id: string;
	runId: string;
	taskId: string;
	agentId?: string;
	operation: LiveAgentControlOperation;
	message?: string;
	createdAt: string;
	processedAt?: string;
	error?: string;
}

export interface LiveAgentControlCursor {
	offset: number;
}

/**
 * R41-1 (M3-11) — durable processed marker.
 *
 * `processedAt` used to be set on the IN-MEMORY request object only, and the
 * dedupe that made it meaningful lived in a per-invocation
 * `BoundedSeenControlRequestIdSet` (live-session-runtime.ts). After a crash or
 * a resume, the cursor starts at offset 0 and the seen-set is empty, so EVERY
 * control request already applied was read back and re-applied (stop / steer /
 * follow-up replayed into a fresh session).
 *
 * The fix persists the consumed state as an append-only marker line in the same
 * `live-control.jsonl` file: crash-safe, no rewrite of request lines, no extra
 * file to lock, and it survives a resume with a cold cursor. Marker lines are
 * distinguishable from request lines by `type === "processed"` and are filtered
 * out of every read.
 */
export interface LiveAgentControlMarker {
	type: "processed";
	requestId: string;
	runId: string;
	taskId: string;
	processedAt: string;
	error?: string;
}

function isControlMarker(value: unknown): value is LiveAgentControlMarker {
	return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "processed");
}

export function liveAgentControlPath(manifest: TeamRunManifest, taskId: string): string {
	return path.join(ensureAgentStateDir(manifest, taskId), "live-control.jsonl");
}

function liveAgentControlFile(manifest: TeamRunManifest, taskId: string): string {
	return agentStateFile(manifest, taskId, "live-control.jsonl");
}

function requestId(): string {
	return `ctrl_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

export function appendLiveAgentControlRequest(
	manifest: TeamRunManifest,
	input: {
		taskId: string;
		agentId?: string;
		operation: LiveAgentControlOperation;
		message?: string;
	},
): LiveAgentControlRequest {
	const request: LiveAgentControlRequest = {
		id: requestId(),
		runId: manifest.runId,
		taskId: input.taskId,
		agentId: input.agentId,
		operation: input.operation,
		message: input.message,
		createdAt: new Date().toISOString(),
	};
	const filePath = liveAgentControlFile(manifest, input.taskId);
	fs.appendFileSync(filePath, `${JSON.stringify(request)}\n`, "utf-8");
	return request;
}

export function readLiveAgentControlRequests(
	manifest: TeamRunManifest,
	taskId: string,
	cursor: LiveAgentControlCursor = { offset: 0 },
): { requests: LiveAgentControlRequest[]; cursor: LiveAgentControlCursor } {
	let filePath: string;
	try {
		filePath = liveAgentControlFile(manifest, taskId);
	} catch {
		return { requests: [], cursor };
	}
	if (!fs.existsSync(filePath)) return { requests: [], cursor };
	const text = fs.readFileSync(filePath, "utf-8");
	const lines = text.split(/\r?\n/).filter(Boolean);
	const records = lines.map((line) => {
		try {
			return JSON.parse(line) as unknown;
		} catch {
			return undefined; // unparseable line — skip (same tolerance as before)
		}
	});
	// R41-1: markers may appear anywhere in the file (appended by any process),
	// so the processed set is scanned over the WHOLE file — not just the unread
	// window — before the cursor slice is filtered. This is what makes a cold
	// cursor after crash/resume replay-free.
	const processedRequestIds = new Set<string>();
	for (const record of records) {
		if (!isControlMarker(record)) continue;
		if (record.runId !== manifest.runId || record.taskId !== taskId) continue;
		processedRequestIds.add(record.requestId);
	}
	const requests = records.slice(cursor.offset).flatMap((record) => {
		if (!record || isControlMarker(record)) return [];
		const parsed = record as LiveAgentControlRequest;
		if (parsed.runId !== manifest.runId || parsed.taskId !== taskId) return [];
		// Already consumed in an earlier process (persisted marker) — never replay.
		if (processedRequestIds.has(parsed.id)) return [];
		return [parsed];
	});
	return { requests, cursor: { offset: lines.length } };
}

export async function applyLiveAgentControlRequest(input: {
	request: LiveAgentControlRequest;
	taskId: string;
	agentId: string;
	session: {
		steer?: (text: string) => Promise<void>;
		prompt?: (text: string, options?: Record<string, unknown>) => Promise<void>;
		abort?: () => Promise<void> | void;
	};
	seenRequestIds?: Set<string>;
	/** R41-1: when supplied, a processed marker is durably appended after the request is consumed. */
	manifest?: TeamRunManifest;
}): Promise<boolean> {
	const { request, taskId, agentId, session, seenRequestIds } = input;
	if (seenRequestIds?.has(request.id)) return false;
	if (request.agentId && request.agentId !== agentId && request.agentId !== taskId) return false;
	seenRequestIds?.add(request.id);
	// R3A-M1 (2026-10-17): a rejecting steer/prompt/abort used to escape this
	// await into fire-and-forget `void` call sites (live-session-runtime) →
	// unhandledRejection → host session crash. Every operation is now guarded;
	// the failure is recorded on the request (`error`, + processedAt for
	// observability) and logged — the control request is CONSUMED either way so
	// a poisoned request cannot crash the loop that polls for it.
	try {
		if (request.operation === "steer")
			await session.steer?.(request.message ?? "Please report current status and wrap up if possible.");
		else if (request.operation === "follow-up")
			await session.prompt?.(request.message ?? "Please continue with the follow-up request.", {
				source: "api",
				expandPromptTemplates: false,
				streamingBehavior: "followUp",
			});
		else if (request.operation === "resume")
			await session.prompt?.(request.message ?? "Please resume and report final status.", {
				source: "api",
				expandPromptTemplates: false,
				streamingBehavior: "followUp",
			});
		else if (request.operation === "stop") await session.abort?.();
		request.processedAt = new Date().toISOString();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		request.error = message;
		request.processedAt = new Date().toISOString();
		logInternalError(
			"live-agent-control.apply-failed",
			error instanceof Error ? error : new Error(message),
			`runId=${request.runId} taskId=${request.taskId} operation=${request.operation} requestId=${request.id}`,
		);
	}
	// R41-1: persist the consumed state BEFORE anyone can observe "applied" — a
	// crash right after this return must not replay the request.
	if (input.manifest) appendProcessedControlMarker(input.manifest, taskId, request);
	return true;
}

/**
 * R41-1: appends a processed marker for a request this process consumed.
 * Best-effort — a failed marker write must never fail the control loop (the
 * in-memory seen-set still dedupes within this process); it only means the
 * request may replay once after a crash.
 */
function appendProcessedControlMarker(manifest: TeamRunManifest, taskId: string, request: LiveAgentControlRequest): void {
	const marker: LiveAgentControlMarker = {
		type: "processed",
		requestId: request.id,
		runId: manifest.runId,
		taskId,
		processedAt: request.processedAt ?? new Date().toISOString(),
		...(request.error ? { error: request.error } : {}),
	};
	try {
		fs.appendFileSync(liveAgentControlFile(manifest, taskId), `${JSON.stringify(marker)}\n`, "utf-8");
	} catch (error) {
		logInternalError("live-agent-control.mark-processed", error, `taskId=${taskId} requestId=${request.id}`);
	}
}

export async function applyLiveAgentControlRequests(input: {
	manifest: TeamRunManifest;
	taskId: string;
	agentId: string;
	session: {
		steer?: (text: string) => Promise<void>;
		prompt?: (text: string, options?: Record<string, unknown>) => Promise<void>;
		abort?: () => Promise<void> | void;
	};
	cursor: LiveAgentControlCursor;
	seenRequestIds?: Set<string>;
}): Promise<LiveAgentControlCursor> {
	const batch = readLiveAgentControlRequests(input.manifest, input.taskId, input.cursor);
	for (const request of batch.requests) {
		const applied = await applyLiveAgentControlRequest({
			request,
			taskId: input.taskId,
			agentId: input.agentId,
			session: input.session,
			seenRequestIds: input.seenRequestIds,
			manifest: input.manifest,
		});
		// R41-1: the realtime subscription (live-session-runtime) consumes an
		// already-persisted request WITHOUT a manifest, so it cannot write the
		// marker itself. The poll sees the id in the shared seen-set on its next
		// tick — mark it consumed here so a crash before then cannot replay it.
		// A request addressed to a DIFFERENT agent is never marked (it is not ours
		// to consume): applyLiveAgentControlRequest returns false for it without
		// touching the seen-set.
		if (!applied && input.seenRequestIds?.has(request.id)) appendProcessedControlMarker(input.manifest, input.taskId, request);
	}
	return batch.cursor;
}
