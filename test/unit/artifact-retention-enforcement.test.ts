import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { isArtifactExpired, pruneExpiredArtifacts, TEMPORARY_RETENTION_TTL_MS } from "../../src/state/stores/artifact-store.ts";
import type { ArtifactDescriptor } from "../../src/state/types.ts";

/**
 * ST-10 tests: ArtifactDescriptor.retention/expiresAt enforcement.
 *
 * Artifacts whose descriptor indicates expiry (expiresAt passed or
 * temporary-retention TTL exceeded) must be deleted on prune.
 * Artifacts that are still valid must be preserved.
 */

// Use realpath to resolve symlinks (macOS /var/folders → /private/var/folders).
const realTmp = fs.realpathSync(os.tmpdir());

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(realTmp, "pi-crew-st10-"));
}

function iso(offsetMs: number): string {
	return new Date(Date.now() + offsetMs).toISOString();
}

function makeDescriptor(filePath: string, overrides: Partial<ArtifactDescriptor> = {}): ArtifactDescriptor {
	return {
		kind: "log",
		path: filePath,
		createdAt: new Date().toISOString(),
		producer: "test",
		retention: "run",
		...overrides,
	};
}

test("ST-10: isArtifactExpired returns true when expiresAt is in the past", () => {
	const desc = makeDescriptor("/tmp/x", { expiresAt: iso(-60_000) });
	assert.equal(isArtifactExpired(desc, Date.now()), true);
});

test("ST-10: isArtifactExpired returns false when expiresAt is in the future", () => {
	const desc = makeDescriptor("/tmp/x", { expiresAt: iso(60_000) });
	assert.equal(isArtifactExpired(desc, Date.now()), false);
});

test("ST-10: isArtifactExpired returns false when no expiresAt and retention is 'run'", () => {
	const desc = makeDescriptor("/tmp/x", { retention: "run" });
	assert.equal(isArtifactExpired(desc, Date.now()), false);
});

test("ST-10: isArtifactExpired returns false when no expiresAt and retention is 'project'", () => {
	const desc = makeDescriptor("/tmp/x", { retention: "project" });
	assert.equal(isArtifactExpired(desc, Date.now()), false);
});

test("ST-10: isArtifactExpired returns true for 'temporary' retention past TTL", () => {
	const now = Date.now();
	const createdIso = new Date(now - TEMPORARY_RETENTION_TTL_MS - 1000).toISOString();
	const desc = makeDescriptor("/tmp/x", { retention: "temporary", createdAt: createdIso });
	assert.equal(isArtifactExpired(desc, now), true);
});

test("ST-10: isArtifactExpired returns false for 'temporary' retention within TTL", () => {
	const now = Date.now();
	const createdIso = new Date(now - 1000).toISOString(); // 1 second ago
	const desc = makeDescriptor("/tmp/x", { retention: "temporary", createdAt: createdIso });
	assert.equal(isArtifactExpired(desc, now), false);
});

test("ST-10: pruneExpiredArtifacts deletes files past expiresAt", () => {
	const dir = makeTmpDir();
	try {
		const expiredFile = path.join(dir, "expired.log");
		const validFile = path.join(dir, "valid.log");
		fs.writeFileSync(expiredFile, "old");
		fs.writeFileSync(validFile, "new");

		const descriptors: ArtifactDescriptor[] = [
			makeDescriptor(expiredFile, { expiresAt: iso(-60_000) }),
			makeDescriptor(validFile, { expiresAt: iso(60_000) }),
		];

		const deleted = pruneExpiredArtifacts(descriptors, { artifactsRoot: dir });
		assert.equal(deleted, 1);
		assert.equal(fs.existsSync(expiredFile), false);
		assert.equal(fs.existsSync(validFile), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ST-10: pruneExpiredArtifacts deletes 'temporary' retention artifacts past TTL", () => {
	const dir = makeTmpDir();
	try {
		const staleFile = path.join(dir, "stale-progress.log");
		const freshFile = path.join(dir, "fresh-progress.log");
		fs.writeFileSync(staleFile, "stale");
		fs.writeFileSync(freshFile, "fresh");

		const now = Date.now();
		const descriptors: ArtifactDescriptor[] = [
			makeDescriptor(staleFile, {
				retention: "temporary",
				createdAt: new Date(now - TEMPORARY_RETENTION_TTL_MS - 5000).toISOString(),
			}),
			makeDescriptor(freshFile, {
				retention: "temporary",
				createdAt: new Date(now - 1000).toISOString(),
			}),
		];

		const deleted = pruneExpiredArtifacts(descriptors, { now, artifactsRoot: dir });
		assert.equal(deleted, 1);
		assert.equal(fs.existsSync(staleFile), false);
		assert.equal(fs.existsSync(freshFile), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ST-10: pruneExpiredArtifacts does NOT delete 'run' or 'project' retention without expiresAt", () => {
	const dir = makeTmpDir();
	try {
		const runFile = path.join(dir, "run.log");
		const projectFile = path.join(dir, "project.log");
		fs.writeFileSync(runFile, "run");
		fs.writeFileSync(projectFile, "project");

		// Create these long ago — age should NOT matter for run/project without expiresAt.
		const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
		const descriptors: ArtifactDescriptor[] = [
			makeDescriptor(runFile, { retention: "run", createdAt: oldIso }),
			makeDescriptor(projectFile, { retention: "project", createdAt: oldIso }),
		];

		const deleted = pruneExpiredArtifacts(descriptors, { artifactsRoot: dir });
		assert.equal(deleted, 0);
		assert.equal(fs.existsSync(runFile), true);
		assert.equal(fs.existsSync(projectFile), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ST-10: pruneExpiredArtifacts handles missing files gracefully", () => {
	const dir = makeTmpDir();
	try {
		const descriptors: ArtifactDescriptor[] = [makeDescriptor(path.join(dir, "does-not-exist.log"), { expiresAt: iso(-60_000) })];

		// Should not throw — best-effort.
		const deleted = pruneExpiredArtifacts(descriptors, { artifactsRoot: dir });
		assert.equal(deleted, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ST-10: pruneExpiredArtifacts with empty descriptor list is a no-op", () => {
	const deleted = pruneExpiredArtifacts([], { artifactsRoot: path.join(realTmp, "anchor-unused") });
	assert.equal(deleted, 0);
});

test("ST-10: pruneExpiredArtifacts respects custom temporaryTtlMs", () => {
	const dir = makeTmpDir();
	try {
		const file = path.join(dir, "temp.log");
		fs.writeFileSync(file, "temp");

		const now = Date.now();
		const created5sAgo = new Date(now - 5000).toISOString();
		const descriptors: ArtifactDescriptor[] = [makeDescriptor(file, { retention: "temporary", createdAt: created5sAgo })];

		// With a 10s TTL, 5s old is NOT expired.
		assert.equal(pruneExpiredArtifacts(descriptors, { now, temporaryTtlMs: 10_000, artifactsRoot: dir }), 0);
		assert.equal(fs.existsSync(file), true);

		// With a 3s TTL, 5s old IS expired.
		assert.equal(pruneExpiredArtifacts(descriptors, { now, temporaryTtlMs: 3_000, artifactsRoot: dir }), 1);
		assert.equal(fs.existsSync(file), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// R44-N1 (fix-wave 6): prune containment — every manifest-declared artifact
// path must realpath UNDER the run's host-derived artifacts root before
// unlink. Pins the live-proven probe (P1: absolute + `../` victims unlinked,
// control survived) as real tests: the victims must now SURVIVE.
// ---------------------------------------------------------------------------

test("R44-N1: absolute path outside the artifacts root survives (never unlinked)", () => {
	const anchor = makeTmpDir();
	const outside = makeTmpDir();
	try {
		const victim = path.join(outside, "victim-abs.txt");
		fs.writeFileSync(victim, "user file");
		const descriptors: ArtifactDescriptor[] = [makeDescriptor(victim, { expiresAt: iso(-60_000) })];
		const deleted = pruneExpiredArtifacts(descriptors, { artifactsRoot: anchor });
		assert.equal(deleted, 0);
		assert.equal(fs.existsSync(victim), true, "absolute-outside victim must survive");
	} finally {
		fs.rmSync(anchor, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("R44-N1: `..` traversal path escaping the artifacts root survives", () => {
	const anchor = makeTmpDir();
	const outside = makeTmpDir();
	try {
		const victim = path.join(outside, "victim-rel.txt");
		fs.writeFileSync(victim, "user file");
		// Relative escape from the anchor to the victim with a LITERAL `..`
		// segment (mirrors the live P1 probe's
		// state/runs/../../../../../victim-rel.txt descriptor).
		const escaping = `${anchor}/../${path.relative(path.dirname(anchor), victim)}`;
		const descriptors: ArtifactDescriptor[] = [makeDescriptor(escaping, { expiresAt: iso(-60_000) })];
		const deleted = pruneExpiredArtifacts(descriptors, { artifactsRoot: anchor });
		assert.equal(deleted, 0);
		assert.equal(fs.existsSync(victim), true, "`..`-escape victim must survive");
	} finally {
		fs.rmSync(anchor, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("R44-N1: symlink inside the root pointing at an outside victim survives (symlink escape)", () => {
	const anchor = makeTmpDir();
	const outside = makeTmpDir();
	try {
		const victim = path.join(outside, "victim-symlink.txt");
		fs.writeFileSync(victim, "user file");
		const link = path.join(anchor, "escape-link.log");
		fs.symlinkSync(victim, link);
		const descriptors: ArtifactDescriptor[] = [makeDescriptor(link, { expiresAt: iso(-60_000) })];
		const deleted = pruneExpiredArtifacts(descriptors, { artifactsRoot: anchor });
		assert.equal(deleted, 0);
		assert.equal(fs.existsSync(victim), true, "symlink-escape victim must survive");
	} finally {
		fs.rmSync(anchor, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("R44-N1: expired artifact genuinely inside the root is still pruned (control)", () => {
	const anchor = makeTmpDir();
	try {
		const nested = path.join(anchor, "tasks", "01_x");
		fs.mkdirSync(nested, { recursive: true });
		const expired = path.join(nested, "expired.log");
		const valid = path.join(anchor, "valid.log");
		fs.writeFileSync(expired, "x");
		fs.writeFileSync(valid, "y");
		const descriptors: ArtifactDescriptor[] = [
			makeDescriptor(expired, { expiresAt: iso(-60_000) }),
			makeDescriptor(valid, { expiresAt: iso(60_000) }),
		];
		const deleted = pruneExpiredArtifacts(descriptors, { artifactsRoot: anchor });
		assert.equal(deleted, 1);
		assert.equal(fs.existsSync(expired), false, "in-root expired artifact must be pruned");
		assert.equal(fs.existsSync(valid), true);
	} finally {
		fs.rmSync(anchor, { recursive: true, force: true });
	}
});

test("R44-N1: missing artifacts root (anchor) fails closed — nothing deleted", () => {
	const outside = makeTmpDir();
	try {
		const victim = path.join(outside, "victim-noanchor.txt");
		fs.writeFileSync(victim, "user file");
		const missingAnchor = path.join(outside, "no-such-artifacts-root");
		const descriptors: ArtifactDescriptor[] = [makeDescriptor(victim, { expiresAt: iso(-60_000) })];
		const deleted = pruneExpiredArtifacts(descriptors, { artifactsRoot: missingAnchor });
		assert.equal(deleted, 0);
		assert.equal(fs.existsSync(victim), true);
	} finally {
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("R44-N1: symlinked artifacts root fails closed — nothing deleted", () => {
	const anchor = makeTmpDir();
	const outside = makeTmpDir();
	try {
		const victim = path.join(outside, "victim-symlinkroot.txt");
		fs.writeFileSync(victim, "user file");
		const inside = path.join(anchor, "inside.log");
		fs.writeFileSync(inside, "artifact");
		const linkedAnchor = path.join(outside, "linked-root");
		fs.symlinkSync(anchor, linkedAnchor);
		const descriptors: ArtifactDescriptor[] = [makeDescriptor(inside, { expiresAt: iso(-60_000) })];
		const deleted = pruneExpiredArtifacts(descriptors, { artifactsRoot: linkedAnchor });
		assert.equal(deleted, 0, "a symlinked anchor proves nothing — fail closed");
		assert.equal(fs.existsSync(inside), true);
		assert.equal(fs.existsSync(victim), true);
	} finally {
		fs.rmSync(anchor, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("R44-N1: realpath failure on the target (non-ENOENT) fails closed", () => {
	const anchor = makeTmpDir();
	try {
		// A dangling path whose PARENT is a plain file: realpathSync fails with
		// ENOTDIR (not ENOENT) — must skip, never throw, never delete.
		const blockingFile = path.join(anchor, "blocker");
		fs.writeFileSync(blockingFile, "not a dir");
		const badPath = path.join(blockingFile, "child.log");
		const descriptors: ArtifactDescriptor[] = [makeDescriptor(badPath, { expiresAt: iso(-60_000) })];
		const deleted = pruneExpiredArtifacts(descriptors, { artifactsRoot: anchor });
		assert.equal(deleted, 0);
		assert.equal(fs.existsSync(blockingFile), true, "the blocking file itself must never be touched");
	} finally {
		fs.rmSync(anchor, { recursive: true, force: true });
	}
});

test("R44-N1: descriptor path exactly equal to the anchor directory is blocked", () => {
	const anchor = makeTmpDir();
	try {
		const descriptors: ArtifactDescriptor[] = [makeDescriptor(anchor, { expiresAt: iso(-60_000) })];
		const deleted = pruneExpiredArtifacts(descriptors, { artifactsRoot: fs.realpathSync(anchor) });
		assert.equal(deleted, 0);
		assert.equal(fs.existsSync(anchor), true, "the artifacts root itself must never be unlinked");
	} finally {
		fs.rmSync(anchor, { recursive: true, force: true });
	}
});
