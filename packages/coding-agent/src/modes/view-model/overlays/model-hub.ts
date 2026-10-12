import type { KeysApi, Model } from "@oh-my-pi/pi-ai";
import { type ConfiguredThinkingLevel } from "../../../utils/render-utils";
import type { ModelBrowserRegistry, ModelBrowserSource } from "./model-browser";

/** Live preferences and selector operations the /models hub reads. */
export interface ModelHubSource extends ModelBrowserSource {
	readonly disabledProviders: readonly string[];
	readonly fallbackChains: Record<string, string[]>;
	readonly modelRoleStorage: "global" | "project";
	readonly cycleOrder: readonly string[];
	getProjectModelRole(role: string): string | undefined;
	getGlobalModelRole(role: string): string | undefined;
	getModelRoleSource(role: string): "global" | "project" | "default";
	/** Saved model presets, the one the current routing matches, and a row summary each; absent hosts have none. */
	getModelPresets?(): ModelPresetListing;
}

/** Catalog capabilities the /models hub needs. */
export interface ModelHubRegistry extends ModelBrowserRegistry {
	readonly authStorage: { readonly keys: Pick<KeysApi, "source"> };
	getDiscoverableProviders(): string[];
	getProviderDiscoveryState(provider: string):
		| {
				optional: boolean;
				status: "idle" | "ok" | "empty" | "cached" | "unavailable" | "unauthenticated";
				fetchedAt?: number;
				error?: string;
		  }
		| undefined;
	find(provider: string, id: string): Model | undefined;
	refreshIfStale(): Promise<boolean>;
	refreshProvider(
		provider: string,
		strategy: "online",
		options?: { refreshCommandCredentials?: boolean },
	): Promise<void>;
}

/** A `--models` scope entry (mirrors the session's scoped model list). */
export interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}

export type ModelRoleSelectionScope = "global" | "project";

/** Outcome of {@link ModelHubCallbacks.onApplyPreset}; the host has already reported it. */
export interface ModelPresetApplyResult {
	applied: boolean;
	error?: string;
}

export interface ModelPresetListing {
	/** Sorted saved preset names. */
	names: readonly string[];
	/** The preset whose captured routing equals the current effective routing, if any ("matches current"). */
	active: string | undefined;
	/** One-line row summary per name, e.g. `default → anthropic/claude-x`, `3 roles`, or `malformed: …`. */
	summaries: Readonly<Record<string, string>>;
}

export interface ModelHubCallbacks {
	/** Persist a role assignment. */
	onAssign: (
		model: Model,
		role: string,
		thinkingLevel: ConfiguredThinkingLevel | undefined,
		selector: string,
		scope?: ModelRoleSelectionScope,
	) => void | boolean | Promise<void | boolean>;
	/** Clear a configured role back to auto-selection. */
	onUnassign: (role: string, scope?: ModelRoleSelectionScope) => void;
	/** Persist a `retry.fallbackChains` entry — keyed by a role, `provider/model-id`, or `provider/*`; an empty chain clears the key. */
	onFallbackChainChange?: (role: string, chain: string[]) => void;
	/** Locked provider activation: forward to the /login flow. */
	onLoginRequest?: (providerId: string) => void;
	/** Returns the rebuilt `--models` scope for the hub to list; `undefined` keeps the current one. */
	onCatalogRefreshed?: (
		providerId?: string,
	) => ReadonlyArray<ScopedModelItem> | undefined | Promise<ReadonlyArray<ScopedModelItem> | undefined>;
	/**
	 * Apply saved preset `name` through the host's validated transaction (the Presets view, and
	 * ctrl+←/→ or p/⇧P in the Roles view). The host reports the outcome (status/error) itself; the
	 * hub freezes its input until the result settles.
	 */
	onApplyPreset?: (name: string) => Promise<ModelPresetApplyResult> | ModelPresetApplyResult;
	/** Capture and persist the current routing under `name` (host validates/reports). */
	onSavePreset?: (name: string) => void;
	/** Delete the global definition named `name` (host reports). */
	onDeletePreset?: (name: string) => void;
	/** Persist a new quick-switch cycle order (the ctrl+p role cycle). */
	onCycleOrderChange?: (order: string[]) => void;
	/**
	 * Persist typed text as `model`'s own compaction limit: a token base the
	 * policy scales (`400k`), a fixed trigger (`f400k`), a percentage (`80%`), or
	 * empty to reset. Rejected input returns `{ kind: "error" }`; input that
	 * needs acknowledgement (one that opens the extended window) returns
	 * `{ kind: "confirm" }` until called again with the same text and
	 * `confirmed`. Either keeps the field open.
	 */
	onCompactionPointChange?: (
		model: Model,
		input: string,
		confirmed: boolean,
	) => CompactionPointChangeResult | undefined;
	/**
	 * One short line on where `model` would compact with the typed limit
	 * (`compacts at 340K · 85% of 400K base`), shown beside the field while
	 * typing; undefined for input that does not parse or fit.
	 */
	previewCompactionPoint?: (model: Model, input: string) => string | undefined;
	onCancel: () => void;
}

/** Why {@link ModelHubCallbacks.onCompactionPointChange} kept the field open. */
export type CompactionPointChangeResult = { kind: "error"; message: string } | { kind: "confirm"; message: string };

export interface ModelHubOptions {
	/** Preselect this provider's sidebar entry (e.g. when reopening after /login). */
	initialProviderId?: string;
	/** `provider/id` of the session's model, marked current in the native picker. */
	currentSelector?: string;
}
