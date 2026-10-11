# Run-Index Runs-Dir Enumeration Microbench — Δ1 (2026-10-11)

> Bench-first decision record for the "collectRuns() is O(n) readdir+sort per
> refresh" observation. **No optimization landed** — this document decides
> whether one is justified, and where.
>
> Bench: `bench/b14-run-index-scan.bench.ts` (standalone:
> `node --experimental-strip-types bench/b14-run-index-scan.bench.ts`; also
> part of `npm run bench`).
> Capture: `bench/results/2026-10-11T13-44-22-679Z.json` (node v22.23.1,
> linux; two standalone runs agreed within ±5%).

## Question

`collectRuns()` (`src/extension/run-index.ts`) does `readdirSync` + filter +
sort over ALL run dirs per refresh even though manifest parsing is cached
(`sharedScanCache` "manifests" bucket: TTL 1000 ms, maxEntries 100, FIFO) and
active runs come from the registry. At what N run dirs does this become
measurable, and is `maxEntries=100` adequate?

## Method

- **Isolation**: synthetic crew home via `mkdtemp` with `PI_CREW_HOME` +
  `PI_TEAMS_HOME` set inside the bench process (never touches `~/.pi`; the
  real runs root is snapshotted before/after and asserted unchanged — passed:
  only `active-run-index.{bin,json}` present, byte-identical listing).
- **Workload**: N = 100 / 1,000 / 10,000 run dirs, one realistic manifest each
  (avg ~1.58 KB, full `TeamRunManifest` field shape; mixture = terminal
  `completed`/`failed` + 3 newest `running`). Note: real-world manifests grow
  to ~23 KB on rich runs — manifest bytes only affect the read+parse fraction
  (≈12 % of a scan, see F3), so these numbers are a conservative lower bound.
- **Phases** (median of 5 samples each):
  - `enumerate` — readdir+filter+sort only (faithful copy of the run-index block);
  - `fullCold` / `fullWarm` / `fullPostTtl` — `listRunsByScope(ws,"user")` =
    unbounded `collectRuns(userRoot)`, bucket invalidated / re-run within TTL /
    re-run after TTL expiry;
  - `recent40Cold/Warm` — `listRecentRuns(ws, 40)`: the async-notifier path
    (poll 5 s, list debounced 30 s, bounded to 40).
- **Scan-cache observability**: fs-op counting is not cheaply observable (the
  `node:fs` ESM namespace is frozen — patching `fs.readFileSync` throws), so
  bucket behavior is measured two ways: `sharedScanCache.list("manifests")`
  + a liveness probe on the last-scanned key after each real scan, and a
  deterministic replay of the same key order into a local
  `SharedScanCache({ttlMs:60s, maxEntries:100})` (exact eviction / warm-miss
  arithmetic).

## Results (median ms of 5; min..max within ±10 % unless noted)

| N dirs | enumerate | full cold | full warm | full post-TTL | recent40 cold | recent40 warm |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 0.19 | 36.8 | 28.4 | 31.5 | 13.0 | 12.0 |
| 1,000 | 1.36 | 293.4 | 299.0 | 295.1 | 12.8 | 12.8 |
| 10,000 | 13.1 | 2993.4 | 3010.1 | 2987.8 | 27.5 | 21.8 |

Per-entry cost of a full scan: (fullCold − enumerate)/N ≈ **0.30 ms/dir at
every N** — perfectly linear, independent of cache state.

| Cache replay (maxEntries=100) | N=100 | N=1,000 | N=10,000 |
|---|---:|---:|---:|
| evictions per full scan | 0 | 1,000 | 9,900 |
| warm hits (2nd scan, same order) | 100 | 100 | 100 |
| warm misses → re-read + re-parse | 0 | 900 | 9,900 |
| bucket size after real cold scan | 100 | 100 | 100 |

## Findings

- **F1 — the O(n) readdir+sort is NOT the cost.** ~1.4 µs/dir, linear: 0.19 /
  1.36 / 13.1 ms at 100/1k/10k. Even at 10k dirs it is 0.4 % of the full scan.
- **F2 — per-selected-entry work dominates: ~0.30 ms/dir.** The driver is
  `resolveRealContainedPath` per entry (realpath×2 + open+fstat per run dir —
  runs on EVERY scan, cached or not) plus manifest exists/stat/read/parse.
- **F3 — the manifests bucket barely helps even when it works.** At N=100 the
  warm scan saves only the read+parse fraction: 36.8 → 28.4 ms (~12 %) because
  F2's path-resolution work is uncached. At N=1,000/10,000 warm ≈ cold (±2 %):
  0 % hit rate beyond the first 100 keys in scan order.
- **F4 — bucket TTL is bucket-level and NON-sliding, with a nasty rollover.**
  `expireAtMs` is stamped at bucket creation; when it lapses, the next `set()`
  resets the bucket to EMPTY. A 3.0 s scan at N=10k rolls the bucket over ~2×
  mid-scan, discarding entries the same scan just inserted (observed: bucket
  alive + size 100 after the scan, but holding only the tail of scan order).
- **F5 — the async-notifier path is fine at any measured scale.**
  `listRecentRuns(40)` = enumerate(N) + ~40 entries: 13 ms at ≤1k dirs,
  27 ms at 10k. With the 30 s debounce that amortizes to <1 ms/s of main-loop
  time.

## Answers

**(a) Cost per scan** — see table. Enumeration: 0.2 / 1.4 / 13 ms. Full
unbounded scan: 37 / 293 / 2,993 ms. Bounded recent-40: 13 / 13 / 27 ms.

**(b) Does the 30 s debounce make it moot?** For the notifier, yes — it is the
bounded path (F5). The debounce does NOT protect the unbounded consumers
(`listRuns`, unbounded `listRunsByScope` used by prune/health/list-all style
callers): those pay the full 0.3 ms × N synchronously per invocation, on the
extension's main thread.

**(c) Threshold where optimization IS justified.** At ≤100 retained run dirs
per scoped root: nothing to do (37 ms worst case). At ~1,000: ~300 ms sync
stall per unbounded scan — noticeable on user-facing list actions, borderline.
At ≥3,000 (≥1 s) it is clearly justified; at 10,000 a single scan is ~3 s AND
the cache TTL rolls over mid-scan (F4). **Verdict: do NOT optimize the
readdir+sort (F1); optimization becomes justified for unbounded-scan consumers
once a scoped root retains ≳1–2k run dirs.** The highest-leverage change (per
F2) is bounding/paginating unbounded callers or caching the runs-dir listing
on directory mtime — not touching the sort.

**(d) maxEntries=100 verdict.** Adequate for bounded consumers (recent-40 uses
≤40 keys; registry "active-manifests" is per-active-run). Inadequate for
unbounded scans at N>100: every scan re-reads and re-parses N−100 manifests
and churns N−100 FIFO evictions, so the bucket converts to pure overhead
(stat of every file + bookkeeping with 0 reuse). Raising maxEntries alone is
NOT recommended (it would pin N parsed manifests in memory and still not fix
F4); if unbounded scans survive, prefer per-entry/sliding TTL + sizing to the
bounded consumer, or eliminate the unbounded scan (c).

## Follow-ups (NOT implemented — bench-first rule)

1. If any user-facing action still calls unbounded `listRuns`-style scans,
   bound or paginate it (same pattern as recent-40) before touching run-index.
2. If unbounded scans remain for prune/health, consider a dir-listing cache
   keyed on runs-root mtime (kills F2's per-entry realpath storm AND F1).
3. `scan-cache.ts` TTL semantics (F4) deserve their own decision record if
   any bucket is used for scans that can exceed 1 s.

## Reproduce

```bash
cd pi-crew
node --experimental-strip-types --no-warnings bench/b14-run-index-scan.bench.ts   # standalone, ~75 s
npm run bench                                                                      # full suite incl. b14
```
