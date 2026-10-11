# Real-test battery — Wave A (0.11.17), post-fix-round

- **Ngày**: 2026-10-11, 15:05–15:45 +07 · host **pi 1.1.0** (release dir `1.1.0`), node v22.23.1, linux, load 3.4–4.9
- **Đối tượng**: `cd09ca8a` (HEAD sau fix-round, dist md5 `b7194c0cbc5eee88e9add4b72685d951`, 1,738,680 B) — mọi live probe qua **fresh pi session** (session dispatch cũ giữ bundle 0.11.16 trong RAM, lesson 2026-10-10c)
- **Scope theo decision table**: src/runtime/child-pi, src/ui, src/config, async-runner, dist → T1·T3·T5·T7·T9b-async·T11c·T11j·T13 + 2 probe MỚI (aborted-settle cancel, OSC 7501)
- **Skill snapshot**: `skills/real-test-pi-crew/SKILL.md` @ `da53bfa7` (đã cập nhật rows + block 2026-10-11 trước battery)

## Verdict tổng

| Tier/probe | Kết quả | Evidence chính |
|---|---|---|
| T1 critical (env-scrub) | **PASS** | `# fail 0 # cancelled 0` 27.8s |
| T3 + T11j bundle | **PASS** | rebuild 1697.9 KB; md5 == committed; `--committed-hash` OK |
| T5 TUI cơ bản (tmux) | **PASS** | `/team-help` render; `\x1bOA` app-cursor alive; crashes.json **1502 B unchanged** (baseline 10-08) |
| T7 smoke sync (fresh `pi -p`) | **PASS** | run `team_20261011080636_b158688fb6ee0246` 3/3 completed, clean shutdown (~10 min — model latency, mỗi worker ≪600s) |
| T9b-async detached (fresh `pi -p` dispatch) | **PASS** | run `team_20261011081711_e6914ed858381014`: `async.spawned` pid+logPath, **0× `inline:true`**, 3/3 completed |
| **L2-1 cancel classification (LIVE, mới)** | **PASS** | run `team_20261011083036_71d02e40873f65b4`: manifest `cancelled`; task in-flight `02_execute/03_verify → cancelled` (**không phải completed** — đúng đích fix MAJOR-1); `run.cancelled`×1 + `task.cancelled`×2. Cancel cross-session qua ownership gate → `force:true` (probe run của mình). Json mode mặc định → rpc-pool eviction N/A live, đã pin unit (`child-pi-rpc-abort-settle` ×3, `assemble-attempt-outcome` ×10) |
| **B-1 OSC 7501 (LIVE, mới)** | **PARTIAL** | Thấy: boot query `\x1b]7501;?` + dispose `\x1b]7501;state=clear:app=pi-crew` (đúng wire format upstream, app=pi-crew) qua /dev/tty trong pty thật (`script`) — **channel + format + no-throw proven**. Chưa thấy live: transitions `working`/`blocked` — (a) run async detached KHÔNG map sang `working` theo design (active = live-session agents), (b) probe live-agent bị feeder stdin-EOF giết session giữa chừng. Transitions đã pin unit (wiring derive + controller). Follow-up recipe bên dưới |
| T11c migration validator | **PASS** | 2 warning `severity:"removed"` đúng (BROKER_DIAG_UI, SAFE_BASH), `hasWarnings:true` |
| R3-2 pin (b13 warm) | **PASS** | warm 22 ms non-empty (budget 400 ms) — regression giữ sau gold-query |
| T13 render từ run thật | **PASS** | CALL/STREAMING/COLLAPSED/EXPANDED/EXPANDED@80: tick glyphs ✓ 100% bar ✓ humanized `4m35s`/`3m47s` ✓ không wire-leak (`cost=`,`turns=`) ✓ truncate giữ status @80 ✓. STREAMING với `durationMs:4200` → `elapsed=4s` (producer-consistent). Live dock proven thêm ở cả 2 pty log (`┏ CREW ▸ …`). Widget-model standalone harness crash `findRepoRoot(Array)` = **harness-context** (không phải product — dock live xanh), xem follow-up #3 |

## Observations (non-blocking)

1. **`pi -p` hang class tái xuất ×2** trong battery (dispatch xong, model stream cuối không exit → phải `timeout` + kill -9 PID). Known class (2026-10-10 lesson b), KHÔNG phải regression wave A.
2. `[state-store] loadRunManifestByIdAsync: retry loop detected instability ... best-effort only` xuất hiện 2 lần trong T7 log (run green) — theo dõi, không chặn.
3. **Probe-harness lessons mới** (nên nhập skill lần sau):
   - `tmux capture-pane` KHÔNG bao giờ thấy OSC writes của app (tmux tiêu thụ sequence, không lưu pane buffer) → đo OSC bằng `script -q -c "… pi" /tmp/x.log` (pty thật, log byte thô) — probe này đã dùng và bắt được `]7501;?` + `state=clear`.
   - Feeder `((sleep N; printf …; sleep M) | script …)` đóng stdin ở EOF → **pi exit giữa chừng** (probe B chết giữa Agent-live window). Fix: giữ pipe mở thêm (`sleep 300` cuối, hoặc `tail -f /dev/null |`), hoặc socat pty pair.
   - T13 harness template trong skill dùng `buildWidgetLines(done, {…})` giờ crash ở standalone context (`findRepoRoot` nhận Array qua `activeWidgetRuns`) — cần update template (signature/context) lần sau; live render vẫn xanh.
4. Sync `team` call với `async:true` từ session cũ (bundle 0.11.16) block trọn turn (~10 min) — ghi nhận hành vi, chưa quy được nhân-quả (session cũ hay regression); fresh-pi dispatch async hoạt động đúng (trả runId, runner detached).

## Follow-ups

- [ ] B-1 live transitions: pty probe với live-agent window dài (feeder giữ stdin) hoặc park run thật (ask/plan-approval) → chốt `working`/`blocked` live.
- [ ] Update skill T13 template (widget-model standalone context) + 2 probe-harness lessons ở trên.
- [ ] RPC-mode live probe cho pool-eviction aborted (khi flip U14-rpc default — Wave B).

## Evidence files

- `/tmp/t7-run.log` (T7), `/tmp/pty7501.log` + `/tmp/pty7501b.log` (7501 + dock live), state runs `team_2026101108{0636,1711,3036}_*` dưới `pi-crew/.crew/state/runs/` (auto-prune keep=10 có thể dọn — runId đã ghi ở đây làm audit).
