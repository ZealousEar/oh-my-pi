/**
 * Source selection and passage segmentation for `semantic_find`.
 *
 * The tool reads exactly the sources the caller named — filesystem paths,
 * globs, and internal URLs — and nothing else. Every input that cannot be read
 * in full is *skipped with a stated reason* rather than partially read: a
 * silently truncated file would turn a low `answerPresent` score into a lie
 * about the caller's own selection.
 *
 * Passages keep exact one-based line locations so every hit is re-readable
 * verbatim with `read path:start-end`.
 */
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { InternalUrlRouter } from "../../internal-urls/router";
import type { InternalResource, ResolveContext } from "../../internal-urls/types";
import {
	formatPathRelativeToCwd,
	hasGlobPathChars,
	isInternalUrlPath,
	parseSearchPath,
	resolveToCwd,
} from "../path-utils";

/** Passage segmentation strategy. `auto` picks per source. */
export type PassageUnit = "line" | "paragraph" | "auto";

/** Concrete strategy chosen for one source once `auto` is resolved. */
export type ResolvedUnit = "line" | "paragraph" | "block";

/** One readable source: the caller's spelling plus where its bytes actually came from. */
export interface PassageSource {
	/** Path exactly as the caller can re-read it (cwd-relative file, or the internal URL). */
	given: string;
	/** Absolute filesystem path, or the internal URL for a virtual resource. */
	resolved: string;
	text: string;
}

/** An input that was named but not read, and why. */
export interface SkippedSource {
	path: string;
	reason: string;
}

/** A scorable span of one source, addressable as `path:startLine-endLine`. */
export interface Passage {
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
	sources: PassageSource[];
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

/** Upper bound on an indentation-aware code block, so one long function is still several passages. */
const MAX_BLOCK_LINES = 12;

/** Bytes sniffed for a NUL before deciding a source is binary. */
const BINARY_SNIFF_BYTES = 8192;

/** How many overflowing names a cap error spells out before summarizing. */
const OVERFLOW_NAMES_SHOWN = 12;

function isBinary(bytes: Uint8Array): boolean {
	const end = Math.min(bytes.length, BINARY_SNIFF_BYTES);
	for (let i = 0; i < end; i++) {
		if (bytes[i] === 0) return true;
	}
	return false;
}

/** Choose the concrete segmentation for one source. */
export function resolveUnit(unit: PassageUnit, given: string, lineCount: number): ResolvedUnit {
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
 * several independently rankable passages.
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

/** Split one source into scorable passages, preserving exact one-based locations. */
export function segmentSource(source: PassageSource, unit: PassageUnit, nextIndex: number): Passage[] {
	const lines = source.text.split("\n");
	const resolved = resolveUnit(unit, source.given, lines.length);
	const spans =
		resolved === "line" ? lineSpans(lines) : resolved === "paragraph" ? paragraphSpans(lines) : blockSpans(lines);
	const passages: Passage[] = [];
	let index = nextIndex;
	for (const span of spans) {
		const text = lines.slice(span.startLine - 1, span.endLine).join("\n");
		if (text.trim() === "") continue;
		passages.push({
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
	return passages;
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

async function readFileSource(
	absolutePath: string,
	given: string,
	caps: SelectionCaps,
	skipped: SkippedSource[],
): Promise<PassageSource | null> {
	let stat: nodeFs.Stats;
	try {
		stat = await fs.stat(absolutePath);
	} catch (error) {
		skipped.push({ path: given, reason: `unreadable (${error instanceof Error ? error.message : String(error)})` });
		return null;
	}
	if (stat.isDirectory()) {
		const asGlob = `${given.replace(/[/\\]+$/, "")}/*`;
		skipped.push({ path: given, reason: `directory — name files or a glob such as ${asGlob}` });
		return null;
	}
	if (!stat.isFile()) {
		skipped.push({ path: given, reason: "not a regular file" });
		return null;
	}
	if (stat.size > caps.maxBytesPerFile) {
		skipped.push({
			path: given,
			reason:
				`${stat.size} bytes exceeds semanticFind.maxBytesPerFile (${caps.maxBytesPerFile}); ` +
				`narrow it with read ${given}:START-END or grep`,
		});
		return null;
	}
	const bytes = new Uint8Array(await Bun.file(absolutePath).arrayBuffer());
	if (isBinary(bytes)) {
		skipped.push({ path: given, reason: "binary content" });
		return null;
	}
	return { given, resolved: absolutePath, text: new TextDecoder().decode(bytes) };
}

async function expandGlob(pattern: string, cwd: string, limit: number, signal?: AbortSignal): Promise<string[]> {
	const parsed = parseSearchPath(pattern);
	const searchPath = resolveToCwd(parsed.basePath || ".", cwd);
	const result = await natives.glob({
		pattern: parsed.glob ?? "**/*",
		path: searchPath,
		fileType: natives.FileType.File,
		hidden: false,
		gitignore: true,
		// One past the cap so the caller can tell "exactly at the cap" from
		// "over it" and fail closed instead of ranking an arbitrary prefix.
		maxResults: Math.max(1, limit + 1),
		recursive: false,
		signal,
	});
	const out: string[] = [];
	for (const match of result.matches) {
		if (!match.path) continue;
		out.push(path.resolve(searchPath, match.path));
	}
	return out.sort();
}

/**
 * Resolve every caller-named input to readable text.
 *
 * Filesystem entries and globs resolve locally; internal URLs go through the
 * shared router with the caller's full {@link ResolveContext}, so an
 * `artifact://`/`local://` with a backing file is read from that file and a
 * purely virtual resource uses its materialized content.
 */
export async function selectSources(options: {
	paths: readonly string[];
	cwd: string;
	caps: SelectionCaps;
	resolveContext: ResolveContext;
	signal?: AbortSignal;
}): Promise<SourceSelection> {
	const { paths, cwd, caps } = options;
	const router = InternalUrlRouter.instance();
	const sources: PassageSource[] = [];
	const skipped: SkippedSource[] = [];
	const seen = new Set<string>();
	const overflow: string[] = [];

	const push = (source: PassageSource | null): void => {
		if (!source) return;
		if (seen.has(source.resolved)) return;
		seen.add(source.resolved);
		if (sources.length >= caps.maxFiles) {
			overflow.push(source.given);
			return;
		}
		sources.push(source);
	};

	for (const raw of paths) {
		const entry = raw.trim();
		if (entry === "") continue;
		options.signal?.throwIfAborted();

		if (isInternalUrlPath(entry) || router.canHandle(entry)) {
			if (hasGlobPathChars(entry)) {
				skipped.push({ path: entry, reason: "glob patterns are not supported for internal URLs" });
				continue;
			}
			let resource: InternalResource;
			try {
				resource = await router.resolve(entry, options.resolveContext);
			} catch (error) {
				skipped.push({
					path: entry,
					reason: `unresolvable (${error instanceof Error ? error.message : String(error)})`,
				});
				continue;
			}
			if (resource.isDirectory) {
				skipped.push({ path: entry, reason: "directory resource — name a file beneath it" });
				continue;
			}
			if (resource.sourcePath) {
				push(await readFileSource(resource.sourcePath, entry, caps, skipped));
				continue;
			}
			const size = resource.size ?? Buffer.byteLength(resource.content, "utf-8");
			if (size > caps.maxBytesPerFile) {
				skipped.push({
					path: entry,
					reason:
						`${size} bytes exceeds semanticFind.maxBytesPerFile (${caps.maxBytesPerFile}); ` +
						`narrow it with read ${entry}:START-END`,
				});
				continue;
			}
			push({ given: entry, resolved: entry, text: resource.content });
			continue;
		}

		if (hasGlobPathChars(entry)) {
			const matches = await expandGlob(entry, cwd, caps.maxFiles - sources.length, options.signal);
			if (matches.length === 0) {
				skipped.push({ path: entry, reason: "glob matched no files" });
				continue;
			}
			for (const match of matches) {
				push(await readFileSource(match, formatPathRelativeToCwd(match, cwd), caps, skipped));
			}
			continue;
		}

		push(await readFileSource(resolveToCwd(entry, cwd), entry, caps, skipped));
	}

	if (overflow.length > 0) throw new SourceCapExceeded(caps.maxFiles, sources.length + overflow.length, overflow);
	return { sources, skipped };
}
