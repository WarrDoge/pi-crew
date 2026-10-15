# pi-crew Audit — Round 5 (Lanes F+G + first full coverage data)

> Date: 2026-10-15 · Base: v0.11.21 @ round-4 commit · Method: iterative-audit skill, 2 focused
> read-only lanes (F: UI/surface rendering correctness under concurrent updates; G: prompt-construction
> + context-budget trimming integrity) + full-suite `npm run test:coverage`.
> HIGH/MEDIUM findings lead-verified at source.

## Round-5 verdict

**2 HIGH · 5 MEDIUM · 6 LOW.** The two lanes were chosen precisely because no prior round touched
them; both produced real defects. G1/G2 are the same *silent-permanent-loss-with-false-audit* class
as the DR-01 P0 — in the worker-coordination inbox channel.

## HIGH (lead-verified)

### R5-1 (G1): Inbox pickup records "acknowledged" BEFORE delivery — a `pi.sendMessage` throw permanently loses worker messages with a false "delivered" audit record
- `src/prompt/inbox-poll.ts:204-224` + `src/prompt/prompt-runtime.ts:1084-1112`
- `pollWorkerInbox` adds every picked row to the in-memory `seen` set AND durably writes
  `delivery.json messages[id]="acknowledged"` BEFORE `pi.sendMessage` runs (lead-verified).
  The pollInbox catch treats ANY throw as "transient mailbox read error" — no unmark, no rollback.
  Next tick: the acknowledged check (`inbox-poll.ts:196-199`) skips the row → **permanent silent loss**;
  `delivery.json` + `mailbox.pickup` events claim success; sender gets no bounce.
- Trigger windows: `pi.sendMessage` throws pre-bind (extension still loading — the exact F-L2 failure
  mode observed live for steers; `pollInbox()` is invoked synchronously at registration, BEFORE
  `armInboxPoll()`), or worker crash between durable write and send.
- Smoking gun: the STEER channel has the compensation (`seenSteers.unmark` + offset rewind,
  `prompt-runtime.ts:934-952`, lead-verified) — the same bug class was fixed there and left here.

### R5-2 (G2): `INBOX_BATCH_MAX=8` overflow — surplus messages in a tick are durably acked then never delivered
- `src/prompt/prompt-runtime.ts:1080,1090`
- `const batch = picked.slice(0, INBOX_BATCH_MAX)` — but ALL of `picked` (>8 rows: group broadcast
  burst, catch-up after poll stall) was already seen-added + durably acked inside `pollWorkerInbox`.
  Rows 9..N are skipped forever. Fix: pass the limit into `pollWorkerInbox` / ack only the batch.

## MEDIUM

- **R5-3 (F1)**: Agents & Jobs browser caches run manifests FOREVER (`manifestFor`,
  `agents-jobs-browser.ts:521-532`, lead-verified — no `.clear()/.delete()` anywhere): a transient
  no-lock read failure caches `null` for the overlay lifetime → sticky "(agent record unavailable)";
  non-null caches go stale (running→failed not reflected in detail pane). List uses fresh entries but
  detail reads the dead cache.
- **R5-4 (F2)**: `blocked` runs vanish from dock/powerbar with ZERO grace while `failed` lingers 10 min
  (`process-status.ts:141-149`, lead-verified — grace branch lists completed/failed/cancelled only;
  `blocked` is terminal → `isDisplayActiveRun` false). A hook-refused run silently disappears from the
  ambient channel — user concludes it was cancelled/never started.
- **R5-5 (G3)**: handoff-budget compact form drops a FAILED dep's error tail — head-only 240-char slice
  (task-output-context.ts:674) + trim purely by declaration order, NO failed-status priority
  (asymmetric: the 96KB inline layer gives failed deps +1000 priority; important-line preservation
  exists only in the full-form path). `Status: failed` survives (no stale-success) but the *why* is
  usually beyond char 240 — affirmatively misleading progress-prose head + artifact pointer.
- **R5-6 (G4)**: steering messages >4096 chars / >50 newlines are REJECTED AND DROPPED — no bounce to
  the leader, cursor advances terminally (prompt-runtime.ts:128-140,941-952). Channel asymmetry: inbox
  bodies truncate-with-marker at 8192; the send side has no clamp — the sender can legitimately
  produce a body the receiver discards (stack traces / test output pasted into steer).
- **R5-7 (G5)**: `chars/4` token heuristic understates CJK ~3-4× in handoff budget + DWF BDG-2 reserve
  (`estimateHandoffTokens`, task-output-context.ts:575-577; dynamic-workflow-context.ts:361); the
  measured anchor is absent exactly for crashed deps (`usage === undefined`). Consequence = budget
  overrun/late trim, not info loss. Vietnamese diacritics actually OVER-estimate via `countTokens`
  (safe direction) — the CJK-safe counter already exists in-tree and is not used here.

## LOW (summary)

F3 agent-transcript module state keyed by taskId only (cross-run cursor/buffer bleed if open-pane
re-target fires — latent, narrow reach; key `${runId}::${taskId}`) · F4 `statusSlot` rail vocabulary
missing `blocked` (+ `planning` unmapped in both palettes) — two surfaces disagree about the same
state · F5 sidebar auto-close countdown text freezes between invalidations (close timer unaffected) ·
G6 L4 path-only downgrade renders "(no result output)" for deps that DO have output · G7
`sanitizeTaskText` redacts legitimate security-constraint lines mentioning the keywords (marker with
no explanation) · G8 fallback retry discards failed attempt's `intermediateFindings` (documented
replay-not-rebuild design — INFO).

## Verified CLEAN

- **UI invalidation design** (Lane F hunt 1): 4 independent channels (runEventBus 80ms coalesced,
  per-run fs.watch, TTL self-rescheduling, preload loop with changed-frame signature); worst-case
  terminal-flip latency ≈ 1.6s documented contract; GATE 1/2 repair divergent snapshots.
- **Cross-run cache contamination** (hunt 2): snapshot cache keyed by runId; events-state registry
  refcounted; frame callbacks guarded. (F3 is module-local UI state, not these caches.)
- **Missed-event windows** (hunt 4): `onWithReplay` replays durable log before attaching live listener,
  dedup by seq; overlays carry independent repaint timers.
- **Dispatch concurrency** (hunt 6): one-shot dashboards, 2-step confirm gates, idempotent acks.
- **Full-form dependency truncation** (Lane G): ANSI-strip + important-line preservation
  (`error|failed|exception|fatal|panic`, file:line, HTTP 4xx/5xx) + tee + markers — failure evidence
  survives; analysis.md same path; render helpers truncate WITH markers; no LLM-generated summaries
  anywhere (compaction is marker-based); model-fallback replays byte-identical prompts; skills
  injection validated + path-pointer.

## First full coverage data (pattern 3 — replaces filename heuristics)

- Suite: 9186 tests under `--experimental-test-coverage`; **90.30% lines / 84.77% branch / 76.85%
  funcs** overall ("all files" incl. dist/install shims).
- **122 of 582 src files below 70% line coverage.** Worst: `tmux-provider.ts` 12.5%,
  `child-pi-timers.ts` 12.7%, `post-exit-stdio-guard.ts` 12.8%, `parallel-research.ts` 12.9%,
  `herdr-provider.ts` 14.9%, `active-run-registry.ts` 15.5%, `runtime-resolver.ts` 16.9%,
  `direct-run.ts` 17.8%, `child-pi.ts` 17.9%, `async-notifier.ts` 21.2% (note: async-notifier is an
  R4-7 fix site), `worktree-manager.ts` 21.8%, `state-store.ts` 24.8%, `child-pi-spawn.ts` 25.5%,
  `process-status.ts` 31.4% (R5-4 fix site), `mailbox.ts` 31.9%.
- Caveat: this measures files LOADED by tests; never-loaded files don't appear (the true zero-test set
  is larger). 4 tests failed under instrumentation; isolated rerun **29/29 green** — confirmed
  coverage-mode flakes (timing-sensitive render/token-perf tests).

## Updated DR-02 backlog (rounds 4+5 merged)

| Pri | Item | Fix shape |
|---|---|---|
| P0 | R4-1 coalesced empty-settle (4th path) | parse pi-json / thread gate through runWorker |
| P0 | R4-3 workspace-lock heartbeat dead | periodic refresh or liveness-based staleness |
| P0 | R5-1 inbox ack-before-delivery | ack after send (mirror steer F-L2 compensation) |
| P0 | R5-2 batch-8 overflow | ack only the batch slice |
| P1 | R4-2 events.jsonl compaction race | design: dual-family lock or archive-style compaction |
| P1 | R4-4 needs_attention at finalize | policy decision before "completed" |
| P1 | R4-5 verify:true decorative | default allowManualEvidence:false or surface decorative |
| P1 | R4-6/7 unlocked tasks.json RMW ×2 | withRunLockSync + fresh reload |
| P1 | R5-3 browser manifest cache | clear on refreshData(true) / TTL / use entry.manifest |
| P1 | R5-4 blocked grace | add "blocked" to ERROR-grace branch |
| P1 | R5-5 compact-form error tail | failed-priority + important-line keep in applyHandoffBudget |
| P1 | R5-6 steer >4096 reject-drop | send-side clamp or truncate-with-marker like inbox |
| P2 | R5-7 CJK token est; B4 fail-closed; E1/E2 logInternalError; F3 keying; F4 rail; F5 countdown; G6; G7 marker note | small diffs |
| P3 | C1-C3, D5, D6 micro-hardening; coverage debt (122 files <70%) | ongoing |

Round metrics: 2 lanes (~35 files read at source), 13 findings (11 kept after lead verification,
2 self-downgraded by lane), 0 false positives surviving lead verification. Diminishing-returns check:
round 4 found 3 HIGH, round 5 found 2 HIGH → protocol says CONTINUE is still justified, but both lanes'
recommended next focus (prompt-builder assembly internals, run-dashboard deep-dive) overlaps DR-02 fix
surface — **recommend fix-first now (DR-02), audit round 6 after**.
