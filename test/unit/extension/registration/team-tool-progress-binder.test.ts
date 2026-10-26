/**
 * FIX-ROUND MAJOR 2 (review 0.11.17): B-3 taught `formatCompactToolProgress`
 * to prefer a producer-supplied `durationMs`, but no streaming binder fed it —
 * the wiring gap was exactly "code đúng nhưng không wiring". The team tool
 * progress binder now plumbs `durationMs: Date.now() - startedAt` on every
 * tick.
 *
 * Regression strategy: pin the spinner clock FAR into the future so the
 * formatter's self-timing fallback would report ~600s. If the binder's
 * durationMs plumbing regresses (field dropped), the header flips to the
 * pinned self-time and this test fails — proving the producer → formatter
 * durationMs path end-to-end.
 *
 * The manifest is real on-disk state (`createRunManifest` + save) because the
 * binder only reaches `formatCompactToolProgress` after a successful
 * `loadRunManifestById(cwd, runId)`; the two earlier branches emit plain
 * "team status=starting…" strings that never exercise the formatter.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { startTeamToolProgressBinder } from "../../../../src/extension/registration/team-tool.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import { __setSpinnerClockSource } from "../../../../src/ui/spinner.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

test("MAJOR 2: the team-tool progress binder feeds durationMs to the formatter (producer wins over self-timing)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-binder-m2-"));
	const restoreClock = __setSpinnerClockSource(() => Date.now() + 600_000); // self-timing would say 600s
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const created = createRunManifest({
			cwd,
			team: {
				name: "default",
				description: "",
				roles: [{ name: "executor", agent: "executor" }],
				source: "test",
				filePath: "builtin",
			} as never,
			workflow: {
				name: "default",
				description: "",
				steps: [{ id: "do", role: "executor" }],
				source: "test",
				filePath: "builtin",
			} as never,
			goal: "MAJOR 2 binder durationMs regression",
		});
		const manifest: TeamRunManifest = { ...created.manifest, status: "running" };
		saveRunManifest(manifest);
		saveRunTasks(manifest, created.tasks);

		const updates: string[] = [];
		const binder = startTeamToolProgressBinder((chunk) => {
			updates.push(chunk.content.map((c) => c.text).join("\n"));
		});
		try {
			binder.attach(cwd, manifest.runId); // attach() ticks synchronously
			const text = updates.at(-1) ?? "";
			assert.match(text, /agent=.*status=running/, `expected a formatter-rendered header, got:\n${text}`);
			// The producer-measured duration is ~0ms (binder just started) and
			// MUST win over the pinned 600s self-time fallback.
			assert.match(text, /elapsed=0s/, `producer durationMs must beat self-timing (600s pin):\n${text}`);
		} finally {
			binder.stop();
		}
	} finally {
		restoreClock();
		await removeDirWithRetry(cwd);
	}
});
