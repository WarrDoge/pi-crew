/**
 * proc-tree-leader.mjs — fixture for reap-group.test.ts (fix-wave 11a).
 *
 * Spawns TWO children in its OWN process group (default spawn inherits the
 * group), waits until each kid reports READY on stdout (so the test cannot
 * deliver a signal before the kids installed their handlers), prints
 * `{"leader":<pid>,"kids":[<pid>,<pid>]}` as a single JSON line on stdout, then
 * stays alive. The test spawns THIS file with `detached: true`, so the leader is
 * its own group leader and its kids are group members — the exact topology
 * `reapGroup()` must be able to reclaim after the leader is SIGKILLed.
 *
 * Arg `ignore-term`: kids install a no-op SIGTERM handler, so only SIGKILL can
 * take them down (this is how the "killed-after-escalation" outcome is proven).
 */

import { spawn } from "node:child_process";

const ignoreTerm = process.argv.includes("ignore-term");
const kidCode = [
	"process.on('SIGTERM', () => {});",
	"process.stdout.write('ready\\n');",
	"setInterval(() => {}, 1000);",
].join(" ");

const kids = [0, 1].map(() =>
	spawn(process.execPath, ["-e", kidCode], { stdio: ["ignore", "pipe", "ignore"], detached: false, windowsHide: true }),
);

let reported = 0;
const announce = () => {
	reported++;
	if (reported < kids.length) return;
	process.stdout.write(`${JSON.stringify({ leader: process.pid, kids: kids.map((kid) => kid.pid), ignoreTerm })}\n`);
};

for (const kid of kids) kid.stdout.once("data", announce);
// The leader itself must stay alive so the test, not the fixture, decides when
// it dies (SIGKILL is delivered by the test).
setInterval(() => {}, 1000);
