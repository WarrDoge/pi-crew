/**
 * M3-1 (UI-AUDIT P0-2/P1-1): wire the terminal-status controller (tab title +
 * Ghostty OSC 9;4 progress) to the runEventBus.
 *
 * History: `src/ui/terminal-status.ts` shipped in v0.8.3 (819d71ad) with unit
 * tests but NO construction site — `ctx.terminalStatus` was never assigned, so
 * the feature never ran. This module is the missing wire, installed once from
 * `register.ts` in place of the old no-op cleanup handler.
 *
 * Design:
 *   - Subscribe to `runEventBus.onAny` and debounce evaluation (250ms) so a
 *     burst of task events collapses into one state transition.
 *   - State is derived from `listLiveAgents()`: >0 live → active; 0 → idle.
 *     `ctx.terminalStatusActive` (already in RegistrationContext) is the single
 *     source of truth for the current phase, so `runtime-cleanup.ts` resetting
 *     it also resets this state machine on the next event.
 *   - On the idle transition, `onRunCompleted()` fires the green Ghostty flash
 *     and `onIdle()` runs COMPLETE_FLASH_MS later (title restore + re-assert
 *     loop), so the flash is visible before the bar clears.
 *   - The `TerminalStatusUi` adapter reads `ctx.currentCtx` dynamically (getter
 *     + call-time lookup), so a session swap never leaves the controller
 *     holding a stale session's `ui.setTitle` (the P1-10 class of bug).
 *   - Everything is best-effort and guarded by `hasUI`: headless / subagent
 *     contexts evaluate to a no-op and write nothing.
 *   - All timers are `unref()`-ed; dispose unsubscribes, clears timers and
 *     disposes the controller (registered via `registerCleanupHandler`, which
 *     replaces the old no-op `disposeTerminalStatus` handler in register.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PATHS } from "../../config/defaults.ts";
import { listLiveAgents } from "../../runtime/live-session/live-agent-manager.ts";
import { activeRunEntries } from "../../state/stores/active-run-registry.ts";
import { runEventBus } from "../../ui/run-event-bus.ts";
import {
	buildCrewTitleSegment,
	COMPLETE_FLASH_MS,
	createTerminalStatusController,
	type ProgramStatusKind,
	setTerminalTitle,
	type TerminalStatusController,
	type TerminalStatusUi,
} from "../../ui/terminal-status.ts";
import { projectCrewRoot } from "../../utils/paths.ts";
import { registerCleanupHandler } from "../crew-cleanup.ts";

/**
 * B-1 (OSC 7501 program-status): the blocked-state the wiring reports when a
 * crew is waiting on the USER. Sources (research round 2, cold-verified):
 * plan-approval gate, `ask`/wait park (crew-broker handleWaitRequest →
 * manifest.waitState), stuck-blocked subagent records. All map to protocol
 * kind `question` (waiting on a human decision/answer).
 */
export interface TerminalBlockedSignal {
	kind: ProgramStatusKind;
	message: string;
}

/**
 * Parked-wait freshness window. The broker server-clamps every park deadline
 * to ≤1h (WAIT_REQUEST_TIMEOUT_SEC_MAX = 3600, request-parsers.ts:127), so a
 * `manifest.waitState` older than this is a leaked marker (ask timed out and
 * the worker resumed) — it must NOT keep the terminal showing "blocked".
 * 1h + 5min clock slack.
 */
const WAIT_STATE_FRESH_MS = 65 * 60 * 1000;
/** Cap on manifests inspected per evaluation (registry returns ≤64 entries). */
const MAX_BLOCKED_RUNS = 16;
/** Cap on subagent record files scanned per project crew root. */
const MAX_SUBAGENT_FILES = 50;

/**
 * Structural subset of RegistrationContext this module needs. Declared
 * locally (not imported) so tests can pass a 3-field fake without building
 * the full context, while `register.ts` passes the real context unchanged.
 */
export interface TerminalStatusWiringDeps {
	currentCtx: { hasUI: boolean; ui: { setTitle(title: string): void } } | undefined;
	terminalStatus: TerminalStatusController | undefined;
	terminalStatusActive: boolean;
}

/** Debounce window that collapses an event burst into one evaluation. */
const EVAL_DEBOUNCE_MS = 250;

/**
 * Live-agent probe (dependency inversion for tests). Production reads the real
 * registry; tests inject a deterministic count source.
 */
let liveAgentProbe: () => number = () => listLiveAgents().length;

/** @internal Re-subscribe guard: unsubscribe fn from a previous registration. */
let currentUnsubscribe: (() => void) | undefined;
/** @internal Latest install's full dispose (unsubscribe + timers + controller). */
let currentDispose: (() => void) | undefined;

/**
 * Blocked-state probe (dependency inversion for tests — same pattern as
 * liveAgentProbe). Production derives from durable run state so the signal
 * survives process boundaries (a detached broker parks the task; the host
 * extension process re-reads the manifest on the next wake event).
 */
let blockedProbe: () => TerminalBlockedSignal | undefined = deriveTerminalBlockedSignal;

// ── B-1: blocked-state derivation (pure, no-throw) ─────────────────────

function readJsonFileSync(file: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Blocked-signal for one run manifest (exported for unit tests — pure).
 * Mirrors `isPlanApprovalStatePending` (runtime/plan-approval.ts:
 * `required === true && status === "pending"`) inline rather than importing
 * it, so this registration-path module does not pull the plan-store/
 * state-store graph into cold start; pinned against drift by
 * terminal-status-wiring.test.ts.
 */
export function blockedSignalFromManifest(manifest: Record<string, unknown>, now = Date.now()): TerminalBlockedSignal | undefined {
	const approval = manifest.planApproval as Record<string, unknown> | undefined;
	if (approval?.required === true && approval.status === "pending") {
		return { kind: "question", message: "plan approval pending" };
	}
	const waitState = manifest.waitState as Record<string, unknown> | undefined;
	const askedAt = typeof waitState?.askedAt === "string" ? Date.parse(waitState.askedAt) : Number.NaN;
	if (Number.isFinite(askedAt) && now - askedAt <= WAIT_STATE_FRESH_MS) {
		const taskId = typeof waitState?.taskId === "string" ? waitState.taskId : "task";
		return { kind: "question", message: `task ${taskId} waiting for leader` };
	}
	return undefined;
}

/**
 * First stuck-blocked subagent id under a project crew root (exported for
 * unit tests). Reads persisted records only — the in-process manager may not
 * exist in this process (child spawns). No-throw, best-effort.
 */
export function blockedSignalFromSubagentDir(crewRoot: string): string | undefined {
	if (!crewRoot) return undefined;
	let files: string[];
	try {
		files = fs.readdirSync(path.join(crewRoot, DEFAULT_PATHS.state.subagentsSubdir)) as string[];
	} catch {
		return undefined; // dir absent / unreadable — no subagents
	}
	for (const file of files.filter((f) => f.endsWith(".json")).slice(0, MAX_SUBAGENT_FILES)) {
		const record = readJsonFileSync(path.join(crewRoot, DEFAULT_PATHS.state.subagentsSubdir, file));
		if (record?.status === "blocked") {
			return typeof record.id === "string" ? record.id : file.slice(0, -5);
		}
	}
	return undefined;
}

/** Default blocked-state derivation: durable active runs → signal. No-throw. */
function deriveTerminalBlockedSignal(): TerminalBlockedSignal | undefined {
	let entries: ReturnType<typeof activeRunEntries>;
	try {
		entries = activeRunEntries();
	} catch {
		return undefined;
	}
	for (const entry of entries.slice(0, MAX_BLOCKED_RUNS)) {
		const manifest = readJsonFileSync(entry.manifestPath);
		if (!manifest) continue;
		const signal = blockedSignalFromManifest(manifest);
		if (signal) return { kind: signal.kind, message: `${signal.message} · ${entry.runId}` };
		// Subagent records live under the RUN's project crew root, not user root.
		try {
			const subId = blockedSignalFromSubagentDir(projectCrewRoot(entry.cwd));
			if (subId) return { kind: "question", message: `subagent ${subId} blocked · ${entry.runId}` };
		} catch {
			// unreadable project root — skip
		}
	}
	return undefined;
}

/** Test seam: override the live-agent source (restore with `() => default`). */
export function __test__setLiveAgentProbe(probe: () => number): void {
	liveAgentProbe = probe;
}

/** Test seam: override the blocked-state source (restore with `() => derive…`). */
export function __test__setBlockedProbe(probe: () => TerminalBlockedSignal | undefined): void {
	blockedProbe = probe;
}

/** Test seam: fully dispose any wiring left by a previous install in this process. */
export function __test__resetTerminalStatusWiring(): void {
	currentDispose?.();
	currentDispose = undefined;
	currentUnsubscribe = undefined;
}

export function installTerminalStatus(pi: ExtensionAPI, deps: TerminalStatusWiringDeps): void {
	// A previous registration in this process must not leave a second
	// subscription behind (registerCleanupHandler only keeps the latest
	// dispose fn, so an older subscription would leak otherwise).
	currentUnsubscribe?.();

	// Dynamic adapter: resolves the CURRENT session's UI at call time, so the
	// controller never captures a session-scoped reference.
	const adapter: TerminalStatusUi = {
		get hasUI(): boolean {
			return deps.currentCtx?.hasUI ?? false;
		},
		ui: {
			setTitle(title: string): void {
				deps.currentCtx?.ui.setTitle(title);
			},
		},
	};

	let evalTimer: ReturnType<typeof setTimeout> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let lastSegment = "";
	/** B-1 dedupe: last blocked-signal key — never re-emit OSC 7501 per event. */
	let lastBlockedKey = "";

	const clearTimers = (): void => {
		if (evalTimer) {
			clearTimeout(evalTimer);
			evalTimer = undefined;
		}
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};

	const evaluate = (): void => {
		evalTimer = undefined;
		if (!adapter.hasUI) return;
		if (!deps.terminalStatus) deps.terminalStatus = createTerminalStatusController(adapter);
		const controller = deps.terminalStatus;

		// B-1 (OSC 7501): blocked-state takes precedence over the active/idle
		// lifecycle — a parked task or pending plan approval is waiting on the
		// USER even when zero live-session agents exist (child-process runs).
		let blocked: TerminalBlockedSignal | undefined;
		try {
			blocked = blockedProbe();
		} catch {
			blocked = undefined; // probe is best-effort, never fails the eval
		}
		if (blocked) {
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = undefined;
			}
			deps.terminalStatusActive = true; // blocked counts as active for the lifecycle
			const key = `${blocked.kind}|${blocked.message}`;
			if (key !== lastBlockedKey) {
				lastBlockedKey = key;
				controller.onBlocked(blocked.kind, blocked.message);
			}
			return;
		}
		const wasBlocked = lastBlockedKey !== "";
		lastBlockedKey = "";

		if (liveAgentProbe() > 0) {
			// Active: cancel any pending idle transition, then (re)assert.
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = undefined;
			}
			if (!deps.terminalStatusActive) {
				deps.terminalStatusActive = true;
				controller.onRunsActive(); // title (best-effort) + Ghostty INDETERMINATE + 7501 working
				lastSegment = buildCrewTitleSegment();
				return;
			}
			// Blocked just cleared while still active: re-assert working so the
			// 7501 channel does not linger on "blocked" (one-off, transition-only).
			if (wasBlocked) controller.onRunsActive();
			// Still active: refresh the title only when the role summary changed
			// (never re-emit the OSC sequence — state 3 persists on its own).
			const segment = buildCrewTitleSegment();
			if (segment && segment !== lastSegment) {
				lastSegment = segment;
				setTerminalTitle(adapter, segment);
			}
			return;
		}

		if (deps.terminalStatusActive) {
			deps.terminalStatusActive = false;
			lastSegment = "";
			controller.onRunCompleted(); // green flash, self-re-evaluates after COMPLETE_FLASH_MS
			idleTimer = setTimeout(() => {
				idleTimer = undefined;
				controller.onIdle(); // title restore + idle re-assert loop + Ghostty CLEAR + 7501 idle
			}, COMPLETE_FLASH_MS);
			idleTimer.unref?.();
		}
	};

	const unsubscribe = runEventBus.onAny(() => {
		if (evalTimer) return;
		evalTimer = setTimeout(evaluate, EVAL_DEBOUNCE_MS);
		evalTimer.unref?.();
	});
	currentUnsubscribe = unsubscribe;
	const dispose = (): void => {
		unsubscribe();
		currentUnsubscribe = undefined;
		currentDispose = undefined;
		clearTimers();
		deps.terminalStatus?.dispose();
		deps.terminalStatus = undefined;
		deps.terminalStatusActive = false;
	};
	currentDispose = dispose;

	registerCleanupHandler(pi, { disposeTerminalStatus: dispose });
}
