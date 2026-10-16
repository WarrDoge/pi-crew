import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChildPiSpawnOptions } from "../../src/runtime/child-pi/child-pi.ts";

// Per-task API key scoping: a worker assigned to a specific model only receives
// that provider's env keys. Provider keys for other models are stripped.
// When no model is provided, NO provider keys leak (deny-by-default).

test("scopes API keys to OpenAI when model='openai/gpt-4o'", () => {
	const opts = buildChildPiSpawnOptions(
		"/tmp/project",
		{
			PATH: "/usr/bin",
			HOME: "/home/user",
			OPENAI_API_KEY: "openai-secret",
			ANTHROPIC_API_KEY: "anthropic-secret",
			GOOGLE_API_KEY: "google-secret",
		},
		"openai/gpt-4o",
	);
	const env = opts.env as Record<string, string>;
	assert.equal(env.OPENAI_API_KEY, "openai-secret", "OpenAI key should be present");
	assert.equal(env.ANTHROPIC_API_KEY, undefined, "Anthropic key must NOT be present");
	assert.equal(env.GOOGLE_API_KEY, undefined, "Google key must NOT be present");
	// System vars still present
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.HOME, "/home/user");
});

test("scopes API keys to Anthropic when model='anthropic/claude'", () => {
	const opts = buildChildPiSpawnOptions(
		"/tmp/project",
		{
			PATH: "/usr/bin",
			OPENAI_API_KEY: "openai-secret",
			ANTHROPIC_API_KEY: "anthropic-secret",
		},
		"anthropic/claude-sonnet-4-5",
	);
	const env = opts.env as Record<string, string>;
	assert.equal(env.ANTHROPIC_API_KEY, "anthropic-secret", "Anthropic key should be present");
	assert.equal(env.OPENAI_API_KEY, undefined, "OpenAI key must NOT be present");
});

test("injects AWS keys for bedrock model", () => {
	const opts = buildChildPiSpawnOptions(
		"/tmp/project",
		{
			PATH: "/usr/bin",
			AWS_ACCESS_KEY_ID: "aws-key",
			AWS_SECRET_ACCESS_KEY: "aws-secret",
			AWS_REGION: "us-east-1",
			OPENAI_API_KEY: "openai-secret",
		},
		"bedrock/anthropic.claude",
	);
	const env = opts.env as Record<string, string>;
	assert.equal(env.AWS_ACCESS_KEY_ID, "aws-key", "AWS key should be present");
	assert.equal(env.AWS_REGION, "us-east-1", "AWS region should be present");
	assert.equal(env.OPENAI_API_KEY, undefined, "OpenAI key must NOT be present");
});

test("leaks no provider keys when model is undefined", () => {
	const opts = buildChildPiSpawnOptions("/tmp/project", {
		PATH: "/usr/bin",
		HOME: "/home/user",
		OPENAI_API_KEY: "openai-secret",
		ANTHROPIC_API_KEY: "anthropic-secret",
	});
	const env = opts.env as Record<string, string>;
	assert.equal(env.OPENAI_API_KEY, undefined, "OpenAI key must NOT leak when model undefined");
	assert.equal(env.ANTHROPIC_API_KEY, undefined, "Anthropic key must NOT leak when model undefined");
	assert.equal(env.PATH, "/usr/bin", "PATH should still be present");
	assert.equal(env.HOME, "/home/user", "HOME should still be present");
});

test("leaks no extra provider keys for unknown provider", () => {
	const opts = buildChildPiSpawnOptions(
		"/tmp/project",
		{
			PATH: "/usr/bin",
			OPENAI_API_KEY: "openai-secret",
			ANTHROPIC_API_KEY: "anthropic-secret",
		},
		"custom/unknown-model",
	);
	const env = opts.env as Record<string, string>;
	assert.equal(env.OPENAI_API_KEY, undefined, "OpenAI key must NOT leak for unknown provider");
	assert.equal(env.ANTHROPIC_API_KEY, undefined, "Anthropic key must NOT leak for unknown provider");
	assert.equal(env.PATH, "/usr/bin", "PATH should still be present");
});

// ── R6-8 (DR-03 round-6): model candidate chain scoping + bare-id warn ──────

// R6-8 regression: only the CURRENT model was passed to buildScopedAllowList,
// so a fallback attempt on a 2nd provider spawned keyless and failed auth with
// a non-retryable /api key/i error, breaking the chain even though qualified
// fallbacks were queued (the env-filter.ts doc contract promised "primary +
// fallbacks"). The chain is now threaded through the spawn context.
test("R6-8: modelChain scoping includes the 2nd provider's key (primary + fallbacks)", () => {
	const opts = buildChildPiSpawnOptions(
		"/tmp/project",
		{
			PATH: "/usr/bin",
			HOME: "/home/user",
			OPENAI_API_KEY: "openai-secret",
			ANTHROPIC_API_KEY: "anthropic-secret",
			GOOGLE_API_KEY: "google-secret",
		},
		"openai/gpt-4o",
		["openai/gpt-4o", "anthropic/claude-sonnet-4-5"],
	);
	const env = opts.env as Record<string, string>;
	assert.equal(env.OPENAI_API_KEY, "openai-secret", "primary provider key must be present");
	assert.equal(env.ANTHROPIC_API_KEY, "anthropic-secret", "2nd provider (fallback) key must be present via the chain");
	assert.equal(env.GOOGLE_API_KEY, undefined, "providers OUTSIDE the chain must NOT leak (no all-provider leak)");
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.HOME, "/home/user");
});

test("R6-8: bare primary + qualified fallback chain gets the fallback provider's key and does not warn", () => {
	// The exact R6-8 stall shape: a bare-id primary resolves zero provider keys
	// on its own, but the queued qualified fallback keeps the chain alive — the
	// fallback provider's keys must be scoped in, and no warn may fire (the
	// chain IS available).
	const original = console.error;
	const calls: string[] = [];
	console.error = (msg: string) => {
		calls.push(msg);
	};
	try {
		const opts = buildChildPiSpawnOptions(
			"/tmp/project",
			{
				PATH: "/usr/bin",
				OPENAI_API_KEY: "openai-secret",
				ANTHROPIC_API_KEY: "anthropic-secret",
				GOOGLE_API_KEY: "google-secret",
			},
			"some-bare-model",
			["some-bare-model", "anthropic/claude-sonnet-4-5"],
		);
		const env = opts.env as Record<string, string>;
		assert.equal(env.ANTHROPIC_API_KEY, "anthropic-secret", "qualified fallback's provider key must be scoped in");
		assert.equal(env.OPENAI_API_KEY, undefined, "unrelated providers must NOT leak");
		assert.equal(env.GOOGLE_API_KEY, undefined, "unrelated providers must NOT leak");
		assert.equal(env.PATH, "/usr/bin");
	} finally {
		console.error = original;
	}
	assert.equal(
		calls.filter((line) => line.includes("child-pi-spawn.bare-model-no-provider-keys")).length,
		0,
		"no bare-id warn when the chain provides a qualified provider",
	);
});

test("R6-8: bare id without a chain warns and passes base keys only (no all-provider leak)", () => {
	// Where the chain is NOT available (truly bare single model), the fix must
	// NOT weaken scoping to compensate — instead it warns: env-key auth + bare
	// id is a likely misconfiguration (auth.json users are unaffected).
	const original = console.error;
	const calls: string[] = [];
	console.error = (msg: string) => {
		calls.push(msg);
	};
	try {
		const opts = buildChildPiSpawnOptions(
			"/tmp/project",
			{
				PATH: "/usr/bin",
				HOME: "/home/user",
				OPENAI_API_KEY: "openai-secret",
				ANTHROPIC_API_KEY: "anthropic-secret",
				GOOGLE_API_KEY: "google-secret",
			},
			"gpt-4o", // bare id — no provider prefix
		);
		const env = opts.env as Record<string, string>;
		assert.equal(env.OPENAI_API_KEY, undefined, "no provider key may leak for a bare id");
		assert.equal(env.ANTHROPIC_API_KEY, undefined, "no all-provider leak");
		assert.equal(env.GOOGLE_API_KEY, undefined, "no all-provider leak");
		assert.equal(env.PATH, "/usr/bin", "base keys still pass");
		assert.equal(env.HOME, "/home/user", "base keys still pass");
	} finally {
		console.error = original;
	}
	const warns = calls.filter((line) => line.includes("child-pi-spawn.bare-model-no-provider-keys"));
	assert.equal(warns.length, 1, "structured warn must fire exactly once");
	assert.match(warns[0]!, /gpt-4o/);
	assert.match(warns[0]!, /bare id/);
});
