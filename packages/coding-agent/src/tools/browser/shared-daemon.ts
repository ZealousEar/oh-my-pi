/**
 * Shared automation Chromium owned by the machine-global agent-browser broker.
 *
 * Instead of every omp process launching (and sometimes orphaning) a private
 * Chromium, the headless browser kind attaches to ONE broker-supervised Chrome
 * per machine — every channel (`omp`, `ompd`, `ompdev`), project, session and
 * subagent opens its own tabs in it. The broker is profile-independent (same
 * scope regardless of `OMP_PROFILE`/project), so concurrent channels adopt the
 * same running instance through the atomic describe→start→adopt loop below,
 * and the daemon stays up while any omp client holds the broker lease.
 *
 * Durable logins come from the stable profile directory: the Chromium always
 * runs on `~/.omp/browser/agent-profile` (0700), never on a per-project or
 * throwaway `mkdtemp` profile, so the cookie store survives daemon restarts.
 * That directory is agent-only — it is never the user's Chrome profile and
 * nothing is ever copied into it.
 *
 * Per-open process flags are intentionally absent: a running shared Chromium
 * cannot be relaunched for one tab. `allow_file_access` is rejected before this
 * boundary; invalid-certificate handling remains page-scoped through CDP.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBaseConfigRoot, logger } from "@oh-my-pi/pi-utils";
import { daemonClientForGlobal } from "../../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../../launch/ensure";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { throwIfAborted } from "../tool-errors";
import { probeCdpStatus } from "./attach";
import { resolveSharedBrowserLaunchSpec } from "./launch";

/** Chrome prints this on stderr once the CDP listener is up; the broker's ready probe captures the line. */
const READY_LOG_PATTERN = String.raw`DevTools listening on ws://\S+`;
const READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_500;
/** describe→start rounds before giving up; bounds cross-process start races and wedged-Chrome replacement. */
const ENSURE_ATTEMPTS = 3;
/** Machine-global broker scope; profile-independent like the relay's `browser-relay`. */
export const AGENT_BROWSER_BROKER_SCOPE = "browser-agent";

/** Broker-owned browser endpoint one omp process can attach to. */
export interface SharedBrowserEndpoint {
	wsEndpoint: string;
	daemonName: string;
	/** Broker runtime directory (durable ownership registry lives beside it). */
	runtimeDir: string;
	/** Chromium profile directory the daemon runs on. */
	profileDir: string;
	/** Per-launch browser identity (the ws endpoint GUID); target ids are only meaningful within it. */
	generation: string;
}

/**
 * The one stable agent-browser profile directory: `~/.omp/browser/agent-profile`.
 * Derived from the profile-independent config root so every channel resolves
 * the same path. `override` exists for tests, which must never touch the real
 * profile.
 */
export function agentBrowserProfileDir(override?: string): string {
	return override ?? path.join(getBaseConfigRoot(), "browser", "agent-profile");
}

/** Browser generation token from a CDP ws endpoint (`ws://host/devtools/browser/<guid>`); the whole URL when unparseable. */
export function browserGenerationOf(wsEndpoint: string): string {
	const match = /\/devtools\/browser\/([^/?#]+)/.exec(wsEndpoint);
	return match?.[1] ?? wsEndpoint;
}

/** Stable broker daemon name for the shared automation browser. */
export function sharedBrowserDaemonName(headless: boolean): string {
	return headless ? "omp.browser.headless" : "omp.browser.headed";
}

function wsEndpointOf(snapshot: DaemonSnapshot | undefined): string | undefined {
	return snapshot?.readyMatch?.match(/ws:\/\/\S+/)?.[0];
}

/** CDP liveness probe: the ws endpoint host must answer /json/version. */
async function probeEndpoint(wsEndpoint: string): Promise<boolean> {
	let host: string;
	try {
		host = new URL(wsEndpoint).host;
	} catch {
		return false;
	}
	const status = await probeCdpStatus(`http://${host}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS });
	return status !== null && status >= 200 && status < 300;
}

/**
 * Ensure the machine-global agent Chromium is running and reachable, launching
 * it under the global daemon broker when needed. Idempotent across processes
 * and channels: losers of the start race adopt the winner's endpoint on the
 * next describe round. Returns null when the shared path is unavailable (no
 * resolvable Chromium, broker failure, or a daemon that never becomes
 * reachable); CLI-hosted callers fail closed on null — they never fall back
 * to a throwaway profile.
 */
export async function ensureSharedBrowser(opts: {
	headless: boolean;
	viewport?: { width: number; height: number };
	signal?: AbortSignal;
	/** Test seam: profile directory override. Production always uses {@link agentBrowserProfileDir}. */
	profileDir?: string;
}): Promise<SharedBrowserEndpoint | null> {
	const client = await daemonClientForGlobal(AGENT_BROWSER_BROKER_SCOPE);
	// For a global scope the client's synthetic project dir IS the runtime dir.
	const runtimeDir = client.projectDir;
	const name = sharedBrowserDaemonName(opts.headless);
	const profileDir = agentBrowserProfileDir(opts.profileDir);
	const launch = await resolveSharedBrowserLaunchSpec({
		headless: opts.headless,
		userDataDir: profileDir,
		viewport: opts.viewport,
	});
	if (!launch) return null;
	// Agent-only state: cookies for logged-in accounts live here, so keep it
	// owner-private. `chmod` covers a directory created earlier with a looser mode.
	await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
	await fs.chmod(profileDir, 0o700).catch(() => undefined);
	const endpoint = (wsEndpoint: string): SharedBrowserEndpoint => ({
		wsEndpoint,
		daemonName: name,
		runtimeDir,
		profileDir,
		generation: browserGenerationOf(wsEndpoint),
	});
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		throwIfAborted(opts.signal);
		const existing = await describeQuietly(client, name, "Shared browser", opts.signal);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			const settled =
				existing.readyAt !== undefined ? existing : await waitReady(client, name, "Shared browser", opts.signal);
			const wsEndpoint = wsEndpointOf(settled);
			if (wsEndpoint && (await probeEndpoint(wsEndpoint))) return endpoint(wsEndpoint);
			// Live record but unreachable Chrome (wedged, or readiness never
			// matched): replace it rather than handing out a dead endpoint.
			await stopQuietly(client, name, "Shared browser", opts.signal);
			continue;
		}
		try {
			const started = await client.request(
				{
					op: "start",
					spec: {
						name,
						application: launch.executablePath,
						args: launch.args,
						env: {},
						cwd: runtimeDir,
						pty: false,
						ready: { log: READY_LOG_PATTERN, timeoutMs: READY_TIMEOUT_MS },
						restart: "no",
						persist: false,
						detached: false,
					},
				},
				opts.signal,
			);
			if (started.op !== "start") continue;
			const wsEndpoint = started.readyTimedOut ? undefined : wsEndpointOf(started.daemon);
			if (wsEndpoint && (await probeEndpoint(wsEndpoint))) return endpoint(wsEndpoint);
			await stopQuietly(client, name, "Shared browser", opts.signal);
		} catch (error) {
			throwIfAborted(opts.signal);
			// Lost a cross-process start race ("already starting/ready"); the next
			// describe round adopts the winner's endpoint.
			logger.debug("Shared browser start contention", {
				name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return null;
}
