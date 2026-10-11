# real-test 2026-10-10 — FULL battery post-restart (v0.11.15, waves 1-3 + 3 live-caught fixes)

Session: fresh pi restart — bundle = v0.11.15 (f57ce84d), loaded via settings.json
`packages: ../../source/my_pi/pi-crew` → dist md5 `8f9a4a112d8070ecb6bbe482ca00e991`.
Scope: FULL T1→T13 per skill done-criteria. Report filled DURING the run.

## Verdict table

| Tier | Verdict | Evidence |
|---|---|---|
| T1 critical (default) | ✅ PASS | 120/120 pass, 0 fail, 0 cancelled, 18.9s |
| T2 kill-switch ×3 | ✅ PASS | BROKER=0 → 0 fail (19.5s); BROKER=1 → 0 fail (20.1s); default = T1 |
| T3 typecheck+bundle+md5 | ✅ PASS | tsc 0 err (node:sqlite experimental warn benign); build 1679.1 KB; staleness+ARCH-7 OK |
| T4 bundle-sync | ✅ PASS | session loads repo dist via settings packages; disk == build == committed (md5 8f9a4a11…) |
| T5 tmux TUI probe | ✅ PASS | /team-help renders crew commands; crash-input `/team-transcript <bad>/team-transcript ` ALIVE; crashes.json +0 (1 entry = OLD 2026-10-08 P0) |
| T6 pty bulk-keys | ✅ PASS | scripts/pty_probe.py keys j/k/↑(CSI)/↑(app-cursor)/q — frames changed per key, exit 0 |
| T7 smoke sync run | ✅ PASS | run team_20261010171504_cc4a5359bbe263ce completed 3/3 in 219s, consistency=1, **sync call RETURNED** (0.11.14 guard fix verified); verifier ran gate test:critical 120/120 as observable work; `task.verifier_pre_gate` = INCONCLUSIVE→LLM-with-context branch |
| T8 md5 sync | ✅ PASS | (see T4) |
| T9a read-only ×12 | ✅ PASS | list/recommend/health/doctor/status/events/summary/get/explain/worktrees/graph/search — all clean structured results; health 41 runs 0 anomalies; doctor 0 zombies (7 foreign pi = my probe leftovers, killed by exact PID) |
| T9b spawn paths | ✅ PASS | sync (=T7) · async run team_20261010171934 3/3 (118s) · chain 2/2 steps (team_…2145 + team_…2537, 428s total, no cancel at watch boundary — fix#2 verified) · Agent direct `AGENT-9B-OK` · crew_agent bg + get_subagent_result `CREW-9B-OK` · steer mid-run = 9g |
| T9g steer round-trip | ✅ PASS | watcher caught steering file 0→163 bytes in **1s**; worker honored at turn boundary — report contains STEER-9G-RECEIVED (4 mentions); run team_20261010173546 completed clean |
| T10 surface | ✅ PASS | surface-tmux.e2e 4/4 (11.8s) — spawn/self-close, kill-pane→degrade, doctor orphan |
| T11 a–j | ✅ PASS (a.4 pending below) | 11a stores sync (plan-store 3, ownership-map 3) + crash-recovery :262 + census 15 files; 11b wc-gate max 1408/2000, ci+ci-fast ✓; 11c warn-only ✓; 11d 3 slow files, globs disjoint ✓; 11e nightly comment-only ✓; 11f reject-format ✓; 11g bottom ✓; 11h worktree-twins 4/4 ×3 ✓; 11i 0 dead exports, MUST_INCLUDE now 6 core (drift documented); 11j committed-hash OK |
| T12 resource contracts | ✅ PASS | 12a 1/1; 12b 18 agents BOTH parsers clean (0 bad desc, 0 no-routing, strict YAML 18/0); 12c 16/16 useWhen (verifier/writer tail-truncated BY DESIGN); 12d 45/0 |
| T13 real-run UI render | ✅ PASS | all surfaces from REAL run state (CALL/STREAMING/COLLAPSED/EXPANDED@118+@80/DOCK done·done@50·running·failed/PLAN CARD/SIDEBAR); invariant sweep **0 undefined / 0 retired glyph / 0 wire-format / 0 plural / 0 over-width / 0 spinner-on-idle**; hint ↓·enter survives 40/50/60; catalog capture 18 + PNG 18/18 after OSC8 fix |
| T11a.4 full test:unit | ✅ PASS | **8952 tests / 8949 pass / 0 fail / 0 cancelled / 3 skipped, EXIT=0** (769s; env scrubbed PI_CREW_*/PI_TEAMS_*) |

## Live-caught during THIS battery (2 findings)

1. **steer_subagent near completion-boundary: claimed delivered, 0 bytes on disk** (run
   team_20261010172900, steer at ~17:32:0x, single-turn task ended 17:31:59, terminal at
   17:32:38): success message returned, steering file stayed 0 bytes (mtime = creation
   17:29), STEER string nowhere on disk (both crew roots + tmp swept), worker's own
   post-run sweep found no note. NOT reproduced mid-run (9g probe landed in 1s) —
   ROOT-CAUSED post-battery from the session transcript (ground truth): the steer
   fired at 17:29:05.086 — the SPAWN window, not the completion window — and the
   F7 on-spawn truncate's baseline (taskDispatchStartedAtMs, captured when the
   executor starts, i.e. AFTER the steer) failed the guard and wiped it at .753.
   **FIXED in v0.11.16** (fcef4db3): baseline = run creation time via
   steerRaceBaselineMs(); regression child-executor-steer-race.test.ts 6/6.
   9g canonical mid-run path PASS.
2. **render_png tofu-guard fired on OSC8 hyperlink escapes** in 15-inline-panel.txt
   capture (8 ESC bytes vs 0 in committed capture — OSC8 landed v0.9.x, catalog wasn't
   regenerated since): fixed by stripping OSC8 wrappers (keep link text) in
   render_png.py — 18/18 PNGs green. (First strip attempt had a 4-backslash raw-string
   bug — the tofu-guard caught my own fix correctly.)

## Known notes (non-blocking)

- goal_achievement reports "unknown — not a git repo" for runs whose cwd = workspace
  root (my_pi is not a git repo by design) — cosmetic, pre-existing.
- graph action on completed fast-fix run: "No graph found" (linear workflow, no graph
  artifact) — clean structured response.
- search "T7-BATTERY": "No results found." — documented PASS-not-error per skill.
- model image-viewing unavailable in this session: PNG visual inspection replaced by
  the programmatic tofu-guard (18/18 with glyph coverage self-check).

## Final counts

## Final counts (filled at completion)

- test:critical: 120/120 ×3 paths (default / BROKER=0 / BROKER=1)
- full test:unit: **8952 / 8949 pass / 0 fail / 3 skipped / EXIT=0** — 769s
- surface-tmux E2E: 4/4 · resource contracts: 18+18 parsers · catalog: 18 captures + 18 PNGs
- Bundle md5: 8f9a4a112d8070ecb6bbe482ca00e991 (disk == session == committed)
- Runs produced: team_…171504 (T7), team_…171934 (9b async), team_…172145+team_…172537 (chain),
  team_…172900 (steer anomaly), team_…173546 (9g round-trip PASS)
- Battery-triggered fixes this run: render_png.py OSC8 strip (committed 5665bd8f)

**VERDICT: FULL T1→T13 PASS** — 2 findings recorded (1 follow-up anomaly, 1 fixed in-run).
