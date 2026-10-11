/**
 * Windows-essential environment variables that MUST be present in every
 * subprocess env allowlist in pi-crew.
 *
 * Without them, child processes on Windows cannot locate the npm-global prefix
 * (`%APPDATA%\npm`), the user profile, system DLLs (SystemRoot), cmd.exe
 * (ComSpec), or a writable temp dir.
 *
 * Regression root cause (v0.9.0): env allowlists stripped these vars, so child
 * pi/npm resolved the npm-global prefix via the literal `%APPDATA%` (cmd) /
 * `${APPDATA}` (bash) expansion — but APPDATA was missing from the env, so the
 * shell left the literal `${APPDATA}` in place. A phantom `${APPDATA}/npm`
 * directory appeared in the project root and a literal `${APPDATA}` line leaked
 * into `.gitignore`.
 *
 * USAGE: spread this constant into every `allowList` array:
 *   `allowList: ["PATH", "HOME", ...WINDOWS_ESSENTIAL_ENV_VARS, ...]`
 *
 * The regression test `test/unit/env-allowlist.test.ts` enforces that no
 * `src/` file hardcodes these vars inline — all sites MUST use this constant
 * (which is why the DEFINITION stays in this file: the test pins THIS path as
 * the only literal-bearing location; src/config/env-allowlist-registry.ts
 * imports it as a building block for the generated allowlists — C-1).
 */
export const WINDOWS_ESSENTIAL_ENV_VARS: readonly string[] = [
	"APPDATA",
	"LOCALAPPDATA",
	"USERPROFILE",
	"SystemRoot",
	"ComSpec",
	"TEMP",
	"TMP",
];
