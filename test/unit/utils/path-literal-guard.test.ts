/**
 * Tests for the shared junk-literal path guard (isJunkPathLiteral) and its
 * three application sites (round3 audit, Wave A item 8):
 * - utils/paths.ts userPiRoot (F4 regression — now also catches "null")
 * - config.ts resolveHomeDir via configPath() (PI_TEAMS_HOME junk literal
 *   previously anchored config paths on a junk "undefined/.pi/…" tree)
 * - state/stores/state-store.ts createRunPaths (junk-literal cwd previously
 *   scoped runs under a relative "undefined/.pi/teams/state/runs/…" tree)
 *
 * Root cause: unset-variable shell expansion yields the LITERAL string
 * "undefined"/"null"; path.join happily builds relative junk trees from it
 * (the stray pi-crew/undefined/ dir was exactly this, deleted with this fix).
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { configPath } from "../../../src/config/config.ts";
import { createRunPaths } from "../../../src/state/stores/state-store.ts";
import { isJunkPathLiteral, userPiRoot } from "../../../src/utils/paths.ts";

/**
 * Set PI_TEAMS_HOME/PI_CREW_HOME around a body, restoring (or deleting) the
 * originals afterwards. Both are cleared first so ambient worker env (this
 * suite may run inside a pi-crew worker) cannot leak into the case.
 */
function withHomeEnv(values: { teams?: string; crew?: string }, body: () => void): void {
	const savedTeams = process.env.PI_TEAMS_HOME;
	const savedCrew = process.env.PI_CREW_HOME;
	delete process.env.PI_TEAMS_HOME;
	delete process.env.PI_CREW_HOME;
	try {
		if (values.teams !== undefined) process.env.PI_TEAMS_HOME = values.teams;
		if (values.crew !== undefined) process.env.PI_CREW_HOME = values.crew;
		body();
	} finally {
		if (savedTeams === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = savedTeams;
		if (savedCrew === undefined) delete process.env.PI_CREW_HOME;
		else process.env.PI_CREW_HOME = savedCrew;
	}
}

test("isJunkPathLiteral: junk literals are true, real paths are false", () => {
	assert.equal(isJunkPathLiteral(""), true);
	assert.equal(isJunkPathLiteral("undefined"), true);
	assert.equal(isJunkPathLiteral("null"), true);
	assert.equal(isJunkPathLiteral("  undefined  "), true, "input is trimmed");
	assert.equal(isJunkPathLiteral("   "), true, "whitespace-only is junk");
	assert.equal(isJunkPathLiteral(undefined), true);
	assert.equal(isJunkPathLiteral(null), true);
	// Legal values must pass through untouched.
	assert.equal(isJunkPathLiteral("/home/user"), false);
	assert.equal(isJunkPathLiteral("relative/dir"), false);
	assert.equal(isJunkPathLiteral("0"), false);
	assert.equal(isJunkPathLiteral("undefined-path"), false, "prefix, not the literal");
	assert.equal(isJunkPathLiteral("nullable"), false);
	assert.equal(isJunkPathLiteral("nullish/x"), false);
});

test("userPiRoot: literal 'undefined' PI_TEAMS_HOME falls back to real home (F4)", () => {
	withHomeEnv({ teams: "undefined" }, () => {
		const result = userPiRoot();
		assert.equal(result, path.join(os.homedir(), ".pi", "agent"));
	});
});

test("userPiRoot: literal 'null' PI_TEAMS_HOME falls back to real home (F4 extension)", () => {
	withHomeEnv({ teams: "null" }, () => {
		const result = userPiRoot();
		assert.equal(result, path.join(os.homedir(), ".pi", "agent"));
		assert.ok(!result.startsWith("null"), `must not produce a relative 'null/...' path, got: ${result}`);
	});
});

test("resolveHomeDir via configPath: literal 'undefined' PI_TEAMS_HOME → real home, not a junk tree", () => {
	withHomeEnv({ teams: "undefined" }, () => {
		const result = configPath();
		assert.equal(result, path.join(os.homedir(), ".pi", "agent", "pi-crew.json"));
	});
});

test("resolveHomeDir via configPath: literal 'null' PI_CREW_HOME (crew fallback of the mirror) → real home", () => {
	withHomeEnv({ crew: "null" }, () => {
		const result = configPath();
		assert.equal(result, path.join(os.homedir(), ".pi", "agent", "pi-crew.json"));
	});
});

test("resolveHomeDir via configPath: whitespace-padded junk literal is trimmed then rejected", () => {
	withHomeEnv({ teams: "  undefined  " }, () => {
		const result = configPath();
		assert.equal(result, path.join(os.homedir(), ".pi", "agent", "pi-crew.json"));
	});
});

test("createRunPaths: junk-literal cwd 'undefined' is rejected like invalid cwd", () => {
	assert.throws(() => createRunPaths("undefined"), /Invalid cwd: undefined/);
});

test("createRunPaths: junk-literal cwd 'null' is rejected like invalid cwd", () => {
	assert.throws(() => createRunPaths("null"), /Invalid cwd: null/);
});

test("createRunPaths: legal cwd keeps working and never anchors on a junk tree", () => {
	const paths = createRunPaths(os.tmpdir());
	assert.ok(!paths.stateRoot.startsWith("undefined"), `stateRoot must not be a relative junk tree, got: ${paths.stateRoot}`);
	assert.ok(!paths.stateRoot.includes("/undefined/"));
	assert.ok(paths.stateRoot.includes(paths.runId));
});
