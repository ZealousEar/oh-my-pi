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
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { $ } from "bun";
import { daemonClientForGlobal } from "../../../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../../../launch/ensure";
import { resolveWorkerSpawnCmd } from "../../../subprocess/worker-client";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { throwIfAborted } from "../../tool-errors";
import { probeCdpResponse, probeCdpStatus } from "../attach";
import { DEFAULT_RELAY_URL, RELAY_SUPERVISOR_ENV, type RelaySupervisor } from "./kind";
import { isOlderRelayVersion, relayCdpClientsOf, relayProtocolOf, relayVersionOf } from "./probe";

/** Broker daemon name of the relay on the default port; other ports get a port suffix (see {@link relayDaemonName}). */
export const RELAY_DAEMON_NAME = "omp.browser.relay";
const DEFAULT_RELAY_PORT = new URL(DEFAULT_RELAY_URL).port;

/** Broker daemon name for the relay on `port`; one per port, so relays on different ports never replace each other. */
function relayDaemonName(port: string): string {
	return port === DEFAULT_RELAY_PORT ? RELAY_DAEMON_NAME : `${RELAY_DAEMON_NAME}.${port}`;
}

function relayPort(cdpUrl: string): string | null {
	try {
		return String(new URL(cdpUrl).port || 80);
	} catch {
		return null;
	}
}

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
	const port = relayPort(cdpUrl);
	const name = port === null ? RELAY_DAEMON_NAME : relayDaemonName(port);
	return `omp browser relay at ${cdpUrl} is a legacy/stock relay (protocol ${found}); this omp requires protocol ${required}. Stop it with \`omp ps --global browser-relay stop ${name}\`${restart}, then retry.`;
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
	const port = relayPort(opts.cdpUrl);
	if (port === null) return false;
	const name = relayDaemonName(port);
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
		const existing = await describeQuietly(client, name, "Browser relay", opts.signal);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			if (existing.readyAt === undefined) await waitReady(client, name, "Browser relay", opts.signal);
			if (await adopt()) return true;
			// Live record but nothing listening: replace the wedged daemon.
			await stopQuietly(client, name, "Browser relay", opts.signal);
			continue;
		}
		try {
			const started = await client.request(
				{
					op: "start",
					spec: {
						name,
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
			await stopQuietly(client, name, "Browser relay", opts.signal);
		} catch (error) {
			if (error instanceof ToolError) throw error;
			throwIfAborted(opts.signal);
			// Lost a cross-process start race; the next round adopts the winner.
			logger.debug("Browser relay start contention", {
				name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return false;
}

/**
 * Replace the broker-owned relay at `cdpUrl` with one from this OMP version
 * when it comes from an older one; with `idleOnly`, only while it reports no
 * CDP client connected. True once the old relay has stopped (the caller's wait
 * reports whether the new one serves) or another process already replaced it
 * or stopped it to replace it. False when a relay the broker does not run
 * serves there (a manually started relay is left alone), the relay comes from
 * a newer OMP (a concurrently running newer omp owns it), an `idleOnly` relay
 * has a client or does not report its clients, or the old relay did not stop.
 */
export async function restartRelayDaemon(opts: {
	cdpUrl: string;
	signal?: AbortSignal;
	idleOnly?: boolean;
}): Promise<boolean> {
	const port = relayPort(opts.cdpUrl);
	if (port === null) return false;
	const name = relayDaemonName(port);
	const client = await daemonClientForGlobal(RELAY_BROKER_SCOPE);
	const existing = await describeQuietly(client, name, "Browser relay", opts.signal);
	if (!existing || existing.state === "exited" || existing.state === "failed") {
		// Another omp may have stopped the old relay and not yet registered its
		// replacement; start or adopt it unless a relay the broker does not run serves.
		const serving = await probeRelayServer(opts.cdpUrl);
		throwIfAborted(opts.signal);
		if (serving) return (await relayStatusAt(opts.cdpUrl, opts.signal))?.version === VERSION;
		// Returns true even if the start fails: the caller's next wait then reports
		// the relay unreachable, which is accurate, rather than out of date.
		await ensureRelayDaemon(opts);
		return true;
	}
	// Another omp of this version may have replaced it since the caller's probe,
	// possibly with a relay that has not printed its ready line yet.
	if (existing.readyAt === undefined) await waitReady(client, name, "Browser relay", opts.signal);
	const status = await relayStatusAt(opts.cdpUrl, opts.signal);
	if (status?.version === VERSION) return true;
	// A newer omp running alongside this one owns a newer relay; replacing it
	// would only make the two versions take turns killing each other's relay.
	if (status !== null && !isOlderRelayVersion(status.version)) return false;
	// The last read before the stop: a client that connected since the caller's
	// probe keeps the relay. One connecting during the stop request itself loses
	// its connection, as on any relay restart.
	if (opts.idleOnly && status?.cdpClients !== 0) return false;
	// Stops only the generation judged outdated, not one another omp started since.
	const stopped = await stopQuietly(client, name, "Browser relay", opts.signal, existing.id);
	if (stopped?.state === "exited" || stopped?.state === "failed") {
		// As above: a failed start surfaces as unreachable on the caller's wait.
		await ensureRelayDaemon(opts);
		return true;
	}
	if (stopped === undefined || stopped.id === existing.id) return false;
	if (stopped.readyAt === undefined) await waitReady(client, name, "Browser relay", opts.signal);
	return true;
}

/**
 * The OMP version (empty for a relay too old to report one) and connected CDP
 * client count the relay at `cdpUrl` reports on `/json/version`, ready or
 * waiting for its extension; null when nothing parseable answers.
 */
async function relayStatusAt(
	cdpUrl: string,
	signal: AbortSignal | undefined,
): Promise<{ version: string; cdpClients: number | null } | null> {
	const response = await probeCdpResponse(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS, signal });
	throwIfAborted(signal);
	if (!response) return null;
	try {
		const parsed: unknown = JSON.parse(response.body);
		return typeof parsed === "object" && parsed !== null
			? { version: relayVersionOf(parsed), cdpClients: relayCdpClientsOf(parsed) }
			: null;
	} catch {
		return null;
	}
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
