/**
 * Model-preset schema, parsing, validation, and transactional application.
 *
 * A preset is a named, persisted snapshot of the model-routing configuration
 * (roles, fallback chains, cycle order, default thinking level). Applying a
 * preset is a validated, atomic, session-scoped routing transaction performed
 * entirely on the runtime-override layer — it is never persisted, never
 * shadowed by a higher-precedence layer, and rolled back in full when the
 * post-commit live model switch fails.
 */

import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Model, THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelRoleLookup } from "@oh-my-pi/pi-tui/overlays/model-browser";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
} from "@oh-my-pi/pi-tui/thinking";
import type { ModelRegistry } from "./model-registry";
import { resolveModelRoleValue } from "./model-resolver";
import { getKnownRoleIds } from "./model-roles";
import { modelRoleValueFromUnknown, type Settings } from "./settings";
import type { DefaultThinkingLevel, ModelPresetV1 } from "./settings-schema";

/** Outcome of an attempted preset application. */
export interface PresetApplyResult {
	applied: boolean;
	error?: string;
}

/**
 * Strictly parse `value` as a preset's default thinking level: a concrete
 * thinking effort or the `auto` sentinel. `inherit` and `off` are valid
 * session selectors but not members of the `defaultThinkingLevel` enum, so
 * they are rejected alongside garbage.
 */
function parsePresetThinkingLevel(value: unknown): DefaultThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = parseConfiguredThinkingLevel(value);
	if (parsed === undefined) return undefined;
	if (parsed === AUTO_THINKING) return parsed;
	for (const effort of THINKING_EFFORTS) {
		if (parsed === effort) return effort;
	}
	return undefined;
}

/**
 * Strictly parse arbitrary stored JSON into a {@link ModelPresetV1}.
 *
 * Malformed input is REJECTED rather than coerced into an (empty but
 * applicable) preset — a bad preset must never wipe the user's routing
 * configuration. `version` must be exactly `1`; `roles`, `fallbackChains`,
 * `cycleOrder`, and `defaultThinkingLevel` are all required and must be
 * well-typed. Role values may be a string or a string array (normalized via
 * {@link modelRoleValueFromUnknown}).
 */
export function parseModelPreset(raw: unknown): { ok: true; preset: ModelPresetV1 } | { ok: false; error: string } {
	if (!isRecord(raw)) {
		return { ok: false, error: "Preset is not an object." };
	}
	if (raw.version !== 1) {
		return { ok: false, error: `Unsupported preset version ${JSON.stringify(raw.version)}; expected 1.` };
	}
	if (!isRecord(raw.roles)) {
		return { ok: false, error: `Preset "roles" must be a role → selector record.` };
	}
	const roles: Record<string, string> = {};
	for (const [role, value] of Object.entries(raw.roles)) {
		const normalized = modelRoleValueFromUnknown(value);
		if (normalized === undefined || normalized.length === 0) {
			return { ok: false, error: `Preset role "${role}" must be a model selector string (or string array).` };
		}
		roles[role] = normalized;
	}
	if (!isRecord(raw.fallbackChains)) {
		return { ok: false, error: `Preset "fallbackChains" must be a record of selector arrays.` };
	}
	const fallbackChains: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(raw.fallbackChains)) {
		if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
			return { ok: false, error: `Preset fallback chain "${key}" must be an array of selector strings.` };
		}
		fallbackChains[key] = [...value];
	}
	const rawCycleOrder = raw.cycleOrder;
	if (!Array.isArray(rawCycleOrder) || !rawCycleOrder.every((entry): entry is string => typeof entry === "string")) {
		return { ok: false, error: `Preset "cycleOrder" must be an array of role ids.` };
	}
	const defaultThinkingLevel = parsePresetThinkingLevel(raw.defaultThinkingLevel);
	if (defaultThinkingLevel === undefined) {
		return {
			ok: false,
			error: `Preset "defaultThinkingLevel" ${JSON.stringify(raw.defaultThinkingLevel)} is not a thinking effort or "auto".`,
		};
	}
	return {
		ok: true,
		preset: { version: 1, roles, fallbackChains, cycleOrder: [...rawCycleOrder], defaultThinkingLevel },
	};
}

/** Capture the current EFFECTIVE routing configuration as a {@link ModelPresetV1}. */
export function captureModelPreset(settings: Settings): ModelPresetV1 {
	const fallbackChains: Record<string, string[]> = {};
	for (const [key, chain] of Object.entries(settings.get("retry.fallbackChains"))) {
		if (!Array.isArray(chain)) continue;
		fallbackChains[key] = chain.filter((entry): entry is string => typeof entry === "string");
	}
	const roles: Record<string, string> = {};
	for (const [role, value] of Object.entries(settings.getModelRoles())) {
		if (value !== undefined) roles[role] = value;
	}
	return {
		version: 1,
		roles,
		fallbackChains,
		cycleOrder: [...settings.get("cycleOrder")],
		defaultThinkingLevel: settings.get("defaultThinkingLevel"),
	};
}

/** Sort object entries by key for a stable canonical form. */
function sortedByKey<T>(record: Record<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
		out[key] = record[key];
	}
	return out;
}

/** Deterministic JSON string for a preset, for equality comparison. */
export function canonicalizeModelPreset(preset: ModelPresetV1): string {
	return JSON.stringify({
		version: preset.version,
		roles: sortedByKey(preset.roles),
		fallbackChains: sortedByKey(preset.fallbackChains),
		cycleOrder: preset.cycleOrder,
		defaultThinkingLevel: preset.defaultThinkingLevel,
	});
}

/**
 * Whether the stored preset `raw` matches the current effective configuration.
 * Malformed presets never match.
 */
export function presetMatchesCurrent(settings: Settings, raw: unknown): boolean {
	const parsed = parseModelPreset(raw);
	if (!parsed.ok) return false;
	return canonicalizeModelPreset(parsed.preset) === canonicalizeModelPreset(captureModelPreset(settings));
}

/**
 * Strict, side-effect-free precondition check for {@link applyModelPresetTransaction}.
 * Every configured role must resolve to an available model with configured
 * credentials; otherwise the preset is rejected before any mutation. `@role`
 * aliases resolve against the preset's OWN role map, never against the
 * current settings the preset is about to replace.
 */
export function validateModelPreset(
	preset: ModelPresetV1,
	availableModels: Model[],
	deps: { settings: Settings; registry: ModelRegistry },
): { ok: true } | { ok: false; error: string } {
	const roleLookup: ModelRoleLookup = { getModelRole: role => preset.roles[role] };
	for (const [role, value] of Object.entries(preset.roles)) {
		if (typeof value !== "string" || value.length === 0) continue;
		const resolved = resolveModelRoleValue(value, availableModels, { settings: deps.settings, roleLookup });
		if (!resolved.model) {
			return { ok: false, error: `Preset role "${role}" has no available model for "${value}".` };
		}
		if (!deps.registry.hasConfiguredAuth(resolved.model)) {
			return {
				ok: false,
				error: `Preset role "${role}" model ${resolved.model.provider}/${resolved.model.id} has no configured credentials.`,
			};
		}
	}
	return { ok: true };
}

/** Minimal live-session state captured before a preset apply, restored on rollback. */
export interface PresetSessionState {
	/** Active model at capture (undefined when none was selected yet). */
	model: Model | undefined;
	/** Configured thinking selector at capture — a concrete level or the `auto` sentinel. */
	thinkingLevel: ConfiguredThinkingLevel | undefined;
}

/**
 * Everything {@link applyModelPresetTransaction} needs. The live-switch hooks
 * are controller-provided so the transaction never touches UI directly.
 */
export interface PresetTransactionDeps {
	settings: Settings;
	registry: ModelRegistry;
	availableModels: Model[];
	/** Switch the live session to `model`, the preset's resolved `default` role. */
	switchModel(
		model: Model,
		opts: { effectiveIsAuto: boolean; concreteThinking: ThinkingLevel | undefined },
	): Promise<{ switched: boolean }>;
	/** Apply the preset's thinking level when the preset carries no `default` role. */
	applyThinking(level: DefaultThinkingLevel): void;
	getSessionState(): PresetSessionState;
	/** Best-effort live-session restore after a rollback; its own failures are swallowed. */
	restoreSessionState(state: PresetSessionState): Promise<void>;
}

/**
 * Apply a preset as a validated, atomic, session-scoped routing transaction:
 * parse → validate → snapshot → commit runtime overrides → live model switch.
 * A failure before the commit mutates nothing; a rejected live switch or a
 * throw at/after the commit rolls the runtime-override layer back, then
 * attempts to restore the prior live model and thinking level on a best-effort
 * basis. Provider and session side effects are not generally reversible. All
 * writes target the runtime-override layer only — nothing is persisted to
 * project or global settings.
 */
export async function applyModelPresetTransaction(
	raw: unknown,
	deps: PresetTransactionDeps,
): Promise<PresetApplyResult> {
	const parsed = parseModelPreset(raw);
	if (!parsed.ok) return { applied: false, error: parsed.error };
	const preset = parsed.preset;

	const validation = validateModelPreset(preset, deps.availableModels, {
		settings: deps.settings,
		registry: deps.registry,
	});
	if (!validation.ok) return { applied: false, error: validation.error };

	// Resolve the live default BEFORE mutating so a bad resolve never leaves a
	// half-applied plan. Validation guarantees this resolves + is authed.
	let liveSwitch: { model: Model; effectiveIsAuto: boolean; concreteThinking: ThinkingLevel | undefined } | undefined;
	if (preset.roles.default) {
		// `@role` aliases resolve against the preset's own role map, as in validation.
		const resolved = resolveModelRoleValue(preset.roles.default, deps.availableModels, {
			settings: deps.settings,
			roleLookup: { getModelRole: role => preset.roles[role] },
		});
		if (resolved.model) {
			const isAuto = resolved.thinkingLevel === AUTO_THINKING;
			let concreteThinking = concreteThinkingLevel(resolved.thinkingLevel);
			let isAutoFromDefault = false;
			if (!resolved.explicitThinkingLevel && !concreteThinking) {
				if (preset.defaultThinkingLevel === AUTO_THINKING) isAutoFromDefault = true;
				else concreteThinking = concreteThinkingLevel(preset.defaultThinkingLevel);
			}
			liveSwitch = { model: resolved.model, effectiveIsAuto: isAuto || isAutoFromDefault, concreteThinking };
		}
	}

	const settingsSnapshot = deps.settings.snapshotRuntimeRoutingState();
	const sessionSnapshot = deps.getSessionState();
	const rollback = async (): Promise<void> => {
		deps.settings.restoreRuntimeRoutingState(settingsSnapshot);
		try {
			await deps.restoreSessionState(sessionSnapshot);
		} catch {
			// Best-effort: a failed live-session restore must not mask the apply error.
		}
	};

	try {
		deps.settings.applyRuntimeRoutingPlan({
			roles: preset.roles,
			clearRoles: new Set([...getKnownRoleIds(deps.settings), ...deps.settings.getAllModelRoleKeys()]),
			fallbackChains: structuredClone(preset.fallbackChains),
			cycleOrder: [...preset.cycleOrder],
			defaultThinkingLevel: preset.defaultThinkingLevel,
		});
		if (liveSwitch) {
			const { switched } = await deps.switchModel(liveSwitch.model, {
				effectiveIsAuto: liveSwitch.effectiveIsAuto,
				concreteThinking: liveSwitch.concreteThinking,
			});
			if (!switched) {
				await rollback();
				return {
					applied: false,
					error: `Switching to ${liveSwitch.model.provider}/${liveSwitch.model.id} was rejected; preset changes were rolled back.`,
				};
			}
		} else {
			// Thinking-only preset: no default role to switch to, but the live
			// session must still pick up the preset's thinking level.
			deps.applyThinking(preset.defaultThinkingLevel);
		}
	} catch (error) {
		await rollback();
		return { applied: false, error: error instanceof Error ? error.message : String(error) };
	}
	return { applied: true };
}
