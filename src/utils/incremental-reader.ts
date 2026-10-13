import * as fs from "node:fs";

export interface IncrementalReadState {
	byteOffset: number;
	lineCount: number;
}

export interface IncrementalReadResult {
	lines: string[];
	state: IncrementalReadState;
	eof: boolean;
	/** U22 Phase 1 rotation signal: the file is now SHORTER than
	 *  `state.byteOffset` (rotate/truncate). The returned state keeps the legacy
	 *  "clamp to fileSize" behavior; consumers that can drain archives should
	 *  re-read from offset 0 instead of trusting the clamp (see
	 *  readEventsCursor's fromByteOffset path). */
	shrank?: boolean;
}

interface TrackedLine {
	text: string;
	/** Absolute byte offset of the line's first byte. */
	byteOffset: number;
	/** 0-based index among ALL complete lines in the file (blank included). */
	lineIndex: number;
}

interface ReadLinesDetailedResult {
	lines: TrackedLine[];
	state: IncrementalReadState;
	eof: boolean;
	shrank: boolean;
	/** Trailing non-blank bytes without "\n" were held back (torn tail). */
	tornTail: boolean;
}

const CHUNK_SIZE = 64 * 1024;

// --- U22 Phase 1: unified torn/poison classification for JSONL read paths ---
//
// One low-level scanner shared by every reader (full parse, tail window,
// byte-offset delta) so all paths classify corrupt content IDENTICALLY:
// - TORN tail = trailing bytes with no terminating "\n" (mid-append crash
//   cut). Recoverable: excluded from items, reported as tornTail=true, never
//   marked — the next append completes the line and it parses normally.
// - POISON line = a COMPLETE (newline-terminated) line whose JSON.parse
//   fails. Sticky: reported in `failures` so the caller records a
//   poison-marker sidecar entry and later reads skip the line by byte offset
//   without re-parsing it.

export interface JsonlParsedItem<T> {
	value: T;
	/** Absolute byte offset of the line's first byte. */
	byteOffset: number;
}

export interface JsonlParseFailure {
	/** Absolute byte offset of the failing line's first byte (stable match key). */
	byteOffset: number;
	/** 0-based index among the window's complete lines; -1 = unknown globally. */
	lineIndex: number;
	/** JSON.parse error message. */
	reason: string;
}

export interface JsonlWindowParseOptions {
	/** Line-start byte offsets already known poison (sticky markers) — skipped
	 *  WITHOUT a parse attempt so marked lines never re-parse. */
	poisonOffsets?: ReadonlySet<number>;
}

export interface JsonlWindowParseResult<T> {
	items: JsonlParsedItem<T>[];
	/** Complete lines whose JSON.parse failed in THIS pass (new poison). */
	failures: JsonlParseFailure[];
	/** Trailing non-blank bytes without a terminating "\n" (torn tail). */
	tornTail: boolean;
	/** Complete lines skipped via poisonOffsets (marker hits — not re-parsed). */
	poisonSkipped: number;
	/** Marker-hit line-start byte offsets whose line RE-PARSED successfully —
	 *  the markers are STALE (the byte offset now names a healthy line, e.g.
	 *  a marker that survived a rewrite of the file) and must be pruned from
	 *  the sidecar by the caller (commitPoisonFindings). Empty unless the
	 *  caller passed poisonOffsets. (U22 fix round: re-parse guard.) */
	staleMarkerOffsets: number[];
	/** Number of complete (newline-terminated) lines in the window. */
	lineCount: number;
	/** Bytes up to and including the last complete line's "\n". */
	completeBytes: number;
}

function parseFailureReason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Scan `buf` (starting at absolute `baseOffset`, itself a line boundary) into
 *  complete lines and classify each. Blank lines yield no item and no failure
 *  (matching the legacy readers). A trailing fragment without "\n" is held
 *  back as tornTail — never parsed as a line.
 *
 *  U22 fix round (re-parse guard): a marker-hit line is PARSED ONCE before the
 *  skip is honored — the line bytes are already in `buf` (no extra IO), so a
 *  marker whose offset now names a line that PARSES is stale (the file was
 *  rewritten/rotated+regrown past the old offset) and the event is DELIVERED
 *  instead of silently skipped; its offset is reported in
 *  `staleMarkerOffsets` for sidecar pruning. A line that still fails to parse
 *  is genuinely poison and stays skipped (poisonSkipped). */
export function parseJsonlWindow<T>(buf: Buffer, baseOffset: number, options?: JsonlWindowParseOptions): JsonlWindowParseResult<T> {
	const poisonOffsets = options?.poisonOffsets;
	const items: JsonlParsedItem<T>[] = [];
	const failures: JsonlParseFailure[] = [];
	const staleMarkerOffsets: number[] = [];
	let poisonSkipped = 0;
	let lineCount = 0;
	let completeBytes = 0;
	let pos = 0;
	for (;;) {
		const newline = buf.indexOf(0x0a, pos);
		if (newline < 0) break;
		const lineStartOffset = baseOffset + pos;
		if (poisonOffsets?.has(lineStartOffset)) {
			// Re-parse guard: validate the marker against the bytes it names (the
			// line is already in the buffer — zero extra IO). Only a line that
			// STILL fails to parse keeps the skip; a healthy line recovers the
			// event and flags the marker for pruning.
			const marked = buf.toString("utf-8", pos, newline).trim();
			let recovered = false;
			if (marked) {
				try {
					items.push({ value: JSON.parse(marked) as T, byteOffset: lineStartOffset });
					recovered = true;
				} catch {
					recovered = false;
				}
			}
			if (recovered) staleMarkerOffsets.push(lineStartOffset);
			else poisonSkipped++;
		} else {
			const trimmed = buf.toString("utf-8", pos, newline).trim();
			if (trimmed) {
				try {
					items.push({ value: JSON.parse(trimmed) as T, byteOffset: lineStartOffset });
				} catch (error) {
					failures.push({ byteOffset: lineStartOffset, lineIndex: lineCount, reason: parseFailureReason(error) });
				}
			}
		}
		lineCount++;
		pos = newline + 1;
		completeBytes = pos;
	}
	const tornTail = pos < buf.length && buf.toString("utf-8", pos).trim().length > 0;
	return { items, failures, tornTail, poisonSkipped, staleMarkerOffsets, lineCount, completeBytes };
}

/**
 * Read the last `tailBytes` bytes of a file and parse it as JSONL,
 * returning each successfully-parsed item in file order. If the file is
 * shorter than `tailBytes`, the entire file is read from offset 0.
 *
 * Returns:
 *   - items: parsed JSONL items (T may be any deserializable type)
 *   - fileSize: total file size in bytes
 *   - bytesRead: number of bytes actually read (≤ min(fileSize, tailBytes))
 *   - truncated: true when `bytesRead < fileSize` (a prefix was dropped)
 *
 * The function bounds the read to `tailBytes`, so CPU is O(tail bytes)
 * regardless of how large the file grows. Used by the event-log tail
 * read path (FIND-05) to avoid the O(total events) cost of the legacy
 * `readFileSync`+`split("\n")`+`JSON.parse` approach.
 *
 * U22 Phase 1: the parse phase is the shared torn/poison classifier
 * (`parseJsonlWindow`) — a trailing fragment without "\n" is held back and
 * reported as `tornTail` (never parsed as a line), complete-but-unparseable
 * lines are reported in `failures` for sticky poison marking, and lines whose
 * start offset is in `options.poisonOffsets` are skipped WITHOUT a parse.
 */
export interface ReadJsonlTailOptions {
	/** Line-start byte offsets already known poison (sticky markers) — skipped
	 *  without a parse attempt. */
	poisonOffsets?: ReadonlySet<number>;
}

export function readJsonlTail<T>(
	filePath: string,
	tailBytes: number,
	options?: ReadJsonlTailOptions,
): {
	items: T[];
	fileSize: number;
	bytesRead: number;
	truncated: boolean;
	/** Trailing torn fragment held back (mid-append crash cut). */
	tornTail: boolean;
	/** Lines skipped via poisonOffsets (marker hits — not re-parsed). */
	poisonSkipped: number;
	/** Complete lines whose JSON.parse failed in THIS pass (new poison). */
	failures: JsonlParseFailure[];
	/** Marker-hit offsets whose line re-parsed OK (stale markers — U22 fix
	 *  round re-parse guard; the caller prunes them via commitPoisonFindings). */
	staleMarkerOffsets: number[];
} {
	const limit = Math.max(0, Math.floor(tailBytes));
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return {
			items: [],
			fileSize: 0,
			bytesRead: 0,
			truncated: false,
			tornTail: false,
			poisonSkipped: 0,
			failures: [],
			staleMarkerOffsets: [],
		};
	}
	const fileSize = stat.size;
	if (fileSize === 0 || limit === 0) {
		return {
			items: [],
			fileSize,
			bytesRead: 0,
			truncated: false,
			tornTail: false,
			poisonSkipped: 0,
			failures: [],
			staleMarkerOffsets: [],
		};
	}

	const startOffset = Math.max(0, fileSize - limit);
	const bytesToRead = fileSize - startOffset;
	const truncated = startOffset > 0;

	let fd: number | undefined;
	try {
		// FIND-05 follow-up: O_NOFOLLOW refuses symlinks (defense-in-depth,
		// consistent with atomicWriteFile / resolveRealContainedPath). The
		// eventsPath is validated inside stateRoot, but this guards against a
		// symlinked file appearing after validation. O_NOFOLLOW on a symlink
		// yields ELOOP, which the catch below treats like ENOENT (return empty).
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch {
		return {
			items: [],
			fileSize,
			bytesRead: 0,
			truncated: false,
			tornTail: false,
			poisonSkipped: 0,
			failures: [],
			staleMarkerOffsets: [],
		};
	}
	try {
		const buf = Buffer.alloc(bytesToRead);
		let totalRead = 0;
		while (totalRead < bytesToRead) {
			const chunkSize = Math.min(CHUNK_SIZE, bytesToRead - totalRead);
			const bytesRead = fs.readSync(fd, buf, totalRead, chunkSize, startOffset + totalRead);
			if (bytesRead === 0) break;
			totalRead += bytesRead;
		}

		// If we truncated the file, the first decoded line may be a
		// half-line from the cut. Drop it — we can't trust the JSON.
		// Use a byte-level indexOf so the drop offset is a real byte offset
		// (a string index would mis-slice multi-byte UTF-8 content).
		if (truncated) {
			const firstNewline = buf.subarray(0, totalRead).indexOf(0x0a);
			if (firstNewline < 0) {
				// No newline at all in the tail → the entire tail is one
				// partial line. Return no items; the caller should fall
				// back to a wider tail or full read.
				return {
					items: [],
					fileSize,
					bytesRead: totalRead,
					truncated: true,
					tornTail: false,
					poisonSkipped: 0,
					failures: [],
					staleMarkerOffsets: [],
				};
			}
			const parsed = parseJsonlWindow<T>(buf.subarray(firstNewline + 1, totalRead), startOffset + firstNewline + 1, options);
			// Window-relative line indexes are only file-global when the window
			// starts at byte 0 (no truncation drop) — otherwise mark unknown.
			return {
				items: parsed.items.map((item) => item.value),
				fileSize,
				bytesRead: totalRead,
				truncated,
				tornTail: parsed.tornTail,
				poisonSkipped: parsed.poisonSkipped,
				failures: parsed.failures.map((failure) => ({ ...failure, lineIndex: -1 })),
				staleMarkerOffsets: parsed.staleMarkerOffsets,
			};
		}

		const parsed = parseJsonlWindow<T>(buf.subarray(0, totalRead), 0, options);
		return {
			items: parsed.items.map((item) => item.value),
			fileSize,
			bytesRead: totalRead,
			truncated,
			tornTail: parsed.tornTail,
			poisonSkipped: parsed.poisonSkipped,
			failures: parsed.failures,
			staleMarkerOffsets: parsed.staleMarkerOffsets,
		};
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * Read new lines from a text file since last known byte offset.
 * Uses fs.openSync + fs.readSync for efficient incremental reading.
 */
export function readLinesSince(filePath: string, state: IncrementalReadState): IncrementalReadResult {
	const detailed = readLinesSinceDetailed(filePath, state);
	return {
		lines: detailed.lines.map((line) => line.text),
		state: detailed.state,
		eof: detailed.eof,
		...(detailed.shrank ? { shrank: true } : {}),
	};
}

function readLinesSinceDetailed(filePath: string, state: IncrementalReadState): ReadLinesDetailedResult {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
	} catch {
		return {
			lines: [],
			state: { byteOffset: state.byteOffset, lineCount: state.lineCount },
			eof: true,
			shrank: false,
			tornTail: false,
		};
	}

	try {
		const stat = fs.fstatSync(fd);
		const fileSize = stat.size;

		if (fileSize <= state.byteOffset) {
			return {
				lines: [],
				state: { byteOffset: fileSize, lineCount: state.lineCount },
				eof: true,
				// U22 Phase 1: file shorter than the caller's offset = the offset
				// is stale (rotate/truncate) — signal instead of silently clamping.
				shrank: fileSize < state.byteOffset,
				tornTail: false,
			};
		}

		const bytesToRead = fileSize - state.byteOffset;
		const buf = Buffer.alloc(bytesToRead);
		let totalRead = 0;

		while (totalRead < bytesToRead) {
			const chunkSize = Math.min(CHUNK_SIZE, bytesToRead - totalRead);
			const bytesRead = fs.readSync(fd, buf, totalRead, chunkSize, state.byteOffset + totalRead);
			if (bytesRead === 0) break;
			totalRead += bytesRead;
		}

		const content = buf.subarray(0, totalRead);
		const lines: TrackedLine[] = [];
		let lineCount = state.lineCount;
		let committedOffset = state.byteOffset;
		let allLineIndex = 0;

		let searchFrom = 0;
		let newlineIdx: number;

		// F07 / RR-017: scan the BUFFER, not a decoded string. A string index is a
		// CHARACTER index, so using it as a byte offset silently mis-commits the
		// watermark on any multi-byte UTF-8 line (Vietnamese diacritics, emoji,
		// CJK): the next read then restarts mid-line and produces a corrupt line
		// (measured: a delta read of a 4-line file returned one `raw` garbage
		// event plus the three real ones). Byte offsets are what the API promises,
		// so `Buffer.indexOf(0x0a)` is the correct scan and decoding happens only
		// per complete line.
		while ((newlineIdx = content.indexOf(0x0a, searchFrom)) !== -1) {
			const lineText = content.toString("utf-8", searchFrom, newlineIdx);
			lines.push({ text: lineText, byteOffset: state.byteOffset + searchFrom, lineIndex: allLineIndex });
			allLineIndex++;
			committedOffset = state.byteOffset + newlineIdx + 1;
			searchFrom = newlineIdx + 1;
			if (lineText.length > 0) {
				lineCount++;
			}
		}

		const eof = committedOffset >= fileSize;
		const tornTail = !eof && content.toString("utf-8", searchFrom).trim().length > 0;

		return {
			lines,
			state: { byteOffset: committedOffset, lineCount },
			eof,
			shrank: false,
			tornTail,
		};
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * Read parsed JSON objects from a JSONL file since last known byte offset.
 * U22 Phase 1: uses the shared torn/poison classifier — a trailing fragment
 * without "\n" is held back (tornTail, never parsed as a line), complete lines
 * in `options.poisonOffsets` are skipped WITHOUT a parse (sticky markers), and
 * new parse failures are returned in `failures` for sticky marking.
 */
export interface ReadJsonlSinceOptions {
	poisonOffsets?: ReadonlySet<number>;
}

export function readJsonlSince<T>(
	filePath: string,
	state: IncrementalReadState,
	options?: ReadJsonlSinceOptions,
): {
	items: T[];
	state: IncrementalReadState;
	eof: boolean;
	tornTail: boolean;
	poisonSkipped: number;
	failures: JsonlParseFailure[];
	/** Marker-hit offsets whose line re-parsed OK (stale markers — U22 fix
	 *  round re-parse guard; the caller prunes them via commitPoisonFindings). */
	staleMarkerOffsets: number[];
	shrank: boolean;
} {
	const detailed = readLinesSinceDetailed(filePath, state);
	// Window-relative line indexes are file-global only when this read started
	// at byte 0; otherwise the caller's lineCount is not the file's line count.
	const globalIndexes = state.byteOffset === 0;
	const items: T[] = [];
	const failures: JsonlParseFailure[] = [];
	const staleMarkerOffsets: number[] = [];
	let poisonSkipped = 0;

	for (const line of detailed.lines) {
		if (options?.poisonOffsets?.has(line.byteOffset)) {
			// U22 fix round (re-parse guard): validate the marker against the
			// line already read into memory (zero extra IO) — a marker whose
			// line now PARSES is stale: deliver the event and flag the marker
			// for pruning instead of silently skipping a healthy line.
			const marked = line.text.trim();
			let recovered = false;
			if (marked) {
				try {
					items.push(JSON.parse(marked) as T);
					recovered = true;
				} catch {
					recovered = false;
				}
			}
			if (recovered) staleMarkerOffsets.push(line.byteOffset);
			else poisonSkipped++;
			continue;
		}
		const trimmed = line.text.trim();
		if (!trimmed) continue;
		try {
			items.push(JSON.parse(trimmed) as T);
		} catch (error) {
			failures.push({
				byteOffset: line.byteOffset,
				lineIndex: globalIndexes ? line.lineIndex : -1,
				reason: parseFailureReason(error),
			});
		}
	}

	return {
		items,
		state: detailed.state,
		eof: detailed.eof,
		tornTail: detailed.tornTail,
		poisonSkipped,
		failures,
		staleMarkerOffsets,
		shrank: detailed.shrank,
	};
}
