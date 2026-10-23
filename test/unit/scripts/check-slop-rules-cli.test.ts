/**
 * check-slop-rules-cli.test.ts — CLI e2e pin (W10-4 batch A).
 *
 * The unit pin (check-slop-rules.test.ts) imports scanSource as a module —
 * main() is argv-guarded, so the module import exercises none of the CLI.
 * This file drives the REAL CLI end-to-end: spawn `node
 * scripts/check-slop-rules.mjs` as a child process in the actual repo and
 * assert it exits 0, reports itself clean, and scanned a non-zero number of
 * files. The ratchet line (baseline burn-down status) shares the same exit,
 * so this also pins that the ratchet keeps the gate green on the current
 * tree.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

const CLEAN_LINE = /check-slop-rules: clean \((\d+) files scanned/;

describe("check-slop-rules CLI e2e (real repo)", () => {
	it("spawns the real CLI: exit 0, reports clean, scanned >0 files", { timeout: 65_000 }, async () => {
		// execFileAsync REJECTS on any non-zero exit, so resolving is the
		// exit-0 assertion; the 60s kill is the harness-level ceiling.
		const { stdout } = await execFileAsync("node", ["scripts/check-slop-rules.mjs"], {
			cwd: REPO_ROOT,
			timeout: 60_000,
			maxBuffer: 16 * 1024 * 1024, // 1744-file warn list is ~100KB today
		});
		const match = CLEAN_LINE.exec(stdout);
		assert.ok(match, `stdout must contain the clean summary line, got tail: ${stdout.slice(-400)}`);
		const scanned = Number(match[1]);
		assert.ok(Number.isFinite(scanned) && scanned > 0, `files scanned must be > 0, got ${scanned}`);
		// Ratchet status rides the same exit code — green line must be there.
		assert.match(stdout, /no-double-cast baseline \d+, current \d+ \(burn-down ok\)/);
	});
});
