import assert from "node:assert/strict";
import test from "node:test";
import { __test } from "../../../../src/runtime/process/zombie-scanner.ts";

/**
 * R7-A2 (audit round-7, wave-1): `isPidAlive` previously treated ANY
 * process.kill(pid, 0) error as "dead". That wrongly killed entries whose
 * pid lives in a different security context (EPERM) — the same class of bug
 * fixed in active-run-registry.ts (R7-15). Contract now mirrors that fix:
 * only ESRCH/ENOENT mean the process is gone; every other errno (EPERM,
 * EACCES, ...) means alive-but-protected → alive.
 */

function stubKill(code: string): (pid: number, signal?: number) => void {
	return (pid: number, _signal?: number) => {
		const err = new Error(`stubbed kill failure for pid ${pid}`) as NodeJS.ErrnoException;
		err.code = code;
		throw err;
	};
}

test("isPidAlive: EPERM from process.kill means alive (protected, not gone)", (t) => {
	t.mock.method(process, "kill", stubKill("EPERM"));
	assert.equal(__test.isPidAlive(4242), true);
});

test("isPidAlive: ESRCH from process.kill means dead", (t) => {
	t.mock.method(process, "kill", stubKill("ESRCH"));
	assert.equal(__test.isPidAlive(4242), false);
});

test("isPidAlive: ENOENT from process.kill means dead", (t) => {
	t.mock.method(process, "kill", stubKill("ENOENT"));
	assert.equal(__test.isPidAlive(4242), false);
});

test("isPidAlive: no error from process.kill means alive", (t) => {
	t.mock.method(process, "kill", () => {});
	assert.equal(__test.isPidAlive(4242), true);
});

test("isPidAlive: non-positive pid is dead without consulting process.kill", (t) => {
	let called = false;
	t.mock.method(process, "kill", () => {
		called = true;
	});
	assert.equal(__test.isPidAlive(0), false);
	assert.equal(__test.isPidAlive(-1), false);
	assert.equal(__test.isPidAlive(Number.NaN), false);
	assert.equal(called, false);
});
