import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { readVerifiedArtifact, writeArtifact } from "../../../../src/state/stores/artifact-store.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

// Use realpath to resolve symlinks (macOS /var/folders → /private/var/folders).
// atomicWriteFile refuses to write through untrusted symlink paths.
const realTmp = fs.realpathSync(os.tmpdir());

test("writeArtifact: contentHash matches sha256 of bytes on disk", async () => {
	const root = fs.mkdtempSync(path.join(realTmp, "pi-crew-art-"));
	const desc = writeArtifact(root, {
		kind: "log",
		relativePath: "x.log",
		content: "api_key=AKIA0123456789ABCDEF\nplain text",
		producer: "test",
	});
	const onDisk = fs.readFileSync(desc.path);
	const expected = createHash("sha256").update(onDisk).digest("hex");
	assert.strictEqual(desc.contentHash, expected);
	assert.strictEqual(desc.sizeBytes, onDisk.length);
	assert.ok(!onDisk.toString("utf-8").includes("AKIA0123456789ABCDEF"));
	await removeDirWithRetry(root);
});

// STATE-9: the hash must be computed on the in-memory content (post-redaction)
// WITHOUT a read-back of the file. The atomic write writes exact content, so
// the hash of the in-memory string == the hash of the on-disk bytes. Verify
// redaction happens BEFORE hashing (hash covers the redacted content, same as
// the bytes that actually land on disk — behavior identical to the old read-back).
test("writeArtifact: contentHash matches post-redaction in-memory content (STATE-9)", async () => {
	const root = fs.mkdtempSync(path.join(realTmp, "pi-crew-art-state9-"));
	try {
		const content = '{"api_key":"sk-abc123-not-a-real-key","keep":"visible"}';
		const desc = writeArtifact(root, {
			kind: "metadata",
			relativePath: "state9.json",
			content,
			producer: "test",
		});
		// Hash must equal sha256 of the bytes actually on disk (which are the
		// redacted in-memory content — atomic write writes exact bytes).
		const onDisk = fs.readFileSync(desc.path, "utf-8");
		const expected = createHash("sha256").update(onDisk).digest("hex");
		assert.strictEqual(desc.contentHash, expected, "hash computed on in-memory content matches on-disk bytes");
		assert.ok(!onDisk.includes("sk-abc123-not-a-real-key"), "secret redacted before hashing");
	} finally {
		await removeDirWithRetry(root);
	}
});

test("writeArtifact: rejects path traversal", async () => {
	const root = fs.mkdtempSync(path.join(realTmp, "pi-crew-art-"));
	assert.throws(
		() =>
			writeArtifact(root, {
				kind: "log",
				relativePath: "../escape.log",
				content: "x",
				producer: "t",
			}),
		/Invalid artifact path/,
	);
	await removeDirWithRetry(root);
});

test("writeArtifact: creates nested directories", async () => {
	const root = fs.mkdtempSync(path.join(realTmp, "pi-crew-art-"));
	const desc = writeArtifact(root, {
		kind: "log",
		relativePath: "a/b/c.log",
		content: "nested",
		producer: "test",
	});
	assert.ok(fs.existsSync(desc.path));
	await removeDirWithRetry(root);
});

test("M2 regression: writeArtifact redacts quoted-JSON & nested secrets via structural pass", async () => {
	// Flat redactSecretString misses JSON-quoted keys ("api_key":"...") because
	// the char after the key run is '"' not ':'/'='. The structural JSON pass
	// added in writeArtifact (security review M2) must catch these.
	const root = fs.mkdtempSync(path.join(realTmp, "pi-crew-art-m2-"));
	const payload = JSON.stringify({
		api_key: "sk-abc123-not-a-real-key",
		nested: { token: "ghp_0123456789abcdef0123456789abcdef" },
		authorization: "Basic c2VjcmV0",
	});
	const desc = writeArtifact(root, {
		kind: "metadata",
		relativePath: "evidence.json",
		content: payload,
		producer: "test",
	});
	const onDisk = fs.readFileSync(desc.path, "utf-8");
	assert.ok(!onDisk.includes("sk-abc123-not-a-real-key"), "api_key value must be redacted (M2)");
	assert.ok(!onDisk.includes("ghp_0123456789abcdef0123456789abcdef"), "nested token must be redacted (M2)");
	assert.ok(!onDisk.includes("c2VjcmV0"), "authorization Basic value must be redacted (M2)");
	// Structure preserved (still valid JSON).
	assert.doesNotThrow(() => JSON.parse(onDisk));
	await removeDirWithRetry(root);
});

// ── M3-27 / R44-N3: read-side hash verification ──────────────────────────────
//
// Round 44 probe (r50b-s3/n3): `contentHash` was written at write time but never
// verified on a read — a tampered artifact was served with
// `hash-mismatch-but-still-served: true`. readVerifiedArtifact is that missing
// read path; these pins cover the tamper case, the happy case, missing files,
// descriptors without a pinned hash, and root containment.

test("M3-27/R44-N3: readVerifiedArtifact returns the content when the pinned hash matches", async () => {
	const root = fs.mkdtempSync(path.join(realTmp, "pi-crew-art-verify-ok-"));
	try {
		const desc = writeArtifact(root, {
			kind: "log",
			relativePath: "evidence/result.md",
			content: "VERIFIER EVIDENCE: all gates green\n",
			producer: "verifier",
		});
		const read = readVerifiedArtifact(desc);
		assert.equal(read.ok, true);
		if (read.ok) {
			assert.equal(read.content, "VERIFIER EVIDENCE: all gates green\n");
			assert.equal(read.contentHash, desc.contentHash);
		}
	} finally {
		await removeDirWithRetry(root);
	}
});

test("M3-27/R44-N3: a TAMPERED artifact is refused (probe n3 replay: served bytes ≠ pinned hash)", async () => {
	const root = fs.mkdtempSync(path.join(realTmp, "pi-crew-art-verify-bad-"));
	try {
		const desc = writeArtifact(root, {
			kind: "log",
			relativePath: "evidence/result.md",
			content: "VERIFIER EVIDENCE: gate FAILED, do not merge\n",
			producer: "verifier",
		});
		// Same-uid rewrite between write and read (the probe's attack).
		fs.writeFileSync(desc.path, "VERIFIER EVIDENCE: all gates green, safe to merge\n");
		const read = readVerifiedArtifact(desc);
		assert.equal(read.ok, false);
		if (!read.ok) {
			assert.equal(read.reason, "hash-mismatch");
			assert.equal(read.expectedHash, desc.contentHash);
			assert.notEqual(read.actualHash, desc.contentHash);
			// The untrusted bytes are surfaced for diagnostics only — a caller must
			// not treat `content` as evidence when ok === false.
			assert.match(read.content ?? "", /all gates green/);
		}
	} finally {
		await removeDirWithRetry(root);
	}
});

test("M3-27/R44-N3: missing / unreadable / unpinned descriptors fail closed with distinct reasons", async () => {
	const root = fs.mkdtempSync(path.join(realTmp, "pi-crew-art-verify-miss-"));
	try {
		const desc = writeArtifact(root, { kind: "log", relativePath: "gone.md", content: "x", producer: "t" });
		fs.rmSync(desc.path, { force: true });
		const missing = readVerifiedArtifact(desc);
		assert.equal(missing.ok, false);
		if (!missing.ok) assert.equal(missing.reason, "missing");

		// No pinned hash: trusted by default (legacy descriptors), refused when the
		// caller demands integrity.
		const dir = path.join(root, "legacy.md");
		fs.writeFileSync(dir, "legacy body");
		const legacy = { path: dir } as { path: string; contentHash?: string };
		assert.equal(readVerifiedArtifact(legacy).ok, true);
		const strict = readVerifiedArtifact(legacy, { requirePinnedHash: true });
		assert.equal(strict.ok, false);
		if (!strict.ok) assert.equal(strict.reason, "no-pinned-hash");
	} finally {
		await removeDirWithRetry(root);
	}
});

test("M3-27/R44-N3: artifactsRoot containment refuses an out-of-root path (R44-N1 sibling guard)", async () => {
	const root = fs.mkdtempSync(path.join(realTmp, "pi-crew-art-verify-root-"));
	const outside = path.join(realTmp, `pi-crew-art-outside-${Date.now()}.md`);
	try {
		fs.writeFileSync(outside, "outside the artifacts root");
		const read = readVerifiedArtifact({ path: outside }, { artifactsRoot: root });
		assert.equal(read.ok, false);
		if (!read.ok) assert.equal(read.reason, "outside-artifacts-root");
	} finally {
		fs.rmSync(outside, { force: true });
		await removeDirWithRetry(root);
	}
});
