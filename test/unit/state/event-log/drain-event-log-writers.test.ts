/**
 * Wave-14 F1/F2: `drainEventLogWriters` + `cleanupStateRoot`.
 *
 * Root cause (wave-14 spec §1): every queued async append re-creates the run
 * dir (`fs.promises.mkdir` inside the event-log queue tail) before appending.
 * Teardown that rmSync's the state dir mid-flight loses the race — mkdir
 * re-creates the dir after the delete (orphan events.jsonl / ENOTEMPTY on the
 * next pass). The drain API lets teardown await the writers FIRST; these
 * tests pin the contract on every OS (real tmpdir, no /proc involved):
 *
 *   d1 — drain settles the write chain: bare rmSync right after drain wins.
 *   d2 — global drain + unknown path: no-op, resolves, never throws.
 *   d3 — rejected tail: drain still resolves (allSettled contract).
 *   d4 — cleanupStateRoot removes the dir immediately after a
 *        fire-and-forget append (true race repro, settleMs: 0).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { appendEventAsync, appendEventFireAndForget, drainEventLogWriters, readEvents } from "../../../../src/state/event-log/event-log.ts";
import { cleanupStateRoot } from "../../../helpers/rm-retry.ts";

test("d1: drain settles the write chain — bare rmSync right after drain never races", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-drain-d1-"));
	const eventsPath = path.join(dir, "state", "run-1", "events.jsonl");
	try {
		// Fire-and-forget: the queued tail mkdirs `dir/state/run-1` then appends.
		appendEventFireAndForget(eventsPath, { type: "task.started", runId: "run-1", taskId: "t1", message: "m" });
		await drainEventLogWriters(eventsPath);
		// The write landed BEFORE the delete…
		assert.equal(readEvents(eventsPath).length, 1, "drained write must be on disk");
		// …so a bare rmSync (no try/retry) cannot hit ENOTEMPTY…
		fs.rmSync(dir, { recursive: true, force: true });
		assert.equal(fs.existsSync(dir), false, "bare rmSync right after drain succeeds");
		// …and nothing resurrects the dir afterwards (the pre-drain bug: the
		// queue tail's mkdir re-created it after the delete).
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(fs.existsSync(dir), false, "no dir resurrection after drain + rmSync");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("d2: global drain with nothing in flight resolves — and unknown path is a no-op", async () => {
	// eventsPath undefined: drains every queue tail + flushes buffers. Even
	// with other suites' state in the same process, this must simply resolve.
	await assert.doesNotReject(drainEventLogWriters());
	// A path that was never written to: Map.get() misses → ?? Promise.resolve().
	const neverWritten = path.join(os.tmpdir(), "pi-crew-drain-d2-unused", "events.jsonl");
	await assert.doesNotReject(drainEventLogWriters(neverWritten));
});

test("d3: rejected tail — drain still resolves (allSettled contract)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-drain-d3-"));
	try {
		// Force the queued tail's mkdir to fail: a REGULAR FILE where a
		// directory component should be (ENOTDIR on every OS). No /proc
		// needed — a real filesystem error injected through a real path.
		const blocker = path.join(dir, "blocker");
		fs.writeFileSync(blocker, "not a dir");
		const eventsPath = path.join(blocker, "run-1", "events.jsonl");
		// Hold the append promise so we can PROVE the tail genuinely rejected.
		const append = appendEventAsync(eventsPath, { type: "task.started", runId: "run-1", taskId: "t1", message: "m" });
		assert.equal(fs.existsSync(eventsPath), false, "sanity: nothing written");
		// Teardown-shaped call must not throw even though the write failed…
		await assert.doesNotReject(drainEventLogWriters(eventsPath), "drain must absorb a rejected write tail");
		// …and the write really did fail (drain resolved while a real
		// rejection was in flight — the allSettled contract, not a no-op).
		await assert.rejects(append);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("d4: cleanupStateRoot removes the dir right after a fire-and-forget append (settleMs: 0)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-drain-d4-"));
	const eventsPath = path.join(dir, "state", "run-1", "events.jsonl");
	try {
		// The race repro: append is in flight (its mkdir/append tail queued)
		// and teardown starts IMMEDIATELY — no settle sleep, no manual drain.
		appendEventFireAndForget(eventsPath, { type: "task.progress", runId: "run-1", taskId: "t1", data: { i: 1 } });
		await cleanupStateRoot(dir, eventsPath);
		assert.equal(fs.existsSync(dir), false, "state root fully removed right after fire-and-forget append");
		// No resurrection after the fact either.
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(fs.existsSync(dir), false, "no dir resurrection after cleanupStateRoot");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
