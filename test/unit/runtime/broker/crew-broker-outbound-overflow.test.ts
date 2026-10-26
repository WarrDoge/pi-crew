/**
 * crew-broker-outbound-overflow.test.ts — R6-5 (DR-03 round-6 2026-10-16)
 * unit tests for the outbound-queue admission classes.
 *
 * Lead-verified bug: `writeOrQueue(force=false)` dropped request RESPONSE
 * frames (sendResult acks for ping/msg.send/wait.request) at the queue cap
 * alongside fanout frames, and the `needsResync` marker set on drop was
 * write-only (6 hits, 0 reads) — no pause, no client notice, live frames
 * silently dropped for the connection's remaining lifetime.
 *
 * Fix under test:
 *  (a) response-class frames (sendResult/sendError acks) BYPASS the
 *      drop-newest cap (bounded by in-flight request count);
 *  (b) a dropped fanout/event frame now CLOSES the connection with a typed
 *      `protocol.close` reason "outbound-overflow-resync" so the client can
 *      reconnect + replay (events.since / msg.inbox).
 *
 * Strategy: `outboundQueueCap: 0` makes EVERY enqueue at-cap — the
 * maximally-saturated queue — deterministically, with no reliance on kernel
 * socket-buffer timing. Pre-fix, cap=0 dropped even the hello ack (the
 * connection was unusable); post-fix the handshake + ping round-trip work.
 *
 * Real net server + real run dir (same fixture discipline as
 * crew-broker-wait-status-cache.test.ts).
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { CrewBroker } from "../../../../src/runtime/broker/crew-broker.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import { encodeBrokerFrame, NdjsonDecoder } from "../../../../src/utils/ndjson.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

// ----------------------------------------------------------------------------
// Fixture literals (same `as never` pattern as the sibling broker tests)
// ----------------------------------------------------------------------------

const team = {
	name: "t",
	description: "",
	source: "test",
	filePath: "t",
	roles: [{ name: "r", agent: "a" }],
} as never;

const workflow = {
	name: "w",
	description: "",
	source: "test",
	filePath: "w",
	steps: [{ id: "s", role: "r", task: "x" }],
} as never;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function tempSocketPath(suffix: string): string {
	const tok = randomBytes(3).toString("hex");
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-crew-test-ovf-${tok}-${suffix}`;
	}
	return path.join(os.tmpdir(), `pc-ovf-${tok}-${suffix}.sock`);
}

interface RawClient {
	socket: net.Socket;
	decoder: NdjsonDecoder;
	frames: unknown[];
	closed: boolean;
	waitForFrame: (predicate: (frame: unknown) => boolean, timeoutMs?: number) => Promise<unknown>;
	waitForClose: (timeoutMs?: number) => Promise<boolean>;
	close: () => void;
}

function rawConnect(socketPath: string): Promise<RawClient> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection(socketPath);
		const client: RawClient = {
			socket: sock,
			decoder: new NdjsonDecoder(),
			frames: [],
			closed: false,
			waitForFrame: () => Promise.reject(new Error("not initialized")),
			waitForClose: () => Promise.reject(new Error("not initialized")),
			close: () => {
				try {
					sock.destroy();
				} catch {
					/* ignore */
				}
			},
		};
		const pending: Array<{
			resolve: (v: unknown) => void;
			reject: (e: Error) => void;
			predicate: (f: unknown) => boolean;
			timer: NodeJS.Timeout;
		}> = [];
		client.waitForFrame = (predicate, timeoutMs = 5000) =>
			new Promise((res, rej) => {
				const timer = setTimeout(() => rej(new Error("waitForFrame: timeout")), timeoutMs);
				timer.unref();
				pending.push({ resolve: res, reject: rej, predicate, timer });
			});
		client.waitForClose = (timeoutMs = 5000) =>
			new Promise((res) => {
				const started = Date.now();
				const poll = () => {
					if (client.closed) res(true);
					else if (Date.now() - started > timeoutMs) res(false);
					else setTimeout(poll, 10).unref();
				};
				poll();
			});
		const drain = (frames: unknown[]) => {
			for (const f of frames) {
				client.frames.push(f);
				const idx = pending.findIndex((p) => p.predicate(f));
				if (idx !== -1) {
					const p = pending.splice(idx, 1)[0];
					clearTimeout(p.timer);
					p.resolve(f);
				}
			}
		};
		sock.on("data", (chunk: Buffer) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, "utf8");
			try {
				drain(client.decoder.push(buf));
			} catch {
				/* ignore malformed */
			}
		});
		sock.on("error", () => {
			/* close handler decides */
		});
		sock.on("close", () => {
			client.closed = true;
			for (const p of pending) {
				clearTimeout(p.timer);
				p.resolve(undefined);
			}
		});
		sock.once("connect", () => resolve(client));
		sock.once("error", (err) => reject(err));
	});
}

interface OvfFixture {
	cwd: string;
	runId: string;
	taskId: string;
	broker: CrewBroker;
	socketPath: string;
	cleanup: () => Promise<void>;
}

/** Real run dir (msg.send needs cwd + a manifest task) + broker with a tiny
 *  outboundQueueCap. */
async function makeOverflowFixture(outboundQueueCap: number, prefix: string): Promise<OvfFixture> {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-ovf-${prefix}-`));
	// Canonicalize to long-name form (Windows 8.3) matching production code.
	try {
		const r = fs.realpathSync.native(cwd);
		cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		/* keep as-is */
	}
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	const created = createRunManifest({ cwd, team, workflow, goal: `outbound overflow test ${prefix}` });
	const socketPath = tempSocketPath(prefix);
	const broker = new CrewBroker({
		sessionId: `ovf-${prefix}-${Date.now()}`,
		socketPath,
		enabled: true,
		cwd,
		outboundQueueCap,
	});
	await broker.start();
	const cleanup = async () => {
		try {
			await broker.stop();
		} catch {
			/* ignore */
		}
		try {
			await removeDirWithRetry(cwd);
		} catch {
			/* ignore */
		}
	};
	return {
		cwd,
		runId: created.manifest.runId,
		taskId: created.tasks[0].id,
		broker,
		socketPath,
		cleanup,
	};
}

async function helloWorker(fx: OvfFixture, client: RawClient): Promise<void> {
	const token = fx.broker.issueRunToken(fx.runId, fx.taskId);
	client.socket.write(
		encodeBrokerFrame({ id: "hello-1", method: "hello", params: { protocol: 1, runId: fx.runId, taskId: fx.taskId, token } }),
	);
	const ack = (await client.waitForFrame((f) => (f as { id?: string })?.id === "hello-1")) as { result?: { ok?: boolean } };
	assert.equal(ack?.result?.ok, true, "hello must succeed");
}

// ----------------------------------------------------------------------------
// R6-5(a): responses bypass the cap
// ----------------------------------------------------------------------------

test("R6-5(a): saturated queue (cap=0) still delivers the hello ack + ping pong — responses bypass the cap", async () => {
	const fx = await makeOverflowFixture(0, "resp");
	try {
		const client = await rawConnect(fx.socketPath);
		try {
			// With cap=0 every enqueue is at-cap. The hello ack and the pong are
			// response-class: they must bypass drop-newest and be delivered.
			// (Pre-fix both were dropped — the connection was unusable at cap=0.)
			await helloWorker(fx, client);
			client.socket.write(encodeBrokerFrame({ id: "p-1", method: "ping", params: null }));
			const pong = (await client.waitForFrame((f) => (f as { id?: string })?.id === "p-1")) as {
				result?: { pong?: boolean };
			};
			assert.equal(pong?.result?.pong, true, "pong must be delivered through the saturated queue");
			// Ordering preserved: ack arrived before the pong (both queued at tail).
			const ids = client.frames.map((f) => (f as { id?: string })?.id).filter(Boolean);
			assert.ok(ids.indexOf("hello-1") < ids.indexOf("p-1"), "response frames keep queue order");
		} finally {
			client.close();
		}
	} finally {
		await fx.cleanup();
	}
});

// ----------------------------------------------------------------------------
// R6-5(b): fanout drop at cap → typed resync close
// ----------------------------------------------------------------------------

test("R6-5(b): fanout frame dropped at cap → protocol.close 'outbound-overflow-resync' + connection closed, no mailbox.message delivered", async () => {
	const fx = await makeOverflowFixture(0, "ovf");
	try {
		const client = await rawConnect(fx.socketPath);
		try {
			await helloWorker(fx, client);
			// Self-addressed msg.send: the durable append's observer fans a
			// mailbox.message event frame onto this connection — fanout class,
			// so at cap=0 it is drop-newest'd → overflow → resync close.
			client.socket.write(
				encodeBrokerFrame({ id: "msg-1", method: "msg.send", params: { to: fx.taskId, kind: "notify", body: "overflow probe" } }),
			);
			const closeFrame = (await client.waitForFrame((f) => (f as { event?: string })?.event === "protocol.close")) as {
				event?: string;
				data?: { reason?: string };
			};
			assert.ok(closeFrame, "protocol.close frame must be delivered (best-effort, direct write)");
			assert.equal(closeFrame.data?.reason, "outbound-overflow-resync", "typed close-reason");
			const closed = await client.waitForClose(2000);
			assert.equal(closed, true, "connection must be closed after the overflow drop");
			// The dropped fanout frame itself must NOT have been delivered.
			assert.ok(
				!client.frames.some((f) => (f as { event?: string })?.event === "mailbox.message"),
				"fanout frame stays dropped at cap (drop-newest preserved for events)",
			);
		} finally {
			client.close();
		}
	} finally {
		await fx.cleanup();
	}
});
