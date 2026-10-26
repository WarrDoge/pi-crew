/**
 * P-5 (DR-04 round-7): restoreState rejects unknown snapshot versions.
 *
 * `snapshotState` writes `{ version: 1, vars, failed }`. restoreState used to
 * parse only `vars` and silently restore an EMPTY namespace for any other
 * format — a v2 snapshot from a future pi-crew (or a hand-crafted file) read
 * as "nothing to restore". The version gate must fail LOUDLY: warn +
 * `{ restored: [], reason }`, and the engine must NOT be started for a file
 * we are going to refuse anyway.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { EngineManager } from "../../../../src/runtime/scratchpad/engine.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-restore-version-"));
}

/** EngineManager keeps its lifecycle state private; read it for test assertions only. */
function engineState(engine: EngineManager): string | undefined {
	return (engine as unknown as { engineState?: string }).engineState;
}

test("P-5: restoreState rejects a version-2 snapshot (fail loudly, no fail-open)", { timeout: 30_000 }, async (t) => {
	const dir = tempDir();
	t.after(() => removeDirWithRetry(dir));
	const snapPath = path.join(dir, "t1.attempt-1.snapshot.json");
	fs.writeFileSync(snapPath, JSON.stringify({ version: 2, vars: { answer: "42" }, failed: [] }), "utf-8");
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	const res = await engine.restoreState(snapPath);
	assert.ok(res, "must return an explicit rejection result (not null)");
	assert.deepEqual(res.restored, []);
	assert.deepEqual(res.failed, []);
	assert.match(res.reason ?? "", /^unsupported-snapshot-version:2$/, "reason must name the refused version");
	// Fail loudly, cheaply: the engine must not have been started to refuse.
	assert.equal(engineState(engine), "idle", "engine must stay idle when the snapshot is refused");
});

test("P-5: restoreState rejects a snapshot with NO version field (unknown format)", { timeout: 30_000 }, async (t) => {
	const dir = tempDir();
	t.after(() => removeDirWithRetry(dir));
	const snapPath = path.join(dir, "t1.attempt-1.snapshot.json");
	// Pre-gate shape: no `version` — every writer since Phase 3 stamps version 1,
	// so a versionless file is not a format we can safely interpret.
	fs.writeFileSync(snapPath, JSON.stringify({ vars: { answer: "42" } }), "utf-8");
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	const res = await engine.restoreState(snapPath);
	assert.ok(res);
	assert.deepEqual(res.restored, []);
	assert.match(res.reason ?? "", /^unsupported-snapshot-version:undefined$/);
	assert.equal(engineState(engine), "idle");
});

test("P-5: a version-1 snapshot still passes the gate (path/failed shape intact)", { timeout: 60_000 }, async (t) => {
	const dir = tempDir();
	t.after(() => removeDirWithRetry(dir));
	const snapPath = path.join(dir, "t1.attempt-1.snapshot.json");
	// Empty-vars v1 snapshot: passes the version gate, restores zero names —
	// result WITHOUT a rejection reason (distinction P-5 introduces).
	fs.writeFileSync(snapPath, JSON.stringify({ version: 1, vars: {}, failed: [] }), "utf-8");
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	const res = await engine.restoreState(snapPath);
	assert.ok(res, "v1 snapshot must reach the restore path");
	assert.deepEqual(res.restored, []);
	assert.equal(res.reason, undefined, "v1 (accepted) result carries no rejection reason");
});
