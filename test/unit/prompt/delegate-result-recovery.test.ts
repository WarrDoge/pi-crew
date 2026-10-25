/**
 * delegate-result-recovery.test.ts — R9-F1 (2026-10-17 wave-2a): delegate
 * results were dropped on parent turn-restart — the grandchild completed
 * durably into the task inbox, but the poll loop died with the restarted
 * turn and nothing re-read the message. recoverPendingDelegateResults
 * re-injects still-pending subIds from the inbox (logged as
 * delegate.result.recovered) exactly once — no double-count.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { recoverPendingDelegateResults } from "../../../src/prompt/prompt-runtime.ts";
import type { MailboxMessage } from "../../../src/state/coordination/mailbox.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { cleanupStateRoot } from "../../helpers/rm-retry.ts";

function makeManifest(): TeamRunManifest {
	const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pc-r9f1-"));
	return {
		runId: "run_r9f1",
		stateRoot,
		cwd: process.cwd(),
		eventsPath: path.join(stateRoot, "events.jsonl"),
	} as unknown as TeamRunManifest;
}

const message = (from: string, body: string): MailboxMessage =>
	({
		id: `msg-${from}`,
		runId: "run_r9f1",
		direction: "inbox",
		from,
		to: "task-parent",
		body,
		createdAt: new Date().toISOString(),
		status: "delivered",
	}) as MailboxMessage;

test("R9-F1: pending subId + durable inbox message + fresh recovery pass → result recovered", async () => {
	const manifest = makeManifest();
	const inbox = [message("delegate:gc-1", "the 10,539-char report"), message("other:source", "unrelated")];
	const pending = new Set(["gc-1"]);
	const recovered = recoverPendingDelegateResults(manifest, pending, () => inbox);
	assert.equal(recovered.size, 1, "the pending subId's result is recovered");
	assert.equal(recovered.get("gc-1")?.body, "the 10,539-char report");
	// Unrelated subIds / senders are ignored.
	const recovered2 = recoverPendingDelegateResults(manifest, new Set(["gc-2"]), () => inbox);
	assert.equal(recovered2.size, 0, "non-pending subIds are not recovered");
	await cleanupStateRoot(manifest.stateRoot, manifest.eventsPath);
});

test("R9-F1: no double-count — a recovered subId is not re-recovered on the next pass", async () => {
	const manifest = makeManifest();
	const inbox = [message("delegate:gc-9", "report")];
	const pending = new Set(["gc-9"]);
	const first = recoverPendingDelegateResults(manifest, pending, () => inbox);
	assert.equal(first.size, 1);
	const second = recoverPendingDelegateResults(manifest, pending, () => inbox);
	assert.equal(second.size, 0, "already-recovered subId must not be recovered twice");
	// A reader failure degrades to empty — never throws into the poll loop.
	const failing = recoverPendingDelegateResults(manifest, pending, () => {
		throw new Error("transient");
	});
	assert.equal(failing.size, 0);
	await cleanupStateRoot(manifest.stateRoot, manifest.eventsPath);
});
