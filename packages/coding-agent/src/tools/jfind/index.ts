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
import { type ChainJudge, hasNativeJudge, journalJudgmentUsage, resolveJudge } from "../../judgment";
import findDescription from "../../prompts/tools/find.md" with { type: "text" };
import type { ToolSession } from "..";
import { formatPathRelativeToCwd, normalizePathLikeInput, resolveSearchResultPath } from "../path-utils";
import { toolResult } from "../tool-result";
import { runBounded } from "./bounded";
import { runCascade } from "./cascade";
import { rankedHeat } from "./passages";
import { resolveSearchRoot } from "./tree";

import {
	cfgFindEnabled,
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

/**
 * Resolve `find.enabled` for a session: `auto` enables `find` only when the
 * judge role is backed by a native System One model ({@link hasNativeJudge})
 * rather than a prompted small model. Gates tool creation and the `find` hints
 * in sibling tool prompts.
 */
export function isFindEnabled(session: ToolSession): boolean {
	const mode = cfgFindEnabled.get(session.settings);
	if (mode !== "auto") return mode === "on";
	return session.modelRegistry !== undefined && hasNativeJudge(session.settings, session.modelRegistry);
}

/** Semantic search tool: describe a behavior, get files and line ranges that implement it. */
export class FindTool implements AgentTool<typeof findSchema, FindToolDetails> {
	readonly name = "find";
	readonly approval = "read" as const;
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
	#judge(): { judge: ChainJudge; usageRecorded: boolean } {
		const registry = this.session.modelRegistry;
		if (!registry) throw new ToolError("find has no model registry to resolve a judge from");
		const onUsage = journalJudgmentUsage(this.session.sessionManager, "find");
		const judge = resolveJudge({
			settings: this.session.settings,
			registry,
			sessionId: this.session.getSessionId?.() ?? undefined,
			onUsage,
		});
		return { judge, usageRecorded: onUsage !== undefined };
	}

	async execute(
		_toolCallId: string,
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
			context: sessionResolveContext(this.session, { signal }),
			tier: this.approval,
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
		const { judge } = this.#judge();
		const started = performance.now();
		const result = await runCascade({
			root,
			filesystem,
			query,
			extraKeywords: params.grep_keywords,
			judge,
			includeHidden: false,
			signal,
			onProgress: message => onUpdate?.({ content: [{ type: "text", text: message }] }),
		});
		const elapsedMs = performance.now() - started;
		const { stats, threshold, keywords } = result;
		// Cascade paths are root-relative; the model and renderer want paths
		// `read` resolves (cwd-relative files, URLs under URL scopes, including
		// with `:start-end` selectors) without knowing the scope.
		const hits = result.hits.map(hit => ({
			...hit,
			rel: formatPathRelativeToCwd(resolveSearchResultPath(root.path, hit.rel), cwd),
		}));
		const details: FindCascadeDetails = {
			mode: "cascade",
			query,
			keywords,
			threshold,
			hits,
			stats,
			elapsedMs,
			cwd,
			scopePath,
		};
		const where = scopePath === undefined ? "" : ` in ${scopePath}`;
		const out: string[] = [];
		if (hits.length === 0) {
			out.push(`no hits for "${query}"${where} (τ ${threshold.toFixed(2)})`);
		} else {
			out.push(`${hits.length} hit(s) for "${query}"${where} (τ ${threshold.toFixed(2)}), strongest first`, "");
			for (const hit of hits) {
				const coverage = hit.truncated ? `${hit.linesSeen} lines judged, partial` : `${hit.linesSeen} lines judged`;
				out.push(`${hit.rel}  ${hit.contentScore.toFixed(2)}  ${coverage}`);
				for (const range of rankedHeat(hit.ranges, RANGES_SHOWN)) {
					const span = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
					out.push(`  ${hit.rel}:${span}  ${range.p.toFixed(2)}  ${range.snippet}`);
				}
			}
		}
		out.push(
			"",
			`listed ${stats.listed} · judged ${stats.judged} · read ${stats.filesRead} files (${formatBytes(stats.fileBytes)}) · ${stats.requests} requests · ${formatNumber(stats.inputTokens)} tokens · $${stats.cost.toFixed(4)} · ${formatDuration(elapsedMs)} wall / ${formatDuration(stats.apiMs)} api`,
		);
		if (stats.failures.length > 0) {
			out.push(
				`${stats.errors} of ${stats.requests} requests failed:`,
				...stats.failures.map(failure => `  ${failure}`),
			);
		}
		const builder = toolResult(details).text(out.join("\n"));
		if (stats.requests > 0 && stats.errors === stats.requests) builder.error();
		else if (hits.length === 0) builder.useless();
		return builder.done();
	}
}
