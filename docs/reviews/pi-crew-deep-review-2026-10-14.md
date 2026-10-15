# pi-crew v0.11.21 — Deep Review: Cơ hội nâng cấp (đã verify 2 vòng)

> **STATUS 2026-10-14 (DR-01):** P0 + F2 + F3 + F5b + F8 đã FIX, gates xanh (9165/9168 unit, ci:fast full pass). Chi tiết: `docs/specs/DR-01-deep-review-fixes-2026-10-14.md`

**Ngày:** 2026-10-14 · **Phương pháp:** direct source audit + verification round 2 (mọi finding được re-check bằng code-read/đếm programmatic; 2 finding ban đầu bị **rút lại** sau verify) · **Quy mô:** ~152K LOC `src/`, 503 file TS, 1065 test files.

> Quy trình: 2 lần dispatch pi-crew team audit đều fail vì upstream 429 — chính failure này cung cấp evidence live cho finding P0. Audit chuyển sang trực tiếp bằng grep/read.

---

## ✅ P0 — Worker 429 zero-output bị mark `completed` (false-green) — VERIFIED

**Vấn đề:** Child-process worker chết vì upstream LLM 429 (auto-retry cạn → settle với assistant message rỗng, exit 0) → task `completed`, run XANH.

**Code path đầy đủ (đã verify từng link):**
1. Child gặp 429 → pi-level `auto_retry_start/end` lặp lại → cuối cùng `agent_settled` với assistant message `content: []`, `usage: 0` — **không có `stopReason: "error"`** (transcript 04_explore-runtime, run `team_20261014082741`).
2. `child-executor.ts:344`: `if (event.stopReason !== "error") continue` — không thu error; `:391` error chỉ khi `childResult.error || exitCode !== 0` → exit 0, no error.
3. `post-execution.ts:374-377`: empty-result check quá hẹp — chỉ bắt `trimmedArtifact === ""` / `"(no output)"` / stderr-only. Output **74–139 byte** câu mở đầu ("I'll start by...") **lọt qua**.
4. `pre-execution.ts:205`: `collectYieldEvents = runtimeKind !== "child-process" && ...` — child-process (chế độ default) **miễn nhiễm yield contract** → `noYield` luôn false.
5. `post-execution.ts:530`: `status: error ? "failed" : noYield ? "needs_attention" : "completed"` → **completed**.
6. Effectiveness guard default = `"warn"` (`effectiveness.ts:56-67`: unconfigured → "warn"; chỉ off khi explicit dry-run) → severity=warning, **không chặn**.
7. `dispatch-batch.ts:442`: `needs_attention` ≈ `completed` khi tính batch progression.

**Evidence live (run `team_20261014082741_d4a123e75cecec85`):** `events.jsonl`: 7× `task.completed`, 0× `task.failed`; `tasks.json`: 7/7 `completed`; mọi transcript chứa 429; `results/*.txt` 74–139 byte.

**Hệ quả dây chuyền:** model fallback của pi-crew (`child-executor.ts` modelAttempts, "stopping model fallback after N attempt(s)") **không bao giờ kích hoạt** — vì child exit 0 được coi là thành công, không có attempt-failure để advance chain. Fix P0 sẽ tự khắc phục cả fallback path này.

**Đề xuất (effort M):**
1. Nới empty-result predicate: output rỗng **hoặc** không có tool-result thực / không có handoff section / tổng usage=0 ⇒ tối thiểu `needs_attention`, không green.
2. `agent_settled` với message cuối rỗng + usage 0 ⇒ coi là attempt-failure để model fallback advance.
3. Guard default → `fail` (hoặc ít nhất `block`) thay vì `warn`.
4. Tests: mock 429-exhausted settle → assert `failed`/`needs_attention` + guard đỏ; test output-boilerplate-74-bytes không pass.

---

## ✅ P1 — Findings đã verify

### F2. `crew-broker.ts` header "PHASE 0 skeleton" lỗi thời — VERIFIED (effort S)
- Header L1-26: *"PHASE 0 skeleton ... dispatches ONLY `hello` and `ping` ... NO persistence. NO children."*
- Thực tế (verify direct): ~1967 LOC; dispatch case ≥13 methods (`msg.send`/`msg.inbox`/`events.since`/`events.subscribe`/`task.waitStatus`/`steer.push`/`escalate`/`wait.request`/`wait.resolve`/`delegate.request` L629...); import `spawnDelegateGrandchild` từ `../delegate-spawn.ts` (L43) + `appendMailboxMessageAsync` (persistence).
- Đây là module transport cross-process quan trọng nhất — comment sai contract gây hiểu nhầm kiến trúc.

### F3. Action count drift 54 vs 57 — VERIFIED PROGRAMMATICALLY (effort S)
- Đếm bằng code: `allActionLiterals` → **total 57, unique 57**.
- Comment đúng: `team-tool-schema.ts:430` ("10+17+7+17+6 = 57"), README ("57 actions").
- Comment **SAI**: `team-tool-schema.ts:77` ("the 54-action mega-tool schema"), `src/extension/team-tool/dispatch/index.ts:4` ("54 action strings").
- Đề xuất: assert `allActionLiterals.length === 57` trong `test/unit/schema/team-tool-docs-sync.test.ts` (file đã tồn tại nhưng không bắt được drift comment này), rồi sửa 2 comment.

### F5b. Không có coverage measurement — VERIFIED (effort S-M)
- `package.json` scripts (`ci`, `ci:fast`): KHÔNG có bước coverage nào (không c8/nyc/`--experimental-test-coverage`).
- Vì thế không thể trả lời "module nào thiếu test" bằng dữ liệu — chỉ đo được bằng heuristic. (Lưu ý: heuristic filename-match ban đầu của tôi sai — `crew-agent-records` thực tế được **40 test files import**, `worktree-manager` 11, `live-session-runtime` 13, `run-dashboard` 14.)
- Đề xuất: thêm `c8`/`node --experimental-test-coverage` vào CI, publish coverage summary — sau đó mới bàn gap thật.

---

## 🔄 P2 — Findings còn lại

### F6. Model fallback chỉ hiệu quả sau khi P0 fix (effort S sau P0)
Chain fallback tồn tại (`child-executor.ts:612-1219`, tried-Set, "stopping model fallback") nhưng không kích hoạt vì 429-exhausted settle exit 0 (xem P0). Run 1 chỉ dùng đúng 1 model `step-5-preview-free` (5/5 model references), không advance. Sau P0: settle-rỗng = attempt-failure → chain tự hoạt động. Có thể tách riêng: cân nhắc treat `auto_retry` exhaustion là signal down-weight model đó trong chain.

### F7. Toolchain bleeding-edge (effort S-M, observation)
`typescript ^7.0.2`, `@types/node ^25.9.8` — cập nhật major nhanh; 215 resolved deps. Pin thận trọng khi CI flake xuất hiện.

### F8. docs/ housekeeping — VERIFIED, nặng hơn dự kiến (effort S)
**487 file** `docs/perf-report-team_*.md` (không ship vào npm package — `files[]` chỉ include docs cụ thể — nhưng làm nhiễu repo và agent resource discovery). Đề xuất: archive ra `docs/archive/perf-reports/` hoặc retention policy + gitignore runtime output.

---

## ❌ ĐÃ RÚT LẠI sau verification (đừng thực hiện)

### ~~F4. Dynamic imports thiếu LAZY marker~~ — FALSE POSITIVE
Markers **có đủ**, đặt ở dòng phía trên import (convention được enforce). `scripts/check-lazy-imports.mjs` chạy trong CI (`check:lazy-imports`): *"all dynamic imports LAZY-marked ... within budget"* — exit 0. Grep ban đầu của tôi chỉ lọc marker cùng dòng → sai.

### ~~F5. Test gap trên hot modules~~ — CLAIM SAI, thay bằng F5b
Filename-heuristic sai: các hot module đều được test import rộng (40/11/13/14/21 test files). Không có evidence gap cụ thể khi chưa có coverage tool → chuyển thành F5b ở trên.

---

## ✅ Điểm mạnh đã verify (giữ nguyên, đừng đụng)
- **merge-gate integrity** (`merge-gate.ts:70-90`): reject terminal→non-terminal + 5 flips completed-integrity, có exhaustive test (`test/unit/team-runner-should-merge-table.test.ts`).
- **Snapshot cache** (`run-snapshot-cache.ts`): TTL 1500ms + coalesced async refresh, không sync-rebuild trên paint path (Tier-11a contract).
- **check-lazy-imports gate**: machine-checked, PASS — thấy được level kỷ luật CI (18 bước check trong `ci`).
- `redactSecretString` trên mọi broker log scope; kill-switches đầy đủ; worktree cleanup dirty-preserve.

## Roadmap (đã điều chỉnh sau verify)

**Quick wins (1-2 ngày):**
1. P0 predicate + tests (quan trọng nhất — mọi run lớn sau phụ thuộc)
2. F3: assert count trong docs-sync test + sửa 2 comment "54"
3. F2: rewrite broker header
4. F8: archive 487 perf-reports

**Major (1-2 tuần):**
5. P0: guard default `fail`/`block` + fallback-advance-on-empty-settle
6. F5b: coverage tool vào CI
7. F7: dep pinning review

**Không làm ngay:** split `crew-broker.ts` (1967 LOC) — chờ F2 + coverage data; consolidation action surface — chờ usage metrics thật.
