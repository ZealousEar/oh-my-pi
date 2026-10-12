/**
 * Bounded `find` (`paths`): semantic evidence retrieval over an explicitly
 * named set of files, globs, and internal resources.
 *
 * Contract highlights:
 * - Only the sources named in `paths` are read. Nothing is auto-attached.
 * - Excerpts are derived locally with exact one-based locations; the judge
 *   only ever returns excerpt ids, and an unknown id is an error.
 * - Ranking and presence are separate signals: `Choice` probabilities sum to 1
 *   and therefore always nominate a winner, so the independent `exists` noul
 *   decides whether the selection contains an answer at all.
 * - Results are verified by re-reading each reported range from its source;
 *   the model's ranking is a proposal, the re-read is the evidence.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui/render";
import type { FindBoundedDetails } from "@oh-my-pi/pi-tui/tools/find";
import { formatMatchLine } from "@oh-my-pi/pi-tui/tools/match-line-format";
import { DEFAULT_MAX_COLUMN } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { InternalUrlFilesystem } from "../../internal-urls/url-filesystem";
import {
	type DecisionJudge,
	type DecisionProvenance,
	LoopBudgetExceeded,
	LoopMeter,
	MAX_CHOICE_OPTIONS,
	type ObservationIdentity,
	type VerificationEvidence,
} from "../../judgment/decision";
import { toolResult } from "../tool-result";
import {
	type Excerpt,
	type ExcerptSource,
	type ExcerptUnit,
	segmentSource,
	selectSources,
	type SkippedSource,
	SourceCapExceeded,
	type SourceSelection,
} from "./excerpts";
import {
	ANSWER_PRESENT_HIGH,
	ANSWER_PRESENT_LOW,
	observationOf,
	type RankedExcerpt,
	type RankingOutcome,
	rankExcerpts,
} from "./ranking";
import { readText } from "./text";

import {
	cfgSemanticFindContextLines,
	cfgSemanticFindMaxBytesPerFile,
	cfgSemanticFindMaxFiles,
	cfgSemanticFindMaxPassages,
	cfgSemanticFindPassagesPerRequest,
	cfgToolsMaxTimeout,
} from "../settings";

/** Highest `limit` a caller may request; the finalist pass must still fit one choice request. */
const MAX_LIMIT = 50;

const DEFAULT_LIMIT = 8;

/** Wall budget of one bounded call in seconds; `tools.maxTimeout` (when positive) caps it further. */
const TIMEOUT_S = 60;

/** Fraction of the call budget reserved for one judgment request. */
const CALL_TIMEOUT_SHARE = 0.5;

/** Full judgment evidence of a bounded find: the transcript's display contract plus what the decision loop recorded. */
export interface BoundedFindDetails extends FindBoundedDetails {
	observation: ObservationIdentity;
	verification: VerificationEvidence;
	provenance: DecisionProvenance[];
	/** False when no session ledger was reachable; provenance then lives only here. */
	usageRecorded: boolean;
}

export interface BoundedFindOptions {
	query: string;
	paths: readonly string[];
	unit?: ExcerptUnit;
	limit?: number;
	context?: number;
	cwd: string;
	settings: Settings;
	/** Filesystem every named source is read (and re-read for verification) through. */
	filesystem: InternalUrlFilesystem;
	judge: DecisionJudge;
	/** Whether the judge's usage reaches a session ledger. */
	usageRecorded: boolean;
	signal?: AbortSignal;
}

function plural(count: number, noun: string, pluralForm?: string): string {
	if (count === 1) return `${count} ${noun}`;
	return `${count} ${pluralForm ?? `${noun}s`}`;
}

function verdictSentence(verdict: FindBoundedDetails["verdict"]): string {
	if (verdict === "present") return "answered in the selected files";
	if (verdict === "partial") return "partially addressed";
	return (
		"likely absent from the selected files — this is not proof of absence in the repository; " +
		"try grep/lsp for exact symbols"
	);
}

/** One line naming the judge that answered (or was last asked) plus what every attempt cost. */
function renderProvenance(last: DecisionProvenance | undefined, usage: FindBoundedDetails["usage"]): string {
	if (!last) return "provenance: unavailable";
	const cost = usage.costUsd === "unknown" ? "cost unknown" : `cost $${usage.costUsd.toFixed(4)}`;
	const outcome = last.error ? `failed (${sanitizeText(last.error)})` : `${last.distribution} distribution`;
	return (
		`provenance: ${last.backend} judge ${last.provider}/${last.model}, ${outcome}, ` +
		`${plural(usage.calls, "call")}, ${plural(usage.attempts, "attempt")}, ${cost}` +
		(last.fallback ? `, fell back from ${last.fallback.from}` : "")
	);
}

/** Re-read every reported range from its source and compare it to what is being rendered. */
async function verifyResults(
	results: readonly RankedExcerpt[],
	sources: readonly ExcerptSource[],
	filesystem: InternalUrlFilesystem,
	maxBytesPerFile: number,
	observation: ObservationIdentity,
): Promise<VerificationEvidence> {
	const byResolved = new Map(sources.map(source => [source.resolved, source]));
	const freshText = new Map<string, string[]>();
	let checked = 0;
	const mismatched: string[] = [];
	for (const { excerpt } of results) {
		if (!byResolved.has(excerpt.resolved)) continue;
		let lines = freshText.get(excerpt.resolved);
		if (!lines) {
			try {
				lines = (await readText(filesystem, excerpt.resolved, maxBytesPerFile)).text.split("\n");
			} catch (error) {
				logger.debug("find: re-read failed during verification", {
					path: excerpt.resolved,
					error: error instanceof Error ? error.message : String(error),
				});
				mismatched.push(excerpt.resolved);
				continue;
			}
			freshText.set(excerpt.resolved, lines);
		}
		checked++;
		const actual = lines.slice(excerpt.startLine - 1, excerpt.endLine).join("\n");
		if (actual !== excerpt.text) mismatched.push(`${excerpt.given}:${excerpt.startLine}-${excerpt.endLine}`);
	}
	if (mismatched.length > 0) {
		return {
			verified: false,
			method: "reread-range",
			observation,
			detail: `source changed while ranking: ${mismatched.join(", ")} no longer matches the excerpt`,
		};
	}
	if (checked === 0) {
		return { verified: "unknown", method: "reread-range", observation, detail: "no result to re-read" };
	}
	return {
		verified: true,
		method: "reread-range",
		observation,
		detail: `${plural(checked, "result")} re-read at the reported location`,
	};
}

/** Source text is untrusted: one display row per source line, no control or escape sequences. */
function snippetLine(line: string): string {
	return truncateToWidth(replaceTabs(sanitizeText(line)), DEFAULT_MAX_COLUMN);
}

function renderHit(result: RankedExcerpt, sourceLines: readonly string[] | undefined, context: number): string {
	const { excerpt } = result;
	const rows = [`${excerpt.given}:${excerpt.startLine}-${excerpt.endLine}  score ${result.score.toFixed(2)}`];
	const excerptLines = excerpt.text.split("\n");
	const before = sourceLines ? Math.max(1, excerpt.startLine - context) : excerpt.startLine;
	const after = sourceLines ? Math.min(sourceLines.length, excerpt.endLine + context) : excerpt.endLine;
	for (let line = before; line < excerpt.startLine; line++) {
		rows.push(formatMatchLine(line, snippetLine(sourceLines?.[line - 1] ?? ""), false, { useHashLines: true }));
	}
	for (let i = 0; i < excerptLines.length; i++) {
		rows.push(formatMatchLine(excerpt.startLine + i, snippetLine(excerptLines[i]), true, { useHashLines: true }));
	}
	for (let line = excerpt.endLine + 1; line <= after; line++) {
		rows.push(formatMatchLine(line, snippetLine(sourceLines?.[line - 1] ?? ""), false, { useHashLines: true }));
	}
	return rows.join("\n");
}

function coverageOf(
	selection: SourceSelection,
	excerpts: number,
	ranking: RankingOutcome | undefined,
): FindBoundedDetails["coverage"] {
	return {
		files: selection.sources.length,
		passages: excerpts,
		windows: ranking?.windows ?? 0,
		passes: ranking?.passes ?? 0,
		finalistsDropped: ranking?.finalistsDropped ?? 0,
		skipped: selection.skipped,
	};
}

function describeSkipped(paths: readonly string[], skipped: readonly SkippedSource[]): string {
	if (skipped.length === 0) return paths.join(", ");
	return skipped.map(skip => `${skip.path} (${skip.reason})`).join("; ");
}

/**
 * Run one bounded find. Caller aborts propagate; a judge failure or spent
 * budget is a failed tool result carrying the provenance of every attempt.
 * @throws {ToolError} empty inputs, exceeded caps, or nothing readable.
 */
export async function runBounded(options: BoundedFindOptions): Promise<AgentToolResult<BoundedFindDetails>> {
	const query = options.query.trim();
	if (query === "") throw new ToolError("`query` must be a non-empty description");
	if (options.paths.length === 0) {
		throw new ToolError("`paths` needs at least one entry; find never reads sources you did not name");
	}
	const { settings, cwd, filesystem, signal } = options;
	const started = performance.now();
	const maxFiles = cfgSemanticFindMaxFiles.get(settings);
	const maxBytesPerFile = cfgSemanticFindMaxBytesPerFile.get(settings);
	const maxPassages = cfgSemanticFindMaxPassages.get(settings);
	const windowSize = Math.min(cfgSemanticFindPassagesPerRequest.get(settings), MAX_CHOICE_OPTIONS);
	const context = Math.max(0, Math.floor(options.context ?? cfgSemanticFindContextLines.get(settings)));
	const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(options.limit ?? DEFAULT_LIMIT)));
	const unit = options.unit ?? "auto";
	const maxTimeout = cfgToolsMaxTimeout.get(settings);
	const timeoutMs = (maxTimeout > 0 ? Math.max(1, Math.min(TIMEOUT_S, maxTimeout)) : TIMEOUT_S) * 1000;

	let selection: SourceSelection;
	try {
		selection = await selectSources({
			paths: options.paths,
			cwd,
			caps: { maxFiles, maxBytesPerFile },
			filesystem,
			signal,
		});
	} catch (error) {
		if (error instanceof SourceCapExceeded) throw new ToolError(error.message);
		throw error;
	}

	const excerpts: Excerpt[] = [];
	for (const source of selection.sources) {
		for (const excerpt of segmentSource(source, unit, excerpts.length + 1)) excerpts.push(excerpt);
		if (excerpts.length > maxPassages) {
			throw new ToolError(
				`${excerpts.length} passages exceed semanticFind.maxPassages (${maxPassages}); ` +
					`narrow paths, or pass unit:"paragraph" to group lines`,
			);
		}
	}
	if (excerpts.length === 0) {
		throw new ToolError(
			`no readable passages in ${describeSkipped(options.paths, selection.skipped)}; use grep for exact matches`,
		);
	}

	const windows = Math.ceil(excerpts.length / windowSize);
	const meter = new LoopMeter({
		maxCalls: windows + 1,
		maxActions: windows + 1,
		deadlineAt: Date.now() + timeoutMs,
		signal,
	});
	const observation = observationOf(excerpts);

	let ranking: RankingOutcome;
	try {
		ranking = await rankExcerpts({
			judge: options.judge,
			meter,
			query,
			excerpts,
			windowSize,
			limit,
			callTimeoutMs: Math.max(1000, Math.floor(timeoutMs * CALL_TIMEOUT_SHARE)),
			signal,
		});
	} catch (error) {
		// Caller aborts propagate; every other failure is reported with the
		// attempts it cost, so provenance is never lost with the answer.
		if (signal?.aborted) throw error;
		const reason = error instanceof Error ? error.message : String(error);
		const message =
			error instanceof LoopBudgetExceeded
				? `find unavailable: ${reason} after ${plural(meter.calls, "judgment call")}; narrow paths or use grep for exact matches`
				: `find unavailable: ${reason}; use grep for exact matches`;
		const usage = meter.totalUsage();
		const details: BoundedFindDetails = {
			mode: "bounded",
			query,
			answerPresent: 0,
			verdict: "unknown",
			results: [],
			coverage: coverageOf(selection, excerpts.length, undefined),
			observation,
			verification: {
				verified: "unknown",
				method: "reread-range",
				observation,
				detail: "ranking failed before any result could be re-read",
			},
			provenance: meter.attempts.slice(),
			usage,
			usageRecorded: options.usageRecorded,
			elapsedMs: performance.now() - started,
			cwd,
			error: reason,
		};
		const text = [`find "${query}" (bounded)`, sanitizeText(message), renderProvenance(meter.attempts.at(-1), usage)];
		return toolResult(details).text(text.join("\n")).error().done();
	}

	const verification = await verifyResults(
		ranking.results,
		selection.sources,
		filesystem,
		maxBytesPerFile,
		observation,
	);
	const usage = meter.totalUsage();
	const verdict =
		ranking.answerPresent >= ANSWER_PRESENT_HIGH
			? "present"
			: ranking.answerPresent < ANSWER_PRESENT_LOW
				? "absent"
				: "partial";
	const sourceLines = new Map(selection.sources.map(source => [source.resolved, source.text.split("\n")]));

	const sections = [
		`find "${query}" (bounded)`,
		`coverage: ${plural(selection.sources.length, "source")}, ${plural(excerpts.length, "passage")}, ` +
			`${plural(ranking.windows, "window")}, ${plural(ranking.passes, "pass", "passes")}`,
	];
	if (ranking.finalistsDropped > 0) {
		sections.push(
			`${plural(ranking.finalistsDropped, "finalist")} dropped: the finalist pass seats ` +
				`floor(passagesPerRequest / windows) per window; raise semanticFind.passagesPerRequest or narrow paths`,
		);
	}
	for (const skip of selection.skipped) sections.push(`skipped ${skip.path}: ${sanitizeText(skip.reason)}`);
	sections.push(`answerPresent ${ranking.answerPresent.toFixed(2)} — ${verdictSentence(verdict)}`);
	if (verification.detail) sections.push(`verification (${String(verification.verified)}): ${verification.detail}`);
	const body = ranking.results.map(result => renderHit(result, sourceLines.get(result.excerpt.resolved), context));
	const text = [sections.join("\n"), body.join("\n\n"), renderProvenance(ranking.provenance.at(-1), usage)]
		.filter(part => part !== "")
		.join("\n\n");

	const details: BoundedFindDetails = {
		mode: "bounded",
		query,
		answerPresent: ranking.answerPresent,
		verdict,
		results: ranking.results.map(result => ({
			path: result.excerpt.given,
			resolved: result.excerpt.resolved,
			startLine: result.excerpt.startLine,
			endLine: result.excerpt.endLine,
			score: result.score,
			snippet: snippetLine(result.excerpt.text.split("\n").find(line => line.trim() !== "") ?? "").trim(),
		})),
		coverage: coverageOf(selection, excerpts.length, ranking),
		observation,
		verification,
		provenance: ranking.provenance,
		usage,
		usageRecorded: options.usageRecorded,
		elapsedMs: performance.now() - started,
		cwd,
	};
	return toolResult(details).text(text).done();
}
