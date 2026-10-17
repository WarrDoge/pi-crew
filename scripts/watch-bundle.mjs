#!/usr/bin/env node
/**
 * Auto-rebuild bundle watcher — dev-loop ergonomics for v0.9.17+.
 *
 * Watches `src/`, `index.bundle.ts` for changes and rebuilds
 * `dist/index.mjs` after a 300ms debounce. Solves the "edit src/foo.ts,
 * forget to rebuild, run stale bundle" race that motivated check:
 * bundle-staleness as a CI gate.
 *
 * Usage:
 *   node scripts/watch-bundle.mjs                # default: watch src/ + index.bundle.ts
 *   node scripts/watch-bundle.mjs --once         # build once and exit (CI prep)
 *   node scripts/watch-bundle.mjs --debounce 500 # custom debounce ms
 *
 * Why native fs.watch (not chokidar):
 *   - Adds zero deps (chokidar would add ~50 transitive deps)
 *   - Node 22 + Linux/macOS support recursive watching (fs.watch recursive)
 *
 * Why not in-process (bundled into build:bundle):
 *   - Watch is a separate dev concern; doesn't belong in the build script
 *   - Keeps the build script one-shot (CI-friendly, deterministic)
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir, watch } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
let onceMode = false;
let debounceMs = 300;
for (let i = 0; i < args.length; i += 1) {
	if (args[i] === "--once") {
		onceMode = true;
	} else if (args[i] === "--debounce" && args[i + 1]) {
		debounceMs = Number(args[i + 1]);
		i += 1;
	}
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const WATCH_PATHS = ["src", "index.bundle.ts"];
const EXTENSIONS_TO_WATCH = new Set([".ts", ".mts", ".cts", ".js", ".mjs"]);
const IGNORE_DIRS = new Set(["node_modules", "dist", ".git"]);

let pending = null;
let lastBuildReason = null;

function scheduleRebuild(reason, file) {
	lastBuildReason = `${reason} ${path.relative(root, file ?? "")}`;
	if (pending) clearTimeout(pending);
	pending = setTimeout(() => {
		pending = null;
		runBuild().catch((err) => console.error("[watch-bundle] build crashed:", err));
	}, debounceMs);
}

function runBuild() {
	return new Promise((resolve, reject) => {
		const startMs = Date.now();
		const child = spawn(process.execPath, [path.join(root, "scripts/build-bundle.mjs")], {
			stdio: ["ignore", "pipe", "pipe"],
			cwd: root,
			env: { ...process.env, FORCE_COLOR: "0" },
		});
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			const text = String(chunk);
			if (text.includes("[build-bundle] dist/index.mjs")) {
				process.stdout.write(`[watch-bundle] ${text}`);
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
			process.stderr.write(`[watch-bundle] ${chunk}`);
		});
		child.on("exit", (code) => {
			const ms = Date.now() - startMs;
			if (code === 0) {
				console.log(`[watch-bundle] ok in ${ms}ms (${lastBuildReason ?? "initial"})`);
				resolve();
			} else {
				reject(new Error(`build exited with code ${code}: ${stderr.trim().split("\n").slice(-3).join(" / ")}`));
			}
		});
		child.on("error", reject);
	});
}

async function listFiles(dir) {
	const out = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (IGNORE_DIRS.has(entry.name)) continue;
			out.push(...(await listFiles(full)));
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name).toLowerCase();
			if (EXTENSIONS_TO_WATCH.has(ext)) out.push(full);
		}
	}
	return out;
}

async function watchDir(dir) {
	// Linux inotify (used by fs.watch {recursive: true} on modern Node)
	// sometimes misses events on deep trees. Walk the tree once and
	// spawn a per-directory watcher for robustness. Cost: O(2N) FDs
	// where N = number of source dirs (~5 for a typical pi-crew tree).
	// Each watcher is independent and yields events as its dir changes.
	// R5-M-A1 (wave-2b): the walk was ONE level deep — sub-subdirectories
	// (src/ui/dashboard-panes/*) had no watcher; late-created dirs were never
	// picked up. watchDir now recurses (each sub calls watchDir itself) and
	// the root watcher arms watchers for dirs created at runtime.
	const watcherJobs = [];
	try {
		// Watch the dir itself (catches direct children changes)
		const rootWatcher = await watch(dir, { persistent: true });
		watcherJobs.push(
			(async () => {
				for await (const e of rootWatcher) {
					if (!e.filename) continue;
					const full = path.join(dir, e.filename);
					let isDir = false;
					try {
						isDir = statSync(full).isDirectory();
					} catch {
						/* raced away — treat as a file event */
					}
					if (isDir) {
						if (IGNORE_DIRS.has(e.filename)) continue;
						// Late-created dir: arm a watcher subtree for it now.
						watcherJobs.push(watchDir(full));
						continue;
					}
					handleEvent(dir, e.filename);
				}
			})(),
		);
	} catch (err) {
		console.warn(`[watch-bundle] cannot watch ${dir}:`, err?.code ?? err?.message ?? err);
	}
	// Recurse into subdirectories (skip ignored) — each recurses further
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (IGNORE_DIRS.has(entry.name)) continue;
			watcherJobs.push(watchDir(path.join(dir, entry.name)));
		}
	} catch {
		// ignore readdir errors
	}
	// Block until any watcher completes (they shouldn't, they're persistent)
	await Promise.race(watcherJobs);
}

function handleEvent(watchedDir, filename) {
	const fullPath = path.resolve(watchedDir, filename);
	const ext = path.extname(fullPath).toLowerCase();
	if (!EXTENSIONS_TO_WATCH.has(ext)) return;
	if (fullPath.includes(`${path.sep}dist${path.sep}`)) return;
	scheduleRebuild("change", fullPath);
}

async function watchFile(file) {
	if (!existsSync(file)) return;
	const dir = path.dirname(file);
	const watcher = watch(dir, { persistent: true });
	for await (const event of watcher) {
		if (!event.filename) continue;
		const changed = path.resolve(dir, event.filename);
		if (changed === file) scheduleRebuild("change", changed);
	}
}

async function main() {
	const watchables = WATCH_PATHS.map((p) => path.join(root, p)).filter((p) => {
		try {
			return existsSync(p);
		} catch {
			return false;
		}
	});
	if (watchables.length === 0) {
		console.error("[watch-bundle] no watchable paths found (run from repo root)");
		process.exit(1);
	}

	console.log("[watch-bundle] initial build...");
	let initialOk = true;
	try {
		await runBuild();
	} catch (err) {
		console.error("[watch-bundle] initial build failed:", err.message);
		initialOk = false;
	}

	if (onceMode) {
		process.exit(initialOk ? 0 : 2);
	}

	if (!initialOk) {
		console.warn("[watch-bundle] initial build failed; watching anyway");
	}

	let seedCount = 0;
	for (const p of watchables) {
		try {
			const stat = statSync(p);
			if (stat.isDirectory()) {
				seedCount += (await listFiles(p)).length;
			} else if (stat.isFile()) {
				seedCount += 1;
			}
		} catch {
			// skip
		}
	}
	console.log(`[watch-bundle] seeded with ${seedCount} source files`);

	const watchJobs = [];
	for (const p of watchables) {
		try {
			const stat = statSync(p);
			watchJobs.push(stat.isDirectory() ? watchDir(p) : watchFile(p));
		} catch (err) {
			console.warn(`[watch-bundle] cannot watch ${p}:`, err?.code ?? err?.message ?? err);
		}
	}

	console.log(`[watch-bundle] watching ${watchables.length} paths; debounce=${debounceMs}ms; Ctrl+C to stop`);

	let shutting = false;
	const stop = () => {
		if (shutting) return;
		shutting = true;
		console.log("\n[watch-bundle] shutting down...");
		if (pending) {
			clearTimeout(pending);
			pending = null;
		}
		setTimeout(() => process.exit(0), 200);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);

	await Promise.race(watchJobs);
}

main().catch((err) => {
	console.error("[watch-bundle] fatal:", err);
	process.exit(1);
});