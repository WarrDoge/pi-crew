/**
 * herdr closeSurface graceful kill-by-pid (TODO A2 → implemented, round2 C-3)
 *
 * Graceful path: NOT forced + deps.resolveWorkerPid returns a pid > 1 →
 * SIGTERM the worker process tree FIRST (killProcessTree semantics via the
 * injected killTree), wait the grace window, then pane.close still runs as
 * the kill-tree fallback (herdr terminates the whole pane tree — idempotent).
 * Every kill-by-pid step is best-effort NO-THROW. Force path and the
 * pane.close error semantics (pane_not_found idempotent, other errors throw)
 * are byte-for-byte the old behavior.
 *
 * Mọi socket đều fake qua deps.connect — không chạm server thật (pattern
 * herdr-provider.test.ts).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHerdrProvider, type HerdrProviderDeps, type HerdrSocket } from "../../../../src/runtime/surface/herdr-provider.ts";
import type { SurfaceProvider } from "../../../../src/runtime/surface/surface-provider.ts";

/** Request đã parse mà provider gửi xuống socket. */
interface SentRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

/** Fake socket: nắm mọi request, đẩy response theo handler của harness. */
class FakeSocket implements HerdrSocket {
	readonly requests: SentRequest[] = [];
	private lineCb: ((line: string) => void) | null = null;
	private readonly onWrite: (req: SentRequest, sock: FakeSocket) => void;

	constructor(onWrite: (req: SentRequest, sock: FakeSocket) => void) {
		this.onWrite = onWrite;
	}

	write(line: string): void {
		const req = JSON.parse(line) as SentRequest;
		this.requests.push(req);
		this.onWrite(req, this);
	}

	onLine(cb: (line: string) => void): void {
		this.lineCb = cb;
	}

	close(): void {
		/* no-op — provider tự close sau response */
	}

	push(line: string): void {
		this.lineCb?.(line);
	}
}

type PaneCloseMode = "ok" | "pane_not_found" | "other_error";

interface Harness {
	provider: SurfaceProvider;
	/** Ordered event log: killTree:<pid> / sleep:<ms> / pane.close. */
	events: string[];
	sockets: FakeSocket[];
}

function makeHarness(overrides: Partial<HerdrProviderDeps> = {}, paneClose: PaneCloseMode = "ok"): Harness {
	const events: string[] = [];
	const sockets: FakeSocket[] = [];
	const respond = (req: SentRequest, sock: FakeSocket): void => {
		if (req.method === "pane.close") {
			events.push("pane.close");
			if (paneClose === "ok") {
				sock.push(JSON.stringify({ id: req.id, result: { type: "ok" } }));
			} else if (paneClose === "pane_not_found") {
				sock.push(JSON.stringify({ id: req.id, error: { code: "pane_not_found", message: "no such pane" } }));
			} else {
				sock.push(JSON.stringify({ id: req.id, error: { code: "internal_error", message: "boom" } }));
			}
			return;
		}
		sock.push(JSON.stringify({ id: req.id, result: { type: "ok" } }));
	};
	const deps: HerdrProviderDeps = {
		env: {},
		connect: () => {
			const sock = new FakeSocket(respond);
			sockets.push(sock);
			return sock;
		},
		resolveWorkerPid: (paneId) => (paneId === "w1:p7" ? 4242 : null),
		killTree: (pid) => {
			events.push(`killTree:${pid}`);
		},
		sleep: async (ms) => {
			events.push(`sleep:${ms}`);
		},
		...overrides,
	};
	return { provider: createHerdrProvider(deps), events, sockets };
}

function pane7Handle(provider: SurfaceProvider) {
	const handle = provider.attach("w1:p7");
	assert.ok(handle, "attach phải trả optimistic handle cho herdr");
	return handle;
}

test("graceful: có pid → killTree TRƯỚC, sleep grace window, RỒI pane.close (đúng thứ tự)", async () => {
	const h = makeHarness();
	await h.provider.closeSurface(pane7Handle(h.provider));
	assert.deepEqual(h.events, ["killTree:4242", "sleep:3000", "pane.close"]);
	// pane.close phải nhắm đúng pane id của handle.
	const closeReq = h.sockets[0]?.requests[0];
	assert.equal(closeReq?.method, "pane.close");
	assert.equal(closeReq?.params.pane_id, "w1:p7");
});

test("force: bỏ qua hoàn toàn kill-by-pid — chỉ pane.close như cũ", async () => {
	const h = makeHarness();
	await h.provider.closeSurface(pane7Handle(h.provider), { force: true });
	assert.deepEqual(h.events, ["pane.close"]);
});

test("default seam (không wire resolveWorkerPid) → graceful giữ hành vi cũ: chỉ pane.close", async () => {
	const h = makeHarness({ resolveWorkerPid: undefined });
	await h.provider.closeSurface(pane7Handle(h.provider));
	assert.deepEqual(h.events, ["pane.close"]);
});

test("pid = 1 (không bao giờ là process worker) → bỏ kill, vẫn pane.close", async () => {
	const h = makeHarness({ resolveWorkerPid: () => 1 });
	await h.provider.closeSurface(pane7Handle(h.provider));
	assert.deepEqual(h.events, ["pane.close"]);
});

test("pid rác (NaN / 0 / âm) → bỏ kill, vẫn pane.close", async () => {
	for (const junk of [Number.NaN, 0, -5]) {
		const h = makeHarness({ resolveWorkerPid: () => junk });
		await h.provider.closeSurface(pane7Handle(h.provider));
		assert.deepEqual(h.events, ["pane.close"], `pid=${junk}`);
	}
});

test("no-throw: killTree ném → vẫn pane.close và closeSurface resolve", async () => {
	const h = makeHarness({
		killTree: () => {
			h.events.push("killTree:4242");
			throw new Error("ESRCH");
		},
	});
	await h.provider.closeSurface(pane7Handle(h.provider));
	assert.deepEqual(h.events, ["killTree:4242", "sleep:3000", "pane.close"]);
});

test("no-throw: sleep reject → vẫn pane.close và closeSurface resolve", async () => {
	const h = makeHarness({
		sleep: async () => {
			h.events.push("sleep:3000");
			throw new Error("timer fault");
		},
	});
	await h.provider.closeSurface(pane7Handle(h.provider));
	assert.deepEqual(h.events, ["killTree:4242", "sleep:3000", "pane.close"]);
});

test("no-throw: resolveWorkerPid ném → bỏ kill, vẫn pane.close và resolve", async () => {
	const h = makeHarness({
		resolveWorkerPid: () => {
			throw new Error("manifest unreadable");
		},
	});
	await h.provider.closeSurface(pane7Handle(h.provider));
	assert.deepEqual(h.events, ["pane.close"]);
});

test("pane_not_found → idempotent resolve (hành vi cũ nguyên vẹn)", async () => {
	const h = makeHarness({}, "pane_not_found");
	await h.provider.closeSurface(pane7Handle(h.provider));
	assert.deepEqual(h.events, ["killTree:4242", "sleep:3000", "pane.close"]);
});

test("lỗi pane.close KHÁC → vẫn throw về caller (hành vi cũ nguyên vẹn)", async () => {
	const h = makeHarness({}, "other_error");
	await assert.rejects(() => h.provider.closeSurface(pane7Handle(h.provider)), /internal_error: boom/);
	assert.deepEqual(h.events, ["killTree:4242", "sleep:3000", "pane.close"]);
});

test("graceful + force luân phiên trên cùng provider: force sau graceful không kill", async () => {
	const h = makeHarness();
	const handle = pane7Handle(h.provider);
	await h.provider.closeSurface(handle);
	// Pane thứ hai cùng provider — force phải bỏ kill.
	await h.provider.closeSurface(h.provider.attach("w1:p9") ?? handle, { force: true });
	assert.deepEqual(h.events, ["killTree:4242", "sleep:3000", "pane.close", "pane.close"]);
});
