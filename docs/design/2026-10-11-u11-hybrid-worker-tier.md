# U11 — Hybrid 2-Tier Worker Model (embedded tier, DEFAULT-OFF)

**Status:** shipped DEFAULT-OFF · unit-verified (866/866 targeted sweep + critical 120/120) · live-acceptance verified 2026-10-11 (this doc, §5)
**Date:** 2026-10-11 · **Spec:** `pi-crew-upgrade-spec-2026-10-09.md` U11 (hybrid worker tier) over U4 (live-session stack)
**Scope:** `src/runtime/task-runner/hybrid-tier.ts` (new), `src/runtime/live-session/embedded-tier.ts` (new), routing seam in `src/runtime/task-runner.ts`, config surface `runtime.embeddedWorkers`, shared slot budget in `src/runtime/scheduling/nested-slots.ts`, events `tier.decision` / `tier.fault` / `tier.fallback` + `live-session.embedded_*`.

---

## 1. Problem and shape

Every pi-crew worker today is a child Pi **subprocess**. That buys crash isolation but
costs a full process spawn (~300–600 ms to a worker handle, measured live in §5.3) and
makes steering/orphan lifecycle heavier than it needs to be for cheap, trusted roles.

U11 adds a second **embedded tier**: the worker's Pi session runs **in-process** on the
U4 live-session stack. The subprocess tier remains the only tier unless a role explicitly
opts in — with `runtime.embeddedWorkers` absent or `enabled: false`, behavior is
byte-identical to pre-U11 (no lazy import of the hybrid module, no events, no budget
reads; pinned by the `embedded-tier.test.ts` "default-off" regression).

## 2. Design summary

### 2.1 Tier router policy (one home: `resolveTaskRuntimeKind`)

Routing rule (evaluated per task attempt in `runTeamTask`, `src/runtime/task-runner.ts:123`):

```
resolved == "live-session" && base == "child-process" → embedded route
```

Guards that ALWAYS beat the opt-in (cannot be weakened by config):
- `runtime.mode === "scaffold"` — scaffold never executes;
- nesting guard `PI_CREW_DEPTH > 0` — a nested worker never leaves the subprocess tier;
- `isolationPolicy.isolatedRoles` — crash-isolated roles stay subprocess;
- role not listed in `embeddedWorkers.roles` — non-opted roles are **silent** (no
  `tier.decision` event; they are unaffected).

A base runtime of `live-session` (legacy `runtime.mode: live-session`) is deliberately
NOT a hybrid route — that path is frozen (ADR `docs/decisions/2026-08-15-runtime-convergence.md`
decision (a)) and keeps its pre-U11 semantics (no slot budget, no fault ledger).

### 2.2 Embedded stack on U4

The embedded tier IS the U4 live-session runtime (`src/runtime/live-session/live-session-runtime.ts`)
with `LiveSessionSpawnInput.embeddedMitigations` set (see `embedded-tier.ts:1-30`
ownership note): shared services (session cache, provider registry), in-process prompt
cycle, transcripts streamed to the same artifacts layout. `session_created` reports
`sharedServices: true` — measured **9 ms** to a session handle, twice (§5.2/§5.3).

### 2.3 Mitigations (spec U11 a–d, all fail-closed, embedded path only)

| # | Mitigation | Anchor |
|---|---|---|
| a | **Builtin-tools-only** — no MCP/extension tools; verified after apply; degradation fails the task instead of running unsandboxed | `embedded-tier.ts` tool-policy apply + `live-session.embedded_factory_assert` |
| b | **Provider `timeoutMs`** — every model HTTP call clamped so a hung provider cannot hold a slot; concurrent sessions share ONE clamped registration restored exactly when the last leaves | `embedded-tier.ts:644-734` (`embedded_provider_timeout_degraded`) |
| c | **Turn-count watchdog** — turn-spinning session disposed after bounded grace (default 10 000 ms, echoed in `embedded_admitted.watchdogGraceMs`) | watchdog + `turn-watchdog` fault kind |
| d | **Embedded concurrency cap N** — fail-fast reject at the ceiling, never queue on the ceiling; rejected tasks reroute to subprocess immediately | `nested-slots.ts:36-57` `defaultEmbeddedSlotCeiling` / `createEmbeddedSlotBudget` |

Blast-radius guard: ref-counted process-level `uncaughtException` handler installed only
while embedded sessions are in flight; on a strike it quarantines (dispose + unregister)
every in-flight embedded session and keeps the host alive, bounded by a circuit breaker
(`MAX_GUARD_QUARANTINES_PER_PROCESS = 20`, `embedded-tier.ts:227`). Memory metrics are
emitted rate-limited and ring-capped (`live-session.embedded_memory`).

### 2.4 Fallback stickiness (2-fault budget)

Per-task fault ledger persisted in `task.diagnostics.embeddedTier` (cross-attempt, drained
synchronously on fault so a concurrent re-dispatch sees the freshest count). Counted fault
kinds: `session-error`, `hung-tool`, `turn-watchdog`, … — aborts/cancellations never count.
After `faultThreshold` counted faults (default **2**), the task is **permanently rerouted
to the subprocess tier** for all remaining attempts — sticky across retries and recovery.
Events: `tier.fault` per counted fault, `tier.fallback` on the downgrade, and a
`tier.decision { route: "subprocess", reason: "fault-threshold" }` on subsequent dispatches.

### 2.5 Shared slot budget

Embedded and subprocess workers draw from the SAME global worker semaphore — there is no
concurrency bypass for the embedded tier. The embedded ceiling
(`maxConcurrent`, default `max(1, floor(worker-cap/2))`) is a blast-radius bound layered
on top: it caps how much of the shared budget may be embedded at once; at the ceiling a
new task fail-fasts to subprocess (which still queues on the shared budget like any other
subprocess task).

## 3. Config surface and where it is read

```jsonc
// ~/.pi/agent/pi-crew.json        (user — always wins)
// <repoRoot>/.crew/config.json    (project; repoRoot via project markers)
// <repoRoot>/.pi/pi-crew.json     (project alt)
// inline run-action `config` param (shallow per-section merge, wins over files)
{
  "runtime": {
    "embeddedWorkers": {
      "enabled": true,          // default false — the whole block is inert without it
      "roles": ["explorer"],    // roles allowed to run embedded; NOT sensitive (behavior pick, not authority)
      "maxConcurrent": 2,       // default max(1, floor(worker-cap/2))
      "faultThreshold": 2       // counted embedded faults before sticky subprocess reroute
    }
  }
}
```

- Project-root resolution (`src/utils/paths.ts:157-241`): walk up from cwd to the first
  dir with a marker (`.git`, `.pi`, `.crew`, `.hg`, `.svn`, `.factory`, `.omc`, or a
  build file `package.json`/`pyproject.toml`/…), stopping at `$HOME`/`$TMPDIR`.
- `runtime.embeddedWorkers` is NOT in the sensitive drop-list — it survives
  `sanitizeProjectConfig` (unlike `runtime.isolationPolicy`).
- **Verifier-failure post-mortem (2026-10-11):** the first 2-tier acceptance attempt
  "failed" NOT because of config placement — the project config was read correctly —
  but because the serving pi session ran a **pre-U11 `dist/index.mjs`** whose config
  schema rejected the key: `config.warning` `"/runtime/embeddedWorkers: Unexpected
  property"` (run `team_20261011144950_d9b7e1712f80db68`, state under `/tmp/u11-2t/.crew/`).
  The bundle was rebuilt (21:54) after that run (21:49–21:52). **Lesson: a
  `… Unexpected property` config warning against a just-added config key is the
  smoking-gun signature of a stale bundle; rebuild + cold-start before re-verifying.**

## 4. CLOCK DEVIATION from spec go-condition

Spec U11 go-condition "U4 stable ≥ 2 weeks" was **NOT met** at ship time (U4 landed
2026-10-10, wave 3). Deviation handling:

- Shipped **DEFAULT-OFF** (`enabled` absent → inert path, byte-identical behavior).
- Enabling per-role **in defaults** (e.g. explorer) is gated on the U4 soak clock
  expiring **~2026-10-24** (2 weeks from U4 landing, commit 665b443a). Until then,
  any rollout is per-user/per-project opt-in only.
- The fallback tier (subprocess) remains the default for every role not opted in.

## 5. Acceptance evidence (live, 2026-10-11)

Environment: `/tmp/u11-acc` (git-initialized scratch, 2-file repo), project config
`.crew/config.json` = `{"runtime":{"embeddedWorkers":{"enabled":true,"roles":["explorer"],"faultThreshold":2}}}`,
fresh `pi -p` sessions with all `PI_*` env scrubbed, default model chain
(zai/glm-5.3 → …), user config `limits.maxConcurrentWorkers: 4` → embedded ceiling 2.

### 5.1 Two-tier E2E — run `team_20261011150612_fb21a4f52bdba427` (team: review)

- Config pickup: `manifest.runConfig.runtime.embeddedWorkers =
  {"enabled":true,"roles":["explorer"],"faultThreshold":2}` (project file, proven).
- **(a) tier routing** — `tier.decision` (seq 7): `01_explore` →
  `{"route":"embedded","from":"child-process","to":"live-session","reason":"role-opt-in","faultCount":0,"threshold":2}`.
  Non-opted roles are silent by design; their subprocess routing is proven by (c).
- **(b) embedded session live** — `live-session.session_created` (seq 13):
  `{"elapsedMs":9,"sharedServices":true}`; `live-session.embedded_admitted` (seq 10):
  `"Embedded tier admitted (1/2)"` — default ceiling `max(1, floor(4/2)) = 2` exercised;
  8× `live-session.embedded_memory` (rate-limited).
- **(c) subprocess trail for the others** — `worker.spawned` with real pids:
  `02_code-review` pid 435062, `03_security-review` pid 435069, `04_verify` pid 436009.
- **(d) completion** — run `completed`, 4/4 tasks `completed` exit=0, consistency 1.0,
  8 789 tokens, ~192 s. Review findings correct (`divide()` missing zero-guard — real).

### 5.2 Latency spot-sample (same role, same repo, same goal)

| Tier | Run | Metric | Value |
|---|---|---|---|
| embedded (explorer) | `team_20261011152607_40e065efb3c47abd` | `session_created.elapsedMs` | **9 ms** |
| embedded (explorer) | `team_20261011150612_fb21a4f52bdba427` | `session_created.elapsedMs` | **9 ms** |
| subprocess (explorer) | `team_20261011151744_410d3cafd44c56ce` | `task.started` → `worker.spawned` (events ts) | **317 ms** |
| subprocess (explorer) | `team_20261011144950_d9b7e1712f80db68` (pre-U11 bundle run) | same method | 566 ms |

Methodology note: **spot-sample, not a bench** — n=1 per cell, wall-clock from
events.jsonl timestamps; the embedded number measures "in-process session handle ready"
and the subprocess number "child pid registered"; neither includes first-token provider
latency, which is identical per call. Direction and magnitude (≈35–60× on the spawn
dimension) are consistent across both samples.

### 5.3 Token spot-check (same 1-task prompt via each tier, team `probe-one`)

| Tier | Run | Model calls / tool uses | Tokens (input / output / cacheRead) |
|---|---|---|---|
| subprocess | `team_20261011151744_410d3cafd44c56ce` | 1 call, 1 tool use | 130 / 476 / 3 904 (≈4.5k ctx; `tasks.json.usage`) |
| embedded | `team_20261011152607_40e065efb3c47abd` | 3 calls, 2 tool uses | per-call finals: 6 898/44/448 · 130/469/7 296 · 361/70/3 328 (session ≈15–19k ctx; transcript records — `tasks.json.usage` stays `undefined` on the embedded path, see §7) |

Quality: both tiers returned a correct one-sentence answer (missing `b === 0` guard →
`Infinity`/`NaN`); embedded's version cited file:line evidence. **Interpretation
caveat:** single sample; the token delta is dominated by agent behavior variance (3 model
calls vs 1) and a colder provider cache on the embedded session's first call — it is NOT
established as an inherent tier cost. Follow-up bench (b15?) should use a fixed
tool-less prompt.

### 5.4 Fallback live-check — SKIPPED (unit coverage cited)

A live 2-fault simulation would need a fault-injection seam (poisoned provider or
forced watchdog) not present in the tree — >10 min of scaffolding for what the state
machine already proves. Cited instead (marked as unit-level, not live):
`test/unit/runtime/task-runner/hybrid-tier.test.ts`
`[u11-3b] runEmbeddedTier: fault #1 stays live (counted, tier.fault), fault #2 → fallback (tier.fallback)`
and `[u11-2c] resolveTaskRuntimeKind: fault budget exhausted → sticky subprocess (no upgrade)`
(ledger persistence, abort/capacity-rejected non-counting gates included). 37 tests
across the 2 new unit files.

## 6. Enable path (operator instructions)

1. Opt in per role — user config `~/.pi/agent/pi-crew.json` (or project; not sensitive):

   ```json
   { "runtime": { "embeddedWorkers": { "enabled": true, "roles": ["explorer"] } } }
   ```

   or one run only: inline `"config": { "runtime": { "embeddedWorkers": { … } } }` on the
   `run` action (shallow-merges over files).
2. Defaults kick in with no tuning: ceiling `max(1, floor(cap/2))`, `faultThreshold` 2,
   watchdog grace 10 s.
3. Watch routing: `grep '"tier.decision"' .crew/state/runs/<runId>/events.jsonl`;
   fallbacks surface as `tier.fault` / `tier.fallback`.
4. Kill switch: remove the block or set `enabled: false` (byte-identical legacy path).

## 7. Known P2 limitations (accepted at ship, follow-ups)

1. **`uncaughtException` swallow bounded at 20** — the blast-radius guard keeps the host
   alive across uncaught strikes only up to `MAX_GUARD_QUARANTINES_PER_PROCESS = 20`
   per process (`embedded-tier.ts:227`); past the breaker, normal crash behavior
   resumes. Unbounded swallow is deliberately rejected.
2. **Ceiling misalignment is conservative-direction** — the ceiling singleton keys on
   `${cap}:${max}` (`hybrid-tier.ts` `embeddedCeilingFor`); if policy ceiling and global
   semaphore disagree across config changes the effective admission is the SMALLER
   budget (never more embedded than intended).
3. **`setDefaultStreamFn` post-condition assert impossible** — the SDK exports only the
   setter (identity read not importable), so the a-mitigation "verify after apply"
   cannot assert the global stream fn equals ours; we assert the degrade-fail path
   around it instead (`embedded-tier.ts:798-799`).
4. **Coalesced-group dispatch is legacy-routed** — `runCoalescedTaskGroup`
   (`src/runtime/scheduling/run-coalesced-task-group.ts`) does not consult the hybrid
   tier router; coalesced group members always run subprocess until a follow-up wires
   the router there.
5. *(Observed in acceptance, new)* **Embedded task usage not persisted to
   `tasks.json.usage`** — subprocess tasks carry `{input,output,cacheRead,cacheWrite}`,
   embedded tasks leave it `undefined` (usage only in the transcript's per-message
   records). Budget/consistency totals still capture embedded runs at run level.
6. *(Observed in acceptance, new)* **Agents-record runtime label says `child-process`
   for embedded tasks in `agents.json`** (while `task.started.data.runtime` correctly
   says `live-session`) — cosmetic inconsistency in the agent status record only.

## 8. Evidence index

- `/tmp/u11-acc/.crew/state/runs/team_20261011150612_fb21a4f52bdba427/` — 2-tier E2E run
- `/tmp/u11-acc/.crew/state/runs/team_20261011152607_40e065efb3c47abd/` — embedded 1-task probe
- `/tmp/u11-acc/.crew/state/runs/team_20261011151744_410d3cafd44c56ce/` — subprocess 1-task probe
- `/tmp/u11-acc-run.log`, `/tmp/u11-probe-sub.log`, `/tmp/u11-probe-emb.log` — session transcripts
- `/tmp/u11-2t/.crew/state/runs/team_20261011144950_d9b7e1712f80db68/` — verifier's
  pre-rebuild run (stale-bundle `config.warning` evidence)
