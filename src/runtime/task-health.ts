export type HealthGrade = "A" | "B" | "C" | "D" | "F";

export interface HealthPenalty {
	reason: string;
	deduction: number;
}

export interface HealthDelta {
	metric: string;
	delta: number;
	trend: "improving" | "degrading" | "stable";
}

export interface RunHealth {
	score: number;
	grade: HealthGrade;
	penalties: HealthPenalty[];
	deltas: HealthDelta[];
}

const STALLED_THRESHOLD_MS = 5 * 60 * 1000;

export function scoreToGrade(score: number): HealthGrade {
	if (score >= 90) return "A";
	if (score >= 70) return "B";
	if (score >= 50) return "C";
	if (score >= 30) return "D";
	return "F";
}

export interface TaskSummary {
	id: string;
	status: string;
	stalledSince?: number;
	/** L-6 (2026-10-16): last worker heartbeat (tasks already carry
	 *  `heartbeat.lastSeenAt` — no new writer needed). Preferred over
	 *  `stalledSince`, which has no writer. */
	heartbeat?: { lastSeenAt: string };
}

export interface ManifestSummary {
	runId: string;
	tasks: TaskSummary[];
	createdAt: string;
}

export function computeRunHealth(manifest: ManifestSummary): RunHealth {
	const penalties: HealthPenalty[] = [];
	const tasks = manifest.tasks;
	const taskCount = tasks.length;
	if (taskCount === 0) return { score: 100, grade: "A", penalties: [], deltas: [] };

	const failedCount = tasks.filter((t) => t.status === "failed").length;
	// L-6: stall detection derived from the task's own heartbeat (already
	// written by worker heartbeat tracking — no new writer). Only RUNNING
	// tasks can stall. `stalledSince` (no known writer) stays as a fallback
	// for summaries without heartbeat data.
	const stalledCount = tasks.filter((t) => {
		if (t.status !== "running") return false;
		if (t.heartbeat) {
			const lastSeenAt = Date.parse(t.heartbeat.lastSeenAt);
			return Number.isFinite(lastSeenAt) && Date.now() - lastSeenAt > STALLED_THRESHOLD_MS;
		}
		return t.stalledSince !== undefined && Date.now() - t.stalledSince > STALLED_THRESHOLD_MS;
	}).length;

	const failureRate = failedCount / taskCount;
	if (failureRate > 0.2) {
		penalties.push({
			reason: "high-failure-rate",
			deduction: Math.round(failureRate * 50),
		});
	}

	if (stalledCount > 0) {
		penalties.push({
			reason: "stalled-tasks",
			deduction: Math.min(15, stalledCount * 5),
		});
	}

	if (taskCount > 20) {
		penalties.push({
			reason: "large-task-count",
			deduction: Math.min(10, Math.floor((taskCount - 20) / 10)),
		});
	}

	const totalDeduction = penalties.reduce((sum, p) => sum + p.deduction, 0);
	const score = Math.max(0, Math.min(100, 100 - totalDeduction));

	return {
		score,
		grade: scoreToGrade(score),
		penalties,
		deltas: [],
	};
}
