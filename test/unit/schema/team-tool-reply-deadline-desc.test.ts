/**
 * DR-04 W5 / R7-5 (2026-10-16, docs-truth).
 *
 * `replyDeadline` is write-only metadata: the enforced deadline is the
 * broker-clamped `task.waiting.deadline`. The schema description must say so —
 * models reading "Ms epoch deadline for a reply" acted on a deadline nothing
 * enforces. This test pins the advisory-truth wording so docs drift fails CI.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { TeamToolParams } from "../../../src/schema/team-tool-schema.ts";

const ADVISORY_DESCRIPTION =
	"Advisory metadata only. The enforced deadline is auto-clamped by the broker (task.waiting.deadline); this value is recorded, not enforced.";

type SchemaWithDescription = { description?: string };

test("R7-5: replyDeadline schema description states the advisory truth", () => {
	const properties = TeamToolParams.properties as Record<string, SchemaWithDescription>;
	const replyDeadline = properties.replyDeadline;
	assert.ok(replyDeadline, "replyDeadline property exists on TeamToolParams");
	assert.equal(replyDeadline.description, ADVISORY_DESCRIPTION, "replyDeadline description must be the advisory-truth wording (R7-5)");
});

test("R7-5: replyDeadline description no longer claims a bare enforcement deadline", () => {
	const properties = TeamToolParams.properties as Record<string, SchemaWithDescription>;
	const description = properties.replyDeadline?.description ?? "";
	assert.equal(description.includes("Ms epoch deadline for a reply."), false, "old wording must be gone");
	assert.match(description, /recorded, not enforced/);
	assert.match(description, /task\.waiting\.deadline/);
});
