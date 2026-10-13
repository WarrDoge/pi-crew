/**
 * U16 — usage ledger (2-tier: embedded + subprocess) — parser unit tests.
 *
 * D2 (locked): `UsageState.cost` stays a NUMBER (aggregate) fed from EITHER
 * the session-level `SessionStats.cost` (number) OR the message-level
 * `Usage.cost` OBJECT ({input, output, cacheRead, cacheWrite, total}) — the
 * parser accepts both. `usageFromValue` (session-usage.ts) is the SINGLE
 * shared parser; `usageFromStats` (live-session-runtime.ts) is a thin adapter
 * over it feeding the embedded tier's getSessionStats() call.
 *
 * SDK shapes (verified against
 * node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts
 * and @earendil-works/pi-ai/dist/types.d.ts):
 *   SessionStats = { …, tokens: {input, output, cacheRead, cacheWrite, total},
 *                    cost: number, contextUsage? }
 *   Usage        = { input, output, cacheRead, cacheWrite, totalTokens,
 *                    cost: {input, output, cacheRead, cacheWrite, total} }
 */
import assert from "node:assert/strict";
import test from "node:test";
import { usageFromStats } from "../../../src/runtime/live-session/live-session-runtime.ts";
import { parseSessionUsageFromJsonlText, usageFromValue } from "../../../src/runtime/session-usage.ts";

const SESSION_STATS_SHAPE = {
	sessionFile: undefined,
	sessionId: "s-1",
	userMessages: 3,
	assistantMessages: 2,
	toolCalls: 4,
	toolResults: 4,
	totalMessages: 9,
	tokens: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 50, total: 1550 },
	cost: 0.123,
	contextUsage: { percent: 42, window: 200000 },
};

// ─── AC 1: cost as NUMBER (legacy shape) → used directly ────────────────────

test("usageFromValue uses a numeric cost directly", () => {
	const usage = usageFromValue({ input: 100, output: 20, cost: 0.5 });
	assert.ok(usage, "numeric-cost usage must parse");
	assert.equal(usage.input, 100);
	assert.equal(usage.output, 20);
	assert.equal(usage.cost, 0.5, "numeric cost must be taken as-is (legacy transcripts)");
});

test("usageFromValue still maps legacy cost aliases (cost_usd)", () => {
	const usage = usageFromValue({ inputTokens: 10, outputTokens: 5, cost_usd: 0.03 });
	assert.ok(usage);
	assert.equal(usage.input, 10);
	assert.equal(usage.output, 5);
	assert.equal(usage.cost, 0.03, "cost_usd alias must keep parsing (back-compat)");
});

// ─── AC 2: cost as OBJECT → total; missing total → clean undefined, no NaN ──

test("usageFromValue extracts cost.total from a message-level cost OBJECT", () => {
	const usage = usageFromValue({
		input: 10,
		output: 5,
		cacheRead: 40,
		cacheWrite: 3,
		totalTokens: 58,
		cost: { input: 0.02, output: 0.01, cacheRead: 0.004, cacheWrite: 0.001, total: 0.035 },
	});
	assert.ok(usage);
	assert.equal(usage.cost, 0.035, "cost object must contribute cost.total");
	assert.equal(usage.input, 10);
	assert.equal(usage.cacheRead, 40);
});

test("usageFromValue yields undefined cost for a cost OBJECT without total — never NaN", () => {
	const usage = usageFromValue({ input: 1, cost: { input: 0.1, output: 0.2 } });
	assert.ok(usage, "token fields must still parse");
	assert.equal(usage.cost, undefined, "missing total must NOT produce a number");
	for (const value of [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost, usage.turns]) {
		assert.ok(value === undefined || Number.isFinite(value), "no field may be NaN");
	}
});

// ─── AC 3: nested SDK SessionStats shape → all 4 token fields + cost ────────

test("usageFromStats maps the nested SDK SessionStats shape completely", () => {
	const usage = usageFromStats(SESSION_STATS_SHAPE);
	assert.ok(usage, "SessionStats-shaped stats must yield usage (was cost-only before U16)");
	assert.equal(usage.input, 1000);
	assert.equal(usage.output, 200);
	assert.equal(usage.cacheRead, 300);
	assert.equal(usage.cacheWrite, 50);
	assert.equal(usage.cost, 0.123, "session-level aggregate cost must map");
});

// ─── AC 4: flat legacy stats shape → still maps (back-compat for old fakes) ─

test("usageFromStats still maps flat legacy stats shapes", () => {
	const flat = usageFromStats({ input: 3, output: 4, cacheRead: 5, cacheWrite: 6, cost: 7, turns: 8 });
	assert.ok(flat);
	assert.equal(flat.input, 3);
	assert.equal(flat.output, 4);
	assert.equal(flat.cacheRead, 5);
	assert.equal(flat.cacheWrite, 6);
	assert.equal(flat.cost, 7);
	assert.equal(flat.turns, 8);

	const aliased = usageFromStats({ inputTokens: 11, outputTokens: 7 });
	assert.ok(aliased);
	assert.equal(aliased.input, 11);
	assert.equal(aliased.output, 7);
});

// ─── AC 6: compactUsage keeps the cost key (stable ledger schema) ───────────

test("parseSessionUsageFromJsonlText always returns a numeric cost once any usage was seen", () => {
	const usage = parseSessionUsageFromJsonlText(
		[
			JSON.stringify({ usage: { inputTokens: 10, outputTokens: 5, turns: 1 } }),
			JSON.stringify({ message: { usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 1 } } }),
		].join("\n"),
	);
	assert.ok(usage, "usage lines must aggregate");
	assert.equal(usage.input, 12);
	assert.equal(usage.output, 8);
	assert.equal(usage.cost, 0, "no source reported cost → cost key must STILL exist with value 0");

	const none = parseSessionUsageFromJsonlText("not-json\n\n");
	assert.equal(none, undefined, "no usage at all → undefined (unchanged)");
});

// ─── Old-transcript regression: message-level usage with cost OBJECT sums ───

test("parseSessionUsageFromJsonlText sums message-level object-cost transcripts", () => {
	const line = (input: number, total: number): string =>
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input,
					output: 2,
					cacheRead: 30,
					cacheWrite: 1,
					totalTokens: input + 33,
					cost: { input: 0.01, output: 0.01, cacheRead: 0.005, cacheWrite: 0.005, total },
				},
			},
		});
	const usage = parseSessionUsageFromJsonlText([line(10, 0.03), line(7, 0.02)].join("\n"));
	assert.ok(usage);
	assert.equal(usage.input, 17);
	assert.equal(usage.cacheRead, 60);
	assert.ok(usage.cost !== undefined && Math.abs(usage.cost - 0.05) < 1e-9, "object costs must sum via total");
});

// ─── AC 7: embedded tier — fake LiveSessionLike.getSessionStats() ───────────

test("a fake LiveSessionLike with getSessionStats() yields complete usage on the :1801 path", () => {
	// Mirrors the exact call introduced by U16 Fix A at the embedded-tier
	// completion site: usageFromStats(session.getSessionStats?.()).
	type FakeSession = { getSessionStats?: () => unknown };
	const session: FakeSession = { getSessionStats: () => SESSION_STATS_SHAPE };
	const usage = usageFromStats(session.getSessionStats?.());
	assert.ok(usage, "getSessionStats() result must produce usage (was always undefined pre-U16)");
	assert.equal(usage.input, 1000);
	assert.equal(usage.output, 200);
	assert.equal(usage.cacheRead, 300);
	assert.equal(usage.cacheWrite, 50);
	assert.equal(usage.cost, 0.123);

	// Session without the surface (old fakes) stays undefined — not a crash.
	const bare: FakeSession = {};
	assert.equal(usageFromStats(bare.getSessionStats?.()), undefined);
});
