/**
 * b14 — Δ1 microbench: run-index runs-dir enumeration scaling (100 / 1k / 10k dirs).
 *
 * QUESTION (bench-first rule — no optimization yet):
 *   `collectRuns()` (src/extension/run-index.ts) does readdirSync + filter +
 *   sort O(total run dirs) per refresh window even though manifest parsing is
 *   cached (sharedScanCache "manifests" bucket: TTL 1000ms, maxEntries 100,
 *   FIFO evict) and active runs come from the registry. At what N run dirs
 *   does that O(n) enumeration + cache pressure become measurable, and is
 *   manifests maxEntries=100 adequate (eviction churn when >100 concurrent
 *   keys)?
 *
 * WHAT THIS MEASURES (per N = 100 / 1,000 / 10,000 synthetic run dirs in an
 * ISOLATED crew home — mkdtemp + PI_CREW_HOME/PI_TEAMS_HOME set in-process,
 * real ~/.pi never touched):
 *   - enumerate      — readdir+filter+sort ONLY (faithful reimplementation of
 *                      run-index.ts readdirSync block; the O(n) floor);
 *   - full cold      — listRunsByScope(ws,"user") = collectRuns(userRoot)
 *                      unbounded, "manifests" bucket invalidated first;
 *   - full warm      — same call immediately after (within TTL) → cache-hit
 *                      rate = min(N,100) of N keys (FIFO truncation);
 *   - full postTTL   — same call after >1000ms sleep (bucket-level TTL is
 *                      NON-sliding: bucket dies 1s after ITS FIRST set, so a
 *                      scan slower than 1s expires its own bucket mid-scan);
 *   - recent40 cold/warm — listRecentRuns(ws, 40): the async-notifier path
 *                      (readdir O(N) + only 40 manifest reads);
 *   - cacheReplay    — deterministic replay of the same key order into a LOCAL
 *                      SharedScanCache({ttlMs:60s,maxEntries:100}) to count
 *                      evictions-per-scan and warm misses exactly (fs-op
 *                      counting is NOT observable: the "node:fs" ESM namespace
 *                      is frozen — patching fs.readFileSync throws; noted in
 *                      the report).
 *
 * Median of 5 samples per phase. Human tables first, then ONE final NDJSON
 * line (runner parses the LAST stdout JSON line).
 *
 * SAFETY: synthetic homes live under os.tmpdir() and are rm -rf'd in finally;
 * the REAL user runs root (~/.pi/agent/extensions/pi-crew/state/runs/) is
 * snapshotted before/after and asserted unchanged (expected: only
 * active-run-index.{bin,json}).
 *
 * Standalone run (NO package.json script — bench/ files are standalone; picked
 * up automatically by `npm run bench` via the b*.bench.ts glob):
 *   node --experimental-strip-types bench/b14-run-index-scan.bench.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { TeamRunManifest, TeamRunStatus } from "../src/state/types.ts";

const ITERATIONS = 5;
const BUCKET_TTL_MS = 1000; // sharedScanCache default (src/utils/scan-cache.ts)
const BUCKET_MAX_ENTRIES = 100; // sharedScanCache default
const RECENT_MAX = 40; // async-notifier bound (debounced 30s)
const SIZES = [100, 1_000, 10_000];
const BASE_EPOCH_MS = Date.UTC(2026, 9, 1, 0, 0, 0); // 2026-10-01 — stagger 1 run/min upward
const GOAL_TEXT =
	"Δ1 bench synthetic goal: measure collectRuns() runs-dir enumeration scaling and manifests-bucket " +
	"cache behavior at 100/1k/10k run dirs so the runs-list refresh cost and the maxEntries=100 verdict " +
	"are decided on numbers, not vibes. This filler keeps the manifest at a realistic few-KB size because " +
	"manifest bytes drive cold-scan JSON.parse cost.";

/** Real user runs root — guarded (must be untouched by this bench). */
const REAL_RUNS_ROOT = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-crew", "state", "runs");

const tmpHomes: string[] = [];
let failures = 0;

function expect(cond: boolean, msg: string): void {
	if (!cond) {
		failures++;
		console.error(`  [FAIL] ${msg}`);
	}
}

function fmt(ms: number): string {
	return ms >= 100 ? ms.toFixed(1) : ms >= 10 ? ms.toFixed(2) : ms.toFixed(3);
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

function minMax(xs: number[]): { min: number; max: number } {
	const s = [...xs].sort((a, b) => a - b);
	return { min: s[0], max: s[s.length - 1] };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotRealRoot(): string[] {
	try {
		return fs.readdirSync(REAL_RUNS_ROOT).sort();
	} catch {
		return [];
	}
}

/** Deterministic 16-hex suffix (xorshift64) — unique per index, [A-Za-z0-9_-]-safe. */
function hexSuffix(seed: number): string {
	let x = BigInt(seed + 1) * 0x9e3779b97f4a7c15n;
	let out = "";
	for (let i = 0; i < 16; i++) {
		x ^= x << 13n;
		x &= 0xffffffffffffffffn;
		x ^= x >> 7n;
		x ^= x << 17n;
		x &= 0xffffffffffffffffn;
		out += (x & 0xfn).toString(16);
	}
	return out;
}

function synthManifest(home: string, runsRoot: string, runId: string, index: number, status: TeamRunStatus): TeamRunManifest {
	const created = BASE_EPOCH_MS + index * 60_000;
	const iso = new Date(created).toISOString();
	return {
		schemaVersion: 1,
		runId,
		sessionId: `crew-${runId}`,
		team: "default",
		workflow: "plan-execute",
		goal: GOAL_TEXT,
		status,
		workspaceMode: "single",
		createdAt: iso,
		updatedAt: new Date(created + 5 * 60_000).toISOString(),
		cwd: home, // exists → ghost-run filter never trips; temp-root semantics apply
		stateRoot: path.join(runsRoot, runId),
		artifactsRoot: path.join(home, "artifacts", runId),
		tasksPath: path.join(runsRoot, runId, "tasks.json"),
		eventsPath: path.join(runsRoot, runId, "events.jsonl"),
		artifacts: [],
		runKind: "team-run",
		goalAchieved: status === "completed" ? true : "unknown",
		goalAchievementNote: "b14 Δ1 synthetic manifest (runs-dir enumeration microbench)",
		summary: "Synthetic run for bench/b14-run-index-scan.bench.ts — Δ1 enumeration scaling probe.",
		budgetTotal: 2_000_000,
		budgetWarning: 0.8,
		budgetAbort: 0.95,
		policyDecisions: [],
	};
}

interface Home {
	home: string;
	ws: string;
	runsRoot: string;
	runIds: string[];
	lastScannedKey: string; // smallest id in desc-sort iteration order (survives FIFO truncation)
	manifestAvgBytes: number;
}

function buildHome(nDirs: number): Home {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-b14-n${nDirs}-`));
	tmpHomes.push(home);
	// userCrewRoot() = <home>/.pi/agent/extensions/pi-crew; runs under <root>/state/runs
	const runsRoot = path.join(home, ".pi", "agent", "extensions", "pi-crew", "state", "runs");
	fs.mkdirSync(runsRoot, { recursive: true });
	const ws = path.join(home, "ws"); // bench "cwd" — deliberately NOT a repo → single scoped root
	fs.mkdirSync(ws, { recursive: true });

	const runIds: string[] = [];
	let bytes = 0;
	for (let i = 0; i < nDirs; i++) {
		const created = BASE_EPOCH_MS + i * 60_000;
		const stamp = new Date(created)
			.toISOString()
			.replace(/[-:TZ.]/g, "")
			.slice(0, 14);
		const runId = `team_${stamp}_${hexSuffix(i)}`;
		runIds.push(runId);
		// Mixture: 3 newest runs "running" (registry-shaped), every 17th "failed", rest "completed".
		const status: TeamRunStatus = i >= nDirs - 3 ? "running" : i % 17 === 5 ? "failed" : "completed";
		const dir = path.join(runsRoot, runId);
		fs.mkdirSync(dir, { recursive: true });
		const manifest = synthManifest(home, runsRoot, runId, i, status);
		const raw = `${JSON.stringify(manifest, null, 2)}\n`;
		bytes += raw.length;
		fs.writeFileSync(path.join(dir, "manifest.json"), raw, "utf-8");
	}
	// collectRuns iterates desc-sorted; last scanned = smallest id. The manifests
	// bucket is keyed by manifest FILE PATH (readAndCache(bucket, filePath, filePath))
	// and FIFO-truncated to the last 100 inserted — the last-scanned key is always
	// retained while the bucket is alive.
	const lastScannedId = [...runIds].sort((a, b) => b.localeCompare(a)).at(-1)!;
	const lastScannedKey = path.join(fs.realpathSync(path.join(runsRoot, lastScannedId)), "manifest.json");
	return { home, ws, runsRoot, runIds, lastScannedKey, manifestAvgBytes: Math.round(bytes / nDirs) };
}

/**
 * Faithful reimplementation of the run-index.ts readdir block (enumeration
 * only — no manifest IO). Mirrors src/extension/run-index.ts collectRuns()
 * readdir+filter+sort lines.
 */
function enumerateOnly(runsRoot: string): number {
	const entries = fs
		.readdirSync(runsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name))
		.map((entry) => entry.name)
		.sort((a, b) => (b ?? "").localeCompare(a ?? ""));
	return entries.length;
}

/**
 * Deterministic maxEntries replay: same key order as collectRuns iteration
 * (desc sort), on a LOCAL instance with a LONG TTL so only the size dimension
 * is exercised. Returns evictions per scan + warm hit/miss counts.
 */
function replayBucket(
	cache: LocalScanCache,
	nKeys: number,
): { evictionsPerScan: number; warmHits: number; warmMisses: number; sizeAfterScan1: number } {
	const keys: string[] = [];
	for (let i = 0; i < nKeys; i++) keys.push(hexSuffix(i + 100_000));
	keys.sort((a, b) => b.localeCompare(a)); // desc — collectRuns iteration order
	const entry = (key: string) => ({
		key,
		path: `/bench/${key}`,
		raw: { runId: key },
		mtimeMs: 1,
		sizeBytes: 1,
		loadedAtMs: 1,
	});
	const before = cache.list("manifests").length;
	for (const key of keys) cache.set("manifests", entry(key));
	const sizeAfterScan1 = cache.list("manifests").length;
	const evictionsPerScan = keys.length - (sizeAfterScan1 - before); // distinct keys → exact
	let warmHits = 0;
	for (const key of keys) if (cache.get("manifests", key) !== undefined) warmHits++;
	return { evictionsPerScan, warmHits, warmMisses: keys.length - warmHits, sizeAfterScan1 };
}

/** Structural slice of SharedScanCache used by replayBucket (keeps it typed without exporting internals). */
interface LocalScanCache {
	list(bucket: string): unknown[];
	get(bucket: string, key: string): unknown;
	set(bucket: string, entry: { key: string }): void;
}

interface Samples {
	enumerate: number[];
	fullCold: number[];
	fullWarm: number[];
	fullPostTtl: number[];
	recentCold: number[];
	recentWarm: number[];
}

async function main(): Promise<Record<string, unknown>> {
	const realRootBefore = snapshotRealRoot();
	console.log(`b14 — run-index runs-dir enumeration microbench (Δ1)`);
	console.log(`  real user runs root guard: ${REAL_RUNS_ROOT}`);
	console.log(`  entries before: [${realRootBefore.join(", ")}]`);

	// Isolated crew home FIRST, then load the modules that read PI_CREW_HOME /
	// PI_TEAMS_HOME (LAZY: env must be set before any userCrewRoot() resolution).
	const firstHome = buildHome(SIZES[0]);
	process.env.PI_CREW_HOME = firstHome.home;
	process.env.PI_TEAMS_HOME = firstHome.home;
	const runIndex = await import("../src/extension/run-index.ts");
	const scanCache = await import("../src/utils/scan-cache.ts");
	const { listRecentRuns, listRunsByScope } = runIndex;
	const sharedScanCache = scanCache.sharedScanCache;
	const replayCache: LocalScanCache = new scanCache.SharedScanCache({ ttlMs: 60_000, maxEntries: BUCKET_MAX_ENTRIES });

	const cases: Record<string, Record<string, unknown>> = {};
	let currentHome = firstHome;

	for (const n of SIZES) {
		const h = n === SIZES[0] ? firstHome : buildHome(n);
		currentHome = h;
		// Switch env — userPiRoot() memoizes KEYED ON HOME, so this re-resolves.
		process.env.PI_CREW_HOME = h.home;
		process.env.PI_TEAMS_HOME = h.home;

		console.log(`\n── N=${n} run dirs (home ${h.home}, manifest avg ${h.manifestAvgBytes} B) ──`);
		const s: Samples = { enumerate: [], fullCold: [], fullWarm: [], fullPostTtl: [], recentCold: [], recentWarm: [] };
		let fullScanLen = -1;
		let recentLen = -1;
		let bucketSizeAfterCold = -1;
		let bucketAliveAfterCold = false;

		// Warmup + sanity (also proves the synthetic root is the ONLY scoped root).
		sharedScanCache.invalidateBucket("manifests");
		const sanity = listRunsByScope(h.ws, "user");
		expect(sanity.length === n, `N=${n}: full scan returned ${sanity.length} runs (expected ${n})`);
		fullScanLen = sanity.length;
		const sanityRecent = listRecentRuns(h.ws, RECENT_MAX);
		expect(sanityRecent.length === Math.min(RECENT_MAX, n), `N=${n}: recent=${RECENT_MAX} returned ${sanityRecent.length}`);
		recentLen = sanityRecent.length;

		for (let iter = 0; iter < ITERATIONS; iter++) {
			// Enumeration-only floor.
			{
				const t0 = performance.now();
				const len = enumerateOnly(h.runsRoot);
				const ms = performance.now() - t0;
				expect(len === n, `N=${n}: enumerateOnly saw ${len} dirs`);
				s.enumerate.push(ms);
			}
			// Full collectRuns — cold (bucket invalidated).
			sharedScanCache.invalidateBucket("manifests");
			{
				const t0 = performance.now();
				const runs = listRunsByScope(h.ws, "user");
				const ms = performance.now() - t0;
				expect(runs.length === n, `N=${n} cold scan len=${runs.length}`);
				s.fullCold.push(ms);
			}
			bucketSizeAfterCold = sharedScanCache.list("manifests").length; // >0 only if bucket still alive
			bucketAliveAfterCold = sharedScanCache.get("manifests", h.lastScannedKey) !== undefined;
			// Full — warm within TTL.
			{
				const t0 = performance.now();
				const runs = listRunsByScope(h.ws, "user");
				const ms = performance.now() - t0;
				expect(runs.length === n, `N=${n} warm scan len=${runs.length}`);
				s.fullWarm.push(ms);
			}
			// Full — after bucket TTL expiry (bucket-level TTL: non-sliding).
			await sleep(BUCKET_TTL_MS + 80);
			{
				const t0 = performance.now();
				const runs = listRunsByScope(h.ws, "user");
				const ms = performance.now() - t0;
				expect(runs.length === n, `N=${n} postTTL scan len=${runs.length}`);
				s.fullPostTtl.push(ms);
			}
			// recent40 — cold then warm (the async-notifier path).
			sharedScanCache.invalidateBucket("manifests");
			{
				const t0 = performance.now();
				const runs = listRecentRuns(h.ws, RECENT_MAX);
				s.recentCold.push(performance.now() - t0);
				expect(runs.length === Math.min(RECENT_MAX, n), `N=${n} recent cold len=${runs.length}`);
			}
			{
				const t0 = performance.now();
				const runs = listRecentRuns(h.ws, RECENT_MAX);
				s.recentWarm.push(performance.now() - t0);
				expect(runs.length === Math.min(RECENT_MAX, n), `N=${n} recent warm len=${runs.length}`);
			}
		}

		const replay = replayBucket(replayCache, n);
		const med = (k: keyof Samples) => median(s[k]);
		const mm = (k: keyof Samples) => minMax(s[k]);
		console.log(`  phase           median(ms)   min..max`);
		for (const k of Object.keys(s) as (keyof Samples)[]) {
			const { min, max } = mm(k);
			console.log(`  ${k.padEnd(14)} ${fmt(med(k)).padStart(10)}   ${fmt(min)}..${fmt(max)}`);
		}
		console.log(
			`  scan-cache: bucketSizeAfterCold=${bucketSizeAfterCold} alive=${bucketAliveAfterCold} | replay evictions/scan=${replay.evictionsPerScan} warmHits=${replay.warmHits} warmMisses=${replay.warmMisses}`,
		);

		cases[`n${n}`] = {
			dirs: n,
			manifestAvgBytes: h.manifestAvgBytes,
			enumerateMs: med("enumerate"),
			enumerateMinMs: mm("enumerate").min,
			enumerateMaxMs: mm("enumerate").max,
			fullColdMs: med("fullCold"),
			fullWarmMs: med("fullWarm"),
			fullPostTtlMs: med("fullPostTtl"),
			recent40ColdMs: med("recentCold"),
			recent40WarmMs: med("recentWarm"),
			fullScanLen,
			recent40Len: recentLen,
			bucketSizeAfterColdScan: bucketSizeAfterCold,
			bucketAliveAfterColdScan: bucketAliveAfterCold,
			cacheReplay: {
				evictionsPerScan: replay.evictionsPerScan,
				warmHits: replay.warmHits,
				warmMisses: replay.warmMisses,
			},
		};
	}

	// Scan-cache config + user-root guard.
	const userRootAfter = snapshotRealRoot();
	const unchanged = realRootBefore.join("|") === userRootAfter.join("|");
	expect(unchanged, `real user runs root CHANGED by bench: [${userRootAfter.join(", ")}]`);
	const onlyIndexFiles =
		realRootBefore.length === 2 && realRootBefore.includes("active-run-index.bin") && realRootBefore.includes("active-run-index.json");
	if (!onlyIndexFiles) console.log(`  [warn] real root holds more than active-run-index.*: [${realRootBefore.join(", ")}]`);

	return {
		name: "b14.run-index-scan",
		unit: "ms",
		iterations: ITERATIONS,
		cases,
		scanCacheConfig: {
			bucket: "manifests",
			maxEntries: BUCKET_MAX_ENTRIES,
			ttlMs: BUCKET_TTL_MS,
			ttlMode: "bucket-level (non-sliding: bucket expires 1s after its FIRST set)",
		},
		userRootGuard: { unchanged, entries: userRootAfter },
		failures,
	};
}

let result: Record<string, unknown>;
try {
	result = await main();
} finally {
	// Cleanup: remove ALL synthetic homes, then assert removal.
	for (const home of tmpHomes) fs.rmSync(home, { recursive: true, force: true });
	for (const home of tmpHomes) expect(!fs.existsSync(home), `cleanup failed: ${home} still exists`);
	delete process.env.PI_CREW_HOME;
	delete process.env.PI_TEAMS_HOME;
}

// NDJSON contract line — must be the LAST stdout line (runner parses it).
console.log(JSON.stringify(result));

if (failures > 0) {
	console.error(`\nb14 FAILED (${failures} check(s))`);
	process.exit(1);
}
console.log("\nb14 PASSED");
