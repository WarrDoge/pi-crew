# Real-Test Battery — Wave S-broker (inference broker PoC) — 2026-10-20

Base v0.11.30 (`2a4da6a0`) → target v0.11.31. Repo: `/home/bom/source/my_pi/pi-crew`.

## Changed surfaces
- NEW `src/runtime/child-pi/inference-broker.ts` — loopback broker (auth,
  substitution, budget, revoke, usage counting, scoped agent dir).
- `src/runtime/child-pi/child-pi-spawn.ts` — broker-active → BASE allowlist
  only (provider keys NEVER injected) + PI_CODING_AGENT_DIR mapped at the
  spawn-options layer + token issuance in prepareSpawnContext (+ SpawnContext
  field).
- `src/runtime/child-pi/child-pi.ts` — `await maybeStartInferenceBroker()` at
  run() head (http listen needs an event-loop turn; spawn path stays sync).
- `src/extension/crew-cleanup.ts` — stopInferenceBroker on session shutdown
  (revokeAll + scoped-dir removal) BEFORE generic temp cleanup.
- `src/config/env-vars.ts` + `env-allowlist-registry.ts` — 4 new registry keys
  with forwarding decisions; `scripts/check-lazy-imports.mjs` budget 532→533.
- NEW `test/unit/runtime/child-pi/inference-broker.test.ts` (15 tests incl.
  LIVE e2e with the real `pi` binary); registry snapshot pin updated.

## Why this tier set (decision table)
Child-pi runtime + extension entry changed → T1, T3, T7 live, T11j; no UI/
schema/agents/workflow changes → T2/T5/T6/T9/T10/T12/T13 not required. The
LIVE e2e broker test additionally exercises a REAL SDK session against the
broker (stronger than T7 for this surface, but broker-off default is covered
by T7 itself).

## Tiers run
| Tier | Result |
|---|---|
| T1 critical | 124/124 |
| Broker battery | 15/15 (incl. LIVE e2e: real `pi -p` via scoped dir + broker + mock upstream; upstream saw the real key; worker env had NO ANTHROPIC_API_KEY) |
| Mutation checks ×4 | skip-auth → 4 red · forward-client-auth → 3 red (incl. LIVE) · budget-off → 1 red · provider-keys-still-injected (wiring) → 1 red — all restored green |
| Env-splice-canary (S\*) regression | 12/12 |
| child-pi-rpc-mode regression | 18/18 |
| Unit full | 9854 tests / 9850 pass / 0 fail (one before_retry flake under parallel load — isolated 11/11 green + full rerun green; one registry-snapshot pin legitimately updated for 4 new keys) |
| Integration full | 147/143/0 |
| tsc / biome / lint | 0 / 0 / 0 |
| Meta gates | bundle ✓ staleness ✓ lazy (budget 533) ✓ env-vars ✓ decision-drift ✓ conflict-markers ✓ event-types --enforce ✓ |
| T7 live session | `pi -ne --extension dist/index.mjs` — exit 0, **BANANA-SBROKER** ×9, usage surfaced (12,182/12,420 tok), prune-anchor silence held (0 lines) — broker-off default path unchanged |

## Behavioral notes
- Default (flag off): zero behavior change — every legacy path regression-pinned
  ((e2) provider keys still flow per scoped allowlist).
- Broker on: provider env keys NEVER injected (even with an anthropic model
  chain); the ONLY credential in the child env is `PI_CREW_INFERENCE_TOKEN`;
  `PI_CODING_AGENT_DIR` is pi's native var, mapped at the spawn-options layer
  (never through built.env — assertOnlyControlEnvKeys contract untouched).
- Pooled RPC reuse: token pinned at first spawn (same as other per-run control
  vars — documented pool limitation).
- Debug detour worth recording: a mock-upstream content-length bug (header
  computed from `opts?.sse ?? ""` → "0" on the default path) produced
  byte-accurate-relay failures that looked like broker stream bugs; the mock
  now computes the body once. Lesson: verify the FIXTURE before auditing the
  code under test.

## Verdict
**GO** for v0.11.31.

## SHIP TRAIL (v0.11.31→v0.11.33)
- v0.11.31 `8eb3e6c2` — CI RED (Windows POSIX-mode assert — known lesson re-applied) → v0.11.32 `dbf310e5`+`33f127ae` — CI RED (biome unused-import after mutation-restore; unsafe-fix not auto-applied) → v0.11.33 `67486540` (lint fix) + `34ef039b` (dist rebuild — T11j caught the missing rebuild) — CI run 39547565041 GREEN after 2 adjudicated rerun-failed (async-notifier + heartbeat-pulse; owned-process-u15 — all isolated-green, timing flakes unrelated to the broker).
- npm `+ pi-crew@0.11.33`; dist-tags.latest=0.11.33; release v0.11.33 (Latest).
