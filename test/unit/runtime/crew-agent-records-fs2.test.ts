/**
 * crew-agent-records-fs2.test.ts — FS2 (2026-10-17 wave-2a): readCrewAgents
 * must NOT degrade an unreadable/unparseable agents.json to [] — the next
 * upsert would persist that [] and WIPE the authoritative index.
 *
 * ENOENT stays a legitimate [] (first write); every other read/parse failure
 * returns the CREW_AGENTS_READ_FAILED sentinel and upsertCrewAgent SKIPS the
 * save so the on-disk bytes survive for manual recovery.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { CREW_AGENTS_READ_FAILED, readCrewAgents, upsertCrewAgent } from "../../../src/runtime/crew-agent-records.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { cleanupStateRoot } from "../../helpers/rm-retry.ts";

function makeManifest(): { manifest: TeamRunManifest; stateRoot: string } {
	const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pc-fs2-"));
	const manifest = {
		runId: "run_fs2",
		stateRoot,
		cwd: process.cwd(),
		eventsPath: path.join(stateRoot, "events.jsonl"),
	} as unknown as TeamRunManifest;
	return { manifest, stateRoot };
}

const record = (id: string, taskId: string): Record<string, unknown> => ({
	id,
	taskId,
	runId: "run_fs2",
	agentId: "a",
	role: "executor",
	status: "completed",
	createdAt: new Date().toISOString(),
});

test("FS2: corrupt agents.json → sentinel, and upsert does NOT overwrite the file", async () => {
	const { manifest, stateRoot } = makeManifest();
	try {
		const agentsPath = path.join(stateRoot, "agents.json");
		const corrupt = '{"broken json';
		fs.writeFileSync(agentsPath, corrupt, "utf-8");

		const read = readCrewAgents(manifest);
		assert.equal(read, CREW_AGENTS_READ_FAILED, "corrupt JSON must return the sentinel, not []");
		assert.equal(read.length, 0, "sentinel is empty so read-only callers still degrade");

		upsertCrewAgent(manifest, record("agent-2", "task-2") as never);
		assert.equal(fs.readFileSync(agentsPath, "utf-8"), corrupt, "upsert must NOT persist over unreadable state");
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("FS2: healthy read + upsert still works (no false positives)", async () => {
	const { manifest, stateRoot } = makeManifest();
	try {
		const agentsPath = path.join(stateRoot, "agents.json");
		fs.writeFileSync(agentsPath, JSON.stringify([record("agent-1", "task-1")]), "utf-8");
		const read = readCrewAgents(manifest);
		assert.equal(read.length, 1);
		assert.notEqual(read, CREW_AGENTS_READ_FAILED);

		upsertCrewAgent(manifest, record("agent-2", "task-2") as never);
		const after = JSON.parse(fs.readFileSync(agentsPath, "utf-8")) as Array<{ id: string }>;
		assert.equal(after.length, 2, `both agents retained, got ${after.map((a) => a.id).join(",")}`);
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});
