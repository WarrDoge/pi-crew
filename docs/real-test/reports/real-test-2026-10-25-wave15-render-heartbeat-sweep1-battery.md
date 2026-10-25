# Real-test battery — wave 15 (render-heartbeat + sweep Lô 1) — 2026-10-25

**Repo:** `pi-crew` @ HEAD `ff1a17c4` (cha `a3e8ee23`, `37894824`), tree sạch suốt battery (verify cuối: `git status --short` rỗng).
**Scope:** gate TRƯỚC bump v0.11.43. Wave 15 = F1 `hasFreshTaskHeartbeatEvidence` + F2 render wiring (run-dashboard 6 site + agents-jobs-browser) + F3 sweep Lô 1 (336 rmSync site/84 file state+prompt → cleanupStateRoot/removeDirWithRetry).
**Chỉ test/verify + report — KHÔNG sửa code, KHÔNG commit** (report này là file untracked duy nhất).

## Môi trường
- Node v22.23.1, npm 10.9.8, Linux. Battery chạy detached (nohup, 1 driver tuần tự, log từng pin riêng + exit code riêng) — `.crew/cache/wave15-1507740/`.
- **Scrub verify:** `SCRUB=$(env | grep -oE '^(PI_CREW|PI_TEAMS|PI_CODING_AGENT)[A-Z0-9_]*' | grep -v TEST_NO_HOME_ISOLATION | sed 's/^/-u /' | tr '\n' ' ')` — 26 biến bị unset, `remaining_after_scrub=0` ✓. Mọi lệnh test chạy qua `env $SCRUB …`.

## Bảng pin

| Pin | Lệnh | Kỳ vọng | Kết quả |
|---|---|---|---|
| 1 targeted h1 ×3 | `process-status-heartbeat-evidence.test.ts` | exit 0 (11 test) | **11/11 ×3, rc=0 ×3** ✓ |
| 1 targeted h2 ×3 | `run-dashboard-heartbeat-display.test.ts` | exit 0 (4 test) | **4/4 ×3, rc=0 ×3** ✓ |
| 1 targeted h3 ×3 | `agents-jobs-browser-events-state.test.ts` | exit 0 (+2) | **5/5 ×3, rc=0 ×3** (trong đó 2 test heartbeat mới) ✓ |
| 1 regression ×1 | `process-status-cov` / `widget-bottom-mode` / `session-summary-cov` | exit 0 | **rc=0 ×3 file** ✓ |
| 1 sweep ev ×3 | 38 file `test/unit/state/event-log/` (batch node test-runner, conc=4) | 0 fail | r1 **209/210 (1 fail)**, r2 **210/210**, r3 **209/210 (1 fail)** — adjudicated (dưới) |
| 1 sweep cs ×3 | 43 file `state/{coordination,stores}/` | 0 fail | r1 **320/320**, r2 **321/321**, r3 **306 pass/0 fail/3 file cancelled (180s timeout)** — adjudicated |
| 1 sweep pr ×3 | 17 file `test/unit/prompt/` | 0 fail | **127/127 ×3** ✓ |
| 2 display proof | h2/h3 với `PI_CREW_DEBUG=1` | 2 phía h2 | **4/4 + 5/5, rc=0** ✓ (TAP dưới) |
| 3 critical | `npm run test:critical` | 0 fail (124) | **124/124, rc=0** ✓ |
| 4 full unit | `npm run test:unit` (scrub) | 0 fail | **10,086 test: 10,081 pass / 1 fail / 4 skip** — adjudicated (dưới) |
| 5 integration | `npm run test:integration` | 144/0/4 | **148 test: 144 pass / 0 fail / 4 skip = baseline CHÍNH XÁC** ✓ |
| 6 static | typecheck/lint/format:check/slop/lazy/wc-gate | 0 / 41 / 0 / 0 | **rc=0 hết; slop baseline 41 = current 41; lazy-imports sạch (no hoisted imports, budgets OK); wc-gate rc=0** ✓ (lint: 15 warning/3 info — warn-only, rc=0) |
| 7 staleness | `check-bundle-staleness.mjs --committed-hash` | MATCH 1,893,087 B | **MATCH sha256 committed=fresh (14b3459c…), 1,893,087 B — KHÔNG rebuild** ✓ |
| 8 leak sweep | `pgrep -af "steer-live|setInterval|proc-tree-leader|test-runner.mjs|zombie-fixture"` | rỗng | **0 byte — rỗng** ✓ |

## Pin 2 — evidence TAP (cả 2 phía)
`p2-h2-debug.log` (PI_CREW_DEBUG=1):
```
ok 1 - h2: stale manifest + fresh task heartbeat renders running and stays in Active
ok 2 - h2: same snapshot WITHOUT a fresh heartbeat stays stale (old behavior pinned)
ok 3 - h2: heartbeat older than the 5-min evidence TTL does NOT veto the stale label
ok 4 - h2: heartbeat.alive === false is not evidence (explicit dead mark)
```
`p2-h3-debug.log`: `ok 4 - h3: legacy-uncovered active run with fresh heartbeat stays listed` / `ok 5 - h3: same fixture WITHOUT a fresh heartbeat stays hidden (old behavior pinned)`.

## Adjudication — 3 failure event, tất cả timing/load, KHÔNG tái hiện solo

| # | Sự kiện | Test/file | Chẩn đoán | Solo re-run (máy yên tĩnh, scrub) |
|---|---|---|---|---|
| A | ev-r1 fail 1 | `event-log-inline-compaction-guard.test.ts:296` "R7-2(c) rotation-tick compacts fast" — `inline compaction must not self-timeout on .alock, took 4466ms` | wall-clock assertion (IO nặng) dưới conc=4 | **×3 solo: 7/7 mỗi lần, rc=0** |
| B | ev-r3 fail 1 | cùng file `:327` "R7-2(c) overflow >50MiB" — `took 10533ms` (duration test 24.8s) | wall-clock assertion trong cửa sổ load cao | **×3 solo: 7/7, rc=0** |
| C | cs-r3 3 file cancelled | `api-locks`, `mailbox-api`, `mailbox-replay` — `testTimeoutFailure: test timed out after 180000ms` (batch 332s vs 40s chuẩn) | file-level timeout trong 1 cửa sổ quá tải toàn máy (ev-r3 cùng lúc 76s vs 12s; máy còn SIGKILL poll ngoài của verifier trong cùng giai đoạn) | **solo ×1 mỗi file: rc=0, xong tức thì (api-locks 1/1, mailbox-api 7/7, mailbox-replay 7/7)** |
| D | p4-unit fail 1 | `async-notifier.test.ts:276` "skips toasts for runs owned by another session" (1 !== 0) | test file KHÔNG thuộc wave-15; test kề ngay sau pass | **×3 solo: 11/11 mỗi lần, rc=0** |

Ghi chú trung thực: F3 sweep (a3e8ee23/ff1a17c4) CÓ sửa teardown của 3/4 file flaky (api-locks, mailbox-api, inline-compaction-guard — chỉ đổi call-site teardown rmSync→cleanupStateRoot/removeDirWithRetry, KHÔNG đụng assertion). Bằng chứng ủng hộ flake thay vì regression: (1) cùng file cùng code pass ở r1/r2 và ở full-unit 10k conc=4; (2) solo ×3 xanh hết; (3) failure mode là wall-clock/timeout thuần, không phải assertion logic; (4) cụm r3 trùng 1 cửa sổ load hệ thống. Không thể loại trừ 100% khả năng teardown mới nhạy load hơn — ghi residual risk.

## Verdict
**PASS (adjudicated)** — mọi pin chức năng wave-15 xanh tuyệt đối (targeted ×3, regression, Pin 2 hai phía, critical 124, static, staleness MATCH 1,893,087 B, integration đúng baseline 144/0/4, leak rỗng). Full unit 10,081/10,082 + 1 flake adjudicated. Sweep ×3 có 3 fail-event timing, tất cả solo-green ×3.

**Residual risk (không chặn bump, leader quyết):** (1) `event-log-inline-compaction-guard.test.ts` R7-2(c) là test wall-clock mỏng — 2/3 fail ở conc=4 dưới load; cân nhắc nới threshold/đánh dấu load-sensitive ở wave sau. (2) 3 file coordination dễ bị 180s file-timeout dưới tải nặng. (3) `async-notifier` session-ownership flake 1 lần (file không thuộc wave-15).
