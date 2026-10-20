# Real-test battery — wave 7 (residual quality wave), 2026-10-20

Base: v0.11.27 (`98f3ce84`) → wave 7 uncommitted at probe time, bundle `e3a16da1dba20cc54e4ad28fd7c1b3c0`.

## Decision table mapping
Đổi: `src/state/**` (artifact-store, state-store), `src/runtime/**` (scheduler, dwf-state-store, dynamic-workflow-runner, pi-spawn, broker tests), `src/ui/**` (theme-adapter), `dist/`.
→ Tier yêu cầu: T1 · T3 · T4/T8 · T7 · T11j (sau commit). Broker/child-pi/surface/prompt core KHÔNG đụng (chỉ test files), schema/registration/agents không đụng → T2/T5/T6/T9/T10/T12/T13 không bắt buộc.

## Kết quả

| Tier | Kết quả | Bằng chứng |
|---|---|---|
| T1 critical | ✅ | 124/124 exit 0 |
| T3 build+md5+staleness | ✅ | exit 0, md5 `e3a16da1…` |
| T4/T8 session-sync | ✅ (functional proof) | C2 silence CHỈ tồn tại trong bundle mới; probe session in **0** dòng `prune-anchor` (bundle cũ sẽ warn) — session chắc chắn serve `e3a16da1` |
| T7 smoke run | ✅ | `team_20261020060204_d9638bf817e793dc`: 3/3, verifier **PASS** (byte-level BANANA check), 3902 tok, consistency=1; `task.usage` YES ×3 |
| T11j committed-hash | ✅ (sau commit) | xem GATES-LOG |
| Meta-gates | ✅ | unit 9820/0 fail · integration 143/0 · lazy 532→OK · env 551 files OK · wc-gate OK |

## Probes riêng cho các fix

1. **C2 prune-anchor ENOENT silence (live-proven)**: xóa `.crew/artifacts/<runId>` của run vừa xong (giả lập age-cleanup) → session start mới: `grep -c prune-anchor` = **0** (trước fix: 1 warn/run stale/session). Fail-closed giữ nguyên (không xóa gì).
2. **C1 usage-null (đóng: không phải bug)**: live repro 2 run (`team_20261020043946`, `team_20261020060204`): text output hiển thị tokens đúng (4155/3902), `task.usage` có input/output/cacheRead/cost. Không code đọc `manifest.usage`. Observation #3 của battery 10-19 đã đính chính trong report đó.
3. **B-flakes**: mỗi test hardened chạy isolated xanh (embedded-tier 18/18 ×2, stale-ctx 4/4, round24 5/5, wait-auth 5/5, rpc-mode 0 fail, append-lock 8/8, inline-guard 7/7). Điểm chung: poll-the-condition thay fixed sleep; adaptive control-fs-op bound cap dưới ngưỡng deadlock thật.
4. **A-low-tail**: wave7-low-tail.test.ts 5/5 (R14-C4 post-arm added payload past+future, R2-L-A1 ENOENT→undefined sync+async, R14-C3 DwfStore roundtrip additive/legacy); theme-adapter-weakref-poll 1 pass + 1 GC-gated SKIP (V8 trong node:test không collect được abandoned theme — đã chứng minh collect được ở REPL riêng; skip-guard tránh đỏ oan).

## Findings
Không regression. 1 phát hiện quy trình: **record findings LOW-table stale** — 8/31 mục (A3/A5/A8/A9/B2/B3/B4/B6) đã có marker fixed từ wave-2b/6 trong src nhưng record chưa đánh dấu; wave 7 đã cập nhật record.

## Verdict
Battery đầy đủ theo decision table cho surface thay đổi. Wave 7 đóng: 1 observation đính chính (không bug), 1 noise fix live-proven, 6 flake classes hardened, 6 LOW items fixed + 8 đánh dấu đã-fix-từ-trước.
