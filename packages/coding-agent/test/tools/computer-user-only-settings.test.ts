import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { dropUserLevelOnlySettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgComputerCuaTelemetry,
	cfgComputerDriverBin,
	cfgComputerEnabled,
	cfgComputerTaskAllowConsequential,
	cfgComputerTaskBackend,
	cfgComputerTaskMaxActions,
} from "@oh-my-pi/pi-coding-agent/tools/settings";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("user-level-only computer settings", () => {
	it("drops the desktop keys from a project document, nested or dotted, and keeps everything else", () => {
		const result = dropUserLevelOnlySettings(
			{
				computer: {
					enabled: true,
					driverBin: "./marker.sh",
					task: { allowConsequential: true, maxActions: 3, backend: "cua" },
					cua: { telemetry: "driver" },
				},
				"computer.driverBin": "scripts/x",
				autoResume: true,
			},
			"/proj/.omp/settings.json",
		);
		expect(result).toEqual({ computer: { task: { maxActions: 3 }, cua: {} }, autoResume: true });
	});

	describe("through layered Settings", () => {
		let settingsState: SettingsTestState | undefined;
		let tempDir: TempDir;
		let agentDir: string;
		let projectDir: string;

		beforeEach(() => {
			settingsState = beginSettingsTest();
			tempDir = TempDir.createSync("@omp-computer-user-only-");
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

		it("ignores a cloned repository's desktop settings while honouring the user's own", async () => {
			await Bun.write(
				path.join(getProjectAgentDir(projectDir), "settings.json"),
				JSON.stringify({
					computer: {
						enabled: true,
						driverBin: "./marker.sh",
						task: { allowConsequential: true, backend: "cua", maxActions: 3 },
						cua: { telemetry: "driver" },
					},
				}),
			);
			await Bun.write(
				path.join(agentDir, "config.yml"),
				YAML.stringify({ computer: { driverBin: "/opt/user/cua-driver", task: { backend: "native" } } }, null, 2),
			);
			const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
			expect(cfgComputerEnabled.get(settings)).toBe(false);
			expect(cfgComputerDriverBin.get(settings)).toBe("/opt/user/cua-driver");
			expect(cfgComputerTaskAllowConsequential.get(settings)).toBe(false);
			expect(cfgComputerTaskBackend.get(settings)).toBe("native");
			expect(cfgComputerCuaTelemetry.get(settings)).toBe("off");
			// Ordinary project keys still apply.
			expect(cfgComputerTaskMaxActions.get(settings)).toBe(3);
		});
	});
});
