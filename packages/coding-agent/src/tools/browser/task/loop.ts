/**
 * The `tab.task` loop: observe atomically, decide with one metered judgment
 * request, execute behind freshness guards, then prove completion against the
 * caller's postconditions.
 *
 * Invariants this file exists to hold:
 *  - Candidates are derived locally from ONE observation; the judge answers
 *    with ids only, and an id the local table does not contain fails closed.
 *  - Freshness is re-checked before text generation AND immediately before
 *    input (in the worker). A changed guard is `stale`, never a retry. SCROLL
 *    and WAIT are bound to the document they were decided against too.
 *  - An interrupted or ambiguous mutation is `unknown`: the loop re-observes,
 *    reconciles by digest, and quarantines the action so it is not offered
 *    again unless the caller's postcondition is still unmet on a changed
 *    document and the action is non-consequential.
 *  - DONE is a proposal. `status: "done"` requires at least one caller `expect`
 *    check to hold on a fresh observation plus a `goal_satisfied` judgment;
 *    without `expect` the best the loop can report is `unverified`.
 *  - Every page contact and every remote call is checked against the deadline
 *    first and runs under a signal derived from it; every judgment and helper
 *    attempt, failed ones included, stays in the meter.
 *  - What leaves the machine is minimised: origin+path, bounded visible text,
 *    control labels and filled/empty state — never field values, query
 *    strings, fragments, or typed text.
 *
 * Loop shape adapted from jev-ultrafast (MIT) `agent.py`.
 */
import type { JsonValue, JudgmentState, Questions } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import {
	type ActionCandidate,
	assertCandidates,
	candidateChoice,
	type DecisionProvenance,
	type LoopBudget,
	LoopBudgetExceeded,
	LoopMeter,
	judgeWithMeter,
	type ObservationIdentity,
	type VerificationEvidence,
} from "../../../judgment/decision";
import type { ResolvedJudge } from "../../../judgment/index";
import operationTemplate from "../../../prompts/tools/browser-task-operation.md" with { type: "text" };
import targetTemplate from "../../../prompts/tools/browser-task-target.md" with { type: "text" };
import verifyCriteriaTemplate from "../../../prompts/tools/browser-task-verify-criteria.md" with { type: "text" };
import verifyTemplate from "../../../prompts/tools/browser-task-verify.md" with { type: "text" };
import { automationScopeFromDenied } from "../../automation-policy";
import { deriveCandidates, snapshotIdentity } from "./candidates";
import { publicUrl, resolveTextValue, type TextHelperDeps } from "./text-value";
import type {
	BrowserTaskOptions,
	BrowserTaskResult,
	TaskActionArgs,
	TaskControl,
	TaskDriver,
	TaskOperation,
	TaskQuarantine,
	TaskSnapshot,
	TaskStep,
	TaskStepProvenance,
} from "./types";

/** Consecutive stale targets tolerated before the loop reports no progress. */
const MAX_STALE_RETRIES = 3;
/** Consecutive non-wait actions that change nothing before the loop reports blocked. */
const MAX_NO_CHANGE = 3;
/** Post-input settle ceiling; WAIT gets the full window. */
const SETTLE_MS = 400;
const WAIT_MS = 3000;
/**
 * Completion judgment must clear this to accept DONE. A code-owned threshold on
 * the `goal_satisfied` noul; `done` additionally requires a caller `expect`
 * check, so the judgment never authorises completion by itself.
 */
const GOAL_SATISFIED_THRESHOLD = 0.5;
/** Visible page text sent with each judgment request. */
const JUDGE_TEXT_CAP = 3000;
/** Default per-contact ceiling when the host does not supply one; the deadline clamps it. */
const DEFAULT_STEP_TIMEOUT_MS = 60_000;

const OPERATION_RUBRIC: Record<TaskOperation, string> = {
	CLICK: "Click a control, link, menu option, autocomplete suggestion, checkbox, or radio.",
	TYPE_TEXT: "Enter or replace text in an editable field. The value comes from the caller or a small model.",
	SELECT: "Set a native dropdown to one of its observed values.",
	SCROLL: "Scroll to bring off-screen controls into the offered set.",
	WAIT: "Wait for the page to reach a useful state: options arriving, navigation settling, mutations stopping.",
	DONE: "Every requirement of the goal is visibly satisfied in this observation.",
	BLOCKED: "No offered operation can make progress on this page.",
	ABSTAIN: "The page needs a capability this loop does not have; hand back to the main model.",
};

/** What a target head selects among, named in its question so the premise is complete. */
const TARGET_NOUN: Record<TaskOperation, string> = {
	CLICK: "control",
	TYPE_TEXT: "field",
	SELECT: "dropdown value",
	SCROLL: "scroll direction",
	WAIT: "target",
	DONE: "target",
	BLOCKED: "target",
	ABSTAIN: "target",
};

/**
 * Option every target head carries so the judge can decline all offered
 * targets under that head's premise; never a candidate id.
 */
const TARGET_NONE = "none";

export interface BrowserTaskDeps {
	tabName: string;
	options: BrowserTaskOptions;
	driver: TaskDriver;
	judge: ResolvedJudge;
	budget: LoopBudget;
	/** Small-model route for field values. Omit to require caller `values`. */
	text?: TextHelperDeps;
	callTimeoutMs?: number;
	/** Ceiling for one page contact; the remaining deadline always tightens it. */
	stepTimeoutMs?: number;
}

function stepProvenance(provenance: DecisionProvenance, confidence: number, probability: number): TaskStepProvenance {
	return {
		backend: provenance.backend,
		label: provenance.label,
		model: provenance.model,
		distribution: provenance.distribution,
		...(provenance.fallback ? { fallback: provenance.fallback.from } : {}),
		costUsd: provenance.costUsd,
		durationMs: provenance.durationMs,
		confidence,
		probability,
	};
}

function controlFor(snapshot: TaskSnapshot, node: number | undefined): TaskControl | undefined {
	return node === undefined ? undefined : snapshot.controls.find(control => control.node === node);
}

/** Action ledger for the judge: what was tried and what happened, never what was typed. */
function recentRows(steps: readonly TaskStep[]): JsonValue {
	return steps.slice(-10).map(step => ({
		action: step.label,
		operation: step.operation,
		outcome: step.outcome,
		page_changed: step.pageChanged,
		...(step.reason === undefined ? {} : { reason: step.reason }),
	}));
}

/** Judgment state for one observation: minimised page view plus the ledger. */
function judgeState(
	snapshot: TaskSnapshot,
	elements: JsonValue,
	steps: readonly TaskStep[],
	quarantine: readonly TaskQuarantine[],
): JudgmentState {
	return {
		page: { url: publicUrl(snapshot.url), title: snapshot.title, text: snapshot.text.slice(0, JUDGE_TEXT_CAP) },
		elements,
		recent_actions: recentRows(steps),
		...(quarantine.length === 0
			? {}
			: {
					quarantined: quarantine.map(item => ({
						operation: item.operation,
						action: item.label,
						reason: "outcome unknown after step " + item.step + "; not offered again",
					})),
				}),
	};
}

/**
 * Run one goal-directed task against an already-open managed tab. Never throws
 * for loop-level failure: budget, cancellation, and dead ends are statuses with
 * the steps taken so far.
 */
export async function runBrowserTask(deps: BrowserTaskDeps): Promise<BrowserTaskResult> {
	const { driver, judge, options } = deps;
	const meter = new LoopMeter(deps.budget);
	const stepTimeoutMs = deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
	const startedAt = Date.now();
	const steps: TaskStep[] = [];
	const quarantine: TaskQuarantine[] = [];
	const usedValueKeys = new Set<string>();
	const judgeOptions = {
		...(deps.callTimeoutMs === undefined ? {} : { callTimeoutMs: deps.callTimeoutMs }),
		...(deps.budget.signal ? { signal: deps.budget.signal } : {}),
	};
	let revision = 0;
	let snapshot: TaskSnapshot | undefined;
	let identity: ObservationIdentity | undefined;
	let initialDigest: string | undefined;
	let staleRetries = 0;
	let noChange = 0;
	let candidatesTruncated = false;
	let candidateFallback: string | undefined;
	let lastProvenance: DecisionProvenance | undefined;
	// The field a WAIT should watch for an autocomplete listbox.
	let lastTypedNode: number | undefined;
	let status: BrowserTaskResult["status"] = "exhausted";
	let reason: string | undefined;
	let verification: VerificationEvidence | undefined;

	/**
	 * One page contact: refused once the deadline has passed or the caller
	 * aborted, and run under a signal that fires at the deadline so no step
	 * outlives the task. A contact cut short by that signal is a budget stop.
	 */
	const contact = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
		if (meter.budget.signal?.aborted) throw new LoopBudgetExceeded("aborted", "loop aborted by caller");
		if (Date.now() >= meter.budget.deadlineAt) {
			throw new LoopBudgetExceeded("deadline", "loop deadline reached after " + meter.calls + " calls");
		}
		const signal = meter.callSignal(stepTimeoutMs);
		try {
			return await run(signal);
		} catch (error) {
			if (meter.budget.signal?.aborted) throw new LoopBudgetExceeded("aborted", "loop aborted by caller");
			if (signal.aborted && Date.now() >= meter.budget.deadlineAt) {
				throw new LoopBudgetExceeded("deadline", "loop deadline reached during page contact");
			}
			throw error;
		}
	};

	const reobserve = async (settle?: { node?: number; kind?: string }): Promise<boolean> => {
		const previous = identity?.digest;
		snapshot = await contact(signal =>
			driver.observe(settle ? { settle: { ...settle, budgetMs: SETTLE_MS } } : {}, signal),
		);
		identity = snapshotIdentity(snapshot, deps.tabName, ++revision);
		return identity.digest !== previous;
	};

	/** Caller postconditions that fail on the current observation; empty when none was supplied. */
	const expectFailures = async (current: TaskSnapshot): Promise<string[]> => {
		const failures: string[] = [];
		const expect = options.expect;
		if (expect?.urlIncludes && !current.url.includes(expect.urlIncludes)) {
			failures.push('url does not contain "' + expect.urlIncludes + '"');
		}
		if (expect?.textIncludes && !current.text.includes(expect.textIncludes)) {
			failures.push('page text does not contain "' + expect.textIncludes + '"');
		}
		if (expect?.selector) {
			const selector = expect.selector;
			const probe = await contact(signal => driver.probe(selector, signal));
			if (probe.selectorPresent !== true) failures.push("selector " + selector + " is not visible");
		}
		return failures;
	};
	const expectCount = options.expect
		? [options.expect.urlIncludes, options.expect.textIncludes, options.expect.selector].filter(Boolean).length
		: 0;

	try {
		await reobserve();
		if (!snapshot || !identity) throw new Error("browser.task: no observation");
		initialDigest = identity.digest;
		verification = {
			verified: "unknown",
			method: "none",
			detail: "the loop ended before a completion was proposed",
			observation: identity,
		};

		for (;;) {
			const current = snapshot;
			// A quarantined action is offered again only when the caller's
			// postcondition is still unmet on a changed document and the action
			// is non-consequential; the check is made once per decision.
			let expectUnmet = false;
			if (expectCount > 0 && quarantine.some(item => item.documentKey !== current.documentKey)) {
				expectUnmet = (await expectFailures(current)).length > 0;
			}
			const excluded = (candidate: ActionCandidate<TaskActionArgs>): boolean =>
				quarantine.some(
					item =>
						item.operation === candidate.args.operation &&
						item.label === candidate.args.label &&
						!(item.documentKey !== current.documentKey && expectUnmet && !candidate.args.consequential),
				);
			const set = deriveCandidates(current, excluded);
			if (set.truncated) {
				candidatesTruncated = true;
				candidateFallback = set.fallback;
			}
			const criteria: Record<string, string | null> = {};
			for (const operation of set.tables.keys()) criteria[operation] = OPERATION_RUBRIC[operation];
			criteria.WAIT = OPERATION_RUBRIC.WAIT;
			criteria.DONE = OPERATION_RUBRIC.DONE;
			criteria.BLOCKED = OPERATION_RUBRIC.BLOCKED;
			criteria.ABSTAIN = OPERATION_RUBRIC.ABSTAIN;
			const questions: Questions = {
				operation: {
					type: "choice",
					instructions: prompt.render(operationTemplate, {
						goal: options.goal,
						unsupported: current.unsupported.join(", "),
						truncated: set.truncated,
						fallback: set.fallback ?? "",
					}),
					criteria,
				},
			};
			for (const [operation, table] of set.tables) {
				assertCandidates(table);
				if (table.some(item => item.id === TARGET_NONE))
					throw new Error('browser.task: candidate id "none" is reserved');
				const head = candidateChoice(
					prompt.render(targetTemplate, {
						goal: options.goal,
						operation,
						rubric: OPERATION_RUBRIC[operation],
						noun: TARGET_NOUN[operation],
					}),
					table,
				);
				head.criteria[TARGET_NONE] =
					"No offered " + TARGET_NOUN[operation] + " would advance the goal if " + operation + " ran next";
				questions[operation.toLowerCase() + "_target"] = head;
			}
			const { result, provenance } = await judgeWithMeter(
				judge,
				meter,
				{ state: judgeState(current, set.elements, steps, quarantine), questions },
				judgeOptions,
			);
			lastProvenance = provenance;
			const operationAnswer = result.answers.operation;
			if (operationAnswer.type !== "choice") {
				status = "error";
				reason = "judgment backend answered the operation with a non-choice";
				break;
			}
			if (!(operationAnswer.choice in criteria)) {
				status = "error";
				reason = 'judgment backend chose unoffered operation "' + operationAnswer.choice + '"';
				break;
			}
			// Every head was answered without seeing the others. The operation
			// head ranks the operations; each target head, answered under the
			// premise that its operation runs, may decline every offered target
			// with `none`. The loop takes the highest-ranked operation whose
			// target head did not decline; operations without a target head
			// (WAIT, DONE, BLOCKED, ABSTAIN) can never be declined, so one is
			// always taken.
			const ranked = (Object.keys(criteria) as TaskOperation[]).sort(
				(a, b) =>
					(b === operationAnswer.choice ? 1 : 0) - (a === operationAnswer.choice ? 1 : 0) ||
					(operationAnswer.probabilities[b] ?? 0) - (operationAnswer.probabilities[a] ?? 0),
			);
			const declined: TaskOperation[] = [];
			let operation: TaskOperation = operationAnswer.choice as TaskOperation;
			let target: string | undefined;
			let args: TaskActionArgs = { operation, label: operation };
			let probability = 0;
			for (const candidateOperation of ranked) {
				const table = set.tables.get(candidateOperation);
				operation = candidateOperation;
				args = { operation, label: operation };
				probability = operationAnswer.probabilities[operation] ?? 0;
				if (!table) break;
				const head = operation.toLowerCase() + "_target";
				const targetAnswer = result.answers[head];
				if (targetAnswer === undefined || targetAnswer.type !== "choice") {
					status = "error";
					reason = "judgment backend did not answer the " + head + " head";
					break;
				}
				if (targetAnswer.choice === TARGET_NONE) {
					declined.push(operation);
					continue;
				}
				const candidate = table.find(item => item.id === targetAnswer.choice);
				if (!candidate) {
					status = "error";
					reason = 'judgment backend chose unknown target "' + targetAnswer.choice + '" for ' + operation;
					break;
				}
				target = candidate.id;
				args = candidate.args;
				probability = targetAnswer.probabilities[candidate.id] ?? 0;
				break;
			}
			if (status === "error") break;
			const vetoNote =
				declined.length === 0
					? undefined
					: declined.join(", ") +
						" declined by " +
						(declined.length === 1 ? "its target head" : "their target heads") +
						" (no offered target advances the goal); took " +
						operation;
			const provenanceRow = stepProvenance(provenance, operationAnswer.confidence, probability);
			const stepStarted = Date.now();
			const pushStep = (
				outcome: TaskStep["outcome"],
				pageChanged: boolean | null,
				extra: Partial<TaskStep> = {},
			): TaskStep => {
				const reasons = [vetoNote, extra.reason].filter((item): item is string => item !== undefined);
				const step: TaskStep = {
					n: steps.length + 1,
					operation,
					...(target === undefined ? {} : { target }),
					label: args.label || operation,
					outcome,
					pageChanged,
					ms: Date.now() - stepStarted,
					provenance: provenanceRow,
					...extra,
					...(reasons.length === 0 ? {} : { reason: reasons.join("; ") }),
				};
				steps.push(step);
				return step;
			};

			if (operation === "BLOCKED" || operation === "ABSTAIN") {
				pushStep("rejected", null, { reason: "the model reported it cannot proceed" });
				status = operation === "BLOCKED" ? "blocked" : "abstain";
				reason =
					operation === "BLOCKED"
						? "no offered operation could make progress"
						: "the page needs a capability this loop does not have" +
							(current.unsupported.length > 0 ? ": " + current.unsupported.join(", ") : "");
				break;
			}

			if (operation === "DONE") {
				pushStep("applied", null, { reason: "completion proposed" });
				await reobserve();
				const fresh = snapshot;
				const contradictions = await expectFailures(fresh);
				const verdict = await judgeWithMeter(
					judge,
					meter,
					{
						state: judgeState(fresh, deriveCandidates(fresh).elements, steps, quarantine),
						questions: {
							goal_satisfied: {
								type: "noul",
								instructions: prompt.render(verifyTemplate, { goal: options.goal }),
								criteria: {
									true: prompt.render(verifyCriteriaTemplate, { yes: true }).trim(),
									false: prompt.render(verifyCriteriaTemplate, { yes: false }).trim(),
								},
							},
						},
					},
					judgeOptions,
				);
				lastProvenance = verdict.provenance;
				const answer = verdict.result.answers.goal_satisfied;
				if (answer.type !== "noul") contradictions.push("completion judgment returned no answer");
				else if (answer.noul < GOAL_SATISFIED_THRESHOLD) {
					contradictions.push("completion judgment was " + answer.noul.toFixed(2));
				}
				// The judgment is the same model family that proposed DONE; only a
				// caller postcondition holding on the fresh page makes it `done`.
				const notes: string[] = [];
				if (expectCount === 0) {
					notes.push(
						"no caller expect postcondition was supplied, so the completion judgment alone cannot verify the result" +
							(identity.digest === initialDigest ? "; the observation is unchanged since the task started" : ""),
					);
				}
				const verified = contradictions.length > 0 ? false : expectCount === 0 ? "unknown" : true;
				verification = {
					verified,
					method: "dom-reobserve+expect+judge",
					observation: identity,
					detail:
						verified === true
							? "fresh observation satisfied every caller expectation and the completion judgment"
							: [...contradictions, ...notes].join("; "),
				};
				status = verified === true ? "done" : "unverified";
				if (status !== "done") reason = verification.detail;
				break;
			}

			if (args.consequential && options.allowConsequential !== true) {
				const why = args.consequentialReason ?? "classified consequential";
				pushStep("rejected", null, { reason: "consequential action requires approval: " + why });
				status = "blocked";
				reason = 'consequential action requires approval: "' + args.label + '" (' + why + ")";
				break;
			}

			// Host-side freshness check before any text generation: a decision
			// made against a page that already moved must not spend a helper call.
			if (args.node !== undefined) {
				const node = args.node;
				const expected = current.guards[String(node)] ?? null;
				const freshState = await contact(signal => driver.fresh(node, signal));
				if (freshState.documentKey !== current.documentKey || freshState.guard !== expected) {
					pushStep("stale", null, { reason: "page changed between the observation and the decision" });
					staleRetries++;
					await reobserve();
					if (staleRetries > MAX_STALE_RETRIES) {
						status = "blocked";
						reason = "the target kept changing under the loop after " + staleRetries + " attempts";
						break;
					}
					continue;
				}
			}

			let text: string | undefined;
			let textSource: TaskStep["textSource"];
			let helper: TaskStep["helper"];
			if (operation === "TYPE_TEXT") {
				const control = controlFor(current, args.node);
				if (!control) {
					pushStep("stale", null, { reason: "the chosen field left the observation" });
					staleRetries++;
					await reobserve();
					continue;
				}
				const resolved = await resolveTextValue(
					{
						goal: options.goal,
						control,
						snapshot: current,
						recent: steps.slice(-10).map(step => step.operation + " " + step.label),
						...(options.values ? { values: options.values } : {}),
					},
					meter,
					deps.text,
				);
				if (resolved.status === "rejected") {
					noChange++;
					pushStep("rejected", null, {
						reason: resolved.reason,
						...(resolved.helper ? { helper: resolved.helper } : {}),
					});
					if (noChange >= MAX_NO_CHANGE) {
						status = "blocked";
						reason = "no field value could be resolved: " + resolved.reason;
						break;
					}
					continue;
				}
				text = resolved.text;
				textSource = resolved.source;
				helper = resolved.helper;
				if (resolved.key !== undefined) usedValueKeys.add(resolved.key);
				lastTypedNode = args.node;
			}

			meter.checkpoint("action");
			meter.actions++;
			const waitNode = operation === "WAIT" ? lastTypedNode : undefined;
			const dispatchedKey = current.documentKey;
			const outcome = await contact(signal =>
				driver.act(
					{
						kind: operation,
						...(args.node === undefined
							? waitNode === undefined
								? {}
								: { node: waitNode }
							: { node: args.node }),
						...(text === undefined ? {} : { text }),
						...(args.value === undefined ? {} : { value: args.value }),
						...(args.deltaY === undefined ? {} : { deltaY: args.deltaY }),
						settleMs: operation === "WAIT" ? WAIT_MS : SETTLE_MS,
						consequential: args.consequential === true,
						// Every dispatch is bound to the document it was decided
						// against; node actions additionally to the target's guard.
						expect: {
							documentKey: dispatchedKey,
							guard: args.node === undefined ? null : (current.guards[String(args.node)] ?? null),
						},
					},
					signal,
				),
			);

			if (outcome.status === "stale") {
				staleRetries++;
				pushStep("stale", null, { reason: outcome.reason });
				await reobserve();
				if (staleRetries > MAX_STALE_RETRIES) {
					status = "blocked";
					reason = "the target kept changing under the loop: " + outcome.reason;
					break;
				}
				continue;
			}

			if (outcome.status === "rejected") {
				noChange++;
				pushStep("rejected", null, {
					reason: outcome.reason,
					...(text === undefined ? {} : { text }),
					...(textSource === undefined ? {} : { textSource }),
					...(helper === undefined ? {} : { helper }),
				});
				if (noChange >= MAX_NO_CHANGE) {
					status = "blocked";
					reason = "the last " + noChange + " actions changed nothing: " + outcome.reason;
					break;
				}
				continue;
			}

			staleRetries = 0;
			// Reconcile by digest: an `unknown` mutation may or may not have
			// landed, so the fresh observation decides what actually happened and
			// the action is withheld from later decisions.
			const changed = await reobserve({ node: args.node, kind: operation });
			const unknown = outcome.status === "unknown";
			const step = pushStep(unknown ? "unknown" : "applied", changed, {
				...(unknown ? { reason: outcome.reason, quarantined: true } : {}),
				...(text === undefined ? {} : { text }),
				...(textSource === undefined ? {} : { textSource }),
				...(helper === undefined ? {} : { helper }),
			});
			if (unknown) {
				quarantine.push({ operation, label: step.label, documentKey: dispatchedKey, step: step.n });
			}
			if (changed || operation === "WAIT") noChange = 0;
			else noChange++;
			if (noChange >= MAX_NO_CHANGE) {
				status = "blocked";
				reason = "the last " + noChange + " non-wait actions changed nothing (last: " + step.label + ")";
				break;
			}
		}
	} catch (error) {
		if (automationScopeFromDenied(error)) throw error;
		if (error instanceof LoopBudgetExceeded) {
			status = error.limit === "aborted" ? "error" : "exhausted";
			reason = error.message;
		} else {
			status = "error";
			reason = error instanceof Error ? error.message : String(error);
		}
	}

	return {
		status,
		...(reason === undefined ? {} : { reason }),
		goal: options.goal,
		tab: deps.tabName,
		steps,
		verification: verification ?? {
			verified: "unknown",
			method: "none",
			detail: "the loop ended before the page was observed",
			observation: { surface: "browser-tab", scope: deps.tabName, revision: 0, capturedAt: startedAt, digest: "" },
		},
		observationRevisions: revision,
		budget: {
			calls: meter.calls,
			actions: meter.actions,
			elapsedMs: Date.now() - startedAt,
			maxCalls: deps.budget.maxCalls,
			maxActions: deps.budget.maxActions,
		},
		usage: meter.totalUsage(),
		attempts: meter.attempts,
		backend: {
			kind: judge.kind,
			label: judge.label,
			...(lastProvenance
				? {
						model: lastProvenance.model,
						distribution: lastProvenance.distribution,
						...(lastProvenance.fallback ? { fallback: lastProvenance.fallback.from } : {}),
					}
				: {}),
		},
		candidatesTruncated,
		...(candidateFallback === undefined ? {} : { candidateFallback }),
		...(snapshot && snapshot.unsupported.length > 0 ? { unsupported: snapshot.unsupported } : {}),
		...(options.values === undefined
			? {}
			: { unusedValues: Object.keys(options.values).filter(key => !usedValueKeys.has(key)) }),
		...(quarantine.length === 0 ? {} : { quarantined: quarantine }),
	};
}
