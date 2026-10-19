/**
 * delegate-abort.test.ts — M3-5 / R43-N3 pins (fix-wave 6, round 43).
 *
 * Round 43 finding R43-N3: the grandchild spawner was fire-and-forget, so a
 * budget abort / run cancel / broker stop left grandchildren running to their
 * own deadline (up to 24h) — still spending and still holding nested slots.
 * The fix has three load-bearing parts, each pinned here:
 *   1. the registry scoping (per-run abort, release on settle, abortAll on stop);
 *   2. the broker wiring — a RUN-terminal call reaches the spawner's `signal`;
 *   3. the process-local singleton the runner side calls without a broker ref.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleCancel } from "../../../../src/extension/team-tool/cancel.ts";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { CrewBroker } from "../../../../src/runtime/broker/crew-broker.ts";
import {
	abortRunDelegates,
	DelegateAbortRegistry,
	getActiveDelegateAborter,
	setActiveDelegateAborter,
} from "../../../../src/runtime/broker/delegate/delegate-abort.ts";
import type { GrandchildSpawnInput, GrandchildSpawnResult } from "../../../../src/runtime/delegate-spawn.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import { encodeBrokerFrame, NdjsonDecoder } from "../../../../src/utils/ndjson.ts";

// ── 1. registry semantics ────────────────────────────────────────────────────

test("R43-N3: registry aborts only the requested run's grandchildren, then forgets them", () => {
	const registry = new DelegateAbortRegistry();
	const a = registry.register("gc-a", "run-1");
	const b = registry.register("gc-b", "run-2");
	assert.equal(registry.size, 2);
	const aborted = registry.abortRun("run-1", { reason: "run-terminal" });
	assert.equal(aborted, 1);
	assert.equal(a.signal.aborted, true, "run-1 grandchild cancelled");
	assert.equal(b.signal.aborted, false, "another run's grandchild untouched");
	assert.equal(registry.size, 1, "aborted entry dropped");
	// Scoping proof: aborting run-2 later still reaches its own grandchild.
	assert.equal(registry.abortRun("run-2", { reason: "budget-abort" }), 1);
	assert.equal(b.signal.aborted, true);
	assert.equal(registry.size, 0);
});

test("R43-N3: abortAll (broker stop) is idempotent and releases every run's grandchildren", () => {
	const registry = new DelegateAbortRegistry();
	const a = registry.register("gc-a", "run-1");
	const b = registry.register("gc-b", "run-2");
	assert.equal(registry.abortAll({ reason: "broker-stop" }), 2);
	assert.equal(a.signal.aborted, true);
	assert.equal(b.signal.aborted, true);
	assert.equal(registry.abortAll({ reason: "broker-stop" }), 0, "second call is a no-op");
});

test("R43-N3: release() drops a settled delegate WITHOUT aborting it", () => {
	const registry = new DelegateAbortRegistry();
	const a = registry.register("gc-a", "run-1");
	registry.release("gc-a");
	assert.equal(a.signal.aborted, false, "a settled delegate is never marked cancelled");
	assert.equal(registry.abortRun("run-1", { reason: "run-terminal" }), 0);
});

test("R43-N3: the process-local singleton is self-gating and never throws", () => {
	assert.equal(getActiveDelegateAborter(), undefined);
	try {
		// No broker wired: the runner's terminal path must degrade to 0.
		assert.equal(abortRunDelegates("run-x", "run-terminal"), 0);
		let seen: { runId: string; reason: string } | undefined;
		setActiveDelegateAborter((runId, reason) => {
			seen = { runId, reason };
			return 3;
		});
		assert.equal(abortRunDelegates("run-9", "budget-abort"), 3);
		assert.deepEqual(seen, { runId: "run-9", reason: "budget-abort" });
		// A throwing aborter (broker already stopped) must not break the caller.
		setActiveDelegateAborter(() => {
			throw new Error("broker gone");
		});
		assert.equal(abortRunDelegates("run-9", "run-terminal"), 0);
	} finally {
		setActiveDelegateAborter(undefined);
	}
});

// ── 2. broker wiring: run-terminal abort reaches the spawner signal ──────────

function tempSocketPath(suffix: string): string {
	const tok = randomBytes(3).toString("hex");
	if (process.platform === "win32") return `\\\\.\\pipe\\pi-crew-abort-${tok}-${suffix}`;
	return path.join(os.tmpdir(), `abt-${tok}-${suffix}.sock`);
}

interface RawClient {
	socket: net.Socket;
	decoder: NdjsonDecoder;
	waitForFrame: (predicate: (frame: unknown) => boolean, timeoutMs?: number) => Promise<unknown>;
	close: () => void;
}

function rawConnect(socketPath: string): Promise<RawClient> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection(socketPath);
		const pending: Array<{ resolve: (v: unknown) => void; predicate: (f: unknown) => boolean }> = [];
		const client: RawClient = {
			socket: sock,
			decoder: new NdjsonDecoder(),
			waitForFrame: (predicate, timeoutMs = 3000) =>
				new Promise((res, rej) => {
					pending.push({ resolve: res, predicate });
					setTimeout(() => rej(new Error("waitForFrame: timeout")), timeoutMs).unref();
				}),
			close: () => {
				try {
					sock.destroy();
				} catch {
					/* ignore */
				}
			},
		};
		sock.on("data", (chunk: Buffer) => {
			let frames: unknown[];
			try {
				frames = client.decoder.push(chunk);
			} catch {
				return;
			}
			for (const f of frames) {
				const idx = pending.findIndex((p) => p.predicate(f));
				if (idx !== -1) pending.splice(idx, 1)[0].resolve(f);
			}
		});
		sock.on("error", () => {
			/* noop */
		});
		sock.on("close", () => {
			for (const p of pending) p.resolve(undefined);
		});
		sock.once("connect", () => resolve(client));
		sock.once("error", (err) => reject(err));
	});
}

test("R43-N3: broker.abortDelegatesForRun reaches the in-flight spawner signal and records delegate.cancelled", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-abort-"));
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	let broker: CrewBroker | undefined;
	try {
		const run = await handleTeamTool(
			{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "abort-wire" },
			{ cwd },
		);
		const runId = run.details.runId!;
		const loaded = loadRunManifestById(cwd, runId)!;
		const task = loaded.tasks[0];
		const now = new Date().toISOString();
		saveRunManifest({ ...loaded.manifest, status: "running", updatedAt: now }, { allowTerminalExit: true });
		// Flip the parent task running via the manifest write path used by the
		// broker's admission read.
		const { saveRunTasks } = await import("../../../../src/state/stores/state-store.ts");
		saveRunTasks(
			{ ...loaded.manifest, status: "running" },
			loaded.tasks.map((t) => (t.id === task.id ? { ...t, status: "running" as const, depth: 1, startedAt: now } : t)),
		);

		let spawnSignal: AbortSignal | undefined;
		let resolveSpawn: (() => void) | undefined;
		const spawner = (input: GrandchildSpawnInput): Promise<GrandchildSpawnResult> => {
			spawnSignal = input.signal;
			return new Promise<GrandchildSpawnResult>((resolve) => {
				resolveSpawn = () => resolve({ ok: false, cancelled: true, resultText: "[delegate cancelled: run terminated]" });
			});
		};

		const socketPath = tempSocketPath("wire");
		broker = new CrewBroker({
			sessionId: "session-abort-test",
			socketPath,
			enabled: true,
			cwd,
			nestingEnabled: true,
			nestingTrustedEscalation: true,
			grandchildSpawner: spawner,
		});
		await broker.start();
		const token = broker.issueRunToken(runId, task.id);
		const client = await rawConnect(socketPath);
		try {
			client.socket.write(
				encodeBrokerFrame({ id: "hello", method: "hello", params: { protocol: 1, runId, taskId: task.id, token } }),
			);
			await client.waitForFrame((f) => (f as { result?: { ok?: boolean } })?.result?.ok === true);
			// No budgetTokens: the broker opts into the audited unmetered allow
			// (this fixture run has no budgetTotal to seed a grant from).
			client.socket.write(encodeBrokerFrame({ id: "dlg", method: "delegate.request", params: { prompt: "long work" } }));
			const ack = (await client.waitForFrame((f) => (f as { id?: string })?.id === "dlg")) as {
				result?: { ok?: boolean };
				error?: { code: string; message: string };
			};
			assert.equal(ack.result?.ok, true, `delegate admitted: ${JSON.stringify(ack)}`);
			// The spawner is now in flight with our registry-issued signal.
			const deadline = Date.now() + 2000;
			while (spawnSignal === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
			assert.ok(spawnSignal, "spawner received a signal");
			assert.equal(spawnSignal!.aborted, false);
			assert.equal(broker.inFlightDelegateCount, 1, "grandchild registered as in-flight");

			// RUN TERMINAL — the exact call budget-enforcement.ts makes.
			assert.equal(broker.abortDelegatesForRun(runId, "budget abort threshold exceeded"), 1);
			assert.equal(spawnSignal!.aborted, true, "in-flight grandchild cancelled (pre-fix: ran to its 24h deadline)");
			resolveSpawn?.();

			// The settle path must audit the cancellation distinctly.
			const eventsPath = loaded.manifest.eventsPath;
			const deadline2 = Date.now() + 3000;
			for (;;) {
				const events = fs
					.readFileSync(eventsPath, "utf8")
					.split("\n")
					.filter((l) => l.trim().length > 0)
					.map((l) => JSON.parse(l) as { type: string });
				if (events.some((e) => e.type === "delegate.cancelled") || Date.now() > deadline2) break;
				await new Promise((r) => setTimeout(r, 25));
			}
			const events = fs
				.readFileSync(eventsPath, "utf8")
				.split("\n")
				.filter((l) => l.trim().length > 0)
				.map((l) => JSON.parse(l) as { type: string });
			assert.ok(
				events.some((e) => e.type === "delegate.cancelled"),
				"delegate.cancelled recorded (not 'completed')",
			);
			assert.equal(broker.inFlightDelegateCount, 0, "abort + settle released the registry slot");
		} finally {
			client.close();
		}
	} finally {
		await broker?.stop();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ── 3. M4-R1(c) (fix-wave 6 residual, M3-A): team-tool cancel / forget wiring ─
// The team-tool terminal paths (handleCancel / handleForget) terminate live
// agents + SIGTERM the background runner, but they never aborted the run's
// in-flight DELEGATE grandchildren — those live in the broker abort registry
// and outlived the run by up to their own 24h deadline. Both call sites now
// abort through the same process-local singleton budget-enforcement uses.

/** Minimal owned run on disk (mirrors cancel-kill-gate.test.ts's fixture). */
function createOwnedRun(ownerSessionId: string): {
	cwd: string;
	runId: string;
	manifest: ReturnType<typeof createRunManifest>["manifest"];
} {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-delegate-cancel-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = {
		name: "delegate-cancel",
		description: "",
		roles: [{ name: "worker", agent: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "wf",
		description: "",
		steps: [{ id: "one", role: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const created = createRunManifest({ cwd, team, workflow, goal: "delegate-abort wiring", ownerSessionId });
	return { cwd, runId: created.manifest.runId, manifest: created.manifest };
}

/** Patch the on-disk manifest (fresh in-lock reads must see this state). */
function patchManifestOnDisk(
	manifest: ReturnType<typeof createRunManifest>["manifest"],
	mutate: (m: Record<string, unknown>) => void,
): void {
	const manifestPath = path.join(manifest.stateRoot, "manifest.json");
	const onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
	mutate(onDisk);
	fs.writeFileSync(manifestPath, `${JSON.stringify(onDisk, null, 2)}\n`, "utf-8");
}

test("M4-R1(c): handleCancel aborts the run's in-flight delegates (running runs only)", async () => {
	const seen: Array<{ runId: string; reason: string }> = [];
	const run = createOwnedRun("session-cancel");
	try {
		saveRunTasks(run.manifest, [
			{
				id: "task-1",
				runId: run.runId,
				role: "worker",
				agent: "worker",
				title: "task",
				status: "running",
				dependsOn: [],
				cwd: run.cwd,
			},
		]);
		setActiveDelegateAborter((runId, reason) => {
			seen.push({ runId, reason });
			return 2;
		});

		// Already-terminal run: the N-5 gate keeps the teardown off → no abort.
		patchManifestOnDisk(run.manifest, (m) => {
			m.status = "completed";
		});
		const terminal = await handleCancel({ action: "cancel", runId: run.runId }, { cwd: run.cwd, sessionId: "session-cancel" });
		assert.equal(terminal.isError, false, "terminal short-circuit is not an error");
		assert.deepEqual(seen, [], "a run that is already terminal must not abort delegates");

		// Still-running run → the delegate abort rides the cancel.
		patchManifestOnDisk(run.manifest, (m) => {
			m.status = "running";
		});
		const cancelled = await handleCancel({ action: "cancel", runId: run.runId }, { cwd: run.cwd, sessionId: "session-cancel" });
		assert.equal(cancelled.isError, false);
		assert.deepEqual(seen, [{ runId: run.runId, reason: "run-cancelled" }], "cancel aborts the run's delegates (M4-R1c)");
	} finally {
		setActiveDelegateAborter(undefined);
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});

test("M4-R1(c): handleForget aborts the run's in-flight delegates before deleting state", async () => {
	const seen: Array<{ runId: string; reason: string }> = [];
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-delegate-forget-"));
	try {
		const run = await handleTeamTool(
			{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "forget-aborts-delegates" },
			{ cwd },
		);
		const runId = run.details.runId!;
		setActiveDelegateAborter((id, reason) => {
			seen.push({ runId: id, reason });
			return 1;
		});

		const forgotten = await handleTeamTool({ action: "forget", runId, confirm: true }, { cwd });
		assert.equal(forgotten.isError, false);
		assert.deepEqual(seen, [{ runId, reason: "run-forgotten" }], "forget aborts the run's delegates (M4-R1c)");
		assert.equal(loadRunManifestById(cwd, runId), undefined, "state is deleted after the abort call");
	} finally {
		setActiveDelegateAborter(undefined);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
