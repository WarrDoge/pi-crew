# SPEC DR-03 — Round-6 Audit Fixes (all lead-verified findings)

> Date: 2026-10-16 · Base: `20735754` (post round-6 report) · Source: `docs/reviews/pi-crew-audit-round6-2026-10-16.md`
> ALL 3 HIGH + 9 MEDIUM lead-verified at source (quotes in report). LOWs: executor re-verifies before fixing.
> No publish in this spec. Gates at end (lead). Clusters are FILE-DISJOINT — do not touch other clusters' files.

## Cluster 1 — terminal-preserve + allocation merge (R6-1 HIGH, R6-4 MED) — HOT PATH, careful
Files: `src/runtime/task-runner/state-helpers.ts`, `src/runtime/task-runner/post-execution.ts`,
`src/runtime/task-runner/live-executor.ts` (if needed) + tests.
- R6-1: `persistSingleTaskUpdate` (state-helpers.ts:103 area) reloads disk inside the lock but
  `updateTask(latest, task)` replaces by id UNCONDITIONALLY. Fix: when the INCOMING task status is
  terminal, compare with the DISK task's status — if disk already holds a DIFFERENT terminal status
  (esp. cancelled by crash-recovery/stale-reconciler), PRESERVE the disk terminal status + error
  (mirror run-coalesced-task-group.ts:367 cancelled branch + R13-S1 class). Non-terminal disk status →
  incoming wins as today. post-execution's event emission must match the PRESERVED status (don't emit
  task.completed over a cancelled record — emit nothing or the preserved status per existing event
  helpers). Tests: cancelled-disk + completed-incoming → cancelled preserved; running-disk +
  completed-incoming → completed (normal path pinned); idempotent same-terminal → unchanged.
- R6-4: delegate budget reserve/roll-up (crew-broker writes allocation.tokensSpent under lock) is
  clobbered by the 1s heartbeat whole-record replace (live-executor.ts:138 → same
  persistSingleTaskUpdate). Fix IN THE SAME MERGE POINT: when merging the incoming task onto disk,
  `allocation` merges field-wise preferring the DISK value for `tokensSpent` when it is GREATER than
  the incoming in-memory value (heartbeats carry stale pre-reserve copies; broker arithmetic only
  ever increases spent on reserve and adjusts on roll-up — max() is safe for both directions: verify
  by reading crew-broker.ts:1575-1602 (reserve: disk+reserved) and :1690-1708 (roll-up:
  −reserved+actual on the then-current base) before choosing max vs sub-field merge; if max is wrong
  for roll-up, keep disk tokensSpent verbatim whenever incoming's equals the value this runner last
  saw — document the chosen rule in a comment). Tests: reserve survives a concurrent heartbeat
  persist; roll-up final value correct after heartbeats.

## Cluster 2 — scheduler persistence + LOWs (R6-2 HIGH, I6, I3, I4)
Files: `src/extension/registration/lifecycle-handlers.ts`, `src/runtime/scheduling/scheduler.ts`,
`src/runtime/settings-store.ts` (load normalize), `src/extension/team-tool/handle-schedule.ts` (humanize, if that's where it lives) + tests.
- R6-2 root (lead-verified): executor persists the job snapshot while `lastStatus:"running"` THEN
  flips memory-only (`lifecycle-handlers.ts:594-620`); the `updated`-event persist flow the armCron
  docstring claims does not exist (emit callback at :563-570 only notifies). Fix (all three):
  (a) emit wiring: on scheduler `updated` events → persistScheduledJobUpdate; (b) executor: swap
  ordering — update FIRST, then persist the updated job; (c) load-time normalization: when
  session_start loads jobs, reset stale `lastStatus:"running"` → undefined (an in-flight flag from a
  dead process is meaningless). Round-trip test: fire → simulate restart (reload from settings) →
  job fires again (no permanent skip); plus in-flight guard still works within one process.
- I6: runCount increment uses closure-captured `job` — read the fresh job from crewScheduler.list()
  before computing runCount+1.
- I3: parse-time validation in parseSchedule — reject unsatisfiable field combos cheaply (e.g.
  day-of-month 31 + month 2 with no valid combination; keep it conservative: only reject
  provably-impossible dom/month pairs, do NOT build a full cron validator). Goal: `"0 0 31 2 *"`
  fails at parse, not after a 309ms scan.
- I4: humanizeSchedule (and schedule action help/docs if reachable) states cron is evaluated in UTC.

## Cluster 3 — DWF correctness (R6-3 HIGH, R6-7, R6-10, R6-12 MEDs + K4 parts)
Files: `src/runtime/goal-workflow/dynamic-workflow-context.ts`, `src/runtime/dwf-state-store.ts` + tests.
- R6-3 (lead-verified :398-412): callId key = {role, agent, prompt, model, schema:"yes"/"no"} — omits
  inputs/systemPrompt/disableTools/maxTurns/worktree (inputs provably alter the dispatched task).
  Fix: key over ALL AgentCallOpts fields that shape the call (JSON.stringify the full resolved call
  object — sort/normalize array fields for stability; schema included BY VALUE). Cached record must
  store the FULL AgentResult (text, usage, structured, artifactPath, durationMs actual) so replay
  doesn't drop structured/artifactPath. Tests: same prompt + different inputs → 2 spawns; same call
  twice → 1 spawn; replay returns structured + artifactPath.
- R6-7 (lead-verified :501): DWF gate `exitCode!==0 || error || settledWithoutAnswer` lacks the
  sibling exemptions. Fix: add `&& !(parsed.patches?.length ?? 0)` on the settledWithoutAnswer term +
  cancelled exclusion (`childResult.exitStatus?.cancelled` / signal aborted) — mirror
  child-executor.ts:428-431 exactly. Tests: patch-only final message → ok:true; aborted → not a 429 error.
- R6-10 (lead-verified :733): ctx.retry never retries ok:false (executor retries THROWN errors only).
  Fix INSIDE ctx.retry: wrap fn that throws a `DwfRetryFailure` (carrying the AgentResult) when
  res.ok === false; executeWithRetry retries it; after exhaustion catch and return the carried
  result (preserve current return type; only DwfAgentCallCapError semantics unchanged). Tests:
  ok:false twice then ok:true → 3 agent calls, success; persistent ok:false → 3 attempts, returns
  last failure.
- R6-12 (lead-verified :583-612): reorder — checkpoint (agentCount++ + onCheckpoint) BEFORE the
  worktree-cleanup await (crash during cleanup no longer loses the call → no duplicate respawn).
  Phase re-emission: when hydrating from a checkpoint, do not re-emit phase_started/phase_completed
  for phases already recorded in the checkpoint (guard by comparing hydrated phase state before
  emitting). Version field: DwfCheckpointState gains `version: 1`; loader quarantines/rejects
  unknown future versions (mirror checkpoint.ts runId-guard style). Tests: ordering pin
  (checkpoint happens before cleanup — source-position or seam), phase no-dup on resume, version
  reject.

## Cluster 4 — broker outbound + client + msg.send (R6-5, R6-6 MEDs + H5, H7, H8 LOWs)
Files: `src/runtime/broker/crew-broker.ts`, `src/runtime/broker/crew-broker-client.ts`,
`src/prompt/message-tool.ts`, `src/runtime/broker/wait-status-cache.ts` + tests.
- R6-5 (lead-verified :801-826): responses (`sendResult` acks for wait.request/msg.send) go through
  writeOrQueue(force=false) → drop-newest at cap; `needsResync` is write-only (6 hits, 0 reads).
  Fix: (a) sendResult/enqueueFrame gains a force/response class that bypasses the cap for REQUEST
  RESPONSES (small frames, bounded by pending-request count — never the fanout storm); keep
  drop-newest for fanout/events. (b) needsResync: wire it — when set, close the connection with a
  typed protocol close-reason ("outbound-overflow-resync") so the client reconnects + replays, OR
  delete the flag + comment honestly. Choose wire-close (matches the comment's intent). Tests:
  saturated queue + response → response delivered (not dropped); fanout still drops at cap;
  overflow → connection closed with the resync reason.
- R6-6 (lead-verified): msg.send client.request has no timeoutMs (15s default) and no requestId →
  >15s durable send reported "NOT sent"; retry duplicates. Fix: message-tool passes a stable
  `requestId` (idempotency key from message identity — rg how requestId is threaded in the broker
  request params; reuse the U5 `appendMailboxMessageIdempotentAsync` index) AND an explicit larger
  timeoutMs for msg.send (e.g. 60_000, module constant). Tests: slow-ack beyond 15s still resolves
  (no false negative); retry with same requestId dedupes (U5 pin already exists — extend to the
  message-tool path).
- H5: wait-status-cache load keys the entry on the PRE-load stamp (stat before parse), not
  post-load (kills the parse→stat TOCTOU window pinning stale-under-fresh). Test: writer lands
  between parse and stat → next tick sees stamp change → reloads.
- H7: single-flight the client connect (in-flight connect promise; concurrent request() awaits the
  same promise). Test: two concurrent requests on a fresh client → one connection.
- H8: teardownSocket rejects stranded pending entries immediately (with a typed
  connection-closed error) instead of leaving them to their timers; subscribe() — implement minimal
  event forwarding OR make it throw "subscribe not supported" (0 production callers — choose throw
  to prevent silent no-op misuse). Tests for both.

## Cluster 6 — model/env/usage (R6-8, R6-9 MEDs + J4, J5 LOWs)
Files: `src/runtime/child-pi/child-pi-spawn.ts`, `src/utils/env-filter.ts`,
`src/runtime/live-session/live-session-runtime.ts`, `src/errors.ts`,
`src/runtime/task-runner/child-executor.ts` (E008 wording only), `src/runtime/model/model-fallback.ts` + tests.
- R6-8 (lead-verified): `buildScopedAllowList(BASE_ALLOWLIST, [model])` passes ONE model;
  providerEnvKeys returns [] for bare ids → zero provider keys → child auth fails → non-retryable
  break though qualified fallbacks were queued. Fix WITHOUT weakening scoping: thread the model
  CANDIDATE CHAIN (or at least the resolved candidates for this task) into the spawn context and
  scope keys for the chain's providers (the doc contract already says "primary + fallbacks"). Where
  the chain isn't available (truly bare single model), emit a warn log (env-key auth + bare id =
  likely misconfiguration; auth.json users unaffected). Tests: chain scoping includes 2nd provider
  key; bare id without chain → warn + base keys only (no all-provider leak).
- R6-9 (lead-verified): embedded-tier usage only on the success return (~:1781); fault/watchdog
  catch paths carry no usage → budget under-count when embeddedWorkers on. Fix: capture
  usageFromSessionStats(session) in the fault/watchdog return paths too (session may be partially
  usable — guard). Test: faulted embedded run still reports usage > 0 when turns burned.
- J4: E008 message — when the loop broke early (tried < chain length), say "Model chain failed
  early (tried A → B of N candidates; last error ...)" instead of "All N exhausted". Keep the
  all-exhausted wording for genuine exhaustion. Test both shapes.
- J5: resolveModelFallbackPolicy validates PI_CREW_MODEL_FALLBACK_ORDER against
  {"parentFirst","asIs"} — invalid → warn + fall back to config/default (mirror the sibling NaN
  clamp-warn pattern). Test: "parent-first" → warn + parentFirst semantics.

## Cluster 7 — splitter + compaction engines (R6-11 MED + K6, K7, K8 LOWs)
Files: `src/runtime/task-runner/output-splitter.ts`, `src/runtime/compaction/compact-stages/truncation-stage.ts`,
`src/runtime/compaction/important-line-classifier.ts`, `src/runtime/compaction/tool-output-pruner.ts` + tests.
- R6-11 (lead-verified :66-86): first-occurrence-wins + no ownership validation → forged/quoted
  delimiter blocks win attribution. Fix (pragmatic, documented): (a) LAST-wins for duplicate
  delimiter hits (a worker quoting an earlier genuine block then emitting its own genuine block →
  genuine wins; document residual: emit-then-quote inversion still misattributes — impossible to
  fully solve without content signing); (b) duplicate-hit detection → structured warn (logInternalError)
  naming the task + hit count; (c) Strategy 2/3 id matching becomes word-boundary/exact (fix
  substring collisions at :171,182; numbered-section mapping honors `num`, not position). Tests:
  forged-quote-before-genuine → genuine content wins + warn logged; substring id collision no
  longer misattributes.
- K6: truncation budget accounts for marker + important-line slack — head+tail shrink so the FINAL
  result (with marker + kept important lines) fits ≤ maxChars + small constant; keep monotonic-shrink
  invariant. Test: result length ≤ maxChars + marker budget across fixtures.
- K7: surrogate-pair-safe slicing at head/tail boundaries (back the index off while it splits a
  surrogate pair; same for the important-line insertion seams). Test: astral char straddling the
  75% boundary survives intact in both halves.
- K8: pruner digest — pass through the REAL exit code when available (don't hardcode 1; if the
  original content lacks it keep current behavior) and firstErrorLine additionally captures the
  first 3 lines of the stderr/stack HEAD when no pattern line matches (diagnostic head > tail).
  Tests: exit 127 digested as 127; multi-line stack trace keeps its head.

## Deferred (documented, NOT in this wave)
H6 (shadow orphan on broker death — needs stale-reconciler delegate branch design), K5 (BDG-2
output-side reservation design), I5 (anchor accumulation — zero production callers), J6 (broad
retryable heuristics — documented trade-off), I2 policy (missed-run silent-skip — now durable after
R6-2; document in usage docs when convenient).

## Gates (lead, after all clusters land)
tsc · targeted suites per cluster · ci:fast · full test:unit (0 new fail) · build:bundle + dist commit.
Real-test battery before any release (src/runtime/task-runner, broker, prompt, scheduling touched).

## Completion record (2026-10-16, commits 0100edef..0c29a3c3)
All 6 clusters landed + lead gates: tsc ✓ · wc-gate ✓ (crew-broker.ts extracted to exactly 2000 —
recipient matrix → protocol/msg-send-targets.ts, lazy-import ratchet 526→527 per usage-bridge
precedent) · ci:fast exit 0 (16 gates; fixed 3 stray biome findings: embedded-tier UR-guard
comment-in-block, pi-json-output optional-chain, test-fixture empty lambdas) · full unit
**9352 tests / 9349 pass / 0 fail / 3 pre-existing skips** (+73 vs DR-02 wave-2) · bundle rebuilt.
All 3 HIGH + 9 MEDIUM fixed; LOWs fixed: I3 I4 I6 H5 H7 H8 J4 J5 K6 K7 K8. Deferred documented:
H6 K5 I5 J6 I2-policy.
