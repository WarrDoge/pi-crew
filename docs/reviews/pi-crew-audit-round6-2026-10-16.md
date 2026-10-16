# pi-crew Audit — Round 6 (Lanes H+I+J+K: protocol / time / model-chain / DWF+compaction)

> Date: 2026-10-16 · Base: v0.11.21 @ DR-02 wave-2 (be362a05..c751e979) · Method: iterative-audit,
> 4 parallel read-only lanes + lead source-verification of every HIGH.
> Lanes: H broker/RPC/delegate protocol · I scheduling/plans/time/checkpoints · J model-fallback/config ·
> K DWF runner + compaction engines.

## Round-6 verdict

**3 HIGH · 7 MEDIUM · 15 LOW** — sixth round, still finding HIGHs (protocol resurrection, scheduler
persistence, DWF cache collision). Two lanes came back largely CLEAN at the core (J: chain advancement
+ empty-settle↔retryable interaction verified PROGRAMMATICALLY — all 4 DR-01/DR-02 gate messages match
every retryable pattern and zero non-retryable ones; I: plan-store/checkpoint/stale-reconciler/orphan
registry all lock+version guarded).

## HIGH (lead-verified at source)

### R6-1 (H1): Late worker settle resurrects a leader-terminalised task
- `src/runtime/task-runner/state-helpers.ts:103` (`persistSingleTaskUpdate`) + `post-execution.ts:548-563`
- Inside the run lock the disk tasks are re-loaded (BUG-028), but `updateTask(latest, task)` is an
  **unconditional replace-by-id** — no status/epoch comparison. A detached runner's worker settling
  AFTER crash-recovery flipped the task to `cancelled` overwrites it with `completed` and emits
  `task.completed` after `crew.run.orphan_cancelled` → cancelled run containing a completed task;
  event-log vs tasks.json divergence. The coalesced path HAS the cancelled branch
  (`run-coalesced-task-group.ts:367`); the singleton terminal write does not. (Lead-verified: the
  BUG-028 comment itself states "updated still wins for THIS task via updateTask".)
- Fix shape: at the terminal write, refuse to overwrite a disk-terminal status written by another
  writer (mirror the coalesced cancelled branch / R13-S1 terminal-preserve class).

### R6-2 (I1): Scheduled jobs die permanently after any restart
- `src/extension/registration/lifecycle-handlers.ts:594-620` + `src/runtime/scheduling/scheduler.ts:296-301`
- The executor persists the job snapshot **while `lastStatus:"running"`** and THEN flips memory to
  `"success"` — which nothing ever persists (the `updated`-event persist flow the armCron docstring
  claims does not exist in the wiring; lead-verified ordering). On restart the job loads with
  `lastStatus:"running"` → `fire()`'s in-flight guard skips EVERY occurrence forever, silently.
  `runNow`'s force path re-snapshots "running" — even manual runs cannot heal disk state.
- Fix shape: persist inside the emit callback on `updated` events AND/OR swap persist-after-update +
  normalize `lastStatus:"running"`→undefined on load; add a persist/reload round-trip test.

### R6-3 (K1): DWF PERS-1 cache key omits inputs/systemPrompt/disableTools/maxTurns/worktree
- `src/runtime/goal-workflow/dynamic-workflow-context.ts:398-412` (lead-verified)
- `callId = JSON.stringify({role, agent, prompt, model, schema})` — but `inputs` is appended to the
  dispatched task text and `systemPrompt` replaces the persona. `for (const f of files) await
  ctx.agent({prompt:"Fix the bug", inputs:[f]})` — iteration 2+ returns iteration 1's cached result,
  spawns nothing, wrong file's fix attributed everywhere. The cache is consulted on EVERY call (not
  just resume). Cached record also drops `structured` and `artifactPath` → schema'd scripts crash on
  replay; artifact chains break.
- Fix shape: include all call-shaping fields in callId; cache the full result shape.

## MEDIUM

- **R6-4 (H2)**: delegate budget reserve/roll-up (`crew-broker.ts:1581/1704`) is a lost update vs the
  runner's 1s heartbeat whole-record replace (`live-executor.ts:138`) — token accounting under-counts,
  budget over-consumption possible.
- **R6-5 (H3)**: outbound drop-newest can drop REQUEST RESPONSES (`wait.request`/`msg.send` acks have
  no durable fallback); `needsResync` is a write-only dead flag (5 hits, 0 reads) — the claimed pause
  doesn't exist.
- **R6-6 (H4)**: `msg.send` ack can exceed the client's 15s default timeout on slow-fsync 64-recipient
  broadcasts → tool reports "NOT sent" after durable delivery; retry duplicates (message-tool passes no
  requestId → U5 dedup can't engage).
- **R6-7 (J1)**: DWF empty-settle gate lacks the patches/cancelled exemptions its 3 siblings have —
  a patch-only coder step (legitimate per DR-01 contract) is misreported as "upstream rate-limit/429
  exhaustion". Direct DR-01/DR-02 contract asymmetry.
- **R6-8 (J2)**: provider env-key scoping passes ONE model; a bare/undefined id yields ZERO provider
  keys → child auth fails → matches `/api key/i` NON-retryable → chain breaks though qualified
  fallbacks were queued (doc contract says "and its fallback chain").
- **R6-9 (J3)**: embedded-tier FAULTED attempts contribute zero usage (`live-session-runtime.ts:1781`
  success-only) vs subprocess tier which persists usage on error too → budget gates under-count
  systematically when embeddedWorkers is on.
- **R6-10 (K2)**: `ctx.retry()` never retries `ok:false` failures (executor retries thrown errors
  only; only the cap error is rethrown) — including the DR-02 empty-settle class; `maxAttempts:3`
  decorative.
- **R6-11 (K3)**: output-splitter forged delimiter entries — first-occurrence-wins, no ownership
  validation (`output-splitter.ts:66-86`): a worker quoting another task's delimited block (or a read
  file containing markers) forges attribution with `strategy:"delimiter"` trust; no deadletter on full
  forged coverage. Strategy-2 substring id matching compounds it.
- **R6-12 (K4)**: resume replays non-agent side effects (ctx.mail/ctx.log/fs writes — no PERS-1);
  checkpoint ordering runs worktree cleanup BEFORE the checkpoint persist (crash in cleanup → duplicate
  re-spawn); `phase()` re-emits scrambled phase events into events.jsonl on resume;
  `DwfCheckpointState` has no version field.

## LOW (summary)

I2 missed-run silent-skip policy undocumented + unpersisted once-past error-disable · I3 cron
minute-scan blocks the event loop 79–309ms ×2/fire (measured), no parse-time validation of
unsatisfiable specs · I4 cron UTC-only, undocumented · I5 anchor TTL creation-based, handoff-evicting,
implicit resurrection (LATENT — `accumulateHandoff` has zero production callers) · I6 runNow
double-dispatch + stale runCount · H5 wait-status-cache post-load-stamp TOCTOU (no production caller
for waitStatus) · H6 broker death mid-delegate orphans shadow record (heartbeat-watcher skips
delegate; stale-reconciler has no branch) · H7 latent double-connect race (no single-flight; currently
unreachable — all callers fresh-per-request) · H8 reconnect strands pending entries; subscribe() is a
no-op stub · J4 E008 "All N candidates exhausted" overstates early break · J5
PI_CREW_MODEL_FALLBACK_ORDER env unvalidated (silent parentFirst) · J6 broad retryable heuristics can
advance chain on deterministic failures (documented trade-off; cost-bounded) · K5 BDG-2 reserve
prompt-side only → last-call overrun · K6 TruncationStage result ≈1.15×maxChars + marker ·
K7 surrogate/grapheme-splitting slices → mojibake · K8 pruner digest hardcodes exit=1 +
firstErrorLine misses multi-line stack-trace heads.

## Verified CLEAN (guard citations in lane reports)

- **Broker core**: request/response correlation (UUID per call, late-response drop); NDJSON partial-frame
  buffering (UTF-8 safe, typed oversize); steer dual-write + cross-channel dedup across the fallback
  window; token lifecycle (runId-scoped, per-secret revocation, constant-time compare).
- **Time/persistence core**: plan-store lineage + version-guarded approval under lock; per-tick plan
  dispatch gate; checkpoint runId-verified + terminal-run refuse on restore; adaptive-plan injection
  idempotence; semaphore FIFO abort-aware; stale-reconciler liveness ladder (intentional-wait →
  registry claim → result → PID/startTime → heartbeat downgrade); orphan-registry TOCTOU kill guards.
- **Model chain**: advancement strictly retryable-gated (non-retryable breaks, never advances);
  empty-settle messages match ALL retryable patterns and ZERO non-retryable (programmatic check — the
  DR-01/DR-02 gates advance the chain as designed); arg re-assembly per attempt (no double suffix);
  env>runtime>default precedence with failsafes; tier escalation sticky + locked.
- **DWF/compaction**: agent-call cap overshoot bounded by semaphore (documented); budget reserve
  check+debit is one synchronous block; DeduplicateStage consecutive-only AND unwired in production;
  pruner staleness/protect/hysteresis correct; jiti per-run isolation (no module bleed).

## Round metrics & protocol decision

4 lanes, ~45 files read at source, 25 findings (3 HIGH · 7 MED · 15 LOW), 3/3 HIGH lead-verified with
quotes, 0 false positives surviving verification. Diminishing-returns check: rounds 4/5/6 found
3/2/3 HIGHs — no decay yet, but the remaining un-audited surface is shrinking (UI render internals,
mailbox delivery internals, verify-gate execution semantics, extension registration lifecycle remain).
Recommendation: **fix-first (DR-03: R6-1/2/3 + the 8 MEDIUMs), then optional round 7.**

## Proposed DR-03 fix plan

| Pri | Item | Fix shape | Effort |
|---|---|---|---|
| P0 | R6-1 terminal-resurrection guard | status/epoch check at persistSingleTaskUpdate terminal write (mirror coalesced :367) | S |
| P0 | R6-2 scheduler persistence | persist on `updated` events + load-time lastStatus normalization + round-trip test | S |
| P0 | R6-3 PERS-1 cache key | full call-shaping key + cache full result shape | S |
| P1 | R6-7 DWF gate exemptions (2-line fix) | add patches/cancelled checks | S |
| P1 | R6-5/H3 response-drop + needsResync | force-flush responses; wire or delete the flag | S |
| P1 | R6-6/H4 msg.send idempotency | pass requestId + explicit timeoutMs in message-tool | S |
| P1 | R6-4/H2 delegate budget lost-update | allocation field-merge in runner persist (or broker-owned side-file) | M |
| P1 | R6-8/J2 env scoping | scope for chain (or bare-id provider inference) | S |
| P1 | R6-9/J3 embedded usage-on-fault | usage capture in catch paths | S |
| P1 | R6-10/K2 ctx.retry semantics | retry on res.ok===false | S |
| P1 | R6-11/K3 splitter ownership | last-wins→validate or per-task nonces | M |
| P2 | I2/I3/I4 policy+perf+docs; K4 ordering+version; K5-K8; J4/J5; H5-H8; I5/I6 | small diffs / docs | S |
