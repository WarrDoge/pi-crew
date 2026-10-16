/**
 * N-5 (DR-04 round 7): handleCancel used to terminate live agents and kill the
 * async background runner BEFORE the in-lock fresh read + terminal
 * short-circuit, on the STALE pre-lock snapshot — a run that completed during
 * the before_cancel hook gap was still torn down. The signal must now derive
 * from the FRESH in-lock status and only fire while the run is still
 * "running". These tests use a real (harmless) dummy runner process as the
 * observable "signal was sent / not sent".
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleCancel } from "../../../../src/extension/team-tool/cancel.ts";
import { readEvents } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function createOwnedRun(ownerSessionId: string): {
	cwd: string;
	runId: string;
	manifest: ReturnType<typeof createRunManifest>["manifest"];
} {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cancel-kill-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = {
		name: "cancel-kill",
		description: "",
		roles: [{ name: "worker", agent: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "wf",
		description: "",
		steps: [{ id: "one", role: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const created = createRunManifest({
		cwd,
		team,
		workflow,
		goal: "cancel kill gate",
		ownerSessionId,
	});
	return { cwd, runId: created.manifest.runId, manifest: created.manifest };
}

/** Patch the on-disk manifest (fresh in-lock reads must see this state). */
function patchManifestOnDisk(
	manifest: ReturnType<typeof createRunManifest>["manifest"],
	mutate: (m: Record<string, unknown>) => void,
): void {
	const manifestPath = path.join(manifest.stateRoot, "manifest.json");
	const onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
	mutate(onDisk);
	fs.writeFileSync(manifestPath, `${JSON.stringify(onDisk, null, 2)}\n`, "utf-8");
}

function spawnDummyRunner(): ChildProcess {
	return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killDummy(child: ChildProcess): void {
	try {
		child.kill("SIGKILL");
	} catch {
		/* already gone */
	}
}

test("N-5: cancelling a run that is already completed on disk sends NO signal to the async runner", async () => {
	const run = createOwnedRun("session-a");
	const child = spawnDummyRunner();
	assert.ok(child.pid, "dummy runner must have a pid");
	try {
		saveRunTasks(run.manifest, [
			{
				id: "task-1",
				runId: run.runId,
				role: "worker",
				agent: "worker",
				title: "task",
				status: "completed",
				dependsOn: [],
				cwd: run.cwd,
			},
		]);
		// The run completed (e.g. during the before_cancel hook gap) but the
		// stale pre-lock snapshot era would still have killed async.pid.
		patchManifestOnDisk(run.manifest, (m) => {
			m.status = "completed";
			m.async = { pid: child.pid, logPath: "/dev/null", spawnedAt: new Date().toISOString() };
		});

		const out = await handleCancel({ action: "cancel", runId: run.runId }, { cwd: run.cwd, sessionId: "session-a" });
		assert.equal(out.isError, false, "terminal short-circuit returns a non-error result");

		await sleep(150); // give any (wrongly sent) signal time to land
		assert.equal(pidAlive(child.pid), true, "completed run must NOT receive a signal (N-5)");
		const events = readEvents(run.manifest.eventsPath);
		assert.equal(
			events.some((event) => event.type === "async.kill_requested"),
			false,
			"no async.kill_requested event for an already-terminal run",
		);
	} finally {
		killDummy(child);
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});

test("N-5 (control): cancelling a still-running run still signals the async runner", async () => {
	const run = createOwnedRun("session-a");
	const child = spawnDummyRunner();
	assert.ok(child.pid, "dummy runner must have a pid");
	try {
		saveRunTasks(run.manifest, [
			{
				id: "task-1",
				runId: run.runId,
				role: "worker",
				agent: "worker",
				title: "task",
				status: "running",
				dependsOn: [],
				cwd: run.cwd,
			},
		]);
		patchManifestOnDisk(run.manifest, (m) => {
			m.status = "running";
			m.async = { pid: child.pid, logPath: "/dev/null", spawnedAt: new Date().toISOString() };
		});

		const out = await handleCancel({ action: "cancel", runId: run.runId }, { cwd: run.cwd, sessionId: "session-a" });
		assert.equal(out.isError, false);

		// The dummy runner (legacy one-shot SIGTERM path) must terminate.
		let exited = false;
		for (let i = 0; i < 40 && !exited; i++) {
			await sleep(50);
			exited = !pidAlive(child.pid);
		}
		assert.ok(exited, "running run cancel must still SIGTERM the async runner");

		// The informational kill event is fire-and-forget — poll until it lands.
		let sawKillEvent = false;
		for (let i = 0; i < 40 && !sawKillEvent; i++) {
			await sleep(50);
			sawKillEvent = readEvents(run.manifest.eventsPath).some((event) => event.type === "async.kill_requested");
		}
		assert.ok(sawKillEvent, "async.kill_requested event must be recorded for a running cancel");
	} finally {
		killDummy(child);
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});
