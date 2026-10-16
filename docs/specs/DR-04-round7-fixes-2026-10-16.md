# DR-04 — Round-7 fixes (2026-10-16)

Source: `docs/reviews/pi-crew-audit-round7-2026-10-16.md` (all findings lead-verified, 0 FP).
Baseline: commit `66352c6c`, unit 9352/9349/0 fail. Conventions: tabs, biome, no `any`, `// LAZY:` markers, targeted tests per fix, mutation counterfactual where cheap.

## W1 — recovery (`crash-recovery.ts` + tests)
- **R7-1 HIGH**: purge step 6 (:684) — before cancelling, require NO task-level life evidence: reuse/extend `hasRecentActivity` (:352-360, task heartbeat/agentProgress) on the fresh in-lock snapshot; skip cancel if any task heartbeated within `staleThresholdMs`.
- **R7-6 MED**: under-lock revalidation (:639 cancelOrphanedRuns, :691 purge) — after `fresh.manifest.status === "running"`, ALSO re-verify liveness inputs from fresh data (manifest.updatedAt / heartbeat.json mtime / task heartbeats); if fresh evidence exists (e.g. resume just adopted), abort.
- **M-4 LOW**: `applyRecoveryPlan` :216 — filter `reset` to tasks whose FRESH status is non-terminal (mirror :787-789 pattern).
Tests: DWF-foreground false-cancel scenario (no heartbeat.json, task heartbeat fresh → no cancel); resume-adoption race (fresh updatedAt under lock → abort); stale-plan requeue.

## W2 — event-log inline compaction (`event-log.ts`, `event-log-rotation.ts` + tests)
- **R7-2 HIGH**: 5 inline sites (:645, :749, :857 async; :1051, :1144 sync) call `prepareCompaction`+`applyCompactionUnlocked` with no `.alock` and no tail-merge.
- Design (DEADLOCK-AWARE — locks non-reentrant):
  - Add exported `applyCompactionAppendGuarded(eventsPath, prepared, opts?: { holdsAppendLock?: boolean })` in event-log-rotation.ts: when NOT already holding `.alock` → `withEventLogAppendLockSync` nested inside the held `.mkdirlock` (order = R4-2 docblock); ALWAYS merge `readTailSince(eventsPath, prepared.originalSize)` before apply. Refactor `compactPreparedEventLog` to reuse it if clean.
  - Executor MUST read each call site's enclosing scope: async-family sites may already hold `.alock` (grep the enclosing function for `withEventLogAppendLockSync`/`withEventLogAppendLock`) → pass `holdsAppendLock: true` (tail-merge only, no re-acquire). Getting this wrong = deadlock; assert with a test that parks an async appender between open and appendFile (R4-2 repro pattern) while inline compaction runs — event must survive.
Tests: cross-family interleavings (sync-compaction vs parked async appender; async-compaction vs sync appender bytes); no-deadlock regression (all append paths still complete under existing suites).

## W3 — RPC + registration lifecycle (`cross-extension-rpc.ts`, `rpc-hmac.ts`, `runtime-cleanup.ts`, `lifecycle-handlers.ts` stop-wiring only, `team-tool/cancel.ts`, `wire-cross-extension.ts` + tests)
- **R7-9 MED**: `pi-crew:live-control` realtime channel — enforce the same read-only gate: parse then check `request.operation` against an allowlist mirroring `RPC_ALLOWED_OPERATIONS` semantics for steer/stop/resume/follow-up; reject (warn log, no publish) operations not permitted without HMAC secret; document the trust decision at :49.
- **R7-10 MED**: nonce replay cache in `rpc-hmac.ts` — bounded LRU/FIFO (e.g. 512) `Map<nonce, ts>`, reject nonces seen within validity window; purge expired. Keep stateless fallback path intact.
- **N-3 LOW**: `withHmacVerification` bind actual channel: MAC must cover the arrival channel — pass the wrapper's channel into `verifyRpcSignature` (mix channel string into `computeHmac` payload or verify `payload.channel === channel` when present).
- **R7-11 MED**: wire `ctx.brokerController?.stop()` into `cleanupRuntime` (runtime-cleanup.ts) + ensure idempotent; align lifecycle-handlers docblock.
- **N-5 LOW**: cancel.ts — move async-pid kill + `terminateLiveAgentsForRun` AFTER the in-lock fresh read + terminal short-circuit (kill only if fresh status still "running"); reuse R13-2 fresh snapshot.
- **N-6 LOW**: wire-cross-extension.ts — generation/ownership guard: capture `ctx` generation; in `.then`, abort install if cleanup already ran (exported flag or disposed check).
Tests: unauthenticated steer on live-control rejected; replayed nonce rejected; channel-mismatch MAC fails; cleanupRuntime calls broker stop once; cancel on completed run sends no signal; late import install skipped post-cleanup.

## W4 — UI render (`render-scheduler.ts`, `overlays/mailbox-compose-overlay.ts`, `inline-panel/agent-view-overlay.ts`, `powerbar-publisher.ts`, `dashboard-panes/agents-pane.ts`, `inline-panel/index.ts`, `events-state-source.ts` + tests)
- **R7-12 MED**: render-scheduler — max-delay cap: track `pendingSince` (first schedule of the current pending render); force flush when `now - pendingSince >= maxDelayMs` (e.g. 3× debounce, floor 250ms) even while events keep arriving; fallback loop may render when pending is stale beyond cap.
- **R7-14 MED**: mailbox-compose — accept multi-char printable chunks: reuse the `isPrintableInput` approach from agent-view-overlay (:41-43); strip nothing else.
- **O-4 LOW**: surrogate-safe backspace in BOTH editors (detect trailing high surrogate, remove 2 units).
- **O-5 LOW**: replace ad-hoc `.slice()` truncations with shared grapheme-aware helpers (`truncVisual`/`truncLine`) at powerbar-publisher :161/:200, agents-pane :102.
- **O-6 LOW**: openPane double-mount — track `opening` promise; second call while pending no-ops (or awaits same mount).
- **O-7 LOW**: events-state-source poll — do NOT mutate stamps before resync; stamp only after successful scan (honor the rootBuild retry contract); don't set `resynced/version` on failed scan.
Tests: sustained schedule() stream flushes within maxDelay; multi-char paste appends; astral backspace leaves clean string; double openPane mounts once; failed resync keeps old stamp and retries.

## W5 — mailbox + notify + registry (`mailbox.ts`, `notification-router.ts`, `team-tool-schema.ts` (description only), `active-run-registry.ts`, `heartbeat-watcher.ts`, `task-health.ts` + tests)
- **R7-3 MED**: `updateMailboxMessageReply` — search archive files too (mirror `safeReadMailboxFile` archive walk :337-347); write the reply metadata back INTO the file where the message lives (archive stays immutable history → instead: if found only in archive, append the reply-marked record to the LIVE file as a compensating update record, or extend the reader merge to prefer live reply-mark — choose the design that keeps readers (`readMailbox`/`readMailboxMessage`) consistent and document it in-code).
- **R7-4 MED**: `flush()` — wrap each `deliver` in try/catch → `logInternalError("notification.flush", ...)`; never propagate out of the timer; keep batch-loss semantics but log.
- **R7-5 MED (docs-truth)**: schema `replyDeadline` description → "Advisory metadata only. Enforcement deadline is auto-clamped by the broker (task.waiting.deadline); this value is recorded, not enforced." Update respond.ts param doc if it repeats the claim.
- **R7-15 MED**: active-run-registry EPERM — `return true` (alive) on non-ESRCH/ENOENT codes per the comment; same fix in `activeRunEntries()` catch path if it mirrors.
- **M-8 LOW**: heartbeat-watcher — delete `lastDeadletterTriggerAt` keys in the cleanup loop + `dispose()`.
- **L-6 LOW**: task-health — derive stalled tasks from `task.heartbeat` age (no new writer): `now - task.heartbeat > STALLED_THRESHOLD_MS` and status running.
- **L-9 LOW**: `validateMailbox` — extend validation/repair loop to `mailbox/tasks/<id>/*.jsonl` (same line-parse + delivery-check semantics).
Tests: reply-to-archived-message visible after respond (reader merge consistent); flush deliver-throw logs and doesn't crash; EPERM entry retained; stale heartbeat counted stalled; corrupt task-mailbox line reported by validate.

## W6 — verification + process + surface (`team-tool/dispatch/status.ts`, `process/zombie-scanner.ts`, `verification/verification-gates.ts`, `scratchpad/engine.ts`, `decision-ledger.ts`, `runtime/surface/tmux-provider.ts` + tests)
- **R7-8 MED**: status checkpoint — read `task.checkpoint` from tasks.json (production source of truth) as PRIMARY, FileCheckpointStore as fallback; report which source.
- **M-7 LOW**: zombie report — include `starttime` (already parsed) + pid age in each row; recommend killing promptly after scan.
- **P-3 LOW**: decision-ledger — tolerant parse: skip unparseable tail lines (logInternalError once per read); keep behavior for valid lines.
- **P-4 LOW**: verification-gates `executeCommand` — cap accumulation while streaming (stop concatenating past ~200KB, keep tail marker); final `slice(-100000)` unchanged.
- **P-5 LOW**: scratchpad `restoreState` — reject/ignore snapshots with unknown `version` (warn, return `{restored: []}` + reason) instead of silent fail-open.
- **R7-13 MED**: tmux-provider — consecutive-failure strike counter (≥2) before firing `mux-dead` (reset on success); single transient exec error no longer kills all panes; keep permanent-death semantics after 2 strikes. Inject `deps.tmux` tests.
Tests: status checkpoint surfaces task.checkpoint; zombie row includes starttime; corrupt ledger tail tolerated; >cap output command bounded; v2 snapshot rejected; 1-strike transient tmux failure keeps watchers alive, 2 strikes fire.

## Deferred (documented, not fixed)
L-4/L-5 dead machinery (0 callers), L-7 ask.timedout re-emit, L-8 pickup priority, M-6 claim lease renewal, H6/K5/I5/J6/I2 (DR-03 carryovers).

## Gates (lead)
tsc → targeted suites → biome → ci:fast (16 gates; watch wc-gate + lazy-import ratchet) → full test:unit (expect ~9420+, 0 fail) → build:bundle + dist commit. Commit per cluster; `git add -f dist/index.mjs`.

## Completion record (2026-10-16, commits 2556e6c1..18bbc043)
All 6 clusters landed + lead wiring (finalize-run heartbeat pass-through — L-6 was dead at the
production call site) + gates: tsc ✓ · biome ✓ · wc-gate/lazy-import 527/527 ✓ · bundle rebuilt ·
ci:fast exit 0 · full unit **9431 tests / 9425 pass / 0 real fail / 3 known timing flakes
(RT-5 #4/#5, pulse-1 — isolated-green ×2 per runbook) / 3 pre-existing skips** (+79 vs DR-03).
All 2 HIGH + 13 MED + 15 LOW fixed. Deferred documented: L-4/L-5 dead machinery, L-7, L-8, M-6,
plus W-noted follow-ups: handleForget pre-lock kill (same N-5 pattern, lifecycle-actions.ts),
readMailboxMessage task-mailbox asymmetry, events-state-source anomalous-fs tail-follow throw.
