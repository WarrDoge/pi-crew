import assert from "node:assert/strict";
import test from "node:test";
import { CrewScheduler, nextRunTime, parseSchedule } from "../../../../src/runtime/scheduling/scheduler.ts";

/**
 * Regression (found live 2026-09-21): `team action='schedule' interval=3600000`
 * was IMPOSSIBLE to satisfy. handle-schedule.ts builds the spec string
 * `${params.interval}ms` from the numeric interval param, but both interval
 * parsers (parseIntervalMs, used by the exported parseSchedule; and
 * CrewScheduler.detectSchedule) only accepted s|m|h|d — the "ms" suffix always fell
 * through to the error branch ("Invalid schedule … Use 5m, +10m, ISO, cron")
 * even though the caller had used the only format the schema accepts (a plain
 * ms number).
 */

// biome-ignore lint/suspicious/noTemplateCurlyInString: the `${interval}ms` is documentation of the format under test, not an interpolation
test("parseSchedule accepts the ms unit (handle-schedule's `${interval}ms` round-trip)", () => {
	const r = parseSchedule("3600000ms");
	assert.ok(!("error" in r), `must parse, got error: ${("error" in r && r.error) || ""}`);
	assert.equal((r as { kind: string }).kind, "interval");
});

test("nextRunTime resolves an ms interval to exactly from+intervalMs", () => {
	const from = new Date("2026-09-21T00:00:00.000Z");
	const next = nextRunTime({ kind: "interval", spec: "3600000ms" }, from);
	assert.ok(next instanceof Date, "must resolve, not error");
	assert.equal((next as Date).toISOString(), "2026-09-21T01:00:00.000Z");
});

test("ms stays distinct from s (5000ms = 5s-of-ms, 5000s = 5000000ms)", () => {
	const from = new Date(0);
	const a = nextRunTime({ kind: "interval", spec: "5000ms" }, from) as Date;
	const b = nextRunTime({ kind: "interval", spec: "5000s" }, from) as Date;
	assert.equal(a.getTime(), 5_000);
	assert.equal(b.getTime(), 5_000_000);
});

test("multi-unit intervals and plain units still parse (no regression)", () => {
	const from = new Date(0);
	const multi = nextRunTime({ kind: "interval", spec: "1h30m" }, from) as Date;
	assert.equal(multi.getTime(), 5_400_000);
	const plain = nextRunTime({ kind: "interval", spec: "5m" }, from) as Date;
	assert.equal(plain.getTime(), 300_000);
});

test("CrewScheduler.detectSchedule also accepts the ms unit", () => {
	const r = CrewScheduler.detectSchedule("3600000ms");
	assert.equal(r.type, "interval");
	assert.equal(r.intervalMs, 3_600_000);
});

test("garbage specs still fail", () => {
	const r = parseSchedule("soon");
	assert.ok("error" in r, "non-spec strings must return an error");
});

// ─── I3 (round-6 audit): parse-time rejection of provably-impossible cron
// day-of-month × month combinations. Pre-fix, `0 0 31 2 *` passed parse and
// nextCronDate burned its full 366-day minute-by-minute scan (~309ms)
// before arm-time disabled the job — the user learned nothing at creation.

test("parseSchedule rejects '0 0 31 2 *' (Feb 31) at parse time", () => {
	const r = parseSchedule("0 0 31 2 *");
	assert.ok("error" in r, "provably-impossible dom/month cron must fail parse, got: " + JSON.stringify(r));
	assert.match((r as { error: string }).error, /day-of-month/, "error must name the impossible fields");
	assert.match((r as { error: string }).error, /month/);
});

test("parseSchedule rejects Feb 30 and all-30-day month lists for dom 31", () => {
	for (const spec of ["0 0 30 2 *", "0 0 31 4 *", "0 0 31 APR,SEP,JUN,NOV *"]) {
		const r = parseSchedule(spec);
		assert.ok("error" in r, `${spec} must fail parse (no valid day/month combo), got: ` + JSON.stringify(r));
	}
});

test("parseSchedule stays conservative: Feb 29 (leap years) and mixed-month dom 31 stay legal", () => {
	// Feb 29 exists in leap years — the arm-time uncomputable-next path owns it.
	const feb29 = parseSchedule("0 0 29 2 *");
	assert.ok(!("error" in feb29), "Feb 29 must parse (conservative leap-day ceiling)");
	// A month LIST containing any 31-day month makes dom 31 feasible.
	const mixed = parseSchedule("0 0 31 2,7 *");
	assert.ok(!("error" in mixed), "dom 31 in {Feb,Jul} is feasible (July)");
	// dom steps/lists inside a short month: some dom always exists.
	const steps = parseSchedule("0 0 */2 2 *");
	assert.ok(!("error" in steps), "dom */2 in Feb is feasible (day 1 matches)");
	const list = parseSchedule("0 0 1,15 * *");
	assert.ok(!("error" in list), "dom list across all months is feasible");
});

test("I3 fast-fail: impossible cron errors are returned synchronously (no scan-shaped latency)", () => {
	const t0 = process.hrtime.bigint();
	const r = parseSchedule("0 0 31 2 *");
	const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
	assert.ok("error" in r, "must error");
	// The pre-fix cost was ~309ms of minute-stepping; the check is pure set
	// algebra. Generous ceiling to stay flake-free under parallel test load.
	assert.ok(elapsedMs < 50, `parse must fail fast, took ${elapsedMs.toFixed(2)}ms`);
});
