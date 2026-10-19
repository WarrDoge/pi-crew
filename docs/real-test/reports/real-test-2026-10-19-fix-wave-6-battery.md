# real-test-pi-crew — Run Report

**Date**: 2026-10-19
**Trigger**: Post-release battery cho fix-wave 6 (deep-review R1-R51 close-out, v0.11.25) — chạy SAU khi publish 0.11.25 (quy trình bị thiếu step battery — phát hiện và chạy bù; battery bắt 1 regression thật → fix trong 0.11.26).
**Repo HEAD**: `9cb79c0b` (v0.11.25) — battery chạy trên cây sạch; fix T7 nằm trong 0.11.26.
**Bundle md5 (disk)**: `cf16c181622ea31f03ba95eadae46361` (0.11.25) → `0afc2b7fecf571b0f49e00ca3dfd88f8` (sau fix T7)
**Pi version**: 1.2.0
**Run by**: leader session (agent) — headless `pi -p` + tmux probes + shell

## Decision-table mapping (paths wave-6 đã đổi)

`src/runtime/broker|child-pi|live-session|prompt|state|surface|verification|task-runner`, `src/ui/`, `src/config/`, `agents/*.md`, `workflows/*.workflow.md`, `.github/workflows/ci.yml`, `scripts/check-lazy-imports.mjs`, `dist/` → **T1, T2, T3, T4/T8, T5, T7×2, T9a/9b/9b-W/9g, T10a/b, T11a-j, T12, T13**. T6 bỏ (tmux có); T10c skip có lý do (herdr wire phủ bởi T10a).

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | `124/124 pass`, `# cancelled 0`, ~13s (`/tmp/rt25-t1.log`) |
| 2 3-path kill-switch | ✅ | default + `PI_CREW_BROKER=0` + `=1` đều `124/124` (`/tmp/rt25-t2*.log`) |
| 3 typecheck + bundle | ✅ | tsc exit 0; bundle 1794.7 KB, md5 `cf16c181…` → sau fix `0afc2b7f…`; staleness exit 0 |
| 4 bundle md5 sync | ✅ | `../node_modules/pi-crew` → `../pi-crew`; md5 disk == symlink target (`cf16c181…`); không có global install |
| 5 tmux TUI probe | ✅ | `/team-help` render đầy đủ trong session mới (`22:22`); `/model` (builtin) OK; crashes.json **1 → 1** (không entry mới). **Probe-hygiene note**: gõ slash command khi session đang BOOT/BUSY → pi giao thành message cho LLM (lần đầu tưởng command mất — phải chờ idle + verify bằng builtin command) |
| 6 pty probe | ⏭️ | T5 đủ (tmux 3.4) |
| 7 smoke team run | ✅ (sau fix) | **A (PASS path)**: run `team_20261019152334_b98709041907909a` → `completed`, `task.verifier_pre_gate {verdict:PASS, skipVerifier:true, reason:deterministic_pass}`, evidence typecheck+test-critical PASS. **B (FAIL path)**: run `team_20261019152513_bdfb2d1057391b37` → verifier spawn ĐÚNG `{skipVerifier:false, reason:deterministic_failed, attachGateContext:true}` nhưng run **BLOCKED `green_unsatisfied observed=none`** ← **REGRESSION M3-2 bắt được**: prompt verifier child-process vẫn dạy prose ("Give PASS or FAIL") trong khi consumer yêu cầu dòng verdict → fix: extractor nhận bare verdict + siết prompt 5 workflows + verifier.md + plan-templates. **Re-probe**: run `team_20261019153419_197f127d7da375c2` → `completed`, `observed=targeted`, `green_unsatisfied` = **0** |
| 8 final md5 sync | ✅ | disk = loaded = `0afc2b7f…` sau fix |
| 9a read-only battery | ✅ 13/13 | list, health (26 runs scanned), doctor zombies, settings get (`ui.widgetPlacement = bottom`), search (no-match = PASS), recommend, status, events, summary, get, explain, worktrees, graph |
| 9b spawn paths | ✅ 5/5 | sync (T7), async `team_20261019154035_…` (`async.spawned {pid,logPath}` — KHÔNG inline) + PING1; chain `team_20261019154146_…`+`_154334_…` (CHAIN1→CHAIN2 tuần tự); `Agent` direct `team_20261019154517_…` (AGENT1); `crew_agent run_in_background`+`get_subagent_result` `team_20261019154539_…` (CREW1). Tất cả `completed` + token trong results |
| 9b-W worker tools | ✅ 3/4 | **ask round-trip**: run `team_20261019155251_…` — worker ask (2× ask.requested), detached responder (recipe trong skill, envelope đầy đủ) trả lời, worker nhận **`PROBE_ASK_ANSWER_RT25` verbatim** trong report ✅; **message notify**: `PROBE_MSG_OK` + 2× `mailbox.send` ✅; **delegate nesting**: run `team_20261019155601_…` — 4× `delegate.requested/admitted/completed`, grandchild trả `NESTED1` verbatim ✅; **loadout**: `LOADOUT: read, grep, find, ls, bash, edit, write, scratchpad, ask, delegate, message` ✅. **Depth-cap live: KHÔNG probe được bằng text** (delegate schema không có depth param — enforcement nội bộ qua PI_CREW_DEPTH) → unit-pinned, ghi nhận thiếu |
| 9g steer round-trip | ✅ | watcher ghi `01_explore.jsonl` tại **+0.5s** (boot window, 106B); worker session log có `PROBE_STEER_RT25` (`custom_message`); result: `PROBE_STEER_ACK` + "steering note received after Section A and honored" (3 tín hiệu) |
| 10a surface E2E | ✅ | **tmux 4/4** (spawn+self-close, kill-pane→degrade→headless, doctor orphan, per-run tab); **herdr 5/5** (spawn, pane.close→degrade, doctor, tab, closeTab edge) — real panes, không mock |
| 10b live surface run | ✅ | run `team_20261019161042_…`: pane thật quan sát live `%12 π - crew-01_explore - pi-crew`; `worker.surface_spawned`×2 + `surface_closed`×2; `manifest.surface.provider=tmux`, workerPids=2; **0** degraded/gate_blocked; panes auto-close (0 crew- panes sau run); config isolated-home (`visibleAgents:["*"]` user tier) |
| 10c herdr live | ⏭️ | session không chạy trong herdr pane (0 biến `HERDR_*`) — skip có lý do; wire herdr phủ bởi T10a 5/5 |
| 11a read-your-writes | ✅ | plan-store 3 + ownership-map 3 `atomicWriteJson`; crash-recovery "Log the event first" :275; buffered census **15 files** (không đổi); full unit đã chạy (9766/0 + 9789/1-flake + pre-push) |
| 11b wc-gate | ✅ | max **1465** (child-executor.ts) ≤ 2000; `ci` có check:wc-gate |
| 11c migration validator | ✅ | 2 key removed → `severity:"removed"` + `hasWarnings:true` |
| 11d slow-tier | ✅ | `test/integration/slow/` = 3 files (full-feature-smoke, phase5-observability, ui-performance) |
| 11e nightly env | ✅ | nightly.yml: chỉ comment; weekly-smoke.yml: `PI_CREW_SMOKE:"1"` |
| 11f reject format | ✅ | `type=${type}` (scratchpad-lifecycle:93) |
| 11g widgetPlacement | ✅ | settings-overlay:469 + handle-settings:48 + defaults:144 đều `"bottom"`; live `settings get` → bottom |
| 11h worktree-twins | ✅ | 4/4 ×3 runs |
| 11i export/slash parity | ✅ | `HELLO_DEADLINE_MS` chỉ còn const nội bộ (không export); `BROKER_PROTOCOL` không export; MUST_INCLUDE parity test green |
| 11j committed-hash | ✅ | `OK: committed dist matches a fresh build` (0.11.25; re-check sau commit 0.11.26) |
| 12 resource contracts | ✅ | 12a 1/1; 12b `agents:18 | bad desc:0 | no routing:0`, strict YAML 18/0; 12c 16/16 rendered có `useWhen=` (orchestrator có, verifier bị budget-truncate = đúng thiết kế); 12d 45/45 |
| 13 real-run UI render | ✅ | Harness render từ run thật `team_20261019161042_…` (CALL/STREAMING/COLLAPSED/EXPANDED/@80/DOCK done·done@50·done@40·running·failed/PLAN CARD/SIDEBAR). Sweep: `undefined|╭╮╰╯├┤|->` **0**; plural **0**; wire-format **0**; spinner+0-running **0**; over-width **0**; hint `↓·enter` sống ở 40 col. Catalog regen: capture 18 files + png 18 files; diff thật = 18-settings (key `runtime.isolationPolicy.defaultRuntime` nay hiển thị đúng — schema-derived); PNG 18-settings soi trực tiếp: render đúng, glyph coverage OK, không tofu |

## Findings (battery bắt được)

1. **REGRESSION (P1, fixed in 0.11.26)** — `verifier verdict consumer` (M3-2/R47-3-V4) chặn run oan: prompt verifier child-process vẫn dạy prose → verifier trả prose → `observed=none` → policy block `green_unsatisfied`. Live-proven 2 lần (trước/sau fix). Fix: (a) `VERIFIER_VERDICT_LINE` nhận bare/decorated verdict (`PASS`, `**PASS**`, `PASS — …`, `PASS. …`, `PASS (…)`), vẫn từ chối mid-line/word-continuation; (b) siết prompt: 5 workflows + `agents/verifier.md` + 2 plan-template verifier taskTemplates yêu cầu dòng verdict chính xác. Pin: 11/11 + mutation.
2. **Probe-hygiene** — gõ slash command khi pi session còn boot/busy → thành message cho LLM (giả "commands không register"); chờ idle + xác nhận bằng builtin command trước khi kết luận.
3. **Observation (không phải regression)** — `manifest.usage` = null trên mọi run (kể cả run cũ 2026-10-14) → UI hiển thị "0 tok" trung thực; ngoài phạm vi wave.
4. **Observation** — session start log `artifact-store.prune-anchor ENOENT ... skipping N descriptor(s), nothing deleted` cho run-dir đã bị auto-prune: hành vi fail-closed đúng (M1-6), nhưng log khá ồn (nhiều dòng/session start).

## Verdict

Battery đầy đủ theo decision table, 0 tier đỏ sau fix. **1 regression thật được bắt và fix (0.11.26)** → đúng lý do quy trình bắt buộc battery TRƯỚC publish; 0.11.25 đã lên npm với regression này (workaround: revert về 0.11.24 hoặc nâng 0.11.26 ngay).
