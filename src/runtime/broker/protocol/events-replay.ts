/**
 * events-replay.ts — Phase 1.5 events.since handler (label corrected
 * 2026-09-10 per review F4 — "Phase 2" is events.subscribe). Used by clients
 * to resync after a missed live frame (e.g. after a queue overflow or
 * reconnect).
 *
 * Moved from crew-broker.ts (M4 / WI-4.1) — pure move, no behavior change.
 * Operates only on the connection + a writers adapter (sendError/sendResult).
 * Promoted to a top-level function so the class method is a 1-line delegation.
 */

import { readEventsCursor } from "../../../state/event-log/event-log.ts";
import { loadRunManifestById } from "../../../state/stores/state-store.ts";
import { encodeBrokerFrame } from "../../../utils/ndjson.ts";
import type { ServerConnection } from "./connection-state.ts";

export interface EventWriterHelpers {
	sendError(conn: ServerConnection, id: string, code: string, message: string): void;
	sendResult(conn: ServerConnection, id: string, result: unknown): void;
}

/** Phase 2: events.since — page-replay handler. Returns events with
 *  seq > sinceSeq from the durable log, capped to `limit` (default 1000). */
export async function handleEventsSince(
	conn: ServerConnection,
	id: string,
	params: unknown,
	helpers: EventWriterHelpers,
	cwd: string | undefined,
): Promise<void> {
	if (!conn.runId) {
		helpers.sendError(conn, id, "auth", "not authed");
		return;
	}
	if (!cwd) {
		helpers.sendError(conn, id, "no-manifest", "broker has no cwd configured");
		return;
	}
	let eventsPath: string;
	try {
		const loaded = loadRunManifestById(cwd, conn.runId);
		if (!loaded) {
			helpers.sendError(conn, id, "no-manifest", `run '${conn.runId}' not found`);
			return;
		}
		eventsPath = loaded.manifest.eventsPath;
	} catch (err) {
		helpers.sendError(conn, id, "no-manifest", (err as Error).message);
		return;
	}
	const v = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
	const sinceSeq = typeof v.sinceSeq === "number" && Number.isFinite(v.sinceSeq) ? Math.max(0, Math.floor(v.sinceSeq)) : 0;
	const limit = typeof v.limit === "number" && Number.isFinite(v.limit) ? Math.min(Math.max(1, Math.floor(v.limit)), 1000) : 1000;
	// R9-N2 (2026-10-17): optional byte-offset anchor + generation echo. The
	// default (non-offset) read only sees the last TAIL_BYTES (4 MB) of the
	// log, so the PREFIX of a larger log is unreachable by seq alone; a client
	// that passes fromByteOffset pages it (the cursor resumes scanning from
	// that byte position). Omitted → exact previous behavior.
	const fromByteOffset =
		typeof v.fromByteOffset === "number" && Number.isFinite(v.fromByteOffset) && v.fromByteOffset >= 0
			? Math.floor(v.fromByteOffset)
			: undefined;
	const generation = typeof v.generation === "number" && Number.isFinite(v.generation) ? Math.floor(v.generation) : undefined;
	try {
		const result = readEventsCursor(eventsPath, { sinceSeq, limit, fromByteOffset, generation });
		// R9-N1 (2026-10-17): a page whose encoded frame exceeds the broker
		// frame limit used to make sendResult → enqueueFrame → encodeBrokerFrame
		// throw into a debug-only log — the client hung on its id with no
		// response (runtime-proven on >256 KiB replays). Pre-check the EXACT
		// response frame here and binary-halve the batch until it encodes;
		// `truncated` + `nextSinceSeq` tell the client to page the rest. Never
		// silence — if even ONE event cannot encode, answer with a typed error.
		let events = result.events;
		let frameTruncated = false;
		let response: Record<string, unknown>;
		const buildResponse = (): Record<string, unknown> => ({
			events,
			nextSeq: events.length ? events.reduce((max, event) => Math.max(max, event.metadata?.seq ?? 0), sinceSeq) : result.nextSeq,
			hasMore: result.total > events.length,
			// Continuation contract: nextSinceSeq is the seq to pass as sinceSeq on
			// the next call (safe resume anchor — never past an undelivered event).
			nextSinceSeq: events.length ? events.reduce((max, event) => Math.max(max, event.metadata?.seq ?? 0), sinceSeq) : result.nextSeq,
			truncated: frameTruncated || result.truncated === true,
			...(result.nextByteOffset !== undefined ? { nextByteOffset: result.nextByteOffset } : {}),
			...(result.generation !== undefined ? { generation: result.generation } : {}),
		});
		while (true) {
			response = buildResponse();
			try {
				encodeBrokerFrame(response);
				break;
			} catch {
				if (events.length <= 1) {
					// A single event over the frame limit can never page — typed error
					// (enqueueFrame's R9-N1 fallback would also catch this, but failing
					// here keeps the client's paging loop coherent).
					helpers.sendError(conn, id, "response-oversize", "events.since: single event exceeds the broker frame limit");
					return;
				}
				events = events.slice(0, Math.ceil(events.length / 2));
				frameTruncated = true;
			}
		}
		helpers.sendResult(conn, id, response);
	} catch (err) {
		helpers.sendError(conn, id, "replay-failed", (err as Error).message);
	}
}
