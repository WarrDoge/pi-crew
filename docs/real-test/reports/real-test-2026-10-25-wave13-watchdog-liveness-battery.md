# Wave 13 battery — watchdog liveness (F1–F4) @ `c779aafd`

Gate trước bump v0.11.41. Repo `pi-crew` HEAD `c779aafd` (wave 13 = `e880348b` + `c779aafd`), tree sạch toàn bộ battery. Chỉ test/verify — không sửa code, không commit.

## Môi trường
- Node v22.23.1, npm 10.9.8, 4 core, up 5d. Load: 1.40 lúc bắt đầu → 3.16 kết thúc (peak 6.x trong lúc suite chạy; 4 process durable-pi/tuistory ambient từ 23/10 vẫn chạy, không đụng).
- Env scrub `PI_CREW_*`/`PI_TEAMS_*`/`PI_CODING_AGENT` cho MỌI lệnh test (knowledge lesson #2).

## Bảng pin

| Pin | Nội dung | Kết quả |
|---|---|---|
| 0 | `git log`/`status` | HEAD `c779aafd`, tree sạch ✅ |
| 1 | targeted ×3 (3 file) | **9/9 run exit 0** ✅ |
| 2 | LIVE REPRO watchdog | **PASS** — 0 alert "appears hung", watchdog suppress ×5 ✅ |
| 3 | test:critical | 124/124 pass, exit 0 ✅ |
| 4 | test:unit (full) | 10065 tests / 10061 pass / **0 fail** / 4 skipped, exit 0 ✅ |
| 5 | test:integration | # tests 148 / # pass 144 / # fail 0 / # skipped 4 exit 0 ✅ |
| 6 | static | typecheck 0 · lint 0 · format:check 0 · slop 41=41 clean · lazy-imports 0 · wc-gate 0 ✅ |
| 7 | dist staleness | exit 0 MATCH — dist/index.mjs 1,891,617 B committed = fresh ✅ |
| 8 | leak sweep cuối | RỖNG (0 process) ✅ |

## Pin 1 — targeted ×3
- `foreground-watchdog.test.ts`: 29/29 ×3 (gồm w1–w5 wave-13: registry claim, heartbeat, ladder regression w3, claimed-threshold w4, `as of` w5, WD-INTERVAL).
- `live-executor-heartbeat.test.ts`: 5/5 ×3 (t1/t1b/t2/t2b/t3).
- `subagent-steer-live.test.ts`: 4/4 ×3. `pgrep` sau mỗi run: RỖNG (2 hit đầu là self-match của chính shell pgrep — chứa chuỗi pattern trong cmdline; kiểm lại bằng pattern ghép-chuỗi ⇒ thật sự rỗng).

## Pin 2 — LIVE REPRO (điểm chính) — Cách B (real headless run)
- **Cách A không fit**: `test/integration/background-runner-watchdog-e2e.test.ts` + `scripts/watchdog-harness.ts` test **force-abort path** (MAX_RUN_MS kill) chứ không phải hung-alert path ⇒ dùng Cách B theo SPEC §4.
- Recipe: `env -u PI_CREW/PI_TEAMS/PI_CODING_AGENT* PI_CREW_WATCHDOG_INTERVAL_MS=20000 PI_CREW_DEBUG=1 pi -ne -e <repo>/dist/index.mjs --no-context-files --no-mcp --session-dir /tmp/w13repro/sessions -p "<dispatch 1 executor task: bash sleep 400, sync>"`, cwd `/tmp/w13repro` (dist mới F1+F2+F3).
- Kết quả: **exit 0, 539s**. Run `team_20261025051133_0814f2700cb3fe64` → **completed**.
- **Bằng chứng watchdog sống + verdict bị chặn đúng chỗ**: debug log `[foreground-watchdog] suppress hung verdict for team_20261025051133_0814f2700cb3fe64: fresh task heartbeat` × **5** — đúng số học: activity shield hết ~t+305s, chu kỳ 20s ⇒ pre-fix alert sẽ nổ ở ~320/340/360/380/400s; post-fix F2 heartbeat (30s tick trong tool) + F1 short-circuit dìm cả 5 chu kỳ. Non-vacuous.
- **Quét không-alert**: "appears hung" = **0** trong (a) session jsonl `/tmp/w13repro/sessions/*.jsonl`, (b) toàn bộ run state user-root `~/.pi/agent/extensions/pi-crew/state/runs/team_20261025051133_*/` + `artifacts/` + `health/`, (c) stdout pi, (d) scratch `/tmp/w13repro` đệ quy.
- Control dương (vẫn bắt hang thật): unit w3 (no claim + stale heartbeat ⇒ ladder vẫn alert) + w4 (claim cũ >45' ⇒ alert + named threshold) — xanh ×3 ở Pin 1.
- **Contrast cũ-mới (bonus)**: chính session pi của verifier (dist 0.11.40, chưa fix) đang chạy battery này đã phát **2 alert "appears hung"** vào events.jsonl của run `team_20261025050347_*` trong lúc các lệnh battery dài chạy — đúng hành vi cũ mà wave 13 sửa; ghi nhận làm bằng chứng tương phản, không tính fail.

## Pin 3/4/5
- critical: `# tests 124 # pass 124 # fail 0` exit 0.
- unit: `# tests 10065 # suites 986 # pass 10061 # fail 0 # cancelled 0 # skipped 4`, exit 0, 12:33:17→12:43:06 (~9m49s). **0 flake** (baseline cho phép ≤4: redaction-prefilter/redaction-redos/resource-sampler-audit/event-log-inline-compaction-guard/implementation-fanout/token-counter/scheduler-inflight-guard — không cái nào đỏ). Không cần adjudication.
  - Ghi chú infra: lần chạy foreground đầu bị SIGKILL (exit 137) ở ~test 6057 — tool-call ceiling ~600s của verifier runtime, KHÔNG phải test fail; chạy lại detached (setsid supervisor) hoàn chỉnh exit 0.
- integration: exit 0 (145s) — # tests 148 / # pass 144 / # fail 0 / # skipped 4.

## Pin 6/7
- typecheck exit 0 ("strip-types import ok"); lint exit 0; format:check exit 0.
- slop: `no-double-cast baseline 41, current 41 (burn-down ok)` — clean, 1762 files.
- lazy-imports: 537/537 value-import graph, 0 hoisted heavy externals, declared-deps ok.
- wc-gate: `npm run check:wc-gate` exit 0 (lần đầu gõ `npm run wc-gate` sai tên script — không tồn tại; tên đúng là `check:wc-gate`).
- staleness: `node scripts/check-bundle-staleness.mjs --committed-hash` exit 0 — committed dist = fresh build, 1,891,617 B (log có 2 dòng `fatal: dist/index.mjs.map / build-meta.json does not exist in HEAD` — benign, gate vẫn MATCH).

## Pin 8 — sweep cuối
`pgrep -af "steer-live|setInterval|proc-tree-leader|test-runner.mjs"`: RỖNG (0 process). Supervisor detached đã thoát. tmp-sweep của runner: removed=23 (pre-existing debris cũ, skipped=538).

## Verdict: **PASS**

Mọi pin xanh, 0 fail ngoài baseline (không cần adjudication), live repro chứng minh được fix hoạt động end-to-end trên dist thật với bằng chừng không-vacuous (suppress ×5). Sẵn sàng bump v0.11.41.
