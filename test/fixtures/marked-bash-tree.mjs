/**
 * marked-bash-tree.mjs — fixture for run-descendant-sweep.test.ts (wave 11b).
 *
 * Models EXACTLY the topology of the incident: pi's bash tool spawns every
 * command `detached`, so the command is the leader of its OWN process group,
 * and the grandchild it starts lives in that group — unreachable by any group
 * kill rooted at the worker.
 *
 * The fixture itself is a "worker": it is spawned by the test with
 * `detached: true` and carries the pi-crew worker markers the sweep matches
 * (PI_CREW_KIND=subagent, PI_CREW_TASK_ID, PI_CREW_PARENT_PID=<dead pid>).
 * It spawns ONE detached "bash command" which in turn spawns ONE grandchild
 * holding an interval, then prints
 * `{"leader":<bash pid>,"grandkids":[<pid>]}` on stdout and stays alive.
 *
 * The test SIGKILLs the worker (the leader) and then sweeps: the surviving
 * grandchild must be found by its markers and reaped.
 */

import { spawn } from "node:child_process";

/** Holder: an infinite interval, so it only dies when it is signalled. */
const holder = "setInterval(() => {}, 1000);";
/** The "bash command": starts the grandchild, reports JSON, then idles. */
const commandCode = `
import { spawn } from "node:child_process";
const kid = spawn(process.execPath, ["-e", ${JSON.stringify(holder)}], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
process.stdout.write(JSON.stringify({ leader: process.pid, grandkids: [kid.pid] }) + "\\n");
setInterval(() => {}, 1000);
`;

const command = spawn(process.execPath, ["--input-type=module", "-e", commandCode], {
	// detached ⇒ the command is its own group leader (pi's bash tool shape).
	detached: true,
	stdio: ["ignore", "pipe", "ignore"],
	windowsHide: true,
});

command.stdout.once("data", (chunk) => {
	process.stdout.write(chunk);
});

// The fixture stays alive until the test SIGKILLs it.
setInterval(() => {}, 1000);
