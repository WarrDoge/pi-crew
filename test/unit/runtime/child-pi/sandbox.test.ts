/**
 * sandbox.test.ts — v0.11.36 OS-boundary (bubblewrap) pins.
 *
 * Layers:
 *   (a) CONFIG: default off; 'bwrap' on; unsupported value / net value
 *       throws FAIL-CLOSED; net=off + active broker throws.
 *   (b) AVAILABILITY: non-Linux throws; missing bwrap binary throws
 *       (fail-closed — never silently unsandboxed); healthy probe passes.
 *   (c) ARGV (pure): --unshare-all; --share-net iff net=share; mount
 *       ORDER (tmpfs /tmp precedes binds under /tmp); rw cwd; ro handed-in
 *       paths; rw broker socket; --chdir; '--' then the wrapped spec tail
 *       verbatim; HOME/TMPDIR overrides.
 *   (d) REAL bwrap smoke (linux + bwrap present only): host ~/.pi is NOT
 *       visible inside; cwd writes work; net=off cannot reach loopback.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	applySandboxToSpawnSpec,
	assertSandboxAvailable,
	resolveSandboxConfig,
	SANDBOX_ENV,
	SANDBOX_NET_ENV,
} from "../../../../src/runtime/child-pi/sandbox.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

// ── (a) CONFIG ──────────────────────────────────────────────────────────

test("(a1) sandbox default off; '0' off; 'bwrap' on with default share-net", () => {
	const base = { platform: "linux" as NodeJS.Platform, brokerActive: false };
	assert.deepEqual(resolveSandboxConfig({}, base), { enabled: false, mode: "off", net: "share" });
	assert.deepEqual(resolveSandboxConfig({ [SANDBOX_ENV]: "0" }, base), { enabled: false, mode: "off", net: "share" });
	assert.deepEqual(resolveSandboxConfig({ [SANDBOX_ENV]: "bwrap" }, base), { enabled: true, mode: "bwrap", net: "share" });
	assert.deepEqual(resolveSandboxConfig({ [SANDBOX_ENV]: "bwrap", [SANDBOX_NET_ENV]: "off" }, base), {
		enabled: true,
		mode: "bwrap",
		net: "off",
	});
});

test("(a2) unsupported sandbox/net values throw FAIL-CLOSED (never silently unsandboxed)", () => {
	const base = { platform: "linux" as NodeJS.Platform, brokerActive: false };
	assert.throws(() => resolveSandboxConfig({ [SANDBOX_ENV]: "docker" }, base), /unsupported value 'docker'/);
	assert.throws(() => resolveSandboxConfig({ [SANDBOX_ENV]: "1" }, base), /unsupported value '1'/);
	assert.throws(() => resolveSandboxConfig({ [SANDBOX_ENV]: "bwrap", [SANDBOX_NET_ENV]: "vpn" }, base), /unsupported value 'vpn'/);
});

test("(a3) net=off + active inference broker is rejected (broker-token workers would be keyless AND netless)", () => {
	assert.throws(
		() => resolveSandboxConfig({ [SANDBOX_ENV]: "bwrap", [SANDBOX_NET_ENV]: "off" }, { platform: "linux", brokerActive: true }),
		/no loopback route/,
	);
	assert.deepEqual(
		resolveSandboxConfig({ [SANDBOX_ENV]: "bwrap", [SANDBOX_NET_ENV]: "off" }, { platform: "linux", brokerActive: false }),
		{ enabled: true, mode: "bwrap", net: "off" },
	);
});

// ── (b) AVAILABILITY (fail-closed) ─────────────────────────────────────

const okProbe = {
	platform: "linux" as NodeJS.Platform,
	spawnSync: () => ({ status: 0, stdout: "bubblewrap 0.9.0", stderr: "", pid: 1, output: [], signal: null, error: undefined }),
};

test("(b1) non-Linux throws; missing bwrap throws; healthy probe passes; disabled config is a no-op", () => {
	const enabled = resolveSandboxConfig({ [SANDBOX_ENV]: "bwrap" }, { platform: "linux", brokerActive: false });
	assert.throws(() => assertSandboxAvailable(enabled, { ...okProbe, platform: "darwin" }), /Linux-only/);
	assert.throws(
		() =>
			assertSandboxAvailable(enabled, {
				platform: "linux",
				spawnSync: () => ({ status: null, stdout: "", stderr: "", pid: -1, output: [], signal: null, error: new Error("ENOENT") }),
			}),
		/requires the 'bwrap' binary/,
	);
	assert.throws(
		() =>
			assertSandboxAvailable(enabled, {
				platform: "linux",
				spawnSync: () => ({ status: 127, stdout: "", stderr: "not found", pid: -1, output: [], signal: null, error: undefined }),
			}),
		/requires the 'bwrap' binary/,
	);
	assert.doesNotThrow(() => assertSandboxAvailable(enabled, okProbe));
	assert.doesNotThrow(() => assertSandboxAvailable({ enabled: false, mode: "off", net: "share" }, { ...okProbe, platform: "win32" }));
});

// ── (c) ARGV (pure) ─────────────────────────────────────────────────────

test("(c1) argv shape: unshare-all, share-net iff net=share, ro OS runtime, tmpfs, rw cwd, chdir, '--' + spec tail verbatim", () => {
	const wrapped = applySandboxToSpawnSpec({ command: "/usr/bin/node", args: ["-p", "1"] }, { cwd: "/proj", net: "share" });
	assert.equal(wrapped.command, "bwrap");
	assert.equal(wrapped.args[0], "--unshare-all");
	assert.ok(wrapped.args.includes("--share-net"), "net=share must re-share host networking");
	assert.ok(wrapped.args.includes("--proc"), "procfs mounted");
	assert.ok(wrapped.args.includes("--dev"), "devfs mounted");
	const bindCwd = wrapped.args.indexOf("--bind");
	assert.equal(wrapped.args[bindCwd + 1], "/proj", "cwd mounted read-write at its real path");
	const chdir = wrapped.args.indexOf("--chdir");
	assert.equal(wrapped.args[chdir + 1], "/proj");
	const sep = wrapped.args.indexOf("--");
	assert.deepEqual(wrapped.args.slice(sep + 1), ["/usr/bin/node", "-p", "1"], "wrapped spec tail verbatim after '--'");
	assert.deepEqual(wrapped.envOverrides, { HOME: "/tmp", TMPDIR: "/tmp" }, "HOME/TMPDIR point at the sandbox tmpfs");

	const netless = applySandboxToSpawnSpec({ command: "x", args: [] }, { cwd: "/proj", net: "off" });
	assert.ok(!netless.args.includes("--share-net"), "net=off must NOT re-share networking");
	assert.ok(netless.args.includes("--unshare-all"));
});

test("(c2) mount ORDER: --tmpfs /tmp precedes any bind under /tmp (scoped agent dir, scratch paths)", () => {
	const wrapped = applySandboxToSpawnSpec(
		{ command: "x", args: [] },
		{
			cwd: "/proj",
			net: "share",
			agentDir: "/tmp/pi-crew-inference-abc",
			roBindPaths: ["/tmp/taskdir", "/tmp/scratch.snapshot.json"],
			rwBindPaths: ["/tmp/crew.sock"],
		},
	);
	const tmpfs = wrapped.args.indexOf("--tmpfs");
	assert.ok(tmpfs >= 0 && wrapped.args[tmpfs + 1] === "/tmp");
	// The flag IMMEDIATELY BEFORE a bound path names its mount kind.
	const flagBefore = (p: string): string => {
		const i = wrapped.args.indexOf(p);
		assert.ok(i > 0, `${p} must appear in argv`);
		return wrapped.args[i - 1];
	};
	for (const p of ["/tmp/pi-crew-inference-abc", "/tmp/taskdir", "/tmp/scratch.snapshot.json", "/tmp/crew.sock"]) {
		assert.ok(wrapped.args.indexOf(p) > tmpfs, `${p} must be bound AFTER the /tmp tmpfs (mounted over it at its real path)`);
	}
	// handed-in temp paths are READ-ONLY (worker consumes, never rewrites)...
	assert.equal(flagBefore("/tmp/taskdir"), "--ro-bind-try");
	assert.equal(flagBefore("/tmp/pi-crew-inference-abc"), "--bind", "agent dir is RW (pi writes session state under it)");
	// ...except the inter-pi broker socket: connect() needs write permission.
	assert.equal(flagBefore("/tmp/crew.sock"), "--bind-try");
});

// ── (d) REAL bwrap smoke (linux + bwrap only) ───────────────────────────

const bwrapProbe = process.platform === "linux" ? spawnSync("bwrap", ["--version"], { timeout: 5000 }) : null;
const haveBwrap = !!bwrapProbe && bwrapProbe.status === 0;

test("(d1) REAL bwrap: host home invisible, cwd writable, OS runtime readable", {
	skip: !haveBwrap && "linux+bwrap required",
}, async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-sbx-"));
	try {
		const wrapped = applySandboxToSpawnSpec(
			{
				command: process.execPath,
				args: ["-e", "require('fs').readFileSync(require('path').join(require('os').homedir(),'.pi','agent','auth.json'))"],
			},
			{ cwd, net: "share" },
		);
		const out = spawnSync(wrapped.command, [...wrapped.args], {
			timeout: 20_000,
			env: { ...process.env, ...wrapped.envOverrides },
			encoding: "utf8",
		});
		// The sandbox HOME is /tmp — ~/.pi must NOT exist inside. (A REAL
		// isolation assertion: the host file demonstrably exists.)
		assert.ok(fs.existsSync(path.join(os.homedir(), ".pi", "agent", "auth.json")), "host auth.json exists outside the sandbox");
		assert.notEqual(out.status, 0, "reading host ~/.pi/agent/auth.json inside the sandbox must FAIL");
		assert.match(out.stderr, /ENOENT/, "the failure is a missing mount (ENOENT), not a permission quirk");

		// cwd write works (the worker's whole job is editing the project).
		const w = spawnSync(
			wrapped.command,
			[
				...applySandboxToSpawnSpec(
					{ command: process.execPath, args: ["-e", `require('fs').writeFileSync('${cwd}/probe.txt','ok')`] },
					{ cwd, net: "share" },
				).args,
			],
			{ timeout: 20_000, env: { ...process.env, ...wrapped.envOverrides }, encoding: "utf8" },
		);
		assert.equal(w.status, 0, `cwd write inside sandbox: ${w.stderr}`);
		assert.equal(fs.readFileSync(path.join(cwd, "probe.txt"), "utf8"), "ok");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("(d2) REAL bwrap net=off: loopback is unreachable inside the namespace", { skip: !haveBwrap && "linux+bwrap required" }, async () => {
	// A listener on host loopback that the sandboxed child tries to reach.
	const server = http.createServer((_req, res) => {
		res.end("host");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-sbx-"));
	try {
		const wrapped = applySandboxToSpawnSpec(
			{
				command: process.execPath,
				args: ["-e", `fetch('http://127.0.0.1:${port}/').then(()=>process.exit(0)).catch(()=>process.exit(3))`],
			},
			{ cwd, net: "off" },
		);
		const out = spawnSync(wrapped.command, [...wrapped.args], {
			timeout: 20_000,
			env: { ...process.env, ...wrapped.envOverrides },
			encoding: "utf8",
		});
		assert.equal(out.status, 3, `net=off must make even loopback unreachable (stderr: ${out.stderr.slice(0, 200)})`);
	} finally {
		await removeDirWithRetry(cwd);
		server.close();
	}
});

test("(c3) extension/skill resources: value + ancestors bound up to the nearest package root", () => {
	const pkgRoots = new Set(["/pkg"]);
	const wrapped = applySandboxToSpawnSpec(
		{
			command: "/usr/bin/node",
			args: [
				"/pkg/node_modules/pi/dist/bundle/cli.js",
				"--extension",
				"/pkg/src/prompt/prompt-runtime.ts",
				"--skill",
				"/pkg/skills/real-test/SKILL.md",
				"-p",
				"x",
			],
		},
		{ cwd: "/work", net: "share", isPackageRoot: (d) => pkgRoots.has(d) },
	);
	// entry .js: dir + node_modules ancestors
	for (const p of ["/pkg/node_modules/pi/dist/bundle", "/pkg/node_modules"]) {
		assert.ok(wrapped.args.includes(p), `${p} mounted for the entry script`);
	}
	// extension: file + every ancestor up to (and including) /pkg
	for (const p of [
		"/pkg/src/prompt/prompt-runtime.ts",
		"/pkg/src/prompt",
		"/pkg/src",
		"/pkg",
		"/pkg/skills/real-test/SKILL.md",
		"/pkg/skills/real-test",
		"/pkg/skills",
	]) {
		assert.ok(wrapped.args.includes(p), `${p} mounted for extension/skill resolution`);
	}
	// everything toolchain is READ-ONLY
	for (let i = 0; i < wrapped.args.length; i++) {
		if (wrapped.args[i] === "--ro-bind-try" || wrapped.args[i] === "--ro-bind") {
			const target = wrapped.args[i + 2];
			assert.notEqual(target, "/work", "cwd is the ONLY read-write project mount");
		}
	}
});
