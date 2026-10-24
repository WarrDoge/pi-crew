# REAL TEST — Wave 11 battery ADDENDUM (wave 11c: F1 + F2 closed)

Repo `/home/bom/source/my_pi/pi-crew`, HEAD `cc1fede7`
(`fix(runtime): record sync-run spawner pid … (wave 11c)`),
`check-bundle-staleness --committed-hash` = **OK MATCH** (dist/index.mjs sha256 `4b4321fa…`,
fresh build = committed). Executor worker of run
`team_20261024071504_db8bfc47176ca00b` (01_01-agent). Mọi lệnh env-scrub
`PI_CREW_*`/`PI_TEAMS_*` (ambient markers của worker session), exit code từ
log-file. Ambient `env | grep PI_CREW_REAP` = rỗng trước mọi probe.

Re-run đúng 2 mục FAIL/BLOCK của
`real-test-2026-10-24-wave11-battery.md`: mục 4b (**F1** kill-switch isolation)
và mục 7b (**F2** sync-run leak).

## R1 — F1 re-run: 5 pinned suite × 3 biến thể ambient

Suites: `test/unit/runtime/process/{reap-group,run-descendant-sweep}.test.ts`,
`test/unit/runtime/recovery/reconcile-terminal-run-descendant-sweep.test.ts`,
`test/unit/runtime/stale-reconciler-run-descendant-sweep.test.ts`,
`test/unit/runtime/stale-reconciler-reap-escalation.test.ts`
qua `node scripts/test-runner.mjs --test-force-exit <5 file>`.

| Biến thể | # tests | # pass | # fail | Exit |
|---|---|---|---|---|
| (i) sạch (scrub, không REAP var) | 82 | 82 | 0 | `EXIT=0` |
| (ii) `PI_CREW_REAP_RUN_DESCENDANTS=0` | 82 | 82 | 0 | `EXIT=0` |
| (iii) `PI_CREW_REAP_GROUP=0` | 82 | 82 | 0 | `EXIT=0` |

82 = 78 pin cũ + 4 test mới của 11c. Mục 4b cũ (17/78 đỏ khi switch=0) đã
lật xanh: suite `run-descendant-sweep.test.ts` giờ pin switch trong setup
(`cc1fede7`). **R1 PASS — F1 closed.**

## R2 — T1 critical

`npm run test:critical` (scrub): `# tests 124 # pass 124 # fail 0`, `EXIT=0`.
**R2 PASS.**

## R3 — F2 re-run: E2E sync-leak thật (quan trọng nhất)

1. **Setup**: scratch project `/tmp/w11c-battery` + scratch HOME
   `/tmp/w11c-home` (copy `auth.json` + `models.json` + `pi-crew.json` —
   auth copy là nguyên nhân fail của battery trước, đã làm đúng). tmux
   `-S /tmp/w11c.sock` session `w11c` chạy `pi -ne -e
   /home/bom/source/my_pi/pi-crew/dist` (dist 11c, env scrub + HOME scratch).
2. **Sync run**: `action='run' team='fast-fix'`, goal = worker bash spawn
   background `node -e "process.title='w11c-battery';setInterval(()=>{},1000)"`
   rồi kết thúc. Run `team_20261024071937_7d1a0603676cd843` **completed 3/3**
   tại `2026-10-24T07:33:06Z`.
3. **sessionPid recorded**: manifest tại thời điểm `status=running` đã có
   `"sessionPid": 4001586` (leader pi pid của sync run — field mới 11c).
4. **Kill tmux** `07:33:14Z`: pid 4001586 DEAD, leak pid `4003225`
   (`w11c-battery`, env `PI_CREW_PARENT_PID=4001586` = sessionPid DEAD,
   kèm `PI_CREW_BROKER_RUN_ID=<runId>`) + bash leader `4003224` sống sót —
   đúng topology 7b cũ.
5. **>60 s**: `07:34:33Z` leak vẫn sống. Negative control sống: pid `4006136`
   cùng title + `PI_CREW_BROKER_RUN_ID=<runId>` nhưng
   `PI_CREW_PARENT_PID=4000069` (pid đang sống, chưa từng được record).
6. **Doctor + reconcile**: `pi -ne -e dist -p` (action doctor, session mới
   cùng scratch) — **startup lane reconcile chạy ngay tại boot** và reap:
   log thật
   `[pi-crew:stale-reconciler.run-descendant-sweep] swept 2 descendant process(es) of terminal run: 4003224(run-id),4003225(run-id): team_20261024071937_7d1a0603676cd843`
   — descent proof thỏa qua `manifest.sessionPid` (dead-only, đúng như
   async runner pid). Doctor report sau đó sạch ("no surviving process
   matched") vì sweep đã chạy tại boot — report-only, không process nào
   khác bị giết.
7. **Manifest sau sweep**: `status=completed`, `sessionPid=4001586`,
   `descendantSweepAt=2026-10-24T07:34:59.145Z`, `descendantSweepPending`
   không set (swept and clean — đúng ngữ nghĩa). Cả 2 leak pid
   (`4003224`, `4003225`) DEAD; sweep xảy ra trong cùng giây boot của
   session doctor (≤ ~6 s).
8. **Negative control**: pid `4006136` VẪN SỐNG sau reconcile (spawned
   07:33:28Z, alive cả sau sweep 07:34:59Z) — parent sống ⇒ không đủ
   descent proof ⇒ không giết. **PASS.**
9. **Dọn**: kill negctl tay, `tmux kill-server`, xoá `/tmp/w11c-battery`,
   `/tmp/w11c-home`, `/tmp/w11c.sock`. Kiểm cuối `ps -ef | grep
   '[w]11c-battery'` = 0 (lần pgrep đầu tự-match shell probe — trap đã
   biết, verified bằng ps). Auth gốc không đụng (chỉ copy, mtime
   `Oct 13 14:16` giữ nguyên).

**R3 PASS — F2 closed** (option (a): record `manifest.sessionPid`).

## Verdict

**BLOCK → PASS.** R1 (3× 82/82, cả hai kill-switch trạng thái), R2
(124/124), R3 (sync-run leak reaped qua descent proof sessionPid, negative
control sống, sweep ≤~6 s, manifest stamps đúng, 0 rác). F1 + F2 closed tại
`cc1fede7`. Sẵn sàng cho leader quyết publish theo quy trình chuẩn.
