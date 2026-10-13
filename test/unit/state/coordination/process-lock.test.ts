/**
 * U21 unit tests — process-lock.ts primitive (kernel-owned socket lock).
 *
 * The primitive is the vendored/adapted chord processLock (see NOTICE.md):
 * on Linux an abstract unix socket, on Windows a named pipe, elsewhere a
 * socket file with corpse-takeover. These tests are platform-agnostic — they
 * exercise the CONTRACT (one live owner per name, release frees the name,
 * distinct names never collide), not the platform address selection.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { acquireProcessLock, isProcessLockHeldError } from "../../../../src/state/coordination/process-lock.ts";

test("acquire → release → re-acquire the same name succeeds", async () => {
	const first = await acquireProcessLock("u21-t1");
	await first.release();
	// After release the kernel name is free again — same-process re-acquire.
	const second = await acquireProcessLock("u21-t1");
	await second.release();
});

test("second acquire of the SAME name in the SAME process rejects reason=locked", async () => {
	const holder = await acquireProcessLock("u21-t2");
	await assert.rejects(
		acquireProcessLock("u21-t2"),
		(error: unknown) => isProcessLockHeldError(error) && (error as { reason?: string }).reason === "locked",
		"the kernel must reject a second live listener on the same name",
	);
	await holder.release();
});

test("different names → two locks held concurrently (namespaces do not collide)", async () => {
	const a = await acquireProcessLock("u21-t3-alpha");
	const b = await acquireProcessLock("u21-t3-beta");
	await a.release();
	await b.release();
});

test("release is idempotent — a second release() resolves without error", async () => {
	const handle = await acquireProcessLock("u21-t4");
	await handle.release();
	await handle.release();
});
