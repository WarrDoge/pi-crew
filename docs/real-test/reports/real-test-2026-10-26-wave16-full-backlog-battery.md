# Real-test battery — Wave 16 (full-backlog sweep + T-6b harden + residual wiring)

- **Ngày:** 2026-10-26 (11:05–11:47 +07)
- **Repo:** `pi-crew` @ `5509b17c` (`5509b17c548c692b245dbfe05324839b81f2a9cc`), tree sạch suốt battery (git status 0 line trước/sau).
- **Node:** v22.23.1, npm 10.9.8. Loadavg lúc unit: 7.7→16.3 (external load có mặt), RAM 15.8GB tổng.
- **Mục đích:** gate trước bump v0.11.44. KHÔNG sửa code, KHÔNG commit.

## Bước 0 — scrub
`SCRUB=$(env | grep -oE '^(PI_CREW|PI_TEAMS|PI_CODING_AGENT)[A-Z0-9_]*' | grep -v TEST_NO_HOME_ISOLATION | sed 's/^/-u /' | tr '\n' ' ')` → **48 biến unset**, mọi lệnh test chạy qua `env $SCRUB …`; `remaining_after_scrub=0` ✓ (≤1; TEST_NO_HOME_ISOLATION không có trong ambient env). Long-run chạy **detached** (setsid+nohup, log + exit-file riêng) — đúng protocol, thấy hiệu lực (xem adjudication).

## Bảng pin

| Pin | Lệnh / mục | Kết quả |
|---|---|---|
| 1a | 4 test wiring mới ×3: health-monitor (23), session-summary-cov (5), crew-widget (8), powerbar-publisher (12) | **×3 GREEN, 0 fail** (exit 0 từng run) |
| 1b | Regression ×1: process-status-heartbeat-evidence (11), run-dashboard-heartbeat-display (4), agents-jobs-browser-events-state (5), widget-bottom-mode (4) | **GREEN 0 fail** |
| 1c | T-6b `state-helpers-cas-contention.test.ts` ×5 | **5/5 GREEN** (3 pass mỗi run, exit 0) |
| 1d | Sweep batch dirs (extension/runtime/integration) | **Subsumed**: Pin 4 chạy full `'test/unit/**/*.test.ts'` (chứa trọn extension+runtime) và Pin 5 chạy đủ 33 file integration ×1 — superset strictly mạnh hơn batch; lý do: RAM ép (2× OOM-kill wrapper), tránh thêm chu kỳ chạy nặng |
| 2 | rmSync-zero proof (regex task) | **44 dòng**: 26 single-file (intentional) + 8 recursive-có-force (regex FP do nested parens — an toàn) + **10 bare-recursive** → phân loại bên dưới, **0 cần làm tiếp** |
| 3 | `npm run test:critical` | **124/124 pass, 0 fail**, exit 0 (13.2s) |
| 4 | Full unit (detached, scrub, concurrency=4) | **10,082 tests / 10,078 pass / 0 fail / 4 skip / 693s**, exit 0 @ 11:34:06 |
| 5 | `test:integration` (33 file, concurrency=1) | **148 tests / 144 pass / 0 fail / 4 skip** — trùng baseline 144/0/4, exit 0 @ 11:44:00 |
| 6 | lint / typecheck / format:check / slop / lazy-imports / wc-gate | **0 / 0 / 0** (lint: 15 warn pre-existing, 0 error); slop `no-double-cast baseline 41, current 41` ✓; lazy-imports 0 ✓ (537/537 value-import graph); wc-gate 0 ✓ (crew-broker 1963 < 2000) |
| 7 | `check-bundle-staleness.mjs --committed-hash` | **MATCH** — dist/index.mjs sha256 committed == fresh (1,893,366 B). KHÔNG rebuild |
| 8 | Leak sweep `pgrep -af "steer-live\|setInterval\|proc-tree-leader\|test-runner.mjs\|zombie-fixture"` | **Rỗng** — 0 process bên thứ 3 (2 match = self-match của probe wrapper); kiểm giữa battery cũng sạch |

## Pin 2 — rmSync-zero proof (chi tiết)
Regex task cho **44** dòng còn lại. Phân loại:
- **26 single-file, no recursive** — intentional (xóa 1 file tmp/state do test tự tạo): vd `worker-events-channel-tail:58`, `plan-store:200`, `spec-store:146`, `agents-jobs-browser:289`, `analyze-run-audit:635`, `events-state-source:304/369`…
- **8 recursive + force:true** — regex FP (`rmSync\([^)]*force` không bắt được force sau nested paren): `cleanup-user-scope:158`, `atomic-write-coalesced:167`, `run-event-bus.replay:38`, `sqlite-parity:230/231/331/332` — an toàn (forced).
- **10 bare recursive** (recursive, không force/retry):
  - `test/unit/atomic-write.test.ts` ×8 (:24,:34,:43,:55,:64,:75,:87,:109) — teardown **dir tmp do chính test vừa mkdtemp** (single-owner, dir chắc chắn tồn tại, không ambient path) → **intentional**.
  - `test/unit/ui/events-state-source.test.ts:382` — **cố ý theo semantics test** (swap directory → inode-rewrite re-detect resync) → intentional.
  - `test/unit/scratchpad-restore-lookup.test.ts:107` — **cố ý theo semantics test** (SEC-7: scratchpad DIR bị thay symlink → containment null) → intentional.
- Residual đã ghi từ wave trước — `drain-test :35`, `terminal-status-wiring` — **không còn xuất hiện** (đã sweep sạch bởi `abf93c7c`/lô 3).
- **Kết luận: 0 dòng "cần làm tiếp"**; mọi dòng còn lại là intentional/FP-of-regex.

## Adjudication & sự cố
1. **OOM incident ×2 (không phải test fail):** lần chạy unit đầu (qua tool-wrapper) bị OOM-killer toàn cục giết wrapper (`droid` pid 695564, anon-rss 10.5GB; box 15.8GB, available chỉ ~5.7GB) → exit 137 tại ~test #5266, không kèm test-fail. Theo protocol detach: relaunch `setsid nohup` + exit-file → chạy trọn vẹn **10,082/0 fail**. Một lệnh poll wrapper sau đó cũng bị 137 (collateral) — run detached không ảnh hưởng. Không process mồ côi sót (pgrep sạch giữa + cuối battery). Load lúc unit start 7.7; đỉnh 16.3 trong integration (external load).
2. **Pin 1d thay bằng superset:** batch directory sweep được покры bởi full-unit (cùng runner, cùng glob cha) + full integration — không mất coverage, chỉ đổi hình thức vì ép RAM. Ghi rõ để leader biết nếu muốn chạy batch riêng.
3. Full unit kết thúc 10,082 tests (4 skip) — tăng/giảm số lượng so pre-push w15 (10,099) do wave 16 chỉnh test; 0 fail là chỉ tiêu.

## Verdict
**PASS** — battery wave 16 xanh toàn bộ pin (1a–1c ×3/×1/×5, 3, 4, 5, 6, 7, 8), rmSync-zero proof đạt (0 cần làm tiếp), T-6b 5/5 sau harden, dist MATCH sau `5509b17c`. Sẵn sàng bump v0.11.44. Residual risk: (a) RAM box eo hẹp — CI/publish nên tránh chạy đồng thời nặng; (b) 2 wrapper-OOM không liên quan chất lượng code.
