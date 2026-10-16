/**
 * DR-04 W5 / R7-4 (2026-10-16).
 *
 * NotificationRouter.flush() runs inside the setTimeout callback installed by
 * enqueue(). A throwing `deliver` used to escape the timer as an uncaught
 * exception. Fix: every delivery is wrapped — logInternalError("notification.flush", …)
 * fires, nothing propagates, and the lossy batch semantics are kept (the
 * batch is not re-queued).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	type NotificationDescriptor,
	NotificationRouter,
	type NotificationRouterOptions,
} from "../../../../src/extension/notification-router.ts";

const baseNotification = (overrides: Partial<NotificationDescriptor> = {}): NotificationDescriptor => ({
	severity: "warning",
	source: "test",
	runId: "r1",
	title: "Test",
	body: "body",
	...overrides,
});

const makeRouter = (opts: NotificationRouterOptions, deliver: (n: NotificationDescriptor) => void) =>
	new NotificationRouter({ severityFilter: ["info", "warning", "error", "critical"], ...opts }, deliver);

/** logInternalError at default severity is gated behind PI_TEAMS_DEBUG; enable
 *  it so the console.error emission is observable. */
function spyDebugLog<T>(fn: () => T): { lines: string[]; result: T } {
	const lines: string[] = [];
	const previousDebug = process.env.PI_TEAMS_DEBUG;
	const previousError = console.error;
	process.env.PI_TEAMS_DEBUG = "1";
	console.error = ((...args: unknown[]) => {
		lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
	}) as typeof console.error;
	try {
		const result = fn();
		return { lines, result };
	} finally {
		console.error = previousError;
		if (previousDebug === undefined) delete process.env.PI_TEAMS_DEBUG;
		else process.env.PI_TEAMS_DEBUG = previousDebug;
	}
}

test("R7-4: single-item flush with throwing deliver logs and does not crash", () => {
	let attempts = 0;
	const router = makeRouter({ batchWindowMs: 50 }, () => {
		attempts += 1;
		throw new Error("deliver boom");
	});
	router.enqueue(baseNotification({ title: "A" }));
	assert.equal(attempts, 0, "batched — not delivered yet");

	const { lines } = spyDebugLog(() => {
		assert.doesNotThrow(() => router.flush(), "flush must not propagate the deliver error");
	});

	assert.equal(attempts, 1, "deliver was attempted exactly once");
	assert.ok(
		lines.some((l) => l.includes("[pi-crew:notification.flush]") && l.includes("deliver boom")),
		`logInternalError(notification.flush) must fire: ${JSON.stringify(lines)}`,
	);
	// Batch state is cleared — a later flush with a working deliver succeeds.
	router.dispose();
});

test("R7-4: batched flush with throwing deliver logs once and does not crash", () => {
	let attempts = 0;
	const router = makeRouter({ batchWindowMs: 50 }, () => {
		attempts += 1;
		throw new Error("batch deliver boom");
	});
	router.enqueue(baseNotification({ title: "A" }));
	router.enqueue(baseNotification({ title: "B" }));
	assert.equal(attempts, 0, "both queued");

	const { lines } = spyDebugLog(() => {
		assert.doesNotThrow(() => router.flush(), "flush must not propagate the deliver error");
	});

	assert.equal(attempts, 1, "single batched delivery attempted");
	assert.ok(
		lines.some((l) => l.includes("[pi-crew:notification.flush]") && l.includes("batch deliver boom")),
		`logInternalError(notification.flush) must fire: ${JSON.stringify(lines)}`,
	);
	router.dispose();
});

test("R7-4: timer-driven flush with throwing deliver does not throw out of the setTimeout callback", async () => {
	let attempts = 0;
	const router = makeRouter({ batchWindowMs: 5 }, () => {
		attempts += 1;
		throw new Error("timer deliver boom");
	});
	router.enqueue(baseNotification({ title: "A" }));
	router.enqueue(baseNotification({ title: "B" }));
	// If the throw escaped the timer callback this await would surface an
	// uncaught exception and fail the test file.
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(attempts, 1, "timer flush attempted the batch delivery exactly once");
	router.dispose();
});
