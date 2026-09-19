/**
 * The bounded semantic desktop goal loop behind `computer.task`.
 *
 * Shape of one iteration: observe one window through structured accessibility
 * data, derive the permitted actions locally, let the judge pick exactly one id,
 * revalidate that target against a fresh observation, dispatch, then re-observe
 * and compare digests. The judge never authors arguments, never sees a stale
 * candidate list, and its DONE is a proposal that an independent re-observation
 * has to confirm before the task reports `done`.
 *
 * Failure handling is deliberately asymmetric: a refused action is terminal for
 * that candidate, a stale target only costs an observation, and an `unknown`
 * outcome (the dispatch may or may not have landed) forces reconciliation and
 * bars that exact action from being offered again.
 */
import type { JsonValue, NoulQuestion } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ResolvedJudge } from "../../../judgment";
import {
	type DecisionProvenance,
	type ExecutionOutcome,
	LoopBudgetExceeded,
	type LoopBudget,
	LoopMeter,
	type VerificationEvidence,
	decideAmongCandidates,
	judgeWithMeter,
	renderCandidates,
} from "../../../judgment/decision";
import selectTemplate from "../../../prompts/tools/computer-task-select.md" with { type: "text" };
import verifyTemplate from "../../../prompts/tools/computer-task-verify.md" with { type: "text" };
import { ToolAbortError } from "../../tool-errors";
import { automationScopeFromDenied } from "../../automation-policy";
import type { DesktopBackendSelection } from "../cua-backend";
import {
	alreadyHoldsValue,
	candidateSignature,
	deriveCandidates,
	dialogContext,
	frameWithinWindow,
	isConsequentialNode,
	isSecureNode,
	locateNode,
	nodeLabel,
} from "./candidates";
import { buildObservation } from "./observation";
import type { DesktopSurface } from "./surface";
import type { TextValueResolver } from "./text-value";
import type {
	ComputerTaskJudgeInfo,
	ComputerTaskOptions,
	ComputerTaskResult,
	ComputerTaskStatus,
	ComputerTaskStep,
	ComputerTaskWindowTarget,
	DesktopActionArgs,
	DesktopNode,
	DesktopObservation,
	DesktopValueSource,
	DesktopWindowInfo,
} from "./types";

/** Consecutive no-change actions after which the loop reports BLOCKED. */
const MAX_NO_CHANGE = 3;
/** Unverified DONE claims tolerated before the loop reports BLOCKED. */
const MAX_DONE_REJECTIONS = 2;
/** Native accessibility query cap per observation. */
const DEFAULT_MAX_NODES = 400;
/** Recent steps shown to the judge. */
const HISTORY_WINDOW = 6;
/** Per-judgment-call wall clock; the meter clamps it to the loop deadline. */
const JUDGE_CALL_TIMEOUT_MS = 30_000;

export interface ComputerTaskAuthorization {
	action: DesktopActionArgs;
	window: DesktopWindowInfo;
	consequential: boolean;
}

export interface ComputerTaskDeps {
	surface: DesktopSurface;
	judge: ResolvedJudge;
	resolveValue: TextValueResolver;
	/** Backend chosen for this run; `surface` is its implementation. */
	backend: DesktopBackendSelection;
	budget: LoopBudget;
	maxNodes?: number;
	signal?: AbortSignal;
	sleep?: (ms: number) => Promise<void>;
	/** Final exact-scope gate, called immediately before each desktop dispatch. */
	authorize?: (request: ComputerTaskAuthorization) => Promise<void> | void;
}

interface Verification {
	evidence: VerificationEvidence;
	observation?: DesktopObservation;
	/** Only the model corroborated the claim; no caller expectation was checked. */
	modelOnly?: boolean;
}

/** Matches a caller `expect.find` clause against one node, substring and case-insensitive. */
function matchesFind(node: DesktopNode, find: { role?: string; title?: string; value?: string }): boolean {
	const contains = (actual: string | undefined, needle: string | undefined): boolean =>
		needle === undefined || (actual !== undefined && actual.toLowerCase().includes(needle.toLowerCase()));
	return (
		contains(node.role, find.role) &&
		contains(node.title ?? node.description, find.title) &&
		contains(node.value, find.value)
	);
}

/** Longest field value shown to any model, per node and per helper request. */
export const MAX_MODEL_VALUE_CHARS = 200;

/** A node value as a model may see it: capped, and never a secret. */
export function modelVisibleValue(node: DesktopNode): string | undefined {
	if (node.value === undefined || isSecureNode(node)) return undefined;
	return node.value.length > MAX_MODEL_VALUE_CHARS
		? `${node.value.slice(0, MAX_MODEL_VALUE_CHARS)}… (${node.value.length} chars)`
		: node.value;
}

/** The judge-facing view of one observation: labels and capped values only, never refs it could invent. */
function renderNodes(observation: DesktopObservation): JsonValue {
	return observation.nodes.map(node => ({
		role: node.role,
		label: nodeLabel(node),
		value: modelVisibleValue(node) ?? null,
		enabled: node.enabled,
		focused: node.focused,
	}));
}

function windowState(window: DesktopWindowInfo): JsonValue {
	return { id: window.id, app: window.app, title: window.title, focused: window.focused };
}

/** Run one desktop goal to a verified end state, or to a bounded, explained stop. */
export async function runComputerTask(
	options: ComputerTaskOptions,
	deps: ComputerTaskDeps,
): Promise<ComputerTaskResult> {
	const goal = options.goal.trim();
	if (goal.length === 0) throw new ToolError("computer.task requires a non-empty goal");
	const target = resolveTarget(options);
	const meter = new LoopMeter(deps.budget);
	const maxNodes = deps.maxNodes ?? DEFAULT_MAX_NODES;
	const sleep = deps.sleep ?? (ms => Bun.sleep(ms));
	const allowConsequential = options.allowConsequential === true;
	const steps: ComputerTaskStep[] = [];
	const notes: string[] = [];
	const attempted = new Set<string>();
	let revision = 0;
	let noChange = 0;
	let doneRejections = 0;
	let verification: VerificationEvidence = { verified: "unknown", method: "not-attempted" };

	const window = await deps.surface.resolveWindow(target, deps.signal);

	const observe = async (): Promise<DesktopObservation | undefined> => {
		const raw = await deps.surface.observe(window.id, maxNodes, deps.signal);
		revision++;
		return buildObservation(raw, revision);
	};

	const finish = (status: ComputerTaskStatus, reason?: string): ComputerTaskResult => ({
		status,
		reason,
		goal,
		window,
		steps,
		verification,
		observationRevisions: revision,
		budget: {
			maxCalls: deps.budget.maxCalls,
			maxActions: deps.budget.maxActions,
			calls: meter.calls,
			actions: meter.actions,
			deadlineAt: deps.budget.deadlineAt,
		},
		usage: meter.totalUsage(),
		backend: {
			kind: deps.surface.kind,
			mode: deps.backend.mode,
			reason: deps.backend.reason,
			driver: deps.backend.driver,
			version: deps.backend.version,
			permissions: deps.backend.permissions,
			judge: judgeInfo(deps.judge, meter.attempts),
		},
		attempts: meter.attempts,
		notes,
	});

	const verify = async (): Promise<Verification> => {
		const observation = await observe();
		if (!observation) {
			return { evidence: { verified: false, method: deps.surface.method, detail: "window disappeared" } };
		}
		const failures: string[] = [];
		const checks: string[] = [];
		const expected = options.expect;
		if (expected?.titleIncludes !== undefined) {
			checks.push("titleIncludes");
			if (!observation.window.title.toLowerCase().includes(expected.titleIncludes.toLowerCase())) {
				failures.push(
					`window title ${JSON.stringify(observation.window.title)} does not include ${JSON.stringify(expected.titleIncludes)}`,
				);
			}
		}
		if (expected?.find !== undefined) {
			checks.push("find");
			const find = expected.find;
			if (!observation.nodes.some(node => matchesFind(node, find))) {
				failures.push(`no node matches ${JSON.stringify(find)}`);
			}
		}
		if (checks.length > 0) {
			return {
				evidence: {
					verified: failures.length === 0,
					method: `${deps.surface.method}+expect(${checks.join(",")})`,
					observation: observation.identity,
					detail: failures.length === 0 ? "every caller expectation holds" : failures.join("; "),
				},
				observation,
			};
		}
		// No caller check: ask the judge a fresh, independent question against the
		// re-observed state, in its own request - never the one that proposed DONE.
		// That is corroboration by the same model class, not independent evidence,
		// so the loop reports `unverified` rather than `done` on this path.
		const question: NoulQuestion = {
			type: "noul",
			instructions: prompt.render(verifyTemplate, { goal }),
			criteria: {
				true: "`window` and `nodes` show every requirement of the goal already met",
				false: "at least one requirement of the goal has no visible evidence in `window` or `nodes`",
			},
		};
		const { result } = await judgeWithMeter(
			deps.judge,
			meter,
			{
				state: { goal, window: windowState(observation.window), nodes: renderNodes(observation) },
				questions: { goal_satisfied: question },
			},
			{ callTimeoutMs: JUDGE_CALL_TIMEOUT_MS, signal: deps.signal, pinnedModel: deps.judge.pinnedModel },
		);
		const answer = result.answers.goal_satisfied;
		const noul = answer.type === "noul" ? answer.noul : 0;
		return {
			evidence: {
				verified: noul >= 0.5 ? "unknown" : false,
				method: `${deps.surface.method}+judge`,
				observation: observation.identity,
				detail: `goal_satisfied=${noul.toFixed(2)} (model verdict only; pass expect for independent verification)`,
			},
			observation,
			modelOnly: noul >= 0.5,
		};
	};

	const initial = await observe();
	if (!initial) throw new ToolError(`computer.task: window ${window.id} disappeared before the first observation`);
	let observation: DesktopObservation = initial;

	try {
		for (;;) {
			const derived = deriveCandidates({
				observation,
				goal,
				values: options.values,
				allowConsequential,
				exclude: attempted,
			});
			if (derived.gated.length > 0) {
				const note = `withheld consequential actions (pass allowConsequential: true to offer them): ${derived.gated.join(", ")}`;
				if (!notes.includes(note)) notes.push(note);
			}
			if (derived.satisfied.length > 0) {
				const note = `fields already holding their caller value (not offered): ${derived.satisfied.join(", ")}`;
				if (!notes.includes(note)) notes.push(note);
			}
			// Fields that already hold their caller value are not actions, but the
			// judge must still be able to claim completion over them.
			if (derived.total === 0 && derived.satisfied.length === 0) {
				if (derived.visualOnly) {
					return finish(
						"unsupported",
						"window exposes no actionable accessibility nodes (visual-only surface); use screenshots with pixel input instead",
					);
				}
				return finish(
					"blocked",
					derived.gated.length > 0
						? "every available action is consequential and was withheld"
						: "window exposes no enabled, actionable accessibility node",
				);
			}
			if (derived.total > derived.shown) {
				const note = `candidate list windowed to the ${derived.shown} most goal-relevant of ${derived.total} actions`;
				if (!notes.includes(note)) notes.push(note);
			}

			const startedAt = Date.now();
			const decision = await decideAmongCandidates(
				deps.judge,
				meter,
				{
					state: {
						goal,
						window: windowState(observation.window),
						// Only what the decision needs: revision and digest are loop
						// bookkeeping, and unrelated detail in the state costs accuracy.
						observation: {
							nodes: observation.nodes.length,
							nodeCount: observation.nodeCount,
							truncated: observation.truncated,
						},
						candidateWindow: { shown: derived.shown, total: derived.total },
						withheld: derived.gated,
						alreadySatisfied: derived.satisfied,
						authorizedValues: Object.keys(options.values ?? {}),
						nodes: renderNodes(observation),
						candidates: renderCandidates(derived.candidates),
						history: steps.slice(-HISTORY_WINDOW).map(step => ({
							action: step.label,
							outcome: step.outcome.status,
							changed: step.changed ?? null,
						})),
					},
					instructions: prompt.render(selectTemplate, { goal }),
					candidates: derived.candidates,
				},
				{ callTimeoutMs: JUDGE_CALL_TIMEOUT_MS, signal: deps.signal, pinnedModel: deps.judge.pinnedModel },
			);
			const args = decision.candidate.args;
			// The observation this candidate list came from; every step records it.
			const current = observation;
			const record = (
				outcome: ExecutionOutcome,
				extra?: { reconciliation?: string; changed?: boolean; valueSource?: DesktopValueSource },
			): void => {
				steps.push({
					index: steps.length + 1,
					action: decision.candidate.id,
					label: decision.candidate.label,
					kind: args.kind,
					ref: args.ref,
					valueSource: extra?.valueSource,
					outcome,
					observation: {
						revision: current.identity.revision,
						digest: current.identity.digest ?? "",
						nodeCount: current.nodeCount,
						truncated: current.truncated,
					},
					reconciliation: extra?.reconciliation,
					changed: extra?.changed,
					probability: decision.answer.probabilities[decision.candidate.id] ?? 0,
					durationMs: Date.now() - startedAt,
					provenance: decision.provenance,
				});
			};

			if (args.kind === "reobserve") {
				const next = await observe();
				record({ status: "applied", detail: "re-observed" });
				if (!next) return finish("blocked", "window disappeared while re-observing");
				observation = next;
				continue;
			}
			if (args.kind === "wait") {
				meter.checkpoint("action");
				meter.actions++;
				const before = observation.identity.digest;
				await sleep(args.waitMs ?? 400);
				const next = await observe();
				record(
					{ status: "applied", detail: `waited ${args.waitMs ?? 400}ms` },
					{
						changed: next ? next.identity.digest !== before : undefined,
					},
				);
				if (!next) return finish("blocked", "window disappeared while waiting");
				observation = next;
				continue;
			}
			if (args.kind === "blocked") {
				record({ status: "rejected", reason: "judge reported no action can advance the goal" });
				return finish("blocked", "no available action advances the goal");
			}
			if (args.kind === "abstain") {
				record({ status: "rejected", reason: "judge abstained" });
				return finish("abstained", "goal is ambiguous or not exposed by this window");
			}
			if (args.kind === "done") {
				const checked = await verify();
				verification = checked.evidence;
				if (checked.evidence.verified === true) {
					record({ status: "applied", detail: "completion verified" });
					return finish("done");
				}
				if (checked.modelOnly) {
					record({ status: "applied", detail: "completion claimed; corroborated by the judge only" });
					return finish(
						"unverified",
						"completion is a model verdict only: pass expect (titleIncludes/find) for an independently verified done",
					);
				}
				doneRejections++;
				record({
					status: "rejected",
					reason: `completion not verified: ${checked.evidence.detail ?? "no evidence"}`,
				});
				notes.push(`unverified completion claim: ${checked.evidence.detail ?? "no evidence"}`);
				if (!checked.observation) return finish("blocked", "window disappeared while verifying completion");
				observation = checked.observation;
				if (doneRejections >= MAX_DONE_REJECTIONS) {
					return finish("blocked", "completion was claimed but could not be independently verified");
				}
				continue;
			}

			meter.checkpoint("action");
			// Revalidate the exact target against a fresh observation: the judgment
			// call took wall-clock time during which the window could have moved on.
			const fresh = await observe();
			if (!fresh) {
				record({ status: "unknown", reason: "window disappeared before the action was dispatched" });
				return finish("blocked", "window disappeared before the action was dispatched");
			}
			if (!fresh.window.focused || fresh.window.app !== window.app || fresh.window.id !== window.id) {
				record({
					status: "rejected",
					reason: "focused window changed before the action could be authorized",
				});
				return finish("blocked", "focused window changed before desktop dispatch");
			}
			const located = locateNode(fresh, args);
			if (!("node" in located)) {
				record({ status: "stale", reason: located.reason, observed: fresh.identity });
				observation = fresh;
				continue;
			}
			const node = located.node;
			const invalid = !node.enabled
				? "element became disabled"
				: args.kind === "click" && !frameWithinWindow(node, fresh)
					? "element frame lies outside the window bounds"
					: undefined;
			if (invalid) {
				record({ status: "stale", reason: invalid, observed: fresh.identity });
				observation = fresh;
				continue;
			}

			let valueSource: DesktopValueSource | undefined;
			// Dispatch against the ref of the freshly observed node: a new query
			// re-registers refs, so the candidate's own ref may already be retired.
			let dispatch: DesktopActionArgs = { ...args, ref: node.ref };
			if (args.kind === "set-value") {
				if (args.text === undefined) {
					const resolved = await deps.resolveValue({
						goal,
						field: args.title ?? args.role ?? "field",
						role: args.role ?? "textfield",
						current: modelVisibleValue(node),
						meter,
						signal: deps.signal,
					});
					if (!resolved.ok) {
						record({ status: "rejected", reason: resolved.reason });
						attempted.add(candidateSignature(args));
						observation = fresh;
						continue;
					}
					dispatch = { ...dispatch, text: resolved.text };
					valueSource = "model";
				} else if (alreadyHoldsValue(node, args.text)) {
					// The field caught up between the decision and the revalidation
					// (or the judge picked a stale-window candidate): an idempotent
					// re-write is refused, never dispatched or counted as an action.
					record({ status: "rejected", reason: `field already holds the caller value "${args.valueKey ?? ""}"` });
					attempted.add(candidateSignature(args));
					observation = fresh;
					continue;
				} else {
					valueSource = "caller";
				}
			}

			await deps.authorize?.({
				action: dispatch,
				window: fresh.window,
				consequential: args.kind !== "set-value" && isConsequentialNode(node, dialogContext(fresh)),
			});
			const before = fresh.identity.digest;
			meter.actions++;
			const dispatched = await deps.surface.execute(dispatch, fresh.window, deps.signal);
			const outcome: ExecutionOutcome =
				dispatched.status === "stale"
					? { status: "stale", reason: dispatched.reason, observed: fresh.identity }
					: dispatched;
			if (outcome.status !== "applied") {
				logger.debug("computer.task: action dispatch failed", {
					backend: deps.surface.kind,
					kind: dispatch.kind,
					status: outcome.status,
					reason: outcome.reason,
				});
			}
			const after = await observe();
			if (!after) {
				record(outcome, { reconciliation: "window closed after the dispatch", valueSource });
				return finish("blocked", "window disappeared after the action was dispatched");
			}
			const changed = after.identity.digest !== before;
			let reconciliation: string | undefined;
			if (outcome.status === "unknown") {
				// Never retry an ambiguous mutation: reconcile, bar this action, move on.
				reconciliation = changed
					? "re-observed after an interrupted dispatch: the window changed, treating the action as landed"
					: "re-observed after an interrupted dispatch: the window is unchanged, the action is not repeated";
				attempted.add(candidateSignature(args));
			}
			if (outcome.status === "rejected") attempted.add(candidateSignature(args));
			if (outcome.status === "applied") noChange = changed ? 0 : noChange + 1;
			record(outcome, { reconciliation, changed, valueSource });
			observation = after;
			if (noChange >= MAX_NO_CHANGE) {
				return finish("blocked", `${MAX_NO_CHANGE} consecutive actions produced no observable change`);
			}
		}
	} catch (error) {
		if (error instanceof LoopBudgetExceeded) {
			if (error.limit === "aborted") throw new ToolAbortError("computer.task aborted");
			return finish("exhausted", error.message);
		}
		if (automationScopeFromDenied(error)) throw error;
		if (error instanceof ToolAbortError) throw error;
		// A judge transport or backend failure after the loop started: the
		// attempts made so far are part of the result, not lost with the throw.
		const message = error instanceof Error ? error.message : String(error);
		logger.debug("computer.task: loop failed", { error: message });
		return finish("failed", message);
	}
}

/** Explicit window target; the focused window is only used when asked for by name. */
function resolveTarget(options: ComputerTaskOptions): ComputerTaskWindowTarget {
	const target = options.window;
	if (typeof target === "string") return target;
	const filter = { ...target };
	if (options.app !== undefined) filter.app = filter.app ?? options.app;
	if (filter.app === undefined && filter.title === undefined) {
		throw new ToolError(
			'computer.task requires an explicit target: pass window (an exact window id, an app/title filter, or "focused") or app',
		);
	}
	return filter;
}

/** Judge identity, taken from the attempt that actually answered when there is one. */
function judgeInfo(judge: ResolvedJudge, attempts: readonly DecisionProvenance[]): ComputerTaskJudgeInfo {
	const last = attempts.at(-1);
	return {
		kind: judge.kind,
		label: judge.label,
		model: last?.model ?? judge.pinnedModel ?? "unresolved",
		distribution: last?.distribution ?? (judge.kind === "typesafe" ? "native" : "synthetic"),
		fallback: last?.fallback,
	};
}
