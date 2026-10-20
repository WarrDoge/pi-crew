import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { logInternalError } from "../../utils/internal-error.ts";
import { redactSecretString, redactSecrets } from "../../utils/redaction.ts";
import { resolveRealContainedPath } from "../../utils/safe-paths.ts";
import { atomicWriteFile } from "../atomic-write.ts";
import type { ArtifactDescriptor } from "../types.ts";

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Public alias used by writeProgress's content-skip cache. */
export function hashArtifactContent(content: string): string {
	return hashContent(content);
}

export const CLEANUP_MARKER_FILE = ".last-cleanup";

export interface ArtifactWriteOptions {
	kind: ArtifactDescriptor["kind"];
	relativePath: string;
	content: string;
	producer: string;
	retention?: ArtifactDescriptor["retention"];
}

export interface ArtifactCleanupOptions {
	maxAgeDays: number;
	maxAgeMs?: number;
	markerFile?: string;
	scanGraceMs?: number;
}

function parseAgeDays(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.floor(value);
}

function nowMs(): number {
	return Date.now();
}

function readMarkerMtime(artifactsRoot: string, markerFile: string): number | undefined {
	try {
		return fs.statSync(path.join(artifactsRoot, markerFile)).mtimeMs;
	} catch {
		return undefined;
	}
}

function shouldCleanup(artifactsRoot: string, markerFile: string, scanGraceMs: number): boolean {
	const marker = readMarkerMtime(artifactsRoot, markerFile);
	if (marker === undefined) return true;
	return nowMs() - marker >= scanGraceMs;
}

export function writeCleanupMarker(artifactsRoot: string, markerFile: string): void {
	fs.mkdirSync(artifactsRoot, { recursive: true });
	atomicWriteFile(path.join(artifactsRoot, markerFile), String(nowMs()));
}

export function cleanupOldArtifacts(artifactsRoot: string, options: ArtifactCleanupOptions): void {
	if (!fs.existsSync(artifactsRoot)) return;
	const maxAgeDays = parseAgeDays(options.maxAgeDays);
	if (maxAgeDays === undefined) return;
	const markerFile = options.markerFile ?? CLEANUP_MARKER_FILE;
	const scanGraceMs = options.scanGraceMs ?? 24 * 60 * 60 * 1000;
	if (!shouldCleanup(artifactsRoot, markerFile, scanGraceMs)) return;
	const maxAgeMs = options.maxAgeMs ?? maxAgeDays * 24 * 60 * 60 * 1000;
	const cutoff = nowMs() - maxAgeMs;
	let didCleanup = false;
	try {
		// FIX: Use { withFileTypes: true } to get Dirent objects (with isDirectory/isFile
		// info), avoiding the need for a separate statSync per entry just to check the
		// type. We still need statSync for mtime, but only on entries that passed the
		// marker-file and symlink filters.
		const entries = fs.readdirSync(artifactsRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === markerFile) continue;
			if (entry.isSymbolicLink()) continue; // skip symlinks — could escape artifactsRoot
			const target = path.join(artifactsRoot, entry.name);
			try {
				const stat = fs.statSync(target);
				if (stat.mtimeMs >= cutoff) continue;
				// Use Dirent info instead of stat.isDirectory() to save a stat call
				if (entry.isDirectory()) {
					fs.rmSync(target, { recursive: true, force: true });
				} else {
					fs.unlinkSync(target);
				}
				didCleanup = true;
			} catch {
				// Ignore cleanup races and permission issues in best-effort mode.
			}
		}
		writeCleanupMarker(artifactsRoot, markerFile);
	} catch {
		// Ignore unreadable roots in best-effort mode.
	}
	if (!didCleanup) writeCleanupMarker(artifactsRoot, markerFile);
}

/**
 * ST-10: Default TTL for "temporary" retention artifacts (1 hour).
 * Temporary artifacts (progress, notepad) are short-lived and should not
 * accumulate. One hour balances cleanup aggressiveness with the possibility
 * that a long-running task writes periodic progress updates.
 */
export const TEMPORARY_RETENTION_TTL_MS = 60 * 60 * 1000;

/**
 * ST-10: Check whether an artifact descriptor indicates the file should be
 * pruned (expired).
 *
 * Enforces:
 * - `expiresAt`: if set and now ≥ expiresAt → expired.
 * - `retention: "temporary"`: if createdAt age ≥ temporaryTtlMs → expired.
 *   ("run" and "project" retentions are handled by run-level prune and the
 *   age-based {@link cleanupOldArtifacts}, not by this per-descriptor check.)
 */
export function isArtifactExpired(desc: ArtifactDescriptor, nowMs: number, temporaryTtlMs: number = TEMPORARY_RETENTION_TTL_MS): boolean {
	// Explicit expiresAt takes precedence.
	if (desc.expiresAt) {
		const expiryMs = Date.parse(desc.expiresAt);
		if (Number.isFinite(expiryMs) && nowMs >= expiryMs) return true;
	}
	// "temporary" retention has a short TTL.
	if (desc.retention === "temporary" && desc.createdAt) {
		const createdMs = Date.parse(desc.createdAt);
		if (Number.isFinite(createdMs) && nowMs - createdMs >= temporaryTtlMs) return true;
	}
	return false;
}

export interface PruneExpiredArtifactsOptions {
	now?: number;
	temporaryTtlMs?: number;
	/**
	 * R44-N1 containment anchor (REQUIRED): the run's HOST-DERIVED artifacts
	 * root (`<crewRoot>/artifacts/<runId>` — the same convention
	 * createRunPaths derives; never trust a manifest-declared root). A
	 * descriptor path is unlinked ONLY when its realpath resolves UNDER this
	 * anchor. Fail-closed: any realpath/containment failure skips + warns —
	 * never deletes. Blocks `..` traversal, absolute-outside paths, and
	 * symlink escapes (a manifest is worker-writable state).
	 */
	artifactsRoot: string;
}

/**
 * R44-N1: resolve a descriptor path for pruning under a containment anchor.
 * Returns the REAL (symlink-resolved) path when it is contained, or a reason
 * to skip: "enoent" (benign — already gone, silent), or "blocked" (warn).
 * Pure filesystem check — never deletes.
 */
function resolvePruneTarget(
	desc: ArtifactDescriptor,
	realAnchor: string,
): { realPath: string } | { skip: "enoent" | "blocked"; reason: string } {
	let realPath: string;
	try {
		realPath = fs.realpathSync(desc.path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { skip: "enoent", reason: `target gone: ${desc.path}` };
		return { skip: "blocked", reason: `realpath failed (${code ?? "unknown"}): ${desc.path}` };
	}
	const relative = path.relative(realAnchor, realPath);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		return { skip: "blocked", reason: `outside artifacts root ${realAnchor}: ${desc.path} (real: ${realPath})` };
	}
	return { realPath };
}

/**
 * ST-10: Prune expired artifacts by enforcing ArtifactDescriptor.retention/expiresAt.
 *
 * Deletes artifact files whose descriptor indicates expiry (expiresAt passed
 * or temporary-retention TTL exceeded). Returns the count of files deleted.
 *
 * Unlike {@link cleanupOldArtifacts} (which is filesystem age-based on raw
 * files), this operates on artifact *metadata* from the manifest's `artifacts[]`
 * and deletes specific expired files via their descriptor `path`.
 *
 * R44-N1 (fix-wave 6, live-proven HIGH): descriptor paths come from
 * WORKER-WRITABLE manifests, so every unlink is containment-checked against
 * the required host-derived `options.artifactsRoot` anchor — realpath both
 * sides, resolve-inside check (blocks `..`, absolute-outside, symlink
 * escape), fail-closed skip+warn on ANY failure (never delete what cannot be
 * verified). Unlinking the symlink-RESOLVED real path means a planted
 * symlink inside the anchor pointing at an outside victim is BLOCKED (its
 * realpath escapes the anchor) — the victim can never be reached.
 */
export function pruneExpiredArtifacts(descriptors: ArtifactDescriptor[], options: PruneExpiredArtifactsOptions): number {
	const nowMs = options.now ?? Date.now();
	const temporaryTtlMs = options.temporaryTtlMs ?? TEMPORARY_RETENTION_TTL_MS;
	// Anchor validation — fail-closed for the WHOLE batch when the anchor
	// itself is unusable (missing, a symlink, or unresolvable): a bad anchor
	// proves nothing, so nothing may be deleted.
	let realAnchor: string;
	try {
		const lstat = fs.lstatSync(options.artifactsRoot);
		if (lstat.isSymbolicLink()) throw new Error(`artifacts root is a symbolic link`);
		if (!lstat.isDirectory()) throw new Error(`artifacts root is not a directory`);
		realAnchor = fs.realpathSync(options.artifactsRoot);
	} catch (error) {
		// W7-C2 (2026-10-20): a MISSING anchor directory means the run's whole
		// artifacts tree is already gone (age-based cleanup, an earlier prune, or
		// operator removal) — there is nothing under it left to delete, so this is
		// success-shaped silence, not a failure. Fail-closed behavior is unchanged
		// (return 0, nothing deleted). Session start walks EVERY retained manifest,
		// so warning here printed one line per stale run per boot (battery
		// 2026-10-19 observation #4). Other anchor failures (symlink anchor,
		// non-directory, permissions) stay visible warns.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return 0;
		logInternalError(
			"artifact-store.prune-anchor",
			error instanceof Error ? error : new Error(String(error)),
			`artifactsRoot=${options.artifactsRoot} — skipping ${descriptors.length} descriptor(s), nothing deleted`,
			"warn",
		);
		return 0;
	}
	let deleted = 0;
	for (const desc of descriptors) {
		if (!isArtifactExpired(desc, nowMs, temporaryTtlMs)) continue;
		const target = resolvePruneTarget(desc, realAnchor);
		if ("skip" in target) {
			if (target.skip === "blocked") {
				// Containment violation / unverifiable path — visible warn, never delete.
				logInternalError("artifact-store.prune-contained", new Error(target.reason), `producer=${desc.producer}`, "warn");
			}
			// "enoent" stays silent — the file was already pruned (best-effort parity
			// with the pre-R44 behavior of swallowing missing-file unlinks).
			continue;
		}
		try {
			// Unlink the VERIFIED real path (not the raw descriptor string).
			fs.unlinkSync(target.realPath);
			deleted++;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") continue; // race: already gone
			logInternalError(
				"artifact-store.prune-unlink",
				error instanceof Error ? error : new Error(String(error)),
				`path=${target.realPath}`,
				"warn",
			);
		}
	}
	return deleted;
}

function resolveInside(baseDir: string, relativePath: string): string {
	// Check if baseDir is a symlink on every call to prevent symlink attacks
	try {
		if (fs.lstatSync(baseDir).isSymbolicLink()) throw new Error(`Artifacts root is a symbolic link — not allowed: ${baseDir}`);
	} catch (err) {
		// If lstatSync fails because baseDir doesn't exist yet, that's fine —
		// it will be created by writeArtifact. Any other error should propagate.
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	const normalizedRelativePath = relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
	if (
		!normalizedRelativePath ||
		normalizedRelativePath.split("/").some((segment) => segment === "..") ||
		path.isAbsolute(normalizedRelativePath)
	) {
		throw new Error(`Invalid artifact path: ${relativePath}`);
	}
	// Use resolveRealContainedPath to resolve symlinks before checking containment,
	// preventing TOCTOU attacks where intermediate directories are replaced with symlinks.
	return resolveRealContainedPath(baseDir, normalizedRelativePath);
}

export function writeArtifact(artifactsRoot: string, options: ArtifactWriteOptions): ArtifactDescriptor {
	// FIX: Create the artifactsRoot BEFORE calling resolveInside/resolveRealContainedPath,
	// which open() the path to validate symlinks (fails with ENOENT if not yet created).
	// Also reject symlinks in baseDir at this point (catches both pre-existing symlinks
	// and the case where baseDir was created by mkdirSync as a regular dir).
	fs.mkdirSync(artifactsRoot, { recursive: true });
	if (fs.lstatSync(artifactsRoot).isSymbolicLink()) {
		throw new Error(`Artifacts root is a symbolic link — not allowed: ${artifactsRoot}`);
	}
	const filePath = resolveInside(artifactsRoot, options.relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	resolveRealContainedPath(artifactsRoot, path.dirname(filePath));
	let content = options.content;
	// Structural JSON redaction first — catches quoted-JSON secrets
	// ("api_key":"sk-...") and nested keys that flat redactSecretString misses.
	// The flat scan below still catches free-text patterns (Bearer/JWT/Auth
	// headers) that may live inside JSON string values. See security review M2.
	//
	// Formatting preservation: re-stringify with the SAME indentation as the
	// input so pretty-printed artifacts (e.g. group-join metadata expected by
	// test/integration/phase4-runtime.test.ts to contain `"partial": false`)
	// keep their whitespace. Detect pretty-vs-compact from the raw input.
	const trimmed = content.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(content);
			const isPretty = /\n|"\s*:\s/.test(content);
			content = JSON.stringify(redactSecrets(parsed), null, isPretty ? 2 : undefined);
		} catch {
			// not valid JSON — fall through to flat redaction only
		}
	}
	content = redactSecretString(content);
	atomicWriteFile(filePath, content);
	// STATE-9: compute the hash on the in-memory content (post-redaction) instead of
	// reading the file back. atomicWriteFile writes the exact content atomically, so
	// the read-back was only ever "defense" for a concurrent-write case that cannot
	// occur — the file is replaced via atomic rename, never partially written.
	const contentHash = hashContent(content);
	const stats = fs.statSync(filePath);
	return {
		kind: options.kind,
		path: filePath,
		createdAt: new Date().toISOString(),
		producer: options.producer,
		sizeBytes: stats.size,
		contentHash,
		retention: options.retention ?? "run",
	};
}

// ── Read-side integrity (M3-27 / R44-N3) ────────────────────────────────────
//
// Round 44 (probe r50b-s3/n3): `contentHash` was stamped at WRITE time and then
// consumed for display (`inspect.ts`), as a cache key (`task-output-context.ts`)
// and for the write-skip compare (`finalize-run.ts`) — but NEVER verified on a
// read. A worker (or anything else with same-uid write access) could rewrite
// `artifacts/<run>/results/<task>.md` between the write and the leader's read
// and the tampered body was served with `hash-mismatch-but-still-served: true`.
//
// `readVerifiedArtifact` is that missing read path: it re-hashes the bytes on
// disk and compares them to the descriptor's pinned `contentHash`. The result is
// a discriminated union so callers must decide what a mismatch means (refuse the
// evidence, flag it, or re-read) instead of silently consuming bytes.

/** Why a verified read did not return trusted content. */
export type ArtifactVerifyFailure = "missing" | "unreadable" | "hash-mismatch" | "no-pinned-hash" | "outside-artifacts-root";

export type ArtifactReadResult =
	| {
			ok: true;
			content: string;
			/** sha256 of the bytes just read (always matches `contentHash`). */
			contentHash: string;
	  }
	| {
			ok: false;
			reason: ArtifactVerifyFailure;
			/** Bytes as read (absent when the file could not be read at all) —
			 *  surfaced for diagnostics only; never treat as trusted evidence. */
			content?: string;
			/** sha256 of the bytes on disk, when they were read. */
			actualHash?: string;
			/** The descriptor's pinned hash, when it had one. */
			expectedHash?: string;
	  };

export interface ArtifactVerifyOptions {
	/** When supplied, the artifact path must resolve INSIDE this root
	 *  (realpath-contained, mirrors the R44-N1 prune containment). */
	artifactsRoot?: string;
	/** Require a pinned `contentHash` on the descriptor. Default false: a
	 *  descriptor written before hashes existed returns
	 *  `{ ok: false, reason: "no-pinned-hash" }` so a caller that NEEDS
	 *  integrity can fail closed without guessing. */
	requirePinnedHash?: boolean;
}

/**
 * R44-N3 read-side verification: read an artifact and verify its pinned sha256.
 *
 * Never throws (a missing/unreadable file is a `{ ok: false }` result — this is
 * called from evidence paths that must degrade, not crash).
 */
export function readVerifiedArtifact(
	descriptor: Pick<ArtifactDescriptor, "path" | "contentHash">,
	options: ArtifactVerifyOptions = {},
): ArtifactReadResult {
	if (options.artifactsRoot !== undefined) {
		try {
			resolveRealContainedPath(path.resolve(options.artifactsRoot), descriptor.path);
		} catch {
			return {
				ok: false,
				reason: "outside-artifacts-root",
				...(descriptor.contentHash ? { expectedHash: descriptor.contentHash } : {}),
			};
		}
	}
	let content: string;
	try {
		content = fs.readFileSync(descriptor.path, "utf-8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return {
			ok: false,
			reason: code === "ENOENT" ? "missing" : "unreadable",
			...(descriptor.contentHash ? { expectedHash: descriptor.contentHash } : {}),
		};
	}
	const actualHash = hashContent(content);
	const expectedHash = descriptor.contentHash;
	if (expectedHash === undefined) {
		if (options.requirePinnedHash === true) return { ok: false, reason: "no-pinned-hash", content, actualHash };
		return { ok: true, content, contentHash: actualHash };
	}
	if (actualHash !== expectedHash) return { ok: false, reason: "hash-mismatch", content, actualHash, expectedHash };
	return { ok: true, content, contentHash: actualHash };
}
