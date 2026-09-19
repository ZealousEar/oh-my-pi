/**
 * Shared contracts for judgment-driven execution loops (browser tasks, desktop
 * tasks, skill recommendation, semantic evidence retrieval).
 *
 * The invariant every loop shares: the model never authors executable
 * arguments. Local code observes a surface, derives a bounded list of
 * {@link ActionCandidate}s whose arguments stay local, and the judge selects a
 * candidate id (a {@link ChoiceQuestion} over ids). The selection is validated
 * against the exact observation it was derived from, executed, and then
 * independently verified — a model's `done` is a proposal, never proof.
 *
 * Provenance is first-class: every decision records which backend answered,
 * whether its probabilities are a native distribution (TypeSafe) or a
 * synthetic one-hot from a chat keyword (see `TextJudge`), whether a fallback
 * happened, and the monetary cost when known — `"unknown"` otherwise.
 */
import {
	type ChoiceAnswer,
	type ChoiceQuestion,
	type JudgeOptions,
	type JudgmentResult,
	type JudgmentState,
	type JsonValue,
	type NoulAnswer,
	type NoulQuestion,
	type Questions,
	TYPESAFE_PROVIDER,
	tokenUsage,
	type Usage,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { JudgmentAttempt, ResolvedJudge } from "./index";

/** Documented option cap of a TypeSafe `Choice` question. */
export const MAX_CHOICE_OPTIONS = 255;

/** Ids are model-facing labels; keep them short, unambiguous, and safe for keyword parsing. */
const CANDIDATE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** Identity of one observation of a surface; selections are only valid against the observation they came from. */
export interface ObservationIdentity {
	/** Which surface produced it: `browser-tab`, `desktop-window`, `skill-catalog`, `passages`. */
	surface: string;
	/** Opaque per-surface identity (tab name, window id, catalog key). */
	scope: string;
	/** Monotonic per-scope revision; a candidate from an older revision is stale. */
	revision: number;
	/** Wall-clock capture time (epoch ms). */
	capturedAt: number;
	/** Content digest when the surface can supply one; equal digests mean no meaningful change. */
	digest?: string;
}

/** A locally derived action the judge may select. `args` are never model-authored. */
export interface ActionCandidate<TArgs = unknown> {
	/** Short label the judge answers with; unique within one decision. */
	id: string;
	/** What the action does, rendered into the judgment state. */
	label: string;
	/** Executable arguments, kept local to the feature. */
	args: TArgs;
	/** Rubric for the choice option; `null` when the label suffices. */
	rubric?: string | null;
}

/** Outcome of executing a selected candidate. `unknown` demands reconciliation, not a blind retry. */
export type ExecutionOutcome =
	| { status: "applied"; detail?: string }
	| { status: "rejected"; reason: string }
	| { status: "stale"; reason: string; observed: ObservationIdentity }
	| { status: "unknown"; reason: string };

/** Evidence gathered independently of the model's own claim. */
export interface VerificationEvidence {
	/** `true`/`false` when a check ran; `unknown` when it could not run. */
	verified: boolean | "unknown";
	/** How the evidence was gathered (`dom-reobserve`, `ax-reobserve`, `text-match`, `judge`). */
	method: string;
	observation?: ObservationIdentity;
	detail?: string;
}

/** Which judge answered and how trustworthy its probabilities are. */
export interface DecisionProvenance {
	/** Judge routing (`typesafe`, `local`, `online`) and its label. */
	backend: ResolvedJudge["kind"];
	label: string;
	/** Transport/provider/model that actually answered. */
	api: string;
	provider: string;
	model: string;
	/** `native` probabilities from TypeSafe; `synthetic` one-hot from a chat keyword. */
	distribution: "native" | "synthetic";
	/** Set when the resolved backend was not the one that answered (TypeSafe → chat fallback). */
	fallback?: { from: string; reason?: string };
	/** Model the caller pinned for reproducibility, when one was configured. */
	pinnedModel?: string;
	usage: Usage;
	/** Monetary cost in USD when the transport prices tokens; `unknown` for TypeSafe. */
	costUsd: number | "unknown";
	durationMs: number;
	/** 1-based logical call number within the owning loop; nested transport attempts share it. */
	attempt: number;
	/**
	 * Set when the attempt produced no answer (transport error, timeout, abort).
	 * `api`/`provider`/`model` then describe the judge that was asked, not a
	 * response, and `usage` is zero because none was reported.
	 */
	error?: string;
	/**
	 * Set on rows that describe one underlying transport attempt behind a
	 * logical call (a failed TypeSafe request before a chat fallback, a chat
	 * candidate that errored). The answering attempt is the row without it.
	 */
	nested?: true;
	/** Set on helper-model completions (text values) metered beside judgments; no distribution applies. */
	helper?: string;
}

/** A judge's selection among candidates plus the confidence it carried. */
export interface CandidateDecision<TArgs = unknown> {
	candidate: ActionCandidate<TArgs>;
	answer: ChoiceAnswer;
	/** Ranked `{id, probability}` for every candidate, highest first. */
	ranking: Array<{ id: string; probability: number }>;
	provenance: DecisionProvenance;
}

/** Bounds a loop must respect; `checkpoint` throws {@link LoopBudgetExceeded} when any is spent. */
export interface LoopBudget {
	maxCalls: number;
	maxActions: number;
	/** Absolute deadline (epoch ms). */
	deadlineAt: number;
	signal?: AbortSignal;
}

export class LoopBudgetExceeded extends Error {
	override readonly name = "LoopBudgetExceeded";
	constructor(
		readonly limit: "calls" | "actions" | "deadline" | "aborted",
		message: string,
	) {
		super(message);
	}
}

/** Mutable counters over a {@link LoopBudget}. */
export class LoopMeter {
	calls = 0;
	actions = 0;
	readonly attempts: DecisionProvenance[] = [];

	constructor(readonly budget: LoopBudget) {}

	/** Throws when a further judgment call or action is not admissible. */
	checkpoint(kind: "call" | "action"): void {
		const { budget } = this;
		if (budget.signal?.aborted) {
			throw new LoopBudgetExceeded("aborted", "loop aborted by caller");
		}
		if (Date.now() >= budget.deadlineAt) {
			throw new LoopBudgetExceeded("deadline", `loop deadline reached after ${this.calls} calls`);
		}
		if (kind === "call" && this.calls >= budget.maxCalls) {
			throw new LoopBudgetExceeded("calls", `judgment call bound ${budget.maxCalls} reached`);
		}
		if (kind === "action" && this.actions >= budget.maxActions) {
			throw new LoopBudgetExceeded("actions", `action bound ${budget.maxActions} reached`);
		}
	}

	/** Signal that fires on the caller's abort or the loop deadline (clamped to `cap` ms), whichever comes first. */
	callSignal(cap: number): AbortSignal {
		const timeout = AbortSignal.timeout(Math.max(0, Math.min(cap, this.budget.deadlineAt - Date.now())));
		return this.budget.signal ? AbortSignal.any([this.budget.signal, timeout]) : timeout;
	}

	/** Aggregate usage across every attempt, including failed and nested ones. */
	totalUsage(): { calls: number; attempts: number; input: number; output: number; costUsd: number | "unknown" } {
		let input = 0;
		let output = 0;
		let cost = 0;
		let unknown = false;
		for (const attempt of this.attempts) {
			input += attempt.usage.input;
			output += attempt.usage.output;
			if (attempt.costUsd === "unknown") unknown = true;
			else cost += attempt.costUsd;
		}
		return { calls: this.calls, attempts: this.attempts.length, input, output, costUsd: unknown ? "unknown" : cost };
	}
}

/** Validate candidate ids: unique, keyword-safe, within the choice cap. */
export function assertCandidates(candidates: readonly ActionCandidate[]): void {
	if (candidates.length === 0) throw new Error("decision: no candidates");
	if (candidates.length > MAX_CHOICE_OPTIONS) {
		throw new Error(`decision: ${candidates.length} candidates exceed the ${MAX_CHOICE_OPTIONS}-option cap`);
	}
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (!CANDIDATE_ID.test(candidate.id)) throw new Error(`decision: invalid candidate id "${candidate.id}"`);
		if (seen.has(candidate.id)) throw new Error(`decision: duplicate candidate id "${candidate.id}"`);
		seen.add(candidate.id);
	}
}

/** Build the `Choice` question that selects among candidates. */
export function candidateChoice(instructions: string, candidates: readonly ActionCandidate[]): ChoiceQuestion<string> {
	const criteria: Record<string, string | null> = {};
	for (const candidate of candidates) criteria[candidate.id] = candidate.rubric ?? candidate.label;
	return { type: "choice", instructions, criteria };
}

/** Render candidates as a JSON-friendly list for the judgment state. */
export function renderCandidates(candidates: readonly ActionCandidate[]): JsonValue {
	return candidates.map(candidate => ({ id: candidate.id, action: candidate.label }));
}

/** Derive provenance from a judgment result and the judge that was asked. */
export function provenanceOf(
	judge: ResolvedJudge,
	result: JudgmentResult,
	timing: { startedAt: number; attempt: number },
	pinnedModel?: string,
): DecisionProvenance {
	const native = result.api === TYPESAFE_PROVIDER;
	const fellBack = judge.kind === "typesafe" && !native;
	return {
		backend: judge.kind,
		label: judge.label,
		api: result.api,
		provider: result.provider,
		model: result.model,
		distribution: native ? "native" : "synthetic",
		fallback: fellBack ? { from: judge.label, reason: "typesafe request failed" } : undefined,
		pinnedModel,
		usage: result.usage,
		// TypeSafe reports token counts without a price; chat transports price their usage.
		costUsd: native ? "unknown" : result.usage.cost.total,
		durationMs: Date.now() - timing.startedAt,
		attempt: timing.attempt,
	};
}

/** Provenance for an attempt that produced no answer; keeps the attempt on the meter. */
function failedProvenance(
	judge: ResolvedJudge,
	error: unknown,
	timing: { startedAt: number; attempt: number },
	pinnedModel?: string,
): DecisionProvenance {
	return {
		backend: judge.kind,
		label: judge.label,
		api: judge.kind === "typesafe" ? TYPESAFE_PROVIDER : "none",
		provider: "none",
		model: pinnedModel ?? "unknown",
		distribution: "synthetic",
		pinnedModel,
		usage: tokenUsage(0, 0),
		costUsd: "unknown",
		durationMs: Date.now() - timing.startedAt,
		attempt: timing.attempt,
		error: error instanceof Error ? error.message : String(error),
	};
}

/** Provenance row for one underlying transport attempt reported by the judge. */
function nestedProvenance(
	judge: ResolvedJudge,
	event: JudgmentAttempt,
	attempt: number,
	pinnedModel?: string,
): DecisionProvenance {
	const native = event.api === TYPESAFE_PROVIDER;
	return {
		backend: judge.kind,
		label: judge.label,
		api: event.api,
		provider: event.provider,
		model: event.model,
		distribution: native ? "native" : "synthetic",
		pinnedModel,
		usage: event.usage,
		costUsd: native ? "unknown" : event.usage.cost.total,
		durationMs: event.durationMs,
		attempt,
		nested: true,
		...(event.error !== undefined ? { error: event.error } : {}),
	};
}

/** Extra questions a decision may carry alongside the candidate choice. */
export interface DecisionExtras {
	/** Independent presence/completion checks answered in the same request. */
	nouls?: Record<string, NoulQuestion>;
}

export interface DecideOptions extends JudgeOptions {
	/** Per-call timeout cap in ms; the meter clamps it to the loop deadline. */
	callTimeoutMs?: number;
	pinnedModel?: string;
}

export interface DecisionResult<TArgs> extends CandidateDecision<TArgs> {
	nouls: Record<string, NoulAnswer>;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** Nested-row reason for a billed completion whose answer the judge rejected and retried. */
const REJECTED_ANSWER = "answer rejected; retried";

/** Map a failed metered call to the loop's budget errors; anything else propagates as-is. */
function rethrowMetered(
	meter: LoopMeter,
	error: unknown,
	callerSignal: AbortSignal | undefined,
	signal: AbortSignal,
): never {
	if (callerSignal?.aborted || meter.budget.signal?.aborted) {
		throw new LoopBudgetExceeded("aborted", "judgment aborted");
	}
	if (signal.aborted || AIError.is(AIError.classify(error), AIError.Flag.Abort)) {
		throw new LoopBudgetExceeded("deadline", "judgment call timed out");
	}
	throw error;
}

/**
 * One metered judgment request: enforces the call bound and deadline, maps
 * aborts/timeouts to {@link LoopBudgetExceeded}, and records provenance for
 * every attempt on the meter — the answering attempt, plus one `nested` row
 * per failed underlying transport attempt the judge reports (a TypeSafe
 * request that fell back to chat, chat candidates that errored). Features
 * that need several heads in one request (operation + per-operation target)
 * call this directly and validate each answered head against their own local
 * tables.
 */
export async function judgeWithMeter<Q extends Questions>(
	judge: ResolvedJudge,
	meter: LoopMeter,
	request: { state: JudgmentState; questions: Q },
	options: DecideOptions = {},
): Promise<{ result: JudgmentResult<Q>; provenance: DecisionProvenance }> {
	meter.checkpoint("call");
	const startedAt = Date.now();
	meter.calls++;
	const attempt = meter.calls;
	const loopSignal = meter.callSignal(options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, loopSignal]) : loopSignal;
	const pinnedModel = options.pinnedModel ?? judge.pinnedModel;
	// Every transport attempt is buffered as it happens. On success the judge's
	// last reported attempt is the completion the result came from — it is
	// represented by the final provenance row, never twice; every earlier
	// attempt (transport failure, or a billed completion whose answer was
	// rejected and retried) is kept as a `nested` row.
	const events: JudgmentAttempt[] = [];
	const onAttempt = (event: JudgmentAttempt): void => {
		events.push(event);
	};
	const nestedRow = (event: JudgmentAttempt): DecisionProvenance =>
		nestedProvenance(
			judge,
			event.error === undefined ? { ...event, error: REJECTED_ANSWER } : event,
			attempt,
			pinnedModel,
		);
	let result: JudgmentResult<Q>;
	try {
		result = await judge.judge(request, { signal, onAttempt });
	} catch (error) {
		for (const event of events) meter.attempts.push(nestedRow(event));
		// Without transport events the whole call is one opaque failed attempt.
		if (events.length === 0) {
			meter.attempts.push(failedProvenance(judge, error, { startedAt, attempt }, pinnedModel));
		}
		rethrowMetered(meter, error, options.signal, signal);
	}
	const answering = events.at(-1);
	const superseded = answering !== undefined && answering.error === undefined ? events.slice(0, -1) : events;
	for (const event of superseded) meter.attempts.push(nestedRow(event));
	const provenance = provenanceOf(judge, result, { startedAt, attempt }, pinnedModel);
	meter.attempts.push(provenance);
	return { result, provenance };
}

/** What a helper-model call reports back so its attempt can be costed. */
export interface HelperCallReport {
	api: string;
	provider: string;
	model: string;
	usage: Usage;
}

export interface HelperCallOptions {
	signal?: AbortSignal;
	/** Per-call timeout cap in ms; the meter clamps it to the loop deadline. */
	callTimeoutMs?: number;
}

/**
 * One metered helper-model completion (e.g. inferring a text value) made by a
 * loop beside its typed judgments. Counts against `maxCalls`, honours the
 * deadline/abort, and records a `helper` provenance row for the attempt —
 * failed ones included — so `LoopMeter.attempts` accounts for every remote
 * request the loop makes.
 */
export async function meterHelperCall<T>(
	meter: LoopMeter,
	helper: string,
	run: (signal: AbortSignal) => Promise<{ value: T; report: HelperCallReport }>,
	options: HelperCallOptions = {},
): Promise<{ value: T; provenance: DecisionProvenance }> {
	meter.checkpoint("call");
	const startedAt = Date.now();
	meter.calls++;
	const attempt = meter.calls;
	const loopSignal = meter.callSignal(options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, loopSignal]) : loopSignal;
	const base = { backend: "online" as const, label: helper, distribution: "synthetic" as const, attempt, helper };
	try {
		const { value, report } = await run(signal);
		const provenance: DecisionProvenance = {
			...base,
			api: report.api,
			provider: report.provider,
			model: report.model,
			usage: report.usage,
			costUsd: report.usage.cost.total,
			durationMs: Date.now() - startedAt,
		};
		meter.attempts.push(provenance);
		return { value, provenance };
	} catch (error) {
		meter.attempts.push({
			...base,
			api: "none",
			provider: "none",
			model: "unknown",
			usage: tokenUsage(0, 0),
			costUsd: "unknown",
			durationMs: Date.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
		});
		rethrowMetered(meter, error, options.signal, signal);
	}
}

/**
 * Ask the judge to pick one candidate (and answer any extra noul questions)
 * in a single request. The returned candidate is the exact local object whose
 * id was chosen; an unknown id is a backend error, never an action.
 */
export async function decideAmongCandidates<TArgs>(
	judge: ResolvedJudge,
	meter: LoopMeter,
	input: {
		state: JudgmentState;
		instructions: string;
		candidates: readonly ActionCandidate<TArgs>[];
		extras?: DecisionExtras;
	},
	options: DecideOptions = {},
): Promise<DecisionResult<TArgs>> {
	assertCandidates(input.candidates);
	const questions: Questions = { select: candidateChoice(input.instructions, input.candidates) };
	if (input.extras?.nouls) {
		for (const id in input.extras.nouls) {
			if (id === "select") throw new Error('decision: "select" is reserved');
			questions[id] = input.extras.nouls[id];
		}
	}
	const { result, provenance } = await judgeWithMeter(judge, meter, { state: input.state, questions }, options);
	const answer = result.answers.select;
	if (answer.type !== "choice") throw new Error("decision: backend answered the selection with a non-choice");
	const candidate = input.candidates.find(item => item.id === answer.choice);
	if (!candidate) throw new Error(`decision: backend chose unknown candidate "${answer.choice}"`);
	const ranking = input.candidates
		.map(item => ({ id: item.id, probability: answer.probabilities[item.id] ?? 0 }))
		.sort((a, b) => b.probability - a.probability);
	const nouls: Record<string, NoulAnswer> = {};
	for (const id in questions) {
		if (id === "select") continue;
		const extra = result.answers[id];
		if (extra.type === "noul") nouls[id] = extra;
	}
	return { candidate, answer, ranking, provenance, nouls };
}
