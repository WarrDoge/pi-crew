/**
 * Parsed git source information.
 */
export type GitSource = {
	/**
	 * Always "git" for git sources.
	 */
	type: "git";
	/**
	 * Clone URL.
	 */
	repo: string;
	/**
	 * Git host domain (for example, "github.com").
	 */
	host: string;
	/**
	 * Repository path (for example, "org/repo").
	 */
	path: string;
	/**
	 * Git ref (branch, tag, or commit) if specified.
	 */
	ref?: string;
	/**
	 * Whether the source includes a pinned ref.
	 */
	pinned: boolean;
};

function splitRef(url: string): { repo: string; ref?: string } {
	const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		const pathWithMaybeRef = scpLikeMatch[2] ?? "";
		const atRefIndex = pathWithMaybeRef.indexOf("@");
		const hashRefIndex = pathWithMaybeRef.indexOf("#");
		let refSeparator = -1;
		if (atRefIndex >= 0 && hashRefIndex >= 0) {
			refSeparator = Math.min(atRefIndex, hashRefIndex);
		} else {
			refSeparator = atRefIndex >= 0 ? atRefIndex : hashRefIndex;
		}
		if (refSeparator < 0) {
			return { repo: url };
		}

		const repoPath = pathWithMaybeRef.slice(0, refSeparator);
		const ref = pathWithMaybeRef.slice(refSeparator + 1);
		if (!repoPath || !ref) {
			return { repo: url };
		}

		return {
			repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`,
			ref,
		};
	}

	if (url.includes("://")) {
		try {
			const parsed = new URL(url);
			const fragmentRef = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : "";
			parsed.hash = "";
			const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
			const atRefIndex = pathWithMaybeRef.indexOf("@");
			if (atRefIndex >= 0) {
				const repoPath = pathWithMaybeRef.slice(0, atRefIndex);
				const ref = pathWithMaybeRef.slice(atRefIndex + 1);
				if (!repoPath || !ref) {
					return { repo: parsed.toString().replace(/\/$/, "") };
				}
				parsed.pathname = `/${repoPath}`;
				return {
					repo: parsed.toString().replace(/\/$/, ""),
					ref,
				};
			}

			if (fragmentRef) {
				return {
					repo: parsed.toString().replace(/\/$/, ""),
					ref: fragmentRef,
				};
			}

			return { repo: parsed.toString().replace(/\/$/, "") };
		} catch {
			return { repo: url };
		}
	}

	const slashIndex = url.indexOf("/");
	if (slashIndex < 0) {
		return { repo: url };
	}

	const pathWithMaybeRef = url.slice(slashIndex + 1);
	const atRefIndex = pathWithMaybeRef.indexOf("@");
	const hashRefIndex = pathWithMaybeRef.indexOf("#");
	let refSeparator = -1;
	if (atRefIndex >= 0 && hashRefIndex >= 0) {
		refSeparator = Math.min(atRefIndex, hashRefIndex);
	} else {
		refSeparator = atRefIndex >= 0 ? atRefIndex : hashRefIndex;
	}
	if (refSeparator < 0) {
		return { repo: url };
	}

	const repoPath = pathWithMaybeRef.slice(0, refSeparator);
	const ref = pathWithMaybeRef.slice(refSeparator + 1);
	if (!repoPath || !ref) {
		return { repo: url };
	}

	return {
		repo: `${url.slice(0, slashIndex)}/${repoPath}`,
		ref,
	};
}

function parseGenericGitUrl(url: string): GitSource | null {
	const { repo: repoWithoutRef, ref } = splitRef(url);
	let repo = repoWithoutRef;
	let host = "";
	let path = "";

	const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		host = scpLikeMatch[1] ?? "";
		path = scpLikeMatch[2] ?? "";
	} else if (
		repoWithoutRef.startsWith("https://") ||
		repoWithoutRef.startsWith("http://") ||
		repoWithoutRef.startsWith("ssh://") ||
		repoWithoutRef.startsWith("git://")
	) {
		try {
			const parsed = new URL(repoWithoutRef);
			host = parsed.hostname;
			path = parsed.pathname.replace(/^\/+/, "");
		} catch {
			return null;
		}
	} else {
		const slashIndex = repoWithoutRef.indexOf("/");
		if (slashIndex < 0) {
			return null;
		}

		host = repoWithoutRef.slice(0, slashIndex);
		path = repoWithoutRef.slice(slashIndex + 1);
		if (!host.includes(".") && host !== "localhost") {
			return null;
		}

		repo = `https://${repoWithoutRef}`;
	}

	const normalizedPath = path.replace(/\.git$/, "").replace(/^\/+/, "");
	if (!host || !normalizedPath || normalizedPath.split("/").length < 2) {
		return null;
	}

	return {
		type: "git",
		repo,
		host,
		path: normalizedPath,
		ref,
		pinned: Boolean(ref),
	};
}

/**
 * Parse git source into normalized source information.
 */
export function parseGitUrl(source: string): GitSource | null {
	const trimmed = source.trim();
	const hasGitPrefix = trimmed.startsWith("git:");
	const normalizedSource = hasGitPrefix ? trimmed.slice(4).trim() : trimmed.replace(/^git\+/i, "");
	const url = normalizedSource;

	if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url) && !/^git@[^:]+:/.test(url)) {
		return null;
	}

	// 2026-10-11 (Δ2 follow-up): a hosted-git-info parse branch used to run
	// here ahead of the generic parser, but its require() never resolved in
	// ANY environment (undeclared dependency; unreachable even transitively
	// from src/ in the repo checkout), so the branch was dead code in every
	// deployment and was removed. parseGenericGitUrl is the only parse path
	// that ever executed.
	return parseGenericGitUrl(url);
}
