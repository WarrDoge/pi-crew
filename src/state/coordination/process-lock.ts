/**
 * U21 (upgrade 2026-10-13): process-level lock guard for the async run-lock
 * path (dual guard supplement in locks.ts `withRunLock`).
 *
 * A lock owned by the kernel for the holder's lifetime: on Linux/Android an
 * ABSTRACT unix socket (address `\0pi-crew-<sha256-32>`) vanishes with its
 * process, so there is no stale state to take over and no race between two
 * would-be owners. On Windows a named pipe has the same kernel-lifetime
 * property. Other unix platforms (darwin/BSD) need a socket FILE: removed on
 * process exit; a leftover one nobody accepts on is taken over.
 *
 * NO environment variable is involved — the lock is acquired in-process and
 * the lock NAME is derived from the protected path by the caller. This is a
 * deliberate deviation from the vendored source (which passes a lock name to
 * forked children via env): pi-crew's child env allowlist strips PI_CREW_*
 * ambient keys (§12.2.1), and nothing about the lock needs to be inherited.
 *
 * NAME CONVENTION: the socket/pipe namespace is system-wide, NOT per-user —
 * callers namespace their names by uid when the protected path can be shared
 * across users (see locks.ts `runLockSocketName`, F2 2026-10-14) so two users
 * on the same path do not collide.
 *
 * VENDORED (adapted, not copied verbatim) from `@earendil-works/chord` (MIT),
 * packages/chord/src/manager.ts:82-170 @ a4d040d30 — see NOTICE.md.
 * Adaptations beyond renaming the namespace:
 *   - `server.unref()` — a held lock must never keep the extension host
 *     process alive on its own (chord relies on its driver lifecycle instead);
 *   - `release()` force-closes lingering probe connections so it can never
 *     hang a caller's `finally` (chord only `end()`s accepted sockets);
 *   - typed `ProcessLockHeldError` carrying `reason: "locked"` instead of the
 *     vendor's generic error class.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/** Handle for a held process lock; `release()` is idempotent. */
export interface ProcessLockHandle {
	release(): Promise<void>;
}

/**
 * Thrown when the lock is held by a LIVE owner (the kernel answered the listen
 * with EADDRINUSE and, on file sockets, a probe confirmed somebody accepts).
 * `reason: "locked"` mirrors the vendor's structured-error contract.
 */
export class ProcessLockHeldError extends Error {
	readonly reason = "locked" as const;
	constructor(name: string) {
		super(`process lock '${name}' is held by another process`);
		this.name = "ProcessLockHeldError";
	}
}

/** Type guard for the held-error shape (contention signal for callers). */
export function isProcessLockHeldError(error: unknown): error is ProcessLockHeldError {
	return error instanceof ProcessLockHeldError;
}

/** sun_path holds 104 bytes on macOS and the BSDs, including the terminating NUL. */
const MAX_SOCKET_PATH_BYTES = 103;

function lockKey(name: string): string {
	return createHash("sha256").update(name).digest("hex").slice(0, 32);
}

/**
 * The lock socket's file path: in the temporary directory, or — when that path
 * does not fit in sun_path (a deep TMPDIR, e.g. a macOS per-user one) — in a
 * private per-user directory under /tmp that only its owner can access.
 * (Non-Linux/non-Windows branch only; Linux uses abstract sockets.)
 */
function fileSocketAddress(key: string): string {
	const preferred = path.join(os.tmpdir(), `pi-crew-${key}.sock`);
	if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
	const uid = process.getuid?.() ?? 0;
	const directory = `/tmp/pi-crew-${uid}`;
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stats = fs.lstatSync(directory);
	if (!stats.isDirectory() || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
		throw new Error(`process-lock: lock directory ${directory} must be a directory only its owner can access`);
	}
	return path.join(directory, `pi-crew-${key}.sock`);
}

interface SocketAddress {
	/** Listen address: `\0…` abstract (Linux), `\\.\pipe\…` (Windows) or a file path. */
	address: string;
	/** True when the address is a filesystem socket file (needs exit cleanup + corpse takeover). */
	file: boolean;
}

function socketAddress(name: string): SocketAddress {
	const key = lockKey(name);
	if (process.platform === "win32") {
		return { address: `\\\\.\\pipe\\pi-crew-${key}`, file: false };
	}
	if (process.platform === "linux" || process.platform === "android") {
		// Abstract namespace — kernel-owned, vanishes with the process.
		return { address: `\0pi-crew-${key}`, file: false };
	}
	return { address: fileSocketAddress(key), file: true };
}

/** True when a live server accepts connections on `address` (leftover-corpse probe). */
function accepting(address: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect(address);
		socket.unref();
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			// ECONNREFUSED/ENOENT → a corpse nobody serves: caller may take over.
			resolve(error.code !== "ECONNREFUSED" && error.code !== "ENOENT");
		});
	});
}

/**
 * Acquire the process lock for `name`. Resolves with a handle once THIS process
 * owns the kernel socket; rejects with {@link ProcessLockHeldError}
 * (`reason: "locked"`) when a live owner holds it. On file-socket platforms a
 * leftover socket file from a crashed holder is probed and taken over.
 */
export async function acquireProcessLock(name: string): Promise<ProcessLockHandle> {
	const { address, file } = socketAddress(name);
	const server = net.createServer((socket) => socket.end());
	for (;;) {
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error): void => reject(error);
				server.once("error", onError);
				server.listen(address, () => {
					server.removeListener("error", onError);
					resolve();
				});
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
				try {
					server.close();
				} catch {
					/* never listened — nothing to close */
				}
				throw error;
			}
			// EADDRINUSE: a live owner holds the kernel object — EXCEPT on file
			// sockets, where a crashed holder may have left the file behind.
			if (!file || (await accepting(address))) {
				try {
					server.close();
				} catch {
					/* never listened — nothing to close */
				}
				throw new ProcessLockHeldError(name);
			}
			// Corpse file nobody serves — remove it and listen again.
			fs.rmSync(address, { force: true });
		}
	}
	// A held lock must never keep the (long-lived extension host) process alive
	// on its own: the socket dies with the process either way, which is exactly
	// the lock's lifetime contract.
	server.unref();
	// Post-listen errors on a lock server are near-impossible (abstract sockets
	// are kernel-owned), but an UNHANDLED 'error' event would crash the host —
	// observe instead of crash. The lock stays held until release()/exit.
	server.on("error", () => {
		/* observed only — see comment above */
	});

	const removeFile = (): void => {
		try {
			fs.unlinkSync(address);
		} catch {
			/* already gone */
		}
	};
	if (file) process.once("exit", removeFile);

	let released = false;
	return {
		release: () =>
			new Promise<void>((resolve, reject) => {
				if (released) {
					resolve();
					return;
				}
				released = true;
				if (file) process.removeListener("exit", removeFile);
				// Force-close any lingering probe connections so the close
				// callback always settles (a hung release would hang the run-lock
				// `finally` that awaits it).
				(server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
