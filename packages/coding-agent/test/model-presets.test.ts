import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	applyModelPresetTransaction,
	canonicalizeModelPreset,
	captureModelPreset,
	type PresetSessionState,
	type PresetTransactionDeps,
	parseModelPreset,
	presetMatchesCurrent,
	validateModelPreset,
} from "@oh-my-pi/pi-coding-agent/config/model-presets";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { onModelRolesChanged, type RuntimeRoutingPlan, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as discovery from "@oh-my-pi/pi-coding-agent/discovery";
import type { ModelPresetV1, SettingValue } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import * as fileLock from "@oh-my-pi/pi-utils/file-lock";
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
const tl = (value: string): SettingValue<"defaultThinkingLevel"> => value as SettingValue<"defaultThinkingLevel">;

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
	return {
		deps,
		switchModel,
		applyThinking,
		getSessionState,
		restoreSessionState,
		sessionState,
	};
}

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

		test("a runtime plan's fallbackChains replace lower-layer chains exactly, empty included", async () => {
			await writeGlobal({ retry: { fallbackChains: { slow: ["p/a"] } } });
			const settings = await load();
			expect(settings.get("retry.fallbackChains")).toEqual({ slow: ["p/a"] });

			// Empty means "no chains" — the global `slow` chain must not survive the deep merge.
			settings.applyRuntimeRoutingPlan(plan({ fallbackChains: {} }));
			expect(settings.get("retry.fallbackChains")).toEqual({});

			// A partial record is exact too: no resurrection of lower-layer keys.
			settings.applyRuntimeRoutingPlan(plan({ fallbackChains: { default: ["p/b"] } }));
			expect(settings.get("retry.fallbackChains")).toEqual({ default: ["p/b"] });
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
				settings.override("modelRoles", { runtime: "test/runtime" });
				expect(settings.getModelRole("runtime")).toBe("test/runtime");
				expect(settings.getModelRole("late-global")).toBe("test/user-edit");
				expect(settings.getModelRole("late-project")).toBe("test/user-project-edit");
				await settings.flush();
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
				expect(cloned.get("retry.fallbackChains")).toEqual({});
				expect(cloned.getModelRole("discovered")).toBeUndefined();
				cloned.set("cycleOrder", ["default"]);
				expect(cloned.get("cycleOrder")).toEqual(["default"]);
				expect(settings.get("cycleOrder")).toEqual([]);
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
				chains: structuredClone(settings.get("retry.fallbackChains")),
				cycle: structuredClone(settings.get("cycleOrder")),
				modelFallback: settings.get("retry.modelFallback"),
				thinking: settings.get("defaultThinkingLevel"),
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
			expect(result.error).toBeTruthy();
			expect(settings.getModelRole("default")).toBe(before.defaultRole);
			expect(settings.getModelRole("reviewer")).toBeUndefined(); // tombstone restored
			expect(settings.get("retry.fallbackChains")).toEqual(before.chains);
			expect(settings.get("retry.modelFallback")).toBe(before.modelFallback);
			expect(settings.get("cycleOrder")).toEqual(before.cycle);
			expect(settings.get("defaultThinkingLevel")).toBe(before.thinking);
		});

		test("preset definitions persist per-key without clobbering external siblings", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.setModelPreset("a", preset({ roles: { default: "test/model-a" } }));
			expect(settings.getModelPresets().a).toBeDefined();
			await settings.flush();

			// Simulate another process adding a sibling preset between our saves.
			const configPath = path.join(agentDir, "config.yml");
			const onDisk = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
			(onDisk.modelPresets as Record<string, unknown>).b = preset({ roles: { default: "test/model-b" } });
			await Bun.write(configPath, YAML.stringify(onDisk, null, 2));

			settings.setModelPreset("a", preset({ roles: { default: "test/model-a2" } }));
			await settings.flush();
			const afterUpdate = YAML.parse(await Bun.file(configPath).text()) as {
				modelPresets?: Record<string, ModelPresetV1>;
			};
			expect(afterUpdate.modelPresets?.a?.roles.default).toBe("test/model-a2");
			expect(afterUpdate.modelPresets?.b?.roles.default).toBe("test/model-b"); // sibling survived

			settings.deleteModelPreset("a");
			await settings.flush();
			const afterDelete = YAML.parse(await Bun.file(configPath).text()) as {
				modelPresets?: Record<string, ModelPresetV1>;
			};
			expect(afterDelete.modelPresets?.a).toBeUndefined();
			expect(afterDelete.modelPresets?.b?.roles.default).toBe("test/model-b");
		});

		test("newer external same-name preset edits survive stale local updates and deletes", async () => {
			const original = preset({ roles: { default: "test/original" } });
			const external = preset({ roles: { default: "test/external" } });
			await writeGlobal({ modelPresets: { update: original, remove: original } });
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.setModelPreset("update", preset({ roles: { default: "test/stale" } }));
			settings.deleteModelPreset("remove");
			settings.setModelPreset("local-only", preset({ roles: { default: "test/local" } }));
			await writeGlobal({ modelPresets: { update: external, remove: external } });
			await settings.flush();
			const saved = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as {
				modelPresets: Record<string, ModelPresetV1>;
			};
			expect(saved.modelPresets.update.roles.default).toBe("test/external");
			expect(saved.modelPresets.remove.roles.default).toBe("test/external");
			expect(saved.modelPresets["local-only"].roles.default).toBe("test/local");
			expect(settings.getModelPresets()).toEqual(saved.modelPresets);
		});

		test("preserves a save and delete queued while another preset save waits for the file lock", async () => {
			const configPath = path.join(agentDir, "config.yml");
			await writeGlobal({
				modelPresets: {
					remove: preset({ roles: { default: "test/remove" } }),
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const firstSaveEntered = Promise.withResolvers<void>();
			const releaseFirstSave = Promise.withResolvers<void>();
			const withFileLock = fileLock.withFileLock;
			let pauseFirstSave = true;
			const lockSpy = vi.spyOn(fileLock, "withFileLock").mockImplementation(async (filePath, fn, options) => {
				if (pauseFirstSave) {
					pauseFirstSave = false;
					firstSaveEntered.resolve();
					await releaseFirstSave.promise;
				}
				return withFileLock(filePath, fn, options);
			});

			try {
				settings.setModelPreset("first", preset({ roles: { default: "test/first" } }));
				const firstFlush = settings.flush();
				await firstSaveEntered.promise;

				settings.deleteModelPreset("remove");
				settings.setModelPreset("second", preset({ roles: { default: "test/second" } }));
				releaseFirstSave.resolve();
				await firstFlush;
				await settings.flush();

				const saved = YAML.parse(await Bun.file(configPath).text()) as {
					modelPresets?: Record<string, ModelPresetV1>;
				};
				expect(saved.modelPresets?.first?.roles.default).toBe("test/first");
				expect(saved.modelPresets?.second?.roles.default).toBe("test/second");
				expect(saved.modelPresets?.remove).toBeUndefined();
				expect(settings.getModelPresets()).toEqual(saved.modelPresets ?? {});
			} finally {
				releaseFirstSave.resolve();
				lockSpy.mockRestore();
			}
		});

		test("reload retries when a model preset is saved or deleted during asynchronous reads", async () => {
			await writeGlobal({
				modelPresets: {
					remove: preset({ roles: { default: "test/remove" } }),
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const loadCapability = discovery.loadCapability;
			const projectLoadStarted = Promise.withResolvers<void>();
			const releaseProjectLoad = Promise.withResolvers<void>();
			let pauseProjectLoad = true;
			const loadSpy = vi.spyOn(discovery, "loadCapability").mockImplementation(async (id, options) => {
				if (pauseProjectLoad) {
					pauseProjectLoad = false;
					projectLoadStarted.resolve();
					await releaseProjectLoad.promise;
				}
				return loadCapability(id, options);
			});

			try {
				const reload = settings.reloadFromDisk();
				await projectLoadStarted.promise;
				settings.setModelPreset("saved", preset({ roles: { default: "test/saved" } }));
				settings.deleteModelPreset("remove");
				releaseProjectLoad.resolve();
				await reload;
				await settings.flush();

				expect((settings.getModelPresets().saved as ModelPresetV1 | undefined)?.roles.default).toBe("test/saved");
				expect(settings.getModelPresets().remove).toBeUndefined();
				const onDisk = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as {
					modelPresets?: Record<string, ModelPresetV1>;
				};
				expect(onDisk.modelPresets?.saved?.roles.default).toBe("test/saved");
				expect(onDisk.modelPresets?.remove).toBeUndefined();
			} finally {
				releaseProjectLoad.resolve();
				loadSpy.mockRestore();
			}
		});
	});

	describe("parseModelPreset", () => {
		test("rejects non-record input", () => {
			for (const raw of [null, undefined, 42, "preset", ["roles"]]) {
				expect(parseModelPreset(raw).ok).toBe(false);
			}
		});

		test("rejects an unsupported or missing version", () => {
			const wrongVersion = parseModelPreset({ ...preset(), version: 2 });
			expect(wrongVersion.ok).toBe(false);
			if (!wrongVersion.ok) expect(wrongVersion.error).toMatch(/version|unsupported/i);

			const { version: _version, ...missingVersion } = preset();
			const parsed = parseModelPreset(missingVersion);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.error).toMatch(/version|unsupported/i);
		});

		test("rejects a preset missing any required field", () => {
			for (const field of ["roles", "fallbackChains", "cycleOrder", "defaultThinkingLevel"] as const) {
				const raw: Record<string, unknown> = { ...preset() };
				delete raw[field];
				expect(parseModelPreset(raw).ok).toBe(false);
			}
		});

		test("rejects a thinking level outside the setting enum", () => {
			for (const level of ["inherit", "off", 7, null]) {
				expect(parseModelPreset({ ...preset(), defaultThinkingLevel: level }).ok).toBe(false);
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
				expect(result.error).toBeTruthy();
			}

			expect(harness.switchModel).not.toHaveBeenCalled();
			expect(harness.applyThinking).not.toHaveBeenCalled();
			expect(settings.getModelRole("default")).toBe("test/model-a");
			expect(settings.get("retry.modelFallback")).toBe(true);
			expect(settings.get("retry.fallbackChains")).toEqual({ slow: ["p/a"] });
			expect(settings.get("cycleOrder")).toEqual(["default"]);
			expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.Medium);
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
			expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.Low);
			expect(settings.get("retry.modelFallback")).toBe(false);
		});
	});

	describe("observer atomicity", () => {
		test("modelRoles observers already see the plan's full routing state when notified", () => {
			const settings = Settings.isolated({});
			const seen: Array<{
				chains: SettingValue<"retry.fallbackChains">;
				modelFallback: SettingValue<"retry.modelFallback">;
				cycle: SettingValue<"cycleOrder">;
				thinking: SettingValue<"defaultThinkingLevel">;
				role: string | undefined;
			}> = [];
			const unsubscribe = onModelRolesChanged(() => {
				seen.push({
					modelFallback: settings.get("retry.modelFallback"),
					chains: settings.get("retry.fallbackChains"),
					cycle: settings.get("cycleOrder"),
					thinking: settings.get("defaultThinkingLevel"),
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
	});

	describe("validateModelPreset", () => {
		test("rejects a role whose value matches no available model, naming the role", () => {
			const models = [makeModel("test", "model-a")];
			const settings = Settings.isolated({});
			const registry = stubRegistry(new Set(["model-a"]));

			const result = validateModelPreset(preset({ roles: { default: "test/nonexistent" } }), models, {
				settings,
				registry,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("default");
		});

		test("rejects a role whose model resolves but has no configured credentials", () => {
			const models = [makeModel("test", "model-a")];
			const settings = Settings.isolated({});
			const registry = stubRegistry(new Set()); // nothing authenticated

			const result = validateModelPreset(preset({ roles: { default: "test/model-a" } }), models, {
				settings,
				registry,
			});
			expect(result.ok).toBe(false);
		});
	});
});
