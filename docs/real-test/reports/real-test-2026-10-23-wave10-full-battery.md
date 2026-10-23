# Full real-test battery re-run — pre-ship 0.11.38 (2026-10-23)

Repo `8ead520f` (dist = local `dist/index.mjs`, 1821.0 KB, unchanged từ `0ca9b552`). Executor worker trong run `team_20261023030033_8e517887abc536a7`. Scratch `/tmp/rtb1023/*` (không `pi-crew-*`). Exit codes qua log-file mọi gate.

## Đã xanh trong session này (GHI NHẬN, không chạy lại — sibling executor)

T1 critical **124/124** · T3 rebuild + T11j committed-hash MATCH @ `0ca9b552` · T4/T8 bundle live · T7 smoke ×3 + verify-gate row (memo HIT probe) · T9a (sibling) + **T9g steer round-trip** (run `team_20261022235426_b15c6f50fbab237c`) · T11a (12 pass) / T11c / T11 lazy-imports (535) · T12 partial (27). Slop-rules gate + 2 suites + verify-gate memo/typed 17/17 + ask-routing 13/13 (addendum `8ead520f`).

## Tier → recipe → evidence → verdict

| Tier | Recipe | Evidence | Verdict |
|---|---|---|---|
| **T2** kill-switch | 3 đường `test:critical` (default / `PI_CREW_BROKER=0` / `=1`), exit qua log-file | default `EXIT=0 # pass 124 # fail 0` · broker0 `EXIT=0 124/0` · broker1 `EXIT=0 124/0` (`logs/t2-exits.txt`) | **PASS** 3/3 |
| **T5** tmux TUI | `tmux -S /tmp/sock` 160x50, `/team-help` + arrows + escape/C-c, crashes.json | pi boot với pi-crew loaded; `/team-help` → model gọi `team action='help'` → card `┏ HELP ┗ ○ ok` render; `\x1bOA` recall input (diff 7 dòng); Escape+C-c: pi sống (pane_pid 2548641); crashes.json **0 entry mới** (baseline 1) | **PASS** |
| **T6** pty probe | `scripts/pty_probe.py --startup-sleep 35` (bulk keys j/k/arrows) | `PTY_EXIT=0`, full TUI frames (skills/extensions/statusbar), không zombie, 0 crash mới | **PASS** |
| **T9a** readonly | 15 action qua 1 pi -p session | `BATTERY-J: 15/15 ok — failures: none` (list/health/doctor-zombies/summary/events/graph/explain/search/worktrees/api/wait/validate/imports/export/cleanup-dryRun); 0 `Unknown type`/`Validation failed` | **PASS** 15/15 |
| **T9b** spawn | sync/async/chain/Agent/crew_agent qua `pi -p` fresh (ambient `PI_CREW_*` scrubbed) | sync `team_…031206_812d120d` fast-fix **completed 3/3** (usage đầy đủ) · async `team_…031434_94c3cd21`: `async.spawned` **không** `inline:true` (detached) · chain `team_…032436_ce91479a` (omit workflow) 2 handoffs, chain-a/b = APPLE · `Agent`=**42** · crew_agent bg + get_subagent_result=**PONG-BG** (retry 1; lần 1 provider-hang 0-output — xem Flakes) | **PASS** |
| **T9b-W** message | fold vào parallel tasks (explorer ×2) | 2 run parallel `…033637_ba36e3ea/…de4bf5a8` **completed**; MSG-PAR-ONE/TWO trong worker events/output/status ×(explorer+execute); broker confirm "delivered to 'parent'" | **PASS** (ask/delegate không chạy — xem Ghi chú) |
| **T9c** lifecycle | steer/checkpoint/status-details/cancel/resume/retry/wait trên run thật | checkpoint=ok (phase+childPid) · status details=true mid-run=running · steer=structured reject "Task completed; cannot steer" (delivery đã proven bởi T9g xanh) · cancel: guard "belongs to another session" rồi `force:true` → manifest **cancelled** · resume/retry: ownership-guard structured reject · wait ok | **PASS** |
| **T9d** (safe) | prune dryRun + forget throwaway trong scratch | prune dryRun "would-remove-1" (audit `prune.jsonl` removed=[]) · forget force → run dir `94c3cd21` **biến mất** | **PASS** (real prune/cleanup không chạy — policy destructive) |
| **T9e** admin | CRUD + workflow CRUD trong scratch | `BATTERY-G: steps=7/7` (create/get/update/delete team + workflow-create/list/delete); **deviation**: create landed USER scope (~/.pi/agent/teams), scope=project get thấy nhưng update/delete cần omit scope; 2 file `.bak` tôi dọn sạch | **PASS** + note |
| **T9f** bg/sched | goal start/stop + schedule add/remove + auto-summarize read | goal `goal_…c18be8b3ea904610` start (pid/evaluator/turns 0/1/budget 0/5000) → stop **cancelled**, state persisted `.crew/state/goals/`, proc gone · schedule created+removed (0 job sót — no spawn storm) · auto-summarize read-only (disabled, không toggle) | **PASS** |
| **T10a** E2E | tmux suite TRONG tmux; herdr suite NGOÀI tmux (socket sống) | tmux **4/4 pass EXIT=0** (spawn/self-close, kill-pane→degrade, doctor, tab-per-run) — lần 1 đỏ 1/3 vì ambient `PI_CREW_DEPTH=1` leak qua tmux-server env → `surface-spawn.hard-gate: host depth 1 > 0` fail-closed **ĐÚNG hành vi** = probe bug, không phải regression; scrub + rerun 4/4, 0 hard-gate · herdr **5/5 pass EXIT=0** (pane thật trong herdr user ~4s, tự dọn) | **PASS** 9/9 (sau probe-fix) |
| **T10b** live surface | `visibleAgents:["*"]` + `pi -p` fast-fix TRONG tmux pane | run `team_…040350_88600f2f`: `manifest.surface.provider="tmux"`, workerPids 3, tabs `@1`; events **3× worker.surface_spawned (paneId %2/%3/%4) + 3× surface_closed, 0 degraded, 0 gate_blocked**; sau run tmux server trống sạch (auto-exit) · visibleAgents **restored undefined** | **PASS** (pane-level) |
| **T10c** herdr live | chỉ khi pi trong herdr pane | `HERDR_ENV`/`HERDR_PANE_ID` = 0 markers → skip theo skill ("not in herdr pane"); herdr provider vẫn được E2E xanh 5/5 ở 10a | **SKIP** (allowed) |
| **T11b** wc-gate | gate + script pins + ci.yml | `npm run check:wc-gate` EXIT=0 `555 files, max 1971 lines (limit 2000)`; `ci`/`ci:fast` include = **true/true**; ci.yml step `:156-161` | **PASS** |
| **T11e** nightly env | grep pins yml | nightly.yml **chỉ comment** `:24` ("deliberately NOT setting") · weekly-smoke.yml `PI_CREW_SMOKE: "1"` `:33` | **PASS** |
| **T13** render | harness `/tmp/rtb1023/full-ui.ts` từ run thật `…031206` (13 section: CALL/STREAMING/COLLAPSED/EXPANDED@118+80/DOCK done/running/failed/40/50/60/PLAN/SIDEBAR) | sweeps **0** undefined · **0** retired glyph `[╭╮╰╯├┤]` · **0** `->` · **0** wire-format · **0** plural sai; python `BAD: none` (spinner/over-width/hint-clipped); hint `↓·enter` sống **@40/50/60**; không `fast-fix/fast-fix`; duration `1m35s/20.8s` nhất quán; shortId đồng nhất | **PASS** |

## Flakes chẩn đoán (không phải regression)

- **Provider hang `pi -p` 0-output ×2** (parallel lần 1 ~8', subagents lần 1): log dừng TRƯỚC khi tool chạy, model stream không tới (zai glm-5.3) — đúng quirk documented 2026-10-14 ("fresh pi -p + prompt nặng có thể treo 0-output — provider-side"). Retry đều xanh ngay. Load 1.5-2.6 cả lúc đỏ lẫn xanh → không phải starvation.
- **T10a đỏ 1/3 lần đầu**: ambient worker env (`PI_CREW_DEPTH=1`) inherit qua tmux server → surface depth-guard fail-closed từ chối spawn pane — hành vi an toàn ĐÚNG. Probe bug (build mảng unset mà quên áp), fix + 4/4.

## Ghi chú / leftovers

- 9b-W `ask`/`delegate` + 9c `respond`/`cache`/`invalidate` không chạy battery này (cần parked-ask watcher/delegate depth-cap setup) — được phủ bởi wave trước + suite xanh session này (ask-routing 13/13). steer_subagent timing-sensitive bỏ qua (T9g steer delivery xanh).
- `create resource=team` landed USER scope dù cwd scratch có marker — mô tả "project scope" chưa khớp hành vi (đã có note tương tự 2026-09-21 fix; scope=project get thấy nhưng update/delete không) — **đề xuất leader theo dõi** (không chặn ship: mọi action trả structured result).
- Capture catalog regen: `capture.ts` 18/18 + `render_png.py` EXIT=0 (glyph self-check không tofu); diff chỉ nondeterminism (temp-dir ids) — đã `git checkout` lại, tree sạch. Bước "nhìn 1 PNG" không khả dụng (model executor không đọc ảnh) — glyph-coverage check là bằng chứng thay thế.
- Orphan hygiene: 0 orphan pi từ probes. 1 background-runner cũ `pid 2182012` (22:57 đêm 22, từ T9g steer probe của sibling) — không đụng, để leader quyết.
- User-scope `.bak` của probe CRUD đã dọn; các `.bak` cũ (t9e/rt-scratch, 2026-08/09) của battery trước còn lại — ngoài scope.

## Verdict

**PASS toàn bộ tier được giao** (T2, T5, T6, T9a–f với các skip có lý do + deviation notes, T10a/10b/10c-skip, T11b/e, T13) trên nền các tier đã xanh trong session. Không phát hiện regression sản phẩm; 2 đỏ đều probe/env flake đã chẩn đoán. **Đủ điều kiện ship 0.11.38 chờ leader duyệt** (protocol: `npm version patch` → push --follow-tags → 3-OS CI xanh → publish → release).
