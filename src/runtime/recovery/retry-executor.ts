import { logInternalError } from "../../utils/internal-error.ts";
import { sleep } from "../../utils/sleep.ts";
import { throwIfCancelled } from "../process/cancellation.ts";

export interface RetryPolicy {
	maxAttempts: number;
	backoffMs: number;
	jitterRatio: number;
	exponentialFactor: number;
	retryableErrors?: string[];
	/**
	 * CORE-3 — per-task spawn budget cap. Maximum total worker spawns
	 * (runWorker/runChildPi calls) allowed across ALL retry attempts × model
	 * fallback iterations for a single task. When omitted or 0, the budget
	 * auto-computes as `attemptModels.length × (maxAttempts + 1)` in
	 * task-runner.ts (always ≥ 1 full attempt above the theoretical max).
	 * Set explicitly to override the auto-computed value.
	 */
	maxTotalSpawns?: number;
}

export interface RetryAttemptInfo {
	attempt: number;
	attemptId: string;
}

/**
 * U9-ADJ (upgrade 2026-10-13 §U9): terminal sentinel thrown when the retry
 * loop stops because the `noProgress` hook detected a stuck loop. Distinct
 * from ordinary give-up (exhaustion throws the ORIGINAL error untouched):
 * this carries `reason: "no_progress"` plus the attempt info, with the
 * original error preserved as `cause`. Callers distinguish the two exits via
 * `error instanceof RetryNoProgressError` or `reason === "no_progress"`.
 */
export class RetryNoProgressError extends Error {
	readonly reason: "no_progress";
	readonly attempt: number;
	readonly attemptId: string;
	readonly durationMsLast: number;

	constructor(details: { attempt: number; attemptId: string; durationMsLast: number; error: Error }) {
		super(
			`Retry loop stopped after attempt ${details.attempt} (${details.attemptId}): no progress between attempts (last attempt took ${details.durationMsLast}ms). Original error: ${details.error.message}`,
			{ cause: details.error },
		);
		this.name = "RetryNoProgressError";
		this.reason = "no_progress";
		this.attempt = details.attempt;
		this.attemptId = details.attemptId;
		this.durationMsLast = details.durationMsLast;
	}
}

export interface RetryHooks {
	onAttemptFailed?: (attempt: number, error: Error, nextDelayMs: number, info: RetryAttemptInfo) => void;
	onRetryGivenUp?: (attempts: number, error: Error, info: RetryAttemptInfo) => void;
	attemptId?: (attempt: number) => string;
	signal?: AbortSignal;
	/**
	 * U6A (upgrade spec 2026-10-09 §U6 Phase A): async pre-gate consulted
	 * after a failed attempt and BEFORE the next one is queued. Returning
	 * false gives up exactly like non-retryable exhaustion (onRetryGivenUp +
	 * throw of the ORIGINAL error — the gate itself can never introduce a new
	 * failure). SOFT contract: a throwing/rejecting hook is swallowed and
	 * treated as "retry" — a broken gate must never change retry behavior.
	 * Consumer: dispatch-batch's ambient-noise classifier gate
	 * (classifyAmbientNoiseGate), dormant unless runtime.classifierEnabled.
	 */
	shouldRetry?: (attempt: number, error: Error, info: RetryAttemptInfo) => boolean | Promise<boolean>;
	/**
	 * U9-ADJ (upgrade 2026-10-13 §U9): no-progress gate consulted after a
	 * failed attempt ONCE `shouldRetry` (if present) has approved queueing the
	 * next one, and BEFORE onAttemptFailed + backoff sleep. The CALLER owns the
	 * "no progress" semantics (e.g. compare checkpoint depth / error identity
	 * between attempts) — the executor stays generic and task-agnostic.
	 * `lastResult` / `previousResult` are the `Error`s thrown by the just-failed
	 * attempt and the one before it (`previousResult` is `undefined` on the
	 * first failure — nothing to compare yet); `durationMsLast` is the wall
	 * time of the just-failed attempt in ms. Returning true stops the loop with
	 * `RetryNoProgressError` (`reason: "no_progress"`) instead of spawning the
	 * next attempt — `onRetryGivenUp` still fires first (same terminal contract
	 * as the cancellation exit). SOFT: a throwing/rejecting hook is logged via
	 * console.error and treated as false — a broken detector must never change
	 * retry behavior. Unregistered ⇒ behaviour is bit-for-bit pre-U9-ADJ.
	 */
	noProgress?: (context: {
		attempt: number;
		lastResult: unknown;
		previousResult: unknown;
		durationMsLast: number;
	}) => boolean | Promise<boolean>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 3,
	backoffMs: 1000,
	jitterRatio: 0.3,
	exponentialFactor: 2,
};

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function globToRegex(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

function isRetryable(error: Error, policy: RetryPolicy): boolean {
	const patterns = policy.retryableErrors ?? [];
	if (!patterns.length) return true;
	return patterns.some((pattern) => globToRegex(pattern).test(error.message));
}

export function calculateRetryDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY, random = Math.random): number {
	const base = policy.backoffMs * policy.exponentialFactor ** Math.max(0, attempt - 1);
	const jitter = (random() * 2 - 1) * policy.jitterRatio * base;
	return Math.max(0, base + jitter);
}

function retryAttemptInfo(attempt: number, hooks: RetryHooks): RetryAttemptInfo {
	return {
		attempt,
		attemptId: hooks.attemptId?.(attempt) ?? `retry_attempt_${attempt}`,
	};
}

export async function executeWithRetry<T>(
	fn: (attempt: number, info: RetryAttemptInfo) => Promise<T>,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
	hooks: RetryHooks = {},
): Promise<T> {
	const normalized: RetryPolicy = {
		...DEFAULT_RETRY_POLICY,
		...policy,
		maxAttempts: Math.max(1, policy.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts),
	};
	let lastError: Error | undefined;
	// U9-ADJ: result (thrown Error) of the PREVIOUS failed attempt, fed to the
	// noProgress hook as `previousResult`. `undefined` until a first failure.
	let previousFailedResult: unknown;
	for (let attempt = 1; attempt <= normalized.maxAttempts; attempt += 1) {
		throwIfCancelled(hooks.signal);
		const info = retryAttemptInfo(attempt, hooks);
		const attemptStartedAtMs = Date.now();
		try {
			return await fn(attempt, info);
		} catch (error) {
			lastError = asError(error);
			const durationMsLast = Date.now() - attemptStartedAtMs;
			// Never retry if aborted — sleep() would immediately reject on every attempt.
			if (hooks.signal?.aborted) {
				hooks.onRetryGivenUp?.(attempt, lastError, info);
				throw lastError;
			}
			if (attempt >= normalized.maxAttempts || !isRetryable(lastError, normalized)) {
				hooks.onRetryGivenUp?.(attempt, lastError, info);
				throw lastError;
			}
			// U6A: ambient-noise pre-gate — consulted once per failed attempt,
			// after retryability, BEFORE the backoff sleep + next spawn. SOFT:
			// hook errors are logged and treated as "retry" (fallback true), so
			// the gate can only skip a queued retry, never break the loop.
			if (hooks.shouldRetry) {
				let gateDecision = true;
				try {
					gateDecision = await hooks.shouldRetry(attempt, lastError, info);
				} catch (gateError) {
					logInternalError("retry-executor.shouldRetry", gateError, "soft-fail: proceeding with the queued retry", "warn");
					gateDecision = true;
				}
				if (gateDecision === false) {
					hooks.onRetryGivenUp?.(attempt, lastError, info);
					throw lastError;
				}
			}
			// U9-ADJ: no-progress gate — consulted once per failed attempt, after
			// retryability + shouldRetry, BEFORE the backoff sleep + next spawn.
			// Only the caller knows task semantics, so it compares the just-failed
			// attempt against the previous one and decides. true ⇒ stop the loop
			// with the distinct no_progress reason (not ordinary give-up exhaustion).
			// SOFT: hook errors are logged (console.error) and treated as false.
			if (hooks.noProgress) {
				let noProgressDecision = false;
				try {
					noProgressDecision = await hooks.noProgress({
						attempt,
						lastResult: lastError,
						previousResult: previousFailedResult,
						durationMsLast,
					});
				} catch (noProgressError) {
					logInternalError(
						"retry-executor.noProgress",
						noProgressError,
						"soft-fail: treating as progress, retry stays queued",
						"error",
					);
					noProgressDecision = false;
				}
				if (noProgressDecision === true) {
					hooks.onRetryGivenUp?.(attempt, lastError, info);
					throw new RetryNoProgressError({
						attempt,
						attemptId: info.attemptId,
						durationMsLast,
						error: lastError,
					});
				}
			}
			previousFailedResult = lastError;
			const delay = calculateRetryDelay(attempt, normalized);
			hooks.onAttemptFailed?.(attempt, lastError, delay, info);
			try {
				await sleep(delay, hooks.signal);
			} catch (sleepError) {
				if (hooks.signal?.aborted) throwIfCancelled(hooks.signal);
				throw sleepError;
			}
		}
	}
	throw lastError ?? new Error("Retry failed without error.");
}
