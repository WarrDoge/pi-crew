# Δ3 — Broker/scheduler scan-cost audit + held-lifetime audit (2026-10-11)

> Verdict: **evidenced no-op** — no candidate index implemented, no memory fix applied.
> Both decision axes closed on LOCAL measurements (bench-first rule, upstream numbers
> never adopted unmeasured). Run: `team_20261011153155_9859923ee94d4bc9` (9/9 tasks,
> reviewer APPROVE 0 MAJOR). Evidence lives in `bench/b15-broker-scan-cost.bench.ts`
> (reproducible: `npm run bench` picks it up) + archived captures under that run's
> `.crew/artifacts/…/results/`.

## 1. Scan-site index decision — all 6 sites NOT-JUSTIFIED

The delta-report's grep-derived "~9 broker / ~10 scheduler filters" was refined to the
actual decision surface (site-by-site verified by explorer + critic against source):

| # | Site | Verdict | Deciding numbers (b15, median-of-5) |
|---|---|---|---|
| 1 | `taskGraphSnapshot` 6-filter partition — `task-graph-scheduler.ts:206-214` | NOT-JUSTIFIED | snapshotWarm 0.018 ms/call @ n10 (11-12 passes); 0.86 ms @ n1000 — below the 8.1 ms parse floor and 28.8 ms planner in the same tick |
| 2 | `getReadyTasks` — `task-graph-scheduler.ts` | NOT-JUSTIFIED | 0.006 ms @ n10, 2 passes |
| 3 | `dagReadyTaskIds` — `dispatch-batch.ts:352` | NOT-JUSTIFIED | the 28.8 ms @ n1000 is `buildDagExecutionPlan` (planner), not the 5 scans; gated behind `dependsOn.length > 0` |
| 4 | broker waitStatus poll `.find` — `crew-broker.ts:1224` | NOT-JUSTIFIED | ≤55 comparisons/sec at 5 Hz, N≤11; parse already stat-gated (R10-3) |
| 5 | broker delegate admission/rollup/refund/wait-park — `crew-broker.ts` ~1492-1847 | NOT-JUSTIFIED | 6 passes/request (find×2, filter×1, map×3); cost is lock+load+save fsync I/O (delegateTotal 49-168 ms, loadCold 8.1 ms @ n1000) |
| 6 | health-monitor zombieWalk — `health-monitor.ts:129/143` | NOT-JUSTIFIED | cost is readdirSync+manifest parse (25.5 ms @ 1000 dirs), not task scans |

**Realistic-N ground truth**: N≤11 tasks/run across 33 run dirs. Even at 90× N, scans
(0.86 ms) sit below the parse floor. An id→task map already exists where it matters
(`buildTaskGraphIndex`, `task-graph-scheduler.ts:42/:52`). Upstream `cb4375493`
candidate indexes were designed for 500-chain workloads — not ours; pattern parked
until a real run exceeds ~50 tasks.

## 2. Held-lifetime audit — no UNBOUNDED-RISK structure

| Structure | Verdict | Worst-case growth driver |
|---|---|---|
| orphan-worker-registry (file-backed) | BOUNDED-BY-LIVE-WORK | live detached background-worker PIDs |
| orphan-worker-registry (heap) | no held state (read/rewrite per op) | — |
| `detachedRuns` Map (`detached-run-results.ts:33`) | INERT — dead producer (`markRunDetached` has zero src callers; if ever rewired, add a TTL first) | — |
| session-snapshot.ts | no held state (pure functions) | — |
| `connections` Set (`crew-broker.ts:126`) | BOUNDED-BY-LIVE-WORK | live sockets |
| `connectionsByRun` Map (`:128`) | BOUNDED-BY-LIVE-WORK (+stop-residue footnote) | runs with ≥1 live connection |
| `subscriptionUnsubs` WeakMap (`:130`) | BOUNDED-BY-LIVE-WORK (GC-safe) | live connections |
| `conn.outbound` per-conn array | ALREADY CAPPED (256, drop-newest) | — |
| `tokens.map` + `revokedTokenHashes` (`tokens.ts:39/:46`) | LIFETIME-OF-BROKER-INSTANCE (per session; cleared only on `stop()`; sized ~sub-MB — accepted, monitor if token minting ever grows per-run) | tokens minted per spawned child/grandchild across ALL runs in one session |
| capped structures (outbound 256, waitStatusCache 128, resolvedRunResults 32, scan-cache 100) | deliberately untouched | — |

## 3. Follow-ups routed (not Δ3)

- Idle-host `npm run bench` to fold b15 into `bench/results/` baseline.
- Planner/serialization perf lane IF real runs exceed ~50 tasks.
- Correctness lane: nestedSlots error-path slot release (`crew-broker.ts:1549` ×
  `lock-busy.ts:62`); `wait-status-cache.ts:26-27` docstring fix.
