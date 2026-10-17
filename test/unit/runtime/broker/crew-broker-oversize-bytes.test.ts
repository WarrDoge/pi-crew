/**
 * crew-broker-oversize-bytes.test.ts — R9-N1 + R8-M1 (2026-10-17 wave-2a).
 *
 * R9-N1: a request-response frame whose encoding exceeds MAX_BROKER_FRAME_BYTES
 * used to be silently dropped by enqueueFrame (debug-only log) — the client
 * hung on its id until its request timeout (runtime-proven on >256 KiB
 * events.since replays). The broker must answer with a small typed error on
 * the SAME id (or close) — never silence.
 *
 * R8-M1: the outbound queue cap counts FRAMES, not bytes; a few large frames
 * under a 256-frame cap buffer unbounded in-app. The queued-BYTES cap must
 * take the same typed overflow-close path.
 *
 * Deterministic by construction: stub ServerConnection + backpressured
 * (write() → false) socket, so no kernel socket-buffer timing is involved
 * (the audit's R9-M1 note: real paused sockets are absorbed by the kernel).
 */

import assert from "node:assert/strict";
import type * as net from "node:net";
import test from "node:test";

import { CrewBroker } from "../../../../src/runtime/broker/crew-broker.ts";
import type { ServerConnection } from "../../../../src/runtime/broker/protocol/connection-state.ts";
import { NdjsonDecoder } from "../../../../src/utils/ndjson.ts";

interface Captured {
	writes: Buffer[];
	closed: boolean;
}

function stubConn(captured: Captured): ServerConnection {
	const socket = {
		write: (buf: Buffer): boolean => {
			captured.writes.push(buf);
			return false; // backpressure — frames STAY queued
		},
		once: () => socket,
		destroy: () => {
			captured.closed = true;
		},
	} as unknown as net.Socket;
	return {
		socket,
		decoder: new NdjsonDecoder(),
		authed: true,
		outbound: [],
		queuedBytes: 0,
		needsResync: false,
		closed: false,
		helloTimer: null,
		outboundSeq: 0,
	} as ServerConnection;
}

function makeBroker(options?: Record<string, unknown>): CrewBroker {
	return new CrewBroker({
		sessionId: `ovf-test-${Date.now()}`,
		enabled: false,
		...options,
	} as never);
}

test("R9-N1: enqueueFrame encode failure answers the SAME id with a typed response-oversize error", () => {
	const broker = makeBroker();
	const captured: Captured = { writes: [], closed: false };
	const conn = stubConn(captured);
	const internals = broker as unknown as { sendResult(conn: ServerConnection, id: string, result: unknown): void };
	// >256 KiB body → encodeBrokerFrame throws inside enqueueFrame.
	internals.sendResult(conn, "req-big", { blob: "x".repeat(300 * 1024) });
	const frames = captured.writes.map((buf) => JSON.parse(buf.toString("utf-8")) as Record<string, unknown>);
	const answer = frames.find((f) => "error" in f);
	assert.ok(answer, `a typed error frame must be written, got ${frames.length} frames`);
	assert.equal(answer.id, "req-big", "error must ride the SAME id so the client stops waiting");
	assert.equal((answer.error as { code: string }).code, "response-oversize");
});

test("R8-M1: queued-BYTES cap (few large frames, frame cap far away) → typed overflow close", () => {
	const broker = makeBroker({ outboundQueueBytesCap: 300_000, outboundQueueCap: 10_000 });
	const captured: Captured = { writes: [], closed: false };
	const conn = stubConn(captured);
	const internals = broker as unknown as {
		writeOrQueue(conn: ServerConnection, buf: Buffer, force: boolean | "response"): void;
	};
	const frame = Buffer.from(`${JSON.stringify({ event: "team.event", data: { blob: "y".repeat(200_000) } })}\n`);
	// Frame 1 (200 KB) queues under the 300 KB byte cap; frame 2 exceeds it.
	internals.writeOrQueue(conn, frame, false);
	assert.equal(conn.outbound.length, 1);
	assert.equal(conn.queuedBytes, frame.length, "queuedBytes must count frame sizes");
	internals.writeOrQueue(conn, frame, false);
	assert.equal(conn.needsResync, true, "typed overflow close must fire on the BYTES cap");
	assert.ok(captured.closed || conn.closed, "connection must be closed for resync");
	// The typed close-reason frame is written DIRECTLY (jumps the doomed queue).
	const closeFrame = captured.writes.map((b) => b.toString("utf-8")).find((s) => s.includes("outbound-overflow-resync"));
	assert.ok(closeFrame, "typed protocol.close reason must be delivered");
});
