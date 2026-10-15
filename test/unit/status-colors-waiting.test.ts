import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { colorForStatus, iconForStatus } from "../../src/ui/status-colors.ts";

describe("Status colors for waiting state", () => {
	it("waiting has muted color", () => {
		assert.equal(colorForStatus("waiting"), "muted");
	});

	it("waiting has hourglass icon", () => {
		assert.equal(iconForStatus("waiting"), "⏳");
	});

	it("running has accent color", () => {
		assert.equal(colorForStatus("running"), "accent");
	});

	it("completed has success color", () => {
		assert.equal(colorForStatus("completed"), "success");
	});

	it("unknown status returns dim color", () => {
		assert.equal(colorForStatus("something_else"), "dim");
	});
});

describe("F4: planning joins the status palette (DR-02 wave 2)", () => {
	it("planning is informational/dim — explicit, not default-by-luck", () => {
		assert.equal(colorForStatus("planning"), "dim");
	});

	it("planning carries the dim-dot glyph from the colorize vocabulary", () => {
		assert.equal(iconForStatus("planning"), "·");
	});

	it("blocked stays warning (parity with rail statusSlot)", () => {
		assert.equal(colorForStatus("blocked"), "warning");
		assert.equal(iconForStatus("blocked"), "⏸");
	});
});
