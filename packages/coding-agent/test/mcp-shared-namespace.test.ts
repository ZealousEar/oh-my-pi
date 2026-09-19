/**
 * Shared managed-MCP-OAuth namespace (`OMP_SHARED_MCP_PROFILES`): the listed
 * profiles are channels of one user and share one credential per server URL.
 * Contracts: shared mode mints the url-keyed id every build parses back to the
 * URL; lookup precedence is url-keyed → own profile → sibling channel rows,
 * a sibling row minted for a different configured OAuth client is never
 * adopted; logout removes every channel's row but not a foreign profile's;
 * the env unset restores upstream profile-scoped behaviour; `/mcp reauth` and
 * `/mcp unauth` follow the same rules end to end, including a build that only
 * honours the config `auth.credentialId` pointer.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import {
	lookupMcpOAuthCredential,
	mcpOAuthCredentialIdsForServerUrl,
	removeManagedMcpOAuthCredentials,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-credentials";
import * as oauthFlow from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getConfigRootDir, getProjectDir, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { getActiveProfile, setProfile } from "@oh-my-pi/pi-utils/dirs";
import { createInteractiveModeContext, createMcpManagerStub } from "./helpers/interactive-mode-context";

const URL = "https://mcp.example.test/mcp?project_ref=abc";
const SHARED = "stock,daily-fork,dev-fork";
const AUTH_ERROR = new Error(
	'HTTP 401: {"authorization_url":"https://auth.example.com/authorize","token_url":"https://auth.example.com/token"}',
);
const cred = (clientId?: string) => ({
	type: "oauth" as const,
	access: "at",
	refresh: "rt",
	expires: Date.now() + 3_600_000,
	...(clientId ? { clientId } : {}),
});

let storage: AuthStorage;
let originalProfile: string | undefined;
let savedEnv: string | undefined;

function shared(profile: string): void {
	process.env.OMP_SHARED_MCP_PROFILES = SHARED;
	setProfile(profile);
}
function upstream(profile: string): void {
	delete process.env.OMP_SHARED_MCP_PROFILES;
	setProfile(profile);
}

beforeEach(async () => {
	originalProfile = getActiveProfile();
	savedEnv = process.env.OMP_SHARED_MCP_PROFILES;
	storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await storage.reload();
	shared("daily-fork");
});
afterEach(() => {
	storage.close();
	setProfile(originalProfile);
	if (savedEnv === undefined) delete process.env.OMP_SHARED_MCP_PROFILES;
	else process.env.OMP_SHARED_MCP_PROFILES = savedEnv;
});

describe("shared MCP OAuth namespace", () => {
	test("shared mode mints the url-keyed id that every build parses back to the server url", () => {
		const id = oauthFlow.mcpOAuthCredentialId(URL);
		expect(id).toBe(`mcp_oauth:${URL}`);
		expect(oauthFlow.mcpOAuthServerUrlFromCredentialId(id)).toBe(URL);
		// An explicit profile still yields the scoped form (used to address sibling rows).
		expect(oauthFlow.mcpOAuthCredentialId(URL, "dev-fork")).toBe(`mcp_oauth:profile:dev-fork:${URL}`);
	});

	test("lookup precedence is url-keyed, own profile, then sibling channels", () => {
		expect(mcpOAuthCredentialIdsForServerUrl(URL)).toEqual([
			`mcp_oauth:${URL}`,
			`mcp_oauth:profile:daily-fork:${URL}`,
			`mcp_oauth:profile:stock:${URL}`,
			`mcp_oauth:profile:dev-fork:${URL}`,
		]);
	});

	test("a sibling channel's row is adopted without a config pointer unless it belongs to another OAuth client", async () => {
		await storage.set(`mcp_oauth:profile:stock:${URL}`, cred("client-A"));
		expect(lookupMcpOAuthCredential(storage, { type: "http", url: URL })?.credentialId).toBe(
			`mcp_oauth:profile:stock:${URL}`,
		);
		expect(
			lookupMcpOAuthCredential(storage, { type: "http", url: URL, oauth: { clientId: "client-B" } }),
		).toBeUndefined();
		// The own-profile row is never filtered by the client guard.
		await storage.set(`mcp_oauth:profile:daily-fork:${URL}`, cred("client-A"));
		expect(
			lookupMcpOAuthCredential(storage, { type: "http", url: URL, oauth: { clientId: "client-B" } })?.credentialId,
		).toBe(`mcp_oauth:profile:daily-fork:${URL}`);
	});

	test("logout removes the url-keyed row and every shared channel's row but not a foreign profile's", async () => {
		await storage.set(`mcp_oauth:${URL}`, cred());
		await storage.set(`mcp_oauth:profile:stock:${URL}`, cred());
		await storage.set(`mcp_oauth:profile:dev-fork:${URL}`, cred());
		await storage.set(`mcp_oauth:profile:someone-else:${URL}`, cred());
		expect(
			await removeManagedMcpOAuthCredentials(storage, [
				...mcpOAuthCredentialIdsForServerUrl(URL),
				`mcp_oauth:profile:someone-else:${URL}`,
			]),
		).toBe(true);
		expect(storage.list().filter(id => id.startsWith("mcp_oauth:"))).toEqual([
			`mcp_oauth:profile:someone-else:${URL}`,
		]);
	});

	test("without the env the upstream profile-scoped behaviour is unchanged", () => {
		upstream("daily-fork");
		expect(oauthFlow.mcpOAuthCredentialId(URL)).toBe(`mcp_oauth:profile:daily-fork:${URL}`);
		expect(mcpOAuthCredentialIdsForServerUrl(URL)).toEqual([`mcp_oauth:profile:daily-fork:${URL}`]);
	});
});

describe("shared MCP OAuth through /mcp commands", () => {
	const originalProjectDir = getProjectDir();
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
	let projectDir = "";
	let agentDir = "";
	let configPath = "";

	function controller() {
		const mcpManager = createMcpManagerStub({ prepareConfig: vi.fn(async (config: MCPServerConfig) => config) });
		const ctx = createInteractiveModeContext({ session: { modelRegistry: { authStorage: storage } }, mcpManager });
		return { controller: new MCPCommandController(ctx), showError: ctx.showError };
	}
	async function savedAuth(): Promise<unknown> {
		const saved = (await Bun.file(configPath).json()) as { mcpServers: Record<string, { auth?: unknown }> };
		return saved.mcpServers.srv?.auth;
	}
	const mcpRows = () => storage.list().filter(id => id.startsWith("mcp_oauth:"));

	beforeAll(() => initTheme());
	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shared-mcp-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shared-mcp-agent-"));
		configPath = path.join(projectDir, ".mcp.json");
		setProjectDir(projectDir);
		setAgentDir(agentDir);
		await Bun.write(configPath, JSON.stringify({ mcpServers: { srv: { type: "http", url: URL } } }, null, 2));
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		setAgentDir(originalAgentDir ?? fallbackAgentDir);
		await fs.rm(projectDir, { recursive: true, force: true });
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	test("login in one channel, reauth in another, unauth from a pointer-only build", async () => {
		const login = vi
			.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login")
			.mockResolvedValue({ access: "a1", refresh: "r1", expires: Date.now() + 3_600_000 });
		// Login in daily-fork: url-keyed row, secret-free pointer in the project definition.
		let c = controller();
		await c.controller.handle("/mcp reauth srv");
		expect(c.showError).not.toHaveBeenCalled();
		expect(storage.get(`mcp_oauth:${URL}`)).toMatchObject({ type: "oauth", access: "a1" });
		expect(mcpRows()).toEqual([`mcp_oauth:${URL}`]);
		expect(await savedAuth()).toMatchObject({ type: "oauth", credentialId: `mcp_oauth:${URL}` });
		expect(await savedAuth()).not.toHaveProperty("clientSecret");
		// A build without shared lookup (env unset, another profile) resolves it through the pointer alone.
		upstream("stock");
		const saved = (await Bun.file(configPath).json()) as { mcpServers: Record<string, MCPServerConfig> };
		expect(lookupMcpOAuthCredential(storage, saved.mcpServers.srv)?.credentialId).toBe(`mcp_oauth:${URL}`);
		// Reauth in dev-fork overwrites the same row; no second row appears.
		shared("dev-fork");
		login.mockResolvedValue({ access: "a2", refresh: "r2", expires: Date.now() + 3_600_000 });
		c = controller();
		await c.controller.handle("/mcp reauth srv");
		expect(c.showError).not.toHaveBeenCalled();
		expect(storage.get(`mcp_oauth:${URL}`)).toMatchObject({ access: "a2" });
		expect(mcpRows()).toEqual([`mcp_oauth:${URL}`]);
		// Unauth from the pointer-only build deletes the shared row: a logout is a logout everywhere.
		upstream("stock");
		c = controller();
		await c.controller.handle("/mcp unauth srv");
		expect(c.showError).not.toHaveBeenCalled();
		expect(mcpRows()).toEqual([]);
	});

	test("a profile-scoped login made by an upstream-mode build is adopted and can be revoked by a shared channel", async () => {
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "s1",
			refresh: "sr1",
			expires: Date.now() + 3_600_000,
		});
		upstream("stock");
		let c = controller();
		await c.controller.handle("/mcp reauth srv");
		expect(storage.get(`mcp_oauth:profile:stock:${URL}`)).toMatchObject({ access: "s1" });
		// Definition-only entry stays clean in upstream mode.
		expect(await savedAuth()).toBeUndefined();
		shared("daily-fork");
		expect(lookupMcpOAuthCredential(storage, { type: "http", url: URL })?.credentialId).toBe(
			`mcp_oauth:profile:stock:${URL}`,
		);
		c = controller();
		await c.controller.handle("/mcp unauth srv");
		expect(c.showError).not.toHaveBeenCalled();
		expect(mcpRows()).toEqual([]);
	});
});
