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
