/**
 * events-replay-oversize-paging.test.ts — R9-N1(b) + R9-N2 (2026-10-17
 * wave-2a): events.since full-replay pages larger than the 256 KiB frame cap
 * must NEVER answer silence — the handler pre-checks the encoded response and
 * binary-halves the batch with a `nextSinceSeq` continuation; a single
 * oversize event answers a typed error. The fromByteOffset anchor makes the
 * PREFIX of >4 MB logs reachable (the default tail read only sees the last
 * 4 MB) and pages ALL events in order.
 *
 * Same fixture discipline as crew-broker-events-replay.test.ts (real scaffold
 * run + durable appends, fake EventWriterHelpers).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import type { ServerConnection } from "../../../../src/runtime/broker/protocol/connection-state.ts";
import { type EventWriterHelpers, handleEventsSince } from "../../../../src/runtime/broker/protocol/events-replay.ts";
import { appendEventAsync } from "../../../../src/state/event-log/event-log.ts";
import { loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import { teardownCwd } from "../../../fixtures/teardown-cwd.ts";

function recordingHelpers(): { helpers: EventWriterHelpers; seen: { errors: Array<{ id: string; code: string }>; results: unknown[] } } {
	const seen = { errors: [] as Array<{ id: string; code: string }>, results: [] as unknown[] };
	return {
		seen,
		helpers: {
			sendError: (_conn, id, code, _message) => {
				seen.errors.push({ id, code });
			},
			sendResult: (_conn, _id, result) => {
				seen.results.push(result);
			},
		},
	};
}

const conn = (runId: string): ServerConnection => ({ runId }) as unknown as ServerConnection;

async function fixture(prefix: string, events: Array<{ message: string }>): Promise<{ cwd: string; runId: string; seqs: number[] }> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "replay-oversize" },
		{ cwd },
	);
	const runId = run.details.runId as string;
	const loaded = loadRunManifestById(cwd, runId)!;
	const seqs: number[] = [];
	for (const e of events) {
		const appended = await appendEventAsync(loaded.manifest.eventsPath, {
			type: "task.progress",
			runId,
			taskId: loaded.tasks[0]?.id ?? "task-1",
			message: e.message,
		});
		seqs.push(appended.metadata?.seq ?? 0);
	}
	return { cwd, runId, seqs };
}

test("R9-N1: >256KiB replay page is truncated with a continuation — never silence", async (t) => {
	const big = "z".repeat(120 * 1024);
	const fx = await fixture("pc-r9n1-", [{ message: `e1-${big}` }, { message: `e2-${big}` }, { message: `e3-${big}` }]);
	t.after(() => teardownCwd(fx.cwd));
	const { helpers, seen } = recordingHelpers();
	await handleEventsSince(conn(fx.runId), "req-1", { sinceSeq: fx.seqs[0] - 1, limit: 10 }, helpers, fx.cwd);
	assert.equal(seen.errors.length, 0, `no typed error expected, got ${JSON.stringify(seen.errors)}`);
	assert.equal(seen.results.length, 1, "exactly one response — the client must never hang");
	const result = seen.results[0] as { events: unknown[]; truncated: boolean; nextSinceSeq: number; hasMore: boolean };
	assert.ok(result.events.length < 3, `page must be truncated below the requested batch, got ${result.events.length}`);
	assert.ok(result.events.length >= 1, "but at least one encodable event is delivered");
	assert.equal(result.truncated, true, "truncated flag must tell the client to page");
	assert.ok(result.nextSinceSeq >= fx.seqs[0], "continuation seq must be a safe resume anchor");
	assert.equal(result.hasMore, true);
});

test("R9-N1: a single event over the frame limit answers a typed response-oversize error", async (t) => {
	const huge = "q".repeat(300 * 1024);
	const fx = await fixture("pc-r9n1-single-", [{ message: `only-${huge}` }]);
	t.after(() => teardownCwd(fx.cwd));
	const { helpers, seen } = recordingHelpers();
	await handleEventsSince(conn(fx.runId), "req-2", { sinceSeq: fx.seqs[0] - 1, limit: 10 }, helpers, fx.cwd);
	assert.equal(seen.results.length, 0);
	assert.equal(seen.errors.length, 1, "typed error — never silence, never a throw");
	assert.equal(seen.errors[0].code, "response-oversize");
});

test("R9-N2: fromByteOffset pages the PREFIX of a >4MB log in order (3+ pages, all seqs)", async (t) => {
	const chunk = "p".repeat(60 * 1024); // 30 events ≈ 1.9MB… use 80 events ≈ 5MB
	const events: Array<{ message: string }> = [];
	for (let i = 0; i < 80; i++) events.push({ message: `seq-event-${i}-${chunk}` });
	const fx = await fixture("pc-r9n2-", events);
	t.after(() => teardownCwd(fx.cwd));
	const { helpers, seen } = recordingHelpers();
	const delivered: number[] = [];
	let sinceSeq = fx.seqs[0] - 1;
	let pages = 0;
	while (pages < 40) {
		await handleEventsSince(conn(fx.runId), `page-${pages}`, { sinceSeq, limit: 30, fromByteOffset: 0 }, helpers, fx.cwd);
		const result = seen.results[pages] as { events: Array<{ metadata?: { seq?: number } }>; nextSinceSeq: number; hasMore: boolean };
		assert.ok(result, "each page must answer");
		const seqs = result.events.map((e) => e.metadata?.seq ?? 0);
		delivered.push(...seqs);
		pages++;
		if (!result.hasMore) break;
		sinceSeq = result.nextSinceSeq;
	}
	assert.ok(pages >= 3, `expected a multi-page walk, got ${pages}`);
	assert.deepEqual(
		delivered,
		[...delivered].sort((a, b) => a - b),
		"pages must deliver seqs in order",
	);
	assert.deepEqual(
		delivered,
		fx.seqs,
		`ALL seqs must be reachable via fromByteOffset paging (got ${delivered.length}/${fx.seqs.length})`,
	);
});
