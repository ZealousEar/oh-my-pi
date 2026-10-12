/**
 * Shared credential-marked settings (`OMP_SHARED_SECRETS_FILE`): with the variable set to a
 * config overlay every channel loads, a credential write lands in that overlay (mode 0600) instead
 * of the profile's config.yml, a shadowing profile-local copy is removed, unset/empty deletes the
 * key without leaving empty containers, hand-edited neighbours survive, non-credential settings and
 * the env-unset case keep upstream's profile-local behaviour, and a second channel loading the same
 * overlay observes the value.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cfgAuthBrokerToken, cfgAuthBrokerUrl } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { writeSharedSecret } from "@oh-my-pi/pi-coding-agent/config/shared-secrets";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { restoreEnvValue } from "../helpers/settings-test-state";

const ENV_KEYS = [
	"OMP_SHARED_SECRETS_FILE",
	"OMP_AUTH_BROKER_TOKEN",
	"OMP_AUTH_BROKER_URL",
	"PI_CONFIG_FILES",
] as const;

describe("shared credential-marked settings", () => {
	let testDir: string;
	let agentDir: string;
	let cwd: string;
	let sharedFile: string;
	const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	const readYaml = (file: string): unknown =>
		fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, "utf8")) : undefined;
	const globalConfig = () => readYaml(path.join(agentDir, "config.yml"));
	const load = (dir = agentDir) => Settings.loadIsolated({ cwd, agentDir: dir, configFiles: [sharedFile] });

	beforeEach(() => {
		resetSettingsForTest();
		for (const key of ENV_KEYS) {
			const value = process.env[key];
			if (value !== undefined) savedEnv[key] = value;
			restoreEnvValue(key, undefined);
		}
		testDir = path.join(os.tmpdir(), "test-shared-secrets", Snowflake.next());
		agentDir = path.join(testDir, "agent");
		cwd = path.join(testDir, "project");
		sharedFile = path.join(testDir, "shared", "credential-settings.yml");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		// The channel launchers create the overlay before listing it in PI_CONFIG_FILES.
		fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
		fs.writeFileSync(sharedFile, "");
		restoreEnvValue("OMP_SHARED_SECRETS_FILE", sharedFile);
	});

	afterEach(() => {
		resetSettingsForTest();
		AgentStorage.close();
		for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
		if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
	});

	it("routes a credential write to the shared overlay, not the profile config", async () => {
		const settings = await load();
		cfgAuthBrokerToken.set(settings, "shared-token");
		cfgAuthBrokerUrl.set(settings, "https://broker.example.test");
		expect(cfgAuthBrokerToken.get(settings)).toBe("shared-token");
		expect(cfgAuthBrokerToken.provenance(settings)).toBe("overlay");
		expect(cfgAuthBrokerUrl.provenance(settings)).toBe("global");
		await settings.flush();

		expect(readYaml(sharedFile)).toEqual({ auth: { broker: { token: "shared-token" } } });
		expect(fs.statSync(sharedFile).mode & 0o777).toBe(0o600);
		expect(globalConfig()).toEqual({ auth: { broker: { url: "https://broker.example.test" } } });

		// Another channel (its own profile dir) loading the same overlay sees the credential.
		const otherAgentDir = path.join(testDir, "other-agent");
		fs.mkdirSync(otherAgentDir, { recursive: true });
		const sibling = await load(otherAgentDir);
		expect(cfgAuthBrokerToken.get(sibling)).toBe("shared-token");
		expect(cfgAuthBrokerUrl.get(sibling)).toBeUndefined();
	});

	it("removes a shadowing profile-local copy when the credential moves to the overlay", async () => {
		fs.writeFileSync(path.join(agentDir, "config.yml"), "auth:\n  broker:\n    token: stale-local\n");
		const settings = await load();
		expect(cfgAuthBrokerToken.provenance(settings)).toBe("global");
		cfgAuthBrokerToken.set(settings, "fresh-shared");
		expect(cfgAuthBrokerToken.get(settings)).toBe("fresh-shared");
		expect(cfgAuthBrokerToken.provenance(settings)).toBe("overlay");
		await settings.flush();

		expect(readYaml(sharedFile)).toEqual({ auth: { broker: { token: "fresh-shared" } } });
		expect(globalConfig()).toEqual({});
	});

	it("unset and empty delete the key from the overlay and prune emptied containers", async () => {
		fs.writeFileSync(
			sharedFile,
			"# hand edit\nauth:\n  broker:\n    token: old\nmemory:\n  hindsight:\n    apiKey: keep\n",
		);
		const settings = await load();
		expect(cfgAuthBrokerToken.get(settings)).toBe("old");

		cfgAuthBrokerToken.unset(settings);
		expect(cfgAuthBrokerToken.get(settings)).toBeUndefined();
		await settings.flush();
		expect(readYaml(sharedFile)).toEqual({ memory: { hindsight: { apiKey: "keep" } } });

		cfgAuthBrokerToken.set(settings, "again");
		cfgAuthBrokerToken.set(settings, "");
		expect(cfgAuthBrokerToken.get(settings)).toBeUndefined();
		await settings.flush();
		expect(readYaml(sharedFile)).toEqual({ memory: { hindsight: { apiKey: "keep" } } });
	});

	it("keeps profile-local behaviour when OMP_SHARED_SECRETS_FILE is unset", async () => {
		restoreEnvValue("OMP_SHARED_SECRETS_FILE", undefined);
		const settings = await load();
		cfgAuthBrokerToken.set(settings, "local-token");
		expect(cfgAuthBrokerToken.provenance(settings)).toBe("global");
		await settings.flush();

		expect(fs.readFileSync(sharedFile, "utf8")).toBe("");
		expect(globalConfig()).toEqual({ auth: { broker: { token: "local-token" } } });
	});

	it("rejects an overlay that is not a mapping instead of clobbering it", async () => {
		fs.writeFileSync(sharedFile, "- not\n- a\n- mapping\n");
		await expect(writeSharedSecret(sharedFile, "auth.broker.token", "x")).rejects.toThrow("YAML mapping");
		expect(fs.readFileSync(sharedFile, "utf8")).toBe("- not\n- a\n- mapping\n");
	});
});
