/**
 * Phase 1.5 worker-thread atomic writer (RFC: 15-PHASE1.5-WORKER-WRITER-RFC.md).
 *
 * Background: multi-step goal-wrapped workflows crash silently and
 * non-deterministically during batch transitions. The crash point moves to
 * every `await` yield in the write path (mkdir, open, stat, rename,
 * appendEvent). Sync replacements regress. Hypothesis: V8/libuv-level race
 * during event-loop yields. Mitigation: route writes through a dedicated
 * worker thread that performs SYNC fs operations with no internal yields.
 *
 * Opt-in via `PI_CREW_WORKER_ATOMIC_WRITER=1`. When disabled, callers fall
 * back to the regular async path. Safe to ship behind a flag.
 *
 * PHASE 0 hardening (U22 bước-0, 2026-10-13):
 *   (a) worker source no longer references logInternalError (ReferenceError
 *       in worker) — replaced with console.error("[worker-atomic-writer] …").
 *   (b) syncAtomicWriteFile fsyncs data + parent dir (parity atomic-write.ts).
 *   (c) syncAppend fsyncs on the same fd (parity event-log FIND-10).
 *   (d) per-request timeout (PI_CREW_WORKER_ATOMIC_TIMEOUT_MS, default 10s).
 *   (e) temp dir cached once per process, removed on terminate + exit hook.
 *   (f) worker "exit" drains pending requests ("writer exited").
 *   P3  main-side symlink guard on the append path + mode passthrough.
 *
 * Protocol (main → worker):
 *   { kind: "write", id, filePath, content, mode? }   // mode added in PHASE 0
 *   { kind: "mkdir", id, dirPath }
 *   { kind: "append", id, filePath, content }
 *
 * Protocol (worker → main):
 *   { kind: "done", id }
 *   { kind: "error", id, message }
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { getCrewEnv } from "../../config/env-vars.ts";
// P3: main-side symlink guard for the append path. Same util atomic-write.ts
// uses (isSymlinkSafeDirCached). This creates an import cycle with
// atomic-write.ts — safe: both modules only call the imported binding at
// runtime (never during module init), and ESM live bindings resolve lazily.
import { isSymlinkSafeDirCached } from "../atomic-write.ts";

const require = createRequire(import.meta.url);

let worker: Worker | undefined;
let workerTempDir: string | undefined;

/** Tests-only knob: keep the worker ref'd so the test runner doesn't exit
 *  before promises resolve. Production code leaves this false (worker is
 *  unref'd to avoid blocking process exit). */
let keepRefForTests = false;

/** Worker script source — runs SYNC fs ops with no internal yields. */
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function isSymlinkSafePath(filePath) {
  try {
    // Safe roots: the system temp dir (resolved through any symlinks, e.g.
    // macOS /var → /private/var) and the current project cwd.
    var tmpReal;
    try { tmpReal = fs.realpathSync(require("node:os").tmpdir()); } catch (e2) { tmpReal = require("node:os").tmpdir(); }
    var cwd = process.cwd();
    // Accept a symlink ancestor as safe if the resolved target (a) IS a safe
    // root, (b) is UNDER a safe root (target is a descendant), or (c) is an
    // ANCESTOR of a safe root (target is a parent dir of a safe root).
    // Case (c) is essential on macOS: /var → /private/var is an ancestor of
    // the tmpdir /private/var/folders/…, so it must be allowed.
    var isSafeAncestor = function (real) {
      var roots = [tmpReal, cwd];
      return roots.some(function (root) {
        return real === root
          || real.indexOf(root + path.sep) === 0
          || root.indexOf(real + path.sep) === 0;
      });
    };
    var currentPath = filePath;
    while (currentPath !== path.dirname(currentPath)) {
      var dir = path.dirname(currentPath);
      try {
        var stat = fs.lstatSync(dir);
        if (stat.isSymbolicLink()) {
          var real = fs.realpathSync(dir);
          if (!isSafeAncestor(real)) return false;
        }
      } catch (e3) { /* not found — fine */ }
      currentPath = dir;
    }
    return true;
  } catch (e) { return true; }
}

// PHASE 0 (b): fsync data before close + fsync the parent dir after rename —
// parity with the main-thread sync path (atomic-write.ts: fsyncSync(fd) then
// fsyncParentDirImmediate). Without the data fsync, rename may become durable
// before the content; without the dir fsync, the rename itself may not be.
function fsyncParentDirBestEffort(filePath) {
  if (process.platform === "win32") return;
  try {
    var dirFd = fs.openSync(path.dirname(filePath), "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (dirError) { /* best-effort — not all filesystems support dir fsync */ }
}

function syncAtomicWriteFile(filePath, content, mode) {
  if (!isSymlinkSafePath(filePath)) throw new Error("Refusing to write: unsafe path: " + filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = filePath + "." + crypto.randomUUID() + ".tmp";
  try {
    const fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, typeof mode === "number" ? mode : 0o600);
    try {
      fs.writeSync(fd, content, undefined, "utf-8");
      // PHASE 0 (b): data fsync before close (was: writeFileSync, no fsync).
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
    // PHASE 0 (b): make the rename durable too.
    fsyncParentDirBestEffort(filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch (cleanupError) {
      // PHASE 0 (a): the repo logger is NOT importable inside the worker —
      // use console.error, keep the message code.
      console.error("[worker-atomic-writer] worker-atomic-writer.cleanup-temp", cleanupError, "tempPath=" + tempPath);
    }
    // If rename raced with another writer that produced identical content, swallow.
    if (error && error.code === "EEXIST") {
      try {
        const existing = fs.readFileSync(filePath, "utf-8");
        if (existing === content) return;
      } catch (compareError) {
        // PHASE 0 (a): same — console.error, keep the message code.
        console.error("[worker-atomic-writer] worker-atomic-writer.compare-existing", compareError, "filePath=" + filePath);
      }
    }
    throw error;
  }
}

// PHASE 0 (c): single-fd append+fsync — parity with the event-log main path
// (FIND-10). Previously appendFileSync with no fsync at all.
// FIX (security F3): O_NOFOLLOW refuses a final-path symlink (ELOOP), closing
// the TOCTOU symlink-swap window between the MAIN-side guard and this open —
// a swapped-in symlink after the guard would otherwise redirect the append.
// On platforms without O_NOFOLLOW (win32), fall back to a pre-open lstat
// refusal (best-effort race window, same rejection semantics).
function syncAppend(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  var appendFlags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT;
  if (typeof fs.constants.O_NOFOLLOW === "number") {
    appendFlags |= fs.constants.O_NOFOLLOW;
  } else {
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) {
        throw new Error("Refusing to append: target is a symlink: " + filePath);
      }
    } catch (lstatError) {
      if (!lstatError || lstatError.code !== "ENOENT") throw lstatError;
    }
  }
  const fd = fs.openSync(filePath, appendFlags);
  try {
    fs.writeSync(fd, content, undefined, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

parentPort.on("message", (msg) => {
  try {
    if (msg.kind === "write") syncAtomicWriteFile(msg.filePath, msg.content, msg.mode);
    else if (msg.kind === "mkdir") fs.mkdirSync(msg.dirPath, { recursive: true });
    else if (msg.kind === "append") syncAppend(msg.filePath, msg.content);
    else throw new Error("worker-atomic-writer: unknown message kind: " + msg.kind);
    parentPort.postMessage({ kind: "done", id: msg.id });
  } catch (error) {
    parentPort.postMessage({ kind: "error", id: msg.id, message: error && error.message ? error.message : String(error) });
  }
});
`;

// ── PHASE 0 (d): per-request timeout ────────────────────────────────────────

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Per-request timeout for worker dispatches. Read main-side; the env name is
 * intentionally unregistered in CREW_ENV_VARS — getCrewEnv falls back to a
 * raw process.env read for unregistered names (pinned by
 * test/unit/config/env-vars.test.ts "unregistered names fall back").
 */
export function readWorkerAtomicTimeoutMs(): number {
	const raw = getCrewEnv("PI_CREW_WORKER_ATOMIC_TIMEOUT_MS");
	if (raw === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REQUEST_TIMEOUT_MS;
	return parsed;
}

/** Reply shape worker → main. */
export interface WorkerWriterReply {
	kind: string;
	id: number;
	message?: string;
}

/**
 * Minimal event surface the request bookkeeper needs. Satisfied by
 * `Worker` and by test doubles, so the timeout / exit-drain / error-drain
 * logic is unit-testable without spawning a real worker thread.
 */
export interface WorkerEventSource {
	on(event: "message", listener: (msg: WorkerWriterReply) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "exit", listener: (exitCode: number) => void): unknown;
}

interface PendingEntry {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout | undefined;
}

/**
 * PHASE 0 (d)/(f): bookkeeping for in-flight worker requests — id
 * assignment, per-request timeout, reply settle, and reject-all drain on
 * worker death ("error") or clean exit ("exit"). Extracted from module-level
 * state (previously a bare Map with no timeout and error-only drain) so the
 * hang-timeout and exit-drain behaviors can be tested against a fake event
 * emitter.
 *
 * The instance outlives worker restarts: ids keep incrementing across worker
 * generations, and `attach` takes an `isActive` guard so a LATE "exit" of an
 * already-replaced worker cannot drain requests in flight on its successor.
 */
export class WorkerRequestBookkeeper {
	private readonly pending = new Map<number, PendingEntry>();
	private nextId = 1;
	private readonly timeoutMs: number;

	// NOTE: no parameter property — child processes import this module with
	// --experimental-strip-types, which rejects TS transform-only syntax
	// (US-011 regression, caught in Phase 1 gate).
	constructor(timeoutMs: number) {
		this.timeoutMs = timeoutMs;
	}

	/** Wire a worker's (or fake's) message/error/exit events into the map. */
	attach(source: WorkerEventSource, isActive?: () => boolean): void {
		const active = isActive ?? (() => true);
		source.on("message", (msg) => {
			if (active()) this.settle(msg);
		});
		source.on("error", (error) => {
			if (active()) this.drain(error);
		});
		source.on("exit", (exitCode) => {
			if (active()) this.drain(new Error(`worker-atomic-writer: writer exited (code=${exitCode})`));
		});
	}

	/** Register a pending request; returns its id. Starts the timeout timer
	 *  (skipped when timeoutMs <= 0, which tests use to isolate drain paths). */
	register(resolve: () => void, reject: (error: Error) => void): number {
		const id = this.nextId++;
		const entry: PendingEntry = { resolve, reject, timer: undefined };
		if (this.timeoutMs > 0) {
			entry.timer = setTimeout(() => {
				this.pending.delete(id);
				entry.reject(new Error(`worker-atomic-writer: request timed out after ${this.timeoutMs}ms (id=${id})`));
			}, this.timeoutMs);
			entry.timer.unref();
		}
		this.pending.set(id, entry);
		return id;
	}

	/** Remove a request without settling it (postMessage threw synchronously
	 *  after register — the worker never saw it, so no reply will come). */
	cancel(id: number): void {
		const entry = this.pending.get(id);
		if (!entry) return;
		if (entry.timer) clearTimeout(entry.timer);
		this.pending.delete(id);
	}

	/** Reject every in-flight request — worker error, exit, or terminate. */
	drain(error: Error): void {
		for (const [, entry] of this.pending) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}

	/** Number of in-flight requests (tests + diagnostics). */
	get inflight(): number {
		return this.pending.size;
	}

	private settle(msg: WorkerWriterReply): void {
		const entry = this.pending.get(msg.id);
		if (!entry) return;
		this.pending.delete(msg.id);
		if (entry.timer) clearTimeout(entry.timer);
		if (msg.kind === "done") entry.resolve();
		else entry.reject(new Error(msg.message ?? "worker-atomic-writer: unknown error"));
	}
}

let bookkeeper: WorkerRequestBookkeeper | undefined;

function getBookkeeper(): WorkerRequestBookkeeper {
	bookkeeper ??= new WorkerRequestBookkeeper(readWorkerAtomicTimeoutMs());
	return bookkeeper;
}

// ── PHASE 0 (e): temp-dir lifecycle ─────────────────────────────────────────

/** Cached per-process temp dir for the worker.cjs bootstrap file. Only
 *  re-created when missing (first spawn, or after a terminate/exit cleanup
 *  removed it) — a worker restart no longer leaks a new mkdtemp dir. */
function getWorkerTempDir(): string {
	if (!workerTempDir || !fs.existsSync(workerTempDir)) {
		workerTempDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "pi-crew-waw-"));
	}
	return workerTempDir;
}

function cleanupWorkerTempDir(): void {
	if (!workerTempDir) return;
	try {
		fs.rmSync(workerTempDir, { recursive: true, force: true });
	} catch {
		/* best-effort — process may be exiting */
	}
	workerTempDir = undefined;
}

// (e) best-effort cleanup at process exit. rmSync is synchronous, so it is
// safe inside an "exit" handler. Registered once at module load.
process.on("exit", () => {
	cleanupWorkerTempDir();
});

function getWorker(): Worker {
	if (worker) return worker;
	// Write worker source to a temp file (so Worker can load it as CJS via
	// require() inside the worker, which always has CommonJS available).
	const tmpPath = path.join(getWorkerTempDir(), "worker.cjs");
	fs.writeFileSync(tmpPath, WORKER_SOURCE, "utf-8");
	worker = new Worker(tmpPath);
	const w = worker;
	// (d)/(f): message settle + reject-all drain on error/exit. The isActive
	// guard ignores late events from a previous (already replaced) worker so
	// they cannot drain requests in flight on the new one.
	getBookkeeper().attach(w, () => worker === w);
	// Respawn on death: drop the singleton so the next dispatch builds a
	// fresh worker (the bookkeeper and its pending map survive the restart).
	w.on("error", () => {
		if (worker === w) worker = undefined;
	});
	w.on("exit", () => {
		if (worker === w) worker = undefined;
	});
	w.unref(); // don't keep event loop alive (unless tests request it)
	if (keepRefForTests) w.ref();
	return worker;
}

function dispatch(kind: "write" | "mkdir" | "append", payload: Record<string, unknown>): Promise<void> {
	return new Promise((resolve, reject) => {
		const bk = getBookkeeper();
		const id = bk.register(resolve, reject);
		try {
			getWorker().postMessage({ kind, id, ...payload });
		} catch (error) {
			bk.cancel(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

/** Whether the worker writer is enabled (env var opt-in). */
export function isWorkerAtomicWriterEnabled(): boolean {
	return getCrewEnv("PI_CREW_WORKER_ATOMIC_WRITER") === "1" || getCrewEnv("PI_TEAMS_WORKER_ATOMIC_WRITER") === "1";
}

/**
 * Atomic-write a file via the worker thread. Sync fs ops inside worker.
 * PHASE 0 P3: `mode` passes through the message protocol (worker defaults to
 * 0o600 when absent). Durability is not forwarded — per defect (b) the worker
 * now ALWAYS fsyncs data + parent dir (durability:"full" semantics).
 */
export function atomicWriteFileViaWorker(filePath: string, content: string, mode?: number): Promise<void> {
	return dispatch("write", { filePath, content, mode });
}

/**
 * Append to a file via the worker thread (used by event-log).
 * PHASE 0 P3: the symlink guard runs MAIN-side, BEFORE dispatch — the worker
 * cannot import repo modules, and its own path guard only walks ancestor
 * DIRS, so a symlinked target FILE would otherwise pass straight through.
 * Same guard util atomic-write.ts uses on its write path.
 */
export async function appendFileViaWorker(filePath: string, content: string): Promise<void> {
	if (!isSymlinkSafeDirCached(filePath))
		throw new Error(`Refusing to append: target is a symlink or inside untrusted directory: ${filePath}`);
	return dispatch("append", { filePath, content });
}

/** Terminate the worker (for tests / cleanup). PHASE 0 (e): also removes the
 *  cached temp dir (recreated on the next spawn) and drains pending. */
export function terminateWorkerAtomicWriter(): void {
	if (worker) {
		const w = worker;
		worker = undefined;
		w.terminate().catch(() => {
			/* ignore */
		});
	}
	getBookkeeper().drain(new Error("worker terminated"));
	cleanupWorkerTempDir();
}

export function __setKeepWorkerRefForTests(value: boolean): void {
	keepRefForTests = value;
}

/** Tests-only: the current cached worker temp dir (for cleanup assertions). */
export function __getWorkerTempDirForTests(): string | undefined {
	return workerTempDir;
}
