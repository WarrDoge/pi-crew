# SPEC DR-02 — Round 4+5 Audit Fixes (P0 wave)

> Date: 2026-10-15 · Owner: lead session · Base: v0.11.21 @ round-5 docs commit
> Sources: `docs/reviews/pi-crew-audit-round4-2026-10-15.md` + `pi-crew-audit-round5-2026-10-15.md`
> (all findings lead-verified at source). No publish in this spec; ship per release gate after CI matrix.

## Scope of THIS wave (P0 only — 4 items, 3 clusters)

### WI-1 (R4-1): Coalesced-group dispatch must not false-green on empty-settle
- File: `src/runtime/scheduling/run-coalesced-task-group.ts` (+ test)
- Evidence: `:246` `rawOutput = result.rawFinalText ?? result.stdout ?? ""` never parsed as pi-json;
  `:253` `success = !cancelled && result.exitCode === 0 && !result.error` (legacy pre-DR-01);
  `:326` `ok = success && Boolean(entry?.text)`. rg settledWithoutAnswer in file = 0.
- Fix shape: in the stdio result branch, when the output is pi-json (reuse the same detection the
  task-runner path uses — see how `child-executor.ts` decides to parse), run `parsePiJsonOutput` and
  fail the group when `parsed.settledWithoutAnswer === true`: set `result.error`-equivalent so the
  existing `success=false` path + retry/deadletter machinery applies, with error message matching the
  DR-01 convention: "Model settled without a final answer (coalesced: empty final assistant message;
  upstream rate-limit/429 exhaustion)". Do NOT change healthy-path behavior: json-success and plain
  text outputs must dispatch identically to before.
- Test: unit test with `PI_TEAMS_MOCK_CHILD_PI=json-429-empty-settle` + `PI_CREW_ALLOW_MOCK=1`
  (fixture exists — `src/runtime/child-pi/mock-fixtures.ts`), coalesced group of 2 read-only tasks →
  group must NOT complete tasks; expect failure/deadletter path. Plus a healthy-path control
  (existing json-success fixture or plain-text) → tasks completed with partitioned entries.
- Conventions: no `any`; `// LAZY:` marker above dynamic imports; biome format; keep G20 comment
  blocks intact.

### WI-2 (R4-3): Workspace-lock heartbeat must be refreshed while the goal loop runs
- Files: `src/runtime/goal-workflow/goal-loop-runner.ts` (+ optionally `src/runtime/workspace-lock.ts`) + test
- Evidence: `workspace-lock.ts:147` `writeLock` is dead code (0 callers); heartbeat written once at
  acquire (`:312`); `isLockStale` clause (b) `:241` stale after 60s REGARDLESS of PID liveness;
  goal-loop-runner acquires at `:579`, releases `:913`, no refresh between (grep = 0 hits).
- Fix shape (preferred): in the goal-loop runner, start an interval (e.g. every 15s, `unref()`-ed,
  stopped in the same `finally` that releases the lock) that calls a NEW exported
  `refreshWorkspaceLockHeartbeat(lockPath, goalId)` implemented in workspace-lock.ts — it must only
  refresh when the lock still belongs to this goal+pid (read, check goalId/pid match, rewrite via the
  existing atomic claim path — reuse/repair `writeLock` for this, keeping its file format identical);
  never throw into the loop (try/catch → logInternalError warn). Alternative accepted: derive
  staleness from PID liveness only (drop clause (b)) — but that changes semantics for
  kill -9'd holders on non-Linux; interval refresh is safer. Document choice in the module header.
- Test: unit test — acquire lock, advance fake time past 60s WITHOUT refresh → second acquire
  force-steals (existing behavior, pin it); WITH periodic refresh → second acquire queues/waits
  (no steal). Use injected `now`/interval like existing workspace-lock tests do (see their patterns).

### WI-3 (R5-1 + R5-2, same seam — one owner): Inbox ack must happen AFTER delivery, and only for the batch actually sent
- Files: `src/prompt/inbox-poll.ts` + `src/prompt/prompt-runtime.ts` (+ test)
- Evidence (lead-verified): `inbox-poll.ts:204-224` — every picked row is `seen?.add`-ed AND durably
  recorded "acknowledged" BEFORE the caller sends; `prompt-runtime.ts:1084-1112` catch treats send
  failure as transient read error (no unmark/rollback — contrast steer path `:934-952` which HAS
  `seenSteers.unmark` + rewind); `:1090` `picked.slice(0, INBOX_BATCH_MAX)` acks N, sends 8.
- Fix shape (preserve U5 restart-safety semantics — the durable record is what prevents
  re-delivery after restart, so it must STILL be written, just not BEFORE a send that can fail):
  1. `pollWorkerInbox` gains an optional `limit` param: only pick (seen-add + durable-ack + return)
     up to `limit` rows (callers pass INBOX_BATCH_MAX). Leftover rows are simply not picked → next
     tick re-picks them. This fixes R5-2 with no ordering change.
  2. For R5-1: split pickup into two phases — `pollWorkerInbox` returns candidates and does the
     in-memory `seen.add`, but the DURABLE "acknowledged" record moves to a new
     `acknowledgeWorkerInboxDelivery(manifest, picked)` called by prompt-runtime ONLY after
     `pi.sendMessage` succeeds; on send throw, unmark the in-memory seen ids (mirror
     `seenSteers.unmark`) so the next tick re-picks. Keep `recordMailboxRequestIdDelivery` internals;
     keep the dedup-read checks (acknowledged rows skipped) unchanged. Emit pickup event after
     successful ack. Mind: mid-batch partial ack is acceptable (at-least-once > at-most-once with
     false audit).
  3. Registration-time synchronous `pollInbox()` call (`:1108`) before extension runtime is bound:
     make it tolerate send-throw via the same unmark path (it now does by construction).
- Test: (a) >limit available rows → only limit delivered+acked, remainder delivered next poll;
  (b) `pi.sendMessage` throws (inject fake pi) → ids unmarked, durable record NOT written, next
  poll re-picks and (send succeeding) delivers; (c) restart-safety control — acknowledged rows are
  still skipped after a fresh pollWorkerInbox with empty seen-set (U5 pin, should already exist —
  keep it green).

## Out of scope (tracked for later waves)
P1: R4-2 compaction race (design spec), R4-4, R4-5, R4-6/7, R5-3..7. P2/P3 per round-5 backlog table.

## Gates (run by lead after all 3 clusters land)
1. `npx tsc --noEmit`
2. Targeted suites: scheduling, workspace-lock/goal-workflow, prompt-runtime/inbox tests
3. `npm run ci:fast` (incl. biome + staleness)
4. Full `npm run test:unit` — 0 new failures (known flake: child-executor-heartbeat-pulse under load →
   isolated rerun ×2 rule)
5. `npm run build:bundle` + commit dist
6. Real-test battery decision table (src/runtime + src/prompt + dist touched) before any release

## WI status
- WI-1: DONE — gate `throwIfSettledWithoutAnswer` inside runOnce (throws per-attempt so executeWithRetry retries + US-003 deadletter applies); parses result.stdout via parsePiJsonOutput (512KiB tail, same seam as DWF gate); behavioral counterfactual pinned (pre-fix completed,completed → post-fix failed,failed). Tests: 4 new (429 group fail / retry-exhaustion deadletter / healthy control / gate-semantics battery); existing coalesced suites 37/37.
- WI-2: DONE — `refreshWorkspaceLockHeartbeat(lockPath, goalId)` exported (re-stamps ONLY heartbeat via repaired writeLock, only when lock still belongs to goalId+pid — never clobbers a reclaimed lock, non-throwing); goal loop starts 15s unref'd interval after acquire, stops first in release finally. Tests: +10 (semantics + WITHOUT-refresh steal pin / WITH-refresh no-steal + cadence/throw-safety/wiring pin). 63/63 incl. 13 pre-existing.
- WI-3: DONE — pickup/durable-ack split: `pollWorkerInbox(pickup, limit)` picks+seen-adds up to limit (R5-2); `acknowledgeWorkerInboxDelivery` called by pollInbox ONLY after pi.sendMessage succeeds; send-throw → `unmarkSeenInboxIds` + warn (mirrors steer F-L2); registration-time poll tolerates throw by construction. U5 restart pins updated to two-phase contract, exactly-once preserved. Tests: +3 new, 12/12 + dedup 7/7 + adjacent 15/15.

Gates (lead, 2026-10-15): tsc ✓ · targeted 42/42 ✓ · ci:fast exit 0 (16 gates, post-rebuild) ✓ · full unit **9201 tests / 9198 pass / 0 fail / 3 pre-existing skips** (+15 tests) ✓ · bundle rebuilt ✓.

---

# Wave 2 — P1 + P2/P3 (2026-10-15, base 8a40cc6e)

## Clusters (file-disjoint, one executor each)

### Cluster A — R4-2 events.jsonl compaction race (P1, design decided by lead)
DESIGN: mutual exclusion, NOT archive-style. Async appends hold `.alock` across the
open→appendFile await gap (event-log.ts:606-610); the orphaned-fd loss happens because compaction's
rename (event-log-rotation.ts:299 atomicWriteFile) runs under `.mkdirlock` only. Fix: compaction
additionally acquires `.alock` in SYNC mode (mkdirSync O_EXCL — same lock-dir protocol, cross-process
compatible with the async acquirer) BEFORE readTailSince+rename, releases after C2 check. Lock order is
strictly mkdirlock→alock (async family never takes mkdirlock — verify by reading event-log.ts), so no
deadlock; reuse the stale-reclaim (mtime+pid) machinery pattern from the existing locks. C2 recovery
unchanged.

### Cluster B — R4-4 needs_attention at finalize + R4-5 verify-decorative surfacing + B4 fail-closed
- R4-4 (detection-first, no status flip): finalize-run.ts — when no failed/waiting/running/queued but
  ≥1 needs_attention, summary must state it ("Team workflow completed with N task(s) needing attention
  (no result submitted)."); policy-engine.ts adds a NON-blocking notify block listing them.
- R4-5 (surface, don't false-fail): green-contract.ts inferGreenLevelFromTask — when required level
  ≠none but contract.commands empty → keep satisfied logic BUT stamp evidence notes
  "self-attested (no verification commands configured)" and expose a `decorative: true` flag consumed
  by post-execution.ts evidence builder; progress-line note optional. Do NOT change
  defaultVerificationContract defaults.
- B4 (post-execution.ts:431-478 catch): fail-closed — on verification-execution throw, when
  requiredGreenLevel ≠ "none": evidence becomes {satisfied:false, observed:"none", notes:
  "Verification execution failed (fail-closed): ..."}. Level none → unchanged.

### Cluster C — R4-6/R4-7/D5 unlocked tasks.json RMW → withRunLockSync + fresh reload
- run-action-dispatcher.ts:125,141 (kill-stale): wrap load→map→save in withRunLockSync with fresh
  re-read inside the lock (canonical pattern: heartbeat.ts:33-40). Keep best-effort semantics on lock
  timeout (skip + warn, do NOT block UI on contention).
- async-notifier.ts:73-92 (async-died): same wrap; preserve per-task terminal guard if present.
- goal-loop-runner.ts:757 (post-turn saveRunTasks): fresh reload + merge (or lock) — do not clobber
  newer heartbeat/claim/delegate fields; merge turn's task fields onto freshly-read tasks.

### Cluster D — UI/surface: R5-3, R5-4, F3, F4, F5
- R5-3 agents-jobs-browser.ts:521: clear this.manifests on refreshData(true); do NOT cache null
  permanently (retry next open); prefer entry.manifest in detailLinesFor when fresh.
- R5-4 process-status.ts:141-149: add "blocked" to the ERROR-grace branch (10min linger). Update
  pinned fixtures.
- F3 agent-transcript.ts:87-91: key module maps by `${runId}::${taskId}`; agent-pane.ts:299 switch
  guard compares runId too; update __hasAgentTranscriptState seam consumers/tests.
- F4 rail.ts:111-133: add `case "blocked"` (warning slot); status-colors.ts: add "planning" mapping
  (dim/informational) — align both vocabularies.
- F5 live-run-sidebar.ts:352-364: countdown line must not freeze — include a coarse time bucket
  (e.g. ceil(remaining/1000)) in the cached signature fragment while terminal countdown active.

### Cluster E — prompt/budget: R5-5, R5-6, R5-7, G6, G7
- R5-5 task-output-context.ts applyHandoffBudget (:723-742): failed/needs-attention deps get the same
  +1000 priority the 96KB layer uses (enforceDependencyInlineBudget :337-347); compact-form head
  (budgetTrimmedDependencyEntryLines :674) runs through important-line preservation (reuse
  important-line-classifier) so error lines from ANYWHERE in the summary survive the 240-char head.
  Status line + pointer stay.
- R5-6 steer reject-drop: send-side clamp — find where leader writes steering (rg steer.*write /
  appendSteering in src) and clamp body to MAX_STEER_MESSAGE_LENGTH with a truncation marker
  (mirror renderInboxMessage's 8192 marker pattern); receiver keeps its validation as backstop.
- R5-7 estimateHandoffTokens (task-output-context.ts:575) + dynamic-workflow-context.ts:361 reserve:
  switch to utils/token-counter.ts countTokens (in-tree, CJK-safe; Vietnamese diacritics already
  over-estimate safely — keep max(heuristic, measured) anchor semantics).
- G6 (:337-347 L4 downgrade): render "[result withheld by inline budget — see artifact path above]"
  instead of falling into "(no result output)".
- G7 task-packet.ts sanitizeTaskText: keep existing markers; when any redaction fired, append ONE
  trailing note to the packet objective: "(N security redaction(s) applied — rephrase constraints to
  avoid trigger patterns if this removed intended meaning)". Count = per-rule hits.

### Cluster F — micro-hardening: E1, E2, C1, C2, C3, D6
- E1 run-coalesced-task-group.ts:148-153: logInternalError in the repair catch (status-stale visibility).
- E2 scratchpad/engine.ts:354-359: logInternalError warn on final-snapshot failure before kill.
- C1 live-session-runtime.ts:1409 seenControlRequestIds: cap 10_000 FIFO (delete first added).
- C2 usage-tracker.ts:71 taskUsageMap: cap 5_000 FIFO eviction (consistent with sibling caps).
- C3 delivery-coordinator.ts:217 pending: MAX 1000 + drop-oldest + warn log (TTL stays).
- D6 crew-agent-records.ts:687 writeSeqToSidecar: tmp+rename atomic write (reuse atomicWriteFile).

## Wave-2 gates: same as wave 1 (tsc, targeted, ci:fast, full unit, bundle) — run by lead.
