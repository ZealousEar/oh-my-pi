/**
 * Selection step of the semantic shake: which eligible tool results may be
 * elided to a recoverable placeholder because an answered judgment, given the
 * person's task, said they are no longer needed?
 *
 * Everything a judgment did not clear stays exactly as it is. Protection is
 * decided in code first (error results, diagnostics, verification receipts
 * are never sent); identical contents share one decision; a decision cached
 * from an earlier pass for the same task context and judge is reused; the
 * remaining regions go through metered judgment requests in batches. A region
 * the judge could not be asked about — no task context, egress off, no judge,
 * budget spent, abort, oversized text, missing answer — is kept `unjudged`,
 * and an uncertain answer keeps the region too. An archive is recovery, not
 * permission.
 */
import type { AgentToolCall } from "@oh-my-pi/pi-agent-core";
import type { ToolResultShakeRegion } from "@oh-my-pi/pi-agent-core/compaction";
import type { JudgmentState, Model, NoulQuestion, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { type DecisionProvenance, judgeWithMeter, LoopBudgetExceeded } from "../judgment/decision";
import keepCriteriaTemplate from "../prompts/system/semantic-shake-keep-criteria.md" with { type: "text" };
import keepTemplate from "../prompts/system/semantic-shake-keep.md" with { type: "text" };
import type { ShakeSelectionSummary } from "../session/shake-types";
import {
	admitReductionJudge,
	contentHash,
	isReductionSkip,
	prepareEgressText,
	type ReductionJudge,
	type ReductionJudgeDeps,
	type ReductionReceipt,
	type ReductionSkip,
	type ReductionStage,
} from "./contract";
import { hasProtectedEvidence } from "./protection";
import type { TaskContext } from "./task-context";

/** Longest region text a judge is asked about; longer ones are kept unjudged rather than truncated. */
export const SEMANTIC_SHAKE_MAX_REGION_CHARS = 12_000;
/** Bound of the rendered tool call (`name(args)`) sent beside each region. */
const CALL_CHARS = 300;
/** A region is kept as needed when the judge's yes-probability reaches this. */
const KEEP_THRESHOLD = 0.5;
/** Below the keep threshold but at or above this, the answer is uncertain and the region is kept anyway. */
const UNCERTAIN_THRESHOLD = 0.35;
/** Decisions remembered per session; the oldest entry is dropped beyond this. */
export const SEMANTIC_SHAKE_CACHE_ENTRIES = 4_096;

/** Admits the judge for one pass; production callers use {@link admitReductionJudge}. */
export type ShakeJudgeAdmission = (deps: ReductionJudgeDeps) => ReductionJudge | ReductionSkip;

export interface ShakeSelectionInput {
	/** Eligible tool-result regions, in document order. */
	regions: readonly ToolResultShakeRegion[];
	/** Bounded task context read from the branch (`collectTaskContext`); the only transcript-derived text sent. */
	context: TaskContext;
	/** Paired tool calls (`collectToolCallsById` over the branch) so each region can name its call. */
	toolCalls: ReadonlyMap<string, AgentToolCall>;
	/** Protect window the regions were collected with; part of the cache key. */
	protectTokens: number;
	settings: Settings;
	registry: ModelRegistry;
	sessionId?: string;
	sessionModel?: Model;
	signal?: AbortSignal;
	/** The session's secret-placeholder step (`obfuscateTextForProvider`); runs before heuristic redaction. */
	obfuscateText?: (text: string) => string;
	/**
	 * Decisive judgments from earlier passes of the same session, keyed by
	 * region content, task context, judge, and protect window. Read and written
	 * here; a region judged "keep" is re-asked only when the task context changes.
	 */
	cache: Map<string, boolean>;
	admitJudge?: ShakeJudgeAdmission;
}

/** How one region's keep/elide decision was reached, for its {@link ReductionReceipt}. */
export interface ShakeRegionDecision {
	keep: boolean;
	/**
	 * `judge`: answered now; `uncertain`: answered now but near the threshold, kept;
	 * `cache`: answered in an earlier pass; `duplicate`: shares a judged twin's
	 * answer; `protected`: error, diagnostic, or verification receipt, never sent;
	 * `unjudged`: could not be asked about, kept.
	 */
	basis: "judge" | "uncertain" | "cache" | "duplicate" | "protected" | "unjudged";
	/** Yes-probability the judge assigned to the deciding question (judge/uncertain/duplicate basis). */
	probability?: number;
	/** Why the region could not be asked about (unjudged basis). */
	skipped?: ReductionSkip;
	/** The judgment attempts behind the deciding call, failed and nested included (judge/uncertain/duplicate basis). */
	attempts: DecisionProvenance[];
}

export interface ShakeSelection {
	/** Regions to elide; every other input region stays untouched. */
	elide: Set<ToolResultShakeRegion>;
	summary: ShakeSelectionSummary;
	/** Every judgment attempt of this pass, failed and nested included. */
	decisions: DecisionProvenance[];
	/** Per-region decision, for every input region. */
	regions: Map<ToolResultShakeRegion, ShakeRegionDecision>;
	/** Label and pinned model of the admitted judge, when one was admitted. */
	judge?: { label: string; pinnedModel?: string };
}

/** One distinct askable region content: the members share a single decision. */
interface RegionGroup {
	hash: string;
	members: ToolResultShakeRegion[];
	/** `judge`/`uncertain`/`cache` once answered; `unjudged` until then. */
	basis: "judge" | "uncertain" | "cache" | "unjudged";
	/** `false` only when an answered judgment cleared the group. */
	keep: boolean;
	probability?: number;
	skipped?: ReductionSkip;
	/** Attempts of the call that answered this group (only when answered now). */
	attempts: DecisionProvenance[];
}

/** One region as the judge sees it (a JSON object, so it is valid judgment state). */
type RegionState = {
	index: number;
	tool: string;
	call: string;
	tokens: number;
	text: string;
};

/** The task context as the judge sees it. */
type GoalState = {
	original_request: string;
	latest_request: string;
	latest_reply: string;
	standing_requirements: string[];
};

function renderCall(region: ToolResultShakeRegion, toolCalls: ReadonlyMap<string, AgentToolCall>): string {
	const message = region.entry.message as ToolResultMessage;
	const call = toolCalls.get(message.toolCallId);
	if (!call) return `${message.toolName}(…)`;
	let args: string;
	try {
		args = JSON.stringify(call.arguments);
	} catch {
		args = "…";
	}
	const rendered = `${call.name}(${args})`;
	return rendered.length <= CALL_CHARS ? rendered : rendered.slice(0, CALL_CHARS);
}

/** Error results and results carrying diagnostics or verification receipts are kept in code, never sent. */
function isProtectedRegion(region: ToolResultShakeRegion): boolean {
	const message = region.entry.message as ToolResultMessage;
	return message.isError === true || hasProtectedEvidence(region.originalText);
}

function groupByContent(regions: readonly ToolResultShakeRegion[]): RegionGroup[] {
	const groups = new Map<string, RegionGroup>();
	for (const region of regions) {
		const hash = contentHash(region.originalText);
		const group = groups.get(hash);
		if (group) group.members.push(region);
		else groups.set(hash, { hash, members: [region], basis: "unjudged", keep: true, attempts: [] });
	}
	return [...groups.values()];
}

function tally(
	groups: readonly RegionGroup[],
	summary: ShakeSelectionSummary,
	elide: Set<ToolResultShakeRegion>,
	regions: Map<ToolResultShakeRegion, ShakeRegionDecision>,
	fallback: ReductionSkip,
): void {
	for (const group of groups) {
		const skipped = group.skipped ?? fallback;
		group.members.forEach((member, index) => {
			// A judged group's first member carries the answer; its twins share it.
			const basis: ShakeRegionDecision["basis"] =
				(group.basis === "judge" || group.basis === "uncertain") && index > 0 ? "duplicate" : group.basis;
			regions.set(member, {
				keep: group.keep,
				basis,
				...(group.probability === undefined ? {} : { probability: group.probability }),
				...(group.basis === "unjudged" ? { skipped } : {}),
				attempts: group.attempts,
			});
			if (!group.keep) elide.add(member);
		});
		const twins = group.members.length - 1;
		switch (group.basis) {
			case "unjudged":
				summary.keptUnjudged += group.members.length;
				break;
			case "uncertain":
				summary.keptUncertain += 1;
				summary.keptDuplicate += twins;
				break;
			default:
				if (group.keep) {
					summary.keptByJudge += 1;
					summary.keptDuplicate += twins;
				} else {
					summary.elided += group.members.length;
				}
		}
	}
}

/**
 * Decide which regions an answered judgment clears for elision. Never throws
 * for judge failures: whatever could not be judged is kept and the summary
 * says why.
 */
export async function selectShakeRegions(input: ShakeSelectionInput): Promise<ShakeSelection> {
	const startedAt = Date.now();
	const summary: ShakeSelectionSummary = {
		candidates: input.regions.length,
		keptByJudge: 0,
		keptUncertain: 0,
		keptDuplicate: 0,
		keptProtected: 0,
		keptUnjudged: 0,
		elided: 0,
		calls: 0,
		durationMs: 0,
	};
	const elide = new Set<ToolResultShakeRegion>();
	const regionDecisions = new Map<ToolResultShakeRegion, ShakeRegionDecision>();
	// Deterministic protection first: these regions never reach a judge.
	const askable: ToolResultShakeRegion[] = [];
	for (const region of input.regions) {
		if (isProtectedRegion(region)) {
			summary.keptProtected += 1;
			regionDecisions.set(region, { keep: true, basis: "protected", attempts: [] });
		} else {
			askable.push(region);
		}
	}
	const groups = groupByContent(askable);
	const finish = (
		decisions: DecisionProvenance[],
		fallback: ReductionSkip,
		judge?: ShakeSelection["judge"],
	): ShakeSelection => {
		tally(groups, summary, elide, regionDecisions, fallback);
		summary.durationMs = Date.now() - startedAt;
		return { elide, summary, decisions, regions: regionDecisions, ...(judge ? { judge } : {}) };
	};
	if (groups.length === 0) return finish([], { reason: "no-useful-reduction", detail: "no askable regions" });
	if (input.context.coverage === "none") {
		summary.skipped = "context-unavailable";
		return finish([], {
			reason: "context-unavailable",
			detail: "no user request on the branch to judge against; every candidate kept",
		});
	}

	const admitted = (input.admitJudge ?? admitReductionJudge)({
		settings: input.settings,
		registry: input.registry,
		...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
		...(input.sessionModel === undefined ? {} : { sessionModel: input.sessionModel }),
		...(input.signal ? { signal: input.signal } : {}),
	});
	if (isReductionSkip(admitted)) {
		summary.skipped = admitted.reason;
		return finish([], admitted);
	}
	const { judge, meter } = admitted;
	const judgeIdentity: ShakeSelection["judge"] = {
		label: judge.label,
		...(judge.pinnedModel === undefined ? {} : { pinnedModel: judge.pinnedModel }),
	};

	const maxRegionsPerCall = Math.max(1, input.settings.get("compaction.semanticShake.maxRegionsPerCall"));
	const egress = (text: string): string => prepareEgressText(input.obfuscateText ? input.obfuscateText(text) : text);
	const goal: GoalState = {
		original_request: egress(input.context.originalRequest),
		latest_request: egress(input.context.latestRequest),
		latest_reply: egress(input.context.latestReply),
		standing_requirements: input.context.requirements.map(egress),
	};
	// Task identity for the cache: the requests and standing requirements. The latest reply is
	// context for the judge, not identity of the task; keying on it would re-ask every turn.
	const goalHash = contentHash(
		JSON.stringify([goal.original_request, goal.latest_request, goal.standing_requirements]),
	);
	const cacheKey = (hash: string): string =>
		`${hash}|${goalHash}|${judge.label}|${judge.pinnedModel ?? ""}|${input.protectTokens}`;
	const remember = (key: string, keep: boolean): void => {
		if (input.cache.size >= SEMANTIC_SHAKE_CACHE_ENTRIES) {
			const oldest = input.cache.keys().next().value;
			if (oldest !== undefined) input.cache.delete(oldest);
		}
		input.cache.set(key, keep);
	};

	// Deterministic next: cached decisions and oversized text need no call.
	const pending: RegionGroup[] = [];
	for (const group of groups) {
		const cached = input.cache.get(cacheKey(group.hash));
		if (cached !== undefined) {
			group.keep = cached;
			group.basis = "cache";
			continue;
		}
		if (group.members[0].originalText.length > SEMANTIC_SHAKE_MAX_REGION_CHARS) {
			group.skipped = {
				reason: "facts-exceed-capacity",
				detail: `region text exceeds ${SEMANTIC_SHAKE_MAX_REGION_CHARS} characters; kept without judgment`,
			};
			continue;
		}
		pending.push(group);
	}
	// Largest first: the budget is spent on the regions worth the most.
	pending.sort((a, b) => b.members[0].tokens - a.members[0].tokens);

	let stopped: ReductionSkip | undefined;
	for (let offset = 0; offset < pending.length; offset += maxRegionsPerCall) {
		const batch = pending.slice(offset, offset + maxRegionsPerCall);
		const regions: RegionState[] = batch.map((group, index) => {
			const region = group.members[0];
			return {
				index,
				tool: egress(region.label),
				call: egress(renderCall(region, input.toolCalls)),
				tokens: region.tokens,
				text: egress(region.originalText),
			};
		});
		const questions: Record<string, NoulQuestion> = {};
		for (const region of regions) {
			questions[`keep_${region.index}`] = {
				type: "noul",
				instructions: prompt.render(keepTemplate, { i: region.index }),
				criteria: {
					true: prompt.render(keepCriteriaTemplate, { i: region.index, yes: true }).trim(),
					false: prompt.render(keepCriteriaTemplate, { i: region.index, yes: false }).trim(),
				},
			};
		}
		const state: JudgmentState = { goal, regions };
		const attemptsBefore = meter.attempts.length;
		try {
			const { result, provenance } = await judgeWithMeter(
				judge,
				meter,
				{ state, questions },
				input.signal ? { signal: input.signal } : {},
			);
			summary.distribution = provenance.distribution;
			const attempts = meter.attempts.slice(attemptsBefore);
			for (const [index, group] of batch.entries()) {
				const answer = result.answers[`keep_${index}`];
				if (answer?.type !== "noul") {
					group.skipped = { reason: "judge-unavailable", detail: `no answer for keep_${index}; kept` };
					continue;
				}
				group.probability = answer.noul;
				group.attempts = attempts;
				if (answer.noul >= KEEP_THRESHOLD) {
					group.basis = "judge";
					group.keep = true;
				} else if (answer.noul >= UNCERTAIN_THRESHOLD) {
					// Not decisive: kept now and asked again next pass.
					group.basis = "uncertain";
					group.keep = true;
					continue;
				} else {
					group.basis = "judge";
					group.keep = false;
				}
				remember(cacheKey(group.hash), group.keep);
			}
		} catch (error) {
			const reason =
				error instanceof LoopBudgetExceeded
					? error.limit === "aborted"
						? "aborted"
						: "budget-exhausted"
					: "judge-unavailable";
			const detail = error instanceof Error ? error.message : String(error);
			logger.warn("semantic shake: judgment stopped; remaining regions kept unjudged", {
				reason,
				error: detail,
				judged: offset,
				pending: pending.length,
			});
			stopped = { reason, detail };
			if (offset === 0) summary.skipped = reason;
			break;
		}
	}

	summary.calls = meter.calls;
	return finish(
		[...meter.attempts],
		stopped ?? { reason: "no-useful-reduction", detail: "every askable region was judged" },
		judgeIdentity,
	);
}

/**
 * The {@link ReductionReceipt} of one candidate region after a semantic shake
 * pass: a kept region records why it stayed verbatim; an elided region records
 * the archive holding its bytes and the judgment that cleared it. Stored on
 * elided tool results as `details.shake` and returned for every candidate.
 */
export function shakeRegionReceipt(input: {
	region: ToolResultShakeRegion;
	decision: ShakeRegionDecision;
	/** Shake artifact holding the elided originals (required when the region was elided). */
	artifactId: string | undefined;
	/** Tokens of the placeholder that replaced the region, when elided. */
	replacementTokens: number;
	judge?: ShakeSelection["judge"];
	durationMs: number;
}): ReductionReceipt {
	const { region, decision } = input;
	const message = region.entry.message as ToolResultMessage;
	const length = region.originalText.length;
	const usage = decision.attempts.reduce(
		(total, attempt) => ({ input: total.input + attempt.usage.input, output: total.output + attempt.usage.output }),
		{ input: 0, output: 0 },
	);
	const unknownCost = decision.attempts.some(attempt => attempt.costUsd === "unknown");
	const costUsd = unknownCost
		? "unknown"
		: decision.attempts.reduce((total, attempt) => total + (attempt.costUsd === "unknown" ? 0 : attempt.costUsd), 0);
	// A kept region's skip names the basis; an unjudged one names why it could not be asked about.
	const kept: ReductionSkip = decision.skipped ?? {
		reason: "no-useful-reduction",
		detail: `kept by ${decision.basis}`,
	};
	const stage: ReductionStage = {
		kind: "semantic",
		label: input.judge?.label ?? "semantic-shake",
		tokensBefore: region.tokens,
		tokensAfter: decision.keep ? region.tokens : input.replacementTokens,
		durationMs: input.durationMs,
		...(decision.keep ? { skipped: kept } : {}),
	};
	return {
		version: 1,
		source: {
			kind: "tool-result",
			identity: message.toolCallId,
			contentHash: contentHash(region.originalText),
			...(input.artifactId === undefined ? {} : { originalArtifactId: input.artifactId }),
		},
		stages: [stage],
		baselineTokens: region.tokens,
		visibleTokens: stage.tokensAfter,
		protectedSpans: decision.basis === "protected" ? [{ start: 0, end: length }] : [],
		keptSpans: decision.keep ? [{ start: 0, end: length }] : [],
		omittedSpans: decision.keep
			? []
			: [
					{
						start: 0,
						end: length,
						reason: "judge",
						...(decision.probability === undefined ? {} : { probability: decision.probability }),
					},
				],
		recovery: { locator: input.artifactId === undefined ? "" : `artifact://${input.artifactId}` },
		...(decision.keep ? { skipped: kept } : {}),
		decisions: decision.attempts,
		cost: {
			calls: decision.attempts.filter(attempt => !attempt.nested).length,
			attempts: decision.attempts.length,
			input: usage.input,
			output: usage.output,
			costUsd,
			durationMs: input.durationMs,
		},
	};
}
