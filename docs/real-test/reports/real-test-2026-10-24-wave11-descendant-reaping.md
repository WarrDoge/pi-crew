# REAL TEST — wave 11b run-descendant sweep (live repro, 2026-10-24)

**Scope**: prove with REAL processes and REAL `/proc` that the run-scoped
descendant sweep reaps the leaked grandchildren of a TERMINAL run and does NOT
signal anything else.

- Repo: `/home/bom/source/my_pi/pi-crew`, HEAD `ed32c582`
  (`fix(runtime): require descent proof before the run-descendant sweep (wave 11b.4)`)
- Test: `test/integration/run-descendant-sweep-live.test.ts` (Linux-only; the
  sweep is `/proc`-based and fail-opens to `[]` elsewhere)
- Sweep path exercised: the REAL startup lane `reconcileAllStaleRuns` →
  `sweepTerminalRunDescendants` → `reapRunDescendants` → `reapGroup`
  (no seam, no injected `/proc` table, no mocked signals)
- `src/` was NOT modified.

## Incident shape reproduced

Incident: run `team_20261022110510_cefb9164af126460` reached `completed`
(2026-10-22T13:02Z) and still had six grandchildren (399 MB) alive 24 h later.
They lived in the process group of a **bash command** (pi's bash tool spawns
`detached: true`), not in the worker's group, and carried the inherited env
markers `PI_CREW_KIND=subagent`, `PI_CREW_TASK_ID=01_01-agent`,
`PI_CREW_PARENT_PID=<dead runner>`, `PI_CREW_BROKER_RUN_ID=<runId>`.

Rebuilt with real processes in a scratch project under the OS tmpdir:

1. The run state is a **rewrite of the real incident manifest/tasks** when
   `/home/bom/source/my-durable/.crew/state/runs/team_20261022110510_cefb9164af126460`
   is present on the host (this run used it); otherwise the same shape is built
   through `createRunManifest` (verified green as well, see "Fallback"). Rewrites:
   new `runId`, `status:"completed"`, `updatedAt = now − 10 min`,
   `async.pid = <verified-dead pid>`, `tasks[0].checkpoint.childPid = <other
   verified-dead pid>`, `taskIds = ["01_01-agent"]`, and
   `descendantSweepAt`/`descendantSweepPending` **removed**.
2. Leak: a `detached:true` bash leader spawns
   `node -e "setInterval(()=>{},1000)"` with all four markers
   (`PI_CREW_PARENT_PID` = the recorded dead runner). The leader is then
   **SIGKILLed**, so the grandchild is reparented to init while keeping the
   leaderless group ⇒ exactly the incident topology.
3. Negative controls:
   - **N1** same markers **minus `PI_CREW_PARENT_PID`** (no descent proof)
   - **N2** full markers attached to a **real PTY** (`script -qfc '… exec node …'`),
     so the marker carrier has `tty_nr != 0` (measured `34849` ⇒ `pts/1`)
   - **N3** a plain `node` with no pi-crew markers at all

## Assertions (this run)

| # | Assertion | Result | Evidence |
|---|---|---|---|
| A1 | Leaked grandchild is dead ≤ 6 s after the sweep | **PASS** | pid `3873599` gone in **91 ms** (reap: SIGTERM → group gone; second run 99 ms, third 100 ms) |
| A2 | N1, N2, N3 all still alive | **PASS** | N1 `3873606` alive, N2 pty child `3873608` alive (wrapper `3873607` alive), N3 `3873609` alive |
| A3 | Manifest: `status` still `completed`, `descendantSweepAt` ISO, `descendantSweepPending === true` | **PASS** | on-disk manifest `status=completed`, `descendantSweepAt=2026-10-24T05:15:37.787Z`, `descendantSweepPending=true` (the N2 tty skip is a retryable skip) |
| A4 | Second immediate pass signals nothing (10-min retry interval) | **PASS** | `descendantSweepAt` byte-identical after pass 2, `descendantSweepPending` still `true`, N1/N2/N3 all alive, `reconcileAllStaleRuns` returned `[]` |
| A4b | After faking the stamp 11 min old, the lane retries and the tty guard still refuses | **PASS** | stamp refreshed, pty child still alive, `descendantSweepPending` still `true`, `status` still `completed` |
| A5 | No survivor after cleanup; scratch dir removed | **PASS** | `pgrep -f '[w]11livesweepmarker'` → **0**, `ls -d /tmp/pi-crew-w11live-*` → **0** (checked after every run) |

Sweep log line (real `logInternalError` output from the real code path):

```
[pi-crew:stale-reconciler.run-descendant-sweep] swept 1 descendant process(es) of terminal run: 3873599(run-id): team_W11LIVE_…
[wave11b-live] run=team_W11LIVE_1792818937575 leak=3873599 reapedIn=91ms n1=3873606
  n2wrapper=3873607 n2pty=3873608 n2tty=34849 n3=3873609 stamp=2026-10-24T05:15:37.787Z
```

**Exactly ONE process was reaped** — the marker-carrying, parent-proven leak.
Nothing else on the host was signalled (the only `run-id` matches were the
leak; N1 lacks the proof parent, N2 is skipped by the tty rung, N3 carries no
marker).

## How to re-run

```bash
cd /home/bom/source/my_pi/pi-crew
node scripts/test-runner.mjs --test-force-exit test/integration/run-descendant-sweep-live.test.ts
```

Prints the PID table above on success; exits non-zero (`not ok`) with the failed
`A<n>` label, the pid set and `/proc` evidence on any failure. Cleanup runs in
`after()` (and in the test's `finally`) even when an assertion fails, so a
failing run leaves no process and no tmp dir behind.

## Stability (3 consecutive runs, after `biome format`)

| Run | Exit | Reaped | pass/fail/cancelled | Leftover procs | Tmp dirs |
|---|---|---|---|---|---|
| 1 | 0 | 1 (`reapedIn=121ms`) | 1/0/0 | 0 | 0 |
| 2 | 0 | 1 (`reapedIn=109ms`) | 1/0/0 | 0 | 0 |
| 3 | 0 | 1 (`reapedIn=111ms`) | 1/0/0 | 0 | 0 |

Three earlier runs (pre-format) were also green (`reapedIn` 91/99/100 ms).
No flake observed in 6 runs; the timeouts have ~50× headroom (sweep budget 6 s,
test budget 180 s) and no sleep-based synchronisation is used (all waits are
poll-until-condition with a deadline).

**Fallback coverage**: re-ran once with `INCIDENT_RUN_DIR` pointed at a
non-existent path (the CI situation, no `/home/bom/source/my-durable`) →
green, `reapedIn=95ms`, same shape via `createRunManifest`.

## Gates (env scrubbed of `PI_CREW_*` / `PI_TEAMS_*`)

| Gate | Command | Exit |
|---|---|---|
| typecheck | `npm run typecheck` | 0 |
| lint | `npm run lint` | 0 |
| format | `npm run format:check` | 0 |
| slop rules | `npm run check:slop-rules` | 0 |
| lazy imports | `npm run check:lazy-imports` | 0 |
| env vars | `npm run check:env-vars` | 0 |
| wc gate | `npm run check:wc-gate` | 0 |

## Known limits of this repro

- The PTY control proves the **skip** (process survives, run stays
  `descendantSweepPending`); it is not a claim that a tty'd leak is ever
  reaped — that is the documented, intentional miss (safety rung 12).
- A descendant that `setsid()`s or lives in a container namespace is out of
  scope for the sweep and is not modelled here.
