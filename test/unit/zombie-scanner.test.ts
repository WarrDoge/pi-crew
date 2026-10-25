/**
 * Tests for the pi-crew sub-agent process-identity marker + zombie scanner.
 *
 * Lesson context: an earlier heuristic-based zombie "cleanup" killed a live
 * main `pi` session by accident. The fix is an AUTHORITATIVE marker —
 * `--crew-subagent` (argv) + `PI_CREW_KIND=subagent` (env) — set on every
 * child-pi spawn. The user's main session never carries the marker, so it
 * can never be matched by zombie detection.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import { buildPiWorkerArgs } from "../../src/runtime/model/pi-args.ts";
import {
	__test,
	type ForeignPiProcess,
	formatZombieReport,
	scanZombieSubagents,
	type ZombieScanOptions,
	type ZombieSubagent,
} from "../../src/runtime/process/zombie-scanner.ts";

function fakeAgent(): AgentConfig {
	return {
		name: "executor",
		description: "test",
		source: "builtin",
		filePath: "<test>",
		systemPrompt: "You are a test agent.",
		tools: [],
		inheritProjectContext: false,
		inheritSkills: false,
	};
}

test("buildPiWorkerArgs: does NOT add an unknown argv flag (pi rejects unknown options)", () => {
	const { args } = buildPiWorkerArgs({
		task: "do thing",
		agent: fakeAgent(),
	});
	// Regression guard: an earlier fix tried to prepend `--crew-subagent`, but pi's
	// strict option parser exits non-zero on unknown flags, breaking every agent call.
	assert.ok(!args.includes("--crew-subagent"), "must not add argv flags pi does not recognize");
	assert.equal(args[0], "--mode", "argv starts with the standard --mode flag");
});

test("buildPiWorkerArgs: sets PI_CREW_KIND=subagent in the child env (authoritative marker)", () => {
	// NOTE: we deliberately do NOT add an argv flag. Pi rejects unknown flags
	// (Error: Unknown option) and exits non-zero, which would break every
	// ctx.agent() call. The ENV var is the sole authoritative signal; the
	// zombie scanner reads it from /proc/<pid>/environ.
	const { env } = buildPiWorkerArgs({ task: "do thing", agent: fakeAgent() });
	assert.equal(env.PI_CREW_KIND, "subagent", "PI_CREW_KIND=subagent is the authoritative machine marker");
});

test("buildPiWorkerArgs: a MAIN session env never has PI_CREW_KIND (sanity check)", () => {
	// This is the inverse guarantee: the marker is ONLY added by buildPiWorkerArgs.
	// The parent process (this test) is a main-session equivalent — it must NOT
	// carry the marker, otherwise doctor --zombies could match it.
	assert.notEqual(process.env.PI_CREW_KIND, "subagent", "main session must not self-identify as subagent");
});

test("scanZombieSubagents: returns a well-formed result object", () => {
	const scan = scanZombieSubagents();
	// Shape contract — never throws, always returns {zombies, live, errors}.
	assert.ok(Array.isArray(scan.zombies));
	assert.ok(Array.isArray(scan.live));
	assert.ok(Array.isArray(scan.errors));
});

test("scanZombieSubagents: never lists a main session (no PI_CREW_KIND marker)", () => {
	// The current process is NOT a pi-crew sub-agent (no PI_CREW_KIND=subagent),
	// so it must NEVER appear in zombies OR live — even though it IS a node/pi
	// process. This is the regression test for the accidental-kill incident.
	const scan = scanZombieSubagents();
	const myPid = process.pid;
	const matched = [...scan.zombies, ...scan.live].filter((z) => z.pid === myPid);
	assert.equal(matched.length, 0, "main session must never be matched as a sub-agent");
});

test("scanZombieSubagents: every matched entry carries PI_CREW_KIND=subagent by construction", () => {
	// Defense in depth: even if some other process slips in, the scanner only
	// emits entries that originated from a process with PI_CREW_KIND=subagent.
	// (We can't easily forge a /proc entry in a unit test, but we can assert
	// the scanner's contract: zombies/live arrays only contain ZombieSubagent
	// objects with numeric pid + crewParentPid fields.)
	const scan = scanZombieSubagents();
	for (const z of [...scan.zombies, ...scan.live]) {
		assert.equal(typeof z.pid, "number");
		assert.equal(typeof z.crewParentPid, "number");
		assert.equal(typeof z.parentAlive, "boolean");
	}
});

test("formatZombieReport: render is human-readable and states read-only safety", () => {
	const scan = scanZombieSubagents();
	const text = formatZombieReport(scan);
	assert.match(text, /read-only/i, "report must clearly state it does not kill");
	assert.match(text, /PI_CREW_KIND=subagent/i, "report must explain the authoritative marker");
	// No zombie or live entry should leak a raw suggestion to kill live parents.
	if (scan.live.length > 0) {
		assert.match(text, /NOT zombies/i, "live entries must be marked do-not-kill");
	}
});

test("formatZombieReport: empty scan renders a clean 'nothing found' message", () => {
	const text = formatZombieReport({ zombies: [], live: [], foreign: [], errors: [] });
	assert.match(text, /No pi-crew sub-agent processes found/i);
});

// ── T12: surface worker fields (PI_CREW_SURFACE / PI_CREW_SURFACE_PANE) ──────
// Surface workers carry their mux identity in env; doctor (T12) reads the pane
// id off the scan result to close orphan panes. The scan MUST NOT rely on a
// heartbeat — surface mode has none (T9 handoff): env markers are the only signal.

/** Bounded poll until /proc/<pid>/environ reflects the post-exec env. */
async function waitForSubagentMarker(pid: number | undefined, timeoutMs = 5000): Promise<void> {
	if (pid === undefined) return;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (__test.readProcEnviron(pid).PI_CREW_KIND === "subagent") return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

// ── Wave-14 F4: ZombieScanOptions seam — synthetic /proc fixtures ──────────
// The seam lets the classification tests below run on EVERY OS: they no
// longer spawn real processes / read the real /proc (which forced
// `skip: process.platform !== "linux"` forever on macOS/Windows CI).
// Real-/proc default-path coverage stays pinned by the linux-gated
// "default opts" tests (spec §4 z1) — seam defaults must not drift.

/** Synthetic pids above Linux's max pid_max (2^22 = 4194304) — can never
 *  collide with a real process (including this test process / its parent). */
const SYNTH_PID_BASE = 5_000_000;

interface SynthProc {
	environ?: Record<string, string>;
	ppid?: number;
	starttime?: number;
	cmdline?: string[];
	rssKb?: number;
	uid?: number;
}

interface SynthScanExtras {
	alive?: number[];
	uptime?: string;
	parentPid?: number;
	platform?: NodeJS.Platform;
	getuid?: () => number | undefined;
}

/** Encode a synthetic /proc table into ZombieScanOptions. */
function syntheticScanOpts(procs: Record<number, SynthProc>, extra: SynthScanExtras = {}): ZombieScanOptions {
	const uptime = extra.uptime ?? "2000000.00"; // default starttime 199999000 ticks → elapsed 10s
	const readProcFile = (p: string): string | undefined => {
		if (p === "/proc/uptime") return uptime;
		const m = /^\/proc\/(\d+)\/(environ|stat|cmdline|status)$/.exec(p);
		if (!m) return undefined;
		const proc = procs[Number(m[1])];
		if (!proc) return undefined;
		switch (m[2]) {
			case "environ":
				return proc.environ === undefined
					? ""
					: Object.entries(proc.environ)
							.map(([k, v]) => `${k}=${v}`)
							.join("\0");
			case "stat": {
				// After the paren-aware comm cut: rest[1] = ppid (field 4),
				// rest[19] = starttime (field 22) — pad the fields between.
				const rest = ["S", String(proc.ppid ?? 1), ...Array<string>(17).fill("0"), String(proc.starttime ?? 199999000)];
				return `${m[1]} (pi-crew-synth) ${rest.join(" ")}`;
			}
			case "cmdline":
				return (proc.cmdline ?? ["pi", "--mode", "json"]).join("\0");
			case "status":
				return `Name:\tpi\nUid:\t${proc.uid ?? 1000}\t1000\t1000\t1000\nVmRSS:\t${proc.rssKb ?? 4096} kB`;
		}
		return undefined;
	};
	const alive = new Set(extra.alive ?? []);
	return {
		platform: extra.platform ?? "linux",
		getuid: extra.getuid ?? (() => 1000),
		readProcFile,
		listProcPids: () => Object.keys(procs).map(Number),
		pidAlive: (pid) => alive.has(pid),
		getParentPid: () => extra.parentPid ?? 1,
	};
}

test("scanZombieSubagents (synthetic): surface worker exposes surface + surfacePaneId from /proc environ", () => {
	const zombiePid = SYNTH_PID_BASE + 1;
	const deadParent = SYNTH_PID_BASE + 99; // NOT in `alive` → parent dead
	const scan = scanZombieSubagents(
		syntheticScanOpts({
			[zombiePid]: {
				environ: {
					PI_CREW_KIND: "subagent",
					PI_CREW_PARENT_PID: String(deadParent),
					PI_CREW_ROLE: "executor",
					PI_CREW_SURFACE: "tmux",
					PI_CREW_SURFACE_PANE: "%12",
				},
			},
		}),
	);
	assert.equal(scan.zombies.length, 1, "dead-parent crew worker lands in zombies");
	const entry = scan.zombies[0]!;
	assert.equal(entry.pid, zombiePid);
	assert.equal(entry.parentAlive, false);
	assert.equal(entry.surface, "tmux", "PI_CREW_SURFACE=tmux must surface as entry.surface");
	assert.equal(entry.surfacePaneId, "%12", "PI_CREW_SURFACE_PANE must surface as entry.surfacePaneId");
	assert.equal(entry.role, "executor");
	// M-7 fields derived from the synthetic stat + uptime (199999000 ticks / 100).
	assert.equal(entry.elapsedSec, 10);
	assert.equal(entry.starttime, 199999000);
	assert.ok(entry.startedAt, "startedAt derived from synthetic uptime");
	assert.equal(entry.rssKb, 4096);
});

test("scanZombieSubagents (synthetic): headless worker leaves surface fields undefined", () => {
	const livePid = SYNTH_PID_BASE + 2;
	const liveParent = SYNTH_PID_BASE + 98; // in `alive` → parent alive → live bucket
	const scan = scanZombieSubagents(
		syntheticScanOpts(
			{
				[livePid]: { environ: { PI_CREW_KIND: "subagent", PI_CREW_PARENT_PID: String(liveParent) } },
			},
			{ alive: [liveParent] },
		),
	);
	assert.equal(scan.zombies.length, 0, "live-parent crew worker is never a zombie");
	const entry = scan.live.find((z) => z.pid === livePid);
	assert.ok(entry, "live-parent marker process must appear in the scan");
	assert.equal(entry.parentAlive, true);
	assert.equal(entry.surface, undefined, "no PI_CREW_SURFACE → surface stays undefined");
	assert.equal(entry.surfacePaneId, undefined, "no PI_CREW_SURFACE_PANE → surfacePaneId stays undefined");
});

test("scanZombieSubagents (synthetic): unknown PI_CREW_SURFACE value is ignored (not half-parsed)", () => {
	const pid = SYNTH_PID_BASE + 3;
	const scan = scanZombieSubagents(
		syntheticScanOpts({
			[pid]: {
				environ: { PI_CREW_KIND: "subagent", PI_CREW_PARENT_PID: "1", PI_CREW_SURFACE: "screen", PI_CREW_SURFACE_PANE: "%99" },
			},
		}),
	);
	const entry = scan.zombies.find((z) => z.pid === pid);
	assert.ok(entry, "crew worker must appear in the scan");
	assert.equal(entry.surface, undefined, "unsupported surface kind must not be reported");
});

test("scanZombieSubagents (real /proc, default opts): surface fields parsed from a live process", {
	skip: process.platform !== "linux",
}, async () => {
	// z1: the seam's DEFAULTS must keep reading the real /proc — no drift.
	const deadParentPid = spawnSync("true").pid ?? 1;
	const child = spawn("sleep", ["30"], {
		env: {
			...process.env,
			PI_CREW_KIND: "subagent",
			PI_CREW_PARENT_PID: String(deadParentPid),
			PI_CREW_SURFACE: "tmux",
			PI_CREW_SURFACE_PANE: "%12",
		},
		stdio: "ignore",
	});
	try {
		await waitForSubagentMarker(child.pid);
		const scan = scanZombieSubagents();
		const entry = [...scan.zombies, ...scan.live].find((z) => z.pid === child.pid);
		assert.ok(entry, "spawned marker process must appear in the no-opts scan");
		assert.equal(entry.surface, "tmux", "PI_CREW_SURFACE=tmux must surface as entry.surface");
		assert.equal(entry.surfacePaneId, "%12", "PI_CREW_SURFACE_PANE must surface as entry.surfacePaneId");
	} finally {
		child.kill();
	}
});

test("scanZombieSubagents (synthetic): uid mismatch skips the pid entirely", () => {
	const pid = SYNTH_PID_BASE + 9;
	const scan = scanZombieSubagents(
		syntheticScanOpts({
			[pid]: { uid: 2000, environ: { PI_CREW_KIND: "subagent", PI_CREW_PARENT_PID: "1" } },
		}),
	);
	assert.equal(
		[...scan.zombies, ...scan.live, ...scan.foreign].some((e) => e.pid === pid),
		false,
		"foreign-uid pid is never inspected (cheap-rejection gate)",
	);
});

test("scanZombieSubagents (synthetic): non-linux platform returns empty result + Linux-only note", () => {
	const scan = scanZombieSubagents(
		syntheticScanOpts(
			{ [SYNTH_PID_BASE + 10]: { environ: { PI_CREW_KIND: "subagent", PI_CREW_PARENT_PID: "1" } } },
			{ platform: "darwin" },
		),
	);
	assert.equal(scan.zombies.length, 0);
	assert.equal(scan.live.length, 0);
	assert.equal(scan.foreign.length, 0);
	assert.match(scan.errors[0] ?? "", /Linux-only.*darwin/, "skip note names the platform");
});

test("formatZombieReport: surface entries render pane id + provider", () => {
	const zombie: ZombieSubagent = {
		pid: 4242,
		ppid: 1,
		crewParentPid: 4242 - 100,
		parentAlive: false,
		role: "executor",
		surface: "tmux",
		surfacePaneId: "%12",
		rssKb: 2048,
		elapsedSec: 600,
		cmd: "pi --mode json -p task",
	};
	const text = formatZombieReport({ zombies: [zombie], live: [], foreign: [], errors: [] });
	assert.match(text, /tmux:%12/, "report must show provider + pane id for surface zombies");
});

// ── M-7 (DR-04 round-7): starttime + pid age in zombie rows ────────────────
// PID reuse recycles a dead zombie's PID for an unrelated process; starttime
// (ticks since boot) + wall-clock STARTED + AGE let the operator detect a
// reuse before killing, and the hint must push a prompt kill after the scan.

test("M-7: zombie rows render starttime (STARTED column) + pid age (AGE column)", () => {
	const zombie: ZombieSubagent = {
		pid: 5150,
		ppid: 1,
		crewParentPid: 5050,
		parentAlive: false,
		role: "executor",
		rssKb: 4096,
		elapsedSec: 3725, // 1h 2m → "1h"
		starttime: 987654,
		startedAt: "2026-10-16T04:05:06.000Z",
		cmd: "pi --mode json -p task",
	};
	const text = formatZombieReport({ zombies: [zombie], live: [], foreign: [], errors: [] });
	assert.match(text, /PID\s+PARENT\s+AGE\s+STARTED/, "table header must have AGE + STARTED columns");
	assert.match(text, /1h/, "pid age (1h from elapsedSec=3725) must render in the row");
	assert.match(text, /10-16 04:05:06/, "wall-clock start (MM-DD HH:MM:SS) must render in the row");
	// The row for THIS zombie must contain both fields on the same line.
	const row = text.split("\n").find((l) => l.includes("5150"));
	assert.ok(row, "zombie row must be present");
	assert.match(row!, /\s1h\s+/, "AGE column filled");
	assert.match(row!, /10-16 04:05:06/, "STARTED column filled");
});

test("M-7: unknown starttime/age render placeholders, not 'undefined'", () => {
	const zombie: ZombieSubagent = {
		pid: 5151,
		ppid: 1,
		crewParentPid: 5051,
		parentAlive: false,
		role: undefined,
		rssKb: 4096,
		elapsedSec: undefined,
		cmd: "pi --mode json -p task",
	};
	const text = formatZombieReport({ zombies: [zombie], live: [], foreign: [], errors: [] });
	const row = text.split("\n").find((l) => l.includes("5151"));
	assert.ok(row);
	assert.ok(!row!.includes("undefined"), `row must not leak 'undefined': ${row}`);
});

test("M-7: hint recommends killing promptly after scan (PID-reuse window)", () => {
	const zombie: ZombieSubagent = {
		pid: 5152,
		ppid: 1,
		crewParentPid: 5052,
		parentAlive: false,
		role: "executor",
		rssKb: 4096,
		elapsedSec: 10,
		starttime: 111,
		startedAt: new Date().toISOString(),
		cmd: "pi --mode json -p task",
	};
	const text = formatZombieReport({ zombies: [zombie], live: [], foreign: [], errors: [] });
	assert.match(text, /PROMPTLY|promptly|soon after the/i, "hint must push a prompt kill after the scan");
	assert.match(text, /PID[- ]reuse/i, "hint must name the PID-reuse risk");
});

test("M-7: __test.computeStartedAtIso derives a wall-clock ISO from starttime ticks", () => {
	// On Linux /proc/uptime exists → expect an ISO string within a sane range;
	// on other platforms the helper returns undefined (acceptable).
	const iso = __test.computeStartedAtIso(12345);
	if (process.platform === "linux" && iso) {
		const t = Date.parse(iso);
		assert.ok(Number.isFinite(t), "ISO parseable");
		assert.ok(t <= Date.now(), "start time cannot be in the future");
	} else {
		assert.equal(iso, undefined);
	}
	assert.equal(__test.computeStartedAtIso(undefined), undefined);
});

// ── R3-16: foreign pi processes (AI_AGENT=pi / PI_CODING_AGENT=true) ─────────
// The CLI sets both markers POST-exec, so they appear in a process's own frozen
// /proc/<pid>/environ ONLY when that process was spawned BY another pi process.
// Discriminators (see zombie-scanner.ts header): PI_CREW_KIND gate first, then
// exact-value marker match, pi-looking argv (inheritors like bash/uv/MCP
// servers must NOT match), self/ancestor exclusion, orphaned + headless flags.

/** Bounded poll until /proc/<pid>/environ reflects the post-exec env. */
async function waitForMarker(pid: number | undefined, pred: (env: Record<string, string>) => boolean, timeoutMs = 5000): Promise<void> {
	if (pid === undefined) return;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pred(__test.readProcEnviron(pid))) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** The R3-16 foreign tests must NOT inherit the crew-worker env this test
 *  process may itself run under (PI_CREW_KIND=subagent from a pi-crew worker
 *  shell would route the spawned child into the CREW branch, not foreign —
 *  see knowledge.md 2026-08-15 test-env gotcha). */
function envWithoutCrewKind(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.PI_CREW_KIND;
	delete env.PI_CREW_PARENT_PID;
	return env;
}

test("scanZombieSubagents (synthetic): marker+pi-argv foreign lands in foreign (REPORT ONLY), not zombies/live", () => {
	const foreignPid = SYNTH_PID_BASE + 4;
	const liveParent = SYNTH_PID_BASE + 98;
	const scan = scanZombieSubagents(
		syntheticScanOpts(
			{
				[foreignPid]: {
					// argv0 "pi" fakes the CLI binary's argv[0]; markers make it
					// pi-descended; no PI_CREW_KIND → the foreign branch owns it.
					environ: { AI_AGENT: "pi", PI_CODING_AGENT: "true" },
					ppid: liveParent,
					cmdline: ["pi"],
				},
			},
			{ alive: [liveParent] },
		),
	);
	const foreign = scan.foreign.find((f) => f.pid === foreignPid);
	assert.ok(foreign, "marker+pi-argv process must appear in scan.foreign");
	assert.equal(
		scan.zombies.some((z) => z.pid === foreignPid),
		false,
		"foreign entries never leak into zombies",
	);
	assert.equal(
		scan.live.some((z) => z.pid === foreignPid),
		false,
		"foreign entries never leak into live",
	);
	assert.equal(foreign.orphaned, false, "live parent → orphaned=false");
	assert.equal(foreign.headless, false, "no headless flags in argv → headless=false");
});

test("scanZombieSubagents (real /proc, default opts): foreign marker+pi-argv child reported", {
	skip: process.platform !== "linux",
}, async () => {
	// z1: default opts still drive the real /proc foreign branch.
	const child = spawn("sleep", ["30"], {
		argv0: "pi",
		env: { ...envWithoutCrewKind(), AI_AGENT: "pi", PI_CODING_AGENT: "true" },
		stdio: "ignore",
	});
	try {
		await waitForMarker(child.pid, (env) => env.AI_AGENT === "pi");
		const scan = scanZombieSubagents();
		const foreign = scan.foreign.find((f) => f.pid === child.pid);
		assert.ok(foreign, "default-opts scan still finds foreign pi processes");
		assert.equal(
			scan.zombies.some((z) => z.pid === child.pid),
			false,
		);
		// Spawned by this test process → parent alive → not orphaned.
		assert.equal(foreign.orphaned, false);
	} finally {
		child.kill();
	}
});

test("scanZombieSubagents (synthetic): marker INHERITOR without pi argv is never foreign-listed", () => {
	// Every process pi spawns (shells, MCP servers, xclip…) inherits the markers.
	// The argv gate must keep them out — otherwise the user's own tool processes
	// flood the report.
	const inheritorPid = SYNTH_PID_BASE + 5;
	const scan = scanZombieSubagents(
		syntheticScanOpts({
			[inheritorPid]: {
				environ: { AI_AGENT: "pi", PI_CODING_AGENT: "true" },
				cmdline: ["sleep", "30"],
			},
		}),
	);
	assert.equal(
		scan.foreign.some((f) => f.pid === inheritorPid),
		false,
		"argv[0]=sleep must NOT be listed as foreign pi",
	);
});

test("scanZombieSubagents (synthetic): crew workers (even legacy marker carriers) are never duplicated into foreign", () => {
	// A real crew worker carries PI_CREW_KIND AND (after the env scrub) no
	// markers; even a LEGACY worker that somehow kept markers must classify via
	// the authoritative PI_CREW_KIND gate — never in both buckets.
	const crewPid = SYNTH_PID_BASE + 6;
	const scan = scanZombieSubagents(
		syntheticScanOpts({
			[crewPid]: {
				environ: {
					PI_CREW_KIND: "subagent",
					PI_CREW_PARENT_PID: "1",
					AI_AGENT: "pi",
					PI_CODING_AGENT: "true",
				},
				cmdline: ["pi", "--mode", "json"],
			},
		}),
	);
	const inCrew = [...scan.zombies, ...scan.live].some((z) => z.pid === crewPid);
	assert.ok(inCrew, "PI_CREW_KIND carrier must classify via the crew path");
	assert.equal(
		scan.foreign.some((f) => f.pid === crewPid),
		false,
		"crew worker must never also appear in foreign",
	);
});

test("collectAncestorPids (synthetic): walks the ppid chain over synthetic stats, never self", () => {
	const ancestorTop = SYNTH_PID_BASE + 7;
	const ancestorMid = SYNTH_PID_BASE + 8;
	const opts = syntheticScanOpts(
		{
			// The chain start (scanner's "parent") carries markers + pi argv but is
			// a hosting session — R3-16: ancestors are excluded from foreign.
			[ancestorTop]: { environ: { AI_AGENT: "pi", PI_CODING_AGENT: "true" }, ppid: ancestorMid, cmdline: ["pi"] },
			[ancestorMid]: { ppid: 1 },
		},
		{ parentPid: ancestorTop },
	);
	// Direct helper check: chain = top → mid → init(1) stop.
	const chain = __test.collectAncestorPids(opts.readProcFile!, () => ancestorTop);
	assert.ok(chain.has(ancestorTop) && chain.has(ancestorMid), "chain walks synthetic ppid links");
	assert.equal(chain.has(process.pid), false, "self is never an ancestor");
	// Scan-level: a marker+pi-argv process ON the ancestor chain is not foreign.
	const scan = scanZombieSubagents(opts);
	assert.equal(
		scan.foreign.some((f) => f.pid === ancestorTop),
		false,
		"ancestor pi must never be reported foreign",
	);
});

test("looksLikePiBinary + isHeadlessArgv: classification unit checks", () => {
	assert.equal(__test.looksLikePiBinary(["pi"]), true);
	assert.equal(__test.looksLikePiBinary(["/home/bom/.nvm/versions/node/v22.23.1/bin/pi"]), true);
	assert.equal(__test.looksLikePiBinary(["node", "/x/y/pi-coding-agent/dist/index.js"]), true);
	assert.equal(__test.looksLikePiBinary(["/bin/bash", "-c", "pi"]), false, "bash running pi text is not a pi binary");
	assert.equal(__test.looksLikePiBinary(["/home/bom/.local/bin/uv", "tool", "uvx"]), false);
	assert.equal(__test.looksLikePiBinary(["sleep", "30"]), false);
	assert.equal(__test.isHeadlessArgv(["--mode", "json", "-p"]), true);
	assert.equal(__test.isHeadlessArgv(["--mode=json"]), true);
	assert.equal(__test.isHeadlessArgv(["pi"]), false, "bare interactive argv is not headless");
});

test("formatZombieReport: foreign section is WARN + REPORT ONLY with the no-discriminator caveat", () => {
	const foreign: ForeignPiProcess = {
		pid: 2829041,
		ppid: 1,
		orphaned: true,
		headless: true,
		rssKb: 3 * 1024 * 1024,
		elapsedSec: 90000,
		cmd: "pi --mode json -p",
	};
	const text = formatZombieReport({ zombies: [], live: [], foreign: [foreign], errors: [] });
	assert.match(text, /WARN/, "foreign section must be marked WARN");
	assert.match(text, /REPORT ONLY/, "foreign section must state REPORT ONLY");
	assert.match(text, /No reliable discriminator/i, "caveat must state no reliable discriminator exists");
	assert.match(text, /orphaned headless/, "triage flags (orphaned + headless) must render");
	assert.match(text, /never kills/i, "read-only guarantee must stay");
});
