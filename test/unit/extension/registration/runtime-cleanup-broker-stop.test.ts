/**
 * R7-11 (DR-04 round 7): cleanupRuntime must stop the inter-pi broker
 * lifecycle controller — exactly once, idempotently — while the
 * session-switch cleanup (cleanupSessionResourcesOnly) must NOT stop it
 * (the broker is retained across session switches by design; see the
 * CrewBrokerLifecycleController docblock in lifecycle-handlers.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildRegistrationContext } from "../../../../src/extension/registration/context-builder.ts";
import type { RegistrationContext } from "../../../../src/extension/registration/registration-types.ts";
import { installRuntimeCleanup } from "../../../../src/extension/registration/runtime-cleanup.ts";

function createEventBus() {
	const handlers = new Map<string, Set<(payload: unknown) => void>>();
	return {
		on(event: string, handler: (payload: unknown) => void) {
			const set = handlers.get(event) ?? new Set<(payload: unknown) => void>();
			set.add(handler);
			handlers.set(event, set);
			return () => {
				set.delete(handler);
			};
		},
		emit(event: string, payload: unknown) {
			for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
		},
	};
}

function createFakePi(events: ReturnType<typeof createEventBus>) {
	return { events };
}

interface BrokerStopSpy {
	stopCalls: number;
}

function makeCtxWithBrokerSpy(pi: ReturnType<typeof createFakePi>): { ctx: RegistrationContext; spy: BrokerStopSpy } {
	const ctx = buildRegistrationContext(pi as never);
	const spy: BrokerStopSpy = { stopCalls: 0 };
	ctx.brokerController = {
		issueForChild: async () => undefined,
		stop: async () => {
			spy.stopCalls++;
		},
		setSessionId: () => undefined,
	} as never;
	installRuntimeCleanup(pi as never, ctx);
	return { ctx, spy };
}

test("R7-11: cleanupRuntime stops the broker controller exactly once (idempotent)", async () => {
	const events = createEventBus();
	const pi = createFakePi(events);
	const { ctx, spy } = makeCtxWithBrokerSpy(pi);
	assert.equal(typeof ctx.cleanupRuntime, "function");

	ctx.cleanupRuntime();
	ctx.cleanupRuntime(); // re-entry must be a no-op (cleanedUp gate)
	// stop() is fire-and-forget inside the sync cleanup — let the microtask drain.
	await new Promise((resolve) => setTimeout(resolve, 20));

	assert.equal(spy.stopCalls, 1, `broker stop must be called exactly once, got ${spy.stopCalls}`);
	assert.equal(ctx.brokerController, undefined, "cleanupRuntime must clear the stopped controller");
});

test("R7-11: a broker stop() that rejects does not break the rest of cleanupRuntime", async () => {
	const events = createEventBus();
	const pi = createFakePi(events);
	const ctx = buildRegistrationContext(pi as never);
	ctx.brokerController = {
		issueForChild: async () => undefined,
		stop: async () => {
			throw new Error("broker socket already closed");
		},
		setSessionId: () => undefined,
	} as never;
	installRuntimeCleanup(pi as never, ctx);

	let threw = false;
	try {
		ctx.cleanupRuntime();
	} catch {
		threw = true;
	}
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(threw, false, "cleanupRuntime must swallow broker stop() failures");
	assert.equal(ctx.cleanedUp, true, "cleanup must still complete");
});

test("R7-11: session-switch cleanup (cleanupSessionResourcesOnly) does NOT stop the broker", () => {
	const events = createEventBus();
	const pi = createFakePi(events);
	const { ctx, spy } = makeCtxWithBrokerSpy(pi);

	ctx.cleanupSessionResourcesOnly();

	assert.equal(spy.stopCalls, 0, "the broker is retained across session switches by design");
});
