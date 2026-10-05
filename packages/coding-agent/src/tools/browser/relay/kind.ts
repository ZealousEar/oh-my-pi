/**
 * Browser relay mode: drive the user's own Chrome tabs through the local CDP
 * relay served by `omp browser-relay` (sibling `server.ts`/`bridge.ts`) plus
 * its companion extension (`packages/browser-relay`, installed via
 * `omp browser-relay install`). The relay impersonates Chrome's CDP discovery
 * endpoint, so beyond kind resolution the entire connected-browser machinery
 * (registry, tab supervisor, tab workers) applies unchanged.
 *
 * The launcher layer adds two env vars so every omp channel agrees on ONE
 * relay release:
 * - `OMP_BROWSER_RELAY_REQUIRE_PROTOCOL=<int>` refuses any relay whose
 *   protocol is lower (stock/legacy relays are protocol 1).
 * - `OMP_BROWSER_RELAY_SUPERVISOR=launchd:<label>` (pinned mode) starts the
 *   relay through that launchd job instead of spawning this build under the
 *   global broker; `=none` (legacy mode) is adopt-only — this build never
 *   starts a relay, so an already-serving legacy relay is never displaced.
 * Malformed values fail closed at kind resolution.
 */
import { parseFlag } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/**
 * Who may start the pinned relay process. `none` = adopt-only: the consumer
 * uses a relay that is already serving and never starts one itself (the
 * launcher's `legacy` relay mode, where a newer relay taking the port would
 * reject the live 0.1.0 extension for every channel).
 */
export type RelaySupervisor = { kind: "launchd"; label: string } | { kind: "none" };

/** Browser kind selecting the omp browser relay. */
export interface RelayKind {
	kind: "relay";
	cdpUrl: string;
	/** Refuse relays speaking a lower protocol (`OMP_BROWSER_RELAY_REQUIRE_PROTOCOL`). */
	requireProtocol?: number;
	/** Start the relay through this supervisor instead of the global broker (`OMP_BROWSER_RELAY_SUPERVISOR`). */
	supervisor?: RelaySupervisor;
}

/** Default endpoint of the `omp-browser-relay` CLI. */
export const DEFAULT_RELAY_URL = "http://127.0.0.1:9224";

export const RELAY_REQUIRE_PROTOCOL_ENV = "OMP_BROWSER_RELAY_REQUIRE_PROTOCOL";
export const RELAY_SUPERVISOR_ENV = "OMP_BROWSER_RELAY_SUPERVISOR";
const LAUNCHD_LABEL = /^[A-Za-z0-9._-]+$/;

export interface ResolveRelayKindOptions {
	/** `browser.relay` setting; `PI_BROWSER_RELAY=0|1` overrides it. */
	settingEnabled?: boolean;
	/** `browser.relayUrl` setting; falls back to {@link DEFAULT_RELAY_URL}. */
	url?: string;
}

function parseRequireProtocol(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = raw.trim();
	if (!/^\d+$/.test(value) || Number(value) < 1) {
		throw new ToolError(
			`${RELAY_REQUIRE_PROTOCOL_ENV} must be a positive integer relay protocol version (got ${JSON.stringify(raw)}).`,
		);
	}
	return Number(value);
}

function parseSupervisor(raw: string | undefined): RelaySupervisor | undefined {
	if (raw === undefined) return undefined;
	const value = raw.trim();
	if (value === "none") return { kind: "none" };
	const separator = value.indexOf(":");
	const kind = separator === -1 ? value : value.slice(0, separator);
	const label = separator === -1 ? "" : value.slice(separator + 1);
	if (kind !== "launchd" || !LAUNCHD_LABEL.test(label)) {
		throw new ToolError(
			`${RELAY_SUPERVISOR_ENV} must be \`none\` or launchd:<label> with a label matching ${LAUNCHD_LABEL} (got ${JSON.stringify(raw)}).`,
		);
	}
	return { kind: "launchd", label };
}

/**
 * Resolve the relay browser kind, or null when relay mode is disabled.
 * Mirrors `resolveCmuxKind`: the setting opts in, the env var is the final
 * override in both directions. Throws a {@link ToolError} for malformed
 * pinning env vars (fail closed rather than silently unpinned).
 */
export function resolveRelayKind(
	options?: ResolveRelayKindOptions | null,
	env: Record<string, string | undefined> = process.env,
): RelayKind | null {
	if (!parseFlag(env.PI_BROWSER_RELAY, options?.settingEnabled ?? false)) {
		return null;
	}
	const url = options?.url?.trim() || DEFAULT_RELAY_URL;
	const kind: RelayKind = { kind: "relay", cdpUrl: url.replace(/\/+$/, "") };
	const requireProtocol = parseRequireProtocol(env[RELAY_REQUIRE_PROTOCOL_ENV]);
	if (requireProtocol !== undefined) kind.requireProtocol = requireProtocol;
	const supervisor = parseSupervisor(env[RELAY_SUPERVISOR_ENV]);
	if (supervisor) kind.supervisor = supervisor;
	return kind;
}
