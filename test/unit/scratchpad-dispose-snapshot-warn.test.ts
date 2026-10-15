/**
 * E2 (DR-02 Wave 2, Cluster F) — ScratchpadEngine.dispose()'s final snapshot
 * failure was `.catch(() => null)`: the guest was SIGKILLed anyway and the
 * lost snapshot was COMPLETELY invisible. The fix logs
 * logInternalError("scratchpad.final-snapshot-failed", ..., "warn") before
 * discarding, while keeping the null return (dispose must never throw — it
 * runs on shutdown paths).
 *
 * Behavioral test via EngineManager.prototype.dispose on a stub `this` (same
 * mock-engine shape approach as scratchpad-lifecycle.test.ts): no real guest
 * process is spawned; dispose only touches engineState / snapshotState / kill.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { SnapshotResult } from "../../src/runtime/scratchpad/engine.ts";
import { EngineManager } from "../../src/runtime/scratchpad/engine.ts";

const SCOPE = "[pi-crew:scratchpad.final-snapshot-failed]";

interface StderrCapture {
	captured: string[];
	restore(): void;
}

function captureStderr(): StderrCapture {
	const original = process.stderr.write.bind(process.stderr);
	const captured: string[] = [];
	process.stderr.write = ((chunk: string | Uint8Array) => {
		captured.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	return {
		captured,
		restore: () => {
			process.stderr.write = original;
		},
	};
}

interface DisposeStub {
	engineState: string;
	snapshotStateCalls: number;
	killCalls: number;
}

function makeDisposeStub(options: { snapshot: (path: string) => Promise<SnapshotResult | null> }): EngineManager {
	const stub: DisposeStub = { engineState: "running", snapshotStateCalls: 0, killCalls: 0 };
	const engine = {
		get engineState() {
			return stub.engineState;
		},
		snapshotState: (path: string) => {
			stub.snapshotStateCalls++;
			return options.snapshot(path);
		},
		kill: async () => {
			stub.killCalls++;
		},
	};
	// Expose the stub record on the side for assertions without widening the cast.
	(engine as unknown as { __stub: DisposeStub }).__stub = stub;
	return engine as unknown as EngineManager;
}

function stubOf(engine: EngineManager): DisposeStub {
	return (engine as unknown as { __stub: DisposeStub }).__stub;
}

test("E2: dispose() warns on final-snapshot failure, still SIGKILLs, and does not throw", async () => {
	const stderr = captureStderr();
	const engine = makeDisposeStub({
		snapshot: () => Promise.reject(new Error("snapshot pipe broke")),
	});
	try {
		const snapshotPath = "/tmp/does-not-matter.task-1.snapshot";
		// Must resolve (dispose never throws) even when the snapshot rejects.
		await EngineManager.prototype.dispose.call(engine, snapshotPath);
		const out = stderr.captured.join("");
		assert.ok(out.includes(SCOPE), `expected a warn with scope ${SCOPE} (got: ${out.trim() || "<empty>"})`);
		assert.ok(out.includes("snapshot pipe broke"), "expected the underlying snapshot error message");
		assert.ok(out.includes("snapshotPath=/tmp/does-not-matter.task-1.snapshot"), "expected the snapshotPath in the log context");
	} finally {
		stderr.restore();
	}
	const stub = stubOf(engine);
	assert.equal(stub.snapshotStateCalls, 1, "dispose must have attempted the snapshot once");
	assert.equal(stub.killCalls, 1, "dispose must still SIGKILL the guest after the snapshot failure");
});

test("E2 control: dispose() with a successful final snapshot logs nothing and kills", async () => {
	const stderr = captureStderr();
	const engine = makeDisposeStub({
		snapshot: async (path) => ({ path, saved: ["ns"], failed: [] }),
	});
	try {
		await EngineManager.prototype.dispose.call(engine, "/tmp/ok.snapshot");
		assert.ok(!stderr.captured.join("").includes("scratchpad.final-snapshot-failed"), "no warn on the healthy path");
	} finally {
		stderr.restore();
	}
	assert.equal(stubOf(engine).killCalls, 1, "healthy path still kills the guest");
});

test("E2 control: dispose() skips the snapshot entirely when the engine is not running", async () => {
	const stderr = captureStderr();
	const engine = makeDisposeStub({
		snapshot: async (path) => ({ path, saved: [], failed: [] }),
	});
	stubOf(engine).engineState = "idle";
	try {
		await EngineManager.prototype.dispose.call(engine, "/tmp/should-not-be-read.snapshot");
		assert.equal(stderr.captured.length, 0, "idle engine must not attempt or log a snapshot");
	} finally {
		stderr.restore();
	}
	const stub = stubOf(engine);
	assert.equal(stub.snapshotStateCalls, 0, "snapshotState must not be called for a non-running engine");
	assert.equal(stub.killCalls, 1, "kill still runs");
});
