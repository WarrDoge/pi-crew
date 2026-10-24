# Real-test battery — Wave 12 (fixture teardown) pre-v0.11.40 gate

- **Date**: 2026-10-25 (run wall-clock 04:36 → 05:13 +07:00)
- **Repo**: `/home/bom/source/my_pi/pi-crew`
- **HEAD**: `c5e607b3` — `test(fixture): normalise low-risk fixture teardown to group reap; document fixture lifecycle rules (wave 12c-F4/F6)`
- **Tree at start**: clean (`git status --short` empty)
- **Node**: v22.23.1 · **npm**: 10.9.8
- **Load**: 6.42 → 8.90 at unit start → **13.58 peak** during full unit → 6.68 at end
- **Env scrub**: `$(env | grep -oE '^(PI_CREW|PI_TEAMS)[A-Z0-9_]*' | sed 's/^/-u /')` applied to every test command. Ambient worker shell carried `PI_CREW_MSG_ENABLED`, `PI_CREW_BROKER_{SOCKET,TOKEN,RUN_ID,TASK_ID}`, `PI_CREW_DEPTH`, `PI_TEAMS_DEPTH`, `PI_CREW_EVENTS_PATH` — precisely the set that previously caused 4 cancelled tests. `PI_CREW_TEST_NO_HOME_ISOLATION` was **absent**, so nothing had to be re-added.

## Verdict: **PASS**

---

## Pin 1 — targeted wave-12 suites ×3 (30 runs)

All 30 runs **exit 0**, 0 fail. Deterministic across 3 consecutive repetitions.

| Suite | tests/run | ×3 exits |
|---|---|---|
| `test/unit/helpers/fixture-process.test.ts` | 5 | 0,0,0 |
| `test/unit/runtime/process/getuid-seam.test.ts` | 10 | 0,0,0 |
| `test/unit/runtime/process/reap-group.test.ts` | 28 | 0,0,0 |
| `test/unit/runtime/process/run-descendant-sweep.test.ts` | 21 | 0,0,0 |
| `test/unit/runtime/stale-reconciler-run-descendant-sweep.test.ts` | 14 | 0,0,0 |
| `test/integration/background-runner-sigint-cleanup.test.ts` | 1 | 0,0,0 |
| `test/integration/run-descendant-sweep-live.test.ts` | 1 | 0,0,0 |
| `test/unit/retrieval-orchestrator.test.ts` | 18 | 0,0,0 |
| `test/unit/runtime/child-pi/inference-broker.test.ts` | 21 | 0,0,0 |
| `test/unit/prompt/message-tool.test.ts` | 8 | 0,0,0 |

## Pin 2 — message-tool hermeticity matrix

| Variant | Env | exit | pass | fail | cancelled |
|---|---|---|---|---|---|
| (a) scrubbed | all `PI_CREW_*`/`PI_TEAMS_*` unset | 0 | **8/8** | 0 | 0 |
| (b) scrubbed + injected | `PI_CREW_MSG_ENABLED=1 PI_CREW_BROKER_SOCKET=/tmp/fake-sock PI_CREW_BROKER_TOKEN=t PI_CREW_BROKER_RUN_ID=r PI_CREW_BROKER_TASK_ID=t` | 0 | **8/8** | 0 | 0 |
| (c) ambient worker shell | no scrub at all | 0 | **8/8** | 0 | 0 |

Hermeticity confirmed: the suite no longer depends on inherited broker/msg env in either direction.

## Pin 3 — test:critical

`npm run test:critical` → **exit 0, 124/124 pass**, 0 fail, 0 skip, 0 cancelled (23.4 s). Matches baseline exactly.

## Pin 4 — full unit (sharded)

`npm run test:unit` (concurrency=4) → **exit 1**

```
# tests 10015   # pass 10009   # fail 2   # skipped 4   # cancelled 0   # duration_ms 1201516 (~20 min)
```

### Failures + adjudication

Neither failure is on the documented baseline list; both were re-run isolated ×2.

| # | File:line | Error | Isolated ×2 | Adjudication |
|---|---|---|---|---|
| 1 | `test/unit/extension/team-tool-steer-clamp.test.ts` (test `R5-6: exactly at the limit is verbatim`) | `failureType: hookFailed` — `ENOTEMPTY: directory not empty, rmdir '/tmp/pi-crew-steer-clamp-BixwXh/.crew/state/runs'` | **exit 0, 3/3 pass** twice | **FLAKE (teardown race under load)**, not a regression |
| 2 | `test/unit/utils/redaction-prefilter.test.ts:105` (`PERF GATE: large clean JSON skips the 14 passes quickly`) | `redact clean 64KB×200 took 506.6 ms (gate < 500)` | **exit 0, 12/12 pass** twice | **FLAKE (perf gate under load)**, not a regression |

Context supporting flake classification: system load peaked at **13.58** (>12) during the full unit run, and both files pass deterministically in isolation immediately afterwards on the same tree with the same HEAD.

**Note on failure #1** — it is a *teardown* `ENOTEMPTY` race: the test's `t.after` hook `rimraf`s `.crew/state/runs` while a background runner is still writing into it. Thematically adjacent to wave-12's fixture-teardown mandate even though it is not a regression from this wave (isolated runs clean). Worth a follow-up ticket: make that fixture's teardown group-reap/await-child-exit like the wave-12 helpers do.

## Pin 5 — integration

`npm run test:integration` → **exit 0**, `# tests 148 / # pass 144 / # fail 0 / # skipped 4 / # cancelled 0`. Exactly matches baseline (144/0/4).

## Pin 6 — static gates

| Gate | exit | Result |
|---|---|---|
| `npm run lint` | 0 | clean |
| `npm run typecheck` | 0 | `tsc --noEmit` + strip-types import ok |
| `npm run format:check` | 0 | clean |
| `npm run check:slop-rules` | 0 | `no-double-cast baseline 41, current 41 (burn-down ok)`; 1761 files scanned → **matches 41 baseline** |
| `npm run check:lazy-imports` | 0 | clean |
| `npm run check:wc-gate` | 0 | clean |

## Pin 7 — dist staleness

`node scripts/check-bundle-staleness.mjs --committed-hash` → **exit 0, MATCH**

```
dist/index.mjs  MATCH  sha256(committed)=e9ec38d50e2df8a1… sha256(fresh)=e9ec38d50e2df8a1… (1889227 B vs 1889227 B)
[check-bundle-staleness] OK: committed dist matches a fresh build from current src.
```

`stat -c%s dist/index.mjs` = **1889227**. No rebuild performed (none needed).

## Pin 8 — leak sweep

- `pgrep -af "setInterval|proc-tree-leader|rg-wedge|harness.ts"` → **EMPTY** (pass).
- Node procs with cwd under `/home/bom/source/my_pi/pi-crew`: **0** at end of battery (only the probing shell's own transient subprocess).
- **Pre-existing residue (NOT from this battery):** 12 orphaned `pi-crew-steer-live-*` background-runner processes survive from earlier sessions today (PIDs 132798 … 4136159, run-ids `team_20261024120545…`, `…155548…`, `…161012…`, `…161607…`, `…175024…`, `…1J8Pq6`, etc., all with deleted cwd). Pre-run count = 13, post-run count = 13 → **this battery leaked 0**. Flagged as pre-existing residue for a separate cleanup ticket; not a gate blocker.

## Fail list summary

| Fail | Baseline? | Adjudication |
|---|---|---|
| `team-tool-steer-clamp.test.ts` — `ENOTEMPTY` teardown hook | No (new observation) | FLAKE — 2/2 isolated pass |
| `redaction-prefilter.test.ts:105` — perf gate 506.6 ms vs <500 | No (class-equivalent to known `redaction-redos-regression.test.ts:104` timing flake) | FLAKE — 2/2 isolated pass |

Known baseline flakes `redaction-redos-regression.test.ts:104`, `resource-sampler-audit.test.ts:190`, `event-log-inline-compaction-guard.test.ts:349`, `implementation-fanout.test.ts:49` did **not** fail this run.

## Conclusion: **PASS**

All wave-12 fixture-teardown suites are green and deterministic (30/30 runs across 3 repetitions). Message-tool hermeticity holds under all 3 env variants. test:critical 124/124, integration 144/0/4, all 6 static gates 0 with slop baseline exactly 41, dist committed-hash MATCH. The only 2 full-unit failures are load-induced flakes (load peak 13.58), each independently cleared 2/2 in isolation on the same tree — no regression. No new fixture leaks. Green light for the v0.11.40 bump.

Residual (non-blocking) follow-ups: (1) 12 pre-existing orphaned `steer-live` background runners; (2) `team-tool-steer-clamp` teardown is not group-reap hardened like the wave-12 helpers.
