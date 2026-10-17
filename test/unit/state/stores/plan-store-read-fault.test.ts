/**
 * plan-store-read-fault.test.ts — R5-M-B4 (2026-10-17 wave-2a): a read/parse
 * fault on plans.json must NOT degrade to [] inside appendPlanRevision — []
 * is indistinguishable from "first revision" and the locked full-overwrite
 * would erase the whole v1-window lineage. ENOENT stays a legitimate empty
 * store (first write).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { appendPlanRevision, planFilePath } from "../../../../src/state/stores/plan-store.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

function makeManifest(): { manifest: TeamRunManifest; stateRoot: string } {
	const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pc-planb4-"));
	const manifest = {
		runId: "run_planb4",
		stateRoot,
		cwd: process.cwd(),
		eventsPath: path.join(stateRoot, "events.jsonl"),
	} as unknown as TeamRunManifest;
	return { manifest, stateRoot };
}

const v1 = {
	id: "plan-1",
	version: 1,
	createdAt: new Date().toISOString(),
	createdBy: "test",
	title: "keep",
	items: [{ id: "i1", title: "item", status: "pending", taskIds: [], phaseId: "p1", notes: "" }],
	phases: [{ id: "p1", title: "phase", itemIds: ["i1"] }],
};

test("R5-M-B4: corrupt plans.json → appendPlanRevision throws, file NOT overwritten", () => {
	const { manifest, stateRoot } = makeManifest();
	try {
		fs.mkdirSync(path.dirname(planFilePath(manifest)), { recursive: true });
		const corrupt = "}{ not json";
		fs.writeFileSync(planFilePath(manifest), corrupt, "utf-8");

		assert.throws(() => appendPlanRevision(manifest, structuredClone(v1) as never), /unreadable/);
		assert.equal(fs.readFileSync(planFilePath(manifest), "utf-8"), corrupt, "lineage must survive for manual recovery");
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("R5-M-B4: ENOENT is a legitimate empty store — first append still works", () => {
	const { manifest, stateRoot } = makeManifest();
	try {
		const stored = appendPlanRevision(manifest, structuredClone(v1) as never);
		assert.equal(stored.version, 1);
		assert.ok(fs.existsSync(planFilePath(manifest)), "first write must still happen");
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});
