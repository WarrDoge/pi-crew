/**
 * R7-12 (DR-04 round-7, 2026-10-16): render-scheduler max-delay cap.
 *
 * While events keep arriving FASTER than `debounceMs`, every schedule()
 * re-arms the debounce timer and the pending flush is postponed forever — a
 * sustained event stream (live run, fast workers) starved rendering
 * indefinitely. The cap (`max(3 × debounceMs, 250)`, floored at 250ms) bounds
 * that starvation: the pending batch is force-flushed at the cap from
 * schedule() itself, and (as a safety net) from the fallback loop's
 * "recent event" branch which previously refused to render while any event
 * was recent.
 *
 * Fake timers drive the whole stream on the mocked clock (one event per
 * 50ms tick) so 2s of stream costs no real waiting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { RenderScheduler } from "../../../src/ui/render-scheduler.ts";

test("R7-12: a sustained schedule() stream force-flushes within the max-delay cap", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const start = Date.now();
	const renders: number[] = [];
	const scheduler = new RenderScheduler(
		undefined,
		() => {
			renders.push(Date.now());
		},
		{ debounceMs: 75, fallbackMs: 750 },
	);
	// One event every 50ms for 2s — faster than the 75ms debounce, so without
	// the cap every schedule() re-arms the debounce before it can ever fire.
	for (let elapsed = 0; elapsed < 2000; elapsed += 50) {
		scheduler.schedule();
		t.mock.timers.tick(50);
	}
	assert.ok(renders.length >= 2, `expected repeated force-flushes during the stream, got ${renders.length} renders`);
	assert.ok(
		renders[0]! - start >= 240 && renders[0]! - start <= 260,
		`first flush must land AT the cap (maxDelayMs=250, one 50ms tick slack), got ${renders[0]! - start}`,
	);
	scheduler.dispose();
});

test("R7-12: the cap is floored at 250ms even for a tiny debounceMs", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const start = Date.now();
	const renders: number[] = [];
	const scheduler = new RenderScheduler(
		undefined,
		() => {
			renders.push(Date.now());
		},
		{ debounceMs: 10, fallbackMs: 5000 },
	);
	// Events every 5ms: a naive `3 × debounceMs` cap of 30ms would flush way
	// too early — the 250ms floor must win.
	for (let elapsed = 0; elapsed < 300; elapsed += 5) {
		scheduler.schedule();
		t.mock.timers.tick(5);
	}
	assert.deepEqual(
		renders.map((r) => r - start),
		[250],
		`expected exactly one force-flush at the 250ms floor, got ${renders.map((r) => r - start)}`,
	);
	scheduler.dispose();
});

test("R7-12: normal debounced burst coalescing is unchanged (no early flush)", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const start = Date.now();
	const renders: number[] = [];
	const scheduler = new RenderScheduler(
		undefined,
		() => {
			renders.push(Date.now());
		},
		{ debounceMs: 75, fallbackMs: 10_000 },
	);
	scheduler.schedule();
	scheduler.schedule();
	scheduler.schedule(); // burst at t=0 — one flush after the debounce window
	t.mock.timers.tick(75); // window elapses with NO new event
	assert.deepEqual(
		renders.map((r) => r - start),
		[75],
		"a burst that goes quiet must flush exactly once via the debounce, not the cap",
	);
	scheduler.schedule(); // a fresh burst restarts the cycle
	t.mock.timers.tick(75);
	assert.deepEqual(
		renders.map((r) => r - start),
		[75, 150],
	);
	scheduler.dispose();
});
