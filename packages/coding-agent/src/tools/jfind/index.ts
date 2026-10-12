/**
 * `find`: semantic grep over the workspace, driven by the session's judge
 * role. A cascade search (`path`) explores a directory or file — lexical
 * prior, filename ranking, sketch routing, passage verification — in
 * {@link runCascade}. A bounded search (`paths`) ranks excerpts of exactly the
 * named files, globs, and internal URLs and reports the independent
 * `answerPresent` probability beside the ranking, in {@link runBounded}. This
 * file is the tool contract and the model-facing report.
 */
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { FindCascadeDetails, FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatBytes, formatDuration, formatNumber, prompt } from "@oh-my-pi/pi-utils";
import { sessionResolveContext } from "../../internal-urls/context";
import { InternalUrlFilesystem } from "../../internal-urls/url-filesystem";
import {
	type ChainJudge,
	hasNativeJudge,
	type JudgeDeps,
	journalJudgmentUsage,
	nativeJudgeRejection,
	resolveJudge,
	sharedJudgmentCache,
} from "../../judgment";
import findDescription from "../../prompts/tools/find.md" with { type: "text" };
import { SPOTLIGHT_ENTRY } from "../../spotlight/types";
import type { ToolSession } from "..";
import { resolveToolTier } from "../approval";
import {
	formatPathRelativeToCwd,
	normalizePathLikeInput,
	parseFindPattern,
	resolveSearchResultPath,
	searchPathTier,
} from "../path-utils";
import { searchApprovalCacheTargets } from "../search-approval-targets";
import { cfgFindVerifyModel } from "../settings";
import { toolResult } from "../tool-result";
import { runBounded } from "./bounded";
import { type CascadeResult, runCascade } from "./cascade";
import { rankedHeat } from "./passages";
import { resolveSearchRoot } from "./tree";

import {
	cfgFindEnabled,
	cfgFindHitThreshold,
	cfgSemanticFindMaxBytesPerFile,
	cfgSemanticFindMaxFiles,
	cfgSemanticFindMaxPassages,
} from "../settings";

const findSchema = type({
	query: "string",
	grep_keywords: "string[]",
	"path?": "string",
	"paths?": "string[]",
	"unit?": '"line" | "paragraph" | "auto"',
	"limit?": "number",
	"context?": "number",
});

export type FindToolInput = typeof findSchema.infer;

/** Line ranges shown per hit in the model-facing text, strongest first. */
const RANGES_SHOWN = 3;

/** Wall-clock budget for one `find` call; a stalled judge ends it with the hits verified so far instead of blocking the turn. */
export const FIND_TIMEOUT_MS = 20_000;

/**
 * Resolve `find.enabled` for a session: `auto` enables `find` only when the
 * judge role is backed by a working native System One model ({@link hasNativeJudge})
 * rather than a prompted small model or a native route that rejected the account.
 * Gates tool creation and the `find` hints in sibling tool prompts.
 */
export function isFindEnabled(session: ToolSession): boolean {
	const mode = cfgFindEnabled.get(session.settings);
	if (mode !== "auto") return mode === "on";
	return (
		session.modelRegistry !== undefined &&
		hasNativeJudge(session.settings, session.modelRegistry, session.getActiveModel?.())
	);
}

/** Semantic search tool: describe a behavior, get files and line ranges that implement it. */
export class FindTool implements AgentTool<typeof findSchema, FindToolDetails> {
	readonly name = "find";
	readonly approval = searchPathTier;
	/**
	 * `always-ask-cached` keys: the tree (or file) a cascade searches, as `grep` reports one, or
	 * each source a bounded search reads (a glob source keys the folder it walks).
	 */
	readonly approvalCacheTargets = (args: unknown): readonly string[] | undefined => {
		const input = args as { path?: string; paths?: unknown } | null | undefined;
		if (Array.isArray(input?.paths)) {
			const sources = input.paths.filter((entry): entry is string => typeof entry === "string");
			return searchApprovalCacheTargets(sources, this.session.cwd, entry => parseFindPattern(entry).basePath);
		}
		const root = input?.path;
		return searchApprovalCacheTargets(root ? [root] : [], this.session.cwd, entry => entry);
	};
	readonly loadMode = "essential";
	readonly label = "Find";
	readonly summary = "Semantic grep: find files and line ranges by describing what they do";
	readonly parameters = findSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	get description(): string {
		const settings = this.session.settings;
		return prompt.render(findDescription, {
			maxFiles: cfgSemanticFindMaxFiles.get(settings),
			maxBytesPerFile: cfgSemanticFindMaxBytesPerFile.get(settings),
			maxPassages: cfgSemanticFindMaxPassages.get(settings),
		});
	}

	/** The session's judge-role chain; its usage journals under `find` when a ledger is reachable. */
	#judge(): { judge: ChainJudge; deps: JudgeDeps; usageRecorded: boolean } {
		const registry = this.session.modelRegistry;
		if (!registry) throw new ToolError("find has no model registry to resolve a judge from");
		const sessionModel = this.session.getActiveModel?.();
		const rejected = nativeJudgeRejection(this.session.settings, registry, sessionModel);
		if (rejected) throw new ToolError(`find is disabled for this session: judge ${rejected}. Use grep.`);
		const deps: JudgeDeps = {
			settings: this.session.settings,
			registry,
			sessionModel,
			sessionId: this.session.getSessionId?.() ?? undefined,
			purpose: "find",
			onUsage: journalJudgmentUsage(this.session.sessionManager),
			telemetry: this.session.getTelemetry?.(),
			cache: sharedJudgmentCache(),
			costGate: this.session.costGate,
		};
		return { judge: resolveJudge(deps), deps, usageRecorded: deps.onUsage !== undefined };
	}

	async execute(
		toolCallId: string,
		params: FindToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<FindToolDetails>,
	): Promise<AgentToolResult<FindToolDetails>> {
		const query = params.query.trim();
		if (query.length === 0) throw new ToolError("`query` must be a non-empty description");
		const cwd = this.session.cwd;
		// Host paths stay native; internal URLs (`local://`, `omp://`, …) are
		// listed, scanned, and read in place through the URL filesystem.
		const filesystem = new InternalUrlFilesystem({
			context: sessionResolveContext(this.session, { signal, containSkillPaths: true }),
			tier: resolveToolTier(this, params),
		});
		if (params.paths !== undefined) {
			if (params.path !== undefined) {
				throw new ToolError("`path` scopes a cascade search and `paths` names a bounded set; pass one, not both");
			}
			const { judge, usageRecorded } = this.#judge();
			return runBounded({
				query,
				paths: params.paths,
				unit: params.unit,
				limit: params.limit,
				context: params.context,
				cwd,
				settings: this.session.settings,
				filesystem,
				judge,
				usageRecorded,
				signal,
			});
		}
		if (params.unit !== undefined || params.limit !== undefined || params.context !== undefined) {
			throw new ToolError(
				"`unit`, `limit`, and `context` apply only to a bounded search; name its sources in `paths`",
			);
		}
		const rawScopeInput = params.path === undefined ? "" : normalizePathLikeInput(params.path);
		const root = await resolveSearchRoot(filesystem, rawScopeInput, cwd);
		const scopePath =
			root.path === path.resolve(cwd)
				? undefined
				: formatPathRelativeToCwd(root.path, cwd, { trailingSlash: root.type === "directory" });
		const { judge, deps: judgeDeps } = this.#judge();
		const verifyModel = cfgFindVerifyModel.get(this.session.settings)?.trim();
		const verifyJudge = verifyModel ? resolveJudge({ ...judgeDeps, leadModel: verifyModel }) : undefined;
		const experiment = this.session.spotlight;
		const started = performance.now();
		const deadline = AbortSignal.timeout(FIND_TIMEOUT_MS);
		// The phase the deadline interrupts, named when nothing was verified before it.
		let phase = "lexical scan";
		let result: CascadeResult | undefined;
		try {
			result = await runCascade({
				root,
				filesystem,
				query,
				extraKeywords: params.grep_keywords,
				judge,
				verifyJudge,
				spotlight: experiment ? { client: experiment.client, thinking: experiment.thinking } : undefined,
				includeHidden: false,
				signal,
				deadline,
				threshold: cfgFindHitThreshold.get(this.session.settings),
				onProgress: message => {
					// Keep the phase the deadline interrupted; the cascade still reads files after it.
					if (!deadline.aborted) phase = message;
					onUpdate?.({ content: [{ type: "text", text: message }] });
				},
			});
		} catch (error) {
			if (!deadline.aborted || signal?.aborted) throw error;
		}
		if (!result) {
			throw new ToolError(
				`find timed out after ${formatDuration(FIND_TIMEOUT_MS)} at "${phase}", before any file was judged. Narrow \`path\` to a smaller tree, or use grep.`,
			);
		}
		const elapsedMs = performance.now() - started;
		const { stats, threshold, keywords, coverage, ranking, timeout } = result;
		experiment?.log(SPOTLIGHT_ENTRY.find, {
			toolCallId,
			ranker: ranking.ranker,
			candidates: ranking.candidates,
			read: ranking.read,
			hits: result.hits.length,
			spotlightMs: ranking.spotlight?.ms,
			spotlightTokens: ranking.spotlight?.inputTokens,
			spotlightCostUsd: ranking.spotlight?.costUsd,
			spotlightError: ranking.spotlight?.error,
			judgeRequests: stats.requests,
			judgeRequestsSaved: ranking.judgeRequestsSaved,
			judgeCostUsd: stats.cost - (ranking.spotlight?.costUsd ?? 0),
			elapsedMs: Math.round(elapsedMs),
		});
		// Cascade paths are root-relative; the model and renderer want paths
		// `read` resolves (cwd-relative files, URLs under URL scopes, including
		// with `:start-end` selectors) without knowing the scope.
		const hits = result.hits.map(hit => ({
			...hit,
			rel: formatPathRelativeToCwd(resolveSearchResultPath(root.path, hit.rel), cwd),
		}));
		const lexicalFallback = result.lexicalFallback.map(match => ({
			...match,
			rel: formatPathRelativeToCwd(resolveSearchResultPath(root.path, match.rel), cwd),
		}));
		const details: FindCascadeDetails = {
			mode: "cascade",
			query,
			keywords,
			threshold,
			hits,
			lexicalFallback,
			coverage,
			stats,
			timeout,
			elapsedMs,
			cwd,
			scopePath,
		};
		const where = scopePath === undefined ? "" : ` in ${scopePath}`;
		const out: string[] = [];
		const disabled =
			coverage === "unavailable"
				? nativeJudgeRejection(this.session.settings, judgeDeps.registry, judgeDeps.sessionModel)
				: undefined;
		if (disabled) {
			out.push(
				`find is disabled for this session: judge ${disabled}. Nothing was judged for "${query}"${where}; use grep.`,
			);
		} else if (coverage === "unavailable") {
			out.push(
				`find unavailable for "${query}"${where}: all ${stats.requests} judge requests failed, nothing was judged. This is not evidence of absence; use grep.`,
			);
		} else if (timeout?.passages === 0) {
			out.push(
				`find timed out after ${formatDuration(FIND_TIMEOUT_MS)} at "${phase}", before any passage was verified. This is not evidence of absence; narrow \`path\`, or use grep.`,
			);
		} else if (stats.listed === 0) {
			out.push(
				`no eligible files${where || " in the workspace"}: find skips gitignored, hidden, binary and credential files and build/vendor dirs (dist, build, out, target, node_modules, …). grep with \`gitignore: false\` searches them.`,
			);
		} else if (hits.length === 0) {
			out.push(`no hits for "${query}"${where} (τ ${threshold.toFixed(2)})`);
		} else {
			out.push(`${hits.length} hit(s) for "${query}"${where} (τ ${threshold.toFixed(2)}), strongest first`);
		}
		if (timeout && timeout.passages > 0) {
			out.push(
				`partial: timed out after ${formatDuration(FIND_TIMEOUT_MS)} with ${timeout.verified} of ${timeout.passages} passages verified; unverified files may still match. Narrow \`path\` for a complete search.`,
			);
		}
		if (coverage === "partial" && stats.failed > 0) {
			out.push(
				`partial: ${stats.failed} of ${stats.requests} judge requests failed; unjudged files may still match`,
			);
		}
		if (hits.length > 0) out.push("");
		for (const hit of hits) {
			const seen = hit.truncated ? `${hit.linesSeen} lines judged, partial` : `${hit.linesSeen} lines judged`;
			out.push(`${hit.rel}  ${hit.contentScore.toFixed(2)}  ${seen}`);
			for (const range of rankedHeat(hit.ranges, RANGES_SHOWN)) {
				const span = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
				out.push(`  ${hit.rel}:${span}  ${range.p.toFixed(2)}  ${range.snippet}`);
			}
		}
		if (lexicalFallback.length > 0) {
			out.push("", "unranked literal keyword matches (not semantically judged):");
			for (const match of lexicalFallback) out.push(`  ${match.rel}:${match.line}  ${match.snippet}`);
		}
		const unanswered = stats.unanswered > 0 ? ` · ${stats.unanswered} unanswered` : "";
		out.push(
			"",
			`listed ${stats.listed} · judged ${stats.judged} · read ${stats.filesRead} files (${formatBytes(stats.fileBytes)}) · ${stats.requests} requests${unanswered} · ${formatNumber(stats.inputTokens)} tokens · $${stats.cost.toFixed(4)} · ${formatDuration(elapsedMs)} wall / ${formatDuration(stats.apiMs)} api`,
		);
		if (stats.failures.length > 0) out.push("failures:", ...stats.failures.map(failure => `  ${failure}`));
		const builder = toolResult(details).text(out.join("\n"));
		if (coverage === "unavailable") builder.error();
		else if (hits.length === 0) builder.useless();
		return builder.done();
	}
}
