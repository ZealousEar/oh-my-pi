import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	acquireModelRoleMutation,
	applyModelPreset,
	applyModelPresetTransaction,
	canonicalizeModelPreset,
	captureModelPreset,
	deleteModelPreset,
	findActiveModelPreset,
	formatModelPresetSwitch,
	getModelPreset,
	getModelPresetNames,
	modelPresetSavedMessage,
	modelPresetShadowOwner,
	parseModelPreset,
	type PresetSessionState,
	type PresetTransactionDeps,
	presetMatchesCurrent,
	saveModelPreset,
	validateModelPreset,
} from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	cfgCycleOrder,
	cfgModelPresets,
	cfgModelRoles,
	type DefaultThinkingLevel,
	type ModelPresetV1,
} from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { type RuntimeRoutingPlan, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	cfgDefaultThinkingLevel,
	cfgRetryFallbackChains,
	cfgRetryModelFallback,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function makeModel(provider: string, id: string, contextWindow = 128_000): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 1024,
	});
}

/** Coerce a raw enum string into the `defaultThinkingLevel` setting value type. */
const tl = (value: string): DefaultThinkingLevel => value as DefaultThinkingLevel;

/** Build a complete, strictly-parseable {@link ModelPresetV1} from partial fields. */
function preset(overrides: Partial<ModelPresetV1> = {}): ModelPresetV1 {
	return {
		version: 1,
		roles: {},
		fallbackChains: {},
		cycleOrder: [],
		defaultThinkingLevel: tl("high"),
		...overrides,
	};
}

/** Build a complete {@link RuntimeRoutingPlan} from partial fields. */
function plan(overrides: Partial<RuntimeRoutingPlan> = {}): RuntimeRoutingPlan {
	return {
		roles: {},
		clearRoles: [],
		fallbackChains: {},
		cycleOrder: [],
		defaultThinkingLevel: tl("high"),
		...overrides,
	};
}

/** Stub registry whose auth answer is driven by a set of authorized model ids. */
function stubRegistry(authed: Set<string>): ModelRegistry {
	return { hasConfiguredAuth: (m: Model) => authed.has(m.id) } as unknown as ModelRegistry;
}

/** Fully-mocked {@link PresetTransactionDeps} over `settings`; every model in `models` is available and authed. */
function makeDeps(settings: Settings, models: Model[], overrides: Partial<PresetTransactionDeps> = {}) {
	const sessionState: PresetSessionState = { model: undefined, thinkingLevel: undefined };
	const switchModel = vi.fn<PresetTransactionDeps["switchModel"]>(async () => ({ switched: true }));
	const applyThinking = vi.fn<PresetTransactionDeps["applyThinking"]>(() => {});
	const getSessionState = vi.fn<PresetTransactionDeps["getSessionState"]>(() => sessionState);
	const restoreSessionState = vi.fn<PresetTransactionDeps["restoreSessionState"]>(async () => {});
	const deps: PresetTransactionDeps = {
		settings,
		registry: stubRegistry(new Set(models.map(m => m.id))),
		availableModels: models,
		switchModel,
		applyThinking,
		getSessionState,
		restoreSessionState,
		...overrides,
	};
	return { deps, switchModel, applyThinking, getSessionState, restoreSessionState, sessionState };
}

/** The owner's config.yml `modelPresets` block, verbatim (keys and shapes). */
const OWNER_PRESET_BLOCK = YAML.parse(`
Rust:
  version: 1
  roles:
    default: anthropic/claude-fable-5-1:high
    slow: openai-codex/gpt-6-astra:xhigh
    plan: openai-codex/gpt-6-astra:high
    researcher: openai-codex/gpt-6-astra:max
    reviewer: anthropic/claude-opus-5:high
    task: anthropic/claude-fable-5-1:medium
    advisor: openai-codex/gpt-6-astra:high
    smol: openai-codex/gpt-5.6-terra:medium
    tiny: openai-codex/gpt-5.6-luna:medium
    commit: openai-codex/gpt-5.6-terra:low
    vision: openai-codex/gpt-6-astra:medium
  fallbackChains:
    default:
      - openai-codex/gpt-6-astra
    slow:
      - anthropic/claude-fable-5-1
    researcher:
      - anthropic/claude-fable-5-1
    reviewer:
      - openai-codex/gpt-6-astra
    smol:
      - openai-codex/gpt-5.6-luna
  cycleOrder:
    - smol
    - default
    - slow
    - researcher
  defaultThinkingLevel: high
Codex Only:
  version: 1
  roles:
    default: openai-codex/gpt-6-astra:high
    smol: openai-codex/gpt-5.6-terra:medium
  fallbackChains: {}
  cycleOrder:
    - smol
    - default
  defaultThinkingLevel: medium
`) as Record<string, unknown>;

describe("model-presets", () => {
	describe("routing transactions against layered Settings", () => {
		let settingsState: SettingsTestState | undefined;
		let tempDir: TempDir;
		let agentDir: string;
		let projectDir: string;

		beforeEach(() => {
			settingsState = beginSettingsTest();
			tempDir = TempDir.createSync("@pi-model-presets-test-");
			agentDir = tempDir.join("agent");
			projectDir = tempDir.join("project");
			fs.mkdirSync(agentDir, { recursive: true });
			fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		});

		afterEach(async () => {
			restoreSettingsTestState(settingsState);
			settingsState = undefined;
			await tempDir?.remove();
		});

		const writeGlobal = async (config: Record<string, unknown>) => {
			await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(config, null, 2));
		};
		const load = () => Settings.loadReadOnly({ cwd: projectDir, agentDir });

		test("the owner's config.yml modelPresets block loads, parses, and applies to every listed role", async () => {
			await writeGlobal({
				modelRoles: { default: "anthropic/claude-fable-5-1", stale: "test/stale" },
				modelPresets: OWNER_PRESET_BLOCK,
			});
			const settings = await load();
			expect(getModelPresetNames(settings)).toEqual(["Codex Only", "Rust"]);
			const stored = cfgModelPresets.get(settings).Rust;
			const parsed = parseModelPreset(stored);
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;
			expect(Object.keys(parsed.preset.roles)).toHaveLength(11);
			expect(parsed.preset.cycleOrder).toEqual(["smol", "default", "slow", "researcher"]);

			const models = [
				makeModel("anthropic", "claude-fable-5-1"),
				makeModel("anthropic", "claude-opus-5"),
				makeModel("openai-codex", "gpt-6-astra"),
				makeModel("openai-codex", "gpt-5.6-terra"),
				makeModel("openai-codex", "gpt-5.6-luna"),
			];
			const harness = makeDeps(settings, models);
			const result = await applyModelPresetTransaction(stored, harness.deps);
			expect(result.applied).toBe(true);
			for (const [role, selector] of Object.entries(parsed.preset.roles)) {
				expect(settings.getModelRole(role)).toBe(selector);
			}
			// A global role the preset does not list is tombstoned, not inherited.
			expect(settings.getModelRole("stale")).toBeUndefined();
			expect(cfgRetryFallbackChains.get(settings)).toEqual(parsed.preset.fallbackChains);
			expect(cfgCycleOrder.get(settings)).toEqual(parsed.preset.cycleOrder);
			expect(cfgDefaultThinkingLevel.get(settings)).toBe(ThinkingLevel.High);
			expect(harness.switchModel.mock.calls[0]?.[0]?.id).toBe("claude-fable-5-1");
			expect(harness.switchModel.mock.calls[0]?.[1]).toEqual({
				effectiveIsAuto: false,
				concreteThinking: ThinkingLevel.High,
			});
			expect(presetMatchesCurrent(settings, stored)).toBe(true);
			expect(findActiveModelPreset(settings)).toBe("Rust");
			// Nothing was persisted: the global layer still holds the pre-apply roles.
			expect(settings.getGlobalModelRole("default")).toBe("anthropic/claude-fable-5-1");
			expect(settings.getGlobalModelRole("stale")).toBe("test/stale");
		});

		test("a runtime plan's fallbackChains replace lower-layer chains exactly, empty included", async () => {
			await writeGlobal({ retry: { fallbackChains: { slow: ["p/a"] } } });
			const settings = await load();
			// Load-time migrations derive extra chains (judge, converge-*); the global `slow` is what matters.
			expect(cfgRetryFallbackChains.get(settings)).toMatchObject({ slow: ["p/a"] });

			// Empty means "no chains" — the global `slow` chain must not survive the deep merge.
			settings.applyRuntimeRoutingPlan(plan({ fallbackChains: {} }));
			expect(cfgRetryFallbackChains.get(settings)).toEqual({});

			// A partial record is exact too: no resurrection of lower-layer keys.
			settings.applyRuntimeRoutingPlan(plan({ fallbackChains: { default: ["p/b"] } }));
			expect(cfgRetryFallbackChains.get(settings)).toEqual({ default: ["p/b"] });
		});

		test("preset A → preset B keeps the tombstone for a global custom role omitted by both", async () => {
			await writeGlobal({ modelRoles: { default: "test/model-a", reviewer: "test/model-r" } });
			const settings = await load();
			expect(settings.getModelRole("reviewer")).toBe("test/model-r");
			const models = [
				makeModel("test", "model-a"),
				makeModel("test", "model-b"),
				makeModel("test", "model-c"),
				makeModel("test", "model-r"),
			];

			const first = makeDeps(settings, models);
			expect(
				(await applyModelPresetTransaction(preset({ roles: { default: "test/model-b" } }), first.deps)).applied,
			).toBe(true);
			expect(settings.getModelRole("reviewer")).toBeUndefined();
			expect(settings.getModelRoleProvenance("reviewer")).toBe("runtime");

			const second = makeDeps(settings, models);
			expect(
				(await applyModelPresetTransaction(preset({ roles: { default: "test/model-c" } }), second.deps)).applied,
			).toBe(true);
			expect(settings.getModelRole("default")).toBe("test/model-c");
			// The runtime tombstone must be recreated by the second plan, not dropped.
			expect(settings.getModelRole("reviewer")).toBeUndefined();
		});

		test("setModelRole on another role leaves a preset's tombstone intact", async () => {
			await writeGlobal({ modelRoles: { default: "test/model-a", reviewer: "test/model-r" } });
			const settings = await load();
			const models = [makeModel("test", "model-a"), makeModel("test", "model-b")];

			const harness = makeDeps(settings, models);
			expect(
				(await applyModelPresetTransaction(preset({ roles: { default: "test/model-b" } }), harness.deps)).applied,
			).toBe(true);
			expect(settings.getModelRole("reviewer")).toBeUndefined();

			settings.setModelRole("smol", "test/model-x");

			expect(settings.getModelRole("smol")).toBe("test/model-x");
			// Editing an unrelated role must not resurrect the shadowed global reviewer.
			expect(settings.getModelRole("reviewer")).toBeUndefined();
		});

		test("exact preset roles hide later layer discoveries but accept later explicit edits", async () => {
			await writeGlobal({ modelRoles: { default: "test/model-a" } });
			const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			try {
				const harness = makeDeps(settings, [makeModel("test", "model-a"), makeModel("test", "model-b")]);
				expect(
					(await applyModelPresetTransaction(preset({ roles: { default: "test/model-b" } }), harness.deps))
						.applied,
				).toBe(true);

				await writeGlobal({
					modelRoles: { default: "test/model-a", "late-global": "test/from-reload" },
				});
				await settings.reloadFromDisk();
				expect(settings.getModelRole("default")).toBe("test/model-b");
				expect(settings.getModelRole("late-global")).toBeUndefined();

				const nextProject = tempDir.join("next-project");
				fs.mkdirSync(getProjectAgentDir(nextProject), { recursive: true });
				await Bun.write(
					path.join(getProjectAgentDir(nextProject), "config.yml"),
					YAML.stringify({ modelRoles: { "late-project": "test/from-project" } }, null, 2),
				);
				await settings.reloadForCwd(nextProject);
				expect(settings.getModelRole("late-project")).toBeUndefined();

				settings.setModelRole("late-global", "test/user-edit");
				expect(settings.getModelRole("late-global")).toBe("test/user-edit");
				expect(settings.getModelRole("late-project")).toBeUndefined();
				settings.setProjectModelRole("late-project", "test/user-project-edit");
				expect(settings.getModelRole("late-project")).toBe("test/user-project-edit");

				// A plain override deliberately leaves preset exact-replacement
				// semantics and retains the ordinary deep-merge contract.
				cfgModelRoles.override(settings, { runtime: "test/runtime" });
				expect(settings.getModelRole("runtime")).toBe("test/runtime");
				expect(settings.getModelRole("late-global")).toBe("test/user-edit");
				expect(settings.getModelRole("late-project")).toBe("test/user-project-edit");
				await settings.flush();
			} finally {
				settings.cancelPendingSaves();
			}
		});

		test("explicit chain and cycle edits update the running plan and persist as usual", async () => {
			await writeGlobal({ retry: { fallbackChains: { slow: ["p/a"] } }, cycleOrder: ["default"] });
			const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			try {
				settings.applyRuntimeRoutingPlan(plan({ fallbackChains: {}, cycleOrder: ["smol"] }));
				expect(cfgRetryFallbackChains.get(settings)).toEqual({});

				// The hub writes one chain entry at a time; the plan must pick it up without
				// resurrecting the global `slow` chain the preset cleared.
				cfgRetryFallbackChains.setEntry(settings, "default", ["p/b"]);
				expect(cfgRetryFallbackChains.get(settings)).toEqual({ default: ["p/b"] });
				cfgCycleOrder.set(settings, ["default", "smol"]);
				expect(cfgCycleOrder.get(settings)).toEqual(["default", "smol"]);
				await settings.flush();

				const saved = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as {
					retry: { fallbackChains: Record<string, string[]> };
					cycleOrder: string[];
				};
				expect(saved.retry.fallbackChains).toEqual({ slow: ["p/a"], default: ["p/b"] });
				expect(saved.cycleOrder).toEqual(["default", "smol"]);
			} finally {
				settings.cancelPendingSaves();
			}
		});

		test("cwd clones retain exact routing and explicit edits without changing the source session", async () => {
			await writeGlobal({
				modelRoles: { default: "test/model-a" },
				retry: { fallbackChains: { slow: ["test/model-a"] } },
			});
			const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			const nextProject = tempDir.join("clone-project");
			await Bun.write(
				path.join(getProjectAgentDir(nextProject), "config.yml"),
				YAML.stringify({ modelRoles: { discovered: "test/from-project" } }, null, 2),
			);
			settings.applyRuntimeRoutingPlan(plan({ roles: { default: "test/model-b" } }));
			const cloned = await settings.cloneForCwd(nextProject);
			try {
				expect(cfgRetryFallbackChains.get(cloned)).toEqual({});
				expect(cloned.getModelRole("discovered")).toBeUndefined();
				cfgCycleOrder.set(cloned, ["default"]);
				expect(cfgCycleOrder.get(cloned)).toEqual(["default"]);
				expect(cfgCycleOrder.get(settings)).toEqual([]);
			} finally {
				cloned.cancelPendingSaves();
				settings.cancelPendingSaves();
			}
		});

		test("a failed live switch rolls back all four routing paths and restores the session state", async () => {
			await writeGlobal({
				modelRoles: { default: "test/model-a", reviewer: "test/model-r" },
				retry: { fallbackChains: { slow: ["p/a"] } },
				cycleOrder: ["default", "smol"],
				defaultThinkingLevel: "medium",
			});
			const settings = await load();
			const models = [
				makeModel("test", "model-a"),
				makeModel("test", "model-b"),
				makeModel("test", "model-c"),
				makeModel("test", "model-r"),
			];

			// Establish a pre-apply state that already contains runtime tombstones.
			const setup = makeDeps(settings, models);
			const setupResult = await applyModelPresetTransaction(
				preset({
					roles: { default: "test/model-b" },
					fallbackChains: { default: ["p/b"] },
					cycleOrder: ["default"],
					defaultThinkingLevel: tl("high"),
				}),
				setup.deps,
			);
			expect(setupResult.applied).toBe(true);
			const before = {
				defaultRole: settings.getModelRole("default"),
				chains: structuredClone(cfgRetryFallbackChains.get(settings)),
				cycle: structuredClone(cfgCycleOrder.get(settings)),
				modelFallback: cfgRetryModelFallback.get(settings),
				thinking: cfgDefaultThinkingLevel.get(settings),
			};

			// Gate the session restore so we can prove the transaction AWAITS it:
			// the transaction promise must stay pending until we release the gate.
			const gate = Promise.withResolvers<void>();
			const restoreSessionState = vi.fn<PresetTransactionDeps["restoreSessionState"]>(() => gate.promise);
			const failing = makeDeps(settings, models, {
				switchModel: vi.fn<PresetTransactionDeps["switchModel"]>(async () => {
					throw new Error("switch failed");
				}),
				restoreSessionState,
			});
			const txPromise = applyModelPresetTransaction(
				preset({
					roles: { default: "test/model-c", reviewer: "test/model-r" },
					fallbackChains: { slow: ["p/z"] },
					cycleOrder: ["smol"],
					defaultThinkingLevel: tl("low"),
				}),
				failing.deps,
			);
			let txSettled = false;
			void txPromise.then(() => {
				txSettled = true;
			});
			// Drain microtasks (bounded, no wall clock) until the rollback reaches the restore hook.
			for (let i = 0; i < 50 && restoreSessionState.mock.calls.length === 0; i++) await Promise.resolve();
			expect(restoreSessionState).toHaveBeenCalledTimes(1);
			expect(restoreSessionState.mock.calls[0]?.[0]).toBe(failing.sessionState);
			await Promise.resolve();
			expect(txSettled).toBe(false); // still blocked on the un-released restore → it is awaited
			gate.resolve();
			const result = await txPromise;

			expect(result.applied).toBe(false);
			if (result.applied) return;
			expect(result.error).toBe("switch failed");
			expect(settings.getModelRole("default")).toBe(before.defaultRole);
			expect(settings.getModelRole("reviewer")).toBeUndefined(); // tombstone restored
			expect(cfgRetryFallbackChains.get(settings)).toEqual(before.chains);
			expect(cfgRetryModelFallback.get(settings)).toBe(before.modelFallback);
			expect(cfgCycleOrder.get(settings)).toEqual(before.cycle);
			expect(cfgDefaultThinkingLevel.get(settings)).toBe(before.thinking);
		});

		test("preset definitions persist per-key without clobbering external siblings", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			try {
				settings.setModelRole("default", "test/model-a");
				saveModelPreset(settings, "a");
				expect(getModelPreset(settings, "a")).toMatchObject({
					kind: "found",
					preset: { roles: { default: "test/model-a" } },
				});
				await settings.flush();

				// Simulate another process adding a sibling preset between our saves.
				const configPath = path.join(agentDir, "config.yml");
				const onDisk = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
				(onDisk.modelPresets as Record<string, unknown>).b = preset({ roles: { default: "test/model-b" } });
				await Bun.write(configPath, YAML.stringify(onDisk, null, 2));

				settings.setModelRole("default", "test/model-a2");
				saveModelPreset(settings, "a");
				await settings.flush();
				const afterUpdate = YAML.parse(await Bun.file(configPath).text()) as {
					modelPresets?: Record<string, ModelPresetV1>;
				};
				expect(afterUpdate.modelPresets?.a?.roles.default).toBe("test/model-a2");
				expect(afterUpdate.modelPresets?.b?.roles.default).toBe("test/model-b"); // sibling survived

				expect(deleteModelPreset(settings, "a")).toBe("deleted");
				await settings.flush();
				const afterDelete = YAML.parse(await Bun.file(configPath).text()) as {
					modelPresets?: Record<string, ModelPresetV1>;
				};
				expect(afterDelete.modelPresets?.a).toBeUndefined();
				expect(afterDelete.modelPresets?.b?.roles.default).toBe("test/model-b");
			} finally {
				settings.cancelPendingSaves();
			}
		});
	});

	describe("parseModelPreset", () => {
		test("rejects non-record input", () => {
			for (const raw of [null, undefined, 42, "preset", ["roles"]]) {
				expect(parseModelPreset(raw)).toEqual({ ok: false, error: "Preset is not an object." });
			}
		});

		test("rejects an unsupported or missing version, including the role-only legacy shape", () => {
			expect(parseModelPreset({ ...preset(), version: 2 })).toEqual({
				ok: false,
				error: "Unsupported preset version 2; expected 1.",
			});
			const { version: _version, ...missingVersion } = preset();
			expect(parseModelPreset(missingVersion)).toEqual({
				ok: false,
				error: "Unsupported preset version undefined; expected 1.",
			});
			// A `{ modelRoles }`-only entry cannot be coerced into a full routing snapshot.
			expect(parseModelPreset({ modelRoles: { default: "p/m" }, defaultThinkingLevel: "high" }).ok).toBe(false);
		});

		test("rejects a preset missing any required field", () => {
			for (const field of ["roles", "fallbackChains", "cycleOrder", "defaultThinkingLevel"] as const) {
				const raw: Record<string, unknown> = { ...preset() };
				delete raw[field];
				const parsed = parseModelPreset(raw);
				expect(parsed.ok).toBe(false);
				if (!parsed.ok) expect(parsed.error).toContain(field);
			}
		});

		test("rejects a thinking level outside the setting enum", () => {
			for (const level of ["inherit", "off", 7, null]) {
				expect(parseModelPreset({ ...preset(), defaultThinkingLevel: level })).toEqual({
					ok: false,
					error: `Preset "defaultThinkingLevel" ${JSON.stringify(level)} is not a thinking effort or "auto".`,
				});
			}
		});

		test("accepts a valid preset and normalizes array role values", () => {
			const parsed = parseModelPreset({ ...preset(), roles: { default: ["p/m1", "p/m2"] } });
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.preset.roles.default).toBe("p/m1,p/m2");
		});
	});

	describe("applyModelPresetTransaction", () => {
		test("role aliases resolve against the preset's own role map, not the current settings", async () => {
			const modelA = makeModel("test", "model-a");
			const modelB = makeModel("test", "model-b");
			const settings = Settings.isolated({ modelRoles: { slow: "test/model-a" } });
			const p = preset({ roles: { default: "@slow", slow: "test/model-b" } });

			const registry = stubRegistry(new Set(["model-a", "model-b"]));
			expect(validateModelPreset(p, [modelA, modelB], { settings, registry })).toEqual({ ok: true });

			const harness = makeDeps(settings, [modelA, modelB]);
			const result = await applyModelPresetTransaction(p, harness.deps);
			expect(result.applied).toBe(true);
			expect(harness.switchModel).toHaveBeenCalledTimes(1);
			// "@slow" must follow the preset's slow (model-b), not settings' slow (model-a).
			expect(harness.switchModel.mock.calls[0]?.[0]?.id).toBe("model-b");
		});

		test("unqualified preset selectors retain the configured provider-order policy", async () => {
			const catalogFirst = makeModel("catalog-first", "shared-model");
			const preferred = makeModel("preferred", "shared-model");
			const settings = Settings.isolated({ modelProviderOrder: ["preferred", "catalog-first"] });
			const harness = makeDeps(settings, [catalogFirst, preferred]);

			const result = await applyModelPresetTransaction(preset({ roles: { default: "shared-model" } }), harness.deps);

			expect(result.applied).toBe(true);
			expect(harness.switchModel).toHaveBeenCalledTimes(1);
			expect(harness.switchModel.mock.calls[0]?.[0]?.provider).toBe("preferred");
		});

		test("malformed input performs zero mutation and never touches the live session", async () => {
			const settings = Settings.isolated({
				modelRoles: { default: "test/model-a" },
				"retry.fallbackChains": { slow: ["p/a"] },
				cycleOrder: ["default"],
				defaultThinkingLevel: "medium",
			});
			const harness = makeDeps(settings, [makeModel("test", "model-a")]);

			for (const raw of [42, { ...preset(), version: 2 }, { ...preset(), defaultThinkingLevel: "inherit" }]) {
				const result = await applyModelPresetTransaction(raw, harness.deps);
				expect(result.applied).toBe(false);
				if (!result.applied) expect(result.error).toBeTruthy();
			}

			expect(harness.switchModel).not.toHaveBeenCalled();
			expect(harness.applyThinking).not.toHaveBeenCalled();
			expect(settings.getModelRole("default")).toBe("test/model-a");
			expect(cfgRetryModelFallback.get(settings)).toBe(true);
			expect(cfgRetryFallbackChains.get(settings)).toEqual({ slow: ["p/a"] });
			expect(cfgCycleOrder.get(settings)).toEqual(["default"]);
			expect(cfgDefaultThinkingLevel.get(settings)).toBe(ThinkingLevel.Medium);
		});

		test("a thinking-only preset applies thinking without a model switch", async () => {
			const settings = Settings.isolated({ defaultThinkingLevel: "high", "retry.modelFallback": false });
			const harness = makeDeps(settings, []);

			const result = await applyModelPresetTransaction(
				preset({ roles: {}, defaultThinkingLevel: tl("low") }),
				harness.deps,
			);

			expect(result.applied).toBe(true);
			expect(harness.switchModel).not.toHaveBeenCalled();
			expect(harness.applyThinking).toHaveBeenCalledTimes(1);
			expect(harness.applyThinking.mock.calls[0]?.[0]).toBe(tl("low"));
			expect(cfgDefaultThinkingLevel.get(settings)).toBe(ThinkingLevel.Low);
			expect(cfgRetryModelFallback.get(settings)).toBe(false);
		});
	});

	describe("observer atomicity", () => {
		test("modelRoles observers already see the plan's full routing state when notified", () => {
			const settings = Settings.isolated({});
			const seen: Array<{
				chains: Record<string, string[]>;
				modelFallback: boolean;
				cycle: string[];
				thinking: string;
				role: string | undefined;
			}> = [];
			const unsubscribe = settings.onEffectiveChange([cfgModelRoles], () => {
				seen.push({
					modelFallback: cfgRetryModelFallback.get(settings),
					chains: cfgRetryFallbackChains.get(settings),
					cycle: cfgCycleOrder.get(settings),
					thinking: cfgDefaultThinkingLevel.get(settings),
					role: settings.getModelRole("default"),
				});
			});
			try {
				settings.applyRuntimeRoutingPlan(
					plan({
						roles: { default: "test/model-b" },
						fallbackChains: { default: ["p/b"] },
						cycleOrder: ["default"],
						defaultThinkingLevel: tl("low"),
					}),
				);
			} finally {
				unsubscribe();
			}

			expect(seen.length).toBeGreaterThanOrEqual(1);
			for (const snapshot of seen) {
				// No intermediate state: every notification observes the complete plan.
				expect(snapshot.modelFallback).toBe(true);
				expect(snapshot.role).toBe("test/model-b");
				expect(snapshot.chains).toEqual({ default: ["p/b"] });
				expect(snapshot.cycle).toEqual(["default"]);
				expect(snapshot.thinking).toBe(tl("low"));
			}
		});
	});

	describe("capture / canonicalize / match", () => {
		test("captures array role values comma-joined, the thinking level, and stamps version 1", () => {
			const captured = captureModelPreset(
				Settings.isolated({ modelRoles: { default: ["p/m1", "p/m2"] }, defaultThinkingLevel: "medium" }),
			);
			expect(captured.version).toBe(1);
			expect(captured.roles.default).toBe("p/m1,p/m2");
			expect(captured.defaultThinkingLevel).toBe(ThinkingLevel.Medium);
		});

		test("canonicalize is order-insensitive over keys but value-sensitive", () => {
			const a = preset({ roles: { default: "test/a", smol: "test/b" } });
			const b = preset({ roles: { smol: "test/b", default: "test/a" } });
			expect(canonicalizeModelPreset(a)).toBe(canonicalizeModelPreset(b));

			const changed = preset({ roles: { default: "test/CHANGED", smol: "test/b" } });
			expect(canonicalizeModelPreset(changed)).not.toBe(canonicalizeModelPreset(a));
		});

		test("presetMatchesCurrent is false for malformed input and true for a capture round-trip", () => {
			const settings = Settings.isolated({ modelRoles: { default: "test/model-a" } });
			expect(presetMatchesCurrent(settings, 42)).toBe(false);
			expect(presetMatchesCurrent(settings, { roles: { default: "test/model-a" } })).toBe(false); // missing version
			expect(presetMatchesCurrent(settings, captureModelPreset(settings))).toBe(true);
		});

		test("the active preset is the one equal on all four fields, not just roles", () => {
			const settings = Settings.isolated({
				modelRoles: { default: "test/model-a" },
				"retry.fallbackChains": { default: ["test/model-b"] },
			});
			cfgModelPresets.setEntry(settings, "roles-only", preset({ roles: { default: "test/model-a" } }));
			expect(findActiveModelPreset(settings)).toBeUndefined();
			saveModelPreset(settings, "exact");
			expect(findActiveModelPreset(settings)).toBe("exact");
		});
	});

	describe("validateModelPreset", () => {
		test("rejects a role whose value matches no available model, naming the role", () => {
			const models = [makeModel("test", "model-a")];
			const settings = Settings.isolated({});
			const registry = stubRegistry(new Set(["model-a"]));

			expect(
				validateModelPreset(preset({ roles: { default: "test/nonexistent" } }), models, { settings, registry }),
			).toEqual({ ok: false, error: 'Preset role "default" has no available model for "test/nonexistent".' });
		});

		test("rejects a role whose model resolves but has no configured credentials", () => {
			const models = [makeModel("test", "model-a")];
			const settings = Settings.isolated({});
			const registry = stubRegistry(new Set()); // nothing authenticated

			expect(
				validateModelPreset(preset({ roles: { default: "test/model-a" } }), models, { settings, registry }),
			).toEqual({ ok: false, error: 'Preset role "default" model test/model-a has no configured credentials.' });
		});
	});
});

const SONNET = "anthropic/claude-sonnet-4-5";
const SONNET_46 = "anthropic/claude-sonnet-4-6";
const OPUS = "anthropic/claude-opus-4-5";

function bundled(selector: string) {
	const [, id] = selector.split("/");
	const model = getBundledModel("anthropic", id!);
	if (!model) throw new Error(`missing bundled model ${selector}`);
	return model;
}

/**
 * Ambient launcher state that would change what the tests observe: `Settings`
 * loads `PI_CONFIG_FILES`/`OMP_SHARED_SECRETS_FILE` overlays even in memory,
 * and any provider key in the environment counts as an authed model.
 */
function ambientEnvKeys(): string[] {
	return Object.keys(Bun.env).filter(
		key =>
			key === "PI_CONFIG_FILES" ||
			key === "OMP_SHARED_SECRETS_FILE" ||
			key.endsWith("_API_KEY") ||
			key.endsWith("_OAUTH_TOKEN"),
	);
}

describe("applyModelPreset over a live session", () => {
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];
	const tempDirs: TempDir[] = [];

	const savedEnv = new Map<string, string>();

	beforeAll(async () => {
		for (const key of ambientEnvKeys()) {
			savedEnv.set(key, Bun.env[key]!);
			delete Bun.env[key];
			delete process.env[key];
		}
		fixtureDir = TempDir.createSync("@pi-model-presets-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		for (const dir of tempDirs.splice(0)) dir.removeSync();
	});

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
		for (const [key, value] of savedEnv) {
			Bun.env[key] = value;
			process.env[key] = value;
		}
	});

	function createSession(settings: Settings, initialModel = SONNET, thinkingLevel: Effort = Effort.High) {
		const agent = new Agent({
			initialState: { model: bundled(initialModel), systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel },
		});
		const session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		sessions.push(session);
		return session;
	}

	/** Settings with a real project layer and an optional `--config` overlay. */
	async function projectSettings(options: { project?: string; overlay?: string }) {
		const dir = TempDir.createSync("@pi-model-presets-project-");
		tempDirs.push(dir);
		const projectDir = path.join(dir.path(), "project");
		fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
		if (options.project) fs.writeFileSync(path.join(projectDir, ".omp", "config.yml"), options.project);
		const configFiles: string[] = [];
		if (options.overlay) {
			const overlayPath = path.join(dir.path(), "overlay.yml");
			fs.writeFileSync(overlayPath, options.overlay);
			configFiles.push(overlayPath);
		}
		return Settings.loadIsolated({ cwd: projectDir, agentDir: dir.path(), inMemory: true, configFiles });
	}

	it("switching replaces the effective routing for the session and switches the live model and level, persisting nothing", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", OPUS);
		settings.setModelRole("plan", SONNET_46);
		cfgRetryFallbackChains.set(settings, { default: [SONNET] });
		cfgCycleOrder.set(settings, ["default", "plan"]);
		cfgDefaultThinkingLevel.set(settings, Effort.Low);
		saveModelPreset(settings, "focus");

		settings.setModelRole("default", SONNET);
		settings.setModelRole("plan", undefined);
		settings.setModelRole("smol", SONNET_46);
		cfgRetryFallbackChains.set(settings, {});
		cfgCycleOrder.set(settings, ["default"]);
		cfgDefaultThinkingLevel.set(settings, Effort.High);
		const session = createSession(settings, SONNET, Effort.High);

		const result = await applyModelPreset(settings, session, "focus");

		expect(result.applied).toBe(true);
		expect({ ...settings.getModelRoles() }).toEqual({ default: OPUS, plan: SONNET_46 });
		expect(cfgRetryFallbackChains.get(settings)).toEqual({ default: [SONNET] });
		expect(cfgCycleOrder.get(settings)).toEqual(["default", "plan"]);
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.Low);
		expect(session.model?.id).toBe("claude-opus-4-5");
		// setModel alone keeps the previous `high`; the preset's `low` must win.
		expect(session.thinkingLevel).toBe(Effort.Low);
		// Session-scoped: the global layer still holds the pre-switch setup.
		expect(settings.getGlobalModelRole("default")).toBe(SONNET);
		expect(settings.getGlobalModelRole("smol")).toBe(SONNET_46);
		expect(formatModelPresetSwitch("focus", result)).toBe(
			'Switched to preset "focus" (anthropic/claude-opus-4-5 · low)',
		);
	});

	it("an explicit selector level on the preset's default beats its defaultThinkingLevel", async () => {
		const settings = Settings.isolated();
		cfgModelPresets.setEntry(
			settings,
			"deep",
			preset({ roles: { default: `${OPUS}:medium` }, defaultThinkingLevel: tl("low") }),
		);
		const session = createSession(settings, SONNET, Effort.High);

		const result = await applyModelPreset(settings, session, "deep");

		expect(result.applied).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("beats a --config overlay role and a project role for the session instead of reporting them", async () => {
		const settings = await projectSettings({
			project: `modelRoles:\n  slow: ${SONNET_46}\n`,
			overlay: `modelRoles:\n  default: ${SONNET}\n`,
		});
		cfgModelPresets.setEntry(settings, "opus", preset({ roles: { default: OPUS } }));
		const session = createSession(settings, SONNET);

		const result = await applyModelPreset(settings, session, "opus");

		expect(result.applied).toBe(true);
		expect({ ...settings.getModelRoles() }).toEqual({ default: OPUS });
		expect(settings.getModelRoleProvenance("slow")).toBe("runtime");
		expect(session.model?.id).toBe("claude-opus-4-5");
		expect(settings.getGlobalModelRole("default")).toBeUndefined();
	});

	it("never resolves inherited object keys as presets", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", SONNET);
		const session = createSession(settings);

		for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
			expect(await applyModelPreset(settings, session, name)).toEqual({
				applied: false,
				error: `Preset not found: ${name}`,
			});
			expect(deleteModelPreset(settings, name)).toBe("missing");
		}
		expect(settings.getModelRole("default")).toBe(SONNET);
	});

	it("rejects a malformed hand-written preset without touching roles", async () => {
		const settings = await projectSettings({
			overlay: `modelPresets:\n  broken:\n    modelRoles: ${OPUS}\n`,
		});
		settings.setModelRole("default", SONNET);
		const session = createSession(settings);

		const result = await applyModelPreset(settings, session, "broken");

		expect(result.applied).toBe(false);
		expect(formatModelPresetSwitch("broken", result)).toBe(
			'Preset "broken" not applied: Unsupported preset version undefined; expected 1.',
		);
		expect(settings.getModelRole("default")).toBe(SONNET);
	});

	it("leaves settings and the session untouched when any preset role is unavailable", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", SONNET);
		cfgModelPresets.setEntry(
			settings,
			"gone",
			preset({ roles: { default: OPUS, reviewer: "nosuch/provider-model" } }),
		);
		const session = createSession(settings);

		const result = await applyModelPreset(settings, session, "gone");

		expect(result).toEqual({
			applied: false,
			error: 'Preset role "reviewer" has no available model for "nosuch/provider-model".',
		});
		expect(settings.getModelRole("default")).toBe(SONNET);
		expect(session.model?.id).toBe("claude-sonnet-4-5");
	});

	it("rolls the runtime routing back when the live switch throws", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", SONNET);
		cfgModelPresets.setEntry(settings, "opus", preset({ roles: { default: OPUS }, cycleOrder: ["default"] }));
		const session = createSession(settings);
		vi.spyOn(session, "setModel").mockRejectedValue(new Error("metadata refresh failed"));

		const result = await applyModelPreset(settings, session, "opus");

		expect(result).toEqual({ applied: false, error: "metadata refresh failed" });
		expect(settings.getModelRole("default")).toBe(SONNET);
		expect(cfgCycleOrder.get(settings)).toEqual(["smol", "default", "slow"]);
	});

	it("saves only the named entry globally and never copies project presets", async () => {
		const settings = await projectSettings({
			project: `modelPresets:\n  team:\n    version: 1\n    roles:\n      default: ${SONNET}\n    fallbackChains: {}\n    cycleOrder: []\n    defaultThinkingLevel: high\n`,
		});
		settings.setModelRole("default", OPUS);

		saveModelPreset(settings, "mine");

		expect(Object.keys(settings.getGlobalSettings().modelPresets ?? {})).toEqual(["mine"]);
		expect(getModelPresetNames(settings)).toEqual(["mine", "team"]);
		expect(deleteModelPreset(settings, "team")).toBe("project");
		expect(deleteModelPreset(settings, "mine")).toBe("deleted");
		expect(getModelPresetNames(settings)).toEqual(["team"]);
	});

	it('accepts names with spaces like the owner\'s "Codex Only" and rejects names not starting with a letter', () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", SONNET);
		saveModelPreset(settings, "Codex Only");
		expect(getModelPresetNames(settings)).toEqual(["Codex Only"]);
		expect(() => saveModelPreset(settings, "1bad")).toThrow(/Invalid preset name/);
	});

	it("resolves an alias default against the preset's own roles, not the current ones", async () => {
		// Current `slow` is broken but the preset redefines it: the switch must pass pre-validation.
		const settings = Settings.isolated();
		settings.setModelRole("default", SONNET);
		settings.setModelRole("slow", "nosuch/gone-model");
		cfgModelPresets.setEntry(settings, "alias", preset({ roles: { default: "@slow", slow: SONNET_46 } }));
		const session = createSession(settings);

		const result = await applyModelPreset(settings, session, "alias");

		expect(result.applied).toBe(true);
		expect(settings.getModelRole("slow")).toBe(SONNET_46);
		expect(session.model?.id).toBe("claude-sonnet-4-6");
	});

	it("resolves a same-name preset whole from the project layer, never merged", async () => {
		const settings = await projectSettings({
			project: `modelPresets:\n  deep:\n    version: 1\n    roles:\n      default: ${OPUS}\n    fallbackChains: {}\n    cycleOrder: []\n    defaultThinkingLevel: high\n`,
		});
		settings.setModelRole("slow", SONNET_46);
		cfgModelPresets.setEntry(settings, "deep", preset({ roles: { default: SONNET, smol: SONNET_46 } }));
		const session = createSession(settings);

		const result = await applyModelPreset(settings, session, "deep");

		expect(result.applied).toBe(true);
		// The project `deep` sets only `default`: the global `deep`'s `smol` must not leak in,
		// and the stale `slow` role is tombstoned for the session.
		expect({ ...settings.getModelRoles() }).toEqual({ default: OPUS });
		expect(session.model?.id).toBe("claude-opus-4-5");
	});


	it("reports when a higher layer still defines a just-saved preset name", async () => {
		const settings = await projectSettings({
			project: `modelPresets:\n  team:\n    version: 1\n    roles:\n      default: ${SONNET}\n    fallbackChains: {}\n    cycleOrder: []\n    defaultThinkingLevel: high\n`,
		});
		settings.setModelRole("default", OPUS);

		saveModelPreset(settings, "team");

		expect(modelPresetShadowOwner(settings, "team")).toBe("project");
		expect(getModelPreset(settings, "team")).toMatchObject({ kind: "found", preset: { roles: { default: SONNET } } });
		expect(modelPresetSavedMessage(settings, "team")).toBe(
			'Saved model preset "team" to the global config, but the project config still defines a preset of the same name, which takes precedence',
		);
	});

	it("does not list a preset a --config overlay tombstones, but keeps one a project null falls through", async () => {
		const tombstoned = await projectSettings({ overlay: "modelPresets:\n  deep: null\n" });
		cfgModelPresets.setEntry(tombstoned, "deep", preset({ roles: { default: OPUS } }));
		cfgModelPresets.setEntry(tombstoned, "fast", preset({ roles: { default: SONNET } }));
		expect(getModelPresetNames(tombstoned)).toEqual(["fast"]);

		const fallsThrough = await projectSettings({ project: "modelPresets:\n  deep: null\n" });
		cfgModelPresets.setEntry(fallsThrough, "deep", preset({ roles: { default: OPUS } }));
		expect(getModelPresetNames(fallsThrough)).toEqual(["deep"]);
	});

	it("serializes concurrent default-role mutations in acquisition order", async () => {
		const order: string[] = [];
		const first = await acquireModelRoleMutation();
		const secondPromise = acquireModelRoleMutation();
		let secondResolved = false;
		void secondPromise.then(release => {
			secondResolved = true;
			order.push("second");
			release();
		});
		// The mutex is promise-chaining only (no timers), so draining microtasks
		// deterministically proves the second acquisition is still parked.
		await Promise.resolve();
		await Promise.resolve();
		expect(secondResolved).toBe(false);
		order.push("first");
		first();
		await secondPromise;
		expect(order).toEqual(["first", "second"]);
	});

	it("holds the model-role mutation lock for the whole apply", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", SONNET);
		cfgModelPresets.setEntry(settings, "opus", preset({ roles: { default: OPUS } }));
		const session = createSession(settings);

		const release = await acquireModelRoleMutation();
		const applying = applyModelPreset(settings, session, "opus");
		// Promise-chaining mutex, no timers: drained microtasks prove the apply is parked.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(settings.getModelRole("default")).toBe(SONNET);
		expect(session.model?.id).toBe("claude-sonnet-4-5");

		release();
		expect((await applying).applied).toBe(true);
		expect(settings.getModelRole("default")).toBe(OPUS);
	});
});
