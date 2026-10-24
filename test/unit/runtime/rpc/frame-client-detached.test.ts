/**
 * frame-client-detached.test.ts — fix-wave 11a (F4) pins.
 *
 * GAP-4: the prototype RPC frame client spawned pi WITHOUT `detached`, so the
 * RPC child was not a process-group leader and a group-targeted teardown could
 * never reach its descendants. Wave 11a mirrors the headless branch:
 * `detached` on POSIX (does NOT detach the piped stdio), off on Windows.
 *
 * (e2) the exported option builder marks POSIX children as group leaders and
 *      keeps all three pipes, AND the default spawner actually uses it,
 * (e3) framing still round-trips through a fake stream (detached changes no
 *      framing behaviour),
 * (e4) a simulated win32 platform never asks for `detached: true`.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { createRpcFrameClient, frameClientSpawnOptions } from "../../../../src/runtime/rpc/frame-client.ts";
import { createFakeRpcServer, delay } from "./fake-rpc-stream.ts";

const SRC = path.join(import.meta.dirname, "..", "..", "..", "..", "src", "runtime", "rpc", "frame-client.ts");

test("(e2) POSIX spawn options: detached group leader + three piped stdio", () => {
	const options = frameClientSpawnOptions("linux");
	assert.equal(options.detached, true, "POSIX RPC children must lead their own process group");
	assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"], "detached must NOT detach the frame pipes");
	assert.equal(options.windowsHide, true);
	assert.equal(frameClientSpawnOptions("darwin").detached, true);
});

test("(e2b) the default spawner routes through frameClientSpawnOptions (static pin)", () => {
	const source = fs.readFileSync(SRC, "utf-8");
	assert.match(
		source,
		/spawn\(command,\s*args,\s*frameClientSpawnOptions\(process\.platform\)\)/,
		"defaultSpawnFn must pass the shared options builder to spawn() — an inline spawn() would bypass the group-leader flag",
	);
});

test("(e3) frames still round-trip with the detached spawner in place", async () => {
	const fake = createFakeRpcServer();
	const client = createRpcFrameClient({ spawnFn: () => fake.handle, commandTimeoutMs: 250, stopTimeoutMs: 120 });
	const pending = client.sendCommand({ type: "get_state" });
	fake.writeRaw(`${JSON.stringify({ id: "pi-crew-rpc-1", type: "response", command: "get_state", success: true })}\n`);
	await delay(10);
	await pending;
	assert.equal(client.counters().responsesMatched, 1);
	assert.equal(client.counters().malformedFrames, 0);
	await client.stop();
	fake.exitWith(0);
});

test("(e4) simulated win32 never requests detached: true", () => {
	const options = frameClientSpawnOptions("win32");
	assert.equal(options.detached, false, "Windows has no process groups — no detached spawn");
	assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
});
