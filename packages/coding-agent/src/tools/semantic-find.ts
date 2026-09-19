/**
 * `semantic_find` — on-demand semantic evidence retrieval over a bounded set
 * of caller-named files, globs, and internal resources.
 *
 * Contract highlights:
 * - Only the sources named in `paths` are read. Nothing is auto-attached.
 * - Candidates (passages) are derived locally with exact one-based locations;
 *   the judge only ever returns passage ids, and an unknown id is an error.
 * - Ranking and presence are separate signals: `Choice` probabilities sum to 1
 *   and therefore always nominate a winner, so the independent `exists` noul
 *   decides whether the selection contains an answer at all.
 * - Results are verified by re-reading each reported range from its source;
 *   the model's ranking is a proposal, the re-read is the evidence.
 */
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, sanitizeText, untilAborted } from "@oh-my-pi/pi-utils";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { formatMatchLine } from "@oh-my-pi/pi-tui/tools/match-line-format";
import { DEFAULT_MAX_COLUMN } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import type { JudgmentUsage } from "../judgment";
import { resolveJudge, type ResolvedJudge } from "../judgment";
import {
	type DecisionProvenance,
	LoopBudgetExceeded,
	LoopMeter,
	MAX_CHOICE_OPTIONS,
	type ObservationIdentity,
	type VerificationEvidence,
} from "../judgment/decision";
import semanticFindDescription from "../prompts/tools/semantic-find.md" with { type: "text" };
import { ONLINE_MEMORY_MODEL_KEY } from "../tiny/models";
import type { ToolSession } from ".";
import { getExperimentalContextSession } from "./context-notes";
import {
	type Passage,
	type PassageSource,
	type PassageUnit,
	segmentSource,
	selectSources,
	type SkippedSource,
	SourceCapExceeded,
	type SourceSelection,
} from "./semantic-find/passages";
import {
	ANSWER_PRESENT_HIGH,
	ANSWER_PRESENT_LOW,
	observationOf,
	type RankedPassage,
	type RankingOutcome,
	rankPassages,
} from "./semantic-find/ranking";
import { clampTimeout } from "./tool-timeouts";
import { toolResult } from "./tool-result";

const semanticFindSchema = type({
	query: type("string").describe("natural-language question to answer from the named sources"),
	paths: type("string[]").describe("files, globs, or internal URLs to search; nothing outside this list is read"),
	"unit?": type('"line" | "paragraph" | "auto"').describe(
		"passage granularity; auto picks lines for short prose, indentation-aware blocks for code, paragraphs for long prose",
	),
	"limit?": type("number").describe("how many passages to return (default 8)"),
	"context?": type("number").describe("extra source lines rendered around each hit"),
});

type SemanticFindParams = typeof semanticFindSchema.infer;

/** Highest `limit` a caller may request; the finalist pass must still fit one choice request. */
const MAX_LIMIT = 50;

const DEFAULT_LIMIT = 8;

/** Fraction of the tool deadline reserved for one judgment call. */
const CALL_TIMEOUT_SHARE = 0.5;

export type AnswerVerdict = "absent" | "partial" | "present";

export interface SemanticFindResultDetail {
	/** Path as the caller named it; `read <path>:<startLine>-<endLine>` re-reads this hit. */
	path: string;
	/** Backing filesystem path, or the internal URL for a virtual resource. */
	resolved: string;
	startLine: number;
	endLine: number;
	score: number;
}

export interface SemanticFindCoverage {
	files: number;
	passages: number;
	windows: number;
	passes: number;
	/** First-pass finalists `limit` admitted that the single finalist request could not seat. */
	finalistsDropped: number;
	skipped: SkippedSource[];
}

/** Aggregate of every judgment attempt made for one call, failed and nested ones included. */
export interface SemanticFindUsage {
	calls: number;
	attempts: number;
	input: number;
	output: number;
	costUsd: number | "unknown";
}

export interface SemanticFindDetails {
	query: string;
	answerPresent: number;
	/** `unknown` only when {@link error} is set: ranking produced no verdict. */
	verdict: AnswerVerdict | "unknown";
	results: SemanticFindResultDetail[];
	coverage: SemanticFindCoverage;
	observation: ObservationIdentity;
	verification: VerificationEvidence;
	provenance: DecisionProvenance[];
	usage: SemanticFindUsage;
	/** False when no session ledger was reachable; provenance then lives only here. */
	usageRecorded: boolean;
	/** Why ranking failed; `provenance`/`usage` still account for every attempt made before it did. */
	error?: string;
	meta?: OutputMeta;
}

function verdictOf(answerPresent: number): AnswerVerdict {
	if (answerPresent >= ANSWER_PRESENT_HIGH) return "present";
	return answerPresent < ANSWER_PRESENT_LOW ? "absent" : "partial";
}

function verdictSentence(verdict: AnswerVerdict): string {
	if (verdict === "present") return "answered in the selected files";
	if (verdict === "partial") return "partially addressed";
	return (
		"likely absent from the selected files — this is not proof of absence in the repository; " +
		"try grep/lsp for exact symbols"
	);
}

function plural(count: number, noun: string, pluralForm?: string): string {
	if (count === 1) return `${count} ${noun}`;
	return `${count} ${pluralForm ?? `${noun}s`}`;
}

/** One line naming the judge that answered (or was last asked) plus what every attempt cost. */
function renderProvenance(last: DecisionProvenance | undefined, usage: SemanticFindUsage): string {
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
	results: readonly RankedPassage[],
	sources: readonly PassageSource[],
	observation: ObservationIdentity,
): Promise<VerificationEvidence> {
	const byResolved = new Map(sources.map(source => [source.resolved, source]));
	const freshText = new Map<string, string[]>();
	let checked = 0;
	const mismatched: string[] = [];
	for (const { passage } of results) {
		const source = byResolved.get(passage.resolved);
		// Virtual resources (no backing file) cannot be re-read independently;
		// they are excluded from the count rather than counted as verified.
		if (!source || !path.isAbsolute(source.resolved)) continue;
		let lines = freshText.get(passage.resolved);
		if (!lines) {
			try {
				lines = (await Bun.file(passage.resolved).text()).split("\n");
			} catch (error) {
				logger.debug("semantic_find: re-read failed during verification", {
					path: passage.resolved,
					error: error instanceof Error ? error.message : String(error),
				});
				mismatched.push(passage.resolved);
				continue;
			}
			freshText.set(passage.resolved, lines);
		}
		checked++;
		const actual = lines.slice(passage.startLine - 1, passage.endLine).join("\n");
		if (actual !== passage.text) mismatched.push(`${passage.given}:${passage.startLine}-${passage.endLine}`);
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
		return {
			verified: "unknown",
			method: "reread-range",
			observation,
			detail: "no file-backed result to re-read",
		};
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

function renderHit(result: RankedPassage, sourceLines: readonly string[] | undefined, context: number): string {
	const { passage } = result;
	const head = `${passage.given}:${passage.startLine}-${passage.endLine}  score ${result.score.toFixed(2)}`;
	const rows: string[] = [head];
	const passageLines = passage.text.split("\n");
	const before = sourceLines ? Math.max(1, passage.startLine - context) : passage.startLine;
	const after = sourceLines ? Math.min(sourceLines.length, passage.endLine + context) : passage.endLine;
	for (let line = before; line < passage.startLine; line++) {
		rows.push(formatMatchLine(line, snippetLine(sourceLines?.[line - 1] ?? ""), false, { useHashLines: true }));
	}
	for (let i = 0; i < passageLines.length; i++) {
		rows.push(formatMatchLine(passage.startLine + i, snippetLine(passageLines[i]), true, { useHashLines: true }));
	}
	for (let line = passage.endLine + 1; line <= after; line++) {
		rows.push(formatMatchLine(line, snippetLine(sourceLines?.[line - 1] ?? ""), false, { useHashLines: true }));
	}
	return rows.join("\n");
}

/** Ranks caller-named passages against a natural-language query using the shared judgment backend. */
export class SemanticFindTool implements AgentTool<typeof semanticFindSchema, SemanticFindDetails> {
	readonly name = "semantic_find";
	readonly approval = "read" as const;
	readonly label = "Semantic Find";
	readonly loadMode = "discoverable";
	readonly summary = "Rank passages of named files by how well they answer a question";
	readonly parameters = semanticFindSchema;
	readonly strict = true;

	readonly #session: ToolSession;
	readonly #judgeOverride?: ResolvedJudge;

	/**
	 * @param judge Injected judge. Production passes nothing and resolves per
	 *   call through {@link resolveJudge}; tests and offline smokes pass a
	 *   deterministic implementation.
	 */
	constructor(session: ToolSession, judge?: ResolvedJudge) {
		this.#session = session;
		this.#judgeOverride = judge;
	}

	static createIf(session: ToolSession): SemanticFindTool | null {
		// Without a model registry there is no judge to resolve, and this tool
		// has no lexical fallback by design — `grep` covers that.
		return session.modelRegistry ? new SemanticFindTool(session) : null;
	}

	get description(): string {
		const settings = this.#session.settings;
		return prompt.render(semanticFindDescription, {
			maxFiles: settings.get("semanticFind.maxFiles"),
			maxBytesPerFile: settings.get("semanticFind.maxBytesPerFile"),
			maxPassages: settings.get("semanticFind.maxPassages"),
		});
	}

	async execute(
		_toolCallId: string,
		params: SemanticFindParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SemanticFindDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<SemanticFindDetails>> {
		return untilAborted(signal, () => this.#run(params, signal));
	}

	#resolveJudge(usage: { recorded: boolean }): ResolvedJudge {
		if (this.#judgeOverride) return this.#judgeOverride;
		const registry = this.#session.modelRegistry;
		if (!registry) {
			throw new ToolError(
				"semantic_find unavailable: no model registry in this session; use grep for exact matches",
			);
		}
		const manager = this.#session.sessionManager;
		const sessionId = manager?.getSessionId?.() ?? this.#session.getSessionId?.() ?? undefined;
		let onUsage: ((entry: JudgmentUsage) => void) | undefined;
		if (manager?.appendModelUsage && manager.getLeafId && manager.getSessionId) {
			const append = manager.appendModelUsage.bind(manager);
			const owner = { sessionId: manager.getSessionId(), parentId: manager.getLeafId() };
			onUsage = entry => {
				const id = append({ purpose: "semantic-find", ...entry }, owner);
				if (id) owner.parentId = id;
				usage.recorded = true;
			};
		}
		try {
			return resolveJudge({
				settings: this.#session.settings,
				registry,
				backend: ONLINE_MEMORY_MODEL_KEY,
				sessionId,
				onUsage,
			});
		} catch (error) {
			throw new ToolError(
				`semantic_find unavailable: ${error instanceof Error ? error.message : String(error)}; use grep for exact matches`,
			);
		}
	}

	async #run(params: SemanticFindParams, signal?: AbortSignal): Promise<AgentToolResult<SemanticFindDetails>> {
		const query = params.query.trim();
		if (query === "") throw new ToolError("semantic_find requires a non-empty query");
		if (params.paths.length === 0) {
			throw new ToolError("semantic_find requires at least one path; it never reads sources you did not name");
		}
		const settings = this.#session.settings;
		const maxFiles = settings.get("semanticFind.maxFiles");
		const maxBytesPerFile = settings.get("semanticFind.maxBytesPerFile");
		const maxPassages = settings.get("semanticFind.maxPassages");
		const windowSize = Math.min(settings.get("semanticFind.passagesPerRequest"), MAX_CHOICE_OPTIONS);
		const context = Math.max(0, Math.floor(params.context ?? settings.get("semanticFind.contextLines")));
		const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(params.limit ?? DEFAULT_LIMIT)));
		const unit: PassageUnit = params.unit ?? "auto";

		let selection: SourceSelection;
		try {
			selection = await selectSources({
				paths: params.paths,
				cwd: this.#session.cwd,
				caps: { maxFiles, maxBytesPerFile },
				resolveContext: this.#resolveContext(signal),
				signal,
			});
		} catch (error) {
			if (error instanceof SourceCapExceeded) throw new ToolError(error.message);
			throw error;
		}

		const passages: Passage[] = [];
		for (const source of selection.sources) {
			for (const passage of segmentSource(source, unit, passages.length + 1)) passages.push(passage);
			if (passages.length > maxPassages) {
				throw new ToolError(
					`${passages.length} passages exceed semanticFind.maxPassages (${maxPassages}); ` +
						`narrow paths, or pass unit:"paragraph" to group lines`,
				);
			}
		}
		if (passages.length === 0) {
			throw new ToolError(
				`semantic_find unavailable: no readable passages in ${describeSkipped(params.paths, selection.skipped)}; ` +
					"use grep for exact matches",
			);
		}

		const usageState = { recorded: false };
		const judge = this.#resolveJudge(usageState);
		const timeoutMs = clampTimeout("semantic_find", undefined, settings.get("tools.maxTimeout")) * 1000;
		const windows = Math.ceil(passages.length / windowSize);
		const meter = new LoopMeter({
			maxCalls: windows + 1,
			maxActions: windows + 1,
			deadlineAt: Date.now() + timeoutMs,
			signal,
		});
		const observation = observationOf(passages);
		const coverage = (ranking: RankingOutcome | undefined): SemanticFindCoverage => ({
			files: selection.sources.length,
			passages: passages.length,
			windows: ranking?.windows ?? 0,
			passes: ranking?.passes ?? 0,
			finalistsDropped: ranking?.finalistsDropped ?? 0,
			skipped: selection.skipped,
		});

		let ranking: RankingOutcome;
		try {
			ranking = await rankPassages({
				judge,
				meter,
				query,
				passages,
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
					? `semantic_find unavailable: ${reason} after ${plural(meter.calls, "judgment call")}; narrow paths or use grep for exact matches`
					: `semantic_find unavailable: ${reason}; use grep for exact matches`;
			const usage = meter.totalUsage();
			const details: SemanticFindDetails = {
				query,
				answerPresent: 0,
				verdict: "unknown",
				results: [],
				coverage: coverage(undefined),
				observation,
				verification: {
					verified: "unknown",
					method: "reread-range",
					observation,
					detail: "ranking failed before any result could be re-read",
				},
				provenance: meter.attempts.slice(),
				usage,
				usageRecorded: usageState.recorded,
				error: reason,
			};
			const text = [
				`semantic_find "${query}"`,
				sanitizeText(message),
				renderProvenance(meter.attempts.at(-1), usage),
			].join("\n");
			return toolResult(details).text(text).error().done();
		}

		const verification = await verifyResults(ranking.results, selection.sources, observation);
		const usage = meter.totalUsage();
		const verdict = verdictOf(ranking.answerPresent);
		const sourceLines = new Map(selection.sources.map(source => [source.resolved, source.text.split("\n")]));

		const text = this.#render({
			query,
			ranking,
			verdict,
			verification,
			skipped: selection.skipped,
			fileCount: selection.sources.length,
			passageCount: passages.length,
			context,
			sourceLines,
			usage,
		});

		const details: SemanticFindDetails = {
			query,
			answerPresent: ranking.answerPresent,
			verdict,
			results: ranking.results.map(result => ({
				path: result.passage.given,
				resolved: result.passage.resolved,
				startLine: result.passage.startLine,
				endLine: result.passage.endLine,
				score: result.score,
			})),
			coverage: coverage(ranking),
			observation,
			verification,
			provenance: ranking.provenance,
			usage,
			usageRecorded: usageState.recorded,
		};
		return toolResult(details).text(text).done();
	}

	#render(input: {
		query: string;
		ranking: RankingOutcome;
		verdict: AnswerVerdict;
		verification: VerificationEvidence;
		skipped: readonly SkippedSource[];
		fileCount: number;
		passageCount: number;
		context: number;
		sourceLines: ReadonlyMap<string, string[]>;
		usage: SemanticFindUsage;
	}): string {
		const { ranking } = input;
		const sections: string[] = [];
		sections.push(`semantic_find "${input.query}"`);
		sections.push(
			`coverage: ${plural(input.fileCount, "source")}, ${plural(input.passageCount, "passage")}, ` +
				`${plural(ranking.windows, "window")}, ${plural(ranking.passes, "pass", "passes")}`,
		);
		if (ranking.finalistsDropped > 0) {
			sections.push(
				`${plural(ranking.finalistsDropped, "finalist")} dropped: the finalist pass seats ` +
					`floor(passagesPerRequest / windows) per window; raise semanticFind.passagesPerRequest or narrow paths`,
			);
		}
		for (const skip of input.skipped) sections.push(`skipped ${skip.path}: ${sanitizeText(skip.reason)}`);
		sections.push(`answerPresent ${ranking.answerPresent.toFixed(2)} — ${verdictSentence(input.verdict)}`);
		if (input.verification.detail) {
			sections.push(`verification (${String(input.verification.verified)}): ${input.verification.detail}`);
		}

		const body = ranking.results.map(result =>
			renderHit(result, input.sourceLines.get(result.passage.resolved), input.context),
		);
		const provenance = renderProvenance(ranking.provenance.at(-1), input.usage);

		return [sections.join("\n"), body.join("\n\n"), provenance].filter(part => part !== "").join("\n\n");
	}

	/** Mirrors `ReadTool`'s resolve context so internal URLs resolve identically here. */
	#resolveContext(signal?: AbortSignal) {
		const session = this.#session;
		return {
			cwd: session.cwd,
			settings: session.settings,
			signal,
			sessionFile: session.getSessionFile() ?? undefined,
			experimentalContextManagement: session.settings.get("compaction.experimentalContextManagement") === true,
			getSessionBranch: () => getExperimentalContextSession(session).getBranch(),
			sessionId: session.sessionManager?.getSessionId?.() ?? session.getSessionId?.() ?? undefined,
			agentRegistry: session.agentRegistry,
			localProtocolOptions: session.localProtocolOptions,
			skills: session.skills,
			rules: session.activeRules,
		};
	}
}

function describeSkipped(paths: readonly string[], skipped: readonly SkippedSource[]): string {
	if (skipped.length === 0) return paths.join(", ");
	return skipped.map(skip => `${skip.path} (${skip.reason})`).join("; ");
}
