/**
 * Model presets: named snapshots of the routing configuration — `modelRoles`,
 * `retry.fallbackChains`, `cycleOrder`, and `defaultThinkingLevel` — saved whole
 * and re-applied as a whole.
 *
 * Definitions persist to the global config (`modelPresets.<name>`, one entry per
 * save); project and `--config` layers may also define presets, which are listed
 * and applied but never copied into the global file. Applying a preset is a
 * validated, atomic, session-scoped routing transaction performed entirely on
 * the runtime-override layer — it is never persisted, never shadowed by a lower
 * layer, and rolled back in full when the post-commit live model switch fails.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import type { ModelRoleLookup } from "@oh-my-pi/pi-tui/overlays/model-browser";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
} from "@oh-my-pi/pi-tui/thinking";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { cfgDefaultThinkingLevel, cfgRetryFallbackChains } from "../session/settings";
import type { ModelRegistry } from "./model-registry";
import { resolveModelRoleValue } from "./model-resolver";
import { getKnownRoleIds } from "./model-roles";
import { cfgCycleOrder, cfgModelPresets, type DefaultThinkingLevel, type ModelPresetV1 } from "./model-settings";
import { modelRoleValueFromUnknown, type Settings, type SettingProvenance } from "./settings";

/** Preset names: a letter, then letters, digits, spaces, `-` or `_`. */
const PRESET_NAME_PATTERN = /^[a-zA-Z][\w -]*$/;

export function isValidModelPresetName(name: string): boolean {
	return PRESET_NAME_PATTERN.test(name);
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

export type PresetLookup =
	| { kind: "found"; preset: ModelPresetV1 }
	| { kind: "missing" }
	| { kind: "invalid"; reason: string };

/** Look a preset up whole from the highest layer owning its name — same-name entries never merge. */
export function getModelPreset(settings: Settings, name: string): PresetLookup {
	const owned = settings.getOwnedModelPreset(name);
	if (!owned) return { kind: "missing" };
	const parsed = parseModelPreset(owned.entry);
	return parsed.ok ? { kind: "found", preset: parsed.preset } : { kind: "invalid", reason: parsed.error };
}

/** Saved preset names, sorted; names a `--config`/runtime `null` tombstone hides are left out. */
export function getModelPresetNames(settings: Settings): string[] {
	return Object.keys(cfgModelPresets.get(settings))
		.filter(name => settings.getOwnedModelPreset(name) !== undefined)
		.sort((a, b) => a.localeCompare(b));
}

/** Capture the current EFFECTIVE routing configuration as a {@link ModelPresetV1}. */
export function captureModelPreset(settings: Settings): ModelPresetV1 {
	const fallbackChains: Record<string, string[]> = {};
	for (const [key, chain] of Object.entries(cfgRetryFallbackChains.get(settings))) {
		if (!Array.isArray(chain)) continue;
		fallbackChains[key] = chain.filter((entry): entry is string => typeof entry === "string");
	}
	const roles: Record<string, string> = {};
	for (const [role, value] of Object.entries(settings.getModelRoles())) {
		if (value) roles[role] = value;
	}
	return {
		version: 1,
		roles,
		fallbackChains,
		cycleOrder: [...cfgCycleOrder.get(settings)],
		defaultThinkingLevel: cfgDefaultThinkingLevel.get(settings),
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
 * First saved preset (by name) whose captured configuration equals the current
 * effective one — roles, chains, cycle order, and default thinking level. It
 * marks equality, not an "active" state: presets are never persisted as active.
 */
export function findActiveModelPreset(settings: Settings): string | undefined {
	const current = canonicalizeModelPreset(captureModelPreset(settings));
	return getModelPresetNames(settings).find(name => {
		const lookup = getModelPreset(settings, name);
		return lookup.kind === "found" && canonicalizeModelPreset(lookup.preset) === current;
	});
}

/** One-line row summary of a saved preset: its default selector, its role count, or why it is malformed. */
export function describeModelPreset(settings: Settings, name: string): string {
	const lookup = getModelPreset(settings, name);
	if (lookup.kind === "missing") return "missing";
	if (lookup.kind === "invalid") return `malformed: ${lookup.reason}`;
	const { roles } = lookup.preset;
	if (typeof roles.default === "string") return `default → ${roles.default}`;
	const count = Object.keys(roles).length;
	return `${count} role${count === 1 ? "" : "s"}`;
}

/**
 * Save the current effective routing configuration as `name` in the global
 * config, overwriting a preset of the same name. Only this entry is written, so
 * presets defined by a project config are never copied globally.
 *
 * @throws Error when `name` is not a valid preset name.
 */
export function saveModelPreset(settings: Settings, name: string): ModelPresetV1 {
	if (!isValidModelPresetName(name)) {
		throw new Error(`Invalid preset name "${name}": use a letter, then letters, digits, space, - or _`);
	}
	const preset = captureModelPreset(settings);
	cfgModelPresets.setEntry(settings, name, preset);
	return preset;
}

export type ModelPresetDeleteResult = "deleted" | "missing" | "project";

/**
 * Delete `name` from the global config. A preset only a project (or `--config`)
 * file defines is reported as `project`: it has to be removed from that file.
 * The same applies when another layer defines the same name: the global entry is
 * removed but the preset keeps listing, so `project` is reported instead of a
 * false `deleted`.
 */
export function deleteModelPreset(settings: Settings, name: string): ModelPresetDeleteResult {
	const global = settings.getGlobalSettings().modelPresets;
	if (isRecord(global) && Object.hasOwn(global, name)) {
		cfgModelPresets.setEntry(settings, name, undefined);
		return settings.getOwnedModelPreset(name) ? "project" : "deleted";
	}
	return settings.getOwnedModelPreset(name) ? "project" : "missing";
}

/**
 * Layer above global config that still defines preset `name`, if any — so a
 * global save can warn that the just-saved entry is shadowed and won't apply.
 */
export function modelPresetShadowOwner(
	settings: Settings,
	name: string,
): "runtime" | "overlay" | "project" | undefined {
	const owned = settings.getOwnedModelPreset(name);
	return owned && owned.source !== "global" ? owned.source : undefined;
}

const SOURCE_LABELS: Record<SettingProvenance, string> = {
	env: "environment",
	runtime: "command line",
	overlay: "--config file",
	project: "project config",
	global: "global config",
	default: "default",
};

/** Status line after saving `name`, naming the higher layer whose same-name preset still wins, if any. */
export function modelPresetSavedMessage(settings: Settings, name: string): string {
	const owner = modelPresetShadowOwner(settings, name);
	if (owner === undefined) return `Saved model preset "${name}"`;
	return `Saved model preset "${name}" to the global config, but the ${SOURCE_LABELS[owner]} still defines a preset of the same name, which takes precedence`;
}

/** Serialize default-role mutations with the model hub's assign/unassign paths. */
let modelRoleMutationTail: Promise<void> = Promise.resolve();
export async function acquireModelRoleMutation(): Promise<() => void> {
	const previous = modelRoleMutationTail;
	const { promise, resolve } = Promise.withResolvers<void>();
	modelRoleMutationTail = previous.then(() => promise);
	await previous;
	return resolve;
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
 * are host-provided so the transaction never touches UI directly.
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

/** Outcome of an attempted preset application. */
export type PresetApplyResult =
	| {
			applied: true;
			/** The live `default` model after the switch; absent for a preset without a `default` role. */
			model?: Model;
			/** The configured thinking selector the session ended up with. */
			thinkingLevel?: ConfiguredThinkingLevel;
	  }
	| { applied: false; error: string };

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
			return {
				applied: true,
				model: liveSwitch.model,
				thinkingLevel: liveSwitch.effectiveIsAuto ? AUTO_THINKING : liveSwitch.concreteThinking,
			};
		}
		// Thinking-only preset: no default role to switch to, but the live
		// session must still pick up the preset's thinking level.
		deps.applyThinking(preset.defaultThinkingLevel);
		return { applied: true, thinkingLevel: preset.defaultThinkingLevel };
	} catch (error) {
		await rollback();
		return { applied: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export type ModelPresetSession = Pick<
	AgentSession,
	| "setModel"
	| "setThinkingLevel"
	| "configuredThinkingLevel"
	| "model"
	| "getAvailableModels"
	| "scopedModels"
	| "modelRegistry"
>;

/** The live-session hooks of {@link PresetTransactionDeps} over an agent session (no UI side effects). */
function sessionTransactionDeps(settings: Settings, session: ModelPresetSession): PresetTransactionDeps {
	const scopedModels = session.scopedModels.map(scoped => scoped.model);
	return {
		settings,
		registry: session.modelRegistry,
		availableModels: scopedModels.length > 0 ? scopedModels : session.getAvailableModels(),
		switchModel: async (model, { effectiveIsAuto, concreteThinking }) => {
			const { switched } = await session.setModel(model, "default", {
				persist: false,
				thinkingLevel: effectiveIsAuto ? ThinkingLevel.Inherit : (concreteThinking ?? ThinkingLevel.Inherit),
			});
			if (switched) {
				if (effectiveIsAuto) {
					session.setThinkingLevel(AUTO_THINKING);
				} else if (concreteThinking && concreteThinking !== ThinkingLevel.Inherit) {
					session.setThinkingLevel(concreteThinking);
				}
			}
			return { switched };
		},
		applyThinking: level => session.setThinkingLevel(level),
		getSessionState: () => ({ model: session.model, thinkingLevel: session.configuredThinkingLevel() }),
		restoreSessionState: async state => {
			if (state.model) {
				await session.setModel(state.model, "default", {
					persist: false,
					thinkingLevel:
						state.thinkingLevel === AUTO_THINKING
							? ThinkingLevel.Inherit
							: (state.thinkingLevel ?? ThinkingLevel.Inherit),
				});
			}
			if (state.thinkingLevel === AUTO_THINKING) {
				session.setThinkingLevel(AUTO_THINKING);
			} else if (state.thinkingLevel === undefined) {
				session.setThinkingLevel(undefined);
			} else if (state.thinkingLevel !== ThinkingLevel.Inherit) {
				session.setThinkingLevel(state.thinkingLevel);
			}
		},
	};
}

/**
 * Apply the saved preset `name` to `session`: the ONE apply path shared by
 * `/modelpreset switch`, the hub's Presets view, and the Roles-view preset
 * switching. Looks the preset up whole from the highest layer owning its name,
 * then runs {@link applyModelPresetTransaction} under the default-role mutation
 * lock so hub assignments cannot interleave with the switch and its rollback.
 */
export async function applyModelPreset(
	settings: Settings,
	session: ModelPresetSession,
	name: string,
): Promise<PresetApplyResult> {
	const owned = settings.getOwnedModelPreset(name);
	if (!owned) return { applied: false, error: `Preset not found: ${name}` };
	const release = await acquireModelRoleMutation();
	try {
		return await applyModelPresetTransaction(owned.entry, sessionTransactionDeps(settings, session));
	} finally {
		release();
	}
}

/** Short summary of an apply outcome for status lines and command output. */
export function formatModelPresetSwitch(name: string, result: PresetApplyResult): string {
	if (!result.applied) return `Preset "${name}" not applied: ${result.error}`;
	const thinking = result.thinkingLevel ? ` · ${result.thinkingLevel}` : "";
	const model = result.model
		? ` (${result.model.provider}/${result.model.id}${thinking})`
		: thinking
			? ` (${result.thinkingLevel})`
			: "";
	return `Switched to preset "${name}"${model}`;
}
