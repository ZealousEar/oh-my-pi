/**
 * Shared managed-MCP-OAuth namespace (`OMP_SHARED_MCP_PROFILES`): the listed
 * profiles are channels of one user and share one credential per server URL.
 * Contracts: shared mode mints the url-keyed id every build parses back to the
 * URL; lookup precedence is url-keyed → own profile → sibling channel rows;
 * the credential-embedded DCR client wins over stale config refresh material;
 * recorded resources, auth-server origins, and scopes cannot contradict the
 * request; logout removes every channel's row but not a foreign profile's; the
 * env unset restores upstream profile-scoped behaviour; `/mcp reauth` and
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
import { getConfigRootDir, getProjectDir, removeWithRetries, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { getActiveProfile, setProfile } from "@oh-my-pi/pi-utils/dirs";
import { asGlobalFetch } from "./helpers/fetch-mock";
import { createInteractiveModeContext, createMcpManagerStub } from "./helpers/interactive-mode-context";

const URL = "https://mcp.example.test/mcp?project_ref=abc";
const SHARED = "stock,daily-fork,dev-fork";
const AUTH_ERROR = new Error(
	'HTTP 401: {"authorization_url":"https://auth.example.com/authorize","token_url":"https://auth.example.com/token"}',
);
const cred = (identity: { clientId?: string; resource?: string; scopes?: string; tokenUrl?: string } = {}) => ({
	type: "oauth" as const,
	access: "at",
	refresh: "rt",
	expires: Date.now() + 3_600_000,
	...identity,
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
const mcpRows = () =>
	storage.credentials
		.list()
		.map(row => row.provider)
		.filter(id => id.startsWith("mcp_oauth:"));

beforeEach(async () => {
	originalProfile = getActiveProfile();
	savedEnv = process.env.OMP_SHARED_MCP_PROFILES;
	storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await storage.credentials.reload();
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

	test("a url-keyed DCR row keeps its embedded client when config carries another profile's client", async () => {
		await storage.credentials.set(
			`mcp_oauth:${URL}`,
			cred({
				clientId: "credential-dcr-client",
				resource: "https://resource.example.test",
				tokenUrl: "https://auth.example.test/oauth/token",
			}),
		);
		expect(
			lookupMcpOAuthCredential(storage, {
				type: "http",
				url: URL,
				auth: {
					type: "oauth",
					clientId: "other-profile-client",
					resource: "https://resource.example.test",
					tokenUrl: "https://auth.example.test/token",
				},
			})?.credentialId,
		).toBe(`mcp_oauth:${URL}`);
	});

	test("a url-keyed legacy row without recorded resource identity remains usable", async () => {
		await storage.credentials.set(`mcp_oauth:${URL}`, cred());
		expect(
			lookupMcpOAuthCredential(storage, {
				type: "http",
				url: URL,
				auth: { type: "oauth", resource: "https://resource.example.test" },
			})?.credentialId,
		).toBe(`mcp_oauth:${URL}`);
	});

	test("a sibling row for a different resource is not exposed to the request", async () => {
		await storage.credentials.set(
			`mcp_oauth:profile:stock:${URL}`,
			cred({ resource: "https://other-resource.example.test" }),
		);
		expect(
			lookupMcpOAuthCredential(storage, {
				type: "http",
				url: URL,
				auth: { type: "oauth", resource: "https://resource.example.test" },
			}),
		).toBeUndefined();
	});

	test("a pointer row for a different resource is rejected even when the config names it", async () => {
		await storage.credentials.set(`mcp_oauth:${URL}`, cred({ resource: "https://other-resource.example.test" }));
		expect(
			lookupMcpOAuthCredential(storage, {
				type: "http",
				url: URL,
				auth: { type: "oauth", credentialId: `mcp_oauth:${URL}`, resource: "https://resource.example.test" },
			}),
		).toBeUndefined();
	});

	test("token endpoints on the same authorization-server origin are compatible", async () => {
		await storage.credentials.set(`mcp_oauth:${URL}`, cred({ tokenUrl: "https://auth.example.test/oauth/token" }));
		expect(
			lookupMcpOAuthCredential(storage, {
				type: "http",
				url: URL,
				auth: { type: "oauth", tokenUrl: "https://auth.example.test/token-v2" },
			})?.credentialId,
		).toBe(`mcp_oauth:${URL}`);
	});

	test("a credential from a different authorization-server origin is not exposed", async () => {
		await storage.credentials.set(`mcp_oauth:${URL}`, cred({ tokenUrl: "https://auth-a.example.test/token" }));
		expect(
			lookupMcpOAuthCredential(storage, {
				type: "http",
				url: URL,
				auth: { type: "oauth", tokenUrl: "https://auth-b.example.test/token" },
			}),
		).toBeUndefined();
	});

	test("a credential whose token endpoint cannot be parsed is not exposed", async () => {
		await storage.credentials.set(`mcp_oauth:${URL}`, cred({ tokenUrl: "not a url" }));
		expect(
			lookupMcpOAuthCredential(storage, {
				type: "http",
				url: URL,
				auth: { type: "oauth", tokenUrl: "https://auth.example.test/token" },
			}),
		).toBeUndefined();
	});

	test("a recorded granted scope must cover every scope required by the server", async () => {
		await storage.credentials.set(`mcp_oauth:${URL}`, cred({ scopes: "openid profile offline_access" }));
		expect(
			lookupMcpOAuthCredential(storage, { type: "http", url: URL, oauth: { scope: "profile openid" } })
				?.credentialId,
		).toBe(`mcp_oauth:${URL}`);
		expect(
			lookupMcpOAuthCredential(storage, { type: "http", url: URL, oauth: { scope: "profile email" } }),
		).toBeUndefined();
	});

	test("default is a resolvable sibling when the shared profile list includes it", async () => {
		process.env.OMP_SHARED_MCP_PROFILES = "stock,daily-fork,dev-fork,default";
		await storage.credentials.set(`mcp_oauth:profile:default:${URL}`, cred());
		expect(lookupMcpOAuthCredential(storage, { type: "http", url: URL })?.credentialId).toBe(
			`mcp_oauth:profile:default:${URL}`,
		);
	});

	test("a profile outside the shared list is never resolved", async () => {
		await storage.credentials.set(`mcp_oauth:profile:someone-else:${URL}`, cred());
		expect(lookupMcpOAuthCredential(storage, { type: "http", url: URL })).toBeUndefined();
		expect(
			lookupMcpOAuthCredential(storage, {
				type: "http",
				url: URL,
				auth: { type: "oauth", credentialId: `mcp_oauth:profile:someone-else:${URL}` },
			}),
		).toBeUndefined();
	});

	test("logout removes the url-keyed row and every shared channel's row but not a foreign profile's", async () => {
		await storage.credentials.set(`mcp_oauth:${URL}`, cred());
		await storage.credentials.set(`mcp_oauth:profile:stock:${URL}`, cred());
		await storage.credentials.set(`mcp_oauth:profile:dev-fork:${URL}`, cred());
		await storage.credentials.set(`mcp_oauth:profile:someone-else:${URL}`, cred());
		expect(
			await removeManagedMcpOAuthCredentials(storage, [
				...mcpOAuthCredentialIdsForServerUrl(URL),
				`mcp_oauth:profile:someone-else:${URL}`,
			]),
		).toBe(true);
		expect(mcpRows()).toEqual([`mcp_oauth:profile:someone-else:${URL}`]);
	});

	test("without the env the upstream profile-scoped behaviour is unchanged", async () => {
		upstream("daily-fork");
		expect(oauthFlow.mcpOAuthCredentialId(URL)).toBe(`mcp_oauth:profile:daily-fork:${URL}`);
		expect(mcpOAuthCredentialIdsForServerUrl(URL)).toEqual([`mcp_oauth:profile:daily-fork:${URL}`]);
		// A sibling's row is neither resolved nor removable.
		await storage.credentials.set(`mcp_oauth:profile:stock:${URL}`, cred());
		expect(lookupMcpOAuthCredential(storage, { type: "http", url: URL })).toBeUndefined();
		expect(await removeManagedMcpOAuthCredentials(storage, [`mcp_oauth:profile:stock:${URL}`])).toBe(false);
	});

	test("an empty shared profile list means upstream behaviour", () => {
		process.env.OMP_SHARED_MCP_PROFILES = " , ";
		expect(oauthFlow.sharedMcpCredentialProfiles()).toBeUndefined();
		expect(oauthFlow.mcpOAuthCredentialId(URL)).toBe(`mcp_oauth:profile:daily-fork:${URL}`);
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
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("login in one channel, reauth in another, unauth from a pointer-only build", async () => {
		const login = vi
			.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login")
			.mockResolvedValue({ access: "a1", refresh: "r1", expires: Date.now() + 3_600_000 });
		// Login in daily-fork: url-keyed row, secret-free pointer in the project definition.
		let c = controller();
		await c.controller.handle("/mcp reauth srv");
		expect(c.showError).not.toHaveBeenCalled();
		expect(storage.credentials.get(`mcp_oauth:${URL}`)).toMatchObject({ type: "oauth", access: "a1" });
		expect(mcpRows()).toEqual([`mcp_oauth:${URL}`]);
		expect(await savedAuth()).toMatchObject({ type: "oauth", credentialId: `mcp_oauth:${URL}` });
		expect(await savedAuth()).not.toHaveProperty("clientSecret");
		// A build without shared lookup (env unset, another profile) resolves it through the pointer alone.
		upstream("stock");
		const saved = (await Bun.file(configPath).json()) as { mcpServers: Record<string, MCPServerConfig> };
		expect(lookupMcpOAuthCredential(storage, saved.mcpServers.srv!)?.credentialId).toBe(`mcp_oauth:${URL}`);
		// Reauth in dev-fork overwrites the same row; no second row appears.
		shared("dev-fork");
		login.mockResolvedValue({ access: "a2", refresh: "r2", expires: Date.now() + 3_600_000 });
		c = controller();
		await c.controller.handle("/mcp reauth srv");
		expect(c.showError).not.toHaveBeenCalled();
		expect(storage.credentials.get(`mcp_oauth:${URL}`)).toMatchObject({ access: "a2" });
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
		expect(storage.credentials.get(`mcp_oauth:profile:stock:${URL}`)).toMatchObject({ access: "s1" });
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

	test("a login records the granted scopes so a channel needing more scope does not reuse the row", async () => {
		await Bun.write(
			configPath,
			JSON.stringify({ mcpServers: { srv: { type: "http", url: URL, oauth: { scope: "read" } } } }, null, 2),
		);
		// The token endpoint restates the grant; a server that omits `scope` grants what was requested.
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				await this.generateAuthUrl("state", "http://127.0.0.1/callback");
				return await this.exchangeToken("authorization-code", "state", "http://127.0.0.1/callback");
			},
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async input => {
				const url = String(input instanceof Request ? input.url : input);
				if (url === "https://auth.example.com/token") {
					return Response.json({ access_token: "scoped", refresh_token: "r", expires_in: 3600, scope: "read" });
				}
				return new Response("not found", { status: 404 });
			}),
		);
		const c = controller();
		await c.controller.handle("/mcp reauth srv");
		expect(c.showError).not.toHaveBeenCalled();
		expect(storage.credentials.get(`mcp_oauth:${URL}`)).toMatchObject({ access: "scoped", scopes: "read" });
		expect(
			lookupMcpOAuthCredential(storage, { type: "http", url: URL, oauth: { scope: "read" } })?.credentialId,
		).toBe(`mcp_oauth:${URL}`);
		expect(
			lookupMcpOAuthCredential(storage, { type: "http", url: URL, oauth: { scope: "read write" } }),
		).toBeUndefined();
	});
});
