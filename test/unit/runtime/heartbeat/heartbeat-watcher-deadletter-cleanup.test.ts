/**
 * DR-04 W5 / M-8 (2026-10-16).
 *
 * HeartbeatWatcher's cleanup loop and dispose() cleared lastLevel /
 * consecutiveDead / lastSeen but leaked the `lastDeadletterTriggerAt` cooldown
 * map (one entry per vanished run:taskId key). Observable failure mode: a
 * stale cooldown timestamp suppresses a legitimate deadletter re-trigger
 * after the same task reappears. This test drives exactly that sequence.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createMetricRegistry } from "../../../../src/observability/metric-registry.ts";
import { HeartbeatWatcher } from "../../../../src/runtime/heartbeat/heartbeat-watcher.ts";
import type { ManifestCache } from "../../../../src/runtime/manifest-cache.ts";
import { createRunManifest, saveRunTasks, updateRunStatus } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

const team = {
	name: "t",
	description: "",
	source: "test",
	filePath: "t",
	roles: [{ name: "r", agent: "a" }],
} as never;
const workflow = {
	name: "w",
	description: "",
	source: "test",
	filePath: "w",
	steps: [{ id: "s", role: "r", task: "x" }],
} as never;

test("M-8: deadletter cooldown marker is dropped when the key leaves the active set", () => {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-hb-m8-"));
	try {
		// Canonicalize to long-name form matching production code
		try {
			const r = fs.realpathSync.native(cwd);
			cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
		} catch {
			/* keep as-is */
		}
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const created = createRunManifest({ cwd, team, workflow, goal: "m8" });
		const manifest = updateRunStatus(created.manifest, "running", "running");
		saveRunTasks(
			manifest,
			created.tasks.map((task) => ({
				...task,
				status: "running" as const,
				heartbeat: {
					workerId: task.id,
					lastSeenAt: "2026-01-01T00:00:00.000Z",
					alive: true,
				},
			})),
		);

		// Controllable cache: flip `runVisible` off to drop the run from the
		// active set, forcing the tick cleanup path.
		let runVisible = true;
		const cache = {
			list: () => (runVisible ? [manifest as TeamRunManifest] : []),
		} as unknown as ManifestCache;

		let deadletters = 0;
		const watcher = new HeartbeatWatcher({
			cwd,
			manifestCache: cache,
			registry: createMetricRegistry(),
			router: { enqueue: () => true },
			deadletterTickThreshold: 1,
			// Huge cooldown: without the M-8 fix the retained marker suppresses
			// the second trigger below; with it (marker deleted by cleanup) the
			// reappearing task may trigger again.
			deadletterCooldownMs: 100_000_000,
			onDeadletterTrigger: () => {
				deadletters += 1;
			},
		});

		const t0 = Date.parse("2026-01-01T00:10:00.000Z");
		watcher.tick(t0); // heartbeat 10min stale, threshold 1 tick → trigger #1
		assert.equal(deadletters, 1, "first dead-letter trigger fires");

		// Run vanishes from the cache → after maxKeyAgeMs (10 min) the cleanup
		// loop must ALSO drop the lastDeadletterTriggerAt marker.
		runVisible = false;
		watcher.tick(t0 + 11 * 60_000);
		assert.equal(deadletters, 1, "no trigger while the run is invisible");

		// Same task reappears, still dead → cooldown marker must have been
		// cleaned up, so trigger #2 is allowed.
		runVisible = true;
		watcher.tick(t0 + 11 * 60_000 + 5000);
		assert.equal(deadletters, 2, "cooldown marker was dropped by the cleanup loop (M-8)");

		watcher.dispose();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("M-8: dispose() clears the deadletter cooldown map (re-created watcher can re-trigger)", () => {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-hb-m8b-"));
	try {
		try {
			const r = fs.realpathSync.native(cwd);
			cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
		} catch {
			/* keep as-is */
		}
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const created = createRunManifest({ cwd, team, workflow, goal: "m8b" });
		const manifest = updateRunStatus(created.manifest, "running", "running");
		saveRunTasks(
			manifest,
			created.tasks.map((task) => ({
				...task,
				status: "running" as const,
				heartbeat: {
					workerId: task.id,
					lastSeenAt: "2026-01-01T00:00:00.000Z",
					alive: true,
				},
			})),
		);
		const cache = {
			list: () => [manifest as TeamRunManifest],
		} as unknown as ManifestCache;

		let deadletters = 0;
		const makeWatcher = () =>
			new HeartbeatWatcher({
				cwd,
				manifestCache: cache,
				registry: createMetricRegistry(),
				router: { enqueue: () => true },
				deadletterTickThreshold: 1,
				deadletterCooldownMs: 100_000_000,
				onDeadletterTrigger: () => {
					deadletters += 1;
				},
			});

		const t0 = Date.parse("2026-01-01T00:10:00.000Z");
		const watcher = makeWatcher();
		watcher.tick(t0);
		assert.equal(deadletters, 1);
		watcher.dispose(); // must also clear lastDeadletterTriggerAt
		// Reuse the SAME watcher: if dispose() leaked the cooldown marker, the
		// 5s elapsed below (< cooldown 100_000_000) would suppress trigger #2.
		watcher.tick(t0 + 5000);
		assert.equal(deadletters, 2, "dispose() clears the cooldown map (M-8)");
		watcher.dispose();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
