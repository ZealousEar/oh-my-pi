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
import { acquireFileLock, type FileLockHandle, getBaseConfigRoot, logger, withTimeout } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerClient, daemonClientForGlobal } from "../../launch/client";
import { describeDaemon, describeQuietly, stopQuietly, waitReady } from "../../launch/ensure";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { throwIfAborted } from "../tool-errors";
import { probeCdpStatus } from "./attach";
import {
	discardOwnedProfileSessions,
	resolveSharedBrowserLaunchSpec,
	type SharedBrowserLaunchSpec,
	seedOwnedProfilePreferences,
} from "./launch";
import type { SharedTargetScope } from "./orphan-registry";

/** Chrome prints this on stderr once the CDP listener is up; the broker's ready probe captures the line. */
const READY_LOG_PATTERN = String.raw`DevTools listening on ws://\S+`;
const READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_500;
/** describe→start rounds before giving up; bounds cross-process start races and wedged-Chrome replacement. */
const ENSURE_ATTEMPTS = 3;
/**
 * Longest one client holds the profile claim through a cold start: the
 * broker's ready wait plus the endpoint probe and IPC slack. A waiter that
 * gives up after this may still adopt a running browser, but never starts one.
 */
const PROFILE_CLAIM_WAIT_MS = READY_TIMEOUT_MS + 15_000;
const PROFILE_CLAIM_RETRY_MS = 100;
/** Grace `restartSharedBrowser` gives Chrome to exit before the broker kills it; matches `omp ps stop`. */
const RESTART_STOP_TIMEOUT_MS = 5_000;
/**
 * Hard bound on one post-cleanup reachability check, covering both probes and
 * the broker stop request. Also the guarantee behind the single-flight entry:
 * whatever stalls underneath, the check settles and the entry clears.
 */
const HEALTH_CHECK_BUDGET_MS = 15_000;
/**
 * Hard cap on one probe attempt: the probe's own HTTP budget plus the connect
 * window that runs before that budget starts. `rawHttpGet` awaits `Bun.connect`
 * before its timer can settle the call, so without this cap a stalled TCP
 * connect outlives the whole health budget.
 */
const PROBE_ATTEMPT_CAP_MS = PROBE_TIMEOUT_MS + 1_500;
/** Marker for a probe the cap abandoned, as opposed to a probe that failed on its own terms. */
const PROBE_STALLED = "Shared browser probe did not settle";
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

/** True for the broker daemon names of the shared agent browsers. */
export function isSharedBrowserDaemonName(name: string): boolean {
	return name === sharedBrowserDaemonName(true) || name === sharedBrowserDaemonName(false);
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
 * and channels: each describe→adopt-or-start round runs under a cross-process
 * claim on the profile, so racing clients converge on the first one's launch
 * (and losers of any remaining broker start race adopt the winner's endpoint
 * on the next round). Returns null when the shared path is unavailable (no
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
		// Chromium reads Preferences only at startup and rewrites them from
		// memory, so only the client that launches it may write them, and only
		// before the launch. The claim makes adopt-or-start one decision per
		// profile: a racing client describes after the winner's start settled
		// and adopts it, instead of renaming a stale Preferences snapshot over
		// the live profile before its own start is rejected. Only a claim holder
		// starts Chrome, so every launch runs on a prepared profile.
		const claim = await claimProfile(profileDir, opts.signal);
		try {
			const found = await adoptOrStart(client, name, launch, profileDir, endpoint, claim !== null, opts.signal);
			if (found) return found;
		} finally {
			claim?.release();
		}
	}
	return null;
}

/** Claim the shared profile; null when another client held it past the wait. */
async function claimProfile(userDataDir: string, signal?: AbortSignal): Promise<FileLockHandle | null> {
	try {
		return await acquireFileLock(userDataDir, {
			retries: Math.ceil(PROFILE_CLAIM_WAIT_MS / PROFILE_CLAIM_RETRY_MS),
			retryDelayMs: PROFILE_CLAIM_RETRY_MS,
			signal,
		});
	} catch (error) {
		throwIfAborted(signal);
		logger.warn("Shared browser profile stayed claimed", {
			userDataDir,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Restart the shared agent browser for `omp ps`. The broker's own restart
 * relaunches the persisted spec on the same profile, where Chromium would
 * reopen every page the stopped process had open. This holds the profile
 * claim throughout, so no other client starts Chrome in between, stops the
 * daemon, prepares the profile as for a cold start once the stop is
 * confirmed, and only then asks the broker to relaunch.
 */
export async function restartSharedBrowser(
	client: DaemonBrokerClient,
	name: string,
	opts: {
		signal?: AbortSignal;
		/** Test seam: profile directory override. Production always uses {@link agentBrowserProfileDir}. */
		profileDir?: string;
	} = {},
): Promise<DaemonSnapshot> {
	const { signal } = opts;
	const userDataDir = agentBrowserProfileDir(opts.profileDir);
	const claim = await claimProfile(userDataDir, signal);
	if (!claim) throw new Error(`${name} is being started by another omp process; try again shortly`);
	try {
		const stopped = await client.request({ op: "stop", name, timeoutMs: RESTART_STOP_TIMEOUT_MS }, signal);
		if (stopped.op !== "stop") throw new Error(`Unexpected broker response ${stopped.op}`);
		if (stopped.daemon.state !== "exited" && stopped.daemon.state !== "failed") {
			throw new Error(`${name} is still ${stopped.daemon.state} after the stop; it was not restarted`);
		}
		await seedOwnedProfilePreferences(userDataDir);
		await discardOwnedProfileSessions(userDataDir);
		const restarted = await client.request({ op: "restart", name }, signal);
		if (restarted.op !== "restart") throw new Error(`Unexpected broker response ${restarted.op}`);
		return restarted.daemon;
	} finally {
		claim.release();
	}
}

/**
 * One describe→adopt-or-start round. Starts Chrome only when this round holds
 * the profile claim and the broker established that no live daemon owns the
 * profile, after preparing it (seeding Preferences, discarding the previous
 * Chrome's session-restore state); adopting an existing browser never writes
 * the profile.
 * Resolves undefined when the caller should run another round.
 */
async function adoptOrStart(
	client: DaemonBrokerClient,
	name: string,
	launch: SharedBrowserLaunchSpec,
	userDataDir: string,
	endpoint: (wsEndpoint: string) => SharedBrowserEndpoint,
	claimed: boolean,
	signal?: AbortSignal,
): Promise<SharedBrowserEndpoint | undefined> {
	const described = await describeDaemon(client, name, "Shared browser", signal);
	// No settled answer: Chrome may be running on the profile, so it must not be
	// prepared, and a start without preparing it restores the stale session.
	// Describe again next round.
	if (described.status === "unknown") return undefined;
	const existing = described.status === "found" ? described.daemon : undefined;
	if (existing && existing.state !== "exited" && existing.state !== "failed") {
		const settled =
			existing.readyAt !== undefined ? existing : await waitReady(client, name, "Shared browser", signal);
		const wsEndpoint = wsEndpointOf(settled);
		if (wsEndpoint && (await probeEndpoint(wsEndpoint))) return endpoint(wsEndpoint);
		// Live record but unreachable Chrome (wedged, or readiness never
		// matched): replace it rather than handing out a dead endpoint.
		await stopQuietly(client, name, "Shared browser", signal);
		return undefined;
	}
	// Without the claim the profile cannot be prepared, and an unprepared start
	// restores the stale session; the claim holder starts Chrome instead.
	if (!claimed) return undefined;
	await seedOwnedProfilePreferences(userDataDir);
	await discardOwnedProfileSessions(userDataDir);
	try {
		const started = await client.request(
			{
				op: "start",
				spec: {
					name,
					application: launch.executablePath,
					args: launch.args,
					env: {},
					cwd: client.projectDir,
					pty: false,
					ready: { log: READY_LOG_PATTERN, timeoutMs: READY_TIMEOUT_MS },
					restart: "no",
					persist: false,
					detached: false,
				},
			},
			signal,
		);
		if (started.op !== "start") return undefined;
		const wsEndpoint = started.readyTimedOut ? undefined : wsEndpointOf(started.daemon);
		if (wsEndpoint && (await probeEndpoint(wsEndpoint))) return endpoint(wsEndpoint);
		await stopQuietly(client, name, "Shared browser", signal);
	} catch (error) {
		throwIfAborted(signal);
		// Lost a cross-process start race ("already starting/ready"); the next
		// describe round adopts the winner's endpoint.
		logger.debug("Shared browser start contention", {
			name,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return undefined;
}

/** Seams for {@link stopSharedBrowserIfUnreachable}; the defaults hit the real broker and CDP probe. */
export interface SharedBrowserHealthDeps {
	client?: DaemonBrokerClient;
	probe?: (wsEndpoint: string) => Promise<boolean>;
	signal?: AbortSignal;
	/** Override the per-attempt probe cap ({@link PROBE_ATTEMPT_CAP_MS}); slower values are only for tests. */
	probeCapMs?: number;
}

/** In-flight checks per broker daemon, so the tabs of one failed sweep share one stop round. */
const reachabilityChecks = new Map<string, Promise<boolean>>();

/**
 * Stop the project-shared browser when its CDP endpoint has stopped answering.
 *
 * `ensureSharedBrowser` makes this decision only while attaching, so a Chromium
 * that wedges *after* a session attached kept its whole process tree — and
 * every target whose close timed out — alive until the last omp client in the
 * project exited (a 9.1 GB, 44-process browser survived 19 h in the
 * 2026-09-27 incident). Cleanup failures re-run the same decision off the
 * acquire path: stop the daemon, so the next attach launches a fresh Chromium
 * and the leaked targets die with the old one.
 *
 * The liveness probe gates the stop — twice in a row, because one slow answer
 * on a loaded machine is not a wedge and stopping the shared browser costs
 * every session in the project its tabs — and the daemon is re-described
 * before the stop, so a browser another session replaced meanwhile is never
 * stopped under its name. A daemon that has not become ready is left to the
 * acquire path, which owns that race. Concurrent failed closes share one check.
 * Best-effort: never throws, and returns true only when the broker confirmed the stop.
 */
export function stopSharedBrowserIfUnreachable(
	scope: SharedTargetScope,
	deps: SharedBrowserHealthDeps = {},
): Promise<boolean> {
	const key = `${scope.runtimeDir}\u0000${scope.daemonName}`;
	const inFlight = reachabilityChecks.get(key);
	if (inFlight) return inFlight;
	// The body bounds every phase it can see. This outer race is what guarantees
	// the check — and therefore its single-flight entry — settles on schedule
	// even when an await underneath cannot be bounded from here (a broker socket
	// connect, a TCP connect that never opens).
	const run = withTimeout(
		checkSharedBrowserReachable(scope, deps),
		HEALTH_CHECK_BUDGET_MS,
		"Shared browser reachability check exceeded its budget",
	).catch(() => false);
	reachabilityChecks.set(key, run);
	void run.finally(() => {
		if (reachabilityChecks.get(key) === run) reachabilityChecks.delete(key);
	});
	return run;
}

/** True when a re-describe still names the daemon instance whose endpoint failed the probes. */
function isSameDaemonInstance(before: DaemonSnapshot, after: DaemonSnapshot | undefined): boolean {
	if (!after || after.state === "exited" || after.state === "failed") return false;
	return (
		after.id === before.id && after.startedAt === before.startedAt && wsEndpointOf(after) === wsEndpointOf(before)
	);
}

/** One reachability round. Resolves false for every non-destructive outcome; never rejects. */
async function checkSharedBrowserReachable(scope: SharedTargetScope, deps: SharedBrowserHealthDeps): Promise<boolean> {
	const signal = deps.signal ?? AbortSignal.timeout(HEALTH_CHECK_BUDGET_MS);
	const deadlineAt = Date.now() + HEALTH_CHECK_BUDGET_MS;
	try {
		const client = deps.client ?? (await daemonClientForGlobal(AGENT_BROWSER_BROKER_SCOPE));
		const existing = await describeQuietly(client, scope.daemonName, "Shared browser", signal);
		if (!existing || existing.state === "exited" || existing.state === "failed") return false;
		const wsEndpoint = wsEndpointOf(existing);
		// No endpoint stamped yet: still starting (or never became ready). The
		// acquire path owns that state; stopping here would race a cross-process
		// start that is about to succeed.
		if (!wsEndpoint) return false;
		const probe = deps.probe ?? probeEndpoint;
		/**
		 * `silent` when the endpoint did not answer 2xx in time — a refused or
		 * stalled connect, a non-2xx status, an answer slower than the probe's
		 * own 1.5 s budget, or an attempt the cap abandoned — `answered` only on
		 * a 2xx, and `unknown` when the health budget was already spent.
		 * `rawHttpGet` awaits `Bun.connect` before its own timer can settle the
		 * call, so the cap — not the probe's HTTP budget — is what a stalled
		 * connect runs into.
		 */
		async function probeAttempt(endpoint: string): Promise<"answered" | "silent" | "unknown"> {
			const capMs = Math.min(deps.probeCapMs ?? PROBE_ATTEMPT_CAP_MS, deadlineAt - Date.now());
			if (capMs <= 0) return "unknown";
			try {
				return (await withTimeout(probe(endpoint), capMs, PROBE_STALLED)) ? "answered" : "silent";
			} catch (error) {
				// Only the cap means "no answer". A probe that failed on its own
				// terms (a malformed endpoint, a broken dependency) is not
				// evidence against the browser and belongs to the caller's catch.
				if (error instanceof Error && error.message === PROBE_STALLED) return "silent";
				throw error;
			}
		}
		// Two silent attempts or nothing. `silent` is the only outcome that
		// counts against the browser, and it covers every way of not answering
		// 2xx in time (refused, non-2xx, slow past the 1.5 s budget, or an
		// attempt the cap abandoned): at that point the endpoint is not
		// servicing requests, so the sessions sharing the browser cannot drive it
		// either. Only `unknown` — no budget left to try — proves nothing, and
		// leaves the browser alone.
		if ((await probeAttempt(wsEndpoint)) !== "silent") return false;
		if ((await probeAttempt(wsEndpoint)) !== "silent") return false;
		// Two silent probes can have raced another session's replacement of the
		// same daemon name. Re-describe and stop only the instance that failed
		// them. (The stop op is still name-addressed, so this narrows rather than
		// closes that window; closing it needs a broker protocol change.)
		const confirmed = await describeQuietly(client, scope.daemonName, "Shared browser", signal);
		if (!isSameDaemonInstance(existing, confirmed)) return false;
		const stopped = await stopQuietly(client, scope.daemonName, "Shared browser", signal);
		// `stopQuietly` absorbs a rejected or unanswered stop, so only a terminal
		// snapshot proves the daemon actually ended. Reporting a stop that never
		// happened would let the caller forget targets that are still open —
		// exactly the leak this check exists to prevent.
		if (stopped?.state !== "exited" && stopped?.state !== "failed") {
			logger.debug("Shared browser stop was not confirmed", { daemon: scope.daemonName, state: stopped?.state });
			return false;
		}
		logger.warn("Stopped the shared agent browser after a cleanup failure", {
			daemon: scope.daemonName,
			runtimeDir: scope.runtimeDir,
			reason: "its CDP endpoint stopped answering",
		});
		return true;
	} catch (error) {
		logger.debug("Shared browser reachability check failed", {
			daemon: scope.daemonName,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
