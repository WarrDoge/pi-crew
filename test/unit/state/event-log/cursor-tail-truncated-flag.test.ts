/**
 * cursor-tail-truncated-flag.test.ts — R9-N2 (2026-10-17 wave-2a): the wide
 * (default) readEventsCursor path only reads the last 4 MB of a log; when the
 * tail window truncates, the result must carry `truncated: true` so replay
 * consumers can switch to the fromByteOffset anchor instead of silently
 * missing the prefix. fromByteOffset paging itself is pinned end-to-end by
 * events-replay-oversize-paging.test.ts.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { readEventsCursor } from "../../../../src/state/event-log/cursor.ts";
import { cleanupStateRoot } from "../../../helpers/rm-retry.ts";

function makeEventsPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-r9n2c-"));
	return path.join(dir, "events.jsonl");
}

test("R9-N2: >4MB log → wide path reports truncated:true; small log does not", async () => {
	const eventsPath = makeEventsPath();
	try {
		const chunk = "c".repeat(60 * 1024);
		for (let seq = 1; seq <= 80; seq++) {
			fs.appendFileSync(
				eventsPath,
				`${JSON.stringify({ type: "task.progress", runId: "r", taskId: "t", message: `${seq}-${chunk}`, metadata: { seq } })}\n`,
			);
		}
		assert.ok(fs.statSync(eventsPath).size > 4 * 1024 * 1024, "fixture: log must exceed the 4MB tail window");
		const wide = readEventsCursor(eventsPath, { sinceSeq: 0, limit: 10 });
		assert.equal(wide.truncated, true, "wide path must flag the dropped prefix");
		// Small file (no truncation) keeps the flag unset — backward compatible.
		const smallPath = path.join(path.dirname(eventsPath), "small.jsonl");
		fs.writeFileSync(smallPath, `${JSON.stringify({ type: "x", runId: "r", metadata: { seq: 1 } })}\n`);
		const small = readEventsCursor(smallPath, { sinceSeq: 0, limit: 10 });
		assert.notEqual(small.truncated, true, "untruncated read must not set the flag");
	} finally {
		await cleanupStateRoot(path.dirname(eventsPath), eventsPath);
	}
});
