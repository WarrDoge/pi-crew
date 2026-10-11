# Pi Upstream Tracking — U12 (pi-durable) — 2026-10-11

- **Date:** 2026-10-11
- **Spec:** `U12 — Track pi-durable (điều kiện tái đánh giá)` in
  [`pi-crew-upgrade-spec-2026-10-09.md`](../../../../pi-crew-upgrade-spec-2026-10-09.md) (root workspace, planning note);
  delta input: §5 of [`pi-crew-upgrade-delta-2026-10-11.md`](../../../../pi-crew-upgrade-delta-2026-10-11.md).
- **Upstream pin:** `origin/main` = `cdaf6c227d4718a72b59ccd02152c9614df44cfc`
  (local clone `/home/bom/source/my_pi/source/pi`, read via `git show`/`git grep` — never checkout).
  Last released upstream: pi-durable 1.1.0 (2026-10-07); everything in `[Unreleased]` is
  post-1.1.0 and can still change before the next npm release.
- **Purpose:** this is a **living re-check log**, not a one-shot review. U12 = **track-only**:
  pi-crew must NOT adopt `@earendil-works/pi-durable` while upstream is unstable. Re-run the
  4-trigger check below on **every pi npm release** (trigger for the next re-check).

## Policy (unchanged)

- **Track-only, never adopt while unstable.** Rationale from the spec: experimental package,
  breaking changes ship in patch/minor (v1.1.0 shipped breaking `Storage.order` +
  `TaskRuntime.context()` one week after 1.0.0 — re-confirmed in
  `packages/durable/CHANGELOG.md` `[1.1.0] › Breaking Changes` at `cdaf6c227`), single-process
  with no cross-process lock / no multi-writer story, subagent conversations not exposed via services.
- **Compat ground-truth = installed pins, not semver.** pi-crew currently pins
  `@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent` (peer `*`, dev `^1.0.4`) and has
  **no** `pi-durable` dependency. Monorepo lockstep versioning does NOT mean API freeze — judge
  by language in README/CHANGELOG, not version numbers.
- **Exact-pin policy stays:** if/when adoption is ever reconsidered, pin exact versions with a
  release + pin gate; never float a range over an unreleased-churn API.

## Trigger re-check at `cdaf6c227` (2026-10-11)

Adoption becomes reconsiderable when **≥ 3 of 4** triggers fire. Current state: **1 of 4, and
that one only via pi-crew's own side** (T4 OR-branch) → **still track-only**.

| # | Trigger | Verdict | Evidence |
|---|---------|---------|----------|
| T1 | Experimental banner removed + CHANGELOG has API-freeze language | **NOT met** | Banner still present; `[Unreleased]` opens with `### Breaking Changes` |
| T2 | Multi-process story stable (session-worker/protocol out of experimental) | **NOT met** | Everything still under `packages/coding-agent/src/experimental/`, gated `PI_EXPERIMENTAL=1` |
| T3 | Subagent conversations exposed via services | **NOT met** | TODO still open at `services/README.md:44` |
| T4 | Scheduler has concurrency cap OR pi-crew's own waiting-tasks cap suffices | **MET via pi-crew's own cap** (OR-branch) | Upstream has no cap; pi-crew `resolveBatchConcurrency` + Semaphore |

### T1 — banner + API-freeze language: NOT met

- `packages/durable/README.md:3` @ `cdaf6c227`, verbatim:
  > **Experimental.** The API changes without notice between releases.
- The banner is README-only: `git grep -i "experimental"` over `packages/durable/src/` finds
  only doc-comments in `src/harness/events.ts:58,157` (agent events specifically) — no header
  banners in src.
- `packages/durable/CHANGELOG.md` contains **zero** API-freeze / stability / compat language
  (grep `api.?freeze|stable|semver|backward|compat` = 0 hits). Instead `[Unreleased]` opens
  with `### Breaking Changes` — five bullets, including the tagged-union and `content → output`
  renames blacklisted below. Expectation from the spec ("expect `[Unreleased]` with breaking
  entries instead") held exactly.

### T2 — multi-process story: NOT met

- Path note vs the spec: there is no `packages/durable/src/experimental/` anymore. The
  multi-process machinery lives in **`packages/coding-agent/src/experimental/`**
  (`session-worker.ts`, `session-worker-manager.ts`, `services/`, `durable/`, `vacation/`,
  `server.ts`, `process.ts`, `coordinator.ts`/`coordinator-entry.ts`, `client*.ts`,
  `session-catalog.ts`, `radius-*.ts`, `plugin.ts`, `plugins/`) — i.e. the "lateral promotion
  out of `src/experimental/` into a package" flagged in the spec continued, but **everything
  still sits under an `experimental/` directory**. No file graduated to the stable surface.
- The services stack is explicitly env-gated —
  `packages/coding-agent/src/experimental/services/README.md:28`: "With `PI_EXPERIMENTAL=1`, an
  interactive `pi client` creates and attaches a Session before opening the service-only chat TUI."
- The README's own TODO header (line 38) is prefixed "Deferred while the worker moves from the
  removed `AgentHarness` to `@earendil-works/pi-durable`" — the story is still mid-migration.

### T3 — subagent conversations via services: NOT met

- `packages/coding-agent/src/experimental/services/README.md` `## TODO` block (lines 38–45) is
  still open. Line 44, verbatim:
  > Subagents: the services cover only the root conversation. Exposing subagent conversations
  > needs keyed service instances per conversation.
- This is the same TODO the spec cited (`services/README.md:38-45`); at `cdaf6c227` it has
  simply not been closed. No keyed-per-conversation service instances exist yet.

### T4 — scheduler concurrency cap: MET via pi-crew's own cap (OR-branch)

- **Upstream durable has NO concurrency cap.** Grep for
  `concurren|maxParallel|maxPending|cap` across `packages/durable/src/` (incl.
  `src/harness/scheduler.ts`) returns only incidental comments — no limit setting, no
  `HarnessSettings` knob.
- Commit `cb437549318e06de1c3b00786f84236a0a4c896e` (2026-10-10)
  `fix(durable): scheduler no longer visits every live task on each pass` changed the **pass
  algorithm**, not concurrency: it added in-memory ownership indexes (`#below`, `#intent`,
  `#unloaded`, `#finalizeChecks`, `#runnable`, `#waiters`; commit message: "No walk recurses"),
  with perf claims (500-task chain 12.3 s → 50 ms; 8000 nested calls 18.8 s → 9.2 s). Follow-ups
  `ea448f454` (ownership indexes bounded by live work) and `f44707e7f` (document cache bounded by
  use, `documentRetentionMs`) are memory-bounding work — again no cap.
- **pi-crew's own cap exists and is deemed sufficient** (the spec's OR-branch):
  `src/runtime/scheduling/concurrency.ts` `resolveBatchConcurrency` resolves
  `maxConcurrent` from `limitMaxConcurrentWorkers` → team `maxConcurrency` → workflow
  `maxConcurrency` → per-workflow defaults, bounded by `hardCap` and
  `src/runtime/scheduling/global-worker-cap.ts`; execution is gated by the signal-aware
  `Semaphore` in `src/runtime/scheduling/semaphore.ts`. The upstream scheduler therefore adds
  nothing pi-crew still needs for T4.
- Counted as **met (1/4)** — but note this says nothing about upstream maturity; it only
  removes the "pi-crew lacks a cap" gap from the original U12 concern list.

## Blacklist — unreleased churn NOT to depend on (append 2026-10-11)

All seven items verified present in `git show origin/main:packages/durable/CHANGELOG.md`
`[Unreleased]` at `cdaf6c227`. Exact upstream wording per item (section in parens):

1. **`ToolTaskInput`/`ToolTaskResult` → tagged unions** *(Breaking Changes)*:
   "`ToolTaskInput` and `ToolTaskResult` are tagged unions: a model-issued call is
   `{ kind: \"model\", ... }` with its previous fields, a nested call `{ kind: \"nested\", ... }`.
   `pi.tool` is version 2 and migrates live version 1 tasks."
2. **`ToolExecutionResult.content` → `output`** *(Breaking Changes)*:
   "`ToolExecutionResult.content` is now `output`, next to the new `structuredOutput`."
3. **`StorageRejected` REMOVED — storage throw ends Session → `SessionFailed`** *(Breaking
   Changes)*: "Any error a `Storage` method throws, a read included, now fails the Session,
   which closes itself: every later call and every pending wait rejects with `SessionFailed`,
   whose `cause` is that error, and nothing is retried. `StorageRejected` is removed; a storage
   retries its own transient failures and throws the new `StorageRequestError` for an invalid
   request, which fails only that call." (Upstream commit `eba849739` — the only delta-window
   commit touching a surface pi-crew consumes, one line in `vacation.ts`.)
4. **`bash` nonzero exit → error result instead of throw** *(Breaking Changes)*:
   "`bash` and `powershell` answer a nonzero exit with an error result carrying an `exit_code`
   diagnostic, instead of throwing (`tool_error`)."
5. **`TaskRuntime.ownedTasks()` / `abortOwned()`** *(Added)*:
   "`TaskRuntime.abortOwned(id, context)`: abort a task this task owns and wait until it is
   terminal." and "`TaskRuntime.ownedTasks(context)`: the live tasks a task owns directly,
   whichever invocation created them, as copies. A tool call settling finds the nested calls it
   left running with it."
6. **`TaskOptions.abandonOnRestart`** *(Added)*: "`TaskOptions.abandonOnRestart`: a task its
   creator awaits only in memory is aborted, with its owned work, when a later Harness starts
   scheduling, before any of it runs again. Its mark carries `abortReason: \"restart\"`, which
   cascades; such a task waits for a missing definition instead of becoming `orphaned`."
7. **One-doc-per-nested-call** *(Fixed — semantic, not just perf)*: "… a tool making 8000
   parallel nested calls finishes in 2.7 s instead of 18.8 s, with one document per nested call
   instead of one growing index (`npm run bench:scheduler-fanout`)."

None of the seven required the "delta-report claim, upstream wording not found" fallback — all
were found verbatim in the upstream `[Unreleased]` changelog.

### Pre-existing policy language carried forward (from spec U12)

- No adoption while: experimental banner stands, breaking changes ship in patch/minor,
  single-process storage without cross-process lock / multi-writer, subagent conversations not
  exposed via services (§13 #7 of the spec's research).
- Compat ground-truth = installed pins (`^1.0.4` dev deps today; no `pi-durable` dep at all).
  Semver is meaningless in an unreleased-churn monorepo — trigger language (T1–T4 above),
  never version numbers, decides re-evaluation.
- When ≥ 3/4 triggers fire: consider replacing state-store (U8 direction) and the worker
  internal runtime with durable conversations, behind an exact pin + release gate.

## Overall verdict (2026-10-11, `cdaf6c227`)

**Still track-only. 1/4 triggers satisfied (T4 only via pi-crew's own cap; T1/T2/T3 all open),
against a ≥ 3/4 bar.** Upstream heat remains high and, per T1, is still producing breaking
churn inside `[Unreleased]` (5 breaking bullets, 3 of which rename or remove APIs). Do not add
a `pi-durable` dependency; do not import from it; keep recording new `[Unreleased]` breaking
entries here on each re-check.

**Next re-check trigger: the next pi npm release** (durable or coding-agent version bump
published to npm). Re-run T1–T4 against the new `origin/main` pin, append any new
`[Unreleased]` breaking changes to the blacklist, and only re-open the adoption question if
the count reaches ≥ 3/4.
