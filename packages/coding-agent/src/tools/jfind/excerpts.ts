/**
 * Source selection and excerpt segmentation for bounded `find` (`paths`).
 *
 * Exactly the sources the caller named — host files, globs, and internal
 * URLs — are read through the session's URL filesystem, and nothing else.
 * Every input that cannot be read in full is *skipped with a stated reason*
 * rather than partially read: a silently truncated file would turn a low
 * `answerPresent` into a lie about the caller's own selection.
 *
 * Excerpts (the model-facing "passages") keep exact one-based line locations
 * so every hit is re-readable verbatim with `read path:start-end`.
 */
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { InternalUrlRouter } from "../../internal-urls/router";
import type { InternalUrlFilesystem, UrlFileStat } from "../../internal-urls/url-filesystem";
import {
	formatPathRelativeToCwd,
	hasGlobPathChars,
	normalizePathLikeInput,
	parseSearchPath,
	resolveSearchBase,
	resolveSearchResultPath,
} from "../path-utils";
import { throwIfAborted } from "../tool-errors";
import { type ReadText, readText, ReadTextError } from "./text";

/** Segmentation strategy. `auto` picks per source. */
export type ExcerptUnit = "line" | "paragraph" | "auto";

/** Concrete strategy chosen for one source once `auto` is resolved. */
export type ResolvedUnit = "line" | "paragraph" | "block";

/** One readable source: the caller's spelling plus where its bytes actually came from. */
export interface ExcerptSource {
	/** Path exactly as the caller can re-read it (cwd-relative file, or the internal URL). */
	given: string;
	/** Absolute host path, or the internal URL of a rendered resource. */
	resolved: string;
	text: string;
}

/** An input that was named but not read, and why. */
export interface SkippedSource {
	path: string;
	reason: string;
}

/** A scorable span of one source, addressable as `path:startLine-endLine`. */
export interface Excerpt {
	/** Judge-facing id; matches the shared candidate-id grammar. */
	id: string;
	given: string;
	resolved: string;
	/** One-based inclusive. */
	startLine: number;
	/** One-based inclusive. */
	endLine: number;
	text: string;
	unit: ResolvedUnit;
}

export interface SelectionCaps {
	maxFiles: number;
	maxBytesPerFile: number;
}

export interface SourceSelection {
	sources: ExcerptSource[];
	skipped: SkippedSource[];
}

/** Extensions whose indentation carries block structure; `auto` segments these by block. */
const CODE_EXTENSIONS: Record<string, true> = {
	".ts": true,
	".tsx": true,
	".js": true,
	".jsx": true,
	".mjs": true,
	".cjs": true,
	".mts": true,
	".cts": true,
	".py": true,
	".rs": true,
	".go": true,
	".java": true,
	".kt": true,
	".swift": true,
	".c": true,
	".h": true,
	".cc": true,
	".cpp": true,
	".hpp": true,
	".cs": true,
	".rb": true,
	".php": true,
	".scala": true,
	".sh": true,
	".bash": true,
	".zsh": true,
	".sql": true,
	".css": true,
	".scss": true,
	".zig": true,
	".lua": true,
};

/** Above this line count `auto` stops scoring individual prose lines and groups paragraphs. */
const AUTO_LINE_LIMIT = 400;

/** Upper bound on an indentation-aware code block, so one long function is still several excerpts. */
const MAX_BLOCK_LINES = 12;

/** How many overflowing names a cap error spells out before summarizing. */
const OVERFLOW_NAMES_SHOWN = 12;

/** Choose the concrete segmentation for one source. */
export function resolveUnit(unit: ExcerptUnit, given: string, lineCount: number): ResolvedUnit {
	if (unit === "line") return "line";
	if (unit === "paragraph") return "paragraph";
	if (CODE_EXTENSIONS[path.extname(given).toLowerCase()]) return "block";
	return lineCount <= AUTO_LINE_LIMIT ? "line" : "paragraph";
}

interface Span {
	startLine: number;
	endLine: number;
}

function lineSpans(lines: readonly string[]): Span[] {
	const spans: Span[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === "") continue;
		spans.push({ startLine: i + 1, endLine: i + 1 });
	}
	return spans;
}

function paragraphSpans(lines: readonly string[]): Span[] {
	const spans: Span[] = [];
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === "") {
			if (start >= 0) {
				spans.push({ startLine: start + 1, endLine: i });
				start = -1;
			}
			continue;
		}
		if (start < 0) start = i;
	}
	if (start >= 0) spans.push({ startLine: start + 1, endLine: lines.length });
	return spans;
}

function indentWidth(line: string): number {
	let width = 0;
	for (const char of line) {
		if (char === " ") width += 1;
		else if (char === "\t") width += 4;
		else break;
	}
	return width;
}

/**
 * Indentation-aware code blocks: a block opens on a non-blank line and absorbs
 * following blank lines and more-indented lines, so a signature travels with
 * its body. Capped at {@link MAX_BLOCK_LINES} so one long function still yields
 * several independently rankable excerpts.
 */
function blockSpans(lines: readonly string[]): Span[] {
	const spans: Span[] = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i].trim() === "") {
			i++;
			continue;
		}
		const openIndent = indentWidth(lines[i]);
		const start = i;
		let end = i;
		i++;
		while (i < lines.length && i - start < MAX_BLOCK_LINES) {
			const line = lines[i];
			if (line.trim() === "") {
				i++;
				continue;
			}
			if (indentWidth(line) <= openIndent) break;
			end = i;
			i++;
		}
		spans.push({ startLine: start + 1, endLine: end + 1 });
		// Blank lines the lookahead consumed past the block's last content line
		// open the next block rather than padding this one.
		i = Math.max(i, end + 1);
	}
	return spans;
}

/** Split one source into scorable excerpts, preserving exact one-based locations. */
export function segmentSource(source: ExcerptSource, unit: ExcerptUnit, nextIndex: number): Excerpt[] {
	const lines = source.text.split("\n");
	const resolved = resolveUnit(unit, source.given, lines.length);
	const spans =
		resolved === "line" ? lineSpans(lines) : resolved === "paragraph" ? paragraphSpans(lines) : blockSpans(lines);
	const excerpts: Excerpt[] = [];
	let index = nextIndex;
	for (const span of spans) {
		const text = lines.slice(span.startLine - 1, span.endLine).join("\n");
		if (text.trim() === "") continue;
		excerpts.push({
			id: `P${String(index).padStart(3, "0")}`,
			given: source.given,
			resolved: source.resolved,
			startLine: span.startLine,
			endLine: span.endLine,
			text,
			unit: resolved,
		});
		index++;
	}
	return excerpts;
}

/** Raised when the caller named more readable sources than the file cap allows. */
export class SourceCapExceeded extends Error {
	override readonly name = "SourceCapExceeded";
	constructor(
		readonly maxFiles: number,
		readonly total: number,
		readonly notRead: readonly string[],
	) {
		const shown = notRead.slice(0, OVERFLOW_NAMES_SHOWN).join(", ");
		const rest = notRead.length > OVERFLOW_NAMES_SHOWN ? ` and ${notRead.length - OVERFLOW_NAMES_SHOWN} more` : "";
		super(`${total} sources exceed semanticFind.maxFiles (${maxFiles}); not read: ${shown}${rest}`);
	}
}

function oversized(given: string, size: number, cap: number): SkippedSource {
	return {
		path: given,
		reason: `${size} bytes exceeds semanticFind.maxBytesPerFile (${cap}); narrow it with read ${given}:START-END or grep`,
	};
}

/**
 * Read one named source in full through `filesystem`, or record why it was
 * not read. Host paths and internal URLs (file-backed or rendered) take the
 * same route, so a `local://` note and a workspace file skip for the same reasons.
 */
async function readSource(
	filesystem: InternalUrlFilesystem,
	resolved: string,
	given: string,
	caps: SelectionCaps,
	skipped: SkippedSource[],
): Promise<ExcerptSource | null> {
	let stat: UrlFileStat;
	try {
		stat = await filesystem.stat(resolved);
	} catch (error) {
		skipped.push({ path: given, reason: `unreadable (${error instanceof Error ? error.message : String(error)})` });
		return null;
	}
	if (stat.type === "directory") {
		const asGlob = `${given.replace(/[/\\]+$/, "")}/*`;
		skipped.push({ path: given, reason: `directory — name files or a glob such as ${asGlob}` });
		return null;
	}
	if (stat.type !== "file") {
		skipped.push({ path: given, reason: "not a regular file" });
		return null;
	}
	if (stat.size > caps.maxBytesPerFile) {
		skipped.push(oversized(given, stat.size, caps.maxBytesPerFile));
		return null;
	}
	let read: ReadText;
	try {
		read = await readText(filesystem, resolved, caps.maxBytesPerFile);
	} catch (error) {
		if (!(error instanceof ReadTextError)) throw error;
		if (error.kind === "binary") skipped.push({ path: given, reason: "binary content" });
		else if (error.kind === "empty") skipped.push({ path: given, reason: "no non-blank lines" });
		else skipped.push({ path: given, reason: `unreadable (${error.message})` });
		return null;
	}
	// The file grew past the cap between stat and read: still never half-read.
	if (read.truncated) {
		skipped.push(oversized(given, read.bytes, caps.maxBytesPerFile));
		return null;
	}
	return { given, resolved, text: read.text };
}

/** Files matching a host or URL glob, absolute spellings in path order; one past `limit` so overflow is detectable. */
async function expandGlob(
	pattern: string,
	cwd: string,
	limit: number,
	filesystem: InternalUrlFilesystem,
	signal?: AbortSignal,
): Promise<string[]> {
	const parsed = parseSearchPath(pattern);
	const base = resolveSearchBase(parsed.basePath || ".", cwd);
	const result = await natives.glob({
		pattern: parsed.glob ?? "**/*",
		path: base,
		fileType: natives.FileType.File,
		hidden: false,
		gitignore: true,
		// One past the cap so the caller can tell "exactly at the cap" from
		// "over it" and fail closed instead of ranking an arbitrary prefix.
		maxResults: Math.max(1, limit + 1),
		recursive: false,
		filesystem: filesystem.shellFilesystem(),
		signal,
	});
	const out: string[] = [];
	for (const match of result.matches) {
		if (!match.path) continue;
		out.push(resolveSearchResultPath(base, match.path));
	}
	return out.sort();
}

/**
 * Resolve every caller-named input to readable text. Globs expand against the
 * host tree or a URL root alike; a name with a `:start-end` selector, a
 * directory, an oversized, binary, blank, or unreadable entry is skipped with
 * its reason. More readable sources than `caps.maxFiles` is an error, never a
 * silently ranked prefix.
 * @throws {SourceCapExceeded}
 */
export async function selectSources(options: {
	paths: readonly string[];
	cwd: string;
	caps: SelectionCaps;
	filesystem: InternalUrlFilesystem;
	signal?: AbortSignal;
}): Promise<SourceSelection> {
	const { cwd, caps, filesystem } = options;
	const router = InternalUrlRouter.instance();
	const sources: ExcerptSource[] = [];
	const skipped: SkippedSource[] = [];
	const seen = new Set<string>();
	const overflow: string[] = [];

	const admit = async (resolved: string, given: string): Promise<void> => {
		if (seen.has(resolved)) return;
		seen.add(resolved);
		const source = await readSource(filesystem, resolved, given, caps, skipped);
		if (!source) return;
		if (sources.length >= caps.maxFiles) {
			overflow.push(given);
			return;
		}
		sources.push(source);
	};

	for (const raw of options.paths) {
		const entry = normalizePathLikeInput(raw);
		if (entry === "") continue;
		throwIfAborted(options.signal);
		// Excerpts carry exact whole-file coordinates, so a selector would be silently ignored.
		if (router.split(entry).sel !== undefined) {
			skipped.push({ path: entry, reason: "line-range selectors are not supported; find judges whole files" });
			continue;
		}
		if (hasGlobPathChars(entry)) {
			const matches = await expandGlob(entry, cwd, caps.maxFiles - sources.length, filesystem, options.signal);
			if (matches.length === 0) {
				skipped.push({ path: entry, reason: "glob matched no files" });
				continue;
			}
			for (const match of matches) await admit(match, formatPathRelativeToCwd(match, cwd));
			continue;
		}
		await admit(resolveSearchBase(entry, cwd), entry);
	}

	if (overflow.length > 0) throw new SourceCapExceeded(caps.maxFiles, sources.length + overflow.length, overflow);
	return { sources, skipped };
}
