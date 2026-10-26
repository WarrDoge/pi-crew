import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import { heartbeatLiveForDisplay, isDisplayActiveRun } from "../runtime/process-status.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { readJsonFileCoalesced } from "../utils/file-coalescer.ts";
import { extractSessionId } from "../utils/session-utils.ts";
import { listRuns } from "./run-index.ts";

/** Tasks-read TTL for the one-shot toast's heartbeat check (coalesced, live-run-sidebar pattern). */
const SUMMARY_TASKS_READ_TTL_MS = 1000;

/**
 * Wave 16 (residual render wiring, GAP-4): coalesced tasks.json read for the
 * active-runs toast — clones agents-jobs-browser's readLegacyRunTasks. Returns
 * undefined on unreadable so a broken tasks.json can NEVER fabricate liveness
 * evidence (fail-closed).
 */
function readSummaryRunTasks(run: TeamRunManifest): TeamTaskState[] | undefined {
	const parse = (): TeamTaskState[] => {
		if (!existsSync(run.tasksPath)) return [];
		const parsed = JSON.parse(readFileSync(run.tasksPath, "utf-8")) as unknown;
		return Array.isArray(parsed) ? (parsed as TeamTaskState[]) : [];
	};
	try {
		return readJsonFileCoalesced(run.tasksPath, SUMMARY_TASKS_READ_TTL_MS, parse);
	} catch {
		return undefined;
	}
}

export function notifyActiveRuns(ctx: ExtensionContext): void {
	const sid = extractSessionId(ctx);
	const active = listRuns(ctx.cwd)
		.filter((run) => {
			// Vector #11: never surface another session's runs in the active-runs
			// toast — session B must not advertise session A's in-flight runs.
			if (sid && run.ownerSessionId && run.ownerSessionId !== sid) return false;
			if (run.status !== "queued" && run.status !== "planning" && run.status !== "running") return false;
			// Use the same display filter as the widget/powerbar — runs without
			// real agent evidence (e.g. integration test fixtures) must not appear.
			const agents = readCrewAgents(run);
			if (isDisplayActiveRun(run, agents)) return true;
			// Wave 16: this is a ONE-SHOT toast, so the lazy coalesced tasks read is
			// in-pattern I/O — fetched ONLY when the display predicate is about to
			// call the run inactive, so a manifest frozen mid-long-tool (fresh task
			// heartbeats, no agent progress) still gets advertised.
			return heartbeatLiveForDisplay(run, readSummaryRunTasks(run));
		})
		.slice(0, 5);
	if (active.length === 0) return;
	ctx.ui.notify(`pi-crew active runs: ${active.map((run) => `${run.runId} [${run.status}]`).join(", ")}`, "info");
}
