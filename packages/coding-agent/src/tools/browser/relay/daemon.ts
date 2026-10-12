/**
 * Broker-owned browser relay daemon.
 *
 * The MV3 extension can only dial OUT (service workers cannot listen on
 * sockets), so a native process must own the relay port. Instead of making
 * the user run `omp browser-relay` by hand, the relay kind lazily starts one
 * under a profile-independent, machine-global daemon broker. Every relay
 * consumer holds a connection to that broker, so one project exiting cannot
 * tear down the fixed-port singleton while another project still uses it.
 *
 * A manually started relay may already own the port. Consumers still acquire
 * the global broker lease before probing, then adopt that external server
 * without attempting another bind.
 *
 * Pinned deployments replace the broker with a launchd job
 * (`OMP_BROWSER_RELAY_SUPERVISOR=launchd:<label>`): when nothing serves the
 * port the consumer kickstarts that job and waits, and never spawns its own
 * build. Before the cutover gate the launcher sets `=none` (adopt-only): an
 * already-serving relay is adopted, nothing is ever started. Independently,
 * `OMP_BROWSER_RELAY_REQUIRE_PROTOCOL` refuses to adopt a relay speaking a
 * lower protocol (stock/legacy relays are protocol 1), so a downgrade is a
 * clear error instead of a silently different feature set.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { daemonClientForGlobal } from "../../../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../../../launch/ensure";
import { resolveWorkerSpawnCmd } from "../../../subprocess/worker-client";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { throwIfAborted } from "../../tool-errors";
import { probeCdpResponse, probeCdpStatus } from "../attach";
import { RELAY_SUPERVISOR_ENV, type RelaySupervisor } from "./kind";
import { relayProtocolOf } from "./probe";

/** Stable broker daemon name for the relay server. */
export const RELAY_DAEMON_NAME = "omp.browser.relay";
const RELAY_BROKER_SCOPE = "browser-relay";
/** Matches the serve banner (`omp browser relay listening on http://…`). */
const READY_LOG_PATTERN = String.raw`browser relay listening on http://\S+`;
const READY_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 1_500;
const SUPERVISED_POLL_INTERVAL_MS = 150;
/** probe→describe→start rounds; bounds cross-process races and wedged-relay replacement. */
const ENSURE_ATTEMPTS = 3;

/** True when the relay HTTP server answers /json/version at all (200 = extension connected, 503 = waiting for it). */
export async function probeRelayServer(cdpUrl: string): Promise<boolean> {
	const status = await probeCdpStatus(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS });
	return status === 503 || (status !== null && status >= 200 && status < 300);
}

/** Protocol of the relay serving `cdpUrl` (1 for a relay without a protocol field), or null when nothing relay-like answers. */
export async function probeRelayProtocol(cdpUrl: string, signal?: AbortSignal): Promise<number | null> {
	return relayProtocolOf(await probeCdpResponse(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS, signal }));
}

/** Auto-start is only safe for endpoints this machine can own. */
export function isLoopbackRelayUrl(cdpUrl: string): boolean {
	try {
		const { hostname } = new URL(cdpUrl);
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}

/** `launchctl` domain target of the calling user's GUI session. */
function launchdDomain(): string {
	return `gui/${process.getuid?.() ?? 0}`;
}

/** Message for a relay that speaks a lower protocol than the consumer requires, with the fixes. */
export function relayProtocolTooOldMessage(
	cdpUrl: string,
	found: number,
	required: number,
	supervisor?: RelaySupervisor,
): string {
	const restart =
		supervisor?.kind === "launchd"
			? ` and start the pinned relay with \`launchctl kickstart -k ${launchdDomain()}/${supervisor.label}\``
			: "";
	return `omp browser relay at ${cdpUrl} is a legacy/stock relay (protocol ${found}); this omp requires protocol ${required}. Stop it with \`omp ps --global browser-relay stop ${RELAY_DAEMON_NAME}\`${restart}, then retry.`;
}

/** Default `kickstart`: `launchctl kickstart gui/<uid>/<label>`; true when launchctl exited 0. */
async function launchctlKickstart(label: string): Promise<boolean> {
	const result = await $`launchctl kickstart ${launchdDomain()}/${label}`.quiet().nothrow();
	if (result.exitCode !== 0) {
		logger.warn("launchctl kickstart failed", {
			label,
			exitCode: result.exitCode,
			stderr: result.stderr.toString().trim(),
		});
	}
	return result.exitCode === 0;
}

export interface EnsureRelayDaemonOptions {
	cdpUrl: string;
	signal?: AbortSignal;
	/** Refuse (throw) any relay whose protocol is lower. */
	requireProtocol?: number;
	/** Start the relay through this supervisor; never spawn this build. */
	supervisor?: RelaySupervisor;
	/** Test seam replacing `launchctl kickstart`; resolves true when the job was kicked. */
	kickstart?: (label: string) => Promise<boolean>;
}

/**
 * Ensure a relay server answers at `cdpUrl`, starting the broker-owned daemon
 * (or kickstarting the supervisor's job) when nothing is serving. Returns
 * true once the HTTP endpoint responds — the extension handshake (503 → 200)
 * is the caller's wait. False when the broker could not start the relay.
 * Throws a {@link ToolError} when the serving relay is older than
 * `requireProtocol` or the supervised job cannot be started (fail closed).
 */
export async function ensureRelayDaemon(opts: EnsureRelayDaemonOptions): Promise<boolean> {
	let port: string;
	try {
		port = String(new URL(opts.cdpUrl).port || 80);
	} catch {
		return false;
	}
	let warned = false;
	/** Probe and apply the protocol policy; true when a relay is adopted. */
	const adopt = async (): Promise<boolean> => {
		const found = await probeRelayProtocol(opts.cdpUrl, opts.signal);
		if (found === null) return false;
		if (opts.requireProtocol !== undefined && found < opts.requireProtocol) {
			throw new ToolError(relayProtocolTooOldMessage(opts.cdpUrl, found, opts.requireProtocol, opts.supervisor));
		}
		if (found === 1 && !warned) {
			warned = true;
			logger.warn("Adopting a legacy/stock browser relay (protocol 1)", { cdpUrl: opts.cdpUrl });
		}
		return true;
	};
	// Fail closed on a downgrade before touching any broker.
	if (await adopt()) {
		if (opts.supervisor) return true;
	} else if (opts.supervisor) {
		return ensureSupervisedRelay(opts, opts.supervisor, adopt);
	}
	// Open the lazy client before (re-)probing. Merely caching SocketDaemonClient
	// would not create the broker connection (and therefore would hold no lease).
	const client = await daemonClientForGlobal(RELAY_BROKER_SCOPE);
	throwIfAborted(opts.signal);
	await client.request({ op: "ping" }, opts.signal);
	if (await adopt()) return true;
	const spawn = resolveWorkerSpawnCmd("browser-relay");
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		throwIfAborted(opts.signal);
		// A manual serve or concurrent global-broker start may have won the
		// port since the last round; adopt it instead of fighting the bind.
		if (await adopt()) return true;
		const existing = await describeQuietly(client, RELAY_DAEMON_NAME, "Browser relay", opts.signal);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			if (existing.readyAt === undefined) await waitReady(client, RELAY_DAEMON_NAME, "Browser relay", opts.signal);
			if (await adopt()) return true;
			// Live record but nothing listening: replace the wedged daemon.
			await stopQuietly(client, RELAY_DAEMON_NAME, "Browser relay", opts.signal);
			continue;
		}
		try {
			const started = await client.request(
				{
					op: "start",
					spec: {
						name: RELAY_DAEMON_NAME,
						application: spawn.cmd[0]!,
						args: [...spawn.cmd.slice(1), "--port", port],
						env: {},
						cwd: spawn.cwd ?? client.projectDir,
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
			if (await adopt()) return true;
			await stopQuietly(client, RELAY_DAEMON_NAME, "Browser relay", opts.signal);
		} catch (error) {
			if (error instanceof ToolError) throw error;
			throwIfAborted(opts.signal);
			// Lost a cross-process start race; the next round adopts the winner.
			logger.debug("Browser relay start contention", {
				name: RELAY_DAEMON_NAME,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return false;
}

/** Kickstart the supervisor's job and wait for the relay it owns; never spawns this build. */
async function ensureSupervisedRelay(
	opts: EnsureRelayDaemonOptions,
	supervisor: RelaySupervisor,
	adopt: () => Promise<boolean>,
): Promise<true> {
	if (supervisor.kind === "none") {
		throw new ToolError(
			`no omp browser relay is serving ${opts.cdpUrl} and this channel is adopt-only (${RELAY_SUPERVISOR_ENV}=none); start the legacy relay or run the launcher cutover.`,
		);
	}
	const notLoaded = () =>
		new ToolError(
			`pinned browser relay service ${supervisor.label} is not loaded or did not start; run \`launchctl bootstrap ${launchdDomain()} ~/Library/LaunchAgents/${supervisor.label}.plist\` (see the launcher runbook) and retry.`,
		);
	throwIfAborted(opts.signal);
	const kicked = await (opts.kickstart ?? launchctlKickstart)(supervisor.label);
	throwIfAborted(opts.signal);
	if (!kicked) throw notLoaded();
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await adopt()) return true;
		throwIfAborted(opts.signal);
		await Bun.sleep(SUPERVISED_POLL_INTERVAL_MS);
	}
	throw notLoaded();
}
