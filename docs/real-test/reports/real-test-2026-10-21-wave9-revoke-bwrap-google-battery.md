# Real-Test Battery — Wave 9: exit-revoke + bwrap OS boundary + google route — 2026-10-21

Base v0.11.35 (`04639e2c`) → target v0.11.36 (one version).

## Changed surfaces
- `src/runtime/child-pi/child-pi.ts` — runChildPi exit-revoke wrapper (finally);
  sandbox resolution before spawn; surface+rpc branches SKIPPED when sandbox on
  (fail-closed branch selection); headless spawn wrapped via bwrap.
- `src/runtime/child-pi/sandbox.ts` (NEW) — resolve/validate (fail-closed on
  bad value, non-linux, missing bwrap, net=off+broker), pure argv builder
  (mount ORDER pinned), toolchain binds (node bin dir, entry dir + node_modules
  ancestors, --extension/--skill walk to nearest package root).
- `src/runtime/child-pi/inference-broker.ts` — google route (x-goog-api-key,
  /v1beta upstream default, usageMetadata counting incl. thoughts); shared
  `inferenceWorkerKeyForAgent` + non-throwing `revokeInferenceWorkerForAgent`.
- `src/runtime/child-pi/child-pi-spawn.ts` — key derivation via shared helper.
- `src/config/env-vars.ts` / `env-allowlist-registry.ts` / pin —
  PI_CREW_SANDBOX, PI_CREW_SANDBOX_NET, PI_CREW_INFERENCE_UPSTREAM_GOOGLE.
- lazy budget 533 → 534 (sandbox.ts static import — sync spawn path).

## Tiers run
| Tier | Result |
|---|---|
| T1 critical | 124/124 |
| Sandbox battery (NEW) | 9/9 — config fail-closed (a1-a3), availability fail-closed (b1), argv pure (c1-c3), **REAL bwrap smoke (d1: host ~/.pi invisible + cwd writable; d2: net=off → loopback unreachable)** |
| Broker battery | 21/21 — google (j1: x-goog-api-key substitution, prefix strip verbatim incl. query, usageMetadata 40/12, models.json bare /google), precedence GOOGLE>GEMINI>auth.json (j2), revoke helper (k1) |
| Revoke WIRING (NEW) | 1/1 — aborted-before-spawn runChildPi leaves NO orphan token (registration-before-B5 probe path) |
| Mutation ×4 | wrapper-revoke removed → wiring red · bwrap-missing fail-open → b1 red · net=off+broker guard off → a3 red · google usage dropped → j1 red — restored green |
| LIVE production-path e2e | `pi` THẬT chạy trong bwrap qua runChildPi: marker SBX-LIVE-OK, exit 0, upstream nhận REAL key (x-api-key), worker env credential-less, stats rỗng sau run (exit-revoke sống ngoài mock) |
| Unit full (canonical runner) | 9854/9850/0 |
| Integration | 147/143/0 |
| lint / tsc / meta gates | 0 / 0 / all 0 |
| T7 live (dist mới) | BANANA-36WAVE ×9, prune-anchor silence — sandbox-off default unchanged |

## Honest boundary (pass 1)
- net=share (mặc định khi sandbox on + broker): egress KHÔNG bị chặn — chỉ
  host-file bị chặn. net=off chặn hết nhưng loại broker (từ chối config).
- TUI surface + rpc branch bị SKIP khi sandbox on (không sandbox pane) — mọi
  worker lấy đường headless sandboxed.
- Sandbox + broker OFF = worker không có credential gì cả (by isolation).

## Verdict
**GO** for v0.11.36.

## SHIP TRAIL
- v0.11.36 `08f029e9` — CI RED on the FORMAT gate (biome format diffs in 4 wave-9
  files). Local `npm run lint` does NOT run `format:check` — new pre-push lesson:
  run BOTH before pushing.
- v0.11.37 `a4e15280` — CI run 39714639415 GREEN after 1 adjudicated rerun-failed
  (team-runner-merge streaming-dispatch DAG on windows/Node24 — isolated green x2,
  known timing-flake class; not a wave-9 file).
- npm `+ pi-crew@0.11.37`; dist-tags.latest=0.11.37; release v0.11.37 (Latest).
- v0.11.36 tag NOT published (red CI).
