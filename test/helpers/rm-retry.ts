/**
 * Shared test teardown helper — recursive delete with bounded retry.
 *
 * Class fix for CI teardown flakes (evidence):
 *  - 36091885921 (mac): adaptive-implementation ENOTEMPTY — a coalesced-write
 *    timer / in-flight artifact write recreates entries during rimraf.
 *  - 36096969768 (win): worktree-async EBUSY — Windows keeps child/process
 *    handles briefly locked after exit; bare rmSync aborts the test.
 *  - event-log-leak / subagent-tools-integration already carry local variants
 *    of this pattern; this module is the shared home (no busy-wait spin).
 *
 * Contract: settle briefly (let in-flight writers land), then up to
 * `attempts` rmSync tries with async backoff on EBUSY/EPERM/ENOTEMPTY.
 * Any other error code (and the final attempt) throws — never masks real
 * failures.
 */
import * as fs from "node:fs";
import { drainEventLogWriters } from "../../src/state/event-log/event-log.ts";

const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

export async function removeDirWithRetry(dir: string, opts: { settleMs?: number; attempts?: number } = {}): Promise<void> {
	const settleMs = opts.settleMs ?? 250;
	const attempts = opts.attempts ?? 8;
	await new Promise((resolve) => setTimeout(resolve, settleMs));
	for (let attempt = 0; ; attempt += 1) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt >= attempts - 1 || !RETRYABLE.has(code ?? "")) throw error;
			await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
		}
	}
}

/**
 * Wave-14 F2 (GAP-1): drain-then-delete teardown for a run's state root.
 *
 * Root cause (wave-14 spec §1): every queued async append re-creates the run
 * dir (`fs.promises.mkdir` inside the event-log queue tail) before appending —
 * a bare rmSync mid-flight loses that race (orphan events.jsonl / ENOTEMPTY).
 * Draining the run's writers FIRST makes the delete deterministic, so the
 * settle delay is dropped (`settleMs: 0` — the 250ms settle exists only to
 * out-wait in-flight writers, which drain just removed). Retries stay enabled
 * for OS-level EBUSY/EPERM (Windows AV scan, etc.).
 *
 * The drain is best-effort: tests without a valid eventsPath must still
 * delete.
 */
export async function cleanupStateRoot(dir: string, eventsPath?: string): Promise<void> {
	try {
		await drainEventLogWriters(eventsPath);
	} catch {
		/* best-effort — never block the delete */
	}
	await removeDirWithRetry(dir, { settleMs: 0 });
}
