# Real-Test Battery — Wave 8 (8 LOW deferred items) — 2026-10-20

Base v0.11.28 (`d77ed5d0`) → target v0.11.29. Repo: `/home/bom/source/my_pi/pi-crew`.

## Changed surfaces (git diff)
- `src/runtime/child-pi/child-pi-rpc.ts` — R2-L-A7: refcounted env-splice canary window (spans `await startPromise` until post-spawn verification), darwin `ps -Eww` observer, win32 explicit unobservable signal, test seam `__runRpcSessionWithCtorForTests`.
- `src/runtime/classifier/classifier-service.ts` — R2-L-B8 site-2: choke-point `redactClassifyPayload` on every `registry.classify` payload.
- Tests: `env-splice-canary.test.ts` (9), `crew-broker-escalate-to-pin.test.ts` (3), `submit-result-error-result.test.ts` (2), classifier-service.test.ts (+2).
- Pins for already-fixed items whose record rows were stale: A4 (pin existed: mailbox-requestid-dedup), A6/B1 (new pins), B5 (behavior pins pre-existing), B7 (pin pre-existing, wave-4), M3-15 (wave-6).

## Ground-truth audit of the 8 "deferred LOW" items (grep-first)
| Item | Recorded | Reality |
|---|---|---|
| A4 | deferred | FIXED wave-2b + pinned |
| A6 | deferred | FIXED wave-2b, **unpinned** → pinned + mutation-checked |
| A7 | deferred | **NOT fixed** + NEW dead-window bug (canary deleted before the await ⇒ could never fire, even on Linux) → real fix |
| B1 | deferred | FIXED wave-2b, **unpinned** (record line 821 was right) → pinned + mutation-checked |
| B5 | deferred | FIXED, behavior pins pre-existing; perf itself not deterministically pinnable (accepted) |
| B7 | deferred | FIXED wave-2b, pin EXISTS (wave-4 "R2-L-B7 PIN UPDATE") |
| B8 | deferred | FIXED at noise gate BUT **second unredacted consumer found** (`child-executor` retryTriage → classifyBool) → choke-point fix in the service |
| M3-15 | by design | addressed wave-6 (`resilient-edit.ts` R49-F1 real-API rewrite) — closed |

## Tiers run (decision table: child-pi + classifier + broker surfaces)
| Tier | Result |
|---|---|
| T1 critical | 124/124 (1st run: 1 load-flake R6-6 client-fallback timer — isolated ×3 green + battery rerun green, adjudicated per flake protocol) |
| Unit (full, canonical runner) | 9822 tests / **0 fail** |
| Integration (full) | 147 tests / 143 pass / 0 fail |
| tsc / biome / lint | 0 / 0 / 0 |
| Meta gates | bundle build ✓ · staleness ✓ · lazy-imports ✓ · env-vars ✓ · decision-drift ✓ · conflict-markers ✓ · event-types `--enforce` ✓ (lesson from v0.11.28 applied — no new event types added this wave) |
| T7 live session | `pi -ne --extension dist/index.mjs` real session, exit 0, byte-check **BANANA-W8** present, provider usage surfaced (12,220 tok), prune-anchor silence held (0 lines) |
| Mutation checks | A6 (revert `to` validation → foreign-`to` red) · B1 (swallow throw → red) · B8 (disable choke → red) · **A7 (wave-2b ordering → WIRING drift test red)** — all restored green after |

## A7 evidence detail
- Live drift (linux, real `/proc`): window open → `node` child spawned mid-window → verify detects canary → false (kill).
- WIRING pin drives `runRpcSession` with a mock client whose `start()` awaits 25ms BEFORE spawning (exact SDK-drift shape): fixed → killed with `env allowlist splice failed`; wave-2b ordering → test red (mutation-proven; the ordering bug was accidentally live for one test run during development and the pin caught it immediately).
- win32: `onUnobservable` fires + one-time internal warn replaces the silent PASS.

## Deviations / disclosures
- T2/T4/T5/T6/T9/T10/T12/T13 not run: surfaces untouched per decision table (no UI/panes/surface/agent-frontmatter/team-tool changes; T4/T8 sync-child and bundle-md5 session serve unaffected — RPC transport exercised by unit rpc-mode suite + new wiring pin).
- T11j committed-hash runs post-commit (release gate).

## Verdict
**GO** for v0.11.29.
