# SPEC DR-01: Fix Deep-Review 2026-10-14 Findings

**Lane:** high-risk (P0 chạm completion semantics của task-runner) + tiny (M1/M3)
**Nguồn:** `docs/reviews/pi-crew-deep-review-2026-10-14.md` (đã verify 2 vòng)
**Workflow:** SDD — milestone → quality gates → evidence

## Goal

Eliminate false-green orchestration (P0) và dọn các finding đã verify (F2, F3, F5b, F8). Không publish, không bump version trong spec này.

## Milestone 1 — Doc/comment truth fixes (tiny)

### WI-1 (F3): Action count 54 → 57 — ✅ DONE
- [x] `src/schema/team-tool-schema.ts:77` — "54-action" → "57-action"
- [x] `src/extension/team-tool/dispatch/index.ts` — header 54/9/16 → 57/10/17 (+ run list thêm `plans`)
- [x] `test/unit/schema/team-tool-docs-sync.test.ts` — block DR-01 mới: tripwire 57 + numeric-claim gate + ACTION_TO_DOMAIN set-compare
- **Verify:** 6/6 pass ✓; node import = 57 ✓

### WI-2 (F2): crew-broker.ts header — ✅ DONE
- [x] Header rewrite: 12 methods dispatch table (grep so khớp switch), bỏ "PHASE 0/ONLY hello-ping/NO persistence/NO children", giữ invariants đúng, thêm history note
- **Verify:** 12 case = 12 method trong header ✓ (ping, hello, msg.send, msg.inbox, events.since, events.subscribe, task.waitStatus, steer.push, escalate, wait.request, wait.resolve, delegate.request)

## Milestone 2 — P0 false-green fix (high-risk)

### WI-3: Parser flag `settledWithoutAnswer` — ✅ DONE
- [x] `ParsedPiJsonOutput.settledWithoutAnswer?: boolean` + track last assistant message_end (isAssistantMessageEnd helper)
- [x] 5 test mới trong `test/unit/pi-json-output.test.ts` (empty-settle thật → true; healthy → false; no-assistant → undefined; whitespace-only → true; string-content)

### WI-4: `attemptErrorFor` bắt empty-settle — ✅ DONE
- [x] Nhánh mới sau 429-branch: `!err && !cancelled && settledWithoutAnswer === true && patches rỗng` → error retryable (message chứa rate-limit/429/upstream keywords — match RETRYABLE_MODEL_FAILURE_PATTERNS)
- [x] 5 test mới trong assemble-attempt-outcome + 3 test end-to-end trong rate-limit-429-detection (dùng transcript shape thật từ run team_20261014082741, kèm counterfactual pin pre-fix)
- **Verify:** 39/39 targeted ✓; test:critical ✓; full unit 9165 pass/0 fail ✓

### WI-5 (decision — GHI NHẬN, không đổi code): Guard default giữ "warn"
Detection-first: predicate mới là fix chính. P0.1 escalation (warn→blocked với role mutating) đã tồn tại; đổi default sang "fail" có thể false-fail các pattern hợp lệ chưa biết — defer đến khi có data. Ghi vào review report.

## Milestone 3 — Tooling & housekeeping (normal)

### WI-6 (F5b): Coverage script — ✅ DONE
- [x] `test:coverage` trong package.json (node --import tsx/esm --test --experimental-test-coverage, mirror flags test:unit). KHÔNG thêm vào `ci`
- **Verify:** chạy trên docs-sync test: 99.52% lines / 84.48% branch / 94.12% funcs, exit 0 ✓

### WI-7 (F8): Archive 487 perf-reports — ✅ DONE (kèm correction)
- [x] Reference check: code chỉ reference `docs/perf/perf-report-*` (vị trí MỚI — analyze-run.mjs:1021 "Legacy location was docs/ top level"); KHÔNG có gì đọc legacy files
- [x] **Correction:** 487 files là local debris đã gitignore (`.gitignore:52`), không nằm trong repo → dùng `mv` (không git mv) vào `docs/archive/perf-report-team_/` (dir đã được ignore sẵn theo `.gitignore:60`)
- **Verify:** docs/ root còn 0 file; git status sạch (9 M + 2 ?? là src/test/docs của spec này) ✓

## Milestone 4 — P0 completeness (vòng review tiếp tục, 2026-10-14 chiều)

> Review tiếp phát hiện fix P0 ban đầu CHƯA phủ hết execution paths: chỉ task-runner attempt loop được fix.

### WI-8 (RPC transport): empty-settle stamp — ✅ DONE
- [x] Phát hiện: RPC (`PI_CREW_WORKER_TRANSPORT=rpc`, experimental) KHÔNG có transcript file ("stdio-only" README) → `attemptErrorFor` không thấy → vẫn false-green
- [x] Fix `rpc-worker.ts`: SettleTracking thêm `sawAssistantMessageEnd` + `lastAssistantMessageEndHadText`; stamp cùng error retryable tại result assembly (gate: !error && settled && sawAssistant && empty && !aborted); `rpcAgentStarted` giữ `isEarlyRpcTransportFailure` không fallback stdio sai
- [x] 3 test mới (fake RPC server harness): empty-settle → error retryable; healthy → no error; aborted → không stamp

### WI-9 (DWF ctx.agent): widened gate — ✅ DONE
- [x] Phát hiện: `dynamic-workflow-context.ts` gọi `runWorker` TRỰC TIẾP (bypass attempt loop), gate chỉ `exitCode !== 0 || childResult.error` → 429-empty-settle exit 0 lọt qua, `rawFinalText` (câu mở đầu) thành result → false-green DWF step
- [x] Fix: parse stdout TRƯỚC gate, thêm điều kiện `parsed.settledWithoutAnswer === true` → ok:false + cùng error message; BDG-2 un-reserve giữ nguyên
- [x] Mock seam mới `json-429-empty-settle` trong mock-fixtures.ts (phản ánh đúng shape run thật)
- [x] 2 test mới (mock env, ctx.agent thật): empty-settle → ok:false match /settled without a final answer/; healthy (json-success) → ok:true
- **Verify vòng này:** rpc+goal-workflow suites 118/118 ✓; typecheck ✓; test:critical 120/120 ✓ (1 flake heartbeat-pulse isolated ×2 xanh — đúng procedure knowledge); full unit **9186/9183 pass/0 fail** ✓; ci:fast format/lint/staleness/bundle ✓; dist rebuilt ✓

## Global Quality Gates (chạy cuối) — ✅ ALL GREEN (2026-10-14)
- [x] `npm run typecheck` xanh ✓
- [x] `npm run lint` + `npm run format:check` xanh ✓ (biome auto-fix 3 file test sau round 1)
- [x] `npm run test:critical` xanh ✓ (trong ci:fast)
- [x] `npm run test:unit` xanh: **9168 tests / 9165 pass / 0 fail / 3 skip (pre-existing)** ✓
- [x] `npm run build:bundle` + `check:bundle-staleness` + `test:bundle` + `check:bundle-size` xanh ✓
- [x] `ci:fast` full pass (16 gates gồm lockfile-sync, decision-drift, env-vars, event-types, lazy-imports, wc-gate, pack dry-run) ✓
- [x] Update `docs/reviews/pi-crew-deep-review-2026-10-14.md` — status từng finding

## Out of scope (deferred, documented)
- F7 dep pinning (observation) — cần CI data trước
- Split crew-broker.ts / action-surface consolidation — chờ usage metrics
- Integration suite (`test:integration`) — chạy riêng nếu cần, unit đã cover pure functions
