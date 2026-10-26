import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { asyncStartMarkerPath, hasAsyncStartMarker, writeAsyncStartMarker } from "../../../../src/runtime/async-marker.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

test("async start marker reports existing valid marker", async () => {
	const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-async-marker-"));
	try {
		const manifest = { stateRoot };
		writeAsyncStartMarker(manifest, {
			pid: 123,
			startedAt: "2026-04-28T00:00:00.000Z",
		});
		assert.equal(hasAsyncStartMarker(manifest), true);
		assert.equal(path.basename(asyncStartMarkerPath(manifest)), "async.pid");
	} finally {
		await removeDirWithRetry(stateRoot);
	}
});

test("async start marker ignores missing or invalid marker", async () => {
	const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-async-marker-invalid-"));
	try {
		const manifest = { stateRoot };
		assert.equal(hasAsyncStartMarker(manifest), false);
		fs.writeFileSync(asyncStartMarkerPath(manifest), "{bad json", "utf-8");
		assert.equal(hasAsyncStartMarker(manifest), false);
		fs.writeFileSync(asyncStartMarkerPath(manifest), JSON.stringify({ pid: 0, startedAt: "" }), "utf-8");
		assert.equal(hasAsyncStartMarker(manifest), false);
	} finally {
		await removeDirWithRetry(stateRoot);
	}
});
