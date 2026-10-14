/**
 * U21 integration tests — withRunLock dual guard (file lock + kernel process
 * socket supplement), process-lock.ts vendored from chord (see NOTICE.md).
 *
 * Covers the PHASE 3 acceptance set:
 *   1. dual guard ON (default): run.lock AND the kernel socket are held during
 *      the body; both free after;
 *   2. PI_CREW_RUN_LOCK_SOCKET=0 → pre-U21 file-lock-only behaviour
 *      bit-for-bit (socket NOT taken);
 *   3. same-context re-entrance bypasses BEFORE any socket acquisition (no
 *      self-deadlock on the kernel socket);
 *   4. the socket guard DEFERS a stale-stealer until the live holder releases
 *      (dual entry prevented) while the file-tier steal WARN still fires;
 *   5. real 2-process contention: a child's withRunLock fails while the parent
 *      holds the run, succeeds after release; the socket guard is observable
 *      from a foreign process;
 *   6. no env inheritance: children see no lock env keys and can acquire a
 *      DIFFERENT lock while the parent holds one (control-namespace canary).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertOnlyControlEnvKeys } from "../../../../src/runtime/child-pi/child-pi-spawn.ts";
import { runLockSocketName, withRunLock } from "../../../../src/state/coordination/locks.ts";
import { acquireProcessLock, isProcessLockHeldError } from "../../../../src/state/coordination/process-lock.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

const LOCKS_TS = fileURLToPath(new URL("../../../../src/state/coordination/locks.ts", import.meta.url));
const PROCESS_LOCK_TS = fileURLToPath(new URL("../../../../src/state/coordination/process-lock.ts", import.meta.url));

function mkTmp(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkManifest(stateRoot: string): TeamRunManifest {
	return {
		runId: "u21-socket",
		team: "test",
		workflow: "default",
		goal: "test",
		stateRoot,
		cwd: "/tmp",
		artifactsRoot: path.join(stateRoot, "artifacts"),
		status: "running",
		tasks: [],
		artifacts: [],
		eventsPath: path.join(stateRoot, "events.jsonl"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		manifestPath: path.join(stateRoot, "manifest.json"),
		createdAt: new Date().toISOString(),
		startedAt: Date.now(),
		turnCount: 0,
	} as unknown as TeamRunManifest;
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
		await sleep(10);
	}
}

/** Set env keys for the duration of an async fn, restoring the previous values. */
async function withEnvAsync(pairs: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
	const saved = new Map<string, string | undefined>();
	for (const key of Object.keys(pairs)) saved.set(key, process.env[key]);
	for (const [key, value] of Object.entries(pairs)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/**
 * Child fixture (plain .mjs — imports the real strip-types src modules):
 *   contend <stateRoot>       — withRunLock(manifest, …, { staleMs: 400 }):
 *                               CHILD:ACQUIRED/CHILD:DONE on success,
 *                               CHILD:LOCKED:<msg> + exit 3 on contention;
 *   socket <lockName>         — acquireProcessLock(lockName): CHILD:SOCKET_FREE
 *                               (exit 0) / CHILD:SOCKET_LOCKED:true (exit 4);
 *   env                       — prints crew-family LOCK-ish env keys as JSON;
 *   other <name>              — acquire+release a DIFFERENT process lock:
 *                               CHILD:OTHER_LOCK_OK (exit 0).
 */
function writeChildFixture(dir: string): string {
	const fixture = `import * as path from "node:path";
import { withRunLock } from ${JSON.stringify(LOCKS_TS)};
import { acquireProcessLock, isProcessLockHeldError } from ${JSON.stringify(PROCESS_LOCK_TS)};
const [phase, arg] = process.argv.slice(2);
const stateRoot = arg;
const manifest = {
	runId: "u21-child", team: "test", workflow: "default", goal: "u21",
	stateRoot, cwd: "/tmp",
	artifactsRoot: path.join(stateRoot, "artifacts"), status: "running",
	tasks: [], artifacts: [],
	eventsPath: path.join(stateRoot, "events.jsonl"),
	tasksPath: path.join(stateRoot, "tasks.json"),
	manifestPath: path.join(stateRoot, "manifest.json"),
	createdAt: new Date().toISOString(), startedAt: Date.now(), turnCount: 0,
};
if (phase === "contend") {
	try {
		await withRunLock(manifest, async () => {
			console.log("CHILD:ACQUIRED");
		}, { staleMs: 400 });
		console.log("CHILD:DONE");
	} catch (error) {
		console.log(\`CHILD:LOCKED:\${(error && error.message) || error}\`);
		process.exitCode = 3;
	}
} else if (phase === "socket") {
	const name = process.argv[4] ?? "";
	try {
		const handle = await acquireProcessLock(name);
		await handle.release();
		console.log("CHILD:SOCKET_FREE");
	} catch (error) {
		console.log(\`CHILD:SOCKET_LOCKED:\${isProcessLockHeldError(error)}\`);
		process.exitCode = isProcessLockHeldError(error) ? 4 : 5;
	}
} else if (phase === "env") {
	const keys = Object.keys(process.env).filter((k) => /^PI_(CREW|TEAMS)_/.test(k) && /LOCK/i.test(k));
	console.log(\`CHILD:ENV:\${JSON.stringify(keys)}\`);
} else if (phase === "other") {
	const name = process.argv[4] ?? "u21-other";
	const handle = await acquireProcessLock(name);
	await handle.release();
	console.log("CHILD:OTHER_LOCK_OK");
} else {
	console.log(\`CHILD:BAD_PHASE:\${phase}\`);
	process.exitCode = 6;
}
`;
	const fixturePath = path.join(dir, "u21-child-fixture.mjs");
	fs.writeFileSync(fixturePath, fixture, "utf-8");
	return fixturePath;
}

/** Minimal, PI_CREW-free child env (tests run inside a pi-crew worker with ambient vars). */
function childEnv(): NodeJS.ProcessEnv {
	return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
}

function runChild(fixture: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fixture, ...args], {
		encoding: "utf-8",
		timeout: 20_000,
		env: childEnv(),
	});
	return {
		status: result.status,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
	};
}

test("U21-1: dual guard default ON — file lock AND kernel socket held during the body, both free after", async () => {
	const dir = mkTmp("u21-dual-on-");
	try {
		const manifest = mkManifest(dir);
		const lockFile = path.join(dir, "run.lock");
		// Explicitly unset the flag: the test must hold even under an ambient value.
		await withEnvAsync({ PI_CREW_RUN_LOCK_SOCKET: undefined }, async () => {
			await withRunLock(manifest, async () => {
				assert.equal(fs.existsSync(lockFile), true, "run.lock exists while the body runs (file tier unchanged)");
				await assert.rejects(
					acquireProcessLock(runLockSocketName(lockFile)),
					(error: unknown) => isProcessLockHeldError(error) && (error as { reason?: string }).reason === "locked",
					"the kernel socket for this run must be held during the body",
				);
			});
			// After release the socket name is free again.
			const handle = await acquireProcessLock(runLockSocketName(lockFile));
			await handle.release();
			assert.equal(fs.existsSync(lockFile), false, "run.lock removed after the body");
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("U21-2: PI_CREW_RUN_LOCK_SOCKET=0 — pre-U21 behaviour bit-for-bit (file lock only)", async () => {
	const dir = mkTmp("u21-flag-off-");
	try {
		const manifest = mkManifest(dir);
		const lockFile = path.join(dir, "run.lock");
		await withEnvAsync({ PI_CREW_RUN_LOCK_SOCKET: "0" }, async () => {
			await withRunLock(manifest, async () => {
				assert.equal(fs.existsSync(lockFile), true, "run.lock still acquired/removed with the supplement OFF");
				// The socket is NOT taken — an outside acquire of the same name succeeds.
				const handle = await acquireProcessLock(runLockSocketName(lockFile));
				await handle.release();
			});
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("U21-3: same-context nested withRunLock re-enters BEFORE the socket tier — no self-deadlock", async () => {
	const dir = mkTmp("u21-nested-");
	try {
		const manifest = mkManifest(dir);
		const lockFile = path.join(dir, "run.lock");
		let innerResult = "";
		const result = await withRunLock(manifest, async () => {
			// Nested call in the SAME async context: lockCtx bypass returns before
			// any file/socket acquisition — the outer socket stays the only one.
			innerResult = await withRunLock(manifest, async () => {
				await assert.rejects(
					acquireProcessLock(runLockSocketName(lockFile)),
					isProcessLockHeldError,
					"the OUTER acquisition's socket must still be the holder (nested call must not acquire/release it)",
				);
				return "inner-ok";
			});
			return "outer-ok";
		});
		assert.equal(innerResult, "inner-ok");
		assert.equal(result, "outer-ok");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("U21-4: socket guard DEFERS a stale-stealer until the live holder releases (no dual entry); steal WARN still fires", async () => {
	const dir = mkTmp("u21-defer-steal-");
	try {
		const manifest = mkManifest(dir);
		// Same shape as run-lock-steal-live-holder-warn.test.ts (staleMs 150 →
		// steal lands ~t=175 against a 300ms deadline), but the holder is
		// released right after the WARN is observed, so the contender enters
		// INSIDE its deadline and the dual-entry window is provably closed.
		const staleMs = 150;
		const captured: string[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			captured.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
		};
		let holderExitAt = 0;
		let contenderEnteredAt = 0;
		try {
			const holderEntered = createDeferred<void>();
			const releaseHolder = createDeferred<void>();
			const first = withRunLock(
				manifest,
				async () => {
					holderEntered.resolve();
					await releaseHolder.promise;
					holderExitAt = Date.now();
				},
				{ staleMs },
			);
			await holderEntered.promise;

			const second = withRunLock(
				manifest,
				async () => {
					contenderEnteredAt = Date.now();
				},
				{ staleMs },
			);

			// The file-tier steal (WARN) must still fire while the holder is live.
			await waitFor(() => captured.some((line) => line.includes("[pi-crew:locks.steal-live-holder]")));
			// NOW let the holder go; the contender must enter only after it exits.
			releaseHolder.resolve();
			await Promise.all([first, second]);

			assert.ok(contenderEnteredAt > 0, "contender must have entered (within its staleMs*2 deadline)");
			assert.ok(
				contenderEnteredAt >= holderExitAt,
				`contender (${contenderEnteredAt}) must not enter before the live holder exits (${holderExitAt}) — U21 closes the dual-entry window`,
			);
		} finally {
			console.error = originalError;
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("U21-5: real 2-process contention — child fails while parent holds, succeeds after release; socket visible cross-process", async () => {
	const dir = mkTmp("u21-two-proc-");
	try {
		const manifest = mkManifest(dir);
		const lockFile = path.join(dir, "run.lock");
		const fixture = writeChildFixture(dir);
		const socketName = runLockSocketName(lockFile);

		const holderEntered = createDeferred<void>();
		const releaseHolder = createDeferred<void>();
		const parent = withRunLock(manifest, async () => {
			holderEntered.resolve();
			await releaseHolder.promise;
		});
		await holderEntered.promise;

		// (a) Child withRunLock on the SAME run dir → contention (`locked`).
		const whileHeld = runChild(fixture, ["contend", dir]);
		assert.match(whileHeld.stdout ?? "", /CHILD:LOCKED:/, "child must observe contention while the parent holds");
		assert.notEqual(whileHeld.status, 0);

		// (b) The kernel socket guard is observable from a FOREIGN process.
		const socketHeld = runChild(fixture, ["socket", dir, socketName]);
		assert.match(socketHeld.stdout ?? "", /CHILD:SOCKET_LOCKED:true/);
		assert.equal(socketHeld.status, 4);

		releaseHolder.resolve();
		await parent;

		// (c) After the parent released, the child's full dual-guard acquire works.
		const afterRelease = runChild(fixture, ["contend", dir]);
		assert.match(afterRelease.stdout ?? "", /CHILD:ACQUIRED/);
		assert.match(afterRelease.stdout ?? "", /CHILD:DONE/);
		assert.equal(afterRelease.status, 0);

		// (d) And the socket is free again for a foreign process.
		const socketFree = runChild(fixture, ["socket", dir, socketName]);
		assert.match(socketFree.stdout ?? "", /CHILD:SOCKET_FREE/);
		assert.equal(socketFree.status, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("U21-6: no env inheritance — child sees no lock env keys and acquires a DIFFERENT lock while the parent holds one", async () => {
	const dir = mkTmp("u21-no-inherit-");
	try {
		const manifest = mkManifest(dir);
		const fixture = writeChildFixture(dir);

		// The control-namespace canary still accepts the new toggle (it is a
		// PI_CREW_* control key, host-read only — never a lock-state carrier).
		assert.doesNotThrow(() => assertOnlyControlEnvKeys({ PI_CREW_RUN_LOCK_SOCKET: "1" }));

		const holderEntered = createDeferred<void>();
		const releaseHolder = createDeferred<void>();
		const parent = withRunLock(manifest, async () => {
			holderEntered.resolve();
			await releaseHolder.promise;
		});
		await holderEntered.promise;

		// (a) A child spawned with the standard minimal env observes NO lock key.
		const envProbe = runChild(fixture, ["env", dir]);
		assert.match(envProbe.stdout ?? "", /CHILD:ENV:/);
		const keys = JSON.parse((envProbe.stdout ?? "").match(/CHILD:ENV:(.*)/)?.[1] ?? "[]") as string[];
		assert.deepEqual(keys, [], `child env must contain no lock-inheritance keys, got: ${JSON.stringify(keys)}`);

		// (b) The parent's held socket does not block the child from acquiring a
		// DIFFERENT lock (sockets are name-scoped, not env/pid-scoped).
		const other = runChild(fixture, ["other", dir, "u21-unrelated-lock"]);
		assert.match(other.stdout ?? "", /CHILD:OTHER_LOCK_OK/);
		assert.equal(other.status, 0);

		releaseHolder.resolve();
		await parent;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("U21-F2: runLockSocketName namespaces by uid — 'uid:run:' prefix + resolved path; distinct paths → distinct names", () => {
	// The prefix must match THIS process's uid so two users on the same run
	// path derive different socket names (system-wide abstract namespace).
	const expectedUid = typeof process.getuid === "function" ? String(process.getuid()) : "noid";
	const alpha = runLockSocketName("/tmp/u21-f2-alpha/run.lock");
	const beta = runLockSocketName("/tmp/u21-f2-beta/run.lock");
	assert.ok(alpha.startsWith(`${expectedUid}:run:`), `socket name must be prefixed with the uid, got: ${alpha}`);
	assert.ok(beta.startsWith(`${expectedUid}:run:`), `socket name must be prefixed with the uid, got: ${beta}`);
	assert.notEqual(alpha, beta, "two different run paths must yield two different socket names");
	// The resolved absolute path stays the distinguishing payload after the uid prefix.
	assert.ok(alpha.includes(path.resolve("/tmp/u21-f2-alpha/run.lock")));
	assert.ok(!alpha.includes(path.resolve("/tmp/u21-f2-beta/run.lock")));
});

test('U21-F2: runtime without process.getuid falls back to the "noid" prefix', () => {
	const original = Object.getOwnPropertyDescriptor(process, "getuid");
	try {
		Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
		const name = runLockSocketName("/tmp/u21-f2-noid/run.lock");
		assert.ok(name.startsWith("noid:run:"), `expected the noid fallback prefix, got: ${name}`);
	} finally {
		if (original) Object.defineProperty(process, "getuid", original);
	}
});
