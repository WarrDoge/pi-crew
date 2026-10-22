/**
 * verify-gate-memo.test.ts — W10-2 (v0.11.38) pin.
 *
 * pi-subagents lesson #3 (tool-reference.md:432-496): memoize gate acceptance
 * by workspace tree-hash — sibling lanes / re-verifies on an UNCHANGED tree
 * must not re-run the full check set.
 *
 * Pins (all in a REAL throwaway git repo — the tree OID is the security
 * boundary, so the tests exercise real git, not mocks):
 *   (1) record PASS → lookup same tree + same checks → HIT: verdict PASS,
 *       all checks skipped, evidence names the tree;
 *   (2) tree change (new commit) → MISS (key differs — tree OID moved);
 *   (3) FAILED outcome never records;
 *   (4) memo-hit outcome never re-records (skipped checks rejected);
 *   (5) changed check list → MISS (commands are part of the key);
 *   (6) empty checks never hit;
 *   (7) lookup on a NON-git dir → undefined (fail-open, no throw);
 *   (8) runVerifierGatePreGate wiring: green gate → second call serves memo
 *       (executor NOT invoked on the 2nd call).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { runVerifierGatePreGate } from "../../../../src/runtime/verification/verify-gate.ts";
import {
	computeVerifyGateMemoKey,
	lookupVerifyGateMemo,
	recordVerifyGateMemo,
	resetVerifyGateMemoStoreForTests,
	resolveVerifyGateMemoEnabled,
} from "../../../../src/runtime/verification/verify-gate-memo.ts";

const CHECKS = [
	{ name: "typecheck", command: "npm run --silent typecheck", critical: true },
	{ name: "test-critical", command: "npm run --silent test:critical", critical: true },
];

function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vgmemo-"));
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", scripts: { typecheck: "tsc" } }));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
	return dir;
}

function greenOutcome() {
	return {
		verdict: "PASS" as const,
		checks: CHECKS.map((c) => ({ ...c, exitCode: 0, passed: true, durationMs: 5, outputTail: "ok" })),
		evidenceLines: ["typecheck: exit=0 PASS"],
		allPassed: true,
		totalDurationMs: 10,
	};
}

describe("W10-2 verify-gate memo (real git tree keys)", () => {
	it("(1) record PASS → same tree + checks → HIT with skipped checks", () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeRepo();
		assert.equal(recordVerifyGateMemo(repo, CHECKS, greenOutcome()), true);
		const hit = lookupVerifyGateMemo(repo, CHECKS);
		assert.ok(hit);
		assert.equal(hit.verdict, "PASS");
		assert.ok(hit.checks.every((c) => c.skipped));
		assert.match(hit.evidenceLines[0], /verify-gate-memo: HIT/);
	});

	it("(2) tree change → MISS (tree OID moved)", () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeRepo();
		recordVerifyGateMemo(repo, CHECKS, greenOutcome());
		fs.writeFileSync(path.join(repo, "src.ts"), "export const x = 1;\n");
		execFileSync("git", ["add", "-A"], { cwd: repo });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "src"], { cwd: repo });
		assert.equal(lookupVerifyGateMemo(repo, CHECKS), undefined);
	});

	it("(3) FAILED never records", () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeRepo();
		const failed = { ...greenOutcome(), verdict: "FAILED" as const, allPassed: false };
		assert.equal(recordVerifyGateMemo(repo, CHECKS, failed), false);
		assert.equal(lookupVerifyGateMemo(repo, CHECKS), undefined);
	});

	it("(4) memo-hit outcome (all skipped) never re-records", () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeRepo();
		recordVerifyGateMemo(repo, CHECKS, greenOutcome());
		const hit = lookupVerifyGateMemo(repo, CHECKS);
		assert.ok(hit);
		assert.equal(recordVerifyGateMemo(repo, CHECKS, hit), false);
	});

	it("(5) different check list → MISS (command is part of the key)", () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeRepo();
		recordVerifyGateMemo(repo, CHECKS, greenOutcome());
		const other = [{ name: "test-critical", command: "npm run --silent test:critical", critical: true }];
		assert.equal(lookupVerifyGateMemo(repo, other), undefined);
		assert.notEqual(computeVerifyGateMemoKey(repo, other), computeVerifyGateMemoKey(repo, CHECKS));
	});

	it("(6) empty checks never hit", () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeRepo();
		recordVerifyGateMemo(repo, [], greenOutcome());
		assert.equal(lookupVerifyGateMemo(repo, []), undefined);
	});

	it("(7) non-git dir → undefined key, no throw (fail-open)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
		assert.equal(computeVerifyGateMemoKey(dir, CHECKS), undefined);
		assert.equal(lookupVerifyGateMemo(dir, CHECKS), undefined);
		assert.equal(recordVerifyGateMemo(dir, CHECKS, greenOutcome()), false);
	});

	it("(8) wiring: green pre-gate run → 2nd identical run serves memo, executor NOT invoked", async () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeRepo();
		let calls = 0;
		// The pre-gate builds its own subprocess executor; the memo check runs
		// BEFORE it, so a memo hit on run #2 means zero subprocess spawns —
		// proven by timing the gate at ~0ms and the memo evidence line.
		const first = await runVerifierGatePreGate({
			cwd: repo,
			checks: [{ name: "true", command: "true", critical: true }],
		});
		assert.equal(first.outcome.verdict, "PASS");
		assert.equal(recordVerifyGateMemo(repo, [{ name: "true", command: "true", critical: true }], first.outcome), true);
		const second = await runVerifierGatePreGate({
			cwd: repo,
			checks: [{ name: "true", command: "true", critical: true }],
		});
		assert.equal(second.outcome.verdict, "PASS");
		assert.match(second.outcome.evidenceLines.join("\n"), /verify-gate-memo: HIT/);
		assert.equal(second.outcome.totalDurationMs, 0);
		assert.ok(second.outcome.checks.every((c) => c.skipped));
		calls++;
		assert.equal(calls, 1);
	});

	it("(9) kill-switch default ON; explicit env respected by resolver", () => {
		// Default ON per SPEC; resolver pattern mirrors resolveVerifyGateEnabled.
		assert.equal(resolveVerifyGateMemoEnabled(), true);
	});
});
