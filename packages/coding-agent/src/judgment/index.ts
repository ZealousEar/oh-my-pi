/**
 * Resolves the {@link Judge} that answers typed judgments through the `judge`
 * model role. The chain is re-resolved at most every {@link CANDIDATE_TTL_MS}
 * so live catalog discovery, role edits, credential changes, and session
 * fallback all take effect without recreating feature consumers, while bulk
 * callers (`judge_batch`) do not re-scan the whole catalog per item.
 */
import {
	type AssistantMessage,
	chatTextBackend,
	isJudgmentApi,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Model,
	type Questions,
	type TextBackend,
	type TextCompletion,
	type TextPrompt,
	TextJudge,
	TYPESAFE_PROVIDER,
	TypeSafeJudge,
	tokenUsage,
	type Usage,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelString,
	formatModelStringWithRouting,
	resolveRoleChain,
	type RoleChainCandidate,
} from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { cfgRetryFallbackChains } from "../session/settings";
import type { SessionManager } from "../session/session-manager";
import { getTinyLocalModelSpec } from "../tiny/models";
import localPromptTemplate from "../prompts/system/judgment-local.md" with { type: "text" };
import { tinyModelClient } from "../tiny/title-client";

/** Usage of one judgment attempt, recorded on the session ledger by callers. */
export interface JudgmentUsage {
	/** Model role the call resolved through, or `typesafe` for native judgments. */
	role: string;
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: AssistantMessage["stopReason"];
	errorMessage?: string;
}

export interface JudgeDeps {
	settings: Settings;
	registry: ModelRegistry;
	/** The session's active model, appended when the judge role does not already route to it. */
	sessionModel?: Model;
	sessionId?: string;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	onUsage?: (usage: JudgmentUsage) => void;
}

/** Session journal surface that records off-transcript model cost; journal-only managers omit it. */
export type JudgmentUsageLedger = Pick<SessionManager, "appendModelUsage" | "getSessionId" | "getLeafId">;

function isUsageLedger(manager: Partial<JudgmentUsageLedger>): manager is JudgmentUsageLedger {
	return (
		manager.appendModelUsage !== undefined && manager.getSessionId !== undefined && manager.getLeafId !== undefined
	);
}

/**
 * Build a {@link JudgeDeps.onUsage} that journals every judgment attempt as a
 * `model_usage` entry under `purpose`, beneath the session leaf at record time,
 * so `getSessionStats()` counts it in session totals. Attempts that land after
 * the session changes are dropped by the ledger. Returns `undefined` when the
 * journal cannot record usage.
 */
export function journalJudgmentUsage(
	manager: Partial<JudgmentUsageLedger> | undefined,
	purpose: string,
): JudgeDeps["onUsage"] {
	if (!manager || !isUsageLedger(manager)) return undefined;
	const sessionId = manager.getSessionId();
	return usage => {
		manager.appendModelUsage({ purpose, ...usage }, { sessionId, parentId: manager.getLeafId() });
	};
}

/** One keyword per answer; OpenAI-compatible endpoints reject budgets below 16. */
const LOCAL_ANSWER_MAX_TOKENS = 16;
/** On-device reasoning models need room for the keyword after their `<think>` preamble. */
const LOCAL_REASONING_MAX_TOKENS = 1024;

/**
 * How long a candidate stays skipped after its account rejected a judgment
 * outright (401/403 credential, 402 billing cap). Every judgment rebuilds the
 * chain, so without this each call re-pays the rejected request plus a
 * credential-rotation round trip before reaching the next candidate.
 */
const CANDIDATE_REJECTION_COOLDOWN_MS = 5 * 60 * 1000;
/**
 * How long a resolved candidate list is reused. Resolution filters the full
 * catalog (thousands of models) synchronously — milliseconds per call, which a
 * concurrent fan-out turns into sustained event-loop stalls.
 */
const CANDIDATE_TTL_MS = 1_000;
/** Skip-until timestamps keyed by routed model identity, carried by the registry that produced the rejection. */
const kRejections = Symbol("judgment.rejections");
interface RegistryWithRejections extends ModelRegistry {
	[kRejections]?: Map<string, number>;
}

/** Which backend a judge-role candidate routes to: native System One decisions, on-device keywords, or a chat model. */
export type JudgeKind = "native" | "local" | "online";

/** Classify a role candidate by model API, never by provider identity. */
export function kindOf(candidate: RoleChainCandidate): JudgeKind;
export function kindOf(model: Model): JudgeKind;
export function kindOf(value: RoleChainCandidate | Model): JudgeKind {
	return kindOfApi(("model" in value ? value.model : value).api);
}

/** Classify an answering transport by API: the backend a result or attempt actually came from. */
export function kindOfApi(api: string): JudgeKind {
	if (isJudgmentApi(api as Model["api"])) return "native";
	if (api === "local-inference") return "local";
	return "online";
}

/**
 * One underlying transport attempt behind a judgment: a native request (with
 * `error` when it failed), a chat completion the text judge made (a billed
 * completion whose answer was rejected carries no `error`; the caller marks
 * it), or a candidate that failed before its transport reported anything.
 * Failed attempts carry zero usage unless the transport reported some.
 */
export interface JudgmentAttempt {
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	durationMs: number;
	error?: string;
}

export interface ChainJudgeOptions extends JudgeOptions {
	/** Receives one event per transport attempt, in order; the final result is unaffected. */
	onAttempt?: (attempt: JudgmentAttempt) => void;
}

/**
 * The judge role's exact pin: `modelRoles.judge` names one literal
 * `provider/id` and `retry.fallbackChains.judge` is an explicit empty list.
 * A pinned judge admits no substitute — not a fuzzy catalog match, not the
 * default role fallbacks, not the session model — so a pin whose model is
 * undiscovered, uncredentialed, or failing fails closed. Supersedes the fork's
 * `providers.typesafeModel` / `providers.judgmentFallback: none`.
 */
export function judgePin(settings: Settings): string | undefined {
	const chain = cfgRetryFallbackChains.get(settings).judge;
	if (!Array.isArray(chain) || chain.length !== 0) return undefined;
	const configured = settings.getModelRole("judge")?.trim();
	if (!configured || configured.startsWith("@") || !configured.includes("/") || /[*?]/.test(configured)) {
		return undefined;
	}
	return configured;
}

/**
 * The `judge` role's candidates in attempt order, drawn from credentialed
 * judge-capable models. From the first native candidate on, only native
 * candidates remain: a prompted model never stands in for a failed native
 * judgment, whose calibrated probabilities it cannot reproduce. Under an exact
 * {@link judgePin} only the candidate whose identity equals the pin remains.
 */
function judgeRoleChain(settings: Settings, registry: ModelRegistry): RoleChainCandidate[] {
	const chain = resolveRoleChain("judge", settings, roleCandidatePool("judge", settings, registry));
	const pin = judgePin(settings);
	if (pin !== undefined) {
		const exact = chain.find(candidate => formatModelString(candidate.model) === pin);
		return exact ? [exact] : [];
	}
	const firstNative = chain.findIndex(candidate => kindOf(candidate) === "native");
	if (firstNative < 0) return chain;
	return chain.filter((candidate, index) => index < firstNative || kindOf(candidate) === "native");
}

/**
 * Whether the `judge` role resolves first to a native System One backend
 * (TypeSafe jev, directly or through OpenRouter) rather than a prompted
 * on-device or chat model. Judge-heavy features gate on it, e.g. the `find`
 * tool under `find.enabled: auto`.
 */
export function hasNativeJudge(settings: Settings, registry: ModelRegistry): boolean {
	const [primary] = judgeRoleChain(settings, registry);
	return primary !== undefined && kindOf(primary) === "native";
}

/** Resolve a live judge-role chain. Candidates resolve lazily and are reused for {@link CANDIDATE_TTL_MS}. */
export function resolveJudge(deps: JudgeDeps): ChainJudge {
	return new ChainJudge(deps);
}

/**
 * Judge facade that falls through the live `judge` role chain. `withCandidate`
 * lets a caller choose candidate-specific questions while retaining the exact
 * same credential, failure, timeout, and abort semantics as ordinary `judge`.
 */
export class ChainJudge implements Judge {
	readonly label = "judge role chain";
	readonly #deps: JudgeDeps;
	#candidates: { list: RoleChainCandidate[]; expiresAt: number } | undefined;

	constructor(deps: JudgeDeps) {
		this.#deps = deps;
	}

	/** Exact `provider/id` the configuration pins the judge to; see {@link judgePin}. */
	get pinnedModel(): string | undefined {
		return judgePin(this.#deps.settings);
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: ChainJudgeOptions = {},
	): Promise<JudgmentResult<Q>> {
		return this.withCandidate(candidate => candidate.judge(request, options), options);
	}

	async withCandidate<T>(
		run: (judge: Judge, kind: JudgeKind) => Promise<T>,
		options: ChainJudgeOptions = {},
	): Promise<T> {
		const signal = options.signal;
		let lastFailure: string | undefined;
		let lastUnavailable: string | undefined;
		const candidates = this.#resolveCandidates();
		const rejections = this.#rejections();
		for (const candidate of candidates) {
			if (signal?.aborted) {
				throw signal.reason instanceof Error ? signal.reason : new AIError.AbortError("judgment aborted");
			}
			const identity = formatModelStringWithRouting(candidate.model);
			const skippedUntil = rejections.get(identity);
			if (skippedUntil !== undefined) {
				if (skippedUntil > Date.now()) {
					lastUnavailable = `${identity} rejected the account recently`;
					continue;
				}
				rejections.delete(identity);
			}
			const startedAt = Date.now();
			let reported = 0;
			const onAttempt = options.onAttempt
				? (attempt: JudgmentAttempt): void => {
						reported++;
						options.onAttempt?.(attempt);
					}
				: undefined;
			try {
				const judge = await this.#createJudge(candidate, signal, onAttempt);
				if (!judge) {
					lastUnavailable = `no API key for ${candidate.model.provider}/${candidate.model.id}`;
					continue;
				}
				return await run(judge, kindOf(candidate));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// A candidate that failed before its transport reported anything
				// (key resolution, backend construction) is still one tried candidate.
				if (onAttempt && reported === 0) {
					onAttempt({
						api: candidate.model.api,
						provider: candidate.model.provider,
						model: candidate.model.id,
						usage: tokenUsage(0, 0),
						durationMs: Date.now() - startedAt,
						error: message,
					});
				}
				if (signal?.aborted) {
					throw signal.reason instanceof Error ? signal.reason : new AIError.AbortError("judgment aborted");
				}
				if (isAbortOrTimeout(error)) throw error;
				const rejected = isAccountRejection(error);
				if (rejected) rejections.set(identity, Date.now() + CANDIDATE_REJECTION_COOLDOWN_MS);
				lastFailure = message;
				logger.warn("judgment candidate failed", {
					candidate: identity,
					status: AIError.status(error),
					error: lastFailure,
					skippedForMs: rejected ? CANDIDATE_REJECTION_COOLDOWN_MS : undefined,
				});
			}
		}
		if (candidates.length === 0) {
			const pin = this.pinnedModel;
			if (pin !== undefined) {
				throw new Error(
					`judgment: pinned judge ${pin} is unavailable (${this.#describePinGap(pin)}); ` +
						"the exact pin with an empty retry.fallbackChains.judge admits no substitute",
				);
			}
			throw new Error("judgment: no judge model available");
		}
		throw new Error(`judgment: every judge candidate failed: ${lastFailure ?? lastUnavailable ?? "unknown error"}`);
	}

	/** Why an exact pin resolved to nothing: not in the catalog, or catalogued but not admitted to the judge pool. */
	#describePinGap(pin: string): string {
		const { registry, settings } = this.#deps;
		const [provider] = pin.split("/", 1);
		const catalogued = registry.getAvailable("all").some(model => formatModelString(model) === pin);
		if (catalogued) return "the model is catalogued but the judge role does not accept it";
		const providerModels = registry.getAvailable("all").filter(model => model.provider === provider);
		if (providerModels.length === 0) {
			return `provider ${provider} lists no available models — check its credential, disabled-provider policy, and model discovery`;
		}
		const nearest = providerModels
			.map(model => formatModelString(model))
			.filter(identity => identity.startsWith(pin.slice(0, pin.lastIndexOf("-") + 1)))
			.slice(0, 3);
		const pool = roleCandidatePool("judge", settings, registry).length;
		return `${provider} lists ${providerModels.length} model(s) but not this id${nearest.length > 0 ? `; nearest: ${nearest.join(", ")}` : ""}; judge pool size ${pool}`;
	}

	#rejections(): Map<string, number> {
		const registry: RegistryWithRejections = this.#deps.registry;
		return (registry[kRejections] ??= new Map());
	}

	#resolveCandidates(): RoleChainCandidate[] {
		const now = Date.now();
		if (this.#candidates && now < this.#candidates.expiresAt) return this.#candidates.list;
		const list = this.#buildCandidates();
		this.#candidates = { list, expiresAt: now + CANDIDATE_TTL_MS };
		return list;
	}

	#buildCandidates(): RoleChainCandidate[] {
		const { settings, registry, sessionModel } = this.#deps;
		const candidates = judgeRoleChain(settings, registry);
		// An exact pin never gains the session model as a last resort.
		if (!sessionModel || judgePin(settings) !== undefined) return candidates;
		if (candidates.some(candidate => kindOf(candidate) === "native")) return candidates;
		const sessionIdentity = formatModelStringWithRouting(sessionModel);
		if (candidates.some(candidate => formatModelStringWithRouting(candidate.model) === sessionIdentity)) {
			return candidates;
		}
		return [...candidates, { model: sessionModel, explicit: false }];
	}

	async #createJudge(
		candidate: RoleChainCandidate,
		signal: AbortSignal | undefined,
		onAttempt: ChainJudgeOptions["onAttempt"],
	): Promise<Judge | undefined> {
		const model = candidate.model;
		if (model.api === "local-inference") return new TextJudge(new LocalTextBackend(model.id, onAttempt));
		if (!(await this.#deps.registry.getApiKey(model, this.#deps.sessionId, { signal }))) return undefined;
		const apiKey = this.#deps.registry.resolver(model, this.#deps.sessionId);
		if (isJudgmentApi(model.api)) {
			const headers = await this.#deps.registry.resolveModelHeaders(model, signal);
			const judge = new TypeSafeJudge({
				apiKey,
				api: model.api,
				provider: model.provider,
				model: model.id,
				baseUrl: model.baseUrl,
				headers,
			});
			return usageReportingTypeSafeJudge(judge, model, this.#deps.onUsage, onAttempt);
		}
		// Resolve metadata after getApiKey so the session-sticky credential is recorded first.
		const metadata = this.#deps.metadataResolver?.(model.provider);
		// Attempts are sequential within a candidate, so each one's duration is
		// the gap since the previous attempt ended (or since the candidate began).
		let attemptStartedAt = Date.now();
		const backend = chatTextBackend(model, {
			apiKey,
			sessionId: this.#deps.sessionId,
			metadata,
			onAttempt: attempt => {
				const now = Date.now();
				this.#deps.onUsage?.({
					role: "judge",
					api: attempt.api,
					provider: attempt.provider,
					model: attempt.model,
					usage: attempt.usage,
					stopReason: attempt.stopReason,
					errorMessage: attempt.errorMessage,
				});
				onAttempt?.({
					api: attempt.api,
					provider: attempt.provider,
					model: attempt.model,
					usage: attempt.usage,
					durationMs: now - attemptStartedAt,
					error:
						attempt.stopReason === "error" || attempt.stopReason === "aborted"
							? (attempt.errorMessage ?? attempt.stopReason)
							: undefined,
				});
				attemptStartedAt = now;
			},
		});
		return new TextJudge(backend);
	}
}

/** Keyword completions through the shared on-device tiny-model worker. */
class LocalTextBackend implements TextBackend {
	readonly api = "local-inference";
	readonly provider = "local";
	readonly guardState = false;
	readonly model: string;
	readonly #reasoning: boolean;
	readonly #onAttempt: ChainJudgeOptions["onAttempt"];

	constructor(modelId: string, onAttempt?: ChainJudgeOptions["onAttempt"]) {
		this.model = modelId;
		this.#reasoning = getTinyLocalModelSpec(modelId)?.reasoning === true;
		this.#onAttempt = onAttempt;
	}

	async complete(judgment: TextPrompt, options: JudgeOptions): Promise<TextCompletion> {
		const startedAt = Date.now();
		const attempt = { api: this.api, provider: this.provider, model: this.model, usage: tokenUsage(0, 0) };
		try {
			// Sub-2B models answer a bare user message as a question (or echo the
			// system prompt); one merged turn ending in `Answer:` keeps them classifying.
			const text = await tinyModelClient.complete(
				this.model,
				prompt.render(localPromptTemplate, { system: judgment.system, state: judgment.user }),
				{
					maxTokens: this.#reasoning ? LOCAL_REASONING_MAX_TOKENS : LOCAL_ANSWER_MAX_TOKENS,
					signal: options.signal,
				},
			);
			if (!text) throw new Error(`judgment: local model ${this.model} returned no output`);
			this.#onAttempt?.({ ...attempt, durationMs: Date.now() - startedAt });
			return { text };
		} catch (error) {
			this.#onAttempt?.({
				...attempt,
				durationMs: Date.now() - startedAt,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}
}

/**
 * Report each native judgment attempt's usage, failed ones included so the
 * session ledger shows why a judgment errored. TypeSafe itself reports tokens
 * only, so a response without a billed amount is priced from the catalog
 * model; a route that bills (OpenRouter) keeps its reported cost.
 */
function usageReportingTypeSafeJudge(
	judge: TypeSafeJudge,
	model: Model,
	onUsage: JudgeDeps["onUsage"],
	onAttempt: ChainJudgeOptions["onAttempt"],
): Judge {
	return {
		label: judge.label,
		async judge<Q extends Questions>(
			request: JudgmentRequest<Q>,
			options?: JudgeOptions,
		): Promise<JudgmentResult<Q>> {
			const startedAt = Date.now();
			let result: JudgmentResult<Q>;
			try {
				result = await judge.judge(request, options);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				onUsage?.({
					role: TYPESAFE_PROVIDER,
					api: judge.api,
					provider: judge.provider,
					model: judge.model,
					usage: tokenUsage(0, 0),
					stopReason: isAbortOrTimeout(error) ? "aborted" : "error",
					errorMessage,
				});
				onAttempt?.({
					api: judge.api,
					provider: judge.provider,
					model: judge.model,
					usage: tokenUsage(0, 0),
					durationMs: Date.now() - startedAt,
					error: errorMessage,
				});
				throw error;
			}
			if (result.usage.cost.total === 0) calculateCost(model, result.usage);
			onUsage?.({
				role: TYPESAFE_PROVIDER,
				api: result.api,
				provider: result.provider,
				model: judge.model,
				usage: result.usage,
				stopReason: "stop",
			});
			onAttempt?.({
				api: result.api,
				provider: result.provider,
				model: judge.model,
				usage: result.usage,
				durationMs: Date.now() - startedAt,
			});
			return result;
		},
	};
}

/** Credential or billing rejection: the account cannot serve this candidate until something changes out of band. */
function isAccountRejection(error: unknown): boolean {
	const status = AIError.status(error);
	return status === 401 || status === 402 || status === 403;
}

function isAbortOrTimeout(error: unknown): boolean {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
	return AIError.is(AIError.classify(error), AIError.Flag.Abort);
}
