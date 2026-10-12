# Real-Test Full Battery — 2026-10-12 (HEAD `926b95ec`, 9-commit stack)

Run by: leader trực tiếp trong live Pi session (per user request — không qua subagent).
Skill: `real-test-pi-crew` (đọc toàn bộ trước khi chạy). Env: mọi gate `PI_CREW_*/PI_TEAMS_*`
scrubbed (SCRUB list). Stack under test: `468fe609` (test-leak fix) → `4cd4618a` (U12 doc) →
`3451a3a3` (Δ2 AST gate) → `1d3ed582` (b14 bench) → `862b943c` (U11 hybrid worker) →
`3ed40b5b` (Δ3 b15 bench) → `a56129ec` (hosted-git-info drop) → `926b95ec` (skill update).

## Verdict

| Tier | Chứng minh | Verdict | Evidence chính |
|---|---|---|---|
| T1 | critical suites | **PASS** | 120/120, 0 cancelled, 18s |
| T2 | kill-switch 3 đường | **PASS** | default / `PI_CREW_BROKER=0` / `=1` — mỗi đường 120/120 |
| T3 | typecheck + bundle + md5 | **PASS** | tsc 0 · bundle idempotent `472cb93254c69f7302b99e47269e02ea` (1717.5 KB) · staleness OK (path-leak scan qua) |
| T4 | bundle sync live session | **PASS (2 nửa)** | Mọi pi process chạy (Oct 8–11) đều start trước rebuild → session đang mở (kể cả của leader) = stale như dự kiến, chỉ user restart được. Session FRESH (tmux 09:35 hôm nay) behavior-probe key mới: `/team-settings get runtime.embeddedWorkers` → `<not set>` (không còn "Unexpected property" — signature stale-bundle đã quotient trong knowledge) |
| T5 | tmux TUI probe | **PASS** | fresh pi trong tmux `/tmp/rtb-sock`; `/team-help` render; arrow keys `\x1bOA`/`\x1bOB` sống; crashes.json KHÔNG entry mới (mtime Oct 8) |
| T6 | pty bulk keys | **PASS** | `scripts/pty_probe.py --keys 'j,j,k,\x1bOA,\x1bOB,q,q'` exit 0, render status line đúng, quit sạch không zombie |
| T7 | smoke run (verifier không treo) | **PASS** | run `team_20261012023749_f076f566387b7f74` (fast-fix, sync, fresh `pi -ne --extension dist/index.mjs` từ scratch git dir): **completed 3/3 trong 178s**, verifier_pre_gate chạy, goal_achievement OK |
| T8 | md5 disk↔session | **PASS** | disk `472cb932…` = idempotent rebuild; fresh sessions (T5/T7) cold-start đúng bundle mới (behavior-probe ở T4) |
| T9a | read-only batch (13 actions) | **PASS 13/13** | list/health/doctor/recommend/status/summary/events/get/explain/worktrees/graph/search/settings — tất cả structured, không "Unknown type"/"Validation failed". Doctor: 2 zombie PID 418727/418728 (stray watchers hôm qua, report-only, đúng thiết kế) |
| T9b | spawn paths | **PASS 4/4** | sync (=T7) · **async**: run `team_20261012025435_f28764e178e7a565` completed, `async.spawned` pid 1177518 detached thật, **inline=0** (không seam leak) · **chain** (omit workflow — quirk #44): 2 steps/2 handoffs cả hai success (`team_20261012030844` + `team_20261012031100`) · **Agent** direct: explorer trả lời đúng |
| T9c–9f / 9b-W | lifecycle/destructive/admin/background/worker-tools | **SKIPPED — not required** | Không thay đổi `src/schema/`, team-tool handlers, `src/prompt/**`, lifecycle trong stack này (decision-table scoping) |
| T10a | surface E2E (real mux) | **PASS** | tmux suite **4/4**, herdr suite **5/5** (herdr chạy thật — không skip) |
| T10b/10c | live surface run / herdr live | **SKIPPED — not required** | `src/runtime/surface/**` không đổi trong stack; 10a đã cover pane spawn/degrade/doctor |
| T11a | read-your-writes | **PASS** | stores sync atomicWriteJson (3+3) · crash-recovery sync intent `:262` · buffered census 15 (không đổi) · full unit hôm nay tại code-HEAD: **9063/9060/0/3skipped** |
| T11b | wc-gate | **PASS** | gate exit OK (max file child-executor.ts 1432/2000) · wired `ci`+`ci:fast`+ci.yml (2 hits) |
| T11c | migration validator | **PASS** | offline probe: 2 key severity "removed", hasWarnings đúng shape |
| T11d | slow tier | **PASS** | 3 file slow/ · **slow suite riêng 63/63/0 EXIT=0** (89s) |
| T11e | CI env sanity | **PASS** | nightly.yml 1 hit (comment only), weekly-smoke.yml 2 (set) |
| T11f | event-log reject format | **PASS** | `type=${` 1+2 đúng vị trí |
| T11g | widgetPlacement default | **PASS** | `"bottom"` ở cả 2 EFFECTIVE_DEFAULTS |
| T11h | worktree-twins 3× | **PASS** | 4/4 × 3 lần liên tiếp |
| T11i | export-surface parity | **PASS** | 0 dead exports · 2 MUST_INCLUDE |
| T11j | committed-hash | **PASS** | "committed dist matches a fresh build" |
| T12 | resource contracts | **PASS** | 12a 1/1 (18 agents) · 12b 18/0/0 cả 2 parser (strict-YAML 18 ok) · 12c 16/16 withRoute + orchestrator present (budget-truncation đúng thiết kế) · 12d 45/45 |
| T13 | real-run UI render | **PASS** | 13 surface renders từ run thật; sweep **0 hits**: undefined / pluralisation / wire-format / spinner+0-running / over-width; hint `↓·enter` sống ở 50 col (done@50); glyph `✓` cho finished; OSC8 + `↑1.5k ↓2.3k` compact đúng grammar |
| **U11 probe** | embedded tier LIVE | **PASS** | Trong run T7: `tier.decision {route:"embedded"}` cho 01_explore ("opted into embedded tier — faults 0/2"), `live-session.session_created {elapsedMs:8, sharedServices:true}`, 8× embedded_memory, subprocess `worker.spawned` cho 02_execute+03_verify — **2 tier song song 1 run**, latency 8ms (hôm qua 9ms — stable) |

**TỔNG: 24 PASS · 0 FAIL · 3 SKIPPED (đều not-required theo decision table, ghi rõ scope)**

## Findings (không block)

1. **F-1 (minor, known-P2)**: `team-settings get runtime.embeddedWorkers` trả giá trị đúng
   (`enabled, roles:["explorer"]`) nhưng kèm warning "unknown — may not take effect" —
   handle-settings chưa biết key mới (UX exposure là follow-up P2 đã liệt kê trong design doc
   U11 §P2; config loading + runtime đều nhận key đúng — T7 probe chứng minh).
2. **F-2 (quirk đã biết, tái xác nhận)**: `pi -p` (zai) 3/3 probe đều không tự exit sau khi
   hoàn thành report (final stream treo) — run state trên đĩa completed hết; wrapper timeout
   là công cụ đo, không phải product regression. Bài học 2026-10-10 (b) đúng nguyên văn.
3. **F-3 (probe hygiene)**: chain probe lần 1 fail do quote-nesting qua bash làm agent bỏ
   chain param (chạy default-team). Fix: instruction qua file (`probe-instr.txt`) — lần 2
   chain chuẩn. Ghi lại làm pattern cho probe phức tạp.

## Anchors @ 2026-10-12 (`926b95ec`)

- `test:critical` **120** (~18-20s) · full unit **9063/9060/0 fail/3 skipped** (hôm nay, code-HEAD) · integration **144/140/0/4** · slow **63/63/0**
- Bundle **1,758,732 B (1717.5 KB)** md5 `472cb93254c69f7302b99e47269e02ea` (committed-hash OK)
- Event registry **182 registered / 147 emitted** (tier.* registered; DRIFT 3 = mailbox cũ, owner broker lane)
- Δ2 gate **523/523** files, allowlist rỗng (strict)

## Evidence paths

- Scratch project: `/tmp/rtb1012` (git, `.crew/config.json` embeddedWorkers:explorer) — 7 runs,
  run chính `team_20261012023749_f076f566387b7f74` (T7+U11), async `…f28764e1…`, chain
  `…11d7f37a…`+`…bdb08692…`
- Logs: `/tmp/rtb-slow.log` (T11d), `/tmp/full-ui.txt` (T13 render), `/tmp/rtb-probe2.log` (chain+Agent),
  `/tmp/rtb-t6-pty.log` (T6), `/tmp/skill-update-fulltest.log` (full suite)
- Cleanup: 3 wrapper strays killed by PID; tmux server removed; user crew root chỉ còn
  `active-run-index.{bin,json}` (leak-free sau toàn bộ battery); crashes.json không entry mới

## methodology notes

- Mọi live probe qua **fresh session** (`pi -ne --extension <repo>/dist/index.mjs -p …`) theo
  bài học 2026-10-10 (c) — session tương tác giữ bundle startup-time trong RAM, in-session
  team calls không chứng minh gì về code mới. `-ne` để tránh double-load conflict với
  pi-crew tự discover (GH#61 normalize không áp dụng khi 2 entry cùng tool names).
- Anchor full-suite chạy TRƯỚC commit `926b95ec` (doc-only, không ảnh hưởng test) — hợp lệ
  làm evidence cho code-HEAD `a56129ec`.
