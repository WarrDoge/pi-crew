/**
 * U11 — hybrid 2-tier worker model: tier orchestration unit tests.
 *
 * Covers the five mandated groups (task packet adaptive-2-1):
 *   1. default-off no-op — resolver + planner + config parse are inert without
 *      an explicit opt-in; legacy live-session and child-process behavior
 *      unchanged (also pinned by the pre-existing runtime-policy-cov /
 *      isolation-policy suites);
 *   2. role opt-in routing — resolveTaskRuntimeKind upgrade rules, guard
 *      precedence (scaffold / depth>0 / isolatedRoles), sticky downgrade;
 *   3. 2-fault fallback state machine — ledger persistence, tier.fault /
 *      tier.fallback events, abort + capacity-rejected non-counting gates,
 *      thrown-attempt counting;
 *   4. budget contention across tiers — the embedded path consumes the SAME
 *      global worker semaphore as the subprocess tier (no bypass) and the
 *      fail-fast embedded ceiling reroutes instead of queueing;
 *   5. depth-guard unchanged — the pre-U11 depth guard is byte-equivalent and
 *      EXTENDED to the embedded upgrade path.
 *
 * Plus: config validation (field-wise drop) + schema acceptance + the
 * live-executor fault-classification fallback (Phase-1 interface contract).
 *
 * Env discipline: every resolver/planner call passes an EXPLICIT env (this
 * suite may run inside a pi-crew worker where PI_CREW_DEPTH=1 is ambient).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import type { CrewRuntimeConfig } from "../../../../src/config/config.ts";
import { parseConfig } from "../../../../src/config/config.ts";
import type { LiveSessionFault, LiveSessionFaultKind } from "../../../../src/runtime/live-session/embedded-tier.ts";
import {
	DEFAULT_EMBEDDED_FAULT_THRESHOLD,
	resolveEmbeddedFaultThreshold,
	resolveTaskRuntimeKind,
} from "../../../../src/runtime/model/runtime-policy.ts";
import {
	__test_resetCap,
	acquireWorkerSlot,
	getWorkerCapCapacity,
	releaseWorkerSlot,
} from "../../../../src/runtime/scheduling/global-worker-cap.ts";
import {
	__test_resetEmbeddedCeiling,
	type EmbeddedLiveOutcome,
	persistEmbeddedFault,
	planEmbeddedTier,
	readEmbeddedFaultCount,
	runEmbeddedTier,
} from "../../../../src/runtime/task-runner/hybrid-tier.ts";
import { classifyLiveTaskFault } from "../../../../src/runtime/task-runner/live-executor.ts";
import { runTeamTask } from "../../../../src/runtime/task-runner.ts";
import { PiTeamsConfigSchema } from "../../../../src/schema/config-schema.ts";
import { flushPendingAtomicWrites } from "../../../../src/state/atomic-write.ts";
import { flushEventLogBuffer, readEvents } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest, loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const team: TeamConfig = {
	name: "u11-test",
	description: "u11 test",
	source: "builtin",
	filePath: "u11-test.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};

const workflow: WorkflowConfig = {
	name: "u11-test",
	description: "u11 test",
	source: "builtin",
	filePath: "u11-test.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "do the recon" }],
};

const FLAT_ENV: NodeJS.ProcessEnv = { PI_CREW_DEPTH: "0" };
const NESTED_ENV: NodeJS.ProcessEnv = { PI_CREW_DEPTH: "1" };

const POLICY_ON: NonNullable<CrewRuntimeConfig["embeddedWorkers"]> = {
	enabled: true,
	roles: ["explorer"],
};

function makeFixture() {
	const cwd = createTrackedTempDir("pi-crew-u11-");
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	const created = createRunManifest({ cwd, team, workflow, goal: "u11" });
	const task = created.tasks[0]!;
	return { cwd, manifest: created.manifest, tasks: created.tasks, task };
}

/** Minimal embedded-attempt outcome bag (shape hybrid-tier consumes). */
function makeLiveOutcome(
	manifest: TeamRunManifest,
	task: TeamTaskState,
	overrides: Partial<Pick<EmbeddedLiveOutcome, "exitCode" | "error" | "fault">> = {},
): EmbeddedLiveOutcome {
	return {
		task,
		tasks: [task],
		startupEvidence: {
			lastLifecycleState: "finished",
			command: "live-session",
			promptSentAt: new Date().toISOString(),
			promptAccepted: true,
			trustPromptDetected: false,
			transportHealthy: true,
			childProcessAlive: false,
			elapsedMs: 1,
			classification: "unknown",
		},
		exitCode: 0,
		resultArtifact: {
			kind: "result",
			path: path.join(manifest.artifactsRoot, "results", `${task.id}.txt`),
			createdAt: new Date().toISOString(),
			producer: task.id,
			retention: "run",
		},
		...overrides,
	};
}

const fault = (kind: LiveSessionFaultKind, countAsFault = true): LiveSessionFault => ({ kind, countAsFault });

async function waitForEvent(eventsPath: string, type: string, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await flushEventLogBuffer();
		if (readEvents(eventsPath).some((event) => event.type === type)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

function eventSummaries(eventsPath: string, type: string): Array<Record<string, unknown>> {
	return readEvents(eventsPath)
		.filter((event) => event.type === type)
		.map((event) => (event.data ?? {}) as Record<string, unknown>);
}

// ─── 1. Default-off no-op ─────────────────────────────────────────────────────

test("[u11-1a] resolveTaskRuntimeKind: inert embedded policy is byte-identical to pre-U11 for every guard combination", () => {
	const inert: CrewRuntimeConfig["embeddedWorkers"] = { enabled: false, roles: ["explorer"] };
	const combinations: Array<[Parameters<typeof resolveTaskRuntimeKind>[0], NodeJS.ProcessEnv]> = [
		["child-process", FLAT_ENV],
		["child-process", NESTED_ENV],
		["live-session", FLAT_ENV],
		["live-session", NESTED_ENV],
		["scaffold", FLAT_ENV],
	];
	for (const [kind, env] of combinations) {
		for (const isolation of [undefined, { isolatedRoles: ["explorer"] }, { defaultRuntime: "child-process" as const }]) {
			assert.equal(
				resolveTaskRuntimeKind(kind, "explorer", isolation, env, { policy: inert, faultCount: 5 }),
				resolveTaskRuntimeKind(kind, "explorer", isolation, env),
				`disabled policy must not change resolution for ${kind}/${JSON.stringify(isolation)}/${env.PI_CREW_DEPTH}`,
			);
			assert.equal(
				resolveTaskRuntimeKind(kind, "explorer", isolation, env, { policy: undefined, faultCount: 5 }),
				resolveTaskRuntimeKind(kind, "explorer", isolation, env),
				`absent policy must not change resolution for ${kind}/${JSON.stringify(isolation)}/${env.PI_CREW_DEPTH}`,
			);
		}
	}
});

test("[u11-1b] planEmbeddedTier: default-off / non-opted role → undefined plan, no events", () => {
	const { cwd, manifest, task } = makeFixture();
	try {
		for (const runtimeConfig of [undefined, {}, { embeddedWorkers: {} }, { embeddedWorkers: { roles: ["explorer"] } }] as Array<
			CrewRuntimeConfig | undefined
		>) {
			const plan = planEmbeddedTier({
				baseRuntimeKind: "child-process",
				role: "explorer",
				runtimeConfig,
				task,
				env: FLAT_ENV,
				manifest,
			});
			assert.equal(plan, undefined, `policy ${JSON.stringify(runtimeConfig?.embeddedWorkers)} must be inert`);
		}
		assert.equal(
			readEvents(manifest.eventsPath).some((event) => event.type.startsWith("tier.")),
			false,
			"default-off must emit NO tier.* events",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("[u11-1c] config parse: embeddedWorkers round-trips; invalid fields drop field-wise; absent stays absent", () => {
	const parsed = parseConfig({
		runtime: { embeddedWorkers: { enabled: true, roles: ["explorer"], maxConcurrent: 3, faultThreshold: 2 } },
	});
	assert.deepEqual(parsed.runtime?.embeddedWorkers, {
		enabled: true,
		roles: ["explorer"],
		maxConcurrent: 3,
		faultThreshold: 2,
	});

	const invalid = parseConfig({
		runtime: { embeddedWorkers: { enabled: "yes", roles: 5, maxConcurrent: 0, faultThreshold: -1 } },
	});
	assert.equal(invalid.runtime?.embeddedWorkers, undefined, "all-invalid block collapses to undefined (tier stays off)");

	const absent = parseConfig({ runtime: { maxTurns: 4 } });
	assert.equal(absent.runtime?.embeddedWorkers, undefined);

	assert.equal(
		Value.Check(PiTeamsConfigSchema, { runtime: { embeddedWorkers: { enabled: true, roles: ["explorer"] } } }),
		true,
		"schema must accept the new block (F19-1: types + schema + parse stay in sync)",
	);
});

// ─── 2. Role opt-in routing (resolver guards) ────────────────────────────────

test("[u11-2a] resolveTaskRuntimeKind: opted-in role upgrades child-process → live-session", () => {
	assert.equal(resolveTaskRuntimeKind("child-process", "explorer", undefined, FLAT_ENV, { policy: POLICY_ON }), "live-session");
	assert.equal(
		resolveTaskRuntimeKind("child-process", "verifier", undefined, FLAT_ENV, { policy: POLICY_ON }),
		"child-process",
		"non-opted role stays child-process",
	);
	// Explicit opt-in beats isolationPolicy.defaultRuntime.
	assert.equal(
		resolveTaskRuntimeKind("child-process", "explorer", { defaultRuntime: "child-process" }, FLAT_ENV, { policy: POLICY_ON }),
		"live-session",
	);
});

test("[u11-2b] resolveTaskRuntimeKind: isolatedRoles and scaffold beat embedded opt-in", () => {
	assert.equal(
		resolveTaskRuntimeKind("child-process", "explorer", { isolatedRoles: ["explorer"] }, FLAT_ENV, { policy: POLICY_ON }),
		"child-process",
		"crash-isolated role never leaves the subprocess tier",
	);
	assert.equal(
		resolveTaskRuntimeKind("scaffold", "explorer", undefined, FLAT_ENV, { policy: POLICY_ON }),
		"scaffold",
		"scaffold is never overridden",
	);
});

test("[u11-2c] resolveTaskRuntimeKind: fault budget exhausted → sticky subprocess (no upgrade)", () => {
	assert.equal(
		resolveTaskRuntimeKind("child-process", "explorer", undefined, FLAT_ENV, { policy: POLICY_ON, faultCount: 2 }),
		"child-process",
	);
	assert.equal(
		resolveTaskRuntimeKind("child-process", "explorer", undefined, FLAT_ENV, {
			policy: { ...POLICY_ON, faultThreshold: 1 },
			faultCount: 1,
		}),
		"child-process",
		"configurable threshold respected",
	);
	assert.equal(resolveEmbeddedFaultThreshold(POLICY_ON), 2);
	assert.equal(resolveEmbeddedFaultThreshold({ enabled: true }), DEFAULT_EMBEDDED_FAULT_THRESHOLD);
});

test("[u11-2d] planEmbeddedTier: routes embedded + emits tier.decision; base live-session is NOT a hybrid route", async () => {
	const { cwd, manifest, task } = makeFixture();
	try {
		const plan = planEmbeddedTier({
			baseRuntimeKind: "child-process",
			role: "explorer",
			runtimeConfig: { embeddedWorkers: POLICY_ON },
			task,
			env: FLAT_ENV,
			manifest,
		});
		assert.equal(plan?.route, "embedded");
		assert.equal(plan?.threshold, 2);
		assert.ok(await waitForEvent(manifest.eventsPath, "tier.decision"), "tier.decision must be emitted for the routed task");
		const decision = eventSummaries(manifest.eventsPath, "tier.decision")[0]!;
		assert.equal(decision.route, "embedded");
		assert.equal(decision.reason, "role-opt-in");

		// Legacy live-session mode: pre-U11 semantics preserved (frozen path).
		assert.equal(
			planEmbeddedTier({
				baseRuntimeKind: "live-session",
				role: "explorer",
				runtimeConfig: { embeddedWorkers: POLICY_ON },
				task,
				env: FLAT_ENV,
				manifest,
			}),
			undefined,
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── 5. Depth guard unchanged (+ extended to the embedded path) ──────────────

test("[u11-5a] depth guard: pre-U11 rule unchanged — live-session at depth>0 stays child-process", () => {
	assert.equal(resolveTaskRuntimeKind("live-session", "explorer", undefined, NESTED_ENV), "child-process");
	assert.equal(resolveTaskRuntimeKind("live-session", "explorer", undefined, FLAT_ENV), "live-session");
	// Test-harness exception preserved.
	assert.equal(
		resolveTaskRuntimeKind("live-session", "explorer", undefined, { PI_CREW_DEPTH: "1", PI_CREW_MOCK_LIVE_SESSION: "success" }),
		"live-session",
	);
});

test("[u11-5b] depth guard EXTENDED to the embedded upgrade: opted-in role at depth>0 stays child-process", () => {
	assert.equal(
		resolveTaskRuntimeKind("child-process", "explorer", undefined, NESTED_ENV, { policy: POLICY_ON }),
		"child-process",
		"embedded session must never nest inside a pi-crew worker",
	);
	assert.equal(
		resolveTaskRuntimeKind(
			"child-process",
			"explorer",
			undefined,
			{ PI_CREW_DEPTH: "1", PI_CREW_MOCK_LIVE_SESSION: "success" },
			{ policy: POLICY_ON },
		),
		"live-session",
		"mock-harness exception applies to the embedded path too",
	);
	const { cwd, manifest, task } = makeFixture();
	try {
		assert.equal(
			planEmbeddedTier({
				baseRuntimeKind: "child-process",
				role: "explorer",
				runtimeConfig: { embeddedWorkers: POLICY_ON },
				task,
				env: NESTED_ENV,
				manifest,
			}),
			undefined,
			"planner is inert when nested (no mock)",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── 3. 2-fault fallback state machine ───────────────────────────────────────

test("[u11-3a] fault ledger: persistEmbeddedFault round-trips durably through tasks.json", async () => {
	const { cwd, manifest, task, tasks } = makeFixture();
	try {
		assert.equal(readEmbeddedFaultCount(task), 0);
		const first = persistEmbeddedFault(manifest, tasks, task, fault("hung-tool"));
		assert.equal(first.faultCount, 1);
		const second = persistEmbeddedFault(manifest, first.tasks, first.task, fault("response-timeout"));
		assert.equal(second.faultCount, 2);
		// Durability: the count survives a fresh read from the manifest store
		// (sticky downgrade across retries/recovery re-dispatch). Non-terminal
		// task writes ride the 50ms coalesce buffer — flush before re-reading.
		await flushPendingAtomicWrites();
		const reloaded = loadRunManifestById(cwd, manifest.runId);
		const reloadedTask = reloaded?.tasks.find((t) => t.id === task.id);
		assert.ok(reloadedTask, "persisted task must be reloadable");
		assert.equal(readEmbeddedFaultCount(reloadedTask!), 2);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("[u11-3b] runEmbeddedTier: fault #1 stays live (counted, tier.fault), fault #2 → fallback (tier.fallback)", async () => {
	const { cwd, manifest, task, tasks } = makeFixture();
	try {
		__test_resetEmbeddedCeiling();
		const plan = { route: "embedded" as const, policy: POLICY_ON, faultCount: 0, threshold: 2 };
		const failing = async () =>
			makeLiveOutcome(manifest, task, {
				exitCode: 1,
				error: "boom",
				fault: { kind: "session-error", detail: "boom", countAsFault: true },
			});

		const first = await runEmbeddedTier({ plan, manifest, task, tasks, runLive: failing });
		assert.equal(first.kind, "live", "first fault returns the (failed) live outcome — retry loop owns the next attempt");
		if (first.kind === "live") {
			assert.equal(first.faultCounted?.faultCount, 1);
			assert.equal(readEmbeddedFaultCount(first.live.task), 1);
		}
		assert.ok(await waitForEvent(manifest.eventsPath, "tier.fault"), "tier.fault emitted");

		const second = await runEmbeddedTier({
			plan,
			manifest,
			task: first.kind === "live" ? first.live.task : task,
			tasks,
			runLive: failing,
		});
		assert.equal(second.kind, "fallback", "second fault crosses the 2-fault threshold → subprocess reroute decision");
		if (second.kind === "fallback") {
			assert.equal(second.reason, "fault-threshold");
			assert.equal(second.faultCount, 2);
		}
		assert.ok(await waitForEvent(manifest.eventsPath, "tier.fallback"), "tier.fallback emitted");
		const fallbackEvent = eventSummaries(manifest.eventsPath, "tier.fallback")[0]!;
		assert.equal(fallbackEvent.reason, "fault-threshold");
		assert.equal(fallbackEvent.faultCount, 2);
	} finally {
		__test_resetEmbeddedCeiling();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("[u11-3c] runEmbeddedTier: aborted and capacity-rejected faults NEVER count; capacity-rejected reroutes immediately", async () => {
	const { cwd, manifest, task, tasks } = makeFixture();
	try {
		__test_resetEmbeddedCeiling();
		const plan = { route: "embedded" as const, policy: POLICY_ON, faultCount: 0, threshold: 2 };

		const aborted = await runEmbeddedTier({
			plan,
			manifest,
			task,
			tasks,
			runLive: async () =>
				Promise.resolve(
					makeLiveOutcome(manifest, task, {
						exitCode: 1,
						error: "aborted",
						fault: { kind: "aborted", detail: "aborted", countAsFault: false },
					}),
				),
		});
		assert.equal(aborted.kind, "live");
		if (aborted.kind === "live") assert.equal(aborted.faultCounted, undefined, "aborted attempt is not counted");
		assert.equal(readEmbeddedFaultCount(task), 0, "ledger untouched by abort");

		const capacity = await runEmbeddedTier({
			plan,
			manifest,
			task,
			tasks,
			runLive: async () =>
				Promise.resolve(
					makeLiveOutcome(manifest, task, {
						exitCode: 1,
						error: "Embedded tier at capacity",
						fault: { kind: "capacity-rejected", detail: "full", countAsFault: false },
					}),
				),
		});
		assert.equal(capacity.kind, "fallback", "capacity-rejected reroutes to subprocess");
		if (capacity.kind === "fallback") assert.equal(capacity.reason, "embedded-capacity-rejected");
		assert.equal(readEmbeddedFaultCount(task), 0, "capacity rejection is a routing signal, not a worker fault");
	} finally {
		__test_resetEmbeddedCeiling();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("[u11-3d] runEmbeddedTier: thrown attempt counts as session-error; rethrows below threshold, falls back at threshold", async () => {
	const { cwd, manifest, task, tasks } = makeFixture();
	try {
		__test_resetEmbeddedCeiling();
		const plan = { route: "embedded" as const, policy: { ...POLICY_ON, faultThreshold: 1 }, faultCount: 0, threshold: 1 };
		const thrown = await runEmbeddedTier({
			plan,
			manifest,
			task,
			tasks,
			runLive: () => Promise.reject(new Error("live executor exploded")),
		});
		assert.equal(thrown.kind, "fallback", "threshold 1 → thrown fault immediately reroutes");
		if (thrown.kind === "fallback") assert.equal(thrown.fault?.kind, "session-error");

		const plan2 = { route: "embedded" as const, policy: POLICY_ON, faultCount: 0, threshold: 2 };
		// Fresh fixture: the first scenario already wrote count=1 into the shared
		// task's durable ledger — the sticky merge would (correctly) push the
		// next fault to 2. Isolate the below-threshold rethrow on a clean task.
		const fresh = makeFixture();
		try {
			await assert.rejects(
				runEmbeddedTier({
					plan: plan2,
					manifest: fresh.manifest,
					task: fresh.task,
					tasks: fresh.tasks,
					runLive: () => Promise.reject(new Error("boom")),
				}),
				/boom/,
				"below threshold the throw propagates (pre-U11 contract for a throwing live attempt)",
			);
			// The rethrown fault still counted — sticky ledger survives to the retry.
			const afterThrow = loadRunManifestById(fresh.cwd, fresh.manifest.runId)?.tasks.find((t) => t.id === fresh.task.id);
			assert.ok(afterThrow, "task persisted after thrown attempt");
			assert.equal(readEmbeddedFaultCount(afterThrow!), 1, "thrown attempt counted toward the ledger");
		} finally {
			fs.rmSync(fresh.cwd, { recursive: true, force: true });
		}
	} finally {
		__test_resetEmbeddedCeiling();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("[u11-3e] planEmbeddedTier: sticky downgrade after 2 faults → subprocess route + decision event", async () => {
	const { cwd, manifest, task } = makeFixture();
	try {
		const faulted: TeamTaskState = {
			...task,
			diagnostics: { embeddedTier: { faultCount: 2, lastFaultKind: "hung-tool", lastFaultAt: new Date().toISOString() } },
		};
		const plan = planEmbeddedTier({
			baseRuntimeKind: "child-process",
			role: "explorer",
			runtimeConfig: { embeddedWorkers: POLICY_ON },
			task: faulted,
			env: FLAT_ENV,
			manifest,
		});
		assert.equal(plan?.route, "subprocess");
		if (plan?.route === "subprocess") assert.equal(plan.reason, "fault-threshold");
		assert.ok(
			await waitForDecisionEvent(manifest.eventsPath, "fault-threshold"),
			"sticky downgrade emits tier.decision(reason=fault-threshold)",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

async function waitForDecisionEvent(eventsPath: string, reason: string, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await flushEventLogBuffer();
		if (eventSummaries(eventsPath, "tier.decision").some((data) => data.reason === reason)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

// ─── 4. Budget contention across tiers ───────────────────────────────────────

test("[u11-4a] shared budget: an in-flight embedded attempt holds the SAME global worker slot a subprocess spawn needs", async () => {
	const prevCap = getWorkerCapCapacity();
	const { cwd, manifest, task, tasks } = makeFixture();
	try {
		__test_resetCap(1);
		__test_resetEmbeddedCeiling();
		let releaseLive!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseLive = resolve;
		});
		const plan = { route: "embedded" as const, policy: POLICY_ON, faultCount: 0, threshold: 2 };
		const embedded = runEmbeddedTier({
			plan,
			manifest,
			task,
			tasks,
			runLive: async () => {
				await gate;
				return makeLiveOutcome(manifest, task);
			},
		});
		// Let the embedded attempt acquire the ONLY slot.
		await new Promise((resolve) => setTimeout(resolve, 100));
		let subprocessGranted = false;
		const subprocessAcquire = acquireWorkerSlot().then(() => {
			subprocessGranted = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(subprocessGranted, false, "subprocess-tier acquire must be BLOCKED while the embedded attempt holds the shared slot");
		releaseLive();
		const outcome = await embedded;
		assert.equal(outcome.kind, "live", "embedded attempt completes cleanly (no fault)");
		await subprocessAcquire;
		assert.equal(subprocessGranted, true, "slot transfers to the subprocess tier after the embedded attempt releases");
		releaseWorkerSlot(); // return the probe's slot
	} finally {
		__test_resetCap(prevCap);
		__test_resetEmbeddedCeiling();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("[u11-4b] embedded ceiling: fail-fast reroute (never queue) when maxConcurrent is exhausted", async () => {
	const prevCap = getWorkerCapCapacity();
	const { cwd, manifest, task, tasks } = makeFixture();
	const otherTask: TeamTaskState = { ...task, id: `${task.id}-b` };
	try {
		__test_resetCap(8);
		__test_resetEmbeddedCeiling();
		const policy = { ...POLICY_ON, maxConcurrent: 1 };
		const plan = { route: "embedded" as const, policy, faultCount: 0, threshold: 2 };
		let releaseFirst!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = runEmbeddedTier({
			plan,
			manifest,
			task,
			tasks,
			runLive: async () => {
				await gate;
				return makeLiveOutcome(manifest, task);
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 100));

		const second = await runEmbeddedTier({
			plan,
			manifest,
			task: otherTask,
			tasks,
			runLive: () => Promise.resolve(makeLiveOutcome(manifest, otherTask)),
		});
		assert.equal(second.kind, "fallback", "ceiling exhaustion reroutes immediately");
		if (second.kind === "fallback") {
			assert.equal(second.reason, "embedded-ceiling-exhausted");
			assert.equal(second.faultCount, 0, "ceiling reroute is not a fault");
		}

		releaseFirst();
		const outcome = await first;
		assert.equal(outcome.kind, "live", "first embedded attempt unaffected");
	} finally {
		__test_resetCap(prevCap);
		__test_resetEmbeddedCeiling();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── E2E wiring through runTeamTask ───────────────────────────────────────────

const agent = {
	name: "explorer",
	description: "u11 explorer",
	source: "builtin",
	filePath: "explorer.md",
	systemPrompt: "",
} as const;

function setEnv(name: string, value: string | undefined, prev: Map<string, string | undefined>): void {
	prev.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function restoreEnv(prev: Map<string, string | undefined>): void {
	for (const [name, value] of prev) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

test("[u11-e2e-1] default-off no-op at runTeamTask level: child-process mock path unchanged, ZERO tier events", async () => {
	const { cwd, manifest, tasks, task } = makeFixture();
	const prev = new Map<string, string | undefined>();
	setEnv("PI_TEAMS_MOCK_CHILD_PI", "json-success", prev);
	setEnv("PI_CREW_ALLOW_MOCK", "1", prev);
	try {
		const result = await runTeamTask({
			manifest,
			tasks,
			task,
			step: { id: "explore", role: "explorer", task: "do the recon" },
			agent,
			executeWorkers: true,
			runtimeKind: "child-process",
			workspaceId: cwd,
		});
		const done = result.tasks.find((t) => t.id === task.id)!;
		assert.equal(done.status, "completed", "default config keeps the exact child-process behavior");
		await flushEventLogBuffer();
		assert.equal(
			readEvents(manifest.eventsPath).some((event) => event.type.startsWith("tier.")),
			false,
			"no tier.* events with default (policy-off) config",
		);
	} finally {
		restoreEnv(prev);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("[u11-e2e-2] embedded routing E2E: opted-in role runs the in-process live-session mock and emits tier.decision", async () => {
	const { cwd, manifest, tasks, task } = makeFixture();
	const prev = new Map<string, string | undefined>();
	setEnv("PI_CREW_MOCK_LIVE_SESSION", "success", prev);
	setEnv("PI_TEAMS_MOCK_CHILD_PI", undefined, prev);
	try {
		const result = await runTeamTask({
			manifest,
			tasks,
			task,
			step: { id: "explore", role: "explorer", task: "do the recon" },
			agent,
			executeWorkers: true,
			runtimeKind: "child-process",
			runtimeConfig: { embeddedWorkers: { enabled: true, roles: ["explorer"] } },
			workspaceId: cwd,
		});
		const done = result.tasks.find((t) => t.id === task.id)!;
		assert.equal(done.status, "completed", "embedded-routed task completes via the live-session mock");
		assert.ok(await waitForEvent(manifest.eventsPath, "tier.decision"), "tier.decision emitted for the routed task");
		const decision = eventSummaries(manifest.eventsPath, "tier.decision")[0]!;
		assert.equal(decision.route, "embedded");
		assert.equal(decision.from, "child-process");
		// The mock live path produced the result artifact.
		const resultPath = path.join(manifest.artifactsRoot, "results", `${task.id}.txt`);
		assert.ok(fs.existsSync(resultPath), "live result artifact written");
		assert.match(fs.readFileSync(resultPath, "utf-8"), /Mock live-session success/, "mock live output is the task result");
		// No fallback, no faults.
		assert.equal(
			readEvents(manifest.eventsPath).some((event) => event.type === "tier.fault" || event.type === "tier.fallback"),
			false,
			"clean embedded attempt: no fault/fallback events",
		);
	} finally {
		restoreEnv(prev);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Fault classification fallback (Phase-1 interface contract) ──────────────

test("[u11-f1] classifyLiveTaskFault: marker ordering — hung-tool beats timeout/abort text overlap; abort never counts", () => {
	assert.deepEqual(classifyLiveTaskFault(undefined, "", 0), undefined);
	assert.deepEqual(classifyLiveTaskFault(undefined, "", null), undefined);
	const hung = classifyLiveTaskFault(
		"Live-session hung: prompt did not settle within 10000ms after the 30000ms timeout and cooperative abort — dropping session reference (escape hatch).",
		"",
		1,
	);
	assert.equal(hung?.kind, "hung-tool");
	assert.equal(hung?.countAsFault, true);
	assert.equal(classifyLiveTaskFault("session aborted by leader", "", 1)?.kind, "aborted");
	assert.equal(classifyLiveTaskFault("session aborted by leader", "", 1)?.countAsFault, false);
	assert.equal(classifyLiveTaskFault("request timed out", "", 1)?.kind, "response-timeout");
	assert.equal(classifyLiveTaskFault("some error", "", 1)?.kind, "session-error");
	assert.equal(classifyLiveTaskFault(undefined, "", 3)?.kind, "nonzero-exit");
	assert.equal(
		classifyLiveTaskFault(undefined, "stderr noise", 1)?.kind,
		"nonzero-exit",
		"stderr-only result without an error string classifies as nonzero-exit",
	);
});
