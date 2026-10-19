import { getCrewEnv } from "../config/env-vars.ts";

export function logInternalError(scope: string, error: unknown, details?: string, severity?: "error" | "warn" | "debug"): void {
	// "error" and "warn" always emit; "debug" (default) is gated behind PI_TEAMS_DEBUG.
	// R45-F4: this is a RAW truthiness check — ANY non-empty value enables debug
	// logging, including `PI_TEAMS_DEBUG=0` / `=false` / `=off`. Unset the variable to
	// silence debug output; do not set it to "0". (Same raw-truthiness shape as
	// PI_CREW_DEBUG in background-runner.ts:63.)
	if (!severity || severity === "debug") {
		if (!getCrewEnv("PI_TEAMS_DEBUG")) return;
	}
	const message =
		error instanceof Error ? error.message : typeof error === "object" && error !== null ? JSON.stringify(error) : String(error);
	const suffix = details ? `: ${details}` : "";
	console.error(`[pi-crew:${scope}] ${message}${suffix}`);
}
