# Real-test battery — residual wave (chain DSL consumers) — 2026-10-20

Bundle md5 `f51438301eadb9815074bc8dae819910` (pre-release commit 9591faad). Decision-table paths: `src/runtime/chain-{parser,runner}.ts`, `src/extension/team-tool/chain-executor.ts`, `dist/` → T1 → T3 → T4/T8 → T7 → T7-chain (new probe) → T11j.

| Tier | Kết quả |
|---|---|
| T1 test:critical | ✅ 124/124 |
| T3 build+staleness | ✅ exit 0, md5 sync |
| T4/T8 live-session sync | ✅ fresh pi session loaded new bundle (proven by features working live) |
| T11j wc-gate/lazy/env | ✅ exit 0 all |
| T7 smoke | ✅ (covered by T7-chain below — full default workflow per step) |
| **T7-chain (probe 1)** | 🎯 **BẮT GAP THẬT**: quoted inline-goal + DSL modifiers (`"goal":2 --with-context "final"`) → DSL parser threw on QUOTED step name → silent fallback simple splitter → constructs chết với cú pháp goal phổ biến nhất. Fixed: parser accepts QUOTED step names; `hasDSLConstructs` broadened to `:\d+\b` (time-like false positives vẫn fallback an toàn — pinned). |
| **T7-chain (probe 2)** | ✅ LIVE-PROVEN cả 3 constructs trong pi session thật (run `team_20261020023538_de9f30d597356273` chain dispatch): pane in `Step 1 ✓ / Step 2 ✓ / Step 2 #2 (repeat) ✓`; step2 goal 10.7KB = `# Previous Step Output (--with-context)` block (full step1 output, có APPLE) + `# Current Chain Step\nRepeat … append DONE final` (args appended); iter2 là run riêng (`…8ce2c280`) hoàn tất sau iter1. |

Scratch: `/tmp/rt26-chain` (git dir). Runs: de9f30 (step1), 1b98f1 (step2 iter1), 8ce2c2 (step2 iter2). Stale `f14830` = probe-1 leftover (host session chết — reconciler cảnh báo đúng, EP3 machinery sống).
