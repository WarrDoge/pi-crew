# pi-crew Audit — Round 4 (5-shard parallel + coverage data)

> Date: 2026-10-15 · Base: v0.11.21 @ `75fe7c57` (post-DR-01) · Method: iterative-audit skill,
> 5 parallel read-only explorer shards (A security sinks / B success-integrity / C growth+leaks /
> D state durability / E error swallowing) + `npm run test:coverage`.
> **Every HIGH/MEDIUM finding below was re-verified by the lead at source** (quotes from actual reads,
> not shard reports). Per-shard rg commands + hit counts recorded in shard outputs (session artifacts).

## Round-4 verdict

**3 HIGH · 5 MEDIUM · ~10 LOW.** Four of five lanes came back substantially clean
(sinks, leaks, merge-gate/verifier/effectiveness, atomic-write coverage) — the risk concentrated
exactly where round 1–3 predicted: **completion paths not yet covered by DR-01** and
**cross-process state races**.

## HIGH (all lead-verified)

### R4-1 (B1): Coalesced-group dispatch is a 4th path that bypasses ALL DR-01 empty-settle gates
- `src/runtime/scheduling/run-coalesced-task-group.ts:246,253,326`; `src/runtime/run-worker.ts:135-143`
- `rawOutput = result.rawFinalText ?? result.stdout` — **never parsed as pi-json**;
  `success = !cancelled && exitCode === 0 && !result.error` (legacy pre-DR-01 criterion);
  `ok = success && Boolean(entry?.text)` — the stale pre-outage opening sentence ("finalText lies")
  satisfies the only work-check. rg `settledWithoutAnswer|parsePiJsonOutput` in both files = **0 hits** (lead-verified).
- Trigger: `workflow.coalesceMicroTasks: true` (opt-in) + ≥2 read_only tasks + upstream 429 mid-group
  → **every task in the group stamped `completed` with the same broadcast sentence**; no retry, no model-fallback.
  This is the exact DR-01 incident shape on the path round 3 missed.
- Mitigations: opt-in flag, read-only roles only. Not enabled by default.

### R4-2 (D1): events.jsonl compaction rename orphans in-flight appends from the other lock family — silent event loss
- `src/state/event-log/event-log.ts:114` (`.mkdirlock` sync family) vs `:327` (`.alock` async family) —
  **disjoint cross-process mutexes by design**; async append has an await gap
  (`await fs.promises.open(path,"a")` … `await fd.appendFile(line)`, :606-610);
  compaction `atomicWriteFile(eventsPath, lines)` (:299 in event-log-rotation.ts) = temp+**rename** →
  replaces the directory entry; an fd opened pre-rename writes into the unlinked inode → event gone.
  C2 recovery re-splices **only events in the kept window** — an unseen event is unrecoverable (no archive
  for compaction, unlike rotation). Reader sees a seq gap; event-reconstructor tolerates gaps → silent.
- Frequency gate: compaction only when log >4MB / >50K events — long runs with 16KB task payloads reach it.
- Fix direction: compaction must take a lock BOTH families honor (careful: merging the families naively
  re-creates the documented sleepSync deadlock at event-log.ts:286-292), or make compaction archive-style
  recoverable. Needs design — SDD spec.

### R4-3 (D2): workspace-lock heartbeat is written ONCE at acquire and never refreshed (`writeLock` is dead code)
- `src/runtime/workspace-lock.ts:147` (writeLock — zero callers, lead-verified) + `:312` (`heartbeat: now()`
  only inside acquire) + `isLockStale` clause (b): `heartbeatAge > 60_000` → stale **regardless of PID
  liveness** (PID check only catches PID-recycle; lead-verified :235-259).
- `goal-loop-runner.ts` acquires at :579, releases in `finally` :913 — **no refresh anywhere between**
  (grep heartbeat/refreshLock/writeLock in the loop = 0 hits, lead-verified). Turns take minutes.
- Consequence: goal A running >60s on cwd W; goal B (or `isWorkspaceBusy` pre-check at team-tool/goal.ts:109)
  sees stale heartbeat → B force-overwrites A's lock → **two goals mutate W concurrently** — the exact
  multi-goal clobber the lock exists to prevent.
- Fix: periodic heartbeat refresh (call the dead `writeLock`) in the goal loop, or derive staleness from
  holder liveness. Small diff.

## MEDIUM

- **R4-4 (B2)**: `needs_attention` tasks don't block run completion — scheduler counts them "done"
  (task-graph-scheduler.ts:75, lead-verified), finalize-run.ts + policy-engine.ts have **zero** handling
  (grep = 0 hits, lead-verified) → run finishes green "Team workflow completed." while a task's result was
  never submitted (live-mode noYield path, post-execution.ts:203-219).
- **R4-5 (B3)**: green contract is ALWAYS self-attested — `defaultVerificationContract` (task-packet.ts:97-103,
  lead-verified) sets `commands: []` + `allowManualEvidence: true` unconditionally → `verify: true` steps
  get `green=targeted/targeted` from the worker's own exit code; `green_unsatisfied` policy can never fire.
  Machine verification exists only via verifier-role pre-gate / spec-gate — not executor `verify:true`.
- **R4-6 (D3)**: kill-stale UI dispatch does unlocked read-modify-write on tasks.json
  (run-action-dispatcher.ts:125 "no withRunLock - best-effort only", :141) — can regress a just-completed
  task to running with stale heartbeats.
- **R4-7 (D4)**: async-died/timeout notifier same class (async-notifier.ts:73-92) — unlocked RMW can flip a
  just-completed task to `failed` ("async worker died") despite green artifacts; contradicts events.jsonl.
- **R4-8 (B4, med-confidence)**: verification-command execution catch keeps `satisfied:true` base evidence
  instead of fail-closed (post-execution.ts:431-478). Dead branch today (default contracts have no commands)
  but becomes live when contracts gain commands.

## LOW (summary; details in shard outputs)

A1 worker spawn inherits full host env (design tradeoff, escalation closed) · B5 goal achieved=true on any
dirty tree · C1 seenControlRequestIds uncapped Set (run-scoped) · C2 taskUsageMap crash-path residue ·
C3 delivery pending TTL-only · D5 goal-turn final saveRunTasks unlocked · D6 agent-events .seq sidecar raw
write (tolerant fallback) · D7 steering truncate race (documented) · E1 swallowed repairGroupTerminalWrite
(no log — status stays stale) · E2 dispose() swallows final scratchpad snapshot failure · E3 runner
heartbeat write swallow → heartbeat_dead false alarms · E4 manifest duck-type casts ×3 (Pick<> fix) ·
E5 session-recovery mkdir swallow · E6 fault-count merge swallow · E7 floating async dispose (guarded) ·
E8 verified-SAFE dead armor (listed to prevent re-report).

## Verified CLEAN (with the protecting mechanism)

- **Security sinks** (Shard A): every user-reachable exec/path/env flow gated — assertSafePathId,
  resolveRealContainedPath, validateGateCommand allowlist; sole `sh -c` site is the guarded verification
  gate; zero eval/Function/vm; no `shell:true` anywhere; ~45 path-join sites all gated.
- **Growth/leaks** (Shard C): all 4 historical caps present + test-pinned; v0.6+ modules systematically
  capped (LRU/FIFO/maxTurns/agent-call caps); all 21 setInterval files clear their timers; watchers close
  on dispose; broker maps clean up on terminal.
- **Success deciders** (Shard B): merge-gate transition table exhaustive + pinned; verifier verdict parsing
  fail-closed (empty → INCONCLUSIVE/escalate, never PASS); effectiveness escalation-to-blocked for mutating
  roles exists; crash-recovery cancels orphans (never completes).
- **Durability** (Shard D): 184 atomicWrite* call sites; tasks.json corrupt → quarantine + reconstruct from
  events; API RMW locked (heartbeat.ts/task-claims.ts canonical pattern); mailbox single .flock namespace;
  readers partial-line tolerant + archive-tail drain; checkpoints atomic + quarantine.
- **Error hygiene** (Shard E): 135/147 swallow sites benign with documented fallbacks; 0 real `as any`;
  0 dead conditionals; 0 failure-path TODOs.

## Coverage data (pattern 3)

`npm run test:coverage` full-suite run captured to `/tmp/dr01-coverage.log` (9186-test suite);
per-file table to be distilled into the follow-up spec if accepted. (First coverage run on record:
99.52% lines on docs-sync module — the F5-era "which module lacks tests" question is now answerable
with data instead of filename heuristics.)

## Proposed DR-02 fix plan (awaiting user decision)

| Priority | Item | Fix shape | Effort |
|---|---|---|---|
| P0 | R4-1 coalesced empty-settle | parse pi-json in coalesced path (mirror child-executor gate) or move gate into runWorker return so all callers inherit | S |
| P0 | R4-2 workspace-lock heartbeat | periodic refresh in goal loop OR liveness-based staleness | S |
| P1 | R4-3 events.jsonl compaction race | design spec (dual-family lock or archive-style compaction) | M |
| P1 | R4-4 needs_attention at finalize | policy decision (notify/block) before "completed" | S |
| P1 | R4-5 verify:true decorative | default allowManualEvidence:false for executor verify steps OR surface verify-decorative in progress | S+decision |
| P1 | R4-6/R4-7 unlocked RMW ×2 | wrap in withRunLockSync + fresh reload (mechanical) | S |
| P2 | B4 fail-closed catch; E1/E2 add logInternalError; E4 Pick<> types; A1 env allowlist (optional) | small diffs | S |
| P3 | C1-C3, D5, D6 micro-hardening | caps/sweeps | S |

Round metrics: 5 shards, ~85 files read at source, ~25 verified findings (18 real kept after lead
verification, ~7 downgraded/benign-classified by shards themselves), 0 false positives surviving lead
verification so far. Continue-audit decision: round 4 found 3 HIGH → per skill protocol, continue rounds
are justified; recommended next foci: (a) fix-first (DR-02), (b) then round 5 on the two un-audited lanes
(UI/surface rendering correctness under concurrent updates; prompt-construction/context-budget trimming).
