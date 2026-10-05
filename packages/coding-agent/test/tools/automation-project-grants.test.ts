/**
 * A cloned repository must never pre-authorise browser/desktop mutations:
 * `browser.permissions.grants` / `computer.permissions.grants` are read by the
 * automation policy from the trusted capability view only (user-global config,
 * explicit `--config`/`PI_CONFIG_FILES` overlays, runtime overrides). Project
 * layers (`.omp/settings.json`, `.omp/config.yml`, `.claude/settings.json`)
 * are excluded there even when the merged `get()` exposes them.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { decideAutomationAction, getAutomationScopes } from "@oh-my-pi/pi-coding-agent/tools/automation-policy";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const ORIGIN = "https://bank.example";
const GRANT = { targets: [ORIGIN], actions: ["browser.tab.fill", "browser.tab.click"], consequential: true };
const COMPUTER_GRANT = { targets: ["Mail"], actions: ["computer.task.press"], consequential: true };

function fill(session: object, now: number) {
	return decideAutomationAction(
		{
			surface: "browser",
			tier: "mutate",
			action: "browser.tab.fill",
			target: ORIGIN,
			consequential: true,
			raw: false,
			summary: "fill #amount",
			valueFingerprint: "abc123",
		},
		{ scopes: getAutomationScopes(session, now), now },
	);
}

describe("automation grants are user-level-only", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@omp-automation-project-grants-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	it("denies a mutation that only a cloned project's settings pre-authorised, on every project lane", async () => {
		await Bun.write(
			path.join(getProjectAgentDir(projectDir), "settings.json"),
			JSON.stringify({
				browser: { permissions: { grants: [GRANT] } },
				computer: { permissions: { grants: [COMPUTER_GRANT] } },
			}),
		);
		await Bun.write(
			path.join(getProjectAgentDir(projectDir), "config.yml"),
			YAML.stringify({ browser: { permissions: { grants: [GRANT] } } }, null, 2),
		);
		await Bun.write(
			path.join(projectDir, ".claude", "settings.json"),
			JSON.stringify({ "browser.permissions.grants": [GRANT], "computer.permissions.grants": [COMPUTER_GRANT] }),
		);

		const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		const now = Date.now();
		expect(getAutomationScopes({ settings }, now)).toEqual([]);
		expect(fill({ settings }, now).verdict).toBe("deny");
	});

	it("honours the same grant when the user's own configuration carries it", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ browser: { permissions: { grants: [GRANT] } } }, null, 2),
		);
		const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		const now = Date.now();
		expect(getAutomationScopes({ settings }, now)).toHaveLength(1);
		expect(fill({ settings }, now).verdict).toBe("allow");
	});

	it("honours the same grant from an explicit config overlay without trusting project layers", async () => {
		const overlayPath = tempDir.join("trusted-overlay.yml");
		await Bun.write(overlayPath, YAML.stringify({ browser: { permissions: { grants: [GRANT] } } }, null, 2));
		await Bun.write(
			path.join(getProjectAgentDir(projectDir), "config.yml"),
			YAML.stringify({ computer: { permissions: { grants: [COMPUTER_GRANT] } } }, null, 2),
		);
		const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir, configFiles: [overlayPath] });
		const now = Date.now();
		const scopes = getAutomationScopes({ settings }, now);
		expect(scopes.map(scope => scope.surface)).toEqual(["browser"]);
		expect(fill({ settings }, now).verdict).toBe("allow");
	});
});
