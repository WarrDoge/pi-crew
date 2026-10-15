/**
 * D6 (DR-02 Wave 2, Cluster F) — writeSeqToSidecar switched from plain
 * writeFileSync to the atomic tmp+rename helper (atomicWriteFile). This test
 * pins the OBSERVABLE contract through the public appendCrewAgentEvent API:
 *   - the .seq sidecar lands at the same path with the same format (bare
 *     number, no newline) and always reflects the LAST seq;
 *   - seq allocation stays monotonic (1, 2, 3, ...) — i.e. the sidecar
 *     round-trips through readSeqFromSidecar;
 *   - the tmp+rename contract leaves NO *.tmp leftovers in the agents dir.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { appendCrewAgentEvent } from "../../../../src/runtime/crew-agent-records.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";

function buildManifest(cwd: string) {
	return createRunManifest({
		cwd,
		team: {
			name: "seq-atomic-team",
			description: "seq atomic",
			source: "builtin",
			filePath: "",
			roles: [{ name: "explorer", agent: "explorer" }],
		},
		workflow: {
			name: "seq-atomic",
			description: "",
			source: "builtin",
			filePath: "",
			steps: [],
		},
		goal: "seq atomic",
	}).manifest;
}

test("writeSeqToSidecar lands atomically: correct .seq content, monotonic seqs, no .tmp leftovers (DR-02 D6)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-seq-atomic-"));
	// createRunManifest uses project state when findRepoRoot() returns a path;
	// a .git dir keeps files under the tmp cwd (same trick as the seq-cap test).
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	try {
		const manifest = buildManifest(cwd);

		appendCrewAgentEvent(manifest, "task-seq", { kind: "a" });
		appendCrewAgentEvent(manifest, "task-seq", { kind: "b" });
		appendCrewAgentEvent(manifest, "task-seq", { kind: "c" });

		const eventsPath = path.join(cwd, ".crew", "state", "runs", manifest.runId, "agents", "task-seq", "events.jsonl");
		// AGENT_EVENT_SEQ_SIDECAR is ".seq" and the builder appends it after a
		// "." — the on-disk name is "events.jsonl..seq" (pre-existing format).
		const sidecarPath = `${eventsPath}..seq`;
		assert.ok(fs.existsSync(eventsPath), "events.jsonl should exist");
		assert.ok(fs.existsSync(sidecarPath), ".seq sidecar should exist");

		// Same path + same format: a bare decimal number (String(seq)).
		assert.equal(fs.readFileSync(sidecarPath, "utf-8"), "3", "sidecar must contain the LAST seq as a bare number");

		// Monotonic seq allocation — proves the sidecar round-trips.
		const lines = fs
			.readFileSync(eventsPath, "utf-8")
			.split("\n")
			.filter((l) => l.trim());
		assert.equal(lines.length, 3, "three appended events");
		const seqs = lines.map((l) => (JSON.parse(l) as { seq: number }).seq);
		assert.deepEqual(seqs, [1, 2, 3], "seq allocation must stay monotonic");

		// Atomic-write contract: the tmp file must never leak into the dir.
		const dirEntries = fs.readdirSync(path.dirname(eventsPath));
		const leftovers = dirEntries.filter((f) => f.endsWith(".tmp"));
		assert.deepEqual(leftovers, [], "tmp+rename must not leak temp files");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
