# ADR — pi-durable wave (U22/U16/U21/U13-ADJ/U9-ADJ + D4), v0.11.19 (2026-10-13)

Status: implemented · shipped as `v0.11.19` (release commit `f10da4cc`, npm shasum `9df00839…`).
Research base: upstream pi-durable `a4d040d30` (8 research tiers + cold-verify, READ-ONLY).
SDD record: `sdd-pi-durable-2026-10-13/` (workspace) — SPEC + 6 đính chính, WORKITEMS W0–W31, GATES ~21 rows.
Battery: `docs/real-test/reports/real-test-2026-10-13-battery-live-session.md`.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | U21 admission giữ **WAIT/backoff** khi socket-held (deadline `staleMs*2`) thay vì steal | Steal một LIVE holder tạo dual-entry — nguy hiểm hơn chờ; RR-011 live WAIT preserved |
| D2 | U16 cost **2-tier song song**: `UsageState.cost: number` aggregate + parser chấp nhận object (`cost.total`) | SDK có session-level `cost: number` và message-level `cost: {…, total}` — giữ kiểu state ổn định, parser thống nhất 1 chỗ (`session-usage.ts`) |
| D3 (P3-type) | `dist/index.mjs` committed ở release commit | `check-bundle-staleness --committed-hash` (T11j) yêu cầu shipped bundle == fresh rebuild bit-for-bit; tradeoff git-noise cho verify-ability |
| D4 | pi-tui pin **peer floor+cap** (`>=1.0.4 <2.0.0`), dev exact `1.0.4` — KHÔNG exact-peer | Exact peer xung đột install với host pi 1.2.x tự ship pi-tui; floor chốt wire-format 7501, cap chặn 2.x breaking |
| D5 | `withRunLockSync` GIỮ file-only (không socket) | Sync path không thể `await listen`; mutual exclusion với async vẫn đảm bảo qua file lock. Deviation có chủ đích từ chữ "migrate" trong SPEC |
| D6 | Flag mới default: `PI_CREW_RUN_LOCK_SOCKET` **ON** (supplement, file-lock vẫn guard chính) · `PI_CREW_VERIFY_DETERMINISM` **OFF** · `PI_CREW_WORKER_ATOMIC_TIMEOUT_MS` 10000 | Socket = hardening thuần, an toàn bật mặc định; determinism layer-3 tốn rerun critical check — opt-in |

## Đính chính SPEC (6, đều leader-approved)

1. **P3 mode-only forward/always-fsync** — fsync theo mode của fd (forward), không ép thêm mode.
2. **EEXIST static assert** — test 2-process EEXIST thật không hermetic được → static assert trên spawn-args + 2-process test đã có chỗ khác.
3. **ENOTDIR/EEXIST hermetic sim** — mô phỏng qua fixture thay vì FS thật.
4. **gap-2 unconditional** — writeArtifact belt wrap vô điều kiện (không chỉ skip-path).
5. **dist commit** — xem D3.
6. **FIX-1.3 rotate+delete+re-parse** thay vì `generation` field — 3 lớp (rotate moves sidecar / compact deletes / re-parse guard) đạt same goal không thêm schema coupling.

## Marker LIFETIME RULE (U22 — bài học M1)

Poison marker chỉ hợp lệ cho **file instance** nó mô tả. Rotate phải MOVE sidecar theo archive; compact phải DELETE; mọi marker-hit được RE-PARSE 1 lần trước khi skip (dòng parse được = marker stale → prune). Tự chữa cả marker bẩn same-uid. Được 2 reviewer độc lập hội tụ tìm ra — 9k-test suite không bắt được → durability paths cần review round, unit xanh không đủ.

## Deploy windows

- **F2 uid-namespace (v0.11.19+ follow-up)**: `runLockSocketName` prefix uid → holder đang sống giữ tên cũ không bị code mới thấy trong transition. AN TOÀN vì file-lock là guard chính (socket = supplement). Sau transition, mọi holder dùng tên mới thống nhất.
- **Flag-off escapes**: `PI_CREW_RUN_LOCK_SOCKET=0` (pre-U21 bit-for-bit) · `PI_CREW_VERIFY_DETERMINISM` off (default).

## Known deferred

F2 whitelist-probe aspect · quota semantics + tasks-store model (DEFER by design) · m5 crew-broker.ts 1966/2000 (split khi đụng tiếp) · pre-diff cwd-oracle trust audit (0.11.12) — xem GATES row 23:55.
