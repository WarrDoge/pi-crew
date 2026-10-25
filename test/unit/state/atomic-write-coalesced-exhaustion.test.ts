/**
 * R39-M1 regression (fix-wave 6, EP3): a coalesced write that exhausts
 * MAX_FLUSH_RETRIES on a persistent (transient-class) fault must DEGRADE, not
 * re-throw. Before the fix the flush re-threw from a `setTimeout` callback →
 * uncaughtException → host process exit (code 7) with the run left "running"
 * forever. This suite pins:
 *   - no throw on retry exhaustion,
 *   - the buffered entry is dropped (no infinite retry loop),
 *   - the degradation is recorded + reported to a subscriber.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { cleanupStateRoot } from "../../helpers/rm-retry.ts";

const require = createRequire(import.meta.url);
const fsDefault = require("node:fs") as typeof fs & { __patched?: boolean };

/** Patch openSync to fail EVERY time for the target temp path (persistent fault). */
function withPersistentWriteFailure(fn: () => void): void {
	const original = fsDefault.openSync;
	fsDefault.openSync = function patchedOpenSync(...args: Parameters<typeof fs.openSync>) {
		const p = String(args[0]);
		if (p.includes("pi-crew-exhaust-") && p.includes(".tmp")) {
			const err = new Error("E_SIMULATED_ENOSPC: no space left on device") as NodeJS.ErrnoException;
			err.code = "ENOSPC";
			throw err;
		}
		return original.apply(fs, args as Parameters<typeof fs.openSync>);
	};
	syncBuiltinESMExports();
	try {
		fn();
	} finally {
		fsDefault.openSync = original;
		syncBuiltinESMExports();
	}
}

test("R39-M1: retry exhaustion degrades — no throw, entry dropped, failure reported", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-exhaust-"));
	try {
		const target = path.join(dir, "state.json");
		const {
			atomicWriteJsonCoalesced,
			flushPendingAtomicWrites,
			listExhaustedFlushFailures,
			__test__clearExhaustedFlushFailures,
			pendingCoalescedWriteCount,
			onCoalescedFlushExhausted,
		} = await import("../../../src/state/atomic-write.ts");

		__test__clearExhaustedFlushFailures();
		const reported: string[] = [];
		const unsubscribe = onCoalescedFlushExhausted((failure) => reported.push(failure.filePath));

		// coalesceMs large so the backoff/coalesce TIMERS never fire during the
		// synchronous loop — the explicit flushes below drive the retry counter.
		atomicWriteJsonCoalesced(target, { hello: "world" }, 60_000, { compact: true });

		withPersistentWriteFailure(() => {
			// MAX_FLUSH_RETRIES = 5 → five failing flushes exhaust the counter.
			for (let i = 0; i < 5; i++) {
				assert.doesNotThrow(() => flushPendingAtomicWrites(target), `flush ${i + 1} must not throw`);
			}
			// One more flush is a harmless no-op (entry already dropped for good).
			assert.doesNotThrow(() => flushPendingAtomicWrites(target));
		});

		assert.equal(pendingCoalescedWriteCount(), 0, "exhausted entry is dropped, not retried forever");
		assert.equal(fs.existsSync(target), false, "nothing was ever written on the persistent fault");

		const failures = listExhaustedFlushFailures();
		assert.equal(failures.length, 1, "exactly one exhaustion recorded");
		assert.equal(failures[0]!.filePath, target);
		assert.match(failures[0]!.error, /ENOSPC/);
		assert.deepEqual(reported, [target], "subscriber notified of the degradation");
		unsubscribe();
	} finally {
		await cleanupStateRoot(dir);
	}
});
