/**
 * Timer-delay limits shared by every code path that converts a caller- or
 * config-supplied millisecond value into a `setTimeout` delay.
 *
 * R37-F1 (deep-review round 37): Node stores a timer's delay in a 32-bit
 * signed int. A delay above 2^31-1 overflows and the timer fires after **1 ms**
 * instead of never — so `params.timeoutMs = 2.5e9` aborted every run at birth
 * (`resolveRunDeadline` armed `setTimeout(abort, 2.5e9)` → abort at ~9 ms), and
 * a huge `waitForRun` timeout rejected immediately (`raceRunPromise`).
 * Negative / NaN / non-finite delays are equally meaningless: they either arm
 * an already-expired timer or poison deadline arithmetic (`Date.now() + NaN`).
 *
 * One constant + one validator so the boundary lives in exactly one place.
 */

/** Largest delay `setTimeout` accepts without overflow (2^31-1 ms ≈ 24.8 days). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Validate + clamp a caller-supplied delay to the timer-safe range.
 *
 * Returns `undefined` (never `0`, never `NaN`, never a clamped-to-1ms value)
 * for absent, non-numeric, non-finite, or non-positive input so callers apply
 * their own config/default fallback instead of arming a nonsense deadline.
 */
export function clampTimerDelayMs(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	if (value <= 0) return undefined;
	return Math.min(Math.floor(value), MAX_TIMER_DELAY_MS);
}
