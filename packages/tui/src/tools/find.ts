/**
 * Transcript renderer for the `find` tool (semantic grep). A cascade search
 * (`path`) ranks hits strongest first; each row carries a score gauge, the
 * hyperlinked file, and its strongest verified line ranges with a verbatim
 * snippet. A bounded search (`paths`) ranks excerpts of the named sources and
 * reports the independent `answerPresent` probability beside them.
 */
import * as path from "node:path";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { renderProgressBar } from "../components/progress-bar";
import { Text } from "../components/text";
import {
	Ellipsis,
	fileHyperlink,
	getTreeBranch,
	renderStatusLine,
	renderTreeList,
	truncateToWidth,
	uriHyperlink,
} from "../render";
import {
	createCachedComponent,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	PREVIEW_LIMITS,
	replaceTabs,
} from "../render/render-utils";
import type { Theme, ThemeColor } from "../theme/theme";
import type { Component } from "../tui";
import type { OutputMeta } from "./output-meta";
import type { NativeToolHead, NativeToolView, RenderResultOptions, ToolRenderer } from "./renderer";
import type { TspTone } from "@oh-my-pi/pi-wire";
import { code, col, compact, keyed, node, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { getLanguageFromPath } from "../lang-from-path";
import { fileHref, fileRow, inlineErrorView } from "./native-view";
import { splitUrlScheme } from "./url-scheme-host";

/** A verified line range with its yes-probability and a one-line preview. */
export interface FindRange {
	start: number;
	end: number;
	p: number;
	snippet: string;
}

/** A file whose verified passages cleared the threshold; `ranges` are merged positive spans, strongest first. */
export interface FindHit {
	/** Display path relative to {@link FindToolDetails.cwd}, or an internal URL under URL scopes. */
	rel: string;
	/** Filename judgment, when the name batch answered. */
	nameScore?: number;
	/** Best verified passage probability. */
	contentScore: number;
	ranges: FindRange[];
	/** Lines of content actually judged, and whether the file held more. */
	linesSeen: number;
	truncated: boolean;
}

/** Search accounting reported alongside the hits. */
export interface FindStats {
	/** Eligible files under the root. */
	listed: number;
	requests: number;
	errors: number;
	/** Entries judged by name. */
	judged: number;
	/** Files whose content was read and sent. */
	filesRead: number;
	fileBytes: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	apiMs: number;
	windowsJudged: number;
	windowsPruned: number;
	mapCards: number;
	/** Distinct request failures, phase-prefixed. */
	failures: string[];
}

/** Display metadata for cascade (`path`) find results. */
export interface FindCascadeDetails {
	mode: "cascade";
	query: string;
	/** Lexical keywords actually used: derived from the query plus `grep_keywords`. */
	keywords: string[];
	/** Verified-passage probability at or above which a file is a hit. */
	threshold: number;
	hits: FindHit[];
	stats: FindStats;
	elapsedMs: number;
	/** Session cwd; hit paths are relative to it. */
	cwd: string;
	/** Display form of the searched directory or file when narrower than cwd. */
	scopePath?: string;
	meta?: OutputMeta;
}

/** One ranked excerpt of a bounded find; `read path:startLine-endLine` re-reads it verbatim. */
export interface FindBoundedResult {
	/** Path as the caller named it: cwd-relative file, or an internal URL. */
	path: string;
	/** Absolute host path, or the internal URL of a rendered resource. */
	resolved: string;
	startLine: number;
	endLine: number;
	/** Share of the final ranking distribution; sums to 1 over the ranked pool. */
	score: number;
	/** First non-blank line of the excerpt, trimmed. */
	snippet: string;
}

/** What a bounded find read and how many judgment requests it spent. */
export interface FindBoundedCoverage {
	files: number;
	passages: number;
	windows: number;
	passes: number;
	/** First-pass finalists `limit` admitted that the single finalist request could not seat. */
	finalistsDropped: number;
	/** Named inputs that were not read, each with its reason. */
	skipped: Array<{ path: string; reason: string }>;
}

/** One judgment attempt behind a bounded find, as the transcript names it. */
export interface FindJudgeAttempt {
	backend: string;
	provider: string;
	model: string;
	distribution: string;
	fallback?: { from: string; reason?: string };
	error?: string;
}

/** Aggregate of every judgment attempt made for one bounded find, failed ones included. */
export interface FindBoundedUsage {
	calls: number;
	attempts: number;
	input: number;
	output: number;
	costUsd: number | "unknown";
}

export type FindAnswerVerdict = "absent" | "partial" | "present";

/** Display metadata for bounded (`paths`) find results. */
export interface FindBoundedDetails {
	mode: "bounded";
	query: string;
	/** Independent probability that the named sources answer the query; never derived from the ranking. */
	answerPresent: number;
	/** `unknown` only when {@link error} is set: ranking produced no verdict. */
	verdict: FindAnswerVerdict | "unknown";
	results: FindBoundedResult[];
	coverage: FindBoundedCoverage;
	/** Re-read check of every reported range against its source. */
	verification: { verified: boolean | "unknown"; detail?: string };
	/** Every judgment attempt in order; the last row names the judge that answered or was last asked. */
	provenance: FindJudgeAttempt[];
	usage: FindBoundedUsage;
	elapsedMs: number;
	/** Session cwd; result paths are relative to it. */
	cwd: string;
	/** Why ranking failed; `provenance`/`usage` still account for every attempt made before it did. */
	error?: string;
	meta?: OutputMeta;
}

export type FindToolDetails = FindCascadeDetails | FindBoundedDetails;

interface FindRenderArgs {
	query?: string;
	grep_keywords?: string[];
	path?: string;
	paths?: string[];
}

/** Cells in the per-hit score gauge. */
const GAUGE_WIDTH = 6;
/** Hits shown before expansion. */
const COLLAPSED_HITS = 5;
/** Ranges shown per hit: one collapsed, three expanded. */
const RANGES_COLLAPSED = 1;
const RANGES_EXPANDED = 3;
/** Score at or above which a hit renders as strong / plausible. */
const STRONG = 0.7;
const PLAUSIBLE = 0.4;

function scoreColor(p: number): ThemeColor {
	return p >= STRONG ? "success" : p >= PLAUSIBLE ? "warning" : "muted";
}

function gauge(p: number, theme: Theme): string {
	const color = scoreColor(p);
	return renderProgressBar(p, GAUGE_WIDTH, {
		style: {
			filled: theme.symbol("progress.filled"),
			empty: theme.symbol("progress.empty"),
			styleFilled: text => theme.fg(color, text),
			styleEmpty: text => theme.fg("dim", text),
		},
	});
}

function renderHit(hit: FindHit, rangeLimit: number, cwd: string | undefined, theme: Theme): string[] {
	// `scheme://` hits (e.g. virtual docs) are not files under `cwd`: link the
	// URL itself instead of joining it onto a filesystem base.
	const isUrlHit = splitUrlScheme(hit.rel) !== undefined;
	const link = (text: string, line?: number): string => {
		if (isUrlHit) return uriHyperlink(line === undefined ? hit.rel : `${hit.rel}:${line}`, text);
		const absPath = cwd === undefined ? undefined : path.join(cwd, hit.rel);
		return absPath === undefined ? text : fileHyperlink(absPath, text, { line });
	};
	const coverage = hit.truncated ? `${hit.linesSeen} lines judged, partial` : `${hit.linesSeen} lines judged`;
	const lines = [
		`${gauge(hit.contentScore, theme)} ${theme.fg(scoreColor(hit.contentScore), hit.contentScore.toFixed(2))} ${link(theme.fg("accent", hit.rel))} ${theme.fg("dim", coverage)}`,
	];
	const ranges = [...hit.ranges].sort((a, b) => b.p - a.p || a.start - b.start).slice(0, rangeLimit);
	ranges.forEach((range, index) => {
		const span = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
		const ref = link(theme.fg("muted", `:${span}`), range.start);
		const snippet = theme.fg("toolOutput", replaceTabs(range.snippet.trim()));
		const branch = theme.fg("dim", getTreeBranch(index === ranges.length - 1, theme));
		lines.push(`  ${branch} ${ref} ${theme.fg("dim", range.p.toFixed(2))} ${snippet}`);
	});
	return lines;
}

function scoreTone(p: number): TspTone {
	return p >= STRONG ? "success" : p >= PLAUSIBLE ? "warning" : "muted";
}

/**
 * One hit (§7.3 find): a 22px row of the score bar, the path and `12 lines
 * judged`, then its strongest ranges as numbered `code` (no path header).
 */
function describeHit(hit: FindHit, rangeLimit: number, cwd: string | undefined): NativeNode {
	const ranges = [...hit.ranges].sort((a, b) => b.p - a.p || a.start - b.start).slice(0, rangeLimit);
	const tone = scoreTone(hit.contentScore);
	const score = hit.contentScore.toFixed(2);
	const isUrlHit = splitUrlScheme(hit.rel) !== undefined;
	const head = fileRow(hit.rel, {
		lead: node("progress", { value: hit.contentScore, tone, title: `score ${score}`, max: { w: 40 } }),
		detail: [
			span(score, tone),
			span(
				hit.truncated ? ` · ${hit.linesSeen} lines judged, partial` : ` · ${hit.linesSeen} lines judged`,
				"muted",
			),
		],
		href: isUrlHit || cwd === undefined ? undefined : fileHref(path.join(cwd, hit.rel)),
		key: "hit",
	});
	const lang = getLanguageFromPath(hit.rel);
	const snippets = ranges.map(range =>
		keyed(
			code(range.snippet.trimEnd(), { lang, start: range.start, numbers: true, title: range.p.toFixed(2) }),
			`${range.start}-${range.end}`,
		),
	);
	return keyed(col([head, ...snippets], { gap: "xs", role: "omp.tool.find.hit" }), hit.rel);
}

/** Native find head: the query, then `meta` (result counts), or the call's keywords and scope. */
function findNativeHead(
	query: string | undefined,
	meta: readonly NonNullable<NativeToolHead["meta"]>[number][],
): NativeToolHead {
	return { title: "Find", target: query ?? "", targetKind: "query", meta };
}

/**
 * One bounded result: the score bar, the hyperlinked `path:start-end`, then
 * the excerpt's first line as numbered `code`.
 */
function describeBoundedResult(result: FindBoundedResult, cwd: string): NativeNode {
	const tone = scoreTone(result.score);
	const score = result.score.toFixed(2);
	const span_ =
		result.startLine === result.endLine ? String(result.startLine) : `${result.startLine}-${result.endLine}`;
	const isUrl = splitUrlScheme(result.path) !== undefined;
	const head = fileRow(result.path, {
		lead: node("progress", { value: result.score, tone, title: `score ${score}`, max: { w: 40 } }),
		detail: [span(score, tone), span(` · :${span_}`, "muted")],
		href: isUrl ? undefined : fileHref(path.join(cwd, result.path)),
		key: "result",
	});
	const snippet = code(result.snippet.trimEnd(), {
		lang: getLanguageFromPath(result.path),
		start: result.startLine,
		numbers: true,
	});
	return keyed(col([head, snippet], { gap: "xs", role: "omp.tool.find.hit" }), `${result.path}:${span_}`);
}

/**
 * Inline bounded find: `Find “query”  3 results · 2 files · answerPresent 0.82 present`,
 * then each ranked excerpt; the judge provenance and skipped inputs trail it.
 */
function describeBounded(
	details: FindBoundedDetails,
	options: RenderResultOptions,
	query: string | undefined,
): NativeToolView {
	const { results, coverage, usage } = details;
	const cost = usage.costUsd === "unknown" ? "cost unknown" : `$${usage.costUsd.toFixed(4)}`;
	const verdict = [
		span("answerPresent ", "muted"),
		span(details.answerPresent.toFixed(2), scoreTone(details.answerPresent)),
		span(` ${details.verdict}`, "muted"),
	];
	const warnings = compact([
		coverage.skipped.length > 0 && [span(`${coverage.skipped.length} skipped`, "warning")],
		details.verification.verified === false && [span("source changed", "warning")],
	]);
	const accounting = [`${formatNumber(usage.input)} tokens`, cost, formatDuration(details.elapsedMs)].join(" · ");
	const notices: NativeChild[] = [];
	const last = details.provenance.at(-1);
	if (last) {
		const outcome = last.error ? `failed: ${last.error}` : `${last.distribution} distribution`;
		notices.push(
			keyed(
				text([span(`${last.backend} judge ${last.provider}/${last.model}, ${outcome}`, "muted")], {
					wrap: "word",
					role: "omp.tool.notice",
				}),
				"judge",
			),
		);
	}
	if (details.verification.detail) {
		notices.push(
			keyed(text([span(details.verification.detail, "muted")], { wrap: "word", role: "omp.tool.notice" }), "verify"),
		);
	}
	coverage.skipped.forEach((skip, i) =>
		notices.push(
			keyed(
				text([span(`skipped ${skip.path}: ${skip.reason}`, "warning")], { wrap: "word", role: "omp.tool.notice" }),
				`skip${i}`,
			),
		),
	);
	if (results.length === 0) {
		return {
			tool: findNativeHead(query, compact(["0 results", verdict, ...warnings])),
			tone: "warning" as const,
			inline: true,
			body: notices.length > 0 ? notices : undefined,
		};
	}
	const shown = options.expanded ? results : results.slice(0, COLLAPSED_HITS);
	const hidden = results.length - shown.length;
	const footParts = compact([hidden > 0 && formatCount("more result", hidden), accounting]);
	const foot = keyed(
		text([span(footParts.join(" · "), "muted")], { wrap: "word", role: "omp.tool.stats", title: accounting }),
		"foot",
	);
	return {
		tool: findNativeHead(
			query,
			compact([
				`${formatCount("result", results.length)} · ${formatCount("file", coverage.files)}`,
				verdict,
				...warnings,
			]),
		),
		inline: true,
		body: compact<NativeChild>([
			...shown.map(result => describeBoundedResult(result, details.cwd)),
			...notices,
			foot,
		]),
		preview: { lines: PREVIEW_LIMITS.EXPANDED_LINES },
	};
}

/** Bounded result row: gauge, score, hyperlinked `path:start-end`, first excerpt line. */
function renderBoundedResult(result: FindBoundedResult, cwd: string, theme: Theme): string[] {
	const span =
		result.startLine === result.endLine ? String(result.startLine) : `${result.startLine}-${result.endLine}`;
	const label = theme.fg("accent", result.path) + theme.fg("muted", `:${span}`);
	const link =
		splitUrlScheme(result.path) === undefined
			? fileHyperlink(path.join(cwd, result.path), label, { line: result.startLine })
			: uriHyperlink(`${result.path}:${result.startLine}`, label);
	const snippet = theme.fg("toolOutput", replaceTabs(result.snippet));
	return [
		`${gauge(result.score, theme)} ${theme.fg(scoreColor(result.score), result.score.toFixed(2))} ${link} ${snippet}`,
	];
}

function renderCascade(details: FindCascadeDetails, options: RenderResultOptions, uiTheme: Theme): Component {
	const { hits, stats, threshold } = details;
	const description = quoteQuery(details.query);
	const scope = details.scopePath === undefined ? [] : [`in ${details.scopePath}`];
	const meta = [
		formatCount("hit", hits.length),
		...scope,
		`${stats.filesRead} files read`,
		`τ ${threshold.toFixed(2)}`,
		`${formatNumber(stats.inputTokens)} tokens`,
		`$${stats.cost.toFixed(4)}`,
		formatDuration(details.elapsedMs),
	];
	if (stats.errors > 0) meta.push(uiTheme.fg("warning", `${stats.errors} failed`));

	if (hits.length === 0) {
		const emptyMeta = ["0 hits", ...scope, `$${stats.cost.toFixed(4)}`, formatDuration(details.elapsedMs)];
		if (stats.errors > 0) emptyMeta.push(uiTheme.fg("warning", `${stats.errors} failed`));
		const header = renderStatusLine(
			{ icon: "warning", title: "Find", titleColor: "toolTitle", description, meta: emptyMeta },
			uiTheme,
		);
		const lines = [header, formatEmptyMessage("No relevant passages found", uiTheme)];
		for (const failure of stats.failures) lines.push(uiTheme.fg("warning", failure));
		return new Text(lines.join("\n"), 1, 0);
	}

	const header = renderStatusLine(
		{
			iconOverride: uiTheme.fg("toolTitle", uiTheme.symbol("icon.search")),
			title: "Find",
			titleColor: "toolTitle",
			description,
			meta,
		},
		uiTheme,
	);

	return createCachedComponent(
		() => options.expanded,
		(width, expanded) => {
			const hitLines = renderTreeList(
				{
					items: hits,
					expanded,
					maxCollapsed: COLLAPSED_HITS,
					maxCollapsedLines: PREVIEW_LIMITS.EXPANDED_LINES,
					itemType: "hit",
					renderItem: hit => renderHit(hit, expanded ? RANGES_EXPANDED : RANGES_COLLAPSED, details.cwd, uiTheme),
				},
				uiTheme,
			);
			const extra: string[] = [];
			if (expanded) {
				extra.push(uiTheme.fg("dim", `keywords: ${details.keywords.join(", ")}`));
				for (const failure of stats.failures) extra.push(uiTheme.fg("warning", failure));
			}
			return [header, ...hitLines, ...extra].map(line => truncateToWidth(line, width, Ellipsis.Omit));
		},
		{ paddingX: 1 },
	);
}

function renderBounded(details: FindBoundedDetails, options: RenderResultOptions, uiTheme: Theme): Component {
	const { results, coverage, usage } = details;
	const description = quoteQuery(details.query);
	const cost = usage.costUsd === "unknown" ? "cost unknown" : `$${usage.costUsd.toFixed(4)}`;
	const meta = [
		formatCount("result", results.length),
		formatCount("file", coverage.files),
		`answerPresent ${uiTheme.fg(scoreColor(details.answerPresent), details.answerPresent.toFixed(2))} ${details.verdict}`,
		`${formatNumber(usage.input)} tokens`,
		cost,
		formatDuration(details.elapsedMs),
	];
	if (coverage.skipped.length > 0) meta.push(uiTheme.fg("warning", `${coverage.skipped.length} skipped`));
	if (details.verification.verified === false) meta.push(uiTheme.fg("warning", "source changed"));

	if (results.length === 0) {
		const header = renderStatusLine(
			{ icon: "warning", title: "Find", titleColor: "toolTitle", description, meta },
			uiTheme,
		);
		const lines = [header, formatEmptyMessage("No passages ranked", uiTheme)];
		for (const skip of coverage.skipped) lines.push(uiTheme.fg("warning", `skipped ${skip.path}: ${skip.reason}`));
		return new Text(lines.join("\n"), 1, 0);
	}

	const header = renderStatusLine(
		{
			iconOverride: uiTheme.fg("toolTitle", uiTheme.symbol("icon.search")),
			title: "Find",
			titleColor: "toolTitle",
			description,
			meta,
		},
		uiTheme,
	);

	return createCachedComponent(
		() => options.expanded,
		(width, expanded) => {
			const rows = renderTreeList(
				{
					items: results,
					expanded,
					maxCollapsed: COLLAPSED_HITS,
					maxCollapsedLines: PREVIEW_LIMITS.EXPANDED_LINES,
					itemType: "result",
					renderItem: result => renderBoundedResult(result, details.cwd, uiTheme),
				},
				uiTheme,
			);
			const extra: string[] = [];
			if (expanded) {
				const last = details.provenance.at(-1);
				if (last) {
					const outcome = last.error ? `failed: ${last.error}` : `${last.distribution} distribution`;
					extra.push(uiTheme.fg("dim", `${last.backend} judge ${last.provider}/${last.model}, ${outcome}`));
				}
				if (details.verification.detail) extra.push(uiTheme.fg("dim", details.verification.detail));
				for (const skip of coverage.skipped)
					extra.push(uiTheme.fg("warning", `skipped ${skip.path}: ${skip.reason}`));
			}
			return [header, ...rows, ...extra].map(line => truncateToWidth(line, width, Ellipsis.Omit));
		},
		{ paddingX: 1 },
	);
}

function quoteQuery(query: string | undefined): string | undefined {
	return query === undefined ? undefined : `"${query}"`;
}

/** Render find calls and results in the transcript. */
export const findToolRenderer = {
	renderCall(args: FindRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const keywords = args.grep_keywords ?? [];
		const meta = keywords.length > 0 ? [keywords.join(" ")] : [];
		if (args.path) meta.push(`in ${args.path}`);
		else if (args.paths) meta.push(`in ${formatCount("path", args.paths.length)}`);
		const text = renderStatusLine(
			{
				icon: "pending",
				spinnerFrame: options.spinnerFrame,
				title: "Find",
				titleColor: "toolTitle",
				description: quoteQuery(args.query),
				meta,
			},
			uiTheme,
		);
		return new Text(text, 1, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: FindToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: FindRenderArgs,
	): Component {
		const details = result.details;
		const text = result.content?.find(c => c.type === "text")?.text ?? "";

		if (result.isError) {
			return new Text(formatErrorMessage(text || "Unknown error", uiTheme), 1, 0);
		}

		// Streaming progress: the tool reports the phase it is in.
		if (options.isPartial || details === undefined) {
			const header = renderStatusLine(
				{
					icon: "pending",
					spinnerFrame: options.spinnerFrame,
					title: "Find",
					titleColor: "toolTitle",
					description: quoteQuery(args?.query ?? details?.query),
					meta: text ? [text] : [],
				},
				uiTheme,
			);
			return new Text(header, 1, 0);
		}

		return details.mode === "bounded"
			? renderBounded(details, options, uiTheme)
			: renderCascade(details, options, uiTheme);
	},
	describeCall(args: FindRenderArgs): NativeToolView {
		const keywords = args.grep_keywords ?? [];
		return {
			tool: findNativeHead(
				args.query,
				compact([
					keywords.length > 0 && keywords.join(" "),
					args.path && `in ${args.path}`,
					args.paths && `in ${formatCount("path", args.paths.length)}`,
				]),
			),
			inline: true,
		};
	},

	/**
	 * Inline (§7.3 find): `Find “query”  2 hits · 8 files`, then per hit its
	 * score bar, path and coverage over the strongest snippets. The search
	 * accounting (τ, tokens, cost, time) is the footnote's tooltip.
	 */
	describeResult(
		result: { content: Array<{ type: string; text?: string }>; details?: FindToolDetails; isError?: boolean },
		options: RenderResultOptions,
		args?: FindRenderArgs,
	): NativeToolView {
		const details = result.details;
		const progress = result.content?.find(c => c.type === "text")?.text ?? "";
		const query = args?.query ?? details?.query;
		if (result.isError) return inlineErrorView(findNativeHead(query, []), progress || "Unknown error");
		if (options.isPartial || details === undefined) {
			return {
				tool: findNativeHead(query, progress ? [[span(progress, "muted", { fx: "shimmer" })]] : []),
				inline: true,
			};
		}
		if (details.mode === "bounded") return describeBounded(details, options, query);
		const { hits, stats, threshold } = details;
		const scope = details.scopePath === undefined ? undefined : `in ${details.scopePath}`;
		const failed = stats.errors > 0 ? [span(`${stats.errors} failed`, "warning")] : undefined;
		const accounting = [
			`${stats.filesRead} files read`,
			`τ ${threshold.toFixed(2)}`,
			`${formatNumber(stats.inputTokens)} tokens`,
			`$${stats.cost.toFixed(4)}`,
			formatDuration(details.elapsedMs),
		].join(" · ");
		const failures = stats.failures.map((failure, i) =>
			keyed(text([span(failure, "warning")], { wrap: "word", role: "omp.tool.notice" }), `fail${i}`),
		);
		if (hits.length === 0) {
			return {
				tool: findNativeHead(query, compact(["0 hits", scope, failed])),
				tone: "warning",
				inline: true,
				body: failures.length > 0 ? failures : undefined,
			};
		}
		const shown = options.expanded ? hits : hits.slice(0, COLLAPSED_HITS);
		const rangeLimit = options.expanded ? RANGES_EXPANDED : RANGES_COLLAPSED;
		const hidden = hits.length - shown.length;
		const footParts = compact([
			hidden > 0 && formatCount("more hit", hidden),
			`keywords: ${details.keywords.join(", ")}`,
		]);
		// One quiet last line; the accounting ANSI prints in the head rides its tooltip.
		const foot = keyed(
			text([span(footParts.join(" · "), "muted")], { wrap: "word", role: "omp.tool.stats", title: accounting }),
			"foot",
		);
		return {
			tool: findNativeHead(
				query,
				compact([`${formatCount("hit", hits.length)} · ${formatCount("file", stats.filesRead)}`, scope, failed]),
			),
			inline: true,
			body: compact<NativeChild>([
				...shown.map(hit => describeHit(hit, rangeLimit, details.cwd)),
				...failures,
				foot,
			]),
			preview: { lines: PREVIEW_LIMITS.EXPANDED_LINES },
		};
	},
	mergeCallAndResult: true,
	animatedPendingPreview: true,
	animatedPartialResult: true,
} satisfies ToolRenderer<FindRenderArgs, FindToolDetails>;
