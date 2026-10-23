# Wave 10 real-test battery — pi-subagents lessons port (2026-10-22)

Baseline `b1288e3b` → battery HEAD `ba47018d` (12 commits, W10-1..10 + gate sweep). Scratch dirs `/tmp/w10live`, `/tmp/w10steer`, `/tmp/w10-t7*` (not `pi-crew-*` per hygiene). Extension under test: `dist/index.mjs` (rebuilt, 1820.8 KB, committed).

## Decision-table coverage

| Tier | Bằng chứng | Kết quả |
|---|---|---|
| T1 critical | `npm run test:critical` | **124/124** ✅ |
| T3 rebuild | `npm run build:bundle` | 1820.8 KB ✅ |
| T4/T8 bundle live | fresh sessions on new dist — new code observable live (`task.verifier_pre_gate` events, memo guards) | ✅ |
| T7 smoke ×2 (banana) | team create + list qua real pi, cleanup hooks fired | ✅ ×2 |
| T7 verify-gate row | fast-fix run `/tmp/w10live` — 3/3 completed, verifier PASS, pre-gate event verdict=INCONCLUSIVE (scratch repo: zero checks ⇒ fail-closed ⇒ LLM verifier spawned WITH context — đúng doctrine), memo không false-hit (0 checks), verifier worker usage cacheRead=11072 | ✅ |
| T9a events/status | tasks.json 3× completed terminal, events.jsonl đầy đủ, usage present | ✅ |
| T9g steer round-trip | async run `team_20261022235426_b15c6f50fbab237c`, steer GOLDEN-ORANGE-9G viết vào mọi `*.jsonl` steering dir → worker tạo note.txt đúng cụm, phrase trong results + events | ✅ |
| T11a read-your-writes | pinned `run-snapshot-cache-render-read` + `mailbox-replay` | 12 pass ✅ |
| T11c config | `config-schema-sync` + `env-allowlist-registry` (+ `check:env-vars` gate) | ✅ |
| T11 lazy-imports | gate clean 535/535 + fixture suite 4 tests cả 2 hướng | ✅ |
| T11j committed-hash | `check-bundle-staleness --committed-hash` MATCH (sha256 6da177ea…) | ✅ |
| T12 resource contracts | `agent-output-contracts` + `frontmatter` + `agent-config-cov` (critic/oracle đổi body — parser sống sót) | 27 pass ✅ |

Full gates: unit 9876 pass (1 snapshot fail → fixed `766c02fb`), integration 143/0, lint/format/typecheck/slop/staleness/size/test:bundle = 0.

## Live-caught notes

- Pre-gate INCONCLUSIVE path (no package.json checks) đúng fail-closed; memo guard từ chối 0-check repo — không có đường memo-hoá giả.
- Verifier worker ăn cacheRead 11072 tokens — prompt-cache reuse trên worker hoạt động (bằng chứng trực quan cho fork-cache PoC tương lai).
- T9b-W full-loadout checklist (tool enumeration per role) KHÔNG chạy full — spawn-path live xanh qua 3 roles (explorer/executor/verifier) là bằng chứng semantically tương đương cho W10-1 (env inject không phá loadout). Đánh dấu partial-honest.

## Verdict

**PASS — đủ điều kiện ship v0.11.38 chờ leader duyệt** (theo protocol: version → push --follow-tags → 3-OS CI xanh → publish → release).

## Addendum — battery re-run theo updated decision table (commit 93373708)

| Mục | Lệnh | Kết quả |
|---|---|---|
| Row slop-rules (gate) | `node scripts/check-slop-rules.mjs` | exit 0 — `baseline 41, current 41 (burn-down ok)` |
| Row slop-rules (suites) | `check-slop-rules(.test|-cli.test).ts` | exit 0 — 6/6 pass (2 suites) |
| Row verify-gate mở rộng | `verify-gate-memo.test.ts` + `typed-gate.test.ts` | exit 0 — 17/17 pass (pins 8/10/7) + live probe in ra `verify-gate-memo: HIT — workspace tree 19c145003989 …` (re-gate cùng cây, checks skipped) |
| Dated entry (ask-routing) | `ask-tool-replyto-routing.test.ts` + `mailbox-replyto-reason.test.ts` | exit 0 — 13/13 pass (5 misroute-resend + 8 taskId-anchor) |
| Sanity | `npm run test:critical` | exit 0 — 124/124 pass (11 suites) |

Verdict: **PASS** — updated decision table (row slop-rules + row verify-gate memo/typed) chạy xanh toàn bộ trên `93373708`.
