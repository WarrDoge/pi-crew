# test/helpers — fixture process lifecycle

Rules for anything a test spawns. Written after fix-wave 12: two fixtures of the
shape `node -e "process.on('SIGTERM',()=>{}); setInterval(...)"` were found alive
**> 6 h** after their run had completed, re-parented to systemd. Both were test
fixtures with `finally { child.kill() }` teardown.

## The one rule

`finally { child.kill() }` is NOT teardown. It is a pid-only signal: it cannot
reach a tree, it is a no-op against a process that swallows `SIGTERM`, and it
never runs at all when the spawn happens after the throw.

## Detached fixture ⇒ group reap (mandatory)

A fixture spawned with `detached: true` owns its process group, so it is
unreachable from the test runner's group. Teardown MUST be a group reap carrying
the identity snapshot taken at spawn time:

```ts
import { reapFixture, spawnFixture } from "../../helpers/fixture-process.ts";

test("…", async () => {
	const handle = spawnFixture([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
	try {
		// … assertions
	} finally {
		await reapFixture(handle); // SIGTERM → SIGKILL escalation, never throws
	}
});
```

- `reapFixture` never throws — it runs in `finally`, where a throw would mask the
  failure under test. It is safe to call twice.
- Refusals that PROVE the pid is a stranger (`starttime-mismatch`,
  `uid-mismatch`, `not-group-member`) signal nothing — never pid-kill a reused
  pid.

## Non-detached fixture ⇒ pid kill (also mandatory)

`spawnFixture` **throws** on `detached: false`, and that is the point: a
non-detached child shares the **test runner's** group, so a group kill rooted at
it signals the runner, its sibling test files and the harness. Spawn those with
`child_process.spawn` directly and tear them down pid-only, with the reason in a
comment:

```ts
// non-detached: pid-only by design (shares runner's group)
child.kill("SIGKILL");
```

## Always snapshot identity at spawn

`spawnFixture` calls `readProcIdentity(pid)` immediately and normalises `pgid` to
`pid` (a detached child leads its own group). The snapshot is what makes the
later group kill reuse-proof: between spawn and reap the pid may be recycled by
an unrelated group. Never read the identity in the `finally` — by then the
process is gone and the read proves nothing.

## `registerFixtureTrap()` — for the abort window

A `finally` cannot protect a fixture spawned before an assertion throws in a
`before`/setup hook. Register the handle for the two shutdown paths a test file
has (`after()` plus a synchronous `process.on("exit")` flush of the armed SIGKILL
rung):

```ts
const handle = spawnFixture([process.execPath, SCRIPT]);
registerFixtureTrap([handle]); // idempotent; installs the hooks exactly once
```

## Symptom → cause

Orphan `node -e "setInterval(...)"` processes carrying `PI_CREW_KIND=subagent`
while the run is already `completed` are **test fixtures**, not a runtime leak:
the wave-11 descendant sweep correctly refuses processes that do not prove a
run descent. Audit test teardown before suspecting `src/`.
