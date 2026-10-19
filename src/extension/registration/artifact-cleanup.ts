import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_ARTIFACT_CLEANUP, DEFAULT_PATHS } from "../../config/defaults.ts";
import { CLEANUP_MARKER_FILE, cleanupOldArtifacts, pruneExpiredArtifacts } from "../../state/stores/artifact-store.ts";
import type { ArtifactDescriptor, TeamRunManifest } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { projectCrewRoot, userCrewRoot } from "../../utils/paths.ts";
import { resolveContainedRelativePath } from "../../utils/safe-paths.ts";

/**
 * ST-10 + R44-N1: artifact descriptors for ONE run, paired with the run's
 * HOST-DERIVED artifacts root (containment anchor). The anchor is computed
 * from the runs directory being scanned (`<crewRoot>/state/runs/<runId>` →
 * `<crewRoot>/artifacts/<runId>` — the same convention `createRunPaths`
 * derives), NEVER from the worker-writable manifest itself: a malicious
 * manifest must not be able to nominate its own prune boundary.
 */
export interface RunArtifactGroup {
	runId: string;
	/** Host-derived per-run artifacts root (prune containment anchor). */
	artifactsRoot: string;
	descriptors: ArtifactDescriptor[];
}

/**
 * ST-10: Load artifact descriptors from all manifests in a runs directory,
 * grouped per run with the host-derived artifacts root for each run.
 * Best-effort: unreadable or corrupt manifests are silently skipped. Runs
 * whose DIRECTORY NAME cannot form a safe artifacts root (path-escape) are
 * skipped with a warn (fail-closed — their descriptors are never pruned).
 */
export function collectArtifactDescriptors(runsDir: string): RunArtifactGroup[] {
	const groups: RunArtifactGroup[] = [];
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(runsDir, { withFileTypes: true });
	} catch {
		return groups;
	}
	// runsDir = <crewRoot>/<state.runsSubdir> → the crew root sits two levels up
	// (mirrors state-store.ts validateRunManifestPaths' baseRoot derivation).
	const crewRoot = path.resolve(runsDir, "..", "..");
	const artifactsParent = path.join(crewRoot, DEFAULT_PATHS.state.artifactsSubdir);
	for (const dir of dirs) {
		if (!dir.isDirectory()) continue;
		let artifactsRoot: string;
		try {
			artifactsRoot = resolveContainedRelativePath(artifactsParent, dir.name, "runId");
		} catch (error) {
			// R44-N1 fail-closed: an unsafe run-dir name must not reach the prune
			// path at all — its descriptors are dropped, not anchored elsewhere.
			logInternalError(
				"artifact-cleanup.run-anchor",
				error instanceof Error ? error : new Error(String(error)),
				`runsDir=${runsDir} runId=${dir.name}`,
				"warn",
			);
			continue;
		}
		const manifestPath = path.join(runsDir, dir.name, DEFAULT_PATHS.state.manifestFile);
		try {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as TeamRunManifest;
			if (Array.isArray(manifest.artifacts)) {
				groups.push({ runId: dir.name, artifactsRoot, descriptors: manifest.artifacts });
			}
		} catch {
			// Skip unreadable/corrupt manifests — best-effort.
		}
	}
	return groups;
}

export function runArtifactCleanup(cwd: string): void {
	try {
		const userArtifactsRoot = path.join(userCrewRoot(), DEFAULT_PATHS.state.artifactsSubdir);
		const projectArtifactsRoot = path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.artifactsSubdir);

		// Existing age-based filesystem cleanup.
		cleanupOldArtifacts(userArtifactsRoot, {
			maxAgeDays: DEFAULT_ARTIFACT_CLEANUP.maxAgeDays,
			markerFile: CLEANUP_MARKER_FILE,
		});
		cleanupOldArtifacts(projectArtifactsRoot, {
			maxAgeDays: DEFAULT_ARTIFACT_CLEANUP.maxAgeDays,
			markerFile: CLEANUP_MARKER_FILE,
		});

		// ST-10 + R44-N1: enforce retention/expiresAt from manifest metadata,
		// per-run and containment-anchored — a run's descriptors can only prune
		// files under that run's OWN host-derived artifacts root.
		for (const scope of [userCrewRoot(), projectCrewRoot(cwd)]) {
			for (const group of collectArtifactDescriptors(path.join(scope, DEFAULT_PATHS.state.runsSubdir))) {
				pruneExpiredArtifacts(group.descriptors, { artifactsRoot: group.artifactsRoot });
			}
		}
	} catch (error) {
		logInternalError("register.artifact-cleanup", error, `cwd=${cwd}`);
	}
}
