import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { collectArtifactDescriptors } from "../../src/extension/registration/artifact-cleanup.ts";
import {
	CLEANUP_MARKER_FILE,
	cleanupOldArtifacts,
	pruneExpiredArtifacts,
	writeCleanupMarker,
} from "../../src/state/stores/artifact-store.ts";
import type { ArtifactDescriptor, TeamRunManifest } from "../../src/state/types.ts";

function makeDir(): string {
	// Use realpath to resolve symlinks (macOS /var/folders → /private/var/folders).
	// atomicWriteFile refuses to write through untrusted symlink paths.
	const realTmp = fs.realpathSync(os.tmpdir());
	return fs.mkdtempSync(path.join(realTmp, "pi-crew-artifact-cleanup-"));
}

test("cleanup removes old files but keeps new files", () => {
	const dir = makeDir();
	try {
		const oldFile = path.join(dir, "old.txt");
		const newFile = path.join(dir, "new.txt");
		fs.writeFileSync(oldFile, "old");
		fs.writeFileSync(newFile, "new");
		const oldMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
		fs.utimesSync(oldFile, oldMs / 1000, oldMs / 1000);
		const newMs = Date.now() - 1 * 60 * 1000;
		fs.utimesSync(newFile, newMs / 1000, newMs / 1000);
		cleanupOldArtifacts(dir, { maxAgeDays: 1, scanGraceMs: 0 });
		assert.equal(fs.existsSync(oldFile), false);
		assert.equal(fs.existsSync(newFile), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("fresh marker skips cleanup", () => {
	const dir = makeDir();
	try {
		const oldFile = path.join(dir, "old.txt");
		fs.writeFileSync(oldFile, "old");
		const oldMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
		fs.utimesSync(oldFile, oldMs / 1000, oldMs / 1000);
		writeCleanupMarker(dir, CLEANUP_MARKER_FILE);
		cleanupOldArtifacts(dir, {
			maxAgeDays: 1,
			scanGraceMs: 24 * 60 * 60 * 1000,
		});
		assert.equal(fs.existsSync(oldFile), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("stale marker triggers cleanup and updates marker", () => {
	const dir = makeDir();
	try {
		const oldFile = path.join(dir, "old.txt");
		fs.writeFileSync(oldFile, "old");
		const oldMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
		fs.utimesSync(oldFile, oldMs / 1000, oldMs / 1000);
		writeCleanupMarker(dir, CLEANUP_MARKER_FILE);
		const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
		const markerBefore = fs.statSync(markerPath).mtimeMs;
		const stale = Date.now() - 48 * 60 * 60 * 1000;
		fs.utimesSync(markerPath, stale / 1000, stale / 1000);
		cleanupOldArtifacts(dir, { maxAgeDays: 1, scanGraceMs: 1000 });
		assert.equal(fs.existsSync(oldFile), false);
		const markerAfter = fs.statSync(markerPath).mtimeMs;
		assert.ok(markerAfter >= markerBefore);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("missing directory is no-op", () => {
	const dir = path.join(os.tmpdir(), `pi-crew-artifact-cleanup-missing-${Date.now()}`);
	cleanupOldArtifacts(dir, { maxAgeDays: 1, scanGraceMs: 0 });
	assert.equal(fs.existsSync(dir), false);
});

// ---------------------------------------------------------------------------
// R44-N1 (fix-wave 6): collectArtifactDescriptors groups descriptors PER RUN
// with a HOST-DERIVED artifacts root anchor (<crewRoot>/artifacts/<runId>),
// and pruneExpiredArtifacts is containment-anchored — a run's manifest can
// only prune files under that run's OWN artifacts root. Pins the live P1
// probe (team_20261019032646: absolute + `../` victims unlinked, control
// survived) as real tests.
// ---------------------------------------------------------------------------

function expiredDescriptor(filePath: string): ArtifactDescriptor {
	return {
		kind: "log",
		path: filePath,
		createdAt: new Date(Date.now() - 120_000).toISOString(),
		producer: "test",
		retention: "run",
		expiresAt: new Date(Date.now() - 60_000).toISOString(),
	};
}

function writeManifest(runsDir: string, runId: string, artifacts: ArtifactDescriptor[]): void {
	const stateRoot = path.join(runsDir, runId);
	fs.mkdirSync(stateRoot, { recursive: true });
	const manifest = {
		schemaVersion: 2,
		runId,
		team: "fast-fix",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: runsDir,
		stateRoot,
		artifactsRoot: path.join(runsDir, "..", "..", "artifacts", runId),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts,
	} as unknown as TeamRunManifest;
	fs.writeFileSync(path.join(stateRoot, "manifest.json"), JSON.stringify(manifest));
}

test("R44-N1: descriptors are grouped per run with a host-derived artifacts-root anchor", () => {
	const crewRoot = makeDir();
	try {
		const runsDir = path.join(crewRoot, "state", "runs");
		writeManifest(runsDir, "team_a", [expiredDescriptor("/tmp/a.log")]);
		writeManifest(runsDir, "team_b", [expiredDescriptor("/tmp/b.log")]);
		const groups = collectArtifactDescriptors(runsDir);
		assert.equal(groups.length, 2);
		const byRun = new Map(groups.map((g) => [g.runId, g]));
		// Host-derived anchor convention (createRunPaths parity) — NOT the
		// manifest-declared artifactsRoot (which the test manifest set with
		// `..` segments on purpose: it must be ignored for anchoring).
		assert.equal(path.resolve(byRun.get("team_a")!.artifactsRoot), path.resolve(path.join(crewRoot, "artifacts", "team_a")));
		assert.equal(path.resolve(byRun.get("team_b")!.artifactsRoot), path.resolve(path.join(crewRoot, "artifacts", "team_b")));
		assert.equal(byRun.get("team_a")!.descriptors.length, 1);
	} finally {
		fs.rmSync(crewRoot, { recursive: true, force: true });
	}
});

test("R44-N1 pin (P1 conversion): run A's manifest cannot prune run B's artifacts (cross-run)", () => {
	const crewRoot = makeDir();
	try {
		const runsDir = path.join(crewRoot, "state", "runs");
		const artifactsA = path.join(crewRoot, "artifacts", "team_a");
		const artifactsB = path.join(crewRoot, "artifacts", "team_b");
		fs.mkdirSync(artifactsA, { recursive: true });
		fs.mkdirSync(artifactsB, { recursive: true });
		const ownExpired = path.join(artifactsA, "own-expired.log");
		const otherRunFile = path.join(artifactsB, "other-run.log");
		fs.writeFileSync(ownExpired, "a");
		fs.writeFileSync(otherRunFile, "b");
		// Malicious/buggy run-A manifest declares run B's file as its own artifact.
		writeManifest(runsDir, "team_a", [expiredDescriptor(ownExpired), expiredDescriptor(otherRunFile)]);
		for (const group of collectArtifactDescriptors(runsDir)) {
			pruneExpiredArtifacts(group.descriptors, { artifactsRoot: group.artifactsRoot });
		}
		assert.equal(fs.existsSync(ownExpired), false, "run A's own expired artifact is pruned (control)");
		assert.equal(fs.existsSync(otherRunFile), true, "run B's file must survive run A's manifest");
	} finally {
		fs.rmSync(crewRoot, { recursive: true, force: true });
	}
});

test("R44-N1 pin (P1 conversion): manifest-declared absolute + `..`-escape victims survive host prune", () => {
	const crewRoot = makeDir();
	try {
		const runsDir = path.join(crewRoot, "state", "runs");
		const artifacts = path.join(crewRoot, "artifacts", "team_a");
		fs.mkdirSync(artifacts, { recursive: true });
		const victimAbs = path.join(crewRoot, "victim-abs.txt");
		const victimRel = path.join(crewRoot, "victim-rel.txt");
		const control = path.join(artifacts, "control-expired.log");
		fs.writeFileSync(victimAbs, "user file");
		fs.writeFileSync(victimRel, "user file");
		fs.writeFileSync(control, "artifact");
		// Exactly the live P1 probe shape: absolute victim + state/runs/../ escape.
		const relEscape = path.join(runsDir, "..", "..", "victim-rel.txt");
		writeManifest(runsDir, "team_a", [expiredDescriptor(victimAbs), expiredDescriptor(relEscape), expiredDescriptor(control)]);
		for (const group of collectArtifactDescriptors(runsDir)) {
			pruneExpiredArtifacts(group.descriptors, { artifactsRoot: group.artifactsRoot });
		}
		assert.equal(fs.existsSync(victimAbs), true, "absolute-outside victim must survive");
		assert.equal(fs.existsSync(victimRel), true, "`..`-escape victim must survive");
		assert.equal(fs.existsSync(control), false, "in-root expired control must still be pruned");
	} finally {
		fs.rmSync(crewRoot, { recursive: true, force: true });
	}
});
