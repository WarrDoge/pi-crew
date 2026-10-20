# Real-Test Battery — Wave S* (undefined-shadow exact-env) — 2026-10-20

Base v0.11.29 (`c4efadc3`) → target v0.11.30. Repo: `/home/bom/source/my_pi/pi-crew`.

## Changed surfaces
- `src/runtime/child-pi/child-pi-rpc.ts` — S* implementation:
  - NEW `buildExactEnvShadowOptions()`: RpcClient env option now carries
    `undefined` for every parent key outside the intended allowlisted set.
  - DELETED the `process.env = childEnv` global swap (wave-2b..8 mechanism).
  - Canary marker explicitly `undefined`-shadowed (ordering bug — delete lets
    the parent marker win the merge — caught live by the wiring pin).
  - Comments rewritten for the new model: drift is structurally inert; the
    canary is a production tripwire for "child env == intended set".
- `test/unit/runtime/child-pi/env-splice-canary.test.ts` — rewritten for S*
  semantics (12 tests; see SDD).

## Why this is the correct tier set (decision table)
child-pi surface changed (runtime/broker-adjacent) → T1, T3, T7 live, T11j;
UI/surface/schema/agents untouched → T2/T5/T6/T9/T10/T12/T13 not required;
T4/T8 meta (bundle serves from the new dist; proven by T7 running the new
bundle in a real session).

## Tiers run
| Tier | Result |
|---|---|
| T1 critical | 124/124 (first run 3-file load flake: mailbox-observer, symlink-steering, heartbeat-pulse — each isolated-green; full rerun green; adjudicated) |
| Unit full (canonical runner) | 9833 / **0 fail** (one R5-6 clamp failure under parallel-load only — isolated green + rerun green) |
| Integration full | 147 tests / 143 pass / 0 fail |
| tsc / biome / lint | 0 / 0 / 0 |
| Meta gates | bundle build ✓ staleness ✓ lazy ✓ env-vars ✓ decision-drift ✓ conflict-markers ✓ event-types --enforce ✓ |
| T7 live session | real `pi -ne --extension dist/index.mjs` session, exit 0, byte-check **BANANA-SSTAR** ×9, usage surfaced (12,193/12,231 tok), prune-anchor silence held (0 lines) |
| Mutation checks | (1) shadow-loop removal → 3 S* pins RED, 9 others GREEN; (2) delete-marker-instead-of-shadow → WIRING RED (the exact ordering bug hit during dev) — both restored green |

## Behavioral notes for reviewers
- json-mode spawn path: UNTOUCHED (was already exact-env by construction —
  Node spawn `env` option replaces entirely).
- rpc pooled path: no spawn → no shadow involved.
- Windows: exactness is now platform-uniform (JS-level; no OS observation
  needed for PREVENTION). The win32 "unobservable" warn remains only for the
  TRIPWIRE's verification layer, not for prevention.
- Forward-compat: upstream removing the process.env spread keeps behavior
  identical (undefined entries still dropped by Node).

## Verdict
**GO** for v0.11.30.
