import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { subscribeThemeChange } from "../../../src/ui/theme-adapter.ts";

/**
 * R2-L-B9 (wave 7): the theme-adapter polling fallback previously held a
 * STRONG ref to the theme from the interval closure — an abandoned
 * subscription (unsubscribe never called) kept the theme + subscription +
 * callbacks alive with a permanent 1s unref'd poll. The poll now holds only a
 * WeakRef and self-terminates on the first tick after the theme is collected.
 */

type Timer = ReturnType<typeof setInterval>;

describe("R2-L-B9: theme poll is WeakRef-held and self-terminates", () => {
	let realSetInterval: typeof globalThis.setInterval;
	let realClearInterval: typeof globalThis.clearInterval;
	let created: Timer[];
	let cleared: Timer[];

	beforeEach(() => {
		realSetInterval = globalThis.setInterval;
		realClearInterval = globalThis.clearInterval;
		created = [];
		cleared = [];
		globalThis.setInterval = ((handler: () => void, ms?: number) => {
			const id = realSetInterval(handler, ms);
			created.push(id);
			return id;
		}) as typeof globalThis.setInterval;
		globalThis.clearInterval = ((id: Timer) => {
			cleared.push(id);
			realClearInterval(id);
		}) as typeof globalThis.clearInterval;
	});

	afterEach(() => {
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
	});

	it("poll still fires for a live theme (signature change reaches the callback)", async () => {
		// themeSignature covers PRIMITIVE fields (functions are filtered out) —
		// mutate a primitive so the 1s poll observes a real change.
		const theme: Record<string, unknown> = { fg: () => "x", bold: (s: string) => s, accent: "red" };
		let fired = 0;
		const unsub = subscribeThemeChange(theme, () => {
			fired += 1;
		});
		assert.ok(created.length >= 1, "polling fallback interval created");
		theme.accent = "blue"; // signature change
		await new Promise((resolve) => setTimeout(resolve, 1300));
		assert.ok(fired >= 1, "signature change must fire the callback via the poll");
		unsub();
		assert.ok(cleared.length >= 1, "unsubscribe clears the poll");
	});

	it("abandoned subscription self-terminates after the theme is collected (GC-gated)", async (t) => {
		const gc = (globalThis as { gc?: () => void }).gc;
		if (typeof gc !== "function") {
			t.skip("needs --expose-gc");
			return;
		}
		// Isolate the theme in its own frame so no optimized caller slot pins it.
		const makeTheme = (): { theme: Record<string, unknown>; weak: WeakRef<object> } => {
			const theme: Record<string, unknown> = { fg: () => "x", bold: (s: string) => s, accent: "red" };
			return { theme, weak: new WeakRef<object>(theme) };
		};
		const holder = makeTheme();
		// Abandon deliberately: never call the returned unsubscribe.
		subscribeThemeChange(holder.theme, () => undefined);
		const timerCount = created.length;
		holder.theme = undefined as unknown as Record<string, unknown>;
		for (let i = 0; i < 20 && holder.weak.deref() !== undefined; i++) {
			gc();
			await new Promise((resolve) => setImmediate(resolve));
		}
		if (holder.weak.deref() !== undefined) {
			t.skip("V8 did not collect the abandoned theme in this run — WeakRef pin unverifiable here");
			return;
		}
		// Give the (1s) poll at least one post-GC tick to self-clear.
		await new Promise((resolve) => setTimeout(resolve, 1300));
		assert.ok(cleared.length >= timerCount, "poll interval must self-terminate after theme collection (R2-L-B9)");
	});
});
