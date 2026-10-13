# real-test-pi-crew — Run Report

**Date**: 2026-10-13 (22:53–23:10 +07)
**Trigger**: "chạy skill real test pi-crew ngay trên live session này" — post skill-update `dd894b38`; prove the FINAL fix-round bundle (`1acd01e7`, build 21:55) live in a fresh session, closing the gap that the previous battery's T7 evidence (runs 142949/143126 @ 14:29–14:31) predates the fix-round commits (`f704b3c5`+`1acd01e7`).
**Repo HEAD**: `dd894b38` (branch `feat/pi-durable-upgrade`; code HEAD = `1acd01e7`, only skill docs after)
**Bundle md5 (disk)**: `c197855f917997a404ae39111d8ccfdc` (1,776,600 B / 1735.0 KB)
**Pi version**: host session PID 3136228 (pi 1.2.0 install tree)
**Run by**: leader agent, INSIDE the live session under test

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 120/120 pass, exit 0 |
| 2 3-path kill-switch | ⏭️ | not in this wave's required set (no broker-path change since last battery) |
| 3 typecheck + bundle | ✅ | tsc exit 0; rebuild reproduces `c197855f` **bit-for-bit**; `check-bundle-staleness` OK (4024.1s newer than newest src/) |
| 4 bundle md5 sync | ✅ | host pi cold-start **22:53:35** > bundle build 21:55 (and > 22:58 rebuild — content-identical) → session serves `c197855f` |
| 5 tmux TUI probe | ⏭️ | no `src/ui/` change this wave |
| 6 pty probe | ⏭️ | no `src/ui/` change this wave |
| 7 smoke team run | ✅ ×2 | **(a)** `team_20261013160009_d2d581b0f73649a8` (cwd=pi-crew repo): 3/3, consistency=1, 77.9s, `03_verify: verify_gate: PASS (skip reason: deterministic_pass)` — typecheck exit=0 + test:critical exit=0, verifier NOT spawned (U13 contract). **(b)** `team_20261013160152_5e13ad4886abad8a` (cwd=.rtb1013-t7b scratch git repo, no package.json): 3/3, consistency=1, 131.5s, `task.verifier_pre_gate` verdict INCONCLUSIVE `inconclusive_no_classifier` → LLM verifier spawned WITH gate context, independent re-read CONFIRMED executor claim (3 workers spawned). FAILED-verdict branch pinned in unit (`verify-gate-determinism.test.ts`); live spawn-with-context branch proven here |
| 8 final md5 sync | ✅ | disk = committed = fresh rebuild = `c197855f`; serving session started after build |
| 9a read-only battery | ✅ | **13/13** — list / recommend / health (33 runs, 0 stuck, 0 zombie-workspace; 5 corrupted = known Oct-4 residue) / doctor-zombies (2 old 1M-RSS bash-wrapper zombies parent-dead, report-only; 9 foreign WARN, never kill) / status / summary / get-workflow / events / search ("No results found." = PASS) / worktrees (none) / graph (none — linear run) / explain / settings |
| 9b spawn paths | ✅ | sync fast-fix ×2 = T7(a)(b) above |
| 9b-W worker tools | ⏭️ | unchanged since last battery (no `src/prompt/` change this wave) |
| 9c lifecycle | ⏭️ | covered by prior battery; no lock/cursor handler change since fix-round |
| 9d destructive | ⏭️ | not required; none run (session-start auto-prune note: runs pruned to keep=10 at 22:53 as designed) |
| 9e admin | ⏭️ | not required |
| 9f background | ⏭️ | not required |
| 10a/10b/10c surface | ⏭️ | no `src/runtime/surface/` change this wave |
| 11a read-your-writes census | ✅ | `appendEventBuffered` users = **15** (no drift) |
| 11j bundle committed-hash | ✅ | `git show HEAD:dist/index.mjs` md5 == fresh rebuild md5 == `c197855f` |
| 12 resource contracts | ⏭️ | only SKILL.md prose changed; no frontmatter/discovery change |
| 13 real-run UI render | ⏭️ | no `src/ui/` change this wave |

## Wave-specific live evidence (pi-durable U22/U16/U21/U13-ADJ/U9-ADJ)

- **U16 (2-tier usage ledger) — STRONGEST live proof**: T7(b) run's `tasks.json` carries full usage per task, including `cacheRead` AND `cost` — e.g. `{"input":1483,"output":1932,"cacheRead":9984,"cacheWrite":0,"cost":0.01317284}` — message-level cost OBJECT (`cost.total`) flows through the unified parser into `UsageState.cost` number on a real subprocess run. `team action=summary` on fix-round run 143555 renders `cacheRead=131840, cost=0.000000` (cost=0: pre-fix-round run wrote no cost — parser tolerates, compactUsage keeps key stable).
- **U13-ADJ (gate)**: deterministic_pass skip path (T7a) AND inconclusive→spawn-with-context path (T7b) both exercised live on the final bundle. `PI_CREW_VERIFY_DETERMINISM` left OFF (default) per battery recipe — layer-3 pinned in unit.
- **U22 (events durability)**: clean runs leave NO poison sidecar (additive behavior on healthy path); `events.jsonl.seq` watermark present. Torn/poison/rotate/compact branches + marker-lifetime rules pinned in `test/unit/state/event-log/` (mutation-checked in fix round).
- **U21 (run-lock dual-guard)**: both T7 runs acquired+released cleanly (`run.lock` absent after completion). Socket default-ON path exercised implicitly by every run's `withRunLock`; explicit 2-process contention + WAIT + flag-off bit-for-bit pinned in `test/unit/state/coordination/{process-lock,run-lock-socket}.test.ts`.

## Notes / quirks

- `cwd` override is workspace-bound (`Invalid cwd override: Path is outside /home/bom/source/my_pi`) — scratch repos must live INSIDE the workspace root (used `.rtb1013-t7b`, mirroring the earlier `.smoke-pi-durable` pattern); because that dir carries its own `.git` marker, run state resolved to `.rtb1013-t7b/.crew/state/runs/` (repo-root walk-up behaved as designed).
- T7(b) gate verdict landed INCONCLUSIVE (no package.json in scratch → executor error → soft-degrade), not FAILED — the spawn-with-context behavior is identical; the strict FAILED branch remains unit-pinned.
- doctor's 9 "foreign pi" WARN entries are old interactive/`pi -p` sessions (Oct 8–12) — report-only, untouched.
- Scratch evidence dirs kept: `.rtb1013-t7b/` (T7b run state) — remove after merge if desired.

## Verdict

**ALL REQUIRED TIERS PASS on the final fix-round bundle, live, from inside a fresh session serving it.** The 14:29–14:31 T7 evidence gap (predating `f704b3c5`+`1acd01e7`) is now closed with runs `160009`/`160152`. Branch `feat/pi-durable-upgrade` (16 commits incl. skill update) remains merge-ready.
