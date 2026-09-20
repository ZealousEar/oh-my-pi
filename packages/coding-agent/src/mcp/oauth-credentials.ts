import { isDefinitiveOAuthFailure, REMOTE_REFRESH_SENTINEL, type StoredOAuthRefreshResult } from "@oh-my-pi/pi-ai";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { logger } from "@oh-my-pi/pi-utils";
import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import { expandEnvVarsDeep } from "../discovery/helpers";
import type { AuthStorage } from "../session/auth-storage";
import {
	hasOAuthScope,
	isManagedMCPOAuthCredentialId,
	type MCPStoredOAuthCredential,
	mcpOAuthCredentialId,
	mcpOAuthCredentialProfile,
	mcpOAuthServerUrlFromCredentialId,
	refreshMCPOAuthToken,
	sharedMcpCredentialProfiles,
	sharedMcpOAuthCredentialId,
} from "./oauth-flow";
import type { MCPAuthConfig, MCPServerConfig } from "./types";

export interface MCPOAuthCredentialLookup {
	credentialId: string;
	credential: MCPStoredOAuthCredential;
}

export type MCPOAuthRefreshMaterial = MCPStoredOAuthCredential | MCPAuthConfig | undefined;

export function mcpOAuthCredentialIdsForServerUrl(serverUrl: string | undefined): string[] {
	if (!serverUrl) return [];
	const ids: string[] = [];
	const shared = sharedMcpCredentialProfiles();
	const own = getActiveProfile() ?? "default";
	for (const url of [expandEnvVarsDeep(serverUrl), serverUrl]) {
		// Shared mode: the url-keyed row first, then this profile's row, then the
		// sibling channels' rows (a login made by a build that mints profile-scoped
		// ids). Order = resolution precedence.
		const candidates = shared
			? [
					sharedMcpOAuthCredentialId(url),
					mcpOAuthCredentialId(url, own),
					...shared.filter(profile => profile !== own).map(profile => mcpOAuthCredentialId(url, profile)),
				]
			: [mcpOAuthCredentialId(url)];
		for (const id of candidates) if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}

/**
 * A stored credential's embedded client is authoritative because dynamic client
 * registration can mint a different client for every profile. Persisted auth
 * blocks are refresh material, not an owner-declared client restriction.
 *
 * When both sides record them, the resource and authorization-server origin
 * must agree and granted scopes must cover every required scope. Missing legacy
 * metadata remains compatible.
 */
function credentialMatchesRequestedIdentity(
	credentialId: string,
	credential: MCPStoredOAuthCredential,
	{
		expectedClientId,
		expectedResource,
		expectedTokenUrl,
		requiredScopes,
	}: {
		expectedClientId?: string;
		expectedResource?: string;
		expectedTokenUrl?: string;
		requiredScopes?: string;
	},
): boolean {
	const reject = (reason: string): false => {
		logger.debug("Rejected MCP OAuth credential with a different requested identity", {
			credentialId,
			reason,
		});
		return false;
	};
	const storedClientId = credential.clientId?.trim() || undefined;
	const requestedClientId = expectedClientId?.trim() || undefined;
	if (storedClientId && requestedClientId && storedClientId !== requestedClientId) {
		logger.debug("Using MCP OAuth credential's embedded client instead of config refresh material", {
			credentialId,
			reason: "credential client id differs from the persisted auth block",
		});
	}

	const storedResource = credential.resource?.trim() || undefined;
	const requestedResource = expectedResource?.trim() || undefined;
	if (storedResource && requestedResource && storedResource !== requestedResource) {
		return reject("resource does not match");
	}

	const storedTokenUrl = credential.tokenUrl?.trim() || undefined;
	const requestedTokenUrl = expectedTokenUrl?.trim() || undefined;
	if (storedTokenUrl && requestedTokenUrl) {
		try {
			if (new URL(storedTokenUrl).origin !== new URL(requestedTokenUrl).origin) {
				return reject("token endpoint origin does not match");
			}
		} catch {
			return reject("token endpoint origin cannot be validated");
		}
	}

	const grantedScopes = credential.scopes?.trim() || undefined;
	const requestedScopes = requiredScopes?.trim() || undefined;
	if (
		grantedScopes &&
		requestedScopes &&
		!requestedScopes.split(/\s+/).every(scope => hasOAuthScope(grantedScopes, scope))
	) {
		return reject("granted scopes do not cover the required scopes");
	}
	return true;
}

export function hasMcpAuthorizationHeader(config: MCPServerConfig): boolean {
	if (config.type !== "http" && config.type !== "sse") return false;
	return Object.keys(config.headers ?? {}).some(header => header.toLowerCase() === "authorization");
}

export function lookupMcpOAuthCredentialForServer(
	authStorage: AuthStorage | null | undefined,
	auth: MCPAuthConfig | undefined,
	serverUrl: string | undefined,
	options: {
		allowUrlKeyedFallback?: boolean;
		expectedClientId?: string;
		expectedResource?: string;
		expectedTokenUrl?: string;
		requiredScopes?: string;
	} = {},
): MCPOAuthCredentialLookup | undefined {
	if (!authStorage) return undefined;
	if (auth && auth.type !== "oauth") return undefined;
	const requestedIdentity = {
		expectedClientId: options.expectedClientId ?? auth?.clientId,
		expectedResource: options.expectedResource ?? auth?.resource,
		expectedTokenUrl: options.expectedTokenUrl ?? auth?.tokenUrl,
		requiredScopes: options.requiredScopes,
	};
	const urlKeyedCredentialIds = mcpOAuthCredentialIdsForServerUrl(serverUrl);
	if (
		auth?.credentialId &&
		(!auth.credentialId.startsWith("mcp_oauth:profile:") || urlKeyedCredentialIds.includes(auth.credentialId))
	) {
		const credential = authStorage.get(auth.credentialId);
		if (
			credential?.type === "oauth" &&
			credentialMatchesRequestedIdentity(auth.credentialId, credential, requestedIdentity)
		) {
			return { credentialId: auth.credentialId, credential };
		}
	}
	if (options.allowUrlKeyedFallback === false) return undefined;
	for (const credentialId of urlKeyedCredentialIds) {
		const credential = authStorage.get(credentialId);
		if (
			credential?.type === "oauth" &&
			credentialMatchesRequestedIdentity(credentialId, credential, requestedIdentity)
		) {
			return { credentialId, credential };
		}
	}
	return undefined;
}

export function lookupMcpOAuthCredential(
	authStorage: AuthStorage | null | undefined,
	config: MCPServerConfig,
): MCPOAuthCredentialLookup | undefined {
	const auth = config.auth;
	const expectedClientId = config.oauth?.clientId?.trim() || auth?.clientId?.trim() || undefined;
	const expectedResource = auth?.resource?.trim() || undefined;
	const expectedTokenUrl = auth?.tokenUrl?.trim() || undefined;
	const requiredScopes = config.oauth?.scope?.trim() || undefined;
	const requestedIdentity = { expectedClientId, expectedResource, expectedTokenUrl, requiredScopes };
	if (config.type !== "http" && config.type !== "sse") {
		return lookupMcpOAuthCredentialForServer(authStorage, auth, undefined, requestedIdentity);
	}
	if (hasMcpAuthorizationHeader(config)) {
		return lookupMcpOAuthCredentialForServer(authStorage, auth, config.url, {
			allowUrlKeyedFallback: false,
			...requestedIdentity,
		});
	}
	return lookupMcpOAuthCredentialForServer(authStorage, auth, config.url, requestedIdentity);
}

export function selectMcpOAuthRefreshMaterial(
	credential: MCPStoredOAuthCredential,
	auth: MCPAuthConfig | undefined,
): MCPOAuthRefreshMaterial {
	return credential.tokenUrl ? credential : auth;
}

/**
 * Refresh a stored MCP OAuth credential via the standard `refresh_token` grant.
 *
 * Refresh material is taken from the credential itself (self-contained modern
 * credentials embed `tokenUrl`/`clientId`/`clientSecret`/`resource`) or, for
 * legacy credentials that carry none, the server's `auth` block. Shared by the
 * local MCP manager and the `omp auth-broker serve` refresh path so a broker
 * with no access to the MCP config can still refresh `mcp_oauth:*` credentials
 * from the vault.
 *
 * `serverUrl` supplies the RFC 8707 fallback resource indicator when neither
 * the credential nor the auth block advertised one; the manager passes the
 * configured server URL, the broker recovers it from the credential id via
 * {@link mcpOAuthServerUrlFromCredentialId}.
 *
 * @throws when no usable refresh token or token endpoint is available.
 */
export function refreshManagedMcpOAuthCredential(
	credential: MCPStoredOAuthCredential,
	opts: { serverUrl?: string; auth?: MCPAuthConfig; signal?: AbortSignal } = {},
): Promise<OAuthCredentials> {
	const material = selectMcpOAuthRefreshMaterial(credential, opts.auth);
	const tokenUrl = material?.tokenUrl;
	if (!credential.refresh || !tokenUrl) {
		throw new Error("MCP OAuth credential is missing refresh material");
	}
	const authorizationUrl = material && "authorizationUrl" in material ? material.authorizationUrl : undefined;
	const resourceIsFallback = !material?.resource && Boolean(opts.serverUrl);
	const resource = material?.resource ?? (resourceIsFallback ? opts.serverUrl : undefined);
	return refreshMCPOAuthToken(tokenUrl, credential.refresh, material?.clientId, material?.clientSecret, resource, {
		authorizationUrl,
		stripSameOriginResource: resourceIsFallback,
		signal: opts.signal,
	});
}

async function refreshBrokeredMcpOAuthCredential(
	authStorage: AuthStorage,
	credentialId: number,
	provider: string,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const entry = await authStorage.forceRefreshCredentialById(credentialId, signal);
	if (entry.credential.type !== "oauth") {
		throw new Error(`Broker returned non-OAuth credential for ${provider}`);
	}
	const refreshed = entry.credential;
	return {
		access: refreshed.access,
		refresh: REMOTE_REFRESH_SENTINEL,
		expires: refreshed.expires,
		accountId: refreshed.accountId,
		email: refreshed.email,
		projectId: refreshed.projectId,
		enterpriseUrl: refreshed.enterpriseUrl,
	};
}

/**
 * Resolve and refresh one stored MCP OAuth row through the durable credential owner.
 *
 * Local rows use their embedded OAuth metadata; broker-redacted rows delegate the
 * grant to the broker. The MCP manager and standalone credential consumers share
 * this path so rotating refresh tokens are persisted before callers receive them.
 *
 * `serverUrl` supplies the RFC 8707 fallback resource indicator; the manager passes
 * the configured server URL for http/sse servers and `undefined` for stdio servers,
 * whose refresh must NOT advertise a resource. Standalone consumers that hold only
 * the credential id (`omp token`) set `recoverServerUrlFromCredentialId` to derive
 * the same fallback resource the http/sse client would use.
 */
export async function refreshStoredManagedMcpOAuthCredential(
	authStorage: AuthStorage,
	provider: string,
	opts: {
		credentialId?: number;
		serverUrl?: string;
		recoverServerUrlFromCredentialId?: boolean;
		auth?: MCPAuthConfig;
		forceRefresh?: boolean;
		keepCredentialOnRefreshFailure?: boolean;
		onRefreshFailure?: (error: unknown) => void;
	} = {},
): Promise<StoredOAuthRefreshResult<MCPStoredOAuthCredential>> {
	const row = authStorage
		.listStoredCredentials(provider)
		.find(
			entry =>
				entry.credential.type === "oauth" && (opts.credentialId === undefined || entry.id === opts.credentialId),
		);
	if (row?.credential.type !== "oauth") {
		return { credential: undefined, refreshed: false, removed: false };
	}
	const observedCredential: MCPStoredOAuthCredential = row.credential;
	const serverUrl =
		opts.serverUrl ??
		(opts.recoverServerUrlFromCredentialId ? mcpOAuthServerUrlFromCredentialId(provider) : undefined);
	return authStorage.refreshStoredOAuthCredential<MCPStoredOAuthCredential>(provider, {
		credentialId: row.id,
		observedCredential,
		credentialFromRow: credential => credential,
		forceRefresh: opts.forceRefresh,
		refreshSkewMs: 5 * 60_000,
		canRefresh: current => {
			const material = selectMcpOAuthRefreshMaterial(current, opts.auth);
			return Boolean(current.refresh && material?.tokenUrl);
		},
		refresh: (current, signal) =>
			current.refresh === REMOTE_REFRESH_SENTINEL
				? refreshBrokeredMcpOAuthCredential(authStorage, row.id, provider, signal)
				: refreshManagedMcpOAuthCredential(current, {
						serverUrl,
						auth: opts.auth,
						signal,
					}),
		mergeRefreshedCredential: (current, refreshed) => {
			const material = selectMcpOAuthRefreshMaterial(current, opts.auth);
			const resourceIsFallback = !material?.resource && Boolean(serverUrl);
			return {
				...current,
				...refreshed,
				tokenUrl: material?.tokenUrl,
				clientId: material?.clientId,
				clientSecret: material?.clientSecret,
				resource: resourceIsFallback ? undefined : material?.resource,
				authorizationUrl: material && "authorizationUrl" in material ? material.authorizationUrl : undefined,
			};
		},
		isDefinitiveFailure: error => isDefinitiveOAuthFailure(error instanceof Error ? error.message : String(error)),
		disabledCause: error => `oauth refresh failed: ${error instanceof Error ? error.message : String(error)}`,
		keepCredentialOnRefreshFailure: opts.keepCredentialOnRefreshFailure ?? true,
		onRefreshFailure: opts.onRefreshFailure,
	});
}

export async function removeManagedMcpOAuthCredential(
	authStorage: AuthStorage,
	credentialId: string | undefined,
): Promise<boolean> {
	if (!isManagedMCPOAuthCredentialId(credentialId)) return false;
	const scopedProfile = mcpOAuthCredentialProfile(credentialId);
	// Shared mode: a logout is a logout everywhere, so sibling channels' rows are removable too.
	const removableProfiles = new Set([getActiveProfile() ?? "default", ...(sharedMcpCredentialProfiles() ?? [])]);
	if (scopedProfile !== undefined && !removableProfiles.has(scopedProfile)) return false;
	if (authStorage.get(credentialId)?.type !== "oauth") return false;
	await authStorage.remove(credentialId);
	return true;
}

export async function removeManagedMcpOAuthCredentials(
	authStorage: AuthStorage,
	credentialIds: readonly (string | undefined)[],
): Promise<boolean> {
	let removed = false;
	for (const credentialId of credentialIds) {
		removed = (await removeManagedMcpOAuthCredential(authStorage, credentialId)) || removed;
	}
	return removed;
}
