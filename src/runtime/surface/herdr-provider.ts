/**
 * herdr SurfaceProvider (spec §4) — Socket API NDJSON client
 *
 * Wire format đối chiếu trực tiếp với server herdr 0.8.2 (protocol 20) qua
 * `herdr api schema --json` + probe trên socket thật (2026-08-26):
 * - MỖI REQUEST MỘT CONNECTION: connect → 1 dòng request `{"id","method","params"}`
 *   → 1 dòng response cùng id → server tự đóng (request thứ hai trên cùng
 *   connection nhận broken pipe). Verified thực nghiệm.
 * - Subscription là connection dài hạn riêng: ack `subscription_started` rồi
 *   mỗi dòng sau là event pushed với envelope `{"event":"pane_closed","data":{...}}`
 *   — event kind DÙNG UNDERSCORE và KHÔNG có id (khác request/response).
 *   Subscribe cả `pane.closed` (đóng qua API) LẪN `pane.exited` (process
 *   exit tự nhiên) — herdr 0.8.2 KHÔNG push pane.closed cho exit tự nhiên.
 * - Socket path resolution theo docs herdr.dev/docs/socket-api:
 *   HERDR_SOCKET_PATH → HERDR_SESSION (sessions/<name>/herdr.sock) → default.
 *
 * onExit: MỘT subscription connection chung cho cả provider (lazy — mở khi
 * handle đầu tiên đăng ký onExit), subscribe `pane.closed` server-wide rồi
 * filter theo pane_id client-side (schema không hỗ trợ filter pane_id cho
 * pane.closed). Subscription socket EOF (server chết/restart) → "mux-dead"
 * cho mọi handle còn sống.
 *
 * closeSurface A1/A2: herdr không có signal-theo-pid trên socket API. Force
 * path dùng `pane.close` — herdr tự terminate cả cây process trong pane
 * (nguyên vẹn như trước). Graceful path (A2, TODO→DONE 2026-10-11): khi host
 * cung cấp pid worker qua deps.resolveWorkerPid (nguồn dự kiến:
 * manifest.surface.workerPids đảo ngược panes — `pane.process_info` chưa có
 * trên wire 0.8.2 đã verify), SIGTERM cây process worker TRƯỚC qua
 * killProcessTree của child-pi (group kill + escalation SIGKILL sẵn có, tự
 * no-throw), đợi grace window cho worker flush, rồi pane.close vẫn chạy làm
 * kill-tree fallback (idempotent). Không wire resolveWorkerPid (default
 * null) → graceful giữ nguyên hành vi cũ (chỉ pane.close).
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { logInternalError } from "../../utils/internal-error.ts";
import { killProcessTree } from "../child-pi/child-pi-kill.ts";
import type { SurfaceDetection, SurfaceExitReason, SurfaceHandle, SurfaceProvider, SurfaceSpawnOpts } from "./surface-provider.ts";
import { MAX_PANES_PER_TAB, splitDirectionFor } from "./surface-provider.ts";

/** Grace window giữa SIGTERM worker pid và pane.close fallback (đối chiều tmux provider). */
const GRACEFUL_TERM_WAIT_MS = 3000;

/** R3-M-B3: per-request deadline on the one-connection-per-request `call()` —
 * a wedged herdr server must fail the caller instead of hanging the host
 * until some outer 600s deadline (gap caught in the E2E herdr battery). */
const HERDR_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Socket abstraction injectable. Quy ước EOF/error: onLine được gọi đúng một
 * lần với chuỗi rỗng khi server đóng connection (đối chiếu NDJSON — dòng
 * rỗng không bao giờ là message hợp lệ).
 */
export interface HerdrSocket {
	write(line: string): void;
	onLine(cb: (line: string) => void): void;
	close(): void;
}

/** Dependencies injectable — mọi I/O đều thay được để unit test không chạm server thật. */
export interface HerdrProviderDeps {
	/** Mở connection tới socket path. Throw khi không connect được. */
	connect?: (path: string) => HerdrSocket;
	/** Nguồn HERDR_SOCKET_PATH / HERDR_SESSION (default process.env). */
	env?: NodeJS.ProcessEnv;
	/**
	 * A2 graceful: pane id → pid worker. Host tra nguồn pid của mình (dự kiến
	 * manifest.surface.workerPids đảo ngược panes map). Default trả null →
	 * graceful về đúng hành vi cũ (chỉ pane.close). Caller được best-effort
	 * bảo vệ (try/catch tại closeSurface) nhưng KHÔNG nên throw.
	 */
	resolveWorkerPid?: (paneId: string) => number | null;
	/** A2 graceful: SIGTERM cây process theo pid (default killProcessTree của
	 * child-pi — no-throw, group kill + SIGKILL escalation). */
	killTree?: (pid: number) => void;
	/** A2 graceful: chờ grace window sau SIGTERM (default setTimeout). */
	sleep?: (ms: number) => Promise<void>;
}

/** herdr socket path theo docs: HERDR_SOCKET_PATH → HERDR_SESSION → default. */
export function herdrSocketPath(env: NodeJS.ProcessEnv): string {
	if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
	if (env.HERDR_SESSION) {
		return path.join(os.homedir(), ".config", "herdr", "sessions", env.HERDR_SESSION, "herdr.sock");
	}
	return path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

/** Default connect: unix socket NDJSON. accessSync fail-fast cho detect sync. */
function defaultConnect(socketPath: string): HerdrSocket {
	fs.accessSync(socketPath);
	// KHÔNG unref: request socket tự đóng sau response (vài ms), còn
	// subscription socket PHẢI giữ event loop sống khi còn pane cần theo dõi —
	// unref khiến process exit giữa chừng với promise pending.
	const socket = net.createConnection({ path: socketPath });
	let lineCb: ((line: string) => void) | null = null;
	let buffer = "";
	let ended = false;
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let idx = buffer.indexOf("\n");
		while (idx !== -1) {
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (line.trim()) lineCb?.(line);
			idx = buffer.indexOf("\n");
		}
	});
	const onEnd = (): void => {
		if (ended) return;
		ended = true;
		lineCb?.("");
		lineCb = null;
	};
	socket.on("close", onEnd);
	socket.on("error", onEnd);
	return {
		write(line) {
			socket.write(`${line}\n`);
		},
		onLine(cb) {
			lineCb = cb;
		},
		close() {
			socket.destroy();
		},
	};
}

/** Một dòng response/error từ server (đã parse). */
interface WireResponse {
	id?: string;
	result?: { type?: string } & Record<string, unknown>;
	error?: { code?: string; message?: string };
}

/** Một dòng event pushed trên subscription connection (đã parse). */
interface WireEvent {
	event?: string;
	data?: { pane_id?: string };
	/** R3-M-B3: an error ACK carries the request id and an error object — no
	 * `event` envelope (previously silently ignored, leaving watchers hung on
	 * a subscription the server actually refused). */
	id?: string;
	error?: { code?: string; message?: string };
}

/** Watcher theo pane id — callback list + trạng thái exit cho replay. */
interface PaneWatcher {
	callbacks: Array<(reason: SurfaceExitReason) => void>;
	exited: boolean;
	reason?: SurfaceExitReason;
}

export function createHerdrProvider(deps: HerdrProviderDeps = {}): SurfaceProvider {
	const env = deps.env ?? process.env;
	const connect = deps.connect ?? defaultConnect;
	const resolveWorkerPid = deps.resolveWorkerPid ?? (() => null);
	const killTree = deps.killTree ?? ((pid: number) => killProcessTree(pid));
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	const watchers = new Map<string, PaneWatcher>();
	let reqSeq = 0;
	let subscription: HerdrSocket | null = null;
	let subscriptionCb: ((line: string) => void) | null = null;
	// R3-M-B3: id of the in-flight events.subscribe request — lets
	// onSubscriptionLine recognize an error ACK (frame with id, no event) and
	// treat the subscription as dead instead of waiting forever.
	let subscriptionRequestId: string | null = null;

	// Tab-layout (spec 2026-08-27-surface-tab-layout): tabKey(run) → {tabIds
	// (MỌI tab của run), rootPaneId (tab đang nhận split), paneCount}. Tab mở
	// khi run spawn worker đầu; KHÔNG đóng khi worker xong — chỉ đóng khi run
	// end (Task 5 gọi closeTab). Giữ array vì run dài có thể vượt
	// MAX_PANES_PER_TAB và mở tab kế — closeTab phải dọn cả tab cũ.
	const tabMap = new Map<string, { tabIds: string[]; rootPaneId: string; paneCount: number }>();
	// Race Task 4 (review Task 3): serialize createSurface per tabKey — giữa lúc
	// đọc tabMap và deferred-commit có 2 await (tab.create + pane.split) nên
	// caller spawn worker song song sẽ đua nhau. Xem createSurface.
	const tabInFlight = new Map<string, Promise<unknown>>();

	function activeWatchers(): number {
		let active = 0;
		for (const watcher of watchers.values()) if (!watcher.exited) active += 1;
		return active;
	}

	// F12-M1 (R2-L-B4 twin): exited watchers were retained forever — the only
	// deletion site was `handle.dispose()`, which the host does not call per pane,
	// so every herdr surface pane leaked one entry (callbacks + reason closure) for
	// the whole host session. `fire()` now MOVES the entry into a bounded
	// recently-exited ring (late subscribers still get their reason replayed once)
	// instead of keeping it alive. Mirrors tmux-provider.ts:150-186.
	const exitedRecent = new Map<string, SurfaceExitReason>();
	const EXITED_RECENT_CAP = 64;

	/** Bắn reason MỘT lần cho mọi callback của pane (copy list — cb có thể dispose). */
	function fire(paneId: string, reason: SurfaceExitReason): void {
		const watcher = watchers.get(paneId);
		if (!watcher || watcher.exited) return;
		watcher.exited = true;
		watcher.reason = reason;
		for (const cb of [...watcher.callbacks]) cb(reason);
		// F12-M1: free the watcher entry after the callbacks fired — keep only a
		// bounded reason ring for late-subscriber replay (onExit below).
		watchers.delete(paneId);
		exitedRecent.set(paneId, reason);
		if (exitedRecent.size > EXITED_RECENT_CAP) {
			const oldest = exitedRecent.keys().next().value;
			if (oldest !== undefined) exitedRecent.delete(oldest);
		}
		maybeCloseSubscription();
	}

	function maybeCloseSubscription(): void {
		if (!subscription || activeWatchers() > 0) return;
		subscription.close();
		subscription = null;
		subscriptionCb = null;
	}

	/**
	 * Gửi một request trên connection riêng (verified: server đóng sau response).
	 * Đóng socket ngay khi có kết quả — id tăng dần req-N toàn provider.
	 */
	function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
		reqSeq += 1;
		const id = `req-${reqSeq}`;
		return new Promise<T>((resolve, reject) => {
			let socket: HerdrSocket;
			try {
				socket = connect(herdrSocketPath(env));
			} catch (err) {
				reject(new Error(`herdr socket unavailable: ${(err as Error).message}`));
				return;
			}
			let settled = false;
			// R3-M-B3: per-request deadline — see HERDR_REQUEST_TIMEOUT_MS. A wedged
			// herdr server must fail the caller instead of hanging until an outer
			// 600s deadline (gap caught in the E2E herdr battery).
			const requestTimer = setTimeout(() => {
				if (settled) return;
				settled = true;
				socket.close();
				reject(new Error(`herdr request timeout: no response to ${id} (${method}) within ${HERDR_REQUEST_TIMEOUT_MS}ms`));
			}, HERDR_REQUEST_TIMEOUT_MS);
			requestTimer.unref?.();
			socket.onLine((line) => {
				if (settled) return;
				if (!line) {
					// EOF trước response — server chết giữa chừng.
					settled = true;
					clearTimeout(requestTimer);
					socket.close();
					reject(new Error(`herdr socket closed before response to ${id} (${method})`));
					return;
				}
				let msg: WireResponse;
				try {
					msg = JSON.parse(line) as WireResponse;
				} catch {
					return; // dòng lệch format — bỏ qua, chờ response thật
				}
				if (msg.id !== id) return;
				settled = true;
				clearTimeout(requestTimer);
				socket.close();
				if (msg.error) {
					reject(new Error(`${msg.error.code ?? "herdr_error"}: ${msg.error.message ?? "unknown error"}`));
					return;
				}
				resolve(msg.result as T);
			});
			// Wire là newline-JSON nhưng KHÔNG tự thêm \n ở đây: defaultConnect's
			// write() wrapper đã nối `\n` (verified live herdr 0.8.2, 2026-08-27:
			// frame `\n\n` khiến server ĐÓNG subscription connection — empty line
			// bị coi là malformed → mọi watcher thành mux-dead).
			socket.write(JSON.stringify({ id, method, params }));
		});
	}

	/** Dispatch một dòng trên subscription connection: event hoặc EOF. */
	function onSubscriptionLine(line: string): void {
		if (!line) {
			// Server đóng subscription socket — mọi handle còn sống thành mux-dead.
			subscription = null;
			subscriptionCb = null;
			subscriptionRequestId = null;
			for (const paneId of [...watchers.keys()]) fire(paneId, "mux-dead");
			return;
		}
		let msg: WireEvent;
		try {
			msg = JSON.parse(line) as WireEvent;
		} catch {
			return;
		}
		// R3-M-B3 (2026-10-17): error ACK for events.subscribe — a frame carrying
		// the request id and an error object (NO event envelope) means the server
		// refused the subscription (bad params / protocol drift). Previously this
		// frame fell through the event filter below and was silently ignored,
		// leaving every watcher hung until the 600s outer deadline. Treat it as
		// mux-dead (same as EOF) so handles fail fast + the reason is logged.
		if (msg.id !== undefined && msg.error !== undefined && msg.id === subscriptionRequestId) {
			logInternalError(
				"herdr-provider",
				new Error(`events.subscribe rejected: ${msg.error.code ?? "herdr_error"}: ${msg.error.message ?? "unknown error"}`),
				herdrSocketPath(env),
				"warn",
			);
			const deadSubscription = subscription;
			subscription = null;
			subscriptionCb = null;
			subscriptionRequestId = null;
			try {
				deadSubscription?.close();
			} catch {
				/* already closed */
			}
			for (const paneId of [...watchers.keys()]) fire(paneId, "mux-dead");
			return;
		}
		// CẢ HAI loại event đều là "pane biến mất" cho pi-crew (verified live
		// herdr 0.8.2, 2026-08-27): `pane_closed` chỉ bắn khi đóng qua API
		// pane.close; process exit tự nhiên (worker xong việc → shell `exit`)
		// chỉ bắn `pane_exited` — thiếu nó thì mọi worker hoàn thành bình thường
		// treo host tới response deadline 600s (bắt được từ E2E herdr thật).
		if (msg.event !== "pane_closed" && msg.event !== "pane_exited") return;
		const paneId = msg.data?.pane_id;
		if (typeof paneId === "string" && watchers.has(paneId)) fire(paneId, "pane-closed");
	}

	/**
	 * Mở (một lần) subscription connection khi handle đầu tiên cần onExit.
	 * Lazy như ensureTimer của tmux provider — không giữ socket khi không
	 * theo dõi pane nào. Subscribe fail → mux-dead mọi watcher sống.
	 * Note: pane đóng giữa split xong và onExit đầu tiên sẽ mất event —
	 * caller đăng ký onExit ngay sau createSurface nên gap chỉ tính ms.
	 */
	function ensureSubscription(): void {
		if (subscription) return;
		reqSeq += 1;
		const id = `req-${reqSeq}`;
		let socket: HerdrSocket;
		try {
			socket = connect(herdrSocketPath(env));
		} catch {
			for (const paneId of [...watchers.keys()]) fire(paneId, "mux-dead");
			return;
		}
		subscription = socket;
		subscriptionCb = onSubscriptionLine;
		subscriptionRequestId = id;
		socket.onLine((line) => subscriptionCb?.(line));
		// Frame nối \n bởi defaultConnect's write() wrapper — KHÔNG thêm \n ở
		// đây (frame `\n\n` → server đóng subscription, xem comment trong call()).
		// Subscribe CẢ pane.closed LẪN pane.exited — xem onSubscriptionLine.
		socket.write(
			JSON.stringify({
				id,
				method: "events.subscribe",
				params: { subscriptions: [{ type: "pane.closed" }, { type: "pane.exited" }] },
			}),
		);
		// Ack subscription_started cũng đi qua onSubscriptionLine — JSON hợp lệ
		// nhưng thiếu envelope event nên bị bỏ qua một cách vô hại.
	}

	function makeHandle(paneId: string, tabId?: string): SurfaceHandle {
		return {
			id: paneId,
			kind: "herdr",
			...(tabId ? { tabId } : {}),
			onExit(cb) {
				// F12-M1: late subscriber on an already-fired pane — replay the exit
				// reason from the bounded ring, then serve it (single replay). Mirrors
				// tmux-provider.ts onExit.
				const exitedReason = exitedRecent.get(paneId);
				if (exitedReason !== undefined) {
					exitedRecent.delete(paneId);
					cb(exitedReason);
					return;
				}
				let watcher = watchers.get(paneId);
				if (!watcher) {
					watcher = { callbacks: [], exited: false };
					watchers.set(paneId, watcher);
				}
				watcher.callbacks.push(cb);
				// Đăng ký sau exit → replay reason ngay để không mất event.
				if (watcher.exited) {
					cb(watcher.reason as SurfaceExitReason);
					return;
				}
				ensureSubscription();
			},
			dispose() {
				const watcher = watchers.get(paneId);
				if (!watcher) {
					exitedRecent.delete(paneId);
					return;
				}
				// Host chủ động dispose khi pane còn sống → "detached" cho listener.
				if (!watcher.exited) fire(paneId, "detached");
				watchers.delete(paneId);
				exitedRecent.delete(paneId);
				maybeCloseSubscription();
			},
		};
	}

	function assertHerdrHandle(handle: SurfaceHandle): void {
		if (handle.kind !== "herdr") {
			throw new Error(`Expected a herdr handle, got kind "${handle.kind}" (id ${handle.id})`);
		}
	}

	/**
	 * Thân spawn chung sau khi biết pane cha + hướng: pane.split → commit
	 * tab-map (nếu có) → rename (cosmetic) → command → handle.
	 */
	async function splitAndBoot(
		opts: SurfaceSpawnOpts,
		parentPaneId: string,
		direction: "down" | "right",
		commitTabPane: (() => void) | null,
		tabId?: string,
	): Promise<SurfaceHandle> {
		const split = await call<{ pane?: { pane_id?: string } }>("pane.split", {
			direction,
			target_pane_id: parentPaneId,
			cwd: opts.cwd,
			focus: false,
		});
		const paneId = split.pane?.pane_id;
		if (!paneId) throw new Error("pane.split returned no pane_id");
		commitTabPane?.();
		if (opts.title) {
			try {
				await call("pane.rename", { pane_id: paneId, label: opts.title });
			} catch {
				// Title là cosmetic — pane vẫn dùng được.
			}
		}
		// Command đã build sẵn ("bash <script-path>") — gửi literal + newline.
		// Commandless tạo pane là hợp lệ (spec §13.1) — bỏ qua khi không có.
		if (opts.command !== undefined) {
			await call("pane.send_text", { pane_id: paneId, text: `${opts.command}\n` });
		}
		return makeHandle(paneId, tabId);
	}

	/**
	 * Nhánh tabKey (spec tab-layout): mọi worker của cùng run chia 1 tab,
	 * split từ root pane của tab theo hướng dọc/ngang xen kẽ (spec tab-layout
	 * §4). CHỈ chạy trong lock per-tabKey (tabInFlight) — giữa lúc đọc tabMap
	 * và deferred-commit (sau split thành công) có await nên caller spawn
	 * song song sẽ đua nhau mà không lock.
	 */
	async function doTabSpawn(opts: SurfaceSpawnOpts, tabKey: string): Promise<SurfaceHandle> {
		const existing = tabMap.get(tabKey);
		// Tab-map chỉ commit sau khi pane.split THÀNH CÔNG — nếu split fail,
		// paneCount không đếm pane không tồn tại (luân phiên không lệch bước ở
		// lần retry kế tiếp) — cùng pattern tabWindows của tmux provider.
		if (existing && existing.paneCount < MAX_PANES_PER_TAB) {
			const paneIndexInTab = existing.paneCount;
			const currentTabId = existing.tabIds[existing.tabIds.length - 1] as string;
			return splitAndBoot(
				opts,
				existing.rootPaneId,
				splitDirectionFor(paneIndexInTab),
				() => {
					existing.paneCount = paneIndexInTab + 1;
				},
				currentTabId,
			);
		}
		// Tab mới cho run (hoặc tab cũ đã đầy MAX_PANES_PER_TAB pane).
		// Wire herdr thật (verified live 2026-08-27): `tab.create` params
		// {label, workspace_id?} → result.tab.tab_id + result.root_pane.pane_id.
		const created = await call<{ tab?: { tab_id?: string }; root_pane?: { pane_id?: string } }>("tab.create", {
			label: opts.title ?? tabKey,
			...(env.HERDR_WORKSPACE_ID ? { workspace_id: env.HERDR_WORKSPACE_ID } : {}),
		});
		const tabId = created.tab?.tab_id;
		const rootPaneId = created.root_pane?.pane_id;
		if (!tabId || !rootPaneId) throw new Error("tab.create returned no tab_id/root_pane");
		const priorTabIds = existing?.tabIds ?? [];
		return splitAndBoot(
			opts,
			rootPaneId,
			splitDirectionFor(0),
			() => {
				tabMap.set(tabKey, { tabIds: [...priorTabIds, tabId], rootPaneId, paneCount: 1 });
			},
			tabId,
		);
	}

	/** Đường legacy (spawn ngoài run, KHÔNG tabKey) — giữ nguyên như trước tab-layout. */
	async function spawnFromCallerPane(opts: SurfaceSpawnOpts): Promise<SurfaceHandle> {
		// Pane cha = pane của PROCESS đang gọi, lấy từ env HERDR_PANE_ID (đặt bởi
		// herdr server khi spawn process trong pane — tương đương $TMUX_PANE của
		// tmux). Fallback pane.current chỉ dùng khi env thiếu:
		//   - Verify live (2026-08-27): `herdr pane current` chạy trong pane w2:p57
		//     (KHÔNG focus) vẫn trả w2:p48 (focus hiện tại của server) — tức
		//     pane.current là FOCUS pane, KHÔNG phải pane của caller. Có truyền
		//     caller_pane_id thì server 0.8.2 vẫn không theo.
		//   - Env HERDR_PANE_ID là nguồn chính xác duy nhất cho "pane của process".
		const envPaneId = env.HERDR_PANE_ID;
		let parentPaneId: string | undefined;
		if (envPaneId) parentPaneId = envPaneId;
		else {
			const current = await call<{ pane?: { pane_id?: string } }>("pane.current", {});
			parentPaneId = current.pane?.pane_id;
		}
		if (!parentPaneId) {
			throw new Error("no parent pane — HERDR_PANE_ID unset, no tabKey, and pane.current returned no pane_id");
		}
		return splitAndBoot(opts, parentPaneId, "right", null);
	}

	return {
		kind: "herdr",

		detect(): SurfaceDetection {
			// Cheap probe: connect được tới socket là ok. Full liveness ping
			// (ping + timeout) là trách nhiệm resolveSurface (T2, pingSocketSync)
			// — SurfaceDetection sync nên provider không đợi response ở đây.
			try {
				const socket = connect(herdrSocketPath(env));
				socket.close();
				return { ok: true, kind: "herdr" };
			} catch (err) {
				return { ok: false, reason: `herdr socket unavailable: ${(err as Error).message}` };
			}
		},

		async createSurface(_name: string, opts: SurfaceSpawnOpts): Promise<SurfaceHandle> {
			if (!opts.tabKey) {
				// Không lock cho đường legacy — không đụng tabMap nên không race.
				return spawnFromCallerPane(opts);
			}
			// Race Task 4 (review Task 3): team-run spawn worker SONG SONG — 2
			// createSurface cùng tabKey sẽ cùng đọc tabMap trước khi cái nào commit
			// → 2 tab.create (1 tab mồ côi) hoặc cùng paneIndexInTab (under-count,
			// luân phiên lệch bước). Serialize per tabKey bằng promise chain. Entry
			// KHÔNG bị clear: promise đã settled thì `.then` kế chạy ngay ở
			// microtask, entry nhỏ và provider sống bằng run lifecycle. Chain lưu
			// bản .catch(() => {}) để MỘT lần fail không làm chết các lần sau.
			// tmux miễn nhiễm race này vì execFileSync sync.
			const tabKey = opts.tabKey;
			const prev = tabInFlight.get(tabKey) ?? Promise.resolve();
			const run = prev.then(() => doTabSpawn(opts, tabKey));
			// Chain lưu bản đã-nuốt-lỗi: `.then` kế chỉ cần biết promise đã settled
			// (kể cả reject); lỗi thật đã về caller qua `run`.
			tabInFlight.set(
				tabKey,
				// biome-ignore lint/suspicious/noEmptyBlockStatements: nuốt lỗi CÓ Ý ĐỊNH — chain cần promise không-bao-giờ-reject
				run.catch(() => {}),
			);
			return await run;
		},

		async sendCommand(handle, text) {
			assertHerdrHandle(handle);
			await call("pane.send_text", { pane_id: handle.id, text: `${text}\n` });
		},

		attach(id: string): SurfaceHandle | null {
			// SurfaceProvider.attach là SYNC nên không round-trip socket kiểm tra
			// pane tồn tại được (A1 ghi chú này từ đầu). Trước đây return null —
			// hệ quả: doctor xếp MỌI orphan herdr là "gone" và không bao giờ đóng
			// pane (bắt được từ E2E herdr 2026-08-27). Giờ trả handle OPTIMISTIC:
			// caller xác minh aliveness qua readScreen (async, doctor đã làm),
			// còn closeSurface lên pane không tồn tại đã idempotent
			// (pane_not_found → coi như đã đóng, không throw).
			return makeHandle(id);
		},

		async readScreen(handle: SurfaceHandle, lines = 50): Promise<string> {
			assertHerdrHandle(handle);
			// source "visible" — verified live trên herdr 0.8.2: "recent"/"recent_unwrapped"
			// trả text rỗng kể cả trên pane đang bận, còn "visible" trả đúng nội
			// dung màn hình (đúng ngữ nghĩa "current screen" của interface).
			const result = await call<{ read?: { text?: string } }>("pane.read", {
				pane_id: handle.id,
				source: "visible",
				lines: Math.max(1, lines),
			});
			return result.read?.text ?? "";
		},

		async closeSurface(handle: SurfaceHandle, opts?: { force?: boolean }): Promise<void> {
			assertHerdrHandle(handle);
			// A2 (graceful kill-by-pid, TODO→DONE): không force + host biết pid
			// worker → SIGTERM cây process worker trước (grace window cho worker
			// flush stdout/đóng session), pane.close sau đó vẫn chạy — vừa là
			// kill-tree fallback (herdr terminate cả cây trong pane) vừa dọn shell.
			// Mọi bước best-effort NO-THROW: pid đã chết (killTree tự nuốt ESRCH),
			// resolveWorkerPid/sleep throw, pid rác (0/1/âm) — đều không chặn close.
			if (!opts?.force) {
				let pid: number | null = null;
				try {
					pid = resolveWorkerPid(handle.id);
				} catch {
					pid = null; // seam của host — không để lỗi seam chặn close
				}
				if (typeof pid === "number" && Number.isInteger(pid) && pid > 1) {
					try {
						killTree(pid);
					} catch {
						// best-effort — signal fail không được chặn pane.close
					}
					try {
						await sleep(GRACEFUL_TERM_WAIT_MS);
					} catch {
						// timer fault — tiếp tục close
					}
				}
			}
			// A1: pane.close (force path nguyên vẹn như cũ) — herdr terminate cả cây
			// process trong pane.
			try {
				await call("pane.close", { pane_id: handle.id });
			} catch (err) {
				// Pane đã mất từ trước → mục tiêu đạt được, idempotent.
				if ((err as Error).message.includes("pane_not_found")) return;
				throw err;
			}
		},

		/**
		 * Task 5 (spec tab-layout §5): run end → đóng MỌI tab của run theo map
		 * nội bộ (run dài >8 pane mở tab kế — cả hai đều phải chết). tab đã mất
		 * (pane exit tự nhiên làm server dọn tab) → tab_not_found → idempotent;
		 * lỗi khác vẫn ném về closeTabForRun (best-effort log ở caller). Dọn cả
		 * lock tabInFlight (minor deferred từ review Task 4) — run đã kết thúc
		 * thì không còn spawn nào cùng tabKey.
		 */
		async closeTab(tabKey: string): Promise<void> {
			const entry = tabMap.get(tabKey);
			if (!entry) return;
			tabMap.delete(tabKey);
			tabInFlight.delete(tabKey);
			let firstError: unknown = null;
			for (const tabId of entry.tabIds) {
				try {
					await call("tab.close", { tab_id: tabId });
				} catch (err) {
					if ((err as Error).message.includes("tab_not_found")) continue; // idempotent
					if (firstError === null) firstError = err;
				}
			}
			if (firstError !== null) throw firstError;
		},

		/**
		 * Task 6 (doctor cleanup-by-id): đóng MỘT tab theo id đọc từ
		 * manifest.surface.tabs — doctor chạy ở process khác host đã spawn nên
		 * tabMap ở đó trống (closeTab no-op). Wire 0.8.2 không có lệnh đọc tab
		 * đã verify (tab.get chưa probe) nên liveness lấy từ CHÍNH tab.close:
		 * `tab_not_found` = server xác nhận tab đã mất → "gone", thành công →
		 * "closed" — idempotent như closeTab ở trên, lỗi thật vẫn ném về doctor.
		 */
		async closeTabById(tabId: string): Promise<"closed" | "gone"> {
			try {
				await call("tab.close", { tab_id: tabId });
				return "closed";
			} catch (err) {
				if ((err as Error).message.includes("tab_not_found")) return "gone";
				throw err;
			}
		},
	};
}
