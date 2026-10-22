/**
 * verify-gate-memo.ts — W10-2 (v0.11.38): memoized green verify-gate by
 * workspace tree-hash (pi-subagents lesson #3, tool-reference.md:432-496).
 *
 * WHY: sibling lanes / re-verifies on an UNCHANGED workspace re-run the full
 * check set (typecheck + test:critical — minutes each) for a deterministic
 * same-tree result. pisub memoizes gate acceptance by workspace tree-hash:
 * tree unchanged ⇒ same verdict, no re-run.
 *
 * SAFETY MODEL (stronger than the M1-7 manifest bookends):
 *  - The key embeds the FULL workspace tree OID (`git write-tree` over the
 *    index — every tracked file, not just manifests) + the exact check list
 *    (name+command) + the running node version. A memo HIT therefore proves
 *    the tree is bit-identical to the tree that produced the recorded PASS —
 *    no manifest re-hash needed (tree equality subsumes it).
 *  - ONLY verdict PASS outcomes are recorded (ran>0). FAILED / INCONCLUSIVE
 *    (incl. every integrity-drift and determinism downgrade) never memoize.
 *  - The lookup ITSELF re-computes the tree OID — a hit can never serve a
 *    stale tree; a miss is an ordinary full gate run (fail-open).
 *  - Not a git repo / git unavailable / write-tree failure ⇒ key undefined ⇒
 *    memo silently disabled for that cwd (ordinary gate runs).
 *  - Typed-JSON gates (structured output, W10-9 candidate) must NEVER
 *    memoize — a JSON schema consumer reads fresh structuredOutput per run.
 *    The memo records only exit-code checks; a future structured gate kind
 *    must bypass this module entirely.
 *  - KNOWN TRADEOFF (accepted by design, mirrors pisub): tests that are
 *    time-dependent or environment-sensitive can pass once and be skipped on
 *    an unchanged tree. The kill-switch PI_CREW_VERIFY_GATE_MEMO=0 restores
 *    pre-W10-2 behavior bit-for-bit (default ON).
 *
 * Scope: host-process in-memory Map. Parallel sibling lanes within one host
 * process share it; cross-process persistence is deliberately out of scope.
 */
import { execFileSync } from "node:child_process";

import { getCrewEnvBool } from "../../config/env-vars.ts";
import type { VerifyGateCheck, VerifyGateOutcome } from "./verify-gate.ts";

/** W10-2 kill-switch: PI_CREW_VERIFY_GATE_MEMO beats default ON. */
export function resolveVerifyGateMemoEnabled(explicit?: boolean): boolean {
	const env = getCrewEnvBool("PI_CREW_VERIFY_GATE_MEMO");
	if (env !== undefined) return env;
	return explicit ?? true;
}

/** Tree OID of `cwd`'s git index, or undefined when git/repo unavailable. */
export function computeWorkspaceTreeOid(cwd: string): string | undefined {
	try {
		const oid = execFileSync("git", ["write-tree"], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf-8",
			timeout: 10_000,
		}).trim();
		return /^[0-9a-f]{40}$/.test(oid) ? oid : undefined;
	} catch {
		return undefined;
	}
}

/** Deterministic memo key: tree OID + check list + node major.minor.
 *  Undefined tree OID ⇒ undefined key ⇒ memo disabled for this cwd. */
export function computeVerifyGateMemoKey(cwd: string, checks: VerifyGateCheck[]): string | undefined {
	const oid = computeWorkspaceTreeOid(cwd);
	if (!oid) return undefined;
	const checkPart = checks.map((c) => `${c.name}::${c.command}::crit=${c.critical !== false}`).join("|");
	return `${oid}::${process.version}::${checkPart}`;
}

/** In-host memo store (module-level: one per host process). */
const memoStore = new Map<string, VerifyGateOutcome>();

/** Test hook: wipe the store between unit tests. */
export function resetVerifyGateMemoStoreForTests(): void {
	memoStore.clear();
}

/** Build the memo-HIT outcome: verdict PASS with every check marked
 *  skipped-memo — evidence lines make the hit auditable in prompts/metrics. */
function memoHitOutcome(key: string, checks: VerifyGateCheck[]): VerifyGateOutcome {
	const oid = key.split("::")[0];
	return {
		verdict: "PASS",
		checks: checks.map((c) => ({
			name: c.name,
			command: c.command,
			exitCode: 0,
			passed: true,
			durationMs: 0,
			outputTail: "",
			skipped: true,
			error: `memoized (tree ${oid.slice(0, 12)} unchanged since recorded PASS)`,
		})),
		evidenceLines: [
			`verify-gate-memo: HIT — workspace tree ${oid.slice(0, 12)} + ${checks.length} check(s) unchanged since recorded PASS (W10-2)`,
		],
		allPassed: true,
		totalDurationMs: 0,
	};
}

/** Lookup a recorded PASS for this exact (tree, checks, node) triple.
 *  Returns undefined on miss / disabled / unkeyable cwd. */
export function lookupVerifyGateMemo(cwd: string, checks: VerifyGateCheck[]): VerifyGateOutcome | undefined {
	if (checks.length === 0) return undefined;
	const key = computeVerifyGateMemoKey(cwd, checks);
	if (!key) return undefined;
	const hit = memoStore.get(key);
	return hit ? memoHitOutcome(key, checks) : undefined;
}

/** Record an outcome — ONLY a ran PASS with real (non-memo) evidence.
 *  Memo-hit outcomes must not re-record (they carry skipped checks). */
export function recordVerifyGateMemo(cwd: string, checks: VerifyGateCheck[], outcome: VerifyGateOutcome): boolean {
	if (checks.length === 0) return false;
	if (outcome.verdict !== "PASS" || !outcome.allPassed) return false;
	const ranReal = outcome.checks.some((c) => !c.skipped);
	if (!ranReal) return false;
	const key = computeVerifyGateMemoKey(cwd, checks);
	if (!key) return false;
	memoStore.set(key, outcome);
	return true;
}
