import { afterEach, beforeAll, describe, expect, type Mock, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { PresetApplyResult } from "@oh-my-pi/pi-coding-agent/config/model-presets";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { modelRoleValueFromUnknown, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ModelPresetV1 } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	type ModelHubCallbacks,
	ModelHubComponent,
	type ModelHubOptions,
	resetProviderAutoRefreshGuard,
} from "@oh-my-pi/pi-coding-agent/modes/components/model-hub";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";
import type { TUI } from "@oh-my-pi/pi-tui";

function normalize(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n")).replace(/\s+/g, " ").trim();
}

/** The footer row (hint line or an active chip strip) of a rendered frame. */
function footerLine(lines: readonly string[]): string {
	return stripVTControlCharacters(lines[lines.length - 2] ?? "");
}

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

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelHub tests");
	}
	setThemeInstance(testTheme);
}

interface RegistryOverrides {
	refresh?: (mode: string) => Promise<void>;
	refreshProvider?: (providerId: string, mode: string) => Promise<void>;
	getAvailable?: () => Model[];
	getAll?: () => Model[];
	getDiscoverableProviders?: () => string[];
	getProviderDiscoveryState?: (providerId: string) => unknown;
}

function makeRegistry(models: () => Model[], overrides: RegistryOverrides = {}): ModelRegistry {
	return {
		refresh: overrides.refresh ?? (async () => {}),
		refreshProvider: overrides.refreshProvider ?? (async () => {}),
		getError: () => undefined,
		getAvailable: overrides.getAvailable ?? models,
		getAll: overrides.getAll ?? models,
		getDiscoverableProviders: overrides.getDiscoverableProviders ?? (() => []),
		getProviderDiscoveryState: overrides.getProviderDiscoveryState ?? (() => undefined),
		authStorage: { hasAuth: () => false },
	} as unknown as ModelRegistry;
}

interface HubHarness {
	hub: ModelHubComponent;
	onAssign: ReturnType<typeof vi.fn>;
	onUnassign: ReturnType<typeof vi.fn>;
	onLoginRequest: ReturnType<typeof vi.fn>;
	onCancel: ReturnType<typeof vi.fn>;
	onFallbackChainChange: Mock<(role: string, chain: string[]) => void>;
	onSavePreset: Mock<(name: string, preset: ModelPresetV1) => void>;
	onDeletePreset: Mock<(name: string) => void>;
	onApplyPreset: Mock<(name: string, preset: ModelPresetV1) => Promise<PresetApplyResult> | PresetApplyResult>;
}

const openHubs: ModelHubComponent[] = [];

function createHub(options: {
	models: Model[] | (() => Model[]);
	scoped?: boolean;
	settings?: Settings;
	registry?: RegistryOverrides;
	hub?: ModelHubOptions;
	callbacks?: Partial<ModelHubCallbacks>;
}): HubHarness {
	installTestTheme();
	const modelsFn = typeof options.models === "function" ? options.models : () => options.models as Model[];
	const settings = options.settings ?? Settings.isolated({});
	const registry = makeRegistry(modelsFn, options.registry);
	const ui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
	const onAssign = vi.fn();
	const onUnassign = vi.fn();
	const onLoginRequest = vi.fn();
	const onCancel = vi.fn();
	// Mirror the controller: persist chain edits so the hub's re-read sees them.
	const onFallbackChainChange = vi.fn((role: string, chain: string[]) => {
		const chains = { ...settings.get("retry.fallbackChains") };
		if (chain.length === 0) {
			delete chains[role];
		} else {
			chains[role] = chain;
		}
		settings.override("retry.fallbackChains", chains);
	});
	// Mirror the controller: persist preset mutations so the hub's re-read sees them.
	const onSavePreset = vi.fn((name: string, preset: ModelPresetV1) => {
		const presets = { ...settings.get("modelPresets") };
		presets[name] = preset;
		settings.override("modelPresets", presets);
	});
	const onDeletePreset = vi.fn((name: string) => {
		const presets = { ...settings.get("modelPresets") };
		delete presets[name];
		settings.override("modelPresets", presets);
	});
	// Mirror the controller's settings effect: pin the preset's routing state at
	// the runtime override layer, tombstoning every role the preset omits.
	const onApplyPreset = vi.fn((_name: string, preset: ModelPresetV1) => {
		const roles: Record<string, string> = {};
		for (const [role, value] of Object.entries(preset.roles ?? {})) {
			const normalized = modelRoleValueFromUnknown(value);
			if (normalized) roles[role] = normalized;
		}
		settings.applyRuntimeRoutingPlan({
			roles,
			clearRoles: settings.getAllModelRoleKeys().filter(role => !(role in roles)),
			fallbackChains: preset.fallbackChains ?? {},
			cycleOrder: preset.cycleOrder ?? [],
			defaultThinkingLevel: preset.defaultThinkingLevel ?? settings.get("defaultThinkingLevel"),
		});
		return { applied: true } as const;
	});
	const hub = new ModelHubComponent(
		ui,
		settings,
		registry,
		options.scoped ? modelsFn().map(model => ({ model })) : [],
		{
			onAssign: options.callbacks?.onAssign ?? onAssign,
			onUnassign: options.callbacks?.onUnassign ?? onUnassign,
			onLoginRequest: options.callbacks?.onLoginRequest ?? onLoginRequest,
			onCycleOrderChange: options.callbacks?.onCycleOrderChange,
			onFallbackChainChange: options.callbacks?.onFallbackChainChange ?? onFallbackChainChange,
			onApplyPreset: options.callbacks?.onApplyPreset ?? onApplyPreset,
			onSavePreset: options.callbacks?.onSavePreset ?? onSavePreset,
			onDeletePreset: options.callbacks?.onDeletePreset ?? onDeletePreset,
			onCancel: options.callbacks?.onCancel ?? onCancel,
		},
		options.hub,
	);
	openHubs.push(hub);
	return {
		hub,
		onAssign,
		onUnassign,
		onLoginRequest,
		onCancel,
		onFallbackChainChange,
		onSavePreset,
		onDeletePreset,
		onApplyPreset,
	};
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const ESC = "\x1b";

describe("ModelHub", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelHub tests");
		}
	});

	afterEach(() => {
		resetProviderAutoRefreshGuard();
		for (const hub of openHubs.splice(0)) {
			hub.dispose();
		}
	});

	describe("role chips and roles view", () => {
		test("tags the selected model's roles in the detail line, including custom roles", () => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
			const settings = Settings.isolated({
				cycleOrder: ["smol", "custom-fast", "default"],
				modelRoles: {
					default: `${model.provider}/${model.id}`,
					"custom-fast": `${model.provider}/${model.id}:low`,
					smol: `${model.provider}/${model.id}`,
				},
			});
			const { hub } = createHub({ models: [model], scoped: true, settings });
			installTestTheme();

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("● default");
			expect(rendered).toContain("● custom-fast");
			// Explicit :low suffix surfaces as the low thinking glyph on the chip.
			expect(rendered).toContain("◔");
			expect(rendered).toContain("● smol");
		});

		test("list rows carry no role chips; only the selected model's detail line is tagged", () => {
			const settings = Settings.isolated({});
			const haiku = makeModel("test", "claude-haiku-4.5");
			const codex = makeModel("test", "gpt-5.1-codex");
			const { hub } = createHub({ models: [codex, haiku], scoped: true, settings });
			installTestTheme();

			const rendered = normalize(hub.render(220));
			// Auto-selection tags smol → haiku and slow → codex, but only the
			// selected model's chips render (in the detail line). With row
			// chips both would appear at once.
			const hollow = ["○ smol", "○ slow"].filter(chip => rendered.includes(chip));
			expect(hollow).toHaveLength(1);
			expect(rendered).not.toContain("● smol");
		});

		test("roles view reflects auto thinking from defaultThinkingLevel and :auto suffixes", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const settings = Settings.isolated({
				defaultThinkingLevel: AUTO_THINKING,
				modelRoles: {
					default: `${model.provider}/${model.id}`,
					smol: `${model.provider}/${model.id}:auto`,
				},
			});
			const { hub } = createHub({ models: [model], scoped: true, settings });
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (since Recent is removed)
			const lines = hub.render(220).map(line => stripVTControlCharacters(line));
			const defaultRow = lines.find(line => line.includes("DEFAULT"));
			const smolRow = lines.find(line => line.includes("SMOL"));
			expect(defaultRow).toContain("auto");
			expect(defaultRow).not.toContain("inherit");
			expect(smolRow).toContain("auto");
		});
		test("thinking-only edits preserve the model and scope from the persisted role layer", () => {
			const storedModel = makeModel("test", "global-role-model");
			const effectiveModel = makeModel("test", "runtime-role-model");
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			settings.setModelRole("default", `${storedModel.provider}/${storedModel.id}`);
			settings.overrideModelRoles({ default: `${effectiveModel.provider}/${effectiveModel.id}` });
			const { hub, onAssign } = createHub({ models: [storedModel, effectiveModel], scoped: true, settings });

			hub.handleInput(UP); // All models → Roles.
			hub.handleInput("\n"); // Dive into role rows on DEFAULT.
			hub.handleInput("t");
			hub.handleInput("\x1b[C"); // Inherit → off.
			hub.handleInput("\n");

			expect(onAssign.mock.calls[0]?.[0]).toBe(storedModel);
			expect(onAssign.mock.calls[0]?.[1]).toBe("default");
			expect(onAssign.mock.calls[0]?.[4]).toBe("global");
		});

		test("x clears a configured role back to auto-selection", () => {
			const model = makeModel("test", "worker-model");
			const settings = Settings.isolated({
				modelRoles: { smol: "test/worker-model" },
			});
			const { hub } = createHub({
				models: [model],
				scoped: true,
				settings,
				callbacks: {
					// Emulate the controller: clearing deletes the persisted role.
					onUnassign: role => settings.setModelRole(role, undefined),
				},
			});
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (top of the sidebar)
			hub.handleInput("\n"); // dive into the role rows
			hub.handleInput(DOWN); // default → smol row
			hub.handleInput("x");

			expect(settings.getModelRole("smol")).toBeUndefined();
			const lines = hub.render(220).map(line => stripVTControlCharacters(line));
			const smolRow = lines.find(line => line.includes("SMOL"));
			// No auto candidate resolves for this synthetic model, so the row
			// reads as unassigned instead of keeping the cleared value.
			expect(smolRow).not.toContain("worker-model");
			expect(smolRow).toContain("—");
		});
	});

	describe("hop focus stability", () => {
		test("hopping onto Roles keeps provider navigation instead of capturing the arrows", () => {
			const model = makeModel("prov-a", "model-a");
			const { hub } = createHub({ models: [model] });
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (since Recent is removed)
			// The roles view shows as a preview, but arrows keep hopping.
			expect(footerLine(hub.render(220))).toContain("→ roles");
			hub.handleInput(DOWN); // continues to All models — not a role row
			expect(normalize(hub.render(220))).toContain("All available models");
		});

		test("while searching, the hop skips Roles", () => {
			const model = makeModel("prov-a", "target-model");
			const { hub } = createHub({ models: [model] });
			installTestTheme();

			for (const ch of "target") hub.handleInput(ch);
			hub.handleInput(UP); // skips Roles → wraps to prov-a
			expect(normalize(hub.render(220))).toContain("prov-a ·");
			expect(footerLine(hub.render(220))).not.toContain("→ roles");
		});
	});

	describe("quick-switch cycle and custom roles", () => {
		test("c toggles cycle membership, [ reorders, and the preview tracks the order", () => {
			const model = makeModel("test", "cycle-model");
			const settings = Settings.isolated({});
			const changes: string[][] = [];
			const { hub } = createHub({
				models: [model],
				scoped: true,
				settings,
				callbacks: {
					onCycleOrderChange: order => {
						changes.push([...order]);
						settings.set("cycleOrder", order);
					},
				},
			});
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (since Recent is removed)
			hub.handleInput("\n"); // dive into rows; cursor on DEFAULT

			// Default cycle is [smol, default, slow]: c removes default…
			hub.handleInput("c");
			expect(changes[0]).toEqual(["smol", "slow"]);
			// …c again re-appends it at the end…
			hub.handleInput("c");
			expect(changes[1]).toEqual(["smol", "slow", "default"]);
			// …and [ moves it one slot earlier.
			hub.handleInput("[");
			expect(changes[2]).toEqual(["smol", "default", "slow"]);

			// The preview line renders the resulting ctrl+p track in order.
			const preview = hub
				.render(220)
				.map(line => stripVTControlCharacters(line))
				.find(line => line.includes("cycle:"));
			expect(preview).toBeDefined();
			const previewText = preview ?? "";
			expect(previewText.indexOf("smol")).toBeGreaterThan(-1);
			expect(previewText.indexOf("smol")).toBeLessThan(previewText.indexOf("default"));
			expect(previewText.indexOf("default")).toBeLessThan(previewText.indexOf("slow"));
		});

		test("the + New role row names a custom role and jumps into assigning it", () => {
			const model = makeModel("test", "reviewer-model");
			const { hub, onAssign } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (since Recent is removed)
			hub.handleInput("\n"); // dive into rows
			hub.handleInput(UP); // wraps to the trailing "+ New fallback…" row
			hub.handleInput(UP); // skips the section divider up to "+ New role…"
			hub.handleInput("\n");
			expect(footerLine(hub.render(220))).toContain("New role name:");

			for (const ch of "reviewer") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("Assigning reviewer");

			hub.handleInput("\n"); // pick the sole model for the new role
			expect(onAssign).toHaveBeenCalledTimes(1);
			const call = onAssign.mock.calls[0];
			expect(call?.[1]).toBe("reviewer");
			expect(call?.[3]).toBe("test/reviewer-model");
		});
	});

	describe("assignment strips", () => {
		test("Enter opens the role strip; assigning fires onAssign and opens the thinking strip", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const { hub, onAssign } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput("\n");
			const strip = footerLine(hub.render(220));
			expect(strip).toContain("default");
			expect(strip).toContain("retry-fallback");
			expect(strip).not.toContain("project default");
			expect(strip).not.toContain("global default");

			hub.handleInput("\n"); // assign to default (first chip)
			expect(onAssign).toHaveBeenCalledTimes(1);
			const call = onAssign.mock.calls[0];
			expect(call?.[0]).toBe(model);
			expect(call?.[1]).toBe("default");
			expect(call?.[2]).toBe(ThinkingLevel.Inherit);
			expect(call?.[3]).toBe("openai/gpt-5.5");
			expect(call?.[4]).toBe("global");

			// The thinking strip follows immediately, scoped to the model's
			// real ladder: gpt-5.5 tops out at xhigh — no invented max tier.
			const thinking = footerLine(hub.render(220));
			expect(thinking).toContain("inherit");
			expect(thinking).toContain("xhigh");
			expect(thinking).not.toContain("max");
		});
		test("project storage exposes project and global role actions with callback scopes", () => {
			const model = makeModel("test", "scoped-role-model");
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			const projectHarness = createHub({ models: [model], scoped: true, settings });

			projectHarness.hub.handleInput("\n");
			const projectStrip = footerLine(projectHarness.hub.render(220));
			expect(projectStrip).toContain("project default");
			expect(projectStrip).toContain("global default");
			projectHarness.hub.handleInput("\n");
			expect(projectHarness.onAssign.mock.calls[0]?.[4]).toBe("project");

			const globalHarness = createHub({ models: [model], scoped: true, settings });
			globalHarness.hub.handleInput("\n");
			globalHarness.hub.handleInput(DOWN);
			globalHarness.hub.handleInput("\n");
			expect(globalHarness.onAssign.mock.calls[0]?.[4]).toBe("global");
		});
		test("shadowed global assignments unassign from the global chip", () => {
			const globalModel = makeModel("test", "a-global-role-model");
			const projectModel = makeModel("test", "z-project-role-model");
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			settings.setModelRole("default", `${globalModel.provider}/${globalModel.id}`);
			settings.setProjectModelRole("default", `${projectModel.provider}/${projectModel.id}`);
			const { hub, onAssign, onUnassign } = createHub({
				models: [globalModel, projectModel],
				scoped: true,
				settings,
			});

			hub.handleInput("\t"); // Sidebar → model list.
			hub.handleInput(DOWN); // Effective project model → shadowed global model.
			hub.handleInput("\n");
			hub.handleInput(DOWN); // Project default → global default.
			hub.handleInput("\n");

			expect(onUnassign).toHaveBeenCalledWith("default", "global");
			expect(onAssign).not.toHaveBeenCalled();
		});
		test("overlay tombstones do not hide stored scoped default assignments", async () => {
			const model = makeModel("test", "claude-haiku-4.5");
			const selector = `${model.provider}/${model.id}`;
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-model-hub-"));
			const cwd = path.join(root, "project");
			const agentDir = path.join(root, "agent");
			const overlayPath = path.join(root, "overlay.yml");

			try {
				await Bun.write(
					path.join(agentDir, "config.yml"),
					`modelRoleStorage: project\nmodelRoles:\n  default: ${selector}\n  smol: ${selector}\n`,
				);
				await Bun.write(
					path.join(cwd, ".omp", "config.yml"),
					`modelRoles:\n  default: ${selector}\n  smol: ${selector}\n`,
				);
				await Bun.write(overlayPath, "modelRoles:\n  default: null\n  smol: null\n");
				const settings = await Settings.loadReadOnly({ cwd, agentDir, configFiles: [overlayPath] });
				expect(settings.getModelRole("default")).toBeUndefined();
				expect(settings.getGlobalModelRole("default")).toBe(selector);
				expect(settings.getProjectModelRole("default")).toBe(selector);

				const projectDefault = createHub({ models: [model], scoped: true, settings });
				expect(normalize(projectDefault.hub.render(220))).toContain("○ smol");
				projectDefault.hub.handleInput("\n");
				projectDefault.hub.handleInput("\n");
				expect(projectDefault.onUnassign).toHaveBeenCalledWith("default", "project");
				expect(projectDefault.onAssign).not.toHaveBeenCalled();

				const globalDefault = createHub({ models: [model], scoped: true, settings });
				globalDefault.hub.handleInput("\n");
				globalDefault.hub.handleInput(DOWN);
				globalDefault.hub.handleInput("\n");
				expect(globalDefault.onUnassign).toHaveBeenCalledWith("default", "global");
				expect(globalDefault.onAssign).not.toHaveBeenCalled();

				const projectAutoSelected = createHub({ models: [model], scoped: true, settings });
				projectAutoSelected.hub.handleInput("\n");
				projectAutoSelected.hub.handleInput(DOWN);
				projectAutoSelected.hub.handleInput(DOWN);
				projectAutoSelected.hub.handleInput("\n");
				expect(projectAutoSelected.onUnassign).toHaveBeenCalledWith("smol", "project");
				expect(projectAutoSelected.onAssign).not.toHaveBeenCalled();

				const globalAutoSelected = createHub({ models: [model], scoped: true, settings });
				globalAutoSelected.hub.handleInput("\n");
				globalAutoSelected.hub.handleInput(DOWN);
				globalAutoSelected.hub.handleInput(DOWN);
				globalAutoSelected.hub.handleInput(DOWN);
				globalAutoSelected.hub.handleInput("\n");
				expect(globalAutoSelected.onUnassign).toHaveBeenCalledWith("smol", "global");
				expect(globalAutoSelected.onAssign).not.toHaveBeenCalled();
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});

		test("auto-selected roles remain assignable when the selected scope has no stored role", () => {
			const model = makeModel("test", "claude-haiku-4.5");
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			const { hub, onAssign, onUnassign } = createHub({ models: [model], scoped: true, settings });
			expect(normalize(hub.render(220))).toContain("○ smol");

			hub.handleInput("\n");
			hub.handleInput(DOWN);
			hub.handleInput(DOWN);
			hub.handleInput("\n");

			expect(onAssign.mock.calls[0]?.[1]).toBe("smol");
			expect(onAssign.mock.calls[0]?.[4]).toBe("project");
			expect(onUnassign).not.toHaveBeenCalled();
		});

		test("global assignments preserve thinking from the global role instead of the project override", () => {
			const configuredModel = getBundledModel("openai", "gpt-5.5");
			const targetModel = getBundledModel("openai", "gpt-5.6");
			if (!configuredModel || !targetModel) {
				throw new Error("Expected bundled OpenAI models for scoped thinking test");
			}
			const selector = `${configuredModel.provider}/${configuredModel.id}`;
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			settings.setModelRole("smol", `${selector}:low,missing/unavailable:high`);
			settings.setModelRole("default", "@smol");
			settings.setProjectModelRole("smol", `${selector}:high`);
			settings.setProjectModelRole("default", "@smol");
			const { hub, onAssign } = createHub({ models: [configuredModel, targetModel], scoped: true, settings });

			hub.handleInput("\t"); // Sidebar → model list.
			hub.handleInput(DOWN); // Effective configured model → assignment target.
			hub.handleInput("\n");
			hub.handleInput(DOWN); // Project default → global default.
			hub.handleInput("\n");

			expect(onAssign.mock.calls[0]?.[2]).toBe(ThinkingLevel.Low);
			expect(onAssign.mock.calls[0]?.[4]).toBe("global");
			hub.handleInput("\n"); // Reapply the preselected global thinking level.
			expect(onAssign.mock.calls[1]?.[2]).toBe(ThinkingLevel.Low);
			expect(onAssign.mock.calls[1]?.[4]).toBe("global");
		});
		test("project-scope alias falls back to the global role when the project role is absent", () => {
			const configuredModel = getBundledModel("openai", "gpt-5.5");
			const targetModel = getBundledModel("openai", "gpt-5.6");
			if (!configuredModel || !targetModel) {
				throw new Error("Expected bundled OpenAI models for project alias fallback test");
			}
			const selector = `${configuredModel.provider}/${configuredModel.id}`;
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			// Global smol selects a concrete model with :low plus an unavailable
			// fallback — the alias must resolve to this, not built-in priority.
			settings.setModelRole("smol", `${selector}:low,missing/unavailable:high`);
			// Global default also points at @smol — another project/effective
			// conflict that would expose merged-resolution contamination if the
			// alias lookup consulted merged settings instead of project-first.
			settings.setModelRole("default", "@smol");
			// Project default is @smol; project smol is absent — the alias must
			// fall back to the global smol, not built-in priority defaults.
			settings.setProjectModelRole("default", "@smol");

			// Assignment thinking: the preserved level comes from the global
			// smol fallback (:low), not built-in priority defaults (Inherit).
			const assignHub = createHub({ models: [configuredModel, targetModel], scoped: true, settings });
			assignHub.hub.handleInput("\t"); // Sidebar → model list.
			assignHub.hub.handleInput(DOWN); // gpt-5.5 → gpt-5.6.
			assignHub.hub.handleInput("\n"); // Open the role strip for gpt-5.6.
			assignHub.hub.handleInput("\n"); // Assign to "project default" (first chip).
			expect(assignHub.onAssign).toHaveBeenCalledTimes(1);
			expect(assignHub.onAssign.mock.calls[0]?.[1]).toBe("default");
			expect(assignHub.onAssign.mock.calls[0]?.[2]).toBe(ThinkingLevel.Low);
			expect(assignHub.onAssign.mock.calls[0]?.[4]).toBe("project");

			// Chip classification: on gpt-5.5, the project default chip is
			// "assigned here" because @smol falls back to global smol → gpt-5.5.
			const classifyHub = createHub({ models: [configuredModel, targetModel], scoped: true, settings });
			classifyHub.hub.handleInput("\t"); // Sidebar → model list.
			classifyHub.hub.handleInput("\n"); // Open the role strip for gpt-5.5.
			classifyHub.hub.handleInput("\n"); // Select "project default" (first chip).
			expect(classifyHub.onUnassign).toHaveBeenCalledWith("default", "project");
			expect(classifyHub.onAssign).not.toHaveBeenCalled();
		});

		test("renders max as a real final tier on max-capable models (gpt-5.6)", () => {
			const model = getBundledModel("openai", "gpt-5.6");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.6");
			const { hub } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput("\n");
			hub.handleInput("\n");
			const thinking = footerLine(hub.render(220));
			expect(thinking).toContain("xhigh");
			expect(thinking).toContain("max");
		});

		test("Enter on a chip already holding this model unassigns it", () => {
			const model = makeModel("test", "toggled-model");
			const settings = Settings.isolated({ modelRoles: { smol: "test/toggled-model" } });
			const { hub, onAssign, onUnassign } = createHub({ models: [model], scoped: true, settings });
			installTestTheme();

			hub.handleInput("\n"); // role strip
			hub.handleInput(DOWN); // default → smol chip (down moves right)
			hub.handleInput("\n");

			expect(onUnassign).toHaveBeenCalledWith("smol");
			expect(onAssign).not.toHaveBeenCalled();
			// Toggle closes the strip without a thinking step.
			expect(footerLine(hub.render(220))).not.toContain("inherit");
		});

		test("retry-fallback chip appends the model to the default chain without a thinking strip", () => {
			const model = makeModel("test", "retry-fallback-model");
			const { hub, onAssign, onFallbackChainChange } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput("\n");
			hub.handleInput(LEFT); // wraps to the trailing retry-fallback chip
			hub.handleInput("\n");

			expect(onFallbackChainChange).toHaveBeenCalledWith("default", ["test/retry-fallback-model"]);
			expect(onAssign).not.toHaveBeenCalled();
			expect(footerLine(hub.render(220))).not.toContain("inherit");

			// A second registration of the same model is a no-op, not a duplicate.
			hub.handleInput("\n");
			hub.handleInput(LEFT);
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenCalledTimes(1);
		});

		test("overflowing role strip scrolls left so the selected chip stays visible", () => {
			const model = makeModel("test", "narrow-strip-model");
			const { hub } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput("\n"); // open the role strip
			// At full width every chip fits and no left ellipsis appears.
			expect(footerLine(hub.render(220))).not.toContain("…");

			hub.handleInput(LEFT); // wrap to the trailing retry-fallback chip
			const narrow = footerLine(hub.render(80));
			expect(narrow).toContain("[ retry-fallback ]");
			expect(narrow).toContain("…");

			// Back on the first chip the window resets — no leading ellipsis.
			hub.handleInput("\x1b[C"); // wrap right back to the first chip
			const reset = footerLine(hub.render(80));
			expect(reset).toContain("[ default");
			expect(reset.trimStart().startsWith("…")).toBe(false);
		});
	});

	describe("fallback chains in the roles view", () => {
		/** Hop to the Roles sidebar entry and dive into its rows. */
		function enterRolesView(hub: ModelHubComponent): void {
			hub.handleInput(UP); // All models → Roles
			hub.handleInput("\n"); // dive into the rows
		}

		test("renders configured chain entries as indented rows under their role", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: ["test/model-a", "test/model-b"] },
			});
			const { hub } = createHub({ models: [a, b], scoped: true, settings });

			enterRolesView(hub);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("↳ test/model-a");
			expect(rendered).toContain("↳ test/model-b");
		});

		test("f on a role opens fallback assignment and Enter appends the picked model", () => {
			const a = makeModel("test", "model-a");
			const settings = Settings.isolated({});
			const { hub, onFallbackChainChange, onAssign } = createHub({ models: [a], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput("f"); // add a fallback for the first role (default)
			expect(normalize(hub.render(220))).toContain("Adding fallback for");

			hub.handleInput("\n"); // pick the only model
			expect(onFallbackChainChange).toHaveBeenCalledWith("default", ["test/model-a"]);
			expect(onAssign).not.toHaveBeenCalled(); // no role assignment, no thinking strip
			expect(normalize(hub.render(220))).toContain("↳ test/model-a");
		});

		test("x removes a chain entry and Enter on an entry replaces it", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: ["test/model-a", "test/model-b"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // default → its first chain entry (model-a)
			hub.handleInput("\n"); // replace this entry
			expect(normalize(hub.render(220))).toContain("Replacing fallback of");
			for (const ch of "model-b") hub.handleInput(ch); // search: arrows hop scopes in assign mode
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", ["test/model-b"]);

			hub.handleInput("x"); // cursor landed on the replaced entry — remove it
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", []);
			expect(normalize(hub.render(220))).not.toContain("↳");
		});

		test("] moves a chain entry later and the cursor follows it", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: ["test/model-a", "test/model-b"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // first chain entry (model-a)
			hub.handleInput("]");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", ["test/model-b", "test/model-a"]);

			// Cursor followed the moved entry: x removes model-a, not model-b.
			hub.handleInput("x");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", ["test/model-b"]);
		});

		test("clicking a roles row hits the row under the pointer", () => {
			const a = makeModel("test", "model-a");
			const { hub } = createHub({ models: [a], scoped: true });

			hub.handleInput(UP); // All models → Roles
			// Derive the pointer row from the frame itself: the fullscreen
			// overlay paints from screen row 0, so frame index == screen row.
			const frame = hub.render(220).map(line => stripVTControlCharacters(line));
			const screenRow = frame.findIndex(line => line.includes("DEFAULT"));
			expect(screenRow).toBeGreaterThan(0);
			const sgr = `\x1b[<0;61;${screenRow + 1}M`; // SGR reports are 1-based
			hub.handleInput(sgr); // select (dive into rows)
			hub.handleInput(sgr); // click-again activates
			expect(normalize(hub.render(220))).toContain("Assigning DEFAULT");
		});

		test("fallbacks chip keys a new chain by the selected model", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true });

			for (const ch of "model-a") hub.handleInput(ch);
			hub.handleInput("\n"); // open the strip for model-a
			hub.handleInput(LEFT); // retry-fallback
			hub.handleInput(LEFT); // fallbacks:test/*
			hub.handleInput(LEFT); // fallbacks:model-a
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("Adding fallback for test/model-a");

			for (const ch of "model-b") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/model-a", ["test/model-b"]);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("test/model-a");
			expect(rendered).toContain("↳ test/model-b");
		});

		test("provider chip keys the chain by provider/*", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true });

			for (const ch of "model-a") hub.handleInput(ch);
			hub.handleInput("\n");
			hub.handleInput(LEFT); // retry-fallback
			hub.handleInput(LEFT); // fallbacks:test/*
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("Adding fallback for test/*");

			for (const ch of "model-b") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/*", ["test/model-b"]);
		});

		test("+ New fallback… picks the protected model, then keys the chain via the strip", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true });

			enterRolesView(hub);
			hub.handleInput(UP); // wrap to the trailing "+ New fallback…"
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("New fallback chain");

			for (const ch of "model-a") hub.handleInput(ch);
			hub.handleInput("\n"); // pick the protected model
			const strip = footerLine(hub.render(220));
			expect(strip).toContain("for test/model-a");
			expect(strip).toContain("for test/*");

			hub.handleInput("\n"); // key by the exact model
			expect(normalize(hub.render(220))).toContain("Adding fallback for test/model-a");
			for (const ch of "model-b") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/model-a", ["test/model-b"]);
		});

		test("model-keyed chains render below the separator and x clears the whole chain", () => {
			const a = makeModel("test", "model-a");
			const settings = Settings.isolated({
				"retry.fallbackChains": { "test/*": ["test/model-a"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a], scoped: true, settings });

			enterRolesView(hub);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("test/*");
			expect(rendered).toContain("↳ test/model-a");
			expect(rendered).toContain("+ New fallback…");
			expect(rendered).toMatch(/─{10,}/); // the roles/fallbacks divider

			hub.handleInput(UP); // + New fallback…
			hub.handleInput(UP); // ↳ test/model-a
			hub.handleInput(UP); // test/* header (separator is skipped)
			hub.handleInput("x");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/*", []);
			expect(normalize(hub.render(220))).not.toContain("↳ test/model-a");
		});
	});

	test("focuses the scope pane initially", () => {
		const { hub } = createHub({ models: [makeModel("test", "test-model")] });
		const rendered = normalize(hub.render(220));
		expect(rendered).toContain("↑/↓ providers · → models");
	});

	describe("mouse wheel", () => {
		// SGR wheel reports: button 64 = up, 65 = down. Column 100 lands in the
		// body pane, column 3 in the sidebar; row 10 is inside the content rows.
		const WHEEL_UP_BODY = "\x1b[<64;100;10M";
		const WHEEL_DOWN_BODY = "\x1b[<65;100;10M";
		const WHEEL_UP_SIDEBAR = "\x1b[<64;3;10M";
		const WHEEL_DOWN_SIDEBAR = "\x1b[<65;3;10M";

		test("wheel pans the model list without moving the selection and clamps at the ends", () => {
			const models = Array.from({ length: 40 }, (_, i) => makeModel("test", `model-${String(i).padStart(2, "0")}`));
			const { hub } = createHub({ models, scoped: true });

			const before = normalize(hub.render(220)); // establishes mouse geometry
			// Enter opens the role strip for the selected model — its footer
			// (`<model-id> → …`) identifies the selection.
			hub.handleInput("\n");
			const initialStrip = footerLine(hub.render(220));
			expect(initialStrip).toContain("→");
			hub.handleInput(ESC); // close the strip

			// Panning reveals rows that were below the fold...
			for (let i = 0; i < 8; i++) hub.handleInput(WHEEL_DOWN_BODY);
			const panned = normalize(hub.render(220));
			const modelIdsIn = (frame: string) => new Set(Array.from(frame.matchAll(/model-\d\d/g), match => match[0]));
			const beforeIds = modelIdsIn(before);
			const revealed = [...modelIdsIn(panned)].filter(id => !beforeIds.has(id));
			expect(revealed.length).toBeGreaterThan(0);

			// ...but never moves the selection: Enter still opens the same model's strip.
			hub.handleInput("\n");
			expect(footerLine(hub.render(220))).toBe(initialStrip);
			hub.handleInput(ESC);

			// The window clamps at the bottom instead of wrapping back to the top...
			for (let i = 0; i < 500; i++) hub.handleInput(WHEEL_DOWN_BODY);
			const saturated = normalize(hub.render(220));
			hub.handleInput(WHEEL_DOWN_BODY);
			expect(normalize(hub.render(220))).toBe(saturated);

			// ...and scrolling back up restores the original window exactly.
			for (let i = 0; i < 500; i++) hub.handleInput(WHEEL_UP_BODY);
			expect(normalize(hub.render(220))).toBe(before);
		});

		test("wheel over the sidebar never changes the active scope or schedules refreshes", () => {
			vi.useFakeTimers();
			try {
				const refreshProvider = vi.fn(async () => {});
				const { hub } = createHub({
					models: [makeModel("prov-a", "model-a"), makeModel("prov-b", "model-b")],
					registry: { refreshProvider },
				});

				expect(normalize(hub.render(220))).toContain("All available models");

				// Two hops under the old wheel-selects behavior would land on a
				// provider scope; the viewport pan must leave the scope alone.
				for (let i = 0; i < 2; i++) hub.handleInput(WHEEL_DOWN_SIDEBAR);
				expect(normalize(hub.render(220))).toContain("All available models");
				for (let i = 0; i < 2; i++) hub.handleInput(WHEEL_UP_SIDEBAR);
				expect(normalize(hub.render(220))).toContain("All available models");

				// No scope change means no provider auto-refresh either.
				vi.advanceTimersByTime(200); // past the 120ms provider-refresh debounce
				expect(refreshProvider).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		test("wheel in the roles view clamps at the top instead of wrapping to the bottom rows", () => {
			const { hub } = createHub({ models: [makeModel("test", "model-a")], scoped: true });

			hub.handleInput(UP); // All models → Roles
			hub.render(220); // establish mouse geometry
			for (let i = 0; i < 4; i++) hub.handleInput(WHEEL_UP_BODY); // cursor stays on the first role
			hub.handleInput("\n"); // dive into the rows
			hub.handleInput("\n"); // activate the cursor row
			expect(normalize(hub.render(220))).toContain("Assigning DEFAULT");
		});
	});

	describe("provider scopes and search", () => {
		test("search inside a provider scope keeps that provider's model (#4522)", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customGlm = makeModel("custom-provider", "glm-5.2");
			const { hub } = createHub({ models: [openrouterGlm, customGlm] });
			installTestTheme();

			// Scope-hop: All models → custom-provider → openrouter.
			hub.handleInput(DOWN);
			hub.handleInput(DOWN);
			expect(normalize(hub.render(220))).toContain("openrouter ·");

			for (const ch of "glm-5.2") hub.handleInput(ch);
			hub.handleInput("\n");

			// The role strip opened for the provider-scoped match, not the
			// identically named custom-provider model.
			expect(footerLine(hub.render(220))).toContain("z-ai/glm-5.2 →");
		});

		test("search on All models spans every provider", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customGlm = makeModel("custom-provider", "glm-5.2");
			const { hub } = createHub({ models: [openrouterGlm, customGlm] });
			installTestTheme();

			for (const ch of "glm") hub.handleInput(ch);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("openrouter/z-ai/glm-5.2");
			expect(rendered).toContain("custom-provider/glm-5.2");
		});

		test("a provider scope that loses every match falls back to All models", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customGlm = makeModel("custom-provider", "glm-5.2");
			const { hub } = createHub({ models: [openrouterGlm, customGlm] });
			installTestTheme();

			hub.handleInput(DOWN);
			hub.handleInput(DOWN); // openrouter scope
			for (const ch of "does-not-exist") hub.handleInput(ch);

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("All available models");
			expect(rendered).toContain("No matching models");
		});

		test("scope hop skips providers without matches while searching", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customOther = makeModel("custom-provider", "different-model");
			const { hub } = createHub({ models: [openrouterGlm, customOther] });
			installTestTheme();

			for (const ch of "z-ai") hub.handleInput(ch);
			hub.handleInput(DOWN); // skips custom-provider (0 matches), lands on openrouter
			expect(normalize(hub.render(220))).toContain("openrouter ·");
		});

		test("providers with matches float to the top of the sidebar while searching", () => {
			const noMatch = makeModel("aaa-provider", "different-model");
			const withMatch = makeModel("zzz-provider", "target-model");
			const { hub } = createHub({ models: [noMatch, withMatch] });
			installTestTheme();

			// Sidebar cell = the first `│`-delimited column of each split row;
			// body rows may also mention provider names, so scope the check.
			const sidebarIndexOf = (provider: string): number =>
				hub
					.render(220)
					.map(line => stripVTControlCharacters(line).split("│")[1] ?? "")
					.findIndex(cell => cell.includes(provider));

			expect(sidebarIndexOf("aaa-provider")).toBeLessThan(sidebarIndexOf("zzz-provider"));

			for (const ch of "target") hub.handleInput(ch);
			expect(sidebarIndexOf("zzz-provider")).toBeLessThan(sidebarIndexOf("aaa-provider"));

			// Clearing the query restores the alphabetical order.
			hub.handleInput("\x1b");
			expect(sidebarIndexOf("aaa-provider")).toBeLessThan(sidebarIndexOf("zzz-provider"));
		});

		test("Escape clears an active query before closing the hub", () => {
			const model = makeModel("test", "escape-model");
			const { hub, onCancel } = createHub({ models: [model] });
			installTestTheme();

			for (const ch of "esc") hub.handleInput(ch);
			hub.handleInput("\x1b");
			expect(onCancel).not.toHaveBeenCalled();
			hub.handleInput("\x1b");
			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		test("left/right arrows switch between the sidebar and the model list", () => {
			const modelA = makeModel("prov-a", "model-a");
			const modelB = makeModel("prov-b", "model-b");
			const { hub } = createHub({ models: [modelA, modelB] });
			installTestTheme();

			// Right enters list mode: Down now moves the model selection, the
			// scope stays on All models.
			hub.handleInput("\x1b[C");
			hub.handleInput(DOWN);
			expect(normalize(hub.render(220))).toContain("All available models");

			// Left returns to the sidebar: Down hops to the first provider.
			hub.handleInput(LEFT);
			hub.handleInput(DOWN);
			expect(normalize(hub.render(220))).toContain("prov-a ·");
		});
	});

	describe("provider refresh lifecycle", () => {
		test("auto-refreshes a provider once per process; F5 forces a re-fetch", async () => {
			const model = makeModel("prov-a", "model-a");
			const refreshProvider = vi.fn(async () => {});
			const { hub } = createHub({
				models: [model],
				registry: { refreshProvider },
			});
			installTestTheme();

			// Real waits: the hub debounces provider refreshes with a real
			// 120ms setTimeout (no injection seam), and the fetch completion is
			// a promise chain — fake timers cannot drive the mixed path.
			hub.handleInput(DOWN); // All models → prov-a, schedules the refresh
			await Bun.sleep(140);
			expect(refreshProvider).toHaveBeenCalledTimes(1);
			expect(refreshProvider).toHaveBeenCalledWith("prov-a", "online");

			hub.handleInput(UP); // back to All models
			hub.handleInput(DOWN); // revisit prov-a
			await Bun.sleep(140);
			// Lifetime guard: revisiting must not re-fetch.
			expect(refreshProvider).toHaveBeenCalledTimes(1);

			hub.handleInput("\x1b[15~"); // F5
			await Bun.sleep(140);
			expect(refreshProvider).toHaveBeenCalledTimes(2);
		});

		test("shows a refreshing status while the provider fetch is in flight", async () => {
			const model = makeModel("prov-b", "model-b");
			const gate = Promise.withResolvers<void>();
			const { hub } = createHub({
				models: [model],
				registry: { refreshProvider: () => gate.promise },
			});
			installTestTheme();

			hub.handleInput(DOWN);
			await Bun.sleep(140);
			expect(normalize(hub.render(220))).toContain("refreshing model list");

			gate.resolve();
			await Bun.sleep(0);
			expect(normalize(hub.render(220))).not.toContain("refreshing model list");
		});
	});

	describe("locked providers", () => {
		test("catalog providers without credentials appear locked and forward to login", () => {
			const anthropicModel = makeModel("anthropic", "claude-locked-test");
			const { hub, onLoginRequest } = createHub({
				models: [anthropicModel],
				registry: { getAvailable: () => [] },
			});
			installTestTheme();

			hub.handleInput(DOWN); // All models → locked anthropic (separator skipped)
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("anthropic has no credentials configured");
			expect(rendered).toContain("claude-locked-test");

			hub.handleInput("\n");
			expect(onLoginRequest).toHaveBeenCalledWith("anthropic");
		});
	});

	describe("presets view", () => {
		test("lists a Presets scope and shows the presets header", () => {
			const model = makeModel("test", "worker-model");
			const { hub } = createHub({ models: [model], scoped: true });
			installTestTheme();

			expect(normalize(hub.render(220))).toContain("Presets");
			hub.handleInput(UP); // All models → Roles
			hub.handleInput(UP); // Roles → Presets
			expect(normalize(hub.render(220))).toContain("Model presets");
			expect(footerLine(hub.render(220))).toContain("→ presets");
		});

		test("saves the current models as a named preset and marks it active", () => {
			const model = makeModel("test", "worker-model");
			const settings = Settings.isolated({ modelRoles: { default: "test/worker-model" } });
			const { hub, onSavePreset } = createHub({ models: [model], scoped: true, settings });
			installTestTheme();

			hub.handleInput(UP); // → Roles
			hub.handleInput(UP); // → Presets
			hub.handleInput("\n"); // dive; cursor on "+ Save current as preset…"
			hub.handleInput("\n"); // open the name strip
			expect(footerLine(hub.render(220))).toContain("Preset name:");
			for (const ch of "fast") hub.handleInput(ch);
			hub.handleInput("\n"); // submit

			expect(onSavePreset).toHaveBeenCalledTimes(1);
			expect(onSavePreset.mock.calls[0]?.[0]).toBe("fast");
			expect(onSavePreset.mock.calls[0]?.[1]?.roles?.default).toBe("test/worker-model");

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("fast");
			expect(rendered).toContain("matches current"); // the saved preset equals the current settings
		});

		test("loads a saved preset, applying its roles", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				modelRoles: { default: "test/model-a" },
				modelPresets: { deep: { roles: { default: "test/model-b" } } },
			});
			const { hub, onApplyPreset } = createHub({ models: [a, b], scoped: true, settings });
			installTestTheme();

			hub.handleInput(UP); // → Roles
			hub.handleInput(UP); // → Presets
			hub.handleInput("\n"); // dive; cursor on "deep"
			hub.handleInput("\n"); // load it

			expect(onApplyPreset).toHaveBeenCalledTimes(1);
			expect(onApplyPreset.mock.calls[0]?.[0]).toBe("deep");
			expect(settings.get("modelRoles").default).toBe("test/model-b");
		});

		test("x deletes the selected preset", () => {
			const model = makeModel("test", "worker-model");
			const settings = Settings.isolated({
				modelPresets: {
					alpha: { roles: { default: "test/worker-model" } },
					bravo: { roles: { smol: "test/worker-model" } },
				},
			});
			const { hub, onDeletePreset } = createHub({ models: [model], scoped: true, settings });
			installTestTheme();

			hub.handleInput(UP); // → Roles
			hub.handleInput(UP); // → Presets
			hub.handleInput("\n"); // dive; cursor on "alpha" (sorted first)
			hub.handleInput("x"); // arm the delete confirm
			expect(normalize(hub.render(220))).toContain("press x again"); // armed hint
			expect(onDeletePreset).not.toHaveBeenCalled();
			hub.handleInput("x"); // confirm — delete alpha

			expect(onDeletePreset).toHaveBeenCalledWith("alpha");
			expect(normalize(hub.render(220))).not.toContain("alpha");
		});

		test("keyboard nav into Presets cancels an active assignment", () => {
			const model = makeModel("test", "worker-model");
			const settings = Settings.isolated({ modelRoles: { default: "test/worker-model" } });
			const { hub } = createHub({ models: [model], scoped: true, settings });
			installTestTheme();

			hub.handleInput(UP); // All models → Roles
			hub.handleInput("\n"); // dive into the roles rows
			hub.handleInput("\n"); // Enter on the default role → begin assigning a model
			expect(normalize(hub.render(220))).toContain("Assigning"); // the model browser is up

			hub.handleInput(UP); // scope focus: hop the sidebar up into Presets
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("Model presets"); // the presets list is shown
			expect(rendered).not.toContain("Assigning"); // the assignment was cancelled
		});

		test("keeps the selected preset visible when the list exceeds the viewport", () => {
			const model = makeModel("test", "worker-model");
			const modelPresets: Record<string, { roles: { default: string } }> = {};
			for (let i = 0; i < 50; i++) {
				modelPresets[`preset-${String(i).padStart(2, "0")}`] = { roles: { default: "test/worker-model" } };
			}
			const settings = Settings.isolated({ modelPresets });
			const { hub } = createHub({ models: [model], scoped: true, settings });
			installTestTheme();

			hub.handleInput(UP); // → Roles
			hub.handleInput(UP); // → Presets
			hub.handleInput("\n"); // dive; cursor on "preset-00"
			for (let i = 0; i < 45; i++) hub.handleInput(DOWN); // page toward the end

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("preset-45"); // the selected row scrolled into view
			expect(rendered).not.toContain("preset-00"); // the earliest row scrolled out
		});

		test("rejects an invalid preset name and keeps the strip open", () => {
			const model = makeModel("test", "worker-model");
			const settings = Settings.isolated({ modelRoles: { default: "test/worker-model" } });
			const { hub, onSavePreset } = createHub({ models: [model], scoped: true, settings });
			installTestTheme();

			hub.handleInput(UP); // → Roles
			hub.handleInput(UP); // → Presets
			hub.handleInput("\n"); // dive; cursor on "+ Save current as preset…"
			hub.handleInput("\n"); // open the name strip
			expect(footerLine(hub.render(220))).toContain("Preset name:");
			for (const ch of "1bad") hub.handleInput(ch); // starts with a digit — invalid
			hub.handleInput("\n"); // submit

			expect(onSavePreset).not.toHaveBeenCalled();
			const footer = footerLine(hub.render(220));
			expect(footer).toContain("Preset name:"); // the strip stays open
			expect(footer).toContain("start with a letter"); // the error explains the rule
		});

		test("ignores a repeated load while one is in flight", async () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				modelRoles: { default: "test/model-a" },
				modelPresets: { deep: { roles: { default: "test/model-b" } } },
			});
			let resolveApply: (() => void) | undefined;
			const onApplyPreset = vi.fn(
				() =>
					new Promise<PresetApplyResult>(resolve => {
						resolveApply = () => resolve({ applied: true });
					}),
			);
			const { hub } = createHub({ models: [a, b], scoped: true, settings, callbacks: { onApplyPreset } });
			installTestTheme();

			hub.handleInput(UP); // → Roles
			hub.handleInput(UP); // → Presets
			hub.handleInput("\n"); // dive; cursor on "deep"
			hub.handleInput("\n"); // load it — apply is now in flight
			hub.handleInput("\n"); // repeat while busy — the guard ignores it
			expect(onApplyPreset).toHaveBeenCalledTimes(1);

			resolveApply?.(); // finish the in-flight apply
			await Promise.resolve();
			await Promise.resolve();

			hub.handleInput("\n"); // now free to apply again
			expect(onApplyPreset).toHaveBeenCalledTimes(2);
		});

		test("a synchronously-throwing onApplyPreset leaves the hub usable for a retry", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				modelRoles: { default: "test/model-a" },
				modelPresets: { deep: { roles: { default: "test/model-b" } } },
			});
			const onApplyPreset = vi.fn((): PresetApplyResult => {
				throw new Error("apply exploded");
			});
			const { hub } = createHub({ models: [a, b], scoped: true, settings, callbacks: { onApplyPreset } });
			installTestTheme();

			hub.handleInput(UP); // → Roles
			hub.handleInput(UP); // → Presets
			hub.handleInput("\n"); // dive; cursor on "deep"
			hub.handleInput("\n"); // load it — the callback throws synchronously
			expect(onApplyPreset).toHaveBeenCalledTimes(1);

			// The applying state must clear: a second attempt reaches the callback again.
			hub.handleInput("\n");
			expect(onApplyPreset).toHaveBeenCalledTimes(2);
		});

		test("a rejecting onApplyPreset promise clears the applying state for a retry", async () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				modelRoles: { default: "test/model-a" },
				modelPresets: { deep: { roles: { default: "test/model-b" } } },
			});
			let rejectApply: ((reason: Error) => void) | undefined;
			const onApplyPreset = vi.fn(
				() =>
					new Promise<PresetApplyResult>((_resolve, reject) => {
						rejectApply = reject;
					}),
			);
			const { hub } = createHub({ models: [a, b], scoped: true, settings, callbacks: { onApplyPreset } });
			installTestTheme();

			hub.handleInput(UP); // → Roles
			hub.handleInput(UP); // → Presets
			hub.handleInput("\n"); // dive; cursor on "deep"
			hub.handleInput("\n"); // load it — apply is now in flight
			expect(onApplyPreset).toHaveBeenCalledTimes(1);

			rejectApply?.(new Error("apply rejected")); // the in-flight apply fails
			await Promise.resolve();
			await Promise.resolve();

			// The applying state must clear: a second attempt reaches the callback again.
			hub.handleInput("\n");
			expect(onApplyPreset).toHaveBeenCalledTimes(2);
		});
	});
});
