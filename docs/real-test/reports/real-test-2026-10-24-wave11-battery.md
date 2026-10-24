# REAL TEST — Wave 11 ship battery (group reaping + run-descendant sweep)

Repo `/home/bom/source/my_pi/pi-crew`, HEAD `fa967665` (dist rebuild `f578c223`,
`check-bundle-staleness --committed-hash` = **OK MATCH**). Executor worker
`team_20261024060707_bbb984feab2f53c9` (01_01-agent). Mọi lệnh env-scrub
`PI_CREW_*`/`PI_TEAMS_*` (session này là worker pi-crew nên ambient markers luôn
có — scrub wrapper trên mọi `pi`/test invocation), exit code đọc từ log-file.
Ambient `env | grep PI_CREW_REAP` = **rỗng** (exit 1) trước mọi live probe.

| # | Mục | Evidence | Verdict |
|---|---|---|---|
| **1** T1 critical | `npm run test:critical` (scrub) | `# tests 124 # pass 124 # fail 0`, 12.2s, `EXIT=0` | **PASS** |
| **2** Pinned unit (5 suite) | `node scripts/test-runner.mjs --test-force-exit <5 file>` | `# tests 78 # pass 78 # fail 0`, 8.6s, `EXIT=0` — đúng 78 như decision table pin @ `f578c223` | **PASS** |
| **3** Integration live repro ×3 | `test/integration/run-descendant-sweep-live.test.ts` | Run1 `# pass 1 # fail 0` 788ms `EXIT=0`; Run2 779ms `EXIT=0`; Run3 762ms `EXIT=0`. A1–A5 gồm negative control bắt buộc SỐNG (no-marker / interactive-tty / parent-còn-sống) — assert trong suite | **PASS** (3/3) |
| **4a** Off-path `PI_CREW_REAP_GROUP=0` | pinned suites rerun | `78 pass / 0 fail`, `EXIT=0` | **PASS** |
| **4b** Off-path `PI_CREW_REAP_RUN_DESCENDANTS=0` | pinned suites rerun | **17/78 FAIL** (exit 1) — tất cả trong `run-descendant-sweep.test.ts` (a1–a8, a10–a19, b1: expect reap → actual `[]`). Suite không tự pin switch (chỉ test a9 tự set/restore); các test kia assume switch ON từ ambient | **FAIL** — **F1** test-isolation gap, KHÔNG phải src regression (src đúng: switch=0 ⇒ no-op) |
| **5** T9a doctor thật | tmux `w11t9a`, `pi -ne -e dist -p` `action='doctor' focus='zombies'` | `PIPE_EXIT=0`. Section **"Run descendants of terminal runs (report-only — nothing killed)"** hiện diện, `"No surviving process matched … (last 5 terminal runs)"`, `"This tool never kills"` — doctor tự khai + không process nào chết. Dòng "no descent proof ⇒ NOT reaped" KHÔNG xuất hiện vì host không có candidate không-proof nào (lane skip đó chỉ in khi có candidate; hành vi lane được cover bởi mục 3 A2/N1 + mục 7) | **PASS** (kèm note) |
| **6** E2E normal flow | tmux `w11t6`, scratch git `/tmp/w11-norm`, `action='run' team='fast-fix'` | Run `team_20261024062218_aa18e385fd93743b` **completed 3/3**, consistency=1. tasks.json: cả 3 checkpoint có `childPgid`/`childStartTime`/`childUid` (F3: 3936806/36761201/1000, 3936958/36765076/1000, 3937068/36767231/1000). Session 1 (không chạm team tool) không stamp; session kế gọi `team status` ⇒ reconcile chạy: manifest `descendantSweepAt=2026-10-24T06:25:26.042Z`, `descendantSweepPending` không set (sweep sạch — đúng ngữ nghĩa 11b.4 "swept and clean") | **PASS** |
| **7** E2E leak thật (async = incident topology) | scratch `/tmp/w11-battery-proj` + `PI_CREW_STATE_ROOT` + HOME scratch (auth.json copy), worker spawn `node -e "process.title='w11-battery';setInterval…"` qua bash | Run `team_20261024064223_cd234e24c8e0a0be` (async, terminal `failed` sau verifier max-retries — deadletter, không liên quan sweep). Leak pid **3961449** sống >60s sau terminal, markers `PI_CREW_BROKER_RUN_ID=<runId>` + `PI_CREW_PARENT_PID=3961142` = `manifest.async.pid` recorded, DEAD. Session mới + `team status` ⇒ log thật `[pi-crew:stale-reconciler.run-descendant-sweep] swept 1 descendant process(es) of terminal run: 3961449(run-id)`, pid biến mất, manifest `descendantSweepAt=2026-10-24T06:48:05.451Z` (~1s sau session boot, trong ngưỡng ~6s), `descendantSweepPending` không set | **PASS** |
| **7b** E2E leak sync-run (probe bổ sung) | run sync `team_20261024063001_3a236f82383e9eea` completed, leak 3948488/3954392 (`w11-battery`) sống, đủ markers run-id + `PI_CREW_PARENT_PID=3938774` | **KHÔNG bị reap, doctor dry-run KHÔNG list** — pid 3938774 (leader pi của sync run) KHÔNG được record (sync run không có `manifest.async.pid`; recorded set = worker pids 3939883/3943877/3953759 + surface panes) ⇒ rơi đúng "documented miss" của rule 11 (`run-descendant-sweep.ts:66-75`: run-id marker alone is not proof). Manifest stamp `descendantSweepAt=06:39:37.610Z`, pending không set | **BY-DESIGN MISS — F2**: sản phẩm an toàn (không giết nhầm) nhưng sync-run leak KHÔNG được quét; task expectation mục 7 (reap mọi leak worker-spawn) không meet trên topology sync |

## Flakes

Không gặp flake nào (`crew-broker-client-fallback`, `child-executor-heartbeat-pulse`
không đỏ trong các lần chạy). 2 bất ổn state-store `loadRunManifestByIdAsync: retry
loop detected … best-effort only` xuất hiện trong session pi thật — đã từng thấy
trong các battery trước, không phải regression của wave 11.

## Findings cho leader (không sửa trong battery)

- **F1 (test-isolation)**: `test/unit/runtime/process/run-descendant-sweep.test.ts`
  cần pin `PI_CREW_REAP_RUN_DESCENDANTS=1` trong beforeEach (giống cách suite
  `reap-group` tự chịu được ambient) — hiện 17/78 đỏ khi ambient switch=0, trái
  decision table "unit xanh trên CẢ HAI trạng thái switch".
- **F2 (design gap)**: sync-run worker bash leak mang `PI_CREW_PARENT_PID` = leader
  pi pid không-record ⇒ sweep bỏ qua an toàn nhưng không bao giờ quét. Options:
  (a) record leader/run pid cho sync run vào manifest (descend proof), hoặc
  (b) chấp nhận documented miss + cập nhật SKILL.md ghi rõ shape này.

## Dọn dẹp

`kill` 2 sync leak (3948488, 3954392) tay; async leak do product reap. Scratch
`/tmp/w11-battery-proj`, `/tmp/w11-norm`, `/tmp/w11-home`, `/tmp/w11b`, `/tmp/w11`
đã xóa. `tmux kill-server`. Kiểm cuối: `pgrep -f w11-battery` = 0,
`pgrep -f run-descendant-sweep-live` = 0, `ls /tmp | grep w11` = 0.

## Verdict

**BLOCK** (cho leader quyết trước publish): 6/7 mục PASS trọn vẹn (T1 124/124,
pinned 78/78, live repro 3/3 với negative control sống, REAP_GROUP=0 xanh,
doctor report-only, E2E normal F3+F7, E2E async leak reaped ~1s). Nhưng **mục 4b
FAIL (F1)** — trái yêu cầu decision-table của chính skill, và **F2** làm mục 7
không meet trên sync topology. Cả hai đều không phải src regression đã biết-cả-hai
là gap cần quyết (fix test / record pid / waive). Không publish cho tới khi leader
xử F1 (bắt buộc theo decision table) và chọn option cho F2.
