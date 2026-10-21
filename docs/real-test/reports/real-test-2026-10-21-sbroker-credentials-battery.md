# Real-Test Battery — Broker credentials completion (auth.json + OpenAI) — 2026-10-21

Base v0.11.33 (`34ef039b`) → target v0.11.34 (ONE version bump per user constraint).

## Changed surfaces
- `src/runtime/child-pi/inference-broker.ts` — multi-provider routes (path-prefix
  routing, per-provider substituted auth), auth.json fallback (read once, env
  wins), OpenAI usage names, fail-closed trace.
- `src/config/env-vars.ts` / `env-allowlist-registry.ts` — 2 test-only upstream
  overrides (ANTHROPIC/OPENAI); snapshot pin updated.
- `test/unit/runtime/child-pi/inference-broker.test.ts` — 15 → 18 tests.

## Tiers run
| Tier | Result |
|---|---|
| T1 critical | 124/124 |
| Broker battery | 18/18 — incl. LIVE e2e ×2 (anthropic route AND openai route with a REAL `pi -p` run; both upstreams saw the real substituted keys; worker envs credential-less) |
| Mutation ×3 (new) | auth.json-ignored → h1 red · first-route-collapse → b3+i1+g2 red (incl. LIVE) · openai-usage-dropped → i1 red — restored green |
| Env-splice (S\*) regression | 12/12 |
| Unit full (canonical runner) | 9855/9851/0 — one F14 preload-idle-render failure traced to LOCAL ENV (direct `node --test` runs against the machine's LIVE crew session state; v0.11.33 checkout reproduces it; canonical runner with isolated HOME = green ×2; full rerun green) — not a regression |
| Integration | 147/143/0 |
| lint / tsc / meta gates | 0 / 0 / all 0 |
| T7 live | BANANA-MULTI ×9, usage 12.2k tok, prune-anchor silence — broker-off default unchanged |

## Notes
- Scoped models.json now emits ONLY resolvable providers, each with a
  path-prefixed baseUrl; override-only (no model lists) so built-ins survive.
- bwrap/OS-boundary (host-file + egress) remains the documented follow-up —
  out of this single-version scope by design.

## Verdict
**GO** for v0.11.34.
