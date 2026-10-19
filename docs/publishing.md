# Publishing pi-crew

This package is published as the scoped public npm package:

```text
pi-crew
```

Before publishing to npm:

1. Confirm package metadata in `package.json`:
   - `author`
   - `repository`
   - `homepage`
   - `bugs`
   - `publishConfig.access = public`
2. Confirm license and notices:
   - keep `LICENSE`
   - keep `NOTICE.md`
   - document copied/adapted MIT source if any substantial code is ported
3. Run checks:

```bash
npm run check
```

For a fast pre-publish smoke (124 broker/UI/config tests in ~15s, instead
of the full `npm run check` unit+integration suite, which takes minutes):

```bash
npm run test:critical && npm run typecheck && npm run build:bundle
```

4. Verify dist is clean and current ("dist clean check", WI-1.3):

```bash
git status --short dist/                          # must print NOTHING (clean)
node scripts/check-bundle-staleness.mjs --committed-hash   # must exit 0
```

A dirty or stale committed dist silently ships old code (the v0.9.x
stale-bundle incident class). If either check fails: `npm run build:bundle`,
then commit the bundle — `git add -f dist/ && git commit -- dist`
(dist/ is gitignored, so `-f` is required).

5. Verify package contents:

```bash
npm pack --dry-run
```

Confirm bundled skills ship (the `real-test-pi-crew` skill references
`scripts/pty_probe.py`):

```bash
npm pack --dry-run 2>&1 | grep -E 'skills/|pty_probe'
```

6. Verify local install in Pi:

```bash
pi install ./pi-crew
/team-doctor
/team-validate
```

7. Publish when ready:

```bash
npm publish --access public
```

Users can install the published package with:

```bash
pi install npm:pi-crew
```

### Pre-push hook (local release gate, D3)

The repo ships committed git hooks under `.githooks/`. A plain
`npm install` activates them via the `prepare` script
(`scripts/install-hooks.mjs` sets `git config core.hooksPath .githooks` —
idempotent, and a no-op when git or a repo is absent). Manual activation
in an existing clone:

```bash
git config core.hooksPath .githooks
```

Scope of `pre-push` (the release-gate broadening; `pre-commit` handles
lockfile drift):

- **push to `refs/heads/main`** — `check:conflict-markers` + `typecheck`,
  then the **FULL unit suite** (`npm run test:unit`, the same gate CI
  runs). Any failure blocks the push. This closes the 2026-10 gap where
  local pushes ran only `test:critical` (124 tests) while CI ran the full
  suite — three waves shipped red that way.
- **push to any other ref** — fast gates only (`check:conflict-markers` +
  `typecheck`).

Emergency bypass (CI still gates `main`):

```bash
git push --no-verify
```

### Postinstall

`npm install` / `pi install` triggers `scripts/postinstall.mjs`, which:

1. Builds the ESM bundle (`scripts/build-bundle.mjs`) — best-effort, falls
   back to strip-types loading if esbuild is missing.
2. Installs the bundled `crew-vibes.ttf` font into the user fonts directory.
3. Runs `cleanupStaleSkillCopies()` — a one-time migration that removes
   stale skill copies from `~/.pi/agent/skills/` left by v0.9.47's (now-removed)
   `copySkills()` step. Only removes **byte-identical** copies; user-customized
   skills are preserved. Pi discovers skills natively from the npm package's
   own `skills/` dir, so copies are never needed.

All three steps are best-effort and never fail the install.

## Config schema

The package exports:

```text
./schema.json
```

Use this for editor validation of the **current** config path
(`src/config/config.ts:208`; the `~/.pi/agent/extensions/pi-crew/config.json`
path is legacy/read-only-for-migration — see `docs/usage.md`):

```text
~/.pi/agent/pi-crew.json
```

## Known tarball / consumer-side notes (R26/R29 census, 2026-10-19)

Verified with `npm pack --dry-run`. These are **declared defects**, not hidden:

- **`skills/research/scripts/__pycache__/safe_io.cpython-312.pyc` ships** in the
  tarball (11.5 kB): the `files` entry `"skills/**"` plus the missing
  `.npmignore` rule means compiled Python bytecode is published and it embeds
  build-machine paths. Fix = add `__pycache__` to a `.npmignore` / tighten
  `files`.
- **Dev tooling ships to consumers:** `scripts/analyze-run.mjs` (64.5 kB),
  `scripts/resource-sampler.mjs`, `scripts/watch-agent-transcript.mjs`. Harmless
  bulk; consider moving them behind a dev-only entry.
- **Consumer-side git hooks reference scripts that are NOT published:**
  `scripts/install-hooks.mjs` (published) sets `core.hooksPath=.githooks`, and
  `.githooks/pre-commit` runs `node scripts/check-lockfile-sync.mjs` — but
  `files[]` ships neither `scripts/check-lockfile-sync.mjs` nor
  `scripts/test-runner.mjs`, so an installed-from-npm consumer's hook fails.
- **Peer range on `pi-coding-agent` is unbounded** (`>=1.0.4`, no ceiling) while
  the `pi-tui` peer IS bounded (`<2.0.0`); pi-crew consumes pi-tui symbols
  re-exported through `pi-coding-agent`, so a future 2.x installs clean and fails
  at load (R49-F2 — bounding it is prospective work).
- **Committed `dist/` must match the tag:** the `--committed-hash` gate reads the
  committed blob (`dist/index.mjs` — the ONLY tracked dist artifact) from the git
  object DB, so every commit that touches `src/` needs
  `npm run build:bundle && git add -f dist/index.mjs` rerun and committed
  (`dist/` is `.gitignore`d, hence `-f`).
