/**
 * fixture-process.test.ts — fix-wave 12a pins for the shared fixture spawn/reap
 * helper.
 *
 * (h1) a non-detached fixture is refused at the call site (a group kill rooted at
 *      it would signal the runner's own group);
 * (h2) a detached tree of SIGTERM-ignoring kids is reaped in < 2000 ms and every
 *      pid is ESRCH afterwards — the shape that leaked two >6 h orphans;
 * (h3) `reapFixture` is idempotent per handle — the second call signals nothing and
 *      reports `already-reaped` (never throws; runs in `finally` bodies);
 * (h4) a snapshot that no longer matches the live process is refused AND is not
 *      degraded into a pid kill (a reused pid must never be signalled);
 * (h5) `registerFixtureTrap` installs its hooks exactly once;
 * (h6) `already-reaped` is decided by the HANDLE, not by process liveness: a fixture
 *      reaped once and then provably dead still reports `already-reaped` (macOS keeps
 *      `kill(pid, 0)` succeeding for unreaped zombies, so liveness cannot decide it).
 *
 * Real-process cases are Linux-only (`/proc` is what makes the identity snapshot
 * reusable) and are gated per test, with the platform constant at the top.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { __fixtureTrapStateForTest, reapFixture, registerFixtureTrap, spawnFixture } from "../../helpers/fixture-process.ts";

const isLinux = process.platform === "linux";
const FIXTURE = path.join(import.meta.dirname, "..", "..", "fixtures", "proc-tree-leader.mjs");
const LONG_LIVED = ["-e", "setInterval(() => {}, 1000)"];

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForDeath(pid: number, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !pidAlive(pid);
}

function killQuietly(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		/* already gone */
	}
}

/** Read the fixture's single JSON report line (`{leader, kids}`) from its stdout. */
function readReportedKids(handle: ReturnType<typeof spawnFixture>, timeoutMs = 15_000): Promise<number[]> {
	return new Promise((resolve, reject) => {
		if (!handle.child.stdout) {
			reject(new Error("fixture stdout is not piped"));
			return;
		}
		let buffer = "";
		const timer = setTimeout(() => reject(new Error("fixture did not report its tree in time")), timeoutMs);
		handle.child.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			clearTimeout(timer);
			try {
				const parsed = JSON.parse(buffer.slice(0, newline)) as { kids: number[] };
				resolve(parsed.kids);
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
		handle.child.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

test("(h1) spawnFixture refuses `detached: false`", () => {
	assert.throws(
		() => spawnFixture([process.execPath, ...LONG_LIVED], { detached: false }),
		/detached: false/,
		"a non-detached fixture would share the runner's group — it must be refused at the call site",
	);
});

test("(h2) reaps a detached tree of SIGTERM-ignoring kids in < 2000 ms", { skip: !isLinux }, async () => {
	const handle = spawnFixture([process.execPath, FIXTURE, "ignore-term"]);
	let kids: number[] = [];
	try {
		kids = await readReportedKids(handle);
		assert.equal(kids.length, 2, "fixture must report its two kids");
		const startedAt = Date.now();
		const result = await reapFixture(handle, { gracefulMs: 200, capMs: 2_000 });
		const elapsed = Date.now() - startedAt;
		assert.equal(result.ok, true, `reap must succeed, reason=${result.reason ?? "-"}`);
		assert.ok(elapsed < 2_000, `reap took ${elapsed}ms, expected < 2000ms`);
		for (const pid of [handle.pid, ...kids]) {
			assert.equal(await waitForDeath(pid), true, `pid ${pid} survived the reap (orphan leak)`);
		}
	} finally {
		for (const pid of [handle.pid, ...kids]) killQuietly(pid, "SIGKILL");
	}
});

test("(h3) reapFixture is idempotent — a second reap signals nothing and says so", async () => {
	const handle = spawnFixture([process.execPath, ...LONG_LIVED]);
	try {
		const first = await reapFixture(handle, { gracefulMs: 100, capMs: 1_000 });
		assert.equal(first.ok, true, `first reap must succeed, reason=${first.reason ?? "-"}`);
		const second = await reapFixture(handle, { gracefulMs: 100, capMs: 1_000 });
		assert.equal(second.ok, false, "a second reap has nothing left to kill");
		assert.equal(second.reason, "already-reaped", "the second reap must report handle-tracked idempotency, not an OS guess");
		// Third call: still handle-tracked, still no throw (it runs in `finally`).
		const third = await reapFixture(handle);
		assert.deepEqual(third, { ok: false, reason: "already-reaped" });
	} finally {
		killQuietly(handle.pid, "SIGKILL");
	}
});

test("(h4) identity mismatch ⇒ refusal, and the pid is NOT signalled", { skip: !isLinux }, async () => {
	const handle = spawnFixture([process.execPath, ...LONG_LIVED]);
	const identity = handle.identity;
	assert.ok(identity, "linux /proc identity must be readable right after spawn");
	try {
		// Same pid, same group — only the incarnation differs (starttime), which is
		// exactly what a reused pid looks like to the ladder.
		const stranger = { ...handle, identity: { ...identity, starttime: "0" } };
		const result = await reapFixture(stranger, { gracefulMs: 100, capMs: 500 });
		assert.equal(result.ok, false, "a mismatched snapshot must never report success");
		assert.match(result.reason ?? "", /starttime-mismatch/);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(pidAlive(handle.pid), true, "the refusal must not degrade into a pid kill of a reused pid");
	} finally {
		await reapFixture(handle, { gracefulMs: 100, capMs: 1_000 });
		killQuietly(handle.pid, "SIGKILL");
	}
});

test("(h5) registerFixtureTrap installs its hooks exactly once", async () => {
	assert.equal(__fixtureTrapStateForTest().hookInstalled, false, "this file must be the first trap caller");
	const exitListenersBefore = process.listenerCount("exit");
	const handle = spawnFixture([process.execPath, ...LONG_LIVED]);
	const before = __fixtureTrapStateForTest();
	try {
		registerFixtureTrap([handle]);
		const afterFirst = __fixtureTrapStateForTest();
		registerFixtureTrap([handle]);
		const afterSecond = __fixtureTrapStateForTest();
		assert.equal(afterFirst.hookInstalled, true);
		assert.equal(afterFirst.handleCount, before.handleCount + 1, "the handle is tracked once");
		assert.deepEqual(afterSecond, afterFirst, "a second registration must not add a hook, a listener or a handle");
		assert.equal(process.listenerCount("exit") - exitListenersBefore, 1, "exactly one exit listener");
	} finally {
		await reapFixture(handle, { gracefulMs: 100, capMs: 1_000 });
		killQuietly(handle.pid, "SIGKILL");
	}
});

test("(h6) `already-reaped` is a property of the handle, not of process liveness", async () => {
	// Simulates the macOS zombie shape without needing macOS: the handle is reaped
	// while the child may still be un-`waitpid`ed (kill(pid, 0) would still say
	// "alive"), and it is reaped again once the process is provably gone. Both
	// calls must report the same handle-tracked verdict — a liveness probe would
	// report different things.
	const handle = spawnFixture([process.execPath, "-e", "process.exit(0)"]);
	try {
		const first = await reapFixture(handle, { gracefulMs: 100, capMs: 500 });
		assert.notEqual(first.reason, "already-reaped", "the first attempt must actually run the ladder");
		// Let the child exit AND be reaped by libuv: the pid is now definitely dead.
		await new Promise<void>((resolve) => {
			if (handle.child.exitCode !== null || handle.child.signalCode !== null) return resolve();
			handle.child.once("exit", () => resolve());
		});
		const second = await reapFixture(handle, { gracefulMs: 100, capMs: 500 });
		assert.deepEqual(second, { ok: false, reason: "already-reaped" }, "a dead fixture must still be `already-reaped`, not re-laddered");
		const third = await reapFixture(handle);
		assert.deepEqual(third, { ok: false, reason: "already-reaped" });
	} finally {
		killQuietly(handle.pid, "SIGKILL");
	}
});
