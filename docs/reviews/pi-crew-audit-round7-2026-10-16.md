# pi-crew Deep Audit — Round 7 (2026-10-16)

Lanes: **L** mailbox/interactive delivery · **M** recovery/heartbeat/process · **N** registration/team-tool/RPC · **O** UI render internals + tmux provider · **P** state stores/event-log/verification/scratchpad.
Protocol: 5 parallel read-only auditors, lead re-verified **all HIGH + MED at source** (quotes below) — 0 false positives this round. Exclusions DR-01..03 honored; P-1 explicitly reported as a *new instance* of the DR-02 R4-2 class at unfixed call sites.

**Totals: 2 HIGH · 13 MED · 20 LOW.** Test baseline at round start: 9352/9349/0 fail (DR-03 tip `d7b44195`).

## HIGH

### R7-1 (=M-1) `purgeStaleActiveRunIndex` step 6 false-cancels a LIVE dynamic-workflow foreground run
- `crash-recovery.ts:684-685`: `if (manifest?.status === "running" && manifest.async === undefined) { if (!hasRecentLifeEvidence(...))`.
- `hasRecentLifeEvidence` (:506-516) checks **only** `manifest.updatedAt` + `heartbeat.json` mtime (`heartbeatAgeMs` :484-491). heartbeat.json writers: `team-runner.ts` + `background-runner.ts` only (grep-verified). DWF foreground (`run.ts:390-420`) calls `runDynamicWorkflow` directly — never `executeTeamRun`; `dynamic-workflow-runner.ts` has **zero** heartbeat/manifest writes during execution (grep empty). `saveRunTasks` writes tasks.json only.
- Chain: DWF foreground subagent step >5min (`staleThresholdMs=300_000`) → manifest.updatedAt frozen → second pi session in same cwd → step 6 cancels all running/waiting tasks + flips manifest `cancelled` + `unregisterActiveRun` while worker B still runs → user `team resume`: registry entry gone, claim expired (5' lease, no renewal), no async pid → resume allowed → **double-dispatch of a live process**. Sibling `cancelOrphanedRuns` DOES check task heartbeat (:352-360 `hasRecentActivity`) — step 6 lacks it.
- Fix: add task-level heartbeat evidence to step-6 liveness (mirror :352) and/or DWF foreground heartbeat. Verified live at source by lead.

### R7-2 (=P-1) Inline compaction at 5 `appendEvent*` call sites lacks `.alock` + tail-merge — new instance of DR-02 R4-2 class
- `event-log.ts:1051-1052` & `:1144-1145` (sync family, inside `withEventLogLockSync` = `.mkdirlock` only):
  ```ts
  const prepared = prepareCompaction(eventsPath);
  if (prepared) applyCompactionUnlocked(eventsPath, prepared);
  ```
  Async-family inline sites `:645/:749/:857` same pattern.
- DR-02's fix landed ONLY in `compactPreparedEventLog` (`event-log-rotation.ts:242-256`): nested `withEventLogAppendLockSync` + `readTailSince` merge. `applyCompactionUnlocked` → `atomicWriteFile` = **temp+rename inode replacement** → any async-family appender parked in the open→appendFile gap (holds only `.alock`) writes to the orphaned inode — **silent event loss incl. terminal events** → crash-recovery sees "running" → double-execution. Reverse direction: async-family inline compaction doesn't block sync-family appenders (never take `.alock`) between `prepareCompaction` read and rename — bytes clobbered (no `readTailSince` at any inline site).
- Fix: route all 5 inline sites through an append-guarded apply (`.mkdirlock`→`.alock` order per R4-2 docblock; async sites already holding `.alock` must use a tail-merge-only variant — **deadlock-aware**: locks are non-reentrant).

## MEDIUM

| ID | File:line | Essence |
|---|---|---|
| R7-3 (L-1) | `mailbox.ts:1142-1170` | `updateMailboxMessageReply` scans only live files; rotation (`:402-423`) moves originals to `*.archive.jsonl`; reply metadata silently lost ("non-fatal" comment :1190) while readers DO walk archives (`safeReadMailboxFile` :337-347) |
| R7-4 (L-2) | `notification-router.ts:146-171` | `flush()` from setTimeout calls `deliver()` unwrapped → deliver-throw = uncaughtException + batch already cleared = loss (needs `batchWindowMs>0`, default 0) |
| R7-5 (L-3) | `team-tool-schema.ts:222` | `replyDeadline` write-only (grep: schema+writers only) — models act on a deadline nothing enforces; real enforcement is broker-clamped `task.waiting.deadline` |
| R7-6 (M-2) | `crash-recovery.ts:639,691` | under-lock revalidation checks only `status === "running"` — doesn't re-verify liveness inputs read pre-lock; resume-adoption race → false cancel + `terminateLiveAgentsForRun` |
| R7-7 (M-3) | `locks.ts:470-478` | sync-path steal: `canSteal` true when stale even if holder pid ALIVE; `withRunLockSync` has no socket dual-guard by design → mutual exclusion break if critical section >30s |
| R7-8 (M-5) | `checkpoint.ts:172` | `saveCheckpoint` 0 production callers; `status domain='checkpoint'` (dispatch/status.ts:203) always "No checkpoint found." — dead diagnostic feature (real checkpoints live in `task.checkpoint`) |
| R7-9 (N-1) | `cross-extension-rpc.ts:283-287` | `pi-crew:live-control` realtime channel bypasses the read-only `RPC_ALLOWED_OPERATIONS` policy the module declares (:49) — in-process extension can steer/stop live agents with no secret by default (soft-warn only, `rpc-hmac.ts:60-71`) |
| R7-10 (N-2) | `rpc-hmac.ts:90,104-125` | nonce decorative — no seen-cache; signed request replayable within 10-min window; secret also handed to child env (`env-allowlist-registry.ts:198`) |
| R7-11 (N-4) | `lifecycle-handlers.ts:675` | docblock promises broker stop on session_shutdown; grep: **0** call sites of `brokerController.stop()` → broker (socket+timers+tokens) leaks across `/reload` |
| R7-12 (O-1) | `render-scheduler.ts:118,163-166` | debounce re-arms on every `schedule()`; fallback loop explicitly refuses to render while "recent" events exist → sustained <75ms event streams (15-worker burst; render-loop.ts:473-501 bridges every bus event + fs.watch) starve ALL rendering during the exact burst users watch |
| R7-13 (O-2) | `tmux-provider.ts:150-158` | any `tmux list-panes` throw (EAGAIN/EMFILE under load) fires **permanent** `mux-dead` for every watched pane → degrade.ts revoke + headless re-dispatch while workers alive (dup-execution risk); no retry/reconnect |
| R7-14 (O-3) | `mailbox-compose-overlay.ts:249` | `data.length === 1` gate drops multi-char paste chunks (pi-tui delivers stdin chunk as one `data`); sibling `agent-view-overlay.ts:41-43` has correct `isPrintableInput` |
| R7-15 (P-2) | `active-run-registry.ts:336-341` | EPERM branch: comment "treat as alive", code `return false` **both** branches — live-but-protected pid (mixed-uid) dropped from registry → prune/duplicate-start risk |

## LOW (fixed-or-documented decisions in DR-04 spec)
- **Fixed**: M-4 stale-plan requeue filter (1-line, dormant), M-7 zombie report starttime pin, M-8 `lastDeadletterTriggerAt` leak, L-6 `stalledSince` no writer (compute from task heartbeat age), L-9 `validateMailbox` skips task mailboxes, N-3 channel-binding unused, N-5 pre-lock async pid kill, N-6 fire-and-forget registry install post-dispose, O-4 backspace splits surrogates, O-5 ad-hoc slice truncation ×3, O-6 openPane double-mount race, O-7 poll() stamps before resync, P-3 ledger parse poison, P-4 unbounded gate output accumulation, P-5 snapshot version unchecked.
- **Deferred (documented)**: L-4/L-5 dead task-id/handoff machinery (0 callers; entropy bug noted in-code when adopted), L-7 ask.timedout re-emit after restart (diagnostics noise), L-8 pickup ignores `priority` (≤1 tick), M-6 claim lease never renewed (decorative; G12 has 3 signals).

## Verified non-issues (highlights — full lists in lane reports)
Fanout miss-window/leak/per-subscriber isolation; U5 dedup; deadline units ms-consistent; webhook SSRF/HMAC/log-redaction; respond exactly-once under lock; zombie gates (kind+uid+ancestor); heartbeat false-death 3-layer protection; lock release pid+token; cancellation signal propagation; post-exit stdio guard real; frame-client no reconnect-storm by design; subagent ownership checks; chain handoff fields; parallel-dispatch allSettled; destructive gate enforced at tool_call; render-coalescer trailing-flush; ANSI-applied-after-diff; events cursor strict `>sinceSeq`; atomic-write fsync+rename full parity; seq sidecar gap-not-dup; rotation archive-tail drain; poison-marker idempotent; sqlite WAL+tx; artifact path containment; sandbox fail-closed; scratchpad nonce-stripped env; verify evidence host-executed (not worker-attested); decision-ledger 1-syscall append.

## Lane auditor reports
Full (a)-(d) detail with verbatim quotes preserved in the five explorer outputs (session `r7-audit` batch): L `agent_mvacfw86`, M `agent_mvacfw9h`, N `agent_mvacfwao`, O `agent_mvacfwbz`, P `agent_mvacfwd3`.
