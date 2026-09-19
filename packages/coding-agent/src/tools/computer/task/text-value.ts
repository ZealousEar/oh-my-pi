/**
 * Small-model route for a field value the caller did not authorize.
 *
 * Deliberately narrow: the model produces one JSON object containing one
 * string, validated locally. It never chooses the field, never chooses the
 * action, and an unparseable or empty reply rejects the action instead of
 * guessing. Same call shape as the browser task slice, so the two remain
 * trivially mergeable into one shared helper.
 */
import { completeSimple, type Api, type Model, type Usage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { extractTextContent } from "../../../commit/utils";
import type { ModelRegistry } from "../../../config/model-registry";
import type { JudgmentUsage } from "../../../judgment";
import { LoopBudgetExceeded, type LoopMeter, meterHelperCall } from "../../../judgment/decision";
import type { Settings } from "../../../config/settings";
import valuePromptTemplate from "../../../prompts/tools/computer-task-value.md" with { type: "text" };
import { collectOnlineTinyCandidates } from "../../../tiny/online-candidates";

/** Longest field value the route will accept. */
const MAX_VALUE_LENGTH = 2_000;
const MAX_OUTPUT_TOKENS = 256;
/** Longest slice of the current field contents sent to the helper model. */
const MAX_CURRENT_CHARS = 200;
/** Per-attempt wall clock; the loop meter clamps it to the deadline. */
const HELPER_CALL_TIMEOUT_MS = 30_000;
/** Provenance label of every value-inference attempt. */
export const VALUE_HELPER = "value-inference";

export interface TextValueRequest {
	goal: string;
	/** Node label the value is destined for. */
	field: string;
	role: string;
	/** Current field contents (already capped and secret-free by the caller), so the model can see what it would replace. */
	current?: string;
	/** The loop's meter: every helper attempt counts against `maxCalls` and is recorded as provenance. */
	meter: LoopMeter;
	signal?: AbortSignal;
}

export type TextValueOutcome =
	| { ok: true; text: string; model: string; provider: string; usage: Usage; durationMs: number }
	| { ok: false; reason: string };

/** Resolves the text for a `set-value` action; injected in tests. */
export type TextValueResolver = (request: TextValueRequest) => Promise<TextValueOutcome>;

export interface TextValueDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId?: string;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	/** Receives each completed attempt so the caller can record it on the session usage ledger. */
	onUsage?: (usage: JudgmentUsage) => void;
}

/** Parse and bound the model reply; anything else is a rejection, never a guess. */
export function parseTextValueReply(text: string): { ok: true; text: string } | { ok: false; reason: string } {
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
	const trimmed = fenced ? fenced[1]!.trim() : text.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { ok: false, reason: "value model did not return JSON" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !("text" in parsed)) {
		return { ok: false, reason: 'value model returned no "text" field' };
	}
	const value: unknown = parsed.text;
	if (typeof value !== "string") return { ok: false, reason: 'value model returned a non-string "text"' };
	if (value.trim().length === 0) return { ok: false, reason: "value model declined to supply a value" };
	if (value.length > MAX_VALUE_LENGTH) return { ok: false, reason: `value model returned ${value.length} characters` };
	return { ok: true, text: value };
}

/**
 * Build the real resolver over the tiny/smol/default role chain. Every remote
 * attempt runs through {@link meterHelperCall}: it counts against the loop's
 * call bound, is recorded as a `value-inference` provenance row (failures
 * included), and a deadline or abort surfaces as `LoopBudgetExceeded`.
 */
export function createTextValueResolver(deps: TextValueDeps): TextValueResolver {
	return async request => {
		const candidates = collectOnlineTinyCandidates(
			["tiny", "smol", "default"],
			deps.settings,
			deps.registry.getAvailable(),
			{ tryAllRoles: true },
		);
		if (candidates.length === 0)
			return { ok: false, reason: "no tiny/smol/default model available for value inference" };
		const current =
			request.current === undefined
				? undefined
				: request.current.length > MAX_CURRENT_CHARS
					? `${request.current.slice(0, MAX_CURRENT_CHARS)}…`
					: request.current;
		const user = [
			`goal: ${request.goal}`,
			`field: ${request.field}`,
			`field role: ${request.role}`,
			current === undefined ? undefined : `current value: ${current}`,
		]
			.filter((line): line is string => line !== undefined)
			.join("\n");
		let lastError = "value inference failed";
		for (const { role, model } of candidates) {
			const apiKey = await deps.registry.getApiKey(model as Model<Api>, deps.sessionId);
			if (!apiKey) {
				lastError = `no API key for ${model.provider}/${model.id}`;
				continue;
			}
			const startedAt = Date.now();
			try {
				const { value: message } = await meterHelperCall(
					request.meter,
					VALUE_HELPER,
					async signal => {
						const completed = await completeSimple(
							model,
							{
								systemPrompt: [valuePromptTemplate],
								messages: [{ role: "user", content: user, timestamp: Date.now() }],
							},
							{
								apiKey: deps.registry.resolver(model, deps.sessionId),
								sessionId: deps.sessionId,
								metadata: deps.metadataResolver?.(model.provider),
								maxTokens: MAX_OUTPUT_TOKENS,
								temperature: 0,
								disableReasoning: true,
								signal,
							},
						);
						return {
							value: completed,
							report: {
								api: completed.api,
								provider: completed.provider,
								model: completed.model,
								usage: completed.usage,
							},
						};
					},
					{ signal: request.signal, callTimeoutMs: HELPER_CALL_TIMEOUT_MS },
				);
				deps.onUsage?.({
					role,
					api: message.api,
					provider: message.provider,
					model: message.model,
					usage: message.usage,
					stopReason: message.stopReason,
				});
				const parsed = parseTextValueReply(extractTextContent(message));
				if (!parsed.ok) {
					lastError = parsed.reason;
					continue;
				}
				return {
					ok: true,
					text: parsed.text,
					model: model.id,
					provider: model.provider,
					usage: message.usage,
					durationMs: Date.now() - startedAt,
				};
			} catch (error) {
				// Budget, deadline, and abort belong to the loop; a provider failure
				// is already on the meter, so the next candidate may still be tried.
				if (error instanceof LoopBudgetExceeded) throw error;
				lastError = error instanceof Error ? error.message : String(error);
				logger.debug("computer.task: value inference candidate failed", { model: model.id, error: lastError });
			}
		}
		return { ok: false, reason: lastError };
	};
}
