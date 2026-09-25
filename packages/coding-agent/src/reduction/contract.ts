/**
 * Shared contract for recoverable context reduction.
 *
 * Two features reduce what the model sees while keeping the original bytes
 * recoverable: `bash` output pruning (a completed command's model-visible
 * output, before the tool result is assembled) and fast semantic shake (tool
 * results outside the live tail, before a summary compaction). Both produce a
 * {@link ReductionReceipt}: what the reduction saw, what it kept verbatim,
 * what it omitted and why, the single native recovery locator, judgment
 * provenance, and measured cost. The receipt is the only cross-feature
 * abstraction; everything else reuses the session's artifact manager,
 * tokenizer, judge role chain, and {@link LoopMeter}.
 *
 * Invariants every producer must hold:
 *  - The lossless original is persisted (content-addressed by
 *    {@link contentHash}) BEFORE the visible form is replaced; a failed archive
 *    write keeps the baseline untouched (`skipped.reason = "archive-failed"`).
 *    An archive is recovery, not permission: content is removed from the
 *    model's view only when a rule or an answered judgment says it may be.
 *  - Retained spans are verbatim: Unicode and line identity preserved.
 *  - Deterministic protection is decided in code, never by the judge:
 *    errors/stderr, diagnostics, result counts, exit status, final outcomes,
 *    artifact paths, and structured/code/diff/binary content are kept (span
 *    level) or the whole result is kept (region level) — see `protection.ts`.
 *  - Reduction is judged against the task, not the command alone: the
 *    bounded `TaskContext` (original request, latest request, latest
 *    reply, standing requirements) is read locally through session APIs. A
 *    stated retention or counting requirement stops rule-based removal of
 *    routine lines (`standing-requirement`); no user turn at all means no
 *    judgment and only content-free collapses (`context-unavailable`).
 *  - Whatever a judge could not answer — egress off, no judge, budget spent,
 *    abort, oversized input, missing answer, uncertain answer — is KEPT. Never
 *    an assertion of irrelevance, and never removed on the strength of a
 *    recovery link alone.
 *  - A judge only ever sees the complete candidate text it is asked about plus
 *    the bounded task context, after {@link prepareEgressText}; and only when
 *    the profile opted in (`reduction.egress = "selected"`). Nothing is sent
 *    when egress is off (`egress-disabled`).
 *  - Recovery reads (`artifact://…`) are never reduced again.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { type DecisionJudge, type DecisionProvenance, type LoopBudget, LoopMeter } from "../judgment/decision";
import { type JudgeDeps, resolveJudge } from "../judgment/index";
import { redactMemorySecrets } from "../memory-backend/redact";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { cfgReduction } from "../session/context-settings";

/** Ordered stages a reduction may run; each stage records its own row. */
export type ReductionStageKind = "native-minimizer" | "deterministic" | "semantic";

export interface ReductionStage {
	kind: ReductionStageKind;
	/** Stage-specific label: the native filter name, the deterministic rule set, or the judge label. */
	label: string;
	/** Tokens visible before and after this stage (session tokenizer). */
	tokensBefore: number;
	tokensAfter: number;
	durationMs: number;
	/** Set when the stage ran but changed nothing, or did not run. */
	skipped?: ReductionSkip;
}

export type ReductionSkipReason =
	| "below-threshold"
	| "no-useful-reduction"
	| "protected-format"
	| "standing-requirement"
	| "context-unavailable"
	| "facts-exceed-capacity"
	| "egress-disabled"
	| "judge-unavailable"
	| "judge-preserved"
	| "budget-exhausted"
	| "archive-failed"
	| "aborted"
	| "already-reduced";
export interface ReductionSkip {
	reason: ReductionSkipReason;
	detail?: string;
}

/** Where the reduced text came from and how the lossless original is addressed. */
export interface ReductionSource {
	kind: "bash-output" | "tool-result" | "block";
	/** Stable identity of the source: tool call id, or session entry id (+ block index). */
	identity: string;
	/** Observation revision when the source has one (e.g. a re-observed surface). */
	revision?: string;
	/** SHA-256 of the BASELINE model-visible text, before any reduction stage. */
	contentHash: string;
	/** Artifact already holding the lossless original when one existed (sink spill, native minimizer). */
	originalArtifactId?: string;
}

/** Character offsets into the baseline text; `end` exclusive. */
export interface ReductionSpan {
	start: number;
	end: number;
}

export interface OmittedSpan extends ReductionSpan {
	/** Why the span was omitted: a deterministic rule name or the judge's question id. */
	reason: string;
	/** Probability the judge assigned when the omission was semantic. */
	probability?: number;
}

export interface ReductionCost {
	calls: number;
	attempts: number;
	input: number;
	output: number;
	costUsd: number | "unknown";
	durationMs: number;
}

/** Complete record of one reduction, stored beside the reduced content. */
export interface ReductionReceipt {
	/** Contract version for persisted receipts. */
	version: 1;
	source: ReductionSource;
	stages: ReductionStage[];
	/** Tokens of the baseline model-visible text (everything the model would have seen, markers and footers included). */
	baselineTokens: number;
	/** Tokens of the visible text after every stage, recovery locator included. */
	visibleTokens: number;
	/** Spans kept verbatim because code protected them (never offered to a judge). */
	protectedSpans: ReductionSpan[];
	/** Spans kept verbatim after selection. */
	keptSpans: ReductionSpan[];
	omittedSpans: OmittedSpan[];
	/** Single native recovery locator for the lossless original, e.g. `artifact://12`. */
	recovery: { locator: string };
	/** Set when no stage changed the visible text; `stages` still record what ran. */
	skipped?: ReductionSkip;
	/** Every judgment attempt, failed and nested included. */
	decisions: DecisionProvenance[];
	cost: ReductionCost;
}

/** Content-address baseline text; hex SHA-256 over UTF-8. */
export function contentHash(text: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(text);
	return hasher.digest("hex");
}

/** What the profile allows to leave the machine for semantic reduction. */
export type ReductionEgress = "off" | "selected";

export interface ReductionPolicy {
	egress: ReductionEgress;
	/** Judgment calls admitted per reduction pass. */
	maxCallsPerPass: number;
	/** Wall clock admitted per reduction pass, in milliseconds. */
	maxLatencyMs: number;
	/** Bound of each `TaskContext` field a reduction may read and send. */
	taskContextChars: number;
}

/** Read the shared reduction policy (`reduction.*`) from settings; bounds never go negative. */
export function resolveReductionPolicy(settings: Settings): ReductionPolicy {
	const configured = cfgReduction.get(settings);
	return {
		egress: configured.egress,
		maxCallsPerPass: Math.max(0, configured.maxCallsPerPass),
		maxLatencyMs: Math.max(0, configured.maxLatencyMs),
		taskContextChars: Math.max(0, configured.taskContextChars),
	};
}

/**
 * Text as it may be sent to a judgment backend: the session's secret
 * placeholders first (when secrets are configured), then the heuristic
 * credential/JWT redaction used for memory backends. Heuristic recognition is
 * not a privacy guarantee; the egress switch is.
 */
export function prepareEgressText(text: string, obfuscator?: SecretObfuscator): string {
	const obfuscated = obfuscator?.hasSecrets() ? obfuscator.obfuscate(text) : text;
	return redactMemorySecrets(obfuscated);
}

export interface ReductionJudgeDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId?: string;
	sessionModel?: Model;
	signal?: AbortSignal;
	/** Records every judgment attempt on the session cost ledger (see `journalJudgmentUsage`). */
	onUsage?: JudgeDeps["onUsage"];
}

/** A judge admitted for one reduction pass, with the meter that bounds it. */
export interface ReductionJudge {
	judge: DecisionJudge;
	meter: LoopMeter;
	policy: ReductionPolicy;
}

/**
 * Admit a judge for one semantic reduction pass, or explain why none is
 * admitted. The judge is the session's `judge` role chain — it honours
 * `modelRoles.judge` and `retry.fallbackChains.judge` (an exact pin admits no
 * substitute) exactly as the task loops do; the meter bounds calls and wall
 * clock by the shared policy.
 */
export function admitReductionJudge(deps: ReductionJudgeDeps): ReductionJudge | ReductionSkip {
	const policy = resolveReductionPolicy(deps.settings);
	if (policy.egress === "off") {
		return { reason: "egress-disabled", detail: "reduction.egress is off; deterministic stages only" };
	}
	if (policy.maxCallsPerPass === 0 || policy.maxLatencyMs === 0) {
		return { reason: "budget-exhausted", detail: "reduction.maxCallsPerPass or reduction.maxLatencyMs is 0" };
	}
	let judge: DecisionJudge;
	try {
		judge = resolveJudge({
			settings: deps.settings,
			registry: deps.registry,
			...(deps.sessionId === undefined ? {} : { sessionId: deps.sessionId }),
			...(deps.sessionModel === undefined ? {} : { sessionModel: deps.sessionModel }),
			...(deps.onUsage === undefined ? {} : { onUsage: deps.onUsage }),
		});
	} catch (error) {
		return { reason: "judge-unavailable", detail: error instanceof Error ? error.message : String(error) };
	}
	const budget: LoopBudget = {
		maxCalls: policy.maxCallsPerPass,
		maxActions: 0,
		deadlineAt: Date.now() + policy.maxLatencyMs,
		...(deps.signal ? { signal: deps.signal } : {}),
	};
	return { judge, meter: new LoopMeter(budget), policy };
}

export function isReductionSkip(value: ReductionJudge | ReductionSkip): value is ReductionSkip {
	return "reason" in value;
}

/** Cost row from a meter plus the pass's wall clock. */
export function reductionCost(meter: LoopMeter | undefined, durationMs: number): ReductionCost {
	if (!meter) return { calls: 0, attempts: 0, input: 0, output: 0, costUsd: 0, durationMs };
	const usage = meter.totalUsage();
	return { ...usage, durationMs };
}

/** A receipt for a source that was inspected and left untouched. */
export function untouchedReceipt(
	source: ReductionSource,
	baselineTokens: number,
	recoveryLocator: string,
	skip: ReductionSkip,
	stages: ReductionStage[] = [],
	decisions: DecisionProvenance[] = [],
	cost: ReductionCost = { calls: 0, attempts: 0, input: 0, output: 0, costUsd: 0, durationMs: 0 },
): ReductionReceipt {
	return {
		version: 1,
		source,
		stages,
		baselineTokens,
		visibleTokens: baselineTokens,
		protectedSpans: [],
		keptSpans: [{ start: 0, end: Number.MAX_SAFE_INTEGER }],
		omittedSpans: [],
		recovery: { locator: recoveryLocator },
		skipped: skip,
		decisions,
		cost,
	};
}
