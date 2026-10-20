export type ScheduleType = "cron" | "once" | "interval";

export interface ScheduledJob {
	id: string;
	name: string;
	description: string;
	schedule: string;
	scheduleType: ScheduleType;
	intervalMs?: number;
	subagentType: string;
	prompt: string;
	enabled: boolean;
	createdAt: string;
	lastRun?: string;
	lastStatus?: "success" | "error" | "running";
	nextRun?: string;
	runCount: number;
	/** Run IDs spawned by this job. Used to cancel runs when job is removed. */
	spawnedRunIds?: string[];
}

export type ScheduleChangeEvent =
	| { type: "added"; job: ScheduledJob }
	| { type: "removed"; jobId: string; spawnedRunIds?: string[] }
	| { type: "updated"; job: ScheduledJob }
	| { type: "fired"; jobId: string; agentId: string; name: string }
	| { type: "skipped"; jobId: string; reason: string }
	| { type: "error"; jobId: string; error: string };

export interface CrewSchedulerOptions {
	/** Injectable clock for tests. Defaults to real time (`new Date()`). */
	now?: () => Date;
}

/** Node clamps setTimeout delays > 2^31-1 ms to fire ~immediately; longer
 * waits (e.g. a yearly cron) must be chained in hops below this ceiling. */
const MAX_TIMER_DELAY_MS = 2_147_483_000;

/** R2-M-B4 (SEV-4): retention cap for job.spawnedRunIds (bounded persisted JSON;
 * remove() cancels at most this most-recent window). */
const SPAWNED_RUN_IDS_CAP = 50;

export class CrewScheduler {
	private jobs = new Map<string, ScheduledJob>();
	private timers = new Map<string, ReturnType<typeof setInterval | typeof setTimeout>>();
	private emit?: (event: ScheduleChangeEvent) => void;
	private executor?: (job: ScheduledJob) => string;
	private finalizer?: (jobId: string, agentId: string) => void;
	private runCancelFn?: (runId: string) => void;
	private nowFn: () => Date;

	constructor(options: CrewSchedulerOptions = {}) {
		this.nowFn = options.now ?? (() => new Date());
	}

	/** Scheduler clock. Injected in tests; real time in production. */
	private now(): Date {
		return this.nowFn();
	}

	start(options: {
		emit: (event: ScheduleChangeEvent) => void;
		executor: (job: ScheduledJob) => string;
		finalizer: (jobId: string, agentId: string) => void;
		/** Optional callback to cancel a spawned run by runId. */
		runCancelFn?: (runId: string) => void;
	}): void {
		this.emit = options.emit;
		this.executor = options.executor;
		this.finalizer = options.finalizer;
		this.runCancelFn = options.runCancelFn;
	}

	stop(): void {
		for (const t of this.timers.values()) {
			clearInterval(t as ReturnType<typeof setInterval>);
			clearTimeout(t as ReturnType<typeof setTimeout>);
		}
		this.timers.clear();
		this.emit = undefined;
		this.executor = undefined;
		this.finalizer = undefined;
		this.runCancelFn = undefined;
	}

	add(job: ScheduledJob): void {
		this.jobs.set(job.id, job);
		// R2-M-B6 (SEV-11): a persisted nextRun in the past = occurrences missed
		// while the host was down. Classic cron leaves mail; we leave a one-time
		//	`skipped` event + log line on RELOAD (this path). No catch-up — firing a
		//	stale queue at load would storm the host. Runtime re-arms go through
		//	update() (never add()), so a normal fire's stale nextRun cannot reach here.
		this.reportMissedCronOccurrences(job);
		if (job.enabled) this.arm(job);
		// R14-C4 (wave 7, 2026-10-20): arm() can mutate the stored entry BEFORE the
		// added event fires (e.g. a past `once` job flips to enabled:false,
		// lastStatus:"error" via update()). Emitting the ORIGINAL stale object
		// confused event-order consumers (disk converged; the event stream didn't).
		// Emit the post-arm truth from the map instead.
		this.emit?.({ type: "added", job: this.jobs.get(job.id) ?? job });
	}

	remove(id: string): boolean {
		const job = this.jobs.get(id);
		const spawnedRunIds = job?.spawnedRunIds;
		this.disarm(id);
		// Cancel all spawned runs that are still active
		if (spawnedRunIds && this.runCancelFn) {
			for (const runId of spawnedRunIds) {
				try {
					this.runCancelFn(runId);
				} catch {
					/* best-effort */
				}
			}
		}
		const ok = this.jobs.delete(id);
		if (ok) this.emit?.({ type: "removed", jobId: id, spawnedRunIds });
		return ok;
	}

	update(id: string, patch: Partial<ScheduledJob>): ScheduledJob | undefined {
		const existing = this.jobs.get(id);
		if (!existing) return undefined;
		this.disarm(id);
		const updated = { ...existing, ...patch };
		this.jobs.set(id, updated);
		if (updated.enabled) this.arm(updated);
		this.emit?.({ type: "updated", job: updated });
		return updated;
	}

	list(): ScheduledJob[] {
		return [...this.jobs.values()];
	}

	/** Record a runId spawned by a job. Call this after executor fires. */
	recordSpawnedRun(jobId: string, runId: string): void {
		const job = this.jobs.get(jobId);
		if (!job) return;
		// R2-M-B4 (SEV-4): cap spawnedRunIds. The unbounded append persisted the
		// FULL array per fire (O(n²) writes — a 5-min job ≈ 8.6k entries/30d,
		// ~300-350 KB) and remove() then cancelled ALL historical runIds. Keep the
		// most recent SPAWNED_RUN_IDS_CAP; runs beyond the cap are long terminal,
		// so not cancelling them is the natural no-op.
		const appended = [...(job.spawnedRunIds ?? []), runId];
		const spawnedRunIds = appended.length > SPAWNED_RUN_IDS_CAP ? appended.slice(-SPAWNED_RUN_IDS_CAP) : appended;
		this.jobs.set(jobId, { ...job, spawnedRunIds });
	}

	/**
	 * Trigger a job immediately (dashboard "run now" / subAction='run-now').
	 * Bypasses the enabled gate — an explicit user action — but otherwise reuses
	 * fire()'s exact path: marks lastStatus=running, invokes the SAME executor
	 * callback, emits fired/error events, and calls the finalizer. Completion
	 * (runCount/lastRun/lastStatus=persisted success) is handled by the same
	 * async finalization the timer-driven path uses.
	 *
	 * Returns ok:false (no throw) when the job or the executor is missing.
	 */
	runNow(jobId: string): { ok: true } | { ok: false; error: string } {
		const job = this.jobs.get(jobId);
		if (!job) return { ok: false, error: `No scheduled job with id '${jobId}'.` };
		if (!this.executor) return { ok: false, error: "Scheduler is not running." };
		this.fire(jobId, true);
		// A run-now on a scheduled ONCE job CONSUMES it: the timer-driven path
		// self-disables after firing (arm()'s setTimeout callback), and without
		// the same step here the still-armed timer would fire the job a SECOND
		// time at its scheduled time — a one-shot executing twice.
		if (job.scheduleType === "once") this.update(jobId, { enabled: false });
		return { ok: true };
	}

	/** R2-M-B6: one-time missed-occurrence report for a reloaded cron job whose
	 * persisted nextRun is in the past (bounded occurrence walk — no catch-up). */
	private reportMissedCronOccurrences(job: ScheduledJob): void {
		if (job.scheduleType !== "cron" || !job.nextRun) return;
		const nowMs = this.now().getTime();
		const persistedMs = new Date(job.nextRun).getTime();
		if (!Number.isFinite(persistedMs) || persistedMs >= nowMs) return;
		let missed = 0;
		let cursor = new Date(persistedMs);
		for (let i = 0; i < 10_000; i++) {
			const next = nextRunTime({ kind: "cron", spec: job.schedule }, cursor);
			if (!(next instanceof Date) || next.getTime() > nowMs) break;
			missed += 1;
			cursor = next;
		}
		const reason = `missed ${missed} occurrence(s) while host down (persisted nextRun ${job.nextRun} < now ${new Date(nowMs).toISOString()})`;
		this.emit?.({ type: "skipped", jobId: job.id, reason });
		console.warn(`[pi-crew scheduler] job ${job.id} (${job.name ?? job.id}) skipped: ${reason}`);
	}

	private arm(job: ScheduledJob): void {
		if (this.timers.has(job.id)) return;
		if (job.scheduleType === "interval" && job.intervalMs) {
			// R2-L-B10 (wave 7, documented design choice): interval jobs re-arm from
			// FIRE time via the chained hop, but the fire() → update() → disarm/arm
			// lifecycle only re-arms after the run COMPLETES — the effective period is
			// intervalMs + run duration, NOT schedule-aligned wall-clock spacing.
			// Deliberate (no overlap between occurrences of the same job); recorded
			// here so the semantics are discoverable at the arm site.
			// 2026-09-22 spawn-storm root cause: this branch used
			// setInterval(fire, intervalMs). Node timers are 32-bit — a LEGAL long
			// interval (e.g. 90d = 7,776,000,000ms > 2^31-1) overflows and Node
			// silently sets the delay to 1ms (TimeoutOverflowWarning): the job then
			// fired every millisecond, and each
			// tick dispatched another run (measured live: ~104 garbage runs + 50+
			// node processes from ONE registered 90-day interval job). armCron()
			// already clamps its hops below the same ceiling — the interval branch
			// was missed. Reuse the identical chained-hop treatment: schedule toward
			// now+intervalMs, clamped; cronTick fires on arrival (its
			// advanceCronNextRun is a cron-only no-op here), and fire()'s internal
			// update() → disarm→arm lifecycle re-arms the next interval.
			const targetMs = this.now().getTime() + job.intervalMs;
			this.setCronTimeout(job.id, targetMs);
		} else if (job.scheduleType === "once") {
			const target = new Date(job.schedule).getTime();
			const delay = target - this.now().getTime();
			if (delay > 0) {
				// Same 32-bit ceiling as the interval branch above: a once job armed
				// > 2^31-1 ms out (e.g. "+30d" — a LEGAL relative spec — or a far ISO
				// timestamp) overflowed setTimeout to a 1ms PREMATURE fire. Chained hops
				// instead; cronTick self-disables once-jobs on arrival (below).
				this.setCronTimeout(job.id, target);
			} else {
				this.update(job.id, { enabled: false, lastStatus: "error" });
				this.emit?.({
					type: "error",
					jobId: job.id,
					error: `Scheduled time ${job.schedule} is in the past`,
				});
			}
		} else if (job.scheduleType === "cron") {
			this.armCron(job);
		}
	}

	/**
	 * Arm a cron job: schedule a chained setTimeout at the next occurrence
	 * (hops are clamped below the 2^31-1 ms setTimeout ceiling so yearly crons
	 * cannot mis-fire), fire once on arrival, then let the existing
	 * update() → disarm+arm lifecycle (triggered by fire()'s
	 * lastStatus='running' update) re-arm the NEXT occurrence. fire() itself
	 * stays persistence-blind; the post-fire nextRun advance happens in
	 * advanceCronNextRun and persists via the usual `updated` event flow.
	 */
	private armCron(job: ScheduledJob): void {
		const now = this.now();
		const next = nextRunTime({ kind: "cron", spec: job.schedule }, now);
		if (!(next instanceof Date) || next.getTime() <= now.getTime()) {
			this.disableCronForUncomputableNext(job.id, next);
			return;
		}
		this.setCronTimeout(job.id, next.getTime());
	}

	/** Chain a clamped timeout hop toward the target cron occurrence. */
	private setCronTimeout(jobId: string, targetMs: number): void {
		const delay = Math.max(targetMs - this.now().getTime(), 0);
		const t = setTimeout(() => this.cronTick(jobId, targetMs), Math.min(delay, MAX_TIMER_DELAY_MS));
		t.unref();
		this.timers.set(jobId, t);
	}

	/** Timer callback for a cron hop/arrival. Fires at most once per occurrence. */
	private cronTick(jobId: string, targetMs: number): void {
		const job = this.jobs.get(jobId);
		if (!job?.enabled) return; // disabled/removed mid-flight: hop must die
		if (this.now().getTime() < targetMs) {
			// Clamped hop landed early — chain again for the remaining time.
			this.setCronTimeout(jobId, targetMs);
			return;
		}
		// Occurrence reached. fire()'s internal update({lastStatus:'running'})
		// runs disarm→arm, which re-arms the NEXT occurrence exactly once; the
		// hop that just fired is dead, so no timer doubles up.
		this.fire(jobId);
		this.advanceCronNextRun(jobId);
		// once-semantics (was inline in arm()'s removed setTimeout): consume the
		// job after its single arrival fire so a re-arm cannot fire it again.
		if (job.scheduleType === "once") this.update(jobId, { enabled: false });
	}

	/** After a cron fire, advance the persisted nextRun to the next occurrence
	 * (or self-disable when no further occurrence is computable). */
	private advanceCronNextRun(jobId: string): void {
		const job = this.jobs.get(jobId);
		if (!job?.enabled || job.scheduleType !== "cron") return;
		const next = nextRunTime({ kind: "cron", spec: job.schedule }, this.now());
		if (!(next instanceof Date)) {
			this.disableCronForUncomputableNext(jobId, next);
			return;
		}
		this.update(jobId, { nextRun: next.toISOString() });
	}

	/** No computable next occurrence (e.g. Feb-29 beyond the 366-day search
	 * window): disable the job and record why. */
	private disableCronForUncomputableNext(jobId: string, next: Date | { error: string }): void {
		const reason = next && typeof next === "object" && "error" in next ? next.error : "next occurrence is not in the future";
		this.update(jobId, { enabled: false, lastStatus: "error" });
		this.emit?.({
			type: "error",
			jobId,
			error: `Cron schedule cannot compute a next occurrence (${reason}); job disabled`,
		});
	}

	private disarm(id: string): void {
		const t = this.timers.get(id);
		if (t) {
			// Branch on timer type to use correct clear function
			const job = this.jobs.get(id);
			if (job?.scheduleType === "interval") {
				clearInterval(t as ReturnType<typeof setInterval>);
			} else {
				// `once` and `cron` both arm setTimeout handles (cron chains hops).
				clearTimeout(t as ReturnType<typeof setTimeout>);
			}
			this.timers.delete(id);
		}
	}

	private fire(id: string, force = false): void {
		const job = this.jobs.get(id);
		if (!job || !this.executor) return;
		if (!job.enabled && !force) return;
		// In-flight guard (2026-09-22, storm follow-up): the executor dispatches
		// asynchronously and resets lastStatus (success/error) only on completion,
		// so `running` marks the in-flight window. Without backpressure here, any
		// interval shorter than the run duration stacks one overlapping run per
		// tick (the 1ms overflow loop was the extreme case; fixed below/above).
		// Skips emit a "skipped" event (visible to pi.events consumers; the toast
		// bridge stays silent — a slow executor + short interval would spam).
		// `force` (run-now) is the explicit escape hatch.
		if (job.lastStatus === "running" && !force) {
			this.emit?.({ type: "skipped", jobId: id, reason: "previous dispatch still in flight" });
			return;
		}
		this.update(id, { lastStatus: "running" });
		let agentId: string;
		try {
			agentId = this.executor(job);
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			this.update(id, {
				lastRun: new Date().toISOString(),
				lastStatus: "error",
			});
			this.emit?.({ type: "error", jobId: id, error });
			return;
		}
		this.emit?.({ type: "fired", jobId: id, agentId, name: job.name });
		this.finalizer?.(id, agentId);
	}

	static detectSchedule(s: string): {
		type: ScheduleType;
		intervalMs?: number;
		normalized: string;
	} {
		const trimmed = s.trim();
		// Relative: +10m
		const rel = trimmed.match(/^\+(\d+)(s|m|h|d)$/);
		if (rel) {
			const ms = parseInt(rel[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "s" | "m" | "h" | "d"];
			return {
				type: "once",
				normalized: new Date(Date.now() + ms).toISOString(),
			};
		}
		// Interval: 5m — "ms" MUST be accepted: handle-schedule builds
		// `${params.interval}ms` from the schema-level numeric `interval` param
		// (ms number), so without an ms unit here every interval schedule died in
		// the parser ("Invalid schedule …") — found live 2026-09-21 when
		// `team action='schedule' interval=3600000` was impossible to satisfy.
		const ivl = trimmed.match(/^(\d+)(ms|s|m|h|d)$/);
		if (ivl) {
			const ms =
				parseInt(ivl[1], 10) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[ivl[2] as "ms" | "s" | "m" | "h" | "d"];
			return { type: "interval", intervalMs: ms, normalized: trimmed };
		}
		// ISO timestamp
		if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
			const d = new Date(trimmed);
			if (!Number.isNaN(d.getTime())) {
				if (d.getTime() <= Date.now()) throw new Error(`Scheduled time ${d.toISOString()} is in the past.`);
				return { type: "once", normalized: d.toISOString() };
			}
		}
		// Simple cron-like (5 fields)
		const cronFields = trimmed.split(/\s+/);
		if (cronFields.length >= 5) {
			return { type: "cron", normalized: trimmed };
		}
		throw new Error(`Invalid schedule "${s}". Use "5m", "+10m", ISO timestamp, or cron expression.`);
	}
}

export interface ScheduleSpec {
	kind: "once" | "interval" | "cron";
	spec: string;
}

function parseIntervalMs(s: string): number | undefined {
	let ms = 0;
	let remaining = s;
	const unitMs: Record<string, number> = {
		// "ms" MUST be first in the regex alternation below and present here:
		// handle-schedule builds `${params.interval}ms` from the numeric interval
		// param, so without an ms unit every interval schedule failed to parse
		// (found live 2026-09-21 — `interval=3600000` was unsatisfiable).
		ms: 1,
		s: 1000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
	};
	while (remaining.length > 0) {
		const m = remaining.match(/^(\d+)(ms|s|m|h|d)/);
		if (!m) return undefined;
		ms += parseInt(m[1], 10) * unitMs[m[2]];
		remaining = remaining.slice(m[0].length);
	}
	return ms;
}

/** Named-token maps for cron DOW (SUN=0..SAT=6) and month (JAN=1..DEC=12). */
const CRON_DOW_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const CRON_MONTH_NAMES: Record<string, number> = {
	JAN: 1,
	FEB: 2,
	MAR: 3,
	APR: 4,
	MAY: 5,
	JUN: 6,
	JUL: 7,
	AUG: 8,
	SEP: 9,
	OCT: 10,
	NOV: 11,
	DEC: 12,
};

/**
 * Expand a single cron field expression into the set of values it can
 * match (clamped to min..max). Returns null when any part fails to parse
 * (empty part, bad step, unrecognizable token) — callers treat null as
 * "matches nothing / keep legacy behavior" instead of throwing.
 *
 * Supports the standard cron grammar: wildcard, single N, range a-b, list
 * a,b,c, step syntax (wildcard-step, range-step, from-step), and named tokens
 * (MON, JAN) when a `names` map is passed. Shared by the per-occurrence
 * matcher below and the parse-time dom/month feasibility check (I3).
 */
function cronFieldCandidates(field: string, min: number, max: number, names?: Record<string, number>): Set<number> | null {
	let normalized = field.trim().toUpperCase();
	if (names) {
		for (const name of Object.keys(names).sort((a, b) => b.length - a.length)) {
			normalized = normalized.split(name).join(String(names[name]));
		}
	}
	// Cron permits 7 for Sunday in the DOW field — normalize to 0.
	if (min === 0 && max === 6) normalized = normalized.replace(/\b7\b/g, "0");
	const matched = new Set<number>();
	for (const rawPart of normalized.split(",")) {
		const part = rawPart.trim();
		if (part === "") return null;
		const stepMatch = part.match(/^(.*)\/(\d+)$/);
		const step = stepMatch ? Number.parseInt(stepMatch[2], 10) : 1;
		if (!Number.isFinite(step) || step < 1) return null;
		const rangeStr = stepMatch ? stepMatch[1] : part;
		let lo: number;
		let hi: number;
		if (rangeStr === "*") {
			lo = min;
			hi = max;
		} else if (/^\d+$/.test(rangeStr)) {
			lo = Number.parseInt(rangeStr, 10);
			hi = stepMatch ? max : lo; // bare `N` = single value; `N/S` = N..max step S
		} else {
			const rm = rangeStr.match(/^(\d+)-(\d+)$/);
			if (!rm) return null;
			lo = Number.parseInt(rm[1], 10);
			hi = Number.parseInt(rm[2], 10);
		}
		for (let v = lo; v <= hi; v += step) {
			if (v >= min && v <= max) matched.add(v);
		}
	}
	return matched;
}

function nextCronDate(spec: string, from: Date): Date | { error: string } | null {
	const parts = spec.split(/\s+/);
	if (parts.length < 5) return { error: "Invalid cron expression" };
	const [minStr, hourStr, domStr, monthStr, dowStr] = parts;

	// R2-L-B5 (SEV-9): hoist the candidate Sets OUT of the scan loop. The old
	// minute-by-minute scan rebuilt 5 Sets per step (sparse crons walked up to
	// 527k iterations ≈ 309ms event-loop stall, re-run after every fire). The
	// scan below keeps EXACTLY the same semantics (first matching minute in
	// chronological order) but hops by hour/day when the coarse fields mismatch.
	const minuteCandidates = cronFieldCandidates(minStr, 0, 59);
	const hourCandidates = cronFieldCandidates(hourStr, 0, 23);
	const domCandidates = cronFieldCandidates(domStr, 1, 31);
	const monthCandidates = cronFieldCandidates(monthStr, 1, 12, CRON_MONTH_NAMES);
	const dowCandidates = cronFieldCandidates(dowStr, 0, 6, CRON_DOW_NAMES);
	if (!minuteCandidates || !hourCandidates || !domCandidates || !monthCandidates || !dowCandidates) {
		return { error: "Invalid cron expression" };
	}

	let cursor = new Date(from.getTime());
	cursor.setSeconds(0, 0);
	cursor = new Date(cursor.getTime() + 60_000);

	// Search window: 366 days (the old 366*24*60 minute-step bound).
	const deadlineMs = cursor.getTime() + 366 * 24 * 60 * 60_000;
	while (cursor.getTime() <= deadlineMs) {
		// Day-level filter: month/dom/dow — skip whole days on mismatch.
		if (
			!monthCandidates.has(cursor.getUTCMonth() + 1) ||
			!domCandidates.has(cursor.getUTCDate()) ||
			!dowCandidates.has(cursor.getUTCDay())
		) {
			// Hop to 00:00 of the next UTC day (Date.UTC normalizes overflow).
			cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1, 0, 0));
			continue;
		}
		// Hour-level filter: skip the rest of the hour on mismatch.
		if (!hourCandidates.has(cursor.getUTCHours())) {
			cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), cursor.getUTCHours() + 1, 0));
			continue;
		}
		// Matching day + hour: scan the remaining minutes of THIS hour only.
		for (let minute = cursor.getUTCMinutes(); minute <= 59; minute++) {
			if (minuteCandidates.has(minute)) {
				return new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), cursor.getUTCHours(), minute));
			}
		}
		// No matching minute left in this hour → next hour boundary.
		cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), cursor.getUTCHours() + 1, 0));
	}

	return { error: "No next cron occurrence found within search window" };
}

export function parseSchedule(spec: string): ScheduleSpec | { error: string } {
	const trimmed = spec.trim();
	if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
		const d = new Date(trimmed);
		if (!Number.isNaN(d.getTime())) {
			return { kind: "once", spec: trimmed };
		}
	}
	if (/^\+\d+(s|m|h|d)$/.test(trimmed)) {
		return { kind: "once", spec: trimmed };
	}
	const ivlMs = parseIntervalMs(trimmed);
	if (ivlMs !== undefined && ivlMs > 0) {
		return { kind: "interval", spec: trimmed };
	}
	const fields = trimmed.split(/\s+/);
	if (fields.length >= 5) {
		const impossible = cronDomMonthImpossible(fields[2], fields[3]);
		if (impossible) return { error: `Invalid cron expression "${trimmed}": ${impossible}.` };
		return { kind: "cron", spec: trimmed };
	}
	return {
		error: `Invalid schedule "${spec}". Use "5m", "+10m", ISO timestamp, or cron expression.`,
	};
}

/** Day-of-month ceilings per month (index 1..12) for a LEAP year — the
 * conservative upper bound used by the I3 parse-time feasibility check
 * (February is granted 29: leap years exist inside the multi-year window,
 * so Feb-29 specs stay legal at parse). */
const MONTH_DAY_CEILINGS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * I3 (round-6 audit): cheap parse-time rejection of cron specs whose
 * day-of-month × month combination cannot occur in ANY year — e.g.
 * `0 0 31 2 *`. nextCronDate only discovers this by scanning
 * minute-by-minute across its entire 366-day window (~309ms measured) after
 * which arm-time disables the job; rejecting at parse surfaces the mistake
 * to the user at schedule-creation time instead of a silent disable later.
 *
 * Conservative by design (NOT a full cron validator):
 *  - dow is ignored: nextCronDate uses AND semantics across fields, so an
 *    impossible dom/month pair can never match regardless of the dow field;
 *  - February is granted its leap-day ceiling of 29 (Feb-29 specs remain
 *    legal; the existing arm-time disableCronForUncomputableNext path owns
 *    the beyond-search-window case);
 *  - any unparseable field returns null here and keeps the legacy runtime
 *    behavior — this adds no new rejection classes beyond provable
 *    impossibility (empty expansions like inverted ranges count: an empty
 *    candidate set can never match under the AND-semantics matcher).
 *
 * Returns a human-readable reason, or null when the combo is feasible (or
 * unknowable cheaply).
 */
function cronDomMonthImpossible(domStr: string, monthStr: string): string | null {
	const doms = cronFieldCandidates(domStr, 1, 31);
	const months = cronFieldCandidates(monthStr, 1, 12, CRON_MONTH_NAMES);
	if (doms === null || months === null) return null;
	const feasible = [...months].some((m) => [...doms].some((d) => d >= 1 && d <= MONTH_DAY_CEILINGS[m]));
	if (feasible) return null;
	return `day-of-month {${[...doms]
		.sort((a, b) => a - b)
		.join(
			",",
		)}} never occurs in month {${[...months].sort((a, b) => a - b).join(",")}} — no valid day/month combination exists in any year`;
}

export function nextRunTime(spec: ScheduleSpec, from: Date = new Date()): Date | { error: string } {
	if (spec.kind === "once") {
		const rel = spec.spec.match(/^\+(\d+)(s|m|h|d)$/);
		if (rel) {
			const ms = parseInt(rel[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "s" | "m" | "h" | "d"];
			return new Date(from.getTime() + ms);
		}
		const d = new Date(spec.spec);
		if (Number.isNaN(d.getTime())) {
			return { error: `Invalid once schedule: ${spec.spec}` };
		}
		return d;
	}
	if (spec.kind === "interval") {
		const ms = parseIntervalMs(spec.spec);
		if (ms === undefined || ms <= 0) {
			return { error: `Invalid interval: ${spec.spec}` };
		}
		return new Date(from.getTime() + ms);
	}
	if (spec.kind === "cron") {
		const next = nextCronDate(spec.spec, from);
		if (!next || !(next instanceof Date)) {
			return (
				(next as { error: string } | null) ?? {
					error: "Invalid cron expression",
				}
			);
		}
		return next;
	}
	return {
		error: `Unknown schedule kind: ${(spec as unknown as Record<string, unknown>).kind}`,
	};
}

export function humanizeSchedule(spec: ScheduleSpec): string {
	if (spec.kind === "once") {
		if (/^\+\d+(s|m|h|d)$/.test(spec.spec)) {
			return `once in ${spec.spec.slice(1)}`;
		}
		return `once at ${spec.spec}`;
	}
	if (spec.kind === "interval") {
		return `every ${spec.spec}`;
	}
	if (spec.kind === "cron") {
		// I4: cron fields are matched against UTC calendar parts (nextCronDate
		// reads getUTCMinutes/getUTCHours/getUTCDate/...), so the label says so —
		// a user in UTC+7 writing `0 9 * * *` otherwise gets 02:00 local with
		// no hint why.
		return `cron ${spec.spec} (UTC)`;
	}
	return "unknown schedule";
}
