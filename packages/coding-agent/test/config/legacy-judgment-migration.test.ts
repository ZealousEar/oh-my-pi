/**
 * The fork's `providers.typesafeModel` (exact native model) and
 * `providers.judgmentFallback: none` (fail closed) migrate onto the role
 * model without losing strictness: the pin becomes the literal
 * `modelRoles.judge` selector — never `typesafe/jev-latest` — and `none`
 * becomes an explicit empty `retry.fallbackChains.judge`, which `judgePin`
 * treats as "admit no substitute".
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { judgePin } from "@oh-my-pi/pi-coding-agent/judgment";
import { cfgDisplayShowTokenUsage } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("legacy fork judgment settings migration", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@omp-legacy-judgment-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	const configPath = () => path.join(agentDir, "config.yml");

	async function load(legacy: Record<string, unknown>): Promise<Settings> {
		await Bun.write(configPath(), YAML.stringify(legacy, null, 2));
		return Settings.init({ cwd: projectDir, agentDir });
	}

	async function saved(settings: Settings): Promise<Record<string, unknown>> {
		cfgDisplayShowTokenUsage.set(settings, true);
		await settings.flush();
		return YAML.parse(await Bun.file(configPath()).text()) as Record<string, unknown>;
	}

	it("migrates an exact TypeSafe pin with fail-closed fallback to the pin plus an empty judge chain", async () => {
		for (const legacy of [
			{ providers: { judgmentProvider: "typesafe", typesafeModel: "jev-1.13.0", judgmentFallback: "none" } },
			{
				"providers.judgmentProvider": "typesafe",
				"providers.typesafeModel": "jev-1.13.0",
				"providers.judgmentFallback": "none",
			},
			// `auto` provider with a pin and `none` is the same fail-closed configuration.
			{ providers: { typesafeModel: "typesafe/jev-1.13.0", judgmentFallback: "none" } },
		]) {
			const settings = await load(legacy);
			expect(cfgModelRoles.get(settings)).toEqual({ judge: "typesafe/jev-1.13.0" });
			expect(cfgRetryFallbackChains.get(settings)).toEqual({ judge: [] });
			expect(judgePin(settings)).toBe("typesafe/jev-1.13.0");

			const persisted = await saved(settings);
			expect(persisted.modelRoles).toEqual({ judge: "typesafe/jev-1.13.0" });
			expect((persisted.retry as Record<string, unknown>).fallbackChains).toEqual({ judge: [] });
			expect(persisted.providers).toBeUndefined();
			for (const key of ["providers.typesafeModel", "providers.judgmentFallback", "providers.judgmentProvider"]) {
				expect(Object.hasOwn(persisted, key)).toBe(false);
			}
		}
	});

	it("keeps a pin without fail-closed on the ordinary role chain, never rewriting it to jev-latest", async () => {
		const settings = await load({ providers: { typesafeModel: "jev-1.12", judgmentFallback: "llm" } });
		expect(cfgModelRoles.get(settings)).toEqual({ judge: "typesafe/jev-1.12" });
		expect(cfgRetryFallbackChains.get(settings)).toEqual({ judge: ["@tiny", "@smol", "@default"] });
		expect(judgePin(settings)).toBeUndefined();
	});

	it("fails closed on jev-latest when only the fallback was disabled", async () => {
		const settings = await load({ providers: { judgmentFallback: "none" } });
		expect(cfgModelRoles.get(settings)).toEqual({ judge: "typesafe/jev-latest" });
		expect(cfgRetryFallbackChains.get(settings)).toEqual({ judge: [] });
		expect(judgePin(settings)).toBe("typesafe/jev-latest");
	});

	it("drops the fork keys without touching an explicitly configured judge role", async () => {
		const settings = await load({
			modelRoles: { judge: "typesafe/jev-2.0" },
			retry: { fallbackChains: { judge: [] } },
			providers: { typesafeModel: "jev-1.13.0", judgmentFallback: "llm" },
		});
		expect(cfgModelRoles.get(settings)).toEqual({ judge: "typesafe/jev-2.0" });
		expect(cfgRetryFallbackChains.get(settings)).toEqual({ judge: [] });
		expect((await saved(settings)).providers).toBeUndefined();
	});

	it("ignores the fork keys when the legacy provider was llm", async () => {
		const settings = await load({
			providers: { judgmentProvider: "llm", typesafeModel: "jev-1.13.0", judgmentFallback: "none" },
		});
		expect(cfgModelRoles.get(settings)).toEqual({ judge: "@tiny" });
		expect(cfgRetryFallbackChains.get(settings)).toEqual({ judge: ["@smol", "@default"] });
	});
});
