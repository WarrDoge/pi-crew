/**
 * typed-gate.test.ts — W10-9 (v0.11.38) pin.
 *
 * pi-subagents lesson #2 (tool-reference.md:432-496): a gate can require
 * TYPED output — `{command, output:"json", schema}` — where stdout must parse
 * as JSON AND match a minimal schema; invalid stdout fails even at exit 0,
 * and the verdict never memoizes (fresh structuredOutput every run).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { runVerifierGatePreGate, validateJsonLite } from "../../../../src/runtime/verification/verify-gate.ts";
import {
	lookupVerifyGateMemo,
	recordVerifyGateMemo,
	resetVerifyGateMemoStoreForTests,
} from "../../../../src/runtime/verification/verify-gate-memo.ts";

const SCHEMA = {
	type: "object",
	required: ["passed", "count"],
	properties: { passed: { type: "boolean" }, count: { type: "number" } },
};

function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w109-"));
	fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: dir });
	return dir;
}

const echo = (json: string) =>
	process.platform === "win32" ? `node -e "process.stdout.write(${JSON.stringify(json)})"` : `printf '%s' ${JSON.stringify(json)}`;

describe("W10-9 typed JSON gates", () => {
	it("(1) valid JSON + schema → PASS with structuredOutput", async () => {
		const repo = makeRepo();
		const res = await runVerifierGatePreGate({
			cwd: repo,
			checks: [{ name: "j", command: echo('{"passed":true,"count":3}'), critical: true, output: "json", schema: SCHEMA }],
		});
		assert.equal(res.outcome.verdict, "PASS");
		const check = res.outcome.checks[0];
		assert.deepEqual(check.structuredOutput, { passed: true, count: 3 });
	});

	it("(2) invalid JSON stdout → FAIL even at exit 0", async () => {
		const repo = makeRepo();
		const res = await runVerifierGatePreGate({
			cwd: repo,
			checks: [{ name: "j", command: echo("not json at all"), critical: true, output: "json", schema: SCHEMA }],
		});
		assert.equal(res.outcome.verdict, "FAILED");
		assert.match(res.outcome.checks[0].error ?? "", /not valid JSON/);
	});

	it("(3) schema mismatch → FAIL with the mismatch path", async () => {
		const repo = makeRepo();
		const res = await runVerifierGatePreGate({
			cwd: repo,
			checks: [{ name: "j", command: echo('{"passed":"yes","count":3}'), critical: true, output: "json", schema: SCHEMA }],
		});
		assert.equal(res.outcome.verdict, "FAILED");
		assert.match(res.outcome.checks[0].error ?? "", /schema mismatch/);
	});

	it("(4) missing required key → FAIL", async () => {
		const repo = makeRepo();
		const res = await runVerifierGatePreGate({
			cwd: repo,
			checks: [{ name: "j", command: echo('{"passed":true}'), critical: true, output: "json", schema: SCHEMA }],
		});
		assert.equal(res.outcome.verdict, "FAILED");
		assert.match(res.outcome.checks[0].error ?? "", /missing required "count"/);
	});

	it("(5) typed gates NEVER memoize — green typed run then lookup = miss", async () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeRepo();
		const checks = [{ name: "j", command: echo('{"passed":true,"count":1}'), critical: true, output: "json" as const, schema: SCHEMA }];
		const res = await runVerifierGatePreGate({ cwd: repo, checks });
		assert.equal(res.outcome.verdict, "PASS");
		assert.equal(recordVerifyGateMemo(repo, checks, res.outcome), false);
		assert.equal(lookupVerifyGateMemo(repo, checks), undefined);
	});

	it("(6) validateJsonLite subset: enum + array items", () => {
		assert.equal(validateJsonLite("a", { enum: ["a", "b"] }), undefined);
		assert.match(validateJsonLite("c", { enum: ["a", "b"] }) ?? "", /enum/);
		assert.equal(validateJsonLite([1, 2], { type: "array", items: { type: "number" } }), undefined);
		assert.match(validateJsonLite([1, "x"], { type: "array", items: { type: "number" } }) ?? "", /\[1\]/);
	});

	it("(7) W10-9 round-trip: deeply nested structuredOutput survives the JSON boundary (deepEqual identity)", async () => {
		// A structuredOutput consumer downstream reads the parsed value, so
		// nesting must round-trip the JSON.stringify/parse boundary intact —
		// objects-in-arrays-in-objects, not just a flat top level.
		const nested = { a: { b: [{ c: "x" }] } };
		const roundTripped = JSON.parse(JSON.stringify(nested));
		assert.deepEqual(roundTripped, nested); // pure boundary identity
		const repo = makeRepo();
		const res = await runVerifierGatePreGate({
			cwd: repo,
			checks: [
				{
					name: "deep",
					command: echo(JSON.stringify(nested)),
					critical: true,
					output: "json" as const,
					schema: { type: "object" },
				},
			],
		});
		assert.equal(res.outcome.verdict, "PASS");
		assert.deepEqual(res.outcome.checks[0].structuredOutput, roundTripped);
		assert.deepEqual(res.outcome.checks[0].structuredOutput, nested);
	});
});
