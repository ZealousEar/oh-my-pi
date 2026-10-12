import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import "@oh-my-pi/pi-coding-agent/config/all-settings";
import { type AnySetting, lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

import {
	cfgBashOutputPruning,
	cfgBashOutputPruningMaxSegments,
	cfgBashOutputPruningMinTokens,
	cfgBashOutputPruningMode,
} from "@oh-my-pi/pi-coding-agent/exec/settings";
import {
	cfgSkillsRecommendCacheEntries,
	cfgSkillsRecommendEnabled,
	cfgSkillsRecommendMaxCandidatesPerRequest,
	cfgSkillsRecommendMinRelevance,
} from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import {
	cfgCompactionSemanticShakeMaxRegionsPerCall,
	cfgCompactionSemanticShakeProtectTokens,
	cfgReduction,
	cfgReductionEgress,
	cfgReductionMaxCallsPerPass,
	cfgReductionMaxLatencyMs,
	cfgReductionTaskContextChars,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import {
	cfgTaskHerdrKeepPane,
	cfgTaskHerdrPromptTimeoutMs,
	cfgTaskHerdrReadyTimeoutMs,
	cfgTaskHerdrSession,
	cfgTaskPaneBackend,
} from "@oh-my-pi/pi-coding-agent/task/settings";
import {
	cfgBrowserPermissionsGrants,
	cfgBrowserTabsAbandonedIdleHours,
	cfgBrowserTaskAllowConsequential,
	cfgBrowserTaskDeadlineSec,
	cfgBrowserTaskMaxActions,
	cfgBrowserTaskMaxCalls,
} from "@oh-my-pi/pi-coding-agent/tools/browser/settings";
import {
	cfgAsyncNoProgressWarnMs,
	cfgComputerCuaTelemetry,
	cfgComputerDriverBin,
	cfgComputerPermissionsGrants,
	cfgComputerTaskAllowConsequential,
	cfgComputerTaskBackend,
	cfgComputerTaskDeadlineSec,
	cfgComputerTaskMaxActions,
	cfgComputerTaskMaxCalls,
	cfgSemanticFindContextLines,
	cfgSemanticFindMaxBytesPerFile,
	cfgSemanticFindMaxFiles,
	cfgSemanticFindMaxPassages,
	cfgSemanticFindPassagesPerRequest,
	cfgToolsWallCapMs,
} from "@oh-my-pi/pi-coding-agent/tools/settings";

/** One fork key contract: the r13 default and, for enums, the closed value set. */
interface ForkKey {
	handle: AnySetting;
	id: string;
	default: unknown;
	values?: readonly string[];
	/** A non-default configured value that must round-trip through the typed registry. */
	sample: unknown;
}

const GRANT = {
	targets: ["https://example.com"],
	actions: ["click"],
	consequential: false,
	ttlMinutes: 30,
};

const FORK_KEYS: readonly ForkKey[] = [
	{ handle: cfgAsyncNoProgressWarnMs, id: "async.noProgressWarnMs", default: 60_000, sample: 0 },
	{ handle: cfgToolsWallCapMs, id: "tools.wallCapMs", default: 3_600_000, sample: 0 },
	{
		handle: cfgBashOutputPruningMode,
		id: "bash.outputPruning.mode",
		default: "off",
		values: ["off", "deterministic", "semantic"],
		sample: "semantic",
	},
	{ handle: cfgBashOutputPruningMinTokens, id: "bash.outputPruning.minTokens", default: 1_500, sample: 100 },
	{ handle: cfgBashOutputPruningMaxSegments, id: "bash.outputPruning.maxSegments", default: 40, sample: 8 },
	{ handle: cfgBrowserPermissionsGrants, id: "browser.permissions.grants", default: [], sample: [GRANT] },
	{ handle: cfgBrowserTabsAbandonedIdleHours, id: "browser.tabs.abandonedIdleHours", default: 6, sample: 0 },
	{ handle: cfgBrowserTaskMaxActions, id: "browser.task.maxActions", default: 25, sample: 3 },
	{ handle: cfgBrowserTaskMaxCalls, id: "browser.task.maxCalls", default: 60, sample: 7 },
	{ handle: cfgBrowserTaskDeadlineSec, id: "browser.task.deadlineSec", default: 120, sample: 15 },
	{ handle: cfgBrowserTaskAllowConsequential, id: "browser.task.allowConsequential", default: false, sample: true },
	{
		handle: cfgCompactionSemanticShakeProtectTokens,
		id: "compaction.semanticShake.protectTokens",
		default: 16_000,
		sample: 4_000,
	},
	{
		handle: cfgCompactionSemanticShakeMaxRegionsPerCall,
		id: "compaction.semanticShake.maxRegionsPerCall",
		default: 12,
		sample: 2,
	},
	{
		handle: cfgComputerCuaTelemetry,
		id: "computer.cua.telemetry",
		default: "off",
		values: ["off", "driver"],
		sample: "driver",
	},
	{ handle: cfgComputerDriverBin, id: "computer.driverBin", default: undefined, sample: "/opt/cua/driver" },
	{ handle: cfgComputerPermissionsGrants, id: "computer.permissions.grants", default: [], sample: [GRANT] },
	{
		handle: cfgComputerTaskAllowConsequential,
		id: "computer.task.allowConsequential",
		default: false,
		sample: true,
	},
	{
		handle: cfgComputerTaskBackend,
		id: "computer.task.backend",
		default: "auto",
		values: ["auto", "native", "cua"],
		sample: "native",
	},
	{ handle: cfgComputerTaskDeadlineSec, id: "computer.task.deadlineSec", default: 120, sample: 30 },
	{ handle: cfgComputerTaskMaxActions, id: "computer.task.maxActions", default: 20, sample: 4 },
	{ handle: cfgComputerTaskMaxCalls, id: "computer.task.maxCalls", default: 50, sample: 9 },
	{
		handle: cfgReductionEgress,
		id: "reduction.egress",
		default: "off",
		values: ["off", "selected"],
		sample: "selected",
	},
	{ handle: cfgReductionMaxCallsPerPass, id: "reduction.maxCallsPerPass", default: 3, sample: 1 },
	{ handle: cfgReductionMaxLatencyMs, id: "reduction.maxLatencyMs", default: 4_000, sample: 500 },
	{ handle: cfgReductionTaskContextChars, id: "reduction.taskContextChars", default: 2_000, sample: 256 },
	{ handle: cfgSemanticFindContextLines, id: "semanticFind.contextLines", default: 2, sample: 5 },
	{ handle: cfgSemanticFindMaxBytesPerFile, id: "semanticFind.maxBytesPerFile", default: 262_144, sample: 1_024 },
	{ handle: cfgSemanticFindMaxFiles, id: "semanticFind.maxFiles", default: 24, sample: 3 },
	{ handle: cfgSemanticFindMaxPassages, id: "semanticFind.maxPassages", default: 2_000, sample: 50 },
	{ handle: cfgSemanticFindPassagesPerRequest, id: "semanticFind.passagesPerRequest", default: 200, sample: 20 },
	{ handle: cfgSkillsRecommendCacheEntries, id: "skills.recommend.cacheEntries", default: 64, sample: 1 },
	{ handle: cfgSkillsRecommendEnabled, id: "skills.recommend.enabled", default: true, sample: false },
	{
		handle: cfgSkillsRecommendMaxCandidatesPerRequest,
		id: "skills.recommend.maxCandidatesPerRequest",
		default: 200,
		sample: 10,
	},
	{ handle: cfgSkillsRecommendMinRelevance, id: "skills.recommend.minRelevance", default: 0.1, sample: 0.5 },
	{ handle: cfgTaskHerdrKeepPane, id: "task.herdr.keepPane", default: false, sample: true },
	{ handle: cfgTaskHerdrPromptTimeoutMs, id: "task.herdr.promptTimeoutMs", default: 600_000, sample: 1_000 },
	{ handle: cfgTaskHerdrReadyTimeoutMs, id: "task.herdr.readyTimeoutMs", default: 30_000, sample: 100 },
	{ handle: cfgTaskHerdrSession, id: "task.herdr.session", default: undefined, sample: "omp-tasks" },
	{
		handle: cfgTaskPaneBackend,
		id: "task.paneBackend",
		default: "native",
		values: ["auto", "native", "herdr"],
		sample: "herdr",
	},
];

describe("fork settings keys", () => {
	it("registers every fork key with its r13 default and resolves it through the settings API", () => {
		const settings = Settings.isolated();
		for (const key of FORK_KEYS) {
			expect(lookup(key.id), key.id).toBe(key.handle);
			expect(key.handle.id, key.id).toBe(key.id);
			expect(key.handle.get(settings), key.id).toEqual(key.default);
			expect(key.handle.provenance(settings), key.id).toBe("default");
			expect(key.handle.isConfigured(settings), key.id).toBe(false);
			if (key.values) expect(key.handle.enumValues, key.id).toEqual(key.values);
		}
	});

	it("round-trips a configured value for every fork key and rejects values outside an enum", () => {
		const overrides: Record<string, unknown> = {};
		for (const key of FORK_KEYS) overrides[key.id] = key.sample;
		const settings = Settings.isolated(overrides);
		for (const key of FORK_KEYS) {
			expect(key.handle.get(settings), key.id).toEqual(key.sample);
			expect(key.handle.provenance(settings), key.id).toBe("runtime");
		}
		for (const key of FORK_KEYS) {
			if (!key.values) continue;
			expect(() => Settings.isolated({ [key.id]: "not-a-value" }), key.id).toThrow();
		}
	});

	it("exposes the combined pruning and reduction policies as one snapshot each", () => {
		const settings = Settings.isolated({ "reduction.egress": "selected", "bash.outputPruning.mode": "semantic" });
		expect(cfgReduction.get(settings)).toEqual({
			egress: "selected",
			maxCallsPerPass: 3,
			maxLatencyMs: 4_000,
			taskContextChars: 2_000,
		});
		expect(cfgBashOutputPruning.get(settings)).toEqual({ mode: "semantic", minTokens: 1_500, maxSegments: 40 });
	});

	it("still rejects unknown setting ids, including near-misses of fork keys", () => {
		expect(() => Settings.isolated({ "tools.wallCap": 1 })).toThrow('Unknown setting "tools.wallCap"');
		expect(() => Settings.isolated({ "providers.typesafeModell": "jev-1.13.0" })).toThrow(
			'Unknown setting "providers.typesafeModell"',
		);
	});

	it("migrates the retired fork judgment keys instead of registering them", () => {
		// Superseded by the exact `modelRoles.judge` pin + empty judge chain
		// (test/config/legacy-judgment-migration.test.ts covers the mapping).
		const settings = Settings.isolated({
			"providers.typesafeModel": "jev-1.13.0",
			"providers.judgmentFallback": "none",
		});
		expect(settings.getModelRole("judge")).toBe("typesafe/jev-1.13.0");
		expect(lookup("providers.typesafeModel")).toBeUndefined();
		expect(lookup("providers.judgmentFallback")).toBeUndefined();
	});

	it("excludes project-discovered layers from the trusted capability view", async () => {
		const tempDir = TempDir.createSync("@pi-fork-settings-trusted-");
		try {
			const agentDir = tempDir.join("agent");
			const cwd = tempDir.join("project");
			fs.mkdirSync(agentDir, { recursive: true });
			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
			await Bun.write(
				path.join(agentDir, "config.yml"),
				YAML.stringify({ browser: { permissions: { grants: [GRANT] }, task: { maxActions: 9 } } }),
			);
			await Bun.write(
				path.join(cwd, ".omp", "config.yml"),
				YAML.stringify({ browser: { task: { maxActions: 1, allowConsequential: true } } }),
			);
			const settings = await Settings.loadReadOnly({ cwd, agentDir });
			// The merged view still honours the project layer for ordinary reads…
			expect(cfgBrowserTaskMaxActions.get(settings)).toBe(1);
			// …never for user-level-only keys (USER_LEVEL_ONLY_SETTINGS drops them from project layers)…
			expect(cfgBrowserTaskAllowConsequential.get(settings)).toBe(false);
			// …but the trusted view carries only user-owned layers (global, --config overlays, runtime).
			const trusted = settings.getTrustedCapabilitySettings();
			const browserOf = (raw: Record<string, unknown>) => raw.browser as { permissions: unknown; task: unknown };
			expect(browserOf(trusted).permissions).toEqual({ grants: [GRANT] });
			expect(browserOf(trusted).task).toEqual({ maxActions: 9 });

			cfgBrowserTaskAllowConsequential.override(settings, false);
			expect(browserOf(settings.getTrustedCapabilitySettings()).task).toEqual({
				maxActions: 9,
				allowConsequential: false,
			});
			// The trusted view is a snapshot: mutating it never reaches the instance.
			trusted.browser = {};
			expect(cfgBrowserTaskMaxActions.get(settings)).toBe(1);
		} finally {
			tempDir.removeSync();
		}
	});
});
