import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { previewLine, replaceTabs, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	JUDGE_DESCRIPTION_CHARS,
	NO_MATCH_CAVEAT,
	readSkillRecommendConfig,
	type SkillRecommendResult,
	SkillRecommender,
} from "../extensibility/skill-recommend";
import { getActiveSkills, type Skill } from "../extensibility/skills";
import { type JudgmentUsage, resolveJudge } from "../judgment/index";
import recommendSkillsDescription from "../prompts/tools/recommend-skills.md" with { type: "text" };
import { ONLINE_MEMORY_MODEL_KEY } from "../tiny/models";
import type { ToolSession } from ".";

const MAX_LIMIT = 10;

/** Skill text echoed into the tool output is untrusted; one row per skill, no control characters. */
function outputText(text: string, width: number): string {
	return previewLine(replaceTabs(sanitizeText(text)), width);
}

const recommendSkillsSchema = type({
	task: type("string").describe("what you are about to do, in one or two concrete sentences"),
	"limit?": type("number.integer >= 1").describe(`how many ranked skills to return (default 5, max ${MAX_LIMIT})`),
	"explicit?": type("string[]").describe("skill names that must be included regardless of ranking"),
	"+": "reject",
});

export type RecommendSkillsParams = typeof recommendSkillsSchema.infer;

export interface RecommendSkillsDetails {
	result: SkillRecommendResult;
	/** Set when judgment usage could not be recorded on the session ledger. */
	usageLedger?: string;
}

/**
 * Ranks the session's skill catalog against a task through the shared judgment
 * backend, degrading to deterministic lexical overlap when no judge is
 * reachable. Candidate ids are derived locally, so the judge can only pick a
 * skill that exists in the observed catalog revision.
 */
export class RecommendSkillsTool implements AgentTool<typeof recommendSkillsSchema, RecommendSkillsDetails> {
	readonly name = "recommend_skills";
	readonly approval = "read" as const;
	readonly label = "Recommend Skills";
	readonly description = recommendSkillsDescription;
	readonly parameters = recommendSkillsSchema;
	readonly strict = true;
	readonly summary = "Rank installed skills by relevance to a task";
	/** Keeps the system prompt's `<skills>` listing enabled: this tool reads skill metadata. */
	readonly readsSkillUris = true;

	readonly #session: ToolSession;
	readonly #recommender: SkillRecommender;
	/** Reason the session ledger cannot take this tool's usage, surfaced in details. */
	readonly #ledgerNote: string | undefined;

	constructor(session: ToolSession, recommender?: SkillRecommender) {
		this.#session = session;
		const manager = session.sessionManager;
		const ledgerReachable =
			manager?.appendModelUsage !== undefined &&
			manager.getLeafId !== undefined &&
			manager.getSessionId?.() !== undefined;
		this.#ledgerNote = ledgerReachable
			? undefined
			: "session ledger unreachable from this ToolSession; judgment provenance is kept in these details only";
		const settings = session.settings;
		this.#recommender =
			recommender ??
			new SkillRecommender({
				config: readSkillRecommendConfig(settings),
				judgmentDigest: `${settings.get("providers.judgmentProvider")}/${settings.get("providers.typesafeModel") ?? ""}`,
				judge: hooks => {
					const registry = session.modelRegistry;
					if (!registry) throw new Error("no model registry in this session");
					return resolveJudge({
						settings,
						registry,
						backend: ONLINE_MEMORY_MODEL_KEY,
						sessionModel: session.getActiveModel?.(),
						sessionId: session.getSessionId?.() ?? undefined,
						onUsage: hooks.onUsage,
					});
				},
			});
	}

	static createIf(session: ToolSession): RecommendSkillsTool | null {
		if (!session.settings.get("skills.enabled")) return null;
		if (!session.settings.get("skills.recommend.enabled")) return null;
		return new RecommendSkillsTool(session);
	}

	/**
	 * Judgment usage lands on the session ledger under `skill-recommend`, chained
	 * from the branch leaf at the time the tool call starts so a multi-window
	 * ranking shows as consecutive entries rather than siblings of the same
	 * parent. The chain is created per tool call, so overlapping calls each
	 * hang off that leaf and never off each other's entries.
	 */
	#usageRecorder(): ((usage: JudgmentUsage) => void) | undefined {
		const manager = this.#session.sessionManager;
		const append = manager?.appendModelUsage;
		const sessionId = manager?.getSessionId?.();
		const leafId = manager?.getLeafId?.();
		if (!manager || !append || sessionId === undefined || leafId === undefined) return undefined;
		const owner = { sessionId, parentId: leafId };
		return usage => {
			const entryId = append.call(manager, { purpose: "skill-recommend", ...usage }, owner);
			if (entryId) owner.parentId = entryId;
		};
	}

	async execute(
		_toolCallId: string,
		params: RecommendSkillsParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RecommendSkillsDetails>> {
		const task = params.task.trim();
		if (task.length === 0) throw new ToolError("task must not be empty.");
		if (params.limit !== undefined && params.limit > MAX_LIMIT) {
			throw new ToolError(`limit must be ${MAX_LIMIT} or less.`);
		}
		const catalog: readonly Skill[] = this.#session.skills ?? getActiveSkills();
		const request = { task, limit: params.limit, catalog, explicit: params.explicit };
		const options = { signal, onUsage: this.#usageRecorder() };
		let result = await this.#recommender.recommend(request, options);
		// The catalog was refreshed under the request: re-observe and re-rank once,
		// never deliver or retry a selection made against a dead revision.
		if (result.stale) result = await this.#recommender.recommend(request, options);

		return {
			content: [{ type: "text", text: renderRecommendations(result) }],
			details: { result, usageLedger: this.#ledgerNote },
		};
	}
}

/** Ranked list plus the mode and provenance lines the decision contract requires. */
export function renderRecommendations(result: SkillRecommendResult): string {
	const lines: string[] = [];
	if (result.stale) {
		lines.push("The skill catalog changed twice while ranking; no stable recommendation was produced.");
	}
	const windows = result.windows > 1 ? `, ${result.windows} windows` : "";
	const cached = result.cacheHit ? ", cached" : "";
	lines.push(
		`Ranked ${result.catalogSize} installed skill(s) for the task (mode: ${result.mode}${windows}${cached}).`,
	);
	if (result.recommendations.length === 0) {
		if (!result.noMatch) lines.push("No skill cleared the relevance floor.");
	} else {
		for (const entry of result.recommendations) {
			const name = outputText(entry.name, TRUNCATE_LENGTHS.LINE);
			const description = outputText(entry.description, JUDGE_DESCRIPTION_CHARS);
			lines.push(`- ${name} — relevance ${entry.relevance.toFixed(2)} (${entry.reason}) — ${description}`);
		}
	}
	if (result.noMatch) {
		const applicable =
			result.anyApplicable === undefined ? "" : ` (any_applicable ${result.anyApplicable.toFixed(2)})`;
		lines.push(`No listed skill materially applies to this task${applicable}. ${NO_MATCH_CAVEAT}`);
	}
	if (result.unmatchedExplicit.length > 0) {
		const names = result.unmatchedExplicit.map(name => outputText(name, TRUNCATE_LENGTHS.LINE));
		lines.push(`Not installed, ignored: ${names.join(", ")}.`);
	}
	if (result.mode === "search") {
		const reason = outputText(result.fallbackReason ?? "no judgment backend", TRUNCATE_LENGTHS.RECAP);
		lines.push(`judge: none · lexical name/description overlap · ${reason}`);
		return lines.join("\n");
	}
	const last = result.attempts.at(-1);
	if (!last) {
		lines.push("judge: cached · no new judgment call");
		return lines.join("\n");
	}
	const distribution = last.distribution === "native" ? "native" : "synthetic one-hot";
	const cost = typeof result.usage.costUsd === "number" ? `$${result.usage.costUsd.toFixed(4)}` : "unknown";
	const fallback = last.fallback ? ` · fell back from ${last.fallback.from}` : "";
	lines.push(
		`judge: ${last.backend} ${last.label} · model ${last.provider}/${last.model} · ${distribution}${fallback} · ${result.usage.calls} call(s) · cost ${cost}`,
	);
	return lines.join("\n");
}
