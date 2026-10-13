/**
 * PHASE 0 (U22 bước-0) worker-atomic-writer hardening tests:
 *   (d) per-request timeout (fake event source — no real worker spin)
 *   (f) exit-drain rejects all pending ("writer exited")
 *   (    error-drain regression — on("error") reject-all kept)
 *   (e) temp-dir cached once per process, removed on terminate, recreated
 *   P3  symlink guard runs MAIN-side BEFORE worker dispatch (write + append)
 *   P3  mode passthrough (0o644 through the worker message protocol)
 *   (a) WORKER_SOURCE no longer references logInternalError
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { atomicWriteFileAsync } from "../../../../src/state/atomic-write.ts";
import {
	__getWorkerTempDirForTests,
	__setKeepWorkerRefForTests,
	appendFileViaWorker,
	atomicWriteFileViaWorker,
	readWorkerAtomicTimeoutMs,
	terminateWorkerAtomicWriter,
	type WorkerEventSource,
	WorkerRequestBookkeeper,
	type WorkerWriterReply,
} from "../../../../src/state/event-log/worker-atomic-writer.ts";

// Keep worker ref'd for the WHOLE suite so the test runner doesn't exit before
// promises resolve (same pattern as worker-atomic-writer.test.ts).
__setKeepWorkerRefForTests(true);

// ─── Fake worker event source (inject into WorkerRequestBookkeeper) ─────────

/** Minimal in-process stand-in for a Worker's event surface. Lets the
 *  timeout/drain bookkeeping be tested without spawning a thread that would
 *  have to be made to hang/crash on purpose. */
class FakeWorkerEvents implements WorkerEventSource {
	private readonly messageHandlers: Array<(msg: WorkerWriterReply) => void> = [];
	private readonly errorHandlers: Array<(error: Error) => void> = [];
	private readonly exitHandlers: Array<(exitCode: number) => void> = [];

	on(event: "message", listener: (msg: WorkerWriterReply) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "exit", listener: (exitCode: number) => void): unknown;
	on(event: "message" | "error" | "exit", listener: (arg: never) => void): unknown {
		if (event === "message") this.messageHandlers.push(listener as (msg: WorkerWriterReply) => void);
		else if (event === "error") this.errorHandlers.push(listener as (error: Error) => void);
		else this.exitHandlers.push(listener as (exitCode: number) => void);
		return this;
	}

	emitMessage(msg: WorkerWriterReply): void {
		for (const handler of this.messageHandlers) handler(msg);
	}
	emitError(error: Error): void {
		for (const handler of this.errorHandlers) handler(error);
	}
	emitExit(exitCode: number): void {
		for (const handler of this.exitHandlers) handler(exitCode);
	}
}

function registerPending(bk: WorkerRequestBookkeeper): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		bk.register(resolve, reject);
	});
}

/** The bookkeeper's timeout timers are unref'd on purpose (production: a
 *  hung request must not block process exit — the worker itself is unref'd
 *  too). With only a FAKE emitter attached there is no ref'd handle left, so
 *  the event loop would drain before the unref'd timer fires. Hold a ref'd
 *  timer for the duration of timer-dependent asserts. */
async function withLoopAlive<T>(fn: () => Promise<T>): Promise<T> {
	const keepAlive = setTimeout(() => {}, 60_000);
	try {
		return await fn();
	} finally {
		clearTimeout(keepAlive);
	}
}

// ─── (d) per-request timeout ────────────────────────────────────────────────

test("(d) bookkeeper: hung request rejects after the per-request timeout", async () => {
	await withLoopAlive(async () => {
		const bk = new WorkerRequestBookkeeper(40);
		bk.attach(new FakeWorkerEvents()); // worker never replies
		const hung = registerPending(bk);
		assert.equal(bk.inflight, 1);
		await assert.rejects(hung, /request timed out after 40ms/);
		assert.equal(bk.inflight, 0, "timed-out request must leave the pending map");
	});
});

test("(d) bookkeeper: late reply after timeout is ignored (no double settle)", async () => {
	await withLoopAlive(async () => {
		const bk = new WorkerRequestBookkeeper(30);
		const fake = new FakeWorkerEvents();
		bk.attach(fake);
		const hung = registerPending(bk);
		await assert.rejects(hung, /timed out/);
		// A very late done/error reply must not throw and must not resurrect state.
		fake.emitMessage({ kind: "done", id: 1 });
		fake.emitMessage({ kind: "error", id: 1, message: "late" });
		assert.equal(bk.inflight, 0);
	});
});

test("(d) bookkeeper: successful settle clears the timeout timer", async () => {
	const bk = new WorkerRequestBookkeeper(5_000);
	const fake = new FakeWorkerEvents();
	bk.attach(fake);
	const ok = registerPending(bk);
	fake.emitMessage({ kind: "done", id: 1 });
	await ok; // resolves immediately — timer (if alive) would keep the test hanging
	assert.equal(bk.inflight, 0);
});

// ─── (f) exit-drain + error-drain ───────────────────────────────────────────

test('(f) bookkeeper: worker exit rejects ALL pending with "writer exited"', async () => {
	const bk = new WorkerRequestBookkeeper(0); // timeout off — isolate exit-drain
	const fake = new FakeWorkerEvents();
	bk.attach(fake);
	const p1 = registerPending(bk);
	const p2 = registerPending(bk);
	assert.equal(bk.inflight, 2);
	fake.emitExit(0);
	await assert.rejects(p1, /writer exited \(code=0\)/);
	await assert.rejects(p2, /writer exited \(code=0\)/);
	assert.equal(bk.inflight, 0);
});

test('bookkeeper: worker error rejects ALL pending (regression of on("error") drain)', async () => {
	const bk = new WorkerRequestBookkeeper(0);
	const fake = new FakeWorkerEvents();
	bk.attach(fake);
	const p1 = registerPending(bk);
	const p2 = registerPending(bk);
	fake.emitError(new Error("worker thread crashed"));
	await assert.rejects(p1, /worker thread crashed/);
	await assert.rejects(p2, /worker thread crashed/);
	assert.equal(bk.inflight, 0);
});

test("bookkeeper: late exit of a REPLACED worker does not drain the new worker's requests", async () => {
	const bk = new WorkerRequestBookkeeper(0);
	// Model the module's `worker === w` guard: exactly one "current" emitter.
	let current: FakeWorkerEvents | undefined;
	const oldFake = new FakeWorkerEvents();
	current = oldFake;
	bk.attach(oldFake, () => current === oldFake);
	const staleRequest = registerPending(bk);
	// Worker A crashes while still current: its error drains its pending…
	oldFake.emitError(new Error("worker A crashed"));
	await assert.rejects(staleRequest, /worker A crashed/);
	// …and the module replaces it with worker B.
	const newFake = new FakeWorkerEvents();
	current = newFake;
	bk.attach(newFake, () => current === newFake);
	const freshRequest = registerPending(bk);
	// A's "exit" arrives LATE (error usually precedes exit) — must be ignored,
	// otherwise it would reject B's in-flight request.
	oldFake.emitExit(1);
	// B replies normally.
	newFake.emitMessage({ kind: "done", id: 2 });
	await freshRequest;
	assert.equal(bk.inflight, 0);
});

// ─── timeout env parsing ────────────────────────────────────────────────────

test("(d) readWorkerAtomicTimeoutMs: default 10000, override via env, invalid falls back", () => {
	const saved = process.env.PI_CREW_WORKER_ATOMIC_TIMEOUT_MS;
	try {
		delete process.env.PI_CREW_WORKER_ATOMIC_TIMEOUT_MS;
		assert.equal(readWorkerAtomicTimeoutMs(), 10_000);
		process.env.PI_CREW_WORKER_ATOMIC_TIMEOUT_MS = "250";
		assert.equal(readWorkerAtomicTimeoutMs(), 250);
		process.env.PI_CREW_WORKER_ATOMIC_TIMEOUT_MS = "0";
		assert.equal(readWorkerAtomicTimeoutMs(), 10_000, "0 is not a valid timeout — fallback");
		process.env.PI_CREW_WORKER_ATOMIC_TIMEOUT_MS = "-5";
		assert.equal(readWorkerAtomicTimeoutMs(), 10_000);
		process.env.PI_CREW_WORKER_ATOMIC_TIMEOUT_MS = "garbage";
		assert.equal(readWorkerAtomicTimeoutMs(), 10_000);
	} finally {
		if (saved === undefined) delete process.env.PI_CREW_WORKER_ATOMIC_TIMEOUT_MS;
		else process.env.PI_CREW_WORKER_ATOMIC_TIMEOUT_MS = saved;
	}
});

// ─── (e) temp-dir lifecycle (real worker) ───────────────────────────────────

test("(e) temp-cleanup: terminate removes the cached temp dir; next write recreates it", async () => {
	const saved = process.env.PI_CREW_WORKER_ATOMIC_WRITER;
	process.env.PI_CREW_WORKER_ATOMIC_WRITER = "1";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-waw-hard-"));
	try {
		const file = path.join(dir, "data.txt");
		await atomicWriteFileViaWorker(file, "first\n");
		const tempDir = __getWorkerTempDirForTests();
		assert.ok(tempDir, "worker spawn must create a temp dir");
		assert.ok(fs.existsSync(tempDir), "temp dir must exist while worker alive");
		assert.ok(fs.existsSync(path.join(tempDir, "worker.cjs")), "worker.cjs lives in the temp dir");

		terminateWorkerAtomicWriter();
		assert.ok(!fs.existsSync(tempDir), "terminate must rmSync the temp dir (leak fix)");

		await atomicWriteFileViaWorker(file, "second\n");
		const tempDir2 = __getWorkerTempDirForTests();
		assert.ok(tempDir2, "respawn recreates a temp dir");
		assert.ok(fs.existsSync(tempDir2), "recreated temp dir exists");
		assert.notEqual(tempDir2, tempDir, "recreated temp dir is a fresh mkdtemp");
		assert.equal(fs.readFileSync(file, "utf-8"), "second\n", "respawned worker still writes");
	} finally {
		terminateWorkerAtomicWriter();
		fs.rmSync(dir, { recursive: true, force: true });
		if (saved === undefined) delete process.env.PI_CREW_WORKER_ATOMIC_WRITER;
		else process.env.PI_CREW_WORKER_ATOMIC_WRITER = saved;
	}
});

// ─── P3: symlink guard runs MAIN-side BEFORE worker dispatch ────────────────

test("P3 write: with worker writer ON, atomicWriteFileAsync rejects a symlinked target BEFORE dispatch", {
	skip: process.platform === "win32" ? "symlinks need admin on Windows CI" : false,
}, async () => {
	const saved = process.env.PI_CREW_WORKER_ATOMIC_WRITER;
	process.env.PI_CREW_WORKER_ATOMIC_WRITER = "1";
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-waw-sym-"));
	try {
		const realTarget = path.join(sandbox, "real-target.txt");
		fs.writeFileSync(realTarget, "untouched\n", "utf-8");
		const evilFile = path.join(sandbox, "evil-link");
		fs.symlinkSync(realTarget, evilFile);
		// Main-side wording ("target is a symlink or inside untrusted directory")
		// differs from the worker's ("unsafe path") — matching the MAIN wording
		// proves the guard ran BEFORE dispatch.
		await assert.rejects(
			atomicWriteFileAsync(evilFile, "payload\n"),
			/Refusing to write: target is a symlink or inside untrusted directory/,
		);
		assert.equal(fs.readFileSync(realTarget, "utf-8"), "untouched\n", "no write may reach the real target");
	} finally {
		terminateWorkerAtomicWriter();
		fs.rmSync(sandbox, { recursive: true, force: true });
		if (saved === undefined) delete process.env.PI_CREW_WORKER_ATOMIC_WRITER;
		else process.env.PI_CREW_WORKER_ATOMIC_WRITER = saved;
	}
});

test("P3 write: with worker writer ON, symlinked DIR into a foreign-uid tree is rejected main-side", {
	skip:
		process.platform !== "linux" || (typeof process.getuid === "function" && process.getuid() === 0)
			? "needs linux + non-root uid (root owns everything it stats)"
			: false,
}, async () => {
	const saved = process.env.PI_CREW_WORKER_ATOMIC_WRITER;
	process.env.PI_CREW_WORKER_ATOMIC_WRITER = "1";
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-waw-symdir-"));
	try {
		const evilDir = path.join(sandbox, "evil-dir");
		fs.symlinkSync("/root", evilDir); // root-owned dir → uid-mismatch rejection
		const target = path.join(evilDir, "stolen.txt");
		await assert.rejects(
			atomicWriteFileAsync(target, "payload\n"),
			/Refusing to write: target is a symlink or inside untrusted directory/,
		);
		assert.ok(!fs.existsSync("/root/stolen.txt"), "must not write through the symlinked dir");
	} finally {
		terminateWorkerAtomicWriter();
		fs.rmSync(sandbox, { recursive: true, force: true });
		if (saved === undefined) delete process.env.PI_CREW_WORKER_ATOMIC_WRITER;
		else process.env.PI_CREW_WORKER_ATOMIC_WRITER = saved;
	}
});

test("P3 append: appendFileViaWorker rejects a symlinked target main-side BEFORE dispatch", {
	skip: process.platform === "win32" ? "symlinks need admin on Windows CI" : false,
}, async () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-waw-appsym-"));
	try {
		const realTarget = path.join(sandbox, "events-real.jsonl");
		const evilFile = path.join(sandbox, "events.jsonl");
		fs.symlinkSync(realTarget, evilFile);
		// The worker's own guard only walks ancestor DIRS, so without the
		// main-side guard the worker would happily append through the symlink.
		await assert.rejects(appendFileViaWorker(evilFile, '{"e":1}\n'), /Refusing to append: target is a symlink/);
		assert.ok(!fs.existsSync(realTarget), "no append may reach the real target through the worker");
	} finally {
		terminateWorkerAtomicWriter();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

// ─── P3: mode passthrough ───────────────────────────────────────────────────

test("P3 mode: atomicWriteFileViaWorker applies the requested mode (0o644)", async () => {
	const saved = process.env.PI_CREW_WORKER_ATOMIC_WRITER;
	process.env.PI_CREW_WORKER_ATOMIC_WRITER = "1";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-waw-mode-"));
	try {
		const file = path.join(dir, "mode-644.txt");
		await atomicWriteFileViaWorker(file, "mode test\n", 0o644);
		// openSync applies mode & ~umask at creation — compare against the same
		// expression rather than a hardcoded 0o644.
		assert.equal(fs.statSync(file).mode & 0o777, 0o644 & ~process.umask());

		const file2 = path.join(dir, "mode-default.txt");
		await atomicWriteFileViaWorker(file2, "default mode\n");
		assert.equal(fs.statSync(file2).mode & 0o777, 0o600 & ~process.umask(), "absent mode keeps 0o600 default");
	} finally {
		terminateWorkerAtomicWriter();
		fs.rmSync(dir, { recursive: true, force: true });
		if (saved === undefined) delete process.env.PI_CREW_WORKER_ATOMIC_WRITER;
		else process.env.PI_CREW_WORKER_ATOMIC_WRITER = saved;
	}
});

test("P3 mode: atomicWriteFileAsync forwards { mode } through the worker path", async () => {
	const saved = process.env.PI_CREW_WORKER_ATOMIC_WRITER;
	process.env.PI_CREW_WORKER_ATOMIC_WRITER = "1";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-waw-mode2-"));
	try {
		const file = path.join(dir, "via-async.txt");
		await atomicWriteFileAsync(file, "via async\n", { mode: 0o644 });
		assert.equal(fs.statSync(file).mode & 0o777, 0o644 & ~process.umask());
	} finally {
		terminateWorkerAtomicWriter();
		fs.rmSync(dir, { recursive: true, force: true });
		if (saved === undefined) delete process.env.PI_CREW_WORKER_ATOMIC_WRITER;
		else process.env.PI_CREW_WORKER_ATOMIC_WRITER = saved;
	}
});

// ─── (a) logInternalError removal (static source assert) ────────────────────

test("(a) worker source no longer references logInternalError; console.error replacements carry the message codes", () => {
	const modulePath = new URL("../../../../src/state/event-log/worker-atomic-writer.ts", import.meta.url);
	const source = fs.readFileSync(modulePath, "utf-8");
	// Extract just the WORKER_SOURCE template literal (the code that actually
	// runs inside the worker thread) — comments outside it may legitimately
	// mention the old logger.
	const start = source.indexOf("const WORKER_SOURCE = `");
	assert.ok(start >= 0, "WORKER_SOURCE literal not found");
	const end = source.indexOf("\n`;", start);
	assert.ok(end > start, "WORKER_SOURCE literal terminator not found");
	const workerSource = source.slice(start, end);
	assert.ok(!workerSource.includes("logInternalError"), "worker source must not reference the repo logger (ReferenceError in worker)");
	// Both catch branches must keep their message codes via console.error.
	assert.ok(workerSource.includes('console.error("[worker-atomic-writer] worker-atomic-writer.cleanup-temp"'));
	assert.ok(workerSource.includes('console.error("[worker-atomic-writer] worker-atomic-writer.compare-existing"'));
	// (b)/(c) fsync parity markers inside the worker source.
	assert.ok(workerSource.includes("fs.fsyncSync(fd);"), "worker must fsync file data");
	assert.ok(workerSource.includes("fsyncParentDirBestEffort"), "worker must fsync the parent dir after rename");
	assert.ok(/function syncAppend[\s\S]*fs\.fsyncSync\(fd\);/.test(workerSource), "syncAppend must fsync after append");
});

// ─── F3 (review fix): worker-side O_NOFOLLOW on the append open ──────────────

test('F3 static: syncAppend opens with O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW (no bare "a" mode)', () => {
	const modulePath = new URL("../../../../src/state/event-log/worker-atomic-writer.ts", import.meta.url);
	const source = fs.readFileSync(modulePath, "utf-8");
	const start = source.indexOf("const WORKER_SOURCE = `");
	assert.ok(start >= 0, "WORKER_SOURCE literal not found");
	const end = source.indexOf("\n`;", start);
	assert.ok(end > start, "WORKER_SOURCE literal terminator not found");
	const workerSource = source.slice(start, end);
	const syncAppendIdx = workerSource.indexOf("function syncAppend");
	assert.ok(syncAppendIdx >= 0, "syncAppend not found in worker source");
	const syncAppendBody = workerSource.slice(
		syncAppendIdx,
		workerSource.indexOf("function ", syncAppendIdx + 1) === -1 ? undefined : workerSource.indexOf("function ", syncAppendIdx + 1),
	);
	assert.ok(syncAppendBody.includes("O_WRONLY"), "syncAppend must compose numeric flags");
	assert.ok(syncAppendBody.includes("O_APPEND"), "syncAppend must append explicitly");
	assert.ok(syncAppendBody.includes("O_CREAT"), "syncAppend must keep create-on-missing semantics");
	assert.ok(syncAppendBody.includes("O_NOFOLLOW"), "syncAppend must refuse final-path symlinks (O_NOFOLLOW, security F3)");
	assert.ok(syncAppendBody.includes("lstatSync"), "platforms without O_NOFOLLOW fall back to a pre-open lstat refusal");
	assert.ok(!syncAppendBody.includes('fs.openSync(filePath, "a")'), 'the bare "a" open (symlink-permeable) must be gone');
});

test("F3 worker-side: appending through a symlinked target is refused INSIDE the worker (ELOOP) and the target stays untouched", {
	skip:
		process.platform === "win32"
			? "symlinks need admin + no O_NOFOLLOW fallback on Windows CI; lstat branch covered by the static test"
			: false,
}, async () => {
	// The main-side guard (P3) rejects symlinked targets BEFORE dispatch, so
	// this exercises the worker's OWN open directly: extract WORKER_SOURCE at
	// runtime, spawn a private Worker (same temp-.cjs pattern getWorker uses),
	// and dispatch an append for a symlinked path.
	const modulePath = new URL("../../../../src/state/event-log/worker-atomic-writer.ts", import.meta.url);
	const source = fs.readFileSync(modulePath, "utf-8");
	const start = source.indexOf("const WORKER_SOURCE = `");
	const end = source.indexOf("\n`;", start);
	assert.ok(start >= 0 && end > start, "WORKER_SOURCE literal not found");
	const workerSource = source.slice(start + "const WORKER_SOURCE = `".length, end);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-waw-nofollow-"));
	const workerFile = path.join(dir, "worker.cjs");
	fs.writeFileSync(workerFile, workerSource, "utf-8");
	const realTarget = path.join(dir, "real.jsonl");
	fs.writeFileSync(realTarget, '{"before":1}\n', "utf-8");
	const evilLink = path.join(dir, "evil.jsonl");
	fs.symlinkSync(realTarget, evilLink);

	const w = new Worker(workerFile);
	try {
		const reply = await new Promise<{ kind: string; id: number; message?: string }>((resolve, reject) => {
			w.once("message", (msg: { kind: string; id: number; message?: string }) => resolve(msg));
			w.once("error", reject);
			w.postMessage({ kind: "append", id: 777, filePath: evilLink, content: '{"evil":1}\n' });
		});
		assert.equal(reply.kind, "error", "the worker must reject the symlinked append");
		assert.match(reply.message ?? "", /ELOOP|symlink/i, `unexpected failure shape: ${reply.message ?? ""}`);
		assert.equal(fs.readFileSync(realTarget, "utf-8"), '{"before":1}\n', "the symlink target must be untouched");

		// Control: a NORMAL file still appends fine through the same worker
		// (the numeric-flag composition must not break the common path).
		const okReply = await new Promise<{ kind: string; id: number; message?: string }>((resolve, reject) => {
			w.once("message", (msg: { kind: string; id: number; message?: string }) => resolve(msg));
			w.once("error", reject);
			const normalFile = path.join(dir, "normal.jsonl");
			w.postMessage({ kind: "append", id: 778, filePath: normalFile, content: '{"ok":1}\n' });
		});
		assert.equal(okReply.kind, "done", `normal append must keep working: ${okReply.message ?? ""}`);
		assert.equal(fs.readFileSync(path.join(dir, "normal.jsonl"), "utf-8"), '{"ok":1}\n');
	} finally {
		await w.terminate();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
