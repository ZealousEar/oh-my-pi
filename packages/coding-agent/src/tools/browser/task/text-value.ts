/**
 * Field values for TYPE_TEXT.
 *
 * Caller-supplied `values` win, and only by exact normalised equality of the
 * key with the control's label, placeholder, or form name: a page cannot name a
 * field so that it fuzzily captures a value meant for another one. Only when
 * nothing matches does a small model write the value, through the same role
 * chain (`tiny` -> `smol` -> `default`) the judgment backend uses — no new HTTP
 * client. Every helper completion is metered beside the judgments, and its
 * answer is accepted only when the goal or the caller values ground it; a
 * value the page could have induced rejects the step and types nothing.
 */
import { completeSimple } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../../config/model-registry";
import type { Settings } from "../../../config/settings";
import { extractTextContent } from "../../../commit/utils";
import { LoopBudgetExceeded, type LoopMeter, meterHelperCall } from "../../../judgment/decision";
import type { JudgmentUsage } from "../../../judgment/index";
import textSystemPrompt from "../../../prompts/tools/browser-task-text.md" with { type: "text" };
import { collectOnlineTinyCandidates } from "../../../tiny/online-candidates";
import type { TaskControl, TaskSnapshot, TextHelperProvenance } from "./types";

/** Hard ceiling on a written field value; longer answers are rejected, never truncated. */
export const MAX_TEXT_VALUE = 2000;
const HELPER_MAX_TOKENS = 512;
const HELPER_TIMEOUT_MS = 20_000;
/** What the helper sees of the page and of the field's current value. */
const HELPER_PAGE_TEXT_CAP = 2000;
const HELPER_VALUE_CAP = 200;

export interface TextHelperDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId?: string;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	onUsage?: (usage: JudgmentUsage) => void;
}

export interface TextValueContext {
	goal: string;
	control: TaskControl;
	snapshot: TaskSnapshot;
	/** `<operation> <label>` per recent step; never typed values. */
	recent: readonly string[];
	values?: Record<string, string>;
}

export type TextValueResult =
	| { status: "resolved"; text: string; source: "values" | "model"; key?: string; helper?: TextHelperProvenance }
	| { status: "rejected"; reason: string; helper?: TextHelperProvenance };

/** Case-, whitespace-, and compatibility-insensitive form used for every equality below. */
export function normalizeKey(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Origin and pathname only: query strings and fragments carry tokens and never leave the machine. */
export function publicUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.origin + parsed.pathname;
	} catch {
		return "";
	}
}

/**
 * The caller-supplied value for this control: the single key equal (after
 * normalisation) to the control's label, placeholder, or form name. No
 * substring matching in either direction. Label wins over placeholder over
 * name when several keys match different sources.
 */
export function matchSuppliedValue(
	values: Record<string, string> | undefined,
	control: TaskControl,
): { key: string; value: string } | undefined {
	if (!values) return undefined;
	const sources = [control.label, control.placeholder, control.name];
	for (const source of sources) {
		if (!source) continue;
		const wanted = normalizeKey(source);
		if (!wanted) continue;
		for (const key in values) {
			if (normalizeKey(key) === wanted) return { key, value: values[key] ?? "" };
		}
	}
	return undefined;
}

/** Local validation of any candidate value, caller-supplied or model-written. */
export function validateTextValue(
	text: unknown,
	control: TaskControl,
): { ok: true; text: string } | { ok: false; reason: string } {
	if (typeof text !== "string") return { ok: false, reason: "field value is not a string" };
	if (text.length === 0) return { ok: false, reason: "field value is empty" };
	if (text.length > MAX_TEXT_VALUE) {
		return { ok: false, reason: "field value is " + text.length + " chars, over the " + MAX_TEXT_VALUE + " cap" };
	}
	if (!control.multiline && /[\r\n]/.test(text)) {
		return { ok: false, reason: "field value spans multiple lines but the field is single-line" };
	}
	return { ok: true, text };
}

export interface HelperReply {
	text: unknown;
	source: unknown;
}

/** Extract `{"text": ..., "source": ...}` from a model reply that may carry fences or prose around it. */
export function parseTextReply(reply: string): { ok: true; reply: HelperReply } | { ok: false; reason: string } {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start < 0 || end <= start) return { ok: false, reason: "helper returned no JSON object" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(reply.slice(start, end + 1));
	} catch {
		return { ok: false, reason: "helper returned unparseable JSON" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, reason: "helper returned a non-object" };
	}
	if (!("text" in parsed)) return { ok: false, reason: "helper reply had no text key" };
	return { ok: true, reply: { text: Reflect.get(parsed, "text"), source: Reflect.get(parsed, "source") } };
}

/**
 * Accept a helper value only when something the caller controls determines
 * it: `source: "values"` must equal one caller value exactly, `source: "goal"`
 * requires the field's label to be named in the goal. Anything else — a value
 * the page's own text could have induced — is `helper value not grounded`.
 */
export function groundHelperValue(
	reply: HelperReply,
	context: Pick<TextValueContext, "goal" | "control" | "values">,
): { ok: true; text: string } | { ok: false; reason: string } {
	const checked = validateTextValue(reply.text, context.control);
	if (!checked.ok) return { ok: false, reason: "helper value: " + checked.reason };
	if (reply.source === "values") {
		for (const key in context.values) {
			if (context.values[key] === checked.text) return checked;
		}
		return { ok: false, reason: "helper value not grounded: no caller value equals it" };
	}
	if (reply.source === "goal") {
		const label = normalizeKey(context.control.label);
		if (label && normalizeKey(context.goal).includes(label)) return checked;
		return {
			ok: false,
			reason: 'helper value not grounded: the goal does not name field "' + context.control.label + '"',
		};
	}
	return { ok: false, reason: "helper value not grounded: source must be goal or values" };
}

/**
 * Resolve the text to type: caller values first, small model only as fallback.
 * Without `deps` (no reachable model registry) an unmatched field is rejected
 * rather than guessed. Helper completions are metered on `meter`: each counts
 * as one call, honours the deadline, and leaves a provenance row whether or
 * not it answered.
 */
export async function resolveTextValue(
	context: TextValueContext,
	meter: LoopMeter,
	deps?: TextHelperDeps,
): Promise<TextValueResult> {
	const supplied = matchSuppliedValue(context.values, context.control);
	if (supplied) {
		const checked = validateTextValue(supplied.value, context.control);
		return checked.ok
			? { status: "resolved", text: checked.text, source: "values", key: supplied.key }
			: { status: "rejected", reason: 'supplied value for "' + supplied.key + '": ' + checked.reason };
	}
	if (!deps) {
		return {
			status: "rejected",
			reason: 'no caller value matched field "' + context.control.label + '" and no text helper is available',
		};
	}

	const candidates = collectOnlineTinyCandidates(
		["tiny", "smol", "default"],
		deps.settings,
		deps.registry.getAvailable(),
		{ tryAllRoles: true },
	);
	if (candidates.length === 0) {
		return { status: "rejected", reason: "no caller value matched this field and no tiny/smol model is available" };
	}
	// What leaves the machine for one field: the goal, the field's own
	// metadata and (capped) current value, origin+path, a bounded slice of
	// visible text, action labels, and the caller values it may pick from.
	const state = {
		goal: context.goal,
		field: {
			label: context.control.label,
			role: context.control.role,
			placeholder: context.control.placeholder ?? null,
			current_value: context.control.value === undefined ? null : context.control.value.slice(0, HELPER_VALUE_CAP),
			multiline: context.control.multiline,
		},
		page: {
			url: publicUrl(context.snapshot.url),
			title: context.snapshot.title,
			text: context.snapshot.text.slice(0, HELPER_PAGE_TEXT_CAP),
		},
		recent_actions: context.recent.slice(-10),
		values: context.values ?? {},
	};
	let lastError = "no model answered";
	for (const { role, model } of candidates) {
		const apiKey = await deps.registry.getApiKey(model, deps.sessionId);
		if (!apiKey) {
			lastError = "no API key for " + model.provider + "/" + model.id;
			continue;
		}
		const metadata = deps.metadataResolver?.(model.provider);
		const startedAt = Date.now();
		let helper: TextHelperProvenance;
		let reply: string;
		try {
			const metered = await meterHelperCall(
				meter,
				"text:" + role,
				async signal => {
					const response = await completeSimple(
						model,
						{
							systemPrompt: [textSystemPrompt],
							messages: [{ role: "user", content: JSON.stringify(state), timestamp: Date.now() }],
						},
						{
							apiKey: deps.registry.resolver(model, deps.sessionId),
							sessionId: deps.sessionId,
							maxTokens: HELPER_MAX_TOKENS,
							disableReasoning: true,
							metadata,
							signal,
						},
					);
					deps.onUsage?.({
						role,
						api: response.api,
						provider: response.provider,
						model: response.model,
						usage: response.usage,
						stopReason: response.stopReason,
						...(response.errorMessage === undefined ? {} : { errorMessage: response.errorMessage }),
					});
					if (response.stopReason === "error") throw new Error(response.errorMessage ?? "helper errored");
					return {
						value: response,
						report: {
							api: response.api,
							provider: response.provider,
							model: response.model,
							usage: response.usage,
						},
					};
				},
				{ callTimeoutMs: HELPER_TIMEOUT_MS },
			);
			const response = metered.value;
			helper = {
				api: response.api,
				provider: response.provider,
				model: response.model,
				role,
				durationMs: Date.now() - startedAt,
				inputTokens: response.usage.input,
				outputTokens: response.usage.output,
			};
			reply = extractTextContent(response);
		} catch (error) {
			if (error instanceof LoopBudgetExceeded) throw error;
			lastError = error instanceof Error ? error.message : String(error);
			logger.debug("browser.task: text helper failed", { model: model.id, error: lastError });
			continue;
		}
		const parsed = parseTextReply(reply);
		if (!parsed.ok) return { status: "rejected", reason: parsed.reason, helper };
		if (parsed.reply.text === null) {
			return { status: "rejected", reason: "helper reported the goal does not determine this field", helper };
		}
		const grounded = groundHelperValue(parsed.reply, context);
		if (!grounded.ok) return { status: "rejected", reason: grounded.reason, helper };
		return { status: "resolved", text: grounded.text, source: "model", helper };
	}
	return { status: "rejected", reason: "text helper unavailable: " + lastError };
}
