# Real-test battery — Wave 14 (drain API + zombie-scanner seam + cleanupStateRoot pilot)

- **Date**: 2026-10-25 20:07–20:26 (+07:00)
- **Repo**: `/home/bom/source/my_pi/pi-crew` @ `92cc36c5` (parent `c95f01ad`, `e9352753` 0.11.41)
- **Tree**: clean (`git status --porcelain` = 0 dòng) trước battery
- **Env**: linux, node v22.23.1, npm 10.9.8
- **Verdict: PASS** (2 fail broker adjudicated ambient, xem §Adjudication)

## Bước 0 — setup
- HEAD `92cc36c5` "test(teardown): pilot cleanupStateRoot … (wave 14-F3)" — đúng spec.
- **Env scrub (regex)**: 27 biến ambient `PI_CREW_*`/`PI_TEAMS_*`/`PI_CODING_AGENT` (worker của chính verifier) được unset qua `env -u …`; verify `env $SCRUB sh -c 'env | grep -cE "^(PI_CREW|PI_TEAMS|PI_CODING_AGENT)"'` → **0** (≤1 yêu cầu). `TEST_NO_HOME_ISOLATION` không có trong env.
- Battery chạy detached (nohup, PID 1303953), mỗi lệnh log riêng + exit code + leak sweep riêng.

## Pin 1 — targeted ×3 (exit 0, leak sweep sau mỗi lần = CLEAN)

| File | r1 | r2 | r3 | Tests |
|---|---|---|---|---|
| state/event-log/drain-event-log-writers.test.ts | 0 | 0 | 0 | 4/4 pass (d1–d4) |
| zombie-scanner.test.ts | 0 | 0 | 0 | **26/26 pass, 0 skip** |
| extension/team-tool-steer-clamp.test.ts | 0 | 0 | 0 | 3/3 |
| dwf-setresult.test.ts | 0 | 0 | 0 | 13/13 |
| state/event-log/event-log-batch.test.ts | 0 | 0 | 0 | 8/8 |
| state/event-log/event-log-async.test.ts | 0 | 0 | 0 | 5/5 |
| extension/core/subagent-steer-live.test.ts | 0 | 0 | 0 | 4/4 |
| extension/registration/subagent-tools-integration.test.ts | 0 | 0 | 0 | 14/14 |

24/24 run exit=0; `pgrep -af "setInterval|proc-tree-leader|zombie-fixture"` rỗng sau **mỗi** run. **Zombie-scanner: skip=0 trên linux ×3** — unskip mọi OS được chứng minh (các gate `skip: process.platform !== "linux"` đều chạy trên linux).

## Pin 2 — race repro (drain → rmSync không retry)
Run thêm 1 lần `PI_CREW_DEBUG=1`: 4/4 pass (exit 0), d1/d4 (repro race EBUSY/EPERM) PASS cả 4 lần (3 targeted + 1 debug). Root cause được trị: drain API cho phép `rmSync` không cần retry — test d1–d4 là bằng chứng repro.

## Pin 3 — test:critical
- Run 1 (trong battery): exit=1 — **123/124**, fail `R6-6: request() arms the REQUEST timer at opts.timeoutMs` (crew-broker-client-fallback, assert 80ms fail nhanh).
- **Rerun (sau adjudication)**: exit=0 — **124/124 pass, 0 skip** ✓

## Pin 4 — full unit `npm run test:unit` (scrub regex)
- 10,080 tests: **10,075 pass / 1 fail / 4 skipped** (skip đều gated: HB-003a real-binary, waiting-tasks UI, GC-gated, macOS /private/var, Windows named-pipe).
- Fail duy nhất: `recordWaitPolicyRejection never throws when the events path is unwritable` (crew-broker-wait-auth).

## Adjudication — 2 fail broker = AMBIENT (không phải regression wave 14)
1. Wave 14 (`c95f01ad` + `92cc36c5`) **không chạm** `src/runtime/broker/` hay test broker (broker src cuối đổi `c77153c9`, pre-0.11.41).
2. Isolated ×2 mỗi file, scrub kỹ: `crew-broker-client-fallback` **15/15 pass ×2**; `crew-broker-wait-auth` **5/5 pass ×2**.
3. Full `test:critical` rerun sau đó: **124/124 exit=0**.
→ Kết luận: 2 test timer-sensitive broker flaky dưới load tuần tự của battery (pin3 chạy ngay sau 25 run targeted; box còn leak shell cũ, xem §Environment). Theo protocol: KHÔNG chấp nhận fail ambient làm fail thật; bằng chứng isolated đủ chứng minh không regression.

## Pin 5 — integration `npm run test:integration`
exit=0 — **148 tests: 144 pass / 0 fail / 4 skipped** = baseline spec ✓ (log có chuỗi "exitCode=130" nhưng đó là OUTPUT kỳ vọng của test RT-2 SIGINT — test đó `ok`).

## Pin 6 — static
lint 0 ✓ · format:check 0 ✓ · typecheck 0 ✓ · slop-rules **baseline 41 = current 41** ✓ (1763 files) · lazy-imports 0 ✓ · wc-gate 0 ✓

## Pin 7 — bundle staleness
`node scripts/check-bundle-staleness.mjs --committed-hash` → **MATCH**: sha256 committed = fresh, **1,892,130 B = 1,892,130 B** ✓ (không rebuild; 2 dòng `fatal: dist/index.mjs.map … does not exist` là so sánh map phụ "absent vs absent", exit vẫn 0).

## Pin 8 — leak sweep cuối
`pgrep -af "steer-live|setInterval|proc-tree-leader|test-runner.mjs"` = **rỗng** ✓

## Environment note (ngoài scope — KHÔNG kill)
Phát hiện leak shell cũ từ **Oct 22 14:51** (3 ngày): PID 1892028 (`npm test`) → 1892029 → 1892040 (`sh -c npm run test:unit`) — con `node test-runner.mjs` đã chết, shell cha treo, không match pattern sweep (cmdline không chứa "test-runner.mjs"). Không thuộc run này → không kill; đề xuất leader prune theo protocol dead-worker.

## Verdict
**PASS** — mọi pin đạt sau adjudication; 0 regression từ wave 14; dist MATCH; 0 leak từ battery. Gate cho bump v0.11.42: XANH.
