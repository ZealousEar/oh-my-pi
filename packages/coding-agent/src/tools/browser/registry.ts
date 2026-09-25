import * as path from "node:path";
import { isCompiledBinary, isRecord, logger, withTimeout, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type { Browser, CDPSession, Connection } from "puppeteer-core";
import { ToolAbortError } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	findFreeCdpPort,
	findReusableCdp,
	gracefulKillTreeOnce,
	probeCdpResponse,
	resolveSpawnArgs,
	waitForCdp,
} from "./attach";
import type { CmuxKind } from "./cmux/rpc";
import { CmuxSocketClient } from "./cmux/socket-client";
import {
	BROWSER_PROTOCOL_TIMEOUT_MS,
	DEFAULT_VIEWPORT,
	launchHeadlessBrowser,
	loadPuppeteer,
	removeUserDataDir,
	type UserAgentOverride,
} from "./launch";
import { ensureRelayDaemon, isLoopbackRelayUrl, relayProtocolTooOldMessage } from "./relay/daemon";
import type { RelayKind } from "./relay/kind";
import { LEGACY_RELAY_PROTOCOL, relayProtocolOf, waitForRelayExtension } from "./relay/probe";
import { parseRelayRevision } from "./relay/protocol";
import { ensureSharedBrowser } from "./shared-daemon";

export type PuppeteerBrowserKind =
	| {
			kind: "headless";
			headless: boolean;
			/** Process-local launch flag; shared browsers use the tab-scoped CDP override instead. */
			ignoreHttpsErrors?: boolean;
			/** Process-local file access launch flag, unsupported by an already-running shared browser. */
			allowFileAccess?: boolean;
	  }
	| { kind: "spawned"; path: string; args?: string[] }
	| { kind: "connected"; cdpUrl: string }
	| RelayKind;

export type BrowserKind = PuppeteerBrowserKind | CmuxKind;

export type BrowserKindTag = BrowserKind["kind"];

/**
 * Upper bound on `browser.close()` for headless Chromium. Puppeteer waits for
 * the process to fully exit; a wedged Chromium would otherwise hang cleanup
 * forever (issue #5260), so we cap the wait and force-kill on timeout.
 */
const HEADLESS_CLOSE_TIMEOUT_MS = 5_000;

interface BrowserHandleCommon {
	key: string;
	kind: BrowserKind;
	refCount: number;
}

export interface PuppeteerBrowserHandle extends BrowserHandleCommon {
	kind: PuppeteerBrowserKind;
	browser: Browser;
	cdpUrl?: string;
	pid?: number;
	/** OMP-owned TEMP Chromium profile removed on dispose. Only the labeled test/SDK fallback sets this. */
	userDataDir?: string;
	/** Broker daemon backing this handle; dispose disconnects instead of closing, kill routes to the broker. */
	sharedDaemon?: { name: string; runtimeDir: string; profileDir: string; generation: string };
	/** Relay: extension-reported per-Chrome-run generation; undefined on a legacy relay. */
	generation?: string;
	subprocess?: Subprocess;
	stealth: { browserSession: CDPSession | null; override: UserAgentOverride | null };
}

export interface CmuxBrowserHandle extends BrowserHandleCommon {
	kind: CmuxKind;
	client: CmuxSocketClient;
	surface?: string;
}

export type BrowserHandle = PuppeteerBrowserHandle | CmuxBrowserHandle;

/** Controls bounded browser-handle teardown and identifies the owning resource in timeout diagnostics. */
export interface ReleaseBrowserOptions {
	kill: boolean;
	timeoutMs?: number;
	resource?: string;
}

const browsers = new Map<string, BrowserHandle>();
/** In-flight opens by browser key, so concurrent acquisitions share one launch instead of storming Chromium. */
const pendingOpens = new Map<string, Promise<BrowserHandle>>();

export function browserKey(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless:${kind.headless ? "1" : "0"}:${kind.ignoreHttpsErrors ? "tls" : ""}:${kind.allowFileAccess ? "file" : ""}`;
		case "spawned":
			return `spawned:${JSON.stringify([kind.path, kind.args ?? []])}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "relay":
			return `relay:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.socketPath}`;
	}
}

export interface AcquireBrowserOptions {
	cwd: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	signal?: AbortSignal;
}

export async function acquireBrowser(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	if (kind.kind === "spawned") kind = { ...kind, args: resolveSpawnArgs(kind.path, kind.args, opts.cwd) };
	const key = browserKey(kind);
	for (;;) {
		const existing = browsers.get(key);
		if (existing) {
			if ("client" in existing) return existing;
			if (existing.browser.connected) return existing;
			browsers.delete(key);
			await disposeBrowserHandle(existing, { kill: false });
			continue;
		}
		// Short-circuit before launching: the tool wrapper's `untilAborted` only
		// rejects its outer promise on abort; without this check `openBrowserHandle`
		// would still fire and its result would land in `browsers` below.
		if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");

		// Single-flight per key: a concurrent caller already opening this browser
		// wins; everyone else waits and re-reads the registry. Without this, N
		// simultaneous opens each launch a Chromium and the last write wins,
		// leaking the rest as unreferenced process trees.
		const pending = pendingOpens.get(key);
		if (pending) {
			await pending.catch(() => undefined);
			continue;
		}
		const open = openBrowserHandle(kind, opts).finally(() => pendingOpens.delete(key));
		pendingOpens.set(key, open);
		const handle = await open;
		// The launch may resolve AFTER the caller has already aborted (the outer
		// `untilAborted` rejects immediately on abort but does not cancel the
		// inner promise, and `launchHeadlessBrowser` does not accept a signal).
		// Without this branch the completed handle sits in `browsers` at
		// refCount:0 forever — no tab ever takes a hold, `releaseBrowser` never
		// fires, and `releaseAllTabs` walks `tabs`, not `browsers`, so the
		// orphaned Chromium/app process / puppeteer handle survives to process
		// exit. (Issue #3963.)
		if (opts.signal?.aborted) {
			await disposeBrowserHandle(handle, { kill: kind.kind === "spawned" }).catch(err => {
				logger.debug("Failed to dispose orphan browser after abort", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
			throw new ToolAbortError("Browser open aborted");
		}
		browsers.set(key, handle);
		return handle;
	}
}

export function normalizeConnectedCdpUrl(rawCdpUrl: string): string {
	const cdpUrl = rawCdpUrl.replace(/\/+$/, "");
	if (/^wss?:\/\//i.test(cdpUrl)) {
		throw new ToolError(
			"browser app.cdp_url must be the HTTP CDP discovery endpoint (for example http://127.0.0.1:9222), not a ws:// browser websocket URL.",
		);
	}
	return cdpUrl;
}

async function openBrowserHandle(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	if (kind.kind === "cmux") {
		const client = new CmuxSocketClient({ socketPath: kind.socketPath, password: kind.password });
		await client.connect();
		return {
			key: browserKey(kind),
			kind,
			client,
			surface: kind.surface,
			refCount: 0,
		};
	}
	if (kind.kind === "headless") {
		// Every real omp process (session, subagent, worker — anything with a CLI
		// worker host) MUST go through the machine-global broker-owned Chromium
		// on the stable agent profile: per-process launches produced launch
		// storms, orphaned process trees and throwaway profiles whose logins
		// evaporated. That path fails closed (`openSharedHeadlessHandle` throws)
		// rather than creating a temp profile.
		if (isCompiledBinary() || workerHostEntry() !== null) {
			return await openSharedHeadlessHandle(kind, opts);
		}
		// TEST/SDK-ONLY FALLBACK: hosts without a CLI worker entry (bun test, SDK
		// embedding) cannot spawn the broker. They get a process-local Chromium
		// on a temp profile that is deleted on dispose. Nothing durable lives
		// here, and it is never reachable from a CLI-hosted run.
		logger.warn("browser: process-local Chromium with a THROWAWAY profile (test/SDK host without a worker entry)", {
			headless: kind.headless,
		});
		const { browser, userDataDir } = await launchHeadlessBrowser({
			headless: kind.headless,
			viewport: opts.viewport,
			ignoreHttpsErrors: kind.ignoreHttpsErrors,
			allowFileAccess: kind.allowFileAccess,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			userDataDir,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}
	if (kind.kind === "connected") {
		const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
		await waitForCdp(cdpUrl, 5_000, opts.signal);
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			cdpUrl,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}
	if (kind.kind === "relay") {
		const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
		// Loopback relays are owned by a machine-global broker (or, when pinned,
		// a launchd job) and auto-started on demand (the extension dials in on
		// its own). Hosts without a CLI worker entry (bun test, SDK embedding)
		// never spawn brokers. Remote relay URLs must already be serving.
		if (isLoopbackRelayUrl(cdpUrl) && (isCompiledBinary() || workerHostEntry() !== null)) {
			await ensureRelayDaemon({
				cdpUrl,
				signal: opts.signal,
				requireProtocol: kind.requireProtocol,
				supervisor: kind.supervisor,
			});
		}
		// The relay answers /json/version with 503 until its extension dials in;
		// the wait fails fast when nothing serves the port, the server has
		// already outlived the window an installed extension needs to connect,
		// or the relay refused the extension that dialed.
		const outcome = await waitForRelayExtension(cdpUrl, opts.signal);
		switch (outcome.kind) {
			case "unreachable":
				throw new ToolError(
					`omp browser relay is not reachable at ${cdpUrl}. Start it with \`omp browser-relay\` (or check the endpoint), and make sure the OMP Browser Relay extension is loaded in Chrome.`,
				);
			case "no-extension":
				throw new ToolError(
					`omp browser relay is serving at ${cdpUrl} but its extension never connected. Install it with \`omp browser-relay install\` and check the toolbar badge shows "on".`,
				);
			case "incompatible-extension":
				throw new ToolError(
					`omp browser relay at ${cdpUrl}: relay extension ${outcome.version} is older than this relay requires (${outcome.required}); reinstall it (omp browser-relay install) and reload it in chrome://extensions.`,
				);
			case "profile-unbound":
				throw new ToolError(
					`omp browser relay at ${cdpUrl}: relay extension from an unbound Chrome profile is connected${outcome.connectedFingerprint ? ` (install ${outcome.connectedFingerprint})` : ""}; bind it with the launcher runbook (omp-relay-share bind --from-connected) or reload the approved profile's extension.`,
				);
			case "profile-mismatch":
				throw new ToolError(
					`omp browser relay at ${cdpUrl}: relay extension install ${outcome.rejectedFingerprint ?? "(unknown)"} was rejected: the relay is bound to Chrome profile install ${outcome.boundFingerprint}; rebind explicitly (omp-relay-share bind) if the approved profile changed.`,
				);
			case "profile-invalid":
				throw new ToolError(`omp browser relay at ${cdpUrl}: ${outcome.error}`);
			case "ready":
				break;
		}
		// The staged relay reports the extension's per-Chrome-run generation
		// (`OMP-Browser-Generation`); it scopes durable relay tab records so a
		// tab id recycled by a Chrome restart can never match an old record.
		// The protocol is re-derived from this same answer (the last one before
		// puppeteer connects) so a relay swapped in after the wait cannot slip
		// under the requirement — hosts that skipped ensureRelayDaemon included.
		// The binding proof follows below, over the adopted connection itself.
		const version = await probeCdpResponse(`${cdpUrl}/json/version`, { timeoutMs: 2_000, signal: opts.signal });
		if (kind.requireProtocol !== undefined) {
			const found = Math.min(outcome.relayProtocol, relayProtocolOf(version) ?? LEGACY_RELAY_PROTOCOL);
			if (found < kind.requireProtocol) {
				throw new ToolError(relayProtocolTooOldMessage(cdpUrl, found, kind.requireProtocol, kind.supervisor));
			}
		}
		let generation: string | undefined;
		let expectedFingerprint: string | undefined;
		try {
			const parsed: unknown = version ? JSON.parse(version.body) : undefined;
			if (isRecord(parsed)) {
				if (typeof parsed["OMP-Browser-Generation"] === "string") generation = parsed["OMP-Browser-Generation"];
				if (typeof parsed["OMP-Profile-Fingerprint"] === "string") {
					expectedFingerprint = parsed["OMP-Profile-Fingerprint"];
				}
			}
		} catch {
			// Legacy relay (18.1.10): no generation; relay tab records stay unprovable and are never reaped.
		}
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		if (kind.requireProtocol !== undefined) {
			// The proof that counts is bound to THIS connection: puppeteer's own
			// discovery lookup and websocket may have reached a different process
			// than the probes above. Only a protocol-2 relay stamps `revision`, and
			// it must be the same bound install the pre-connect answer named.
			let revision: unknown;
			try {
				revision = (await rootCdpConnection(browser).send("Browser.getVersion")).revision;
			} catch (err) {
				await browser.disconnect().catch(() => undefined);
				throw new ToolError(
					`omp browser relay at ${cdpUrl} did not answer Browser.getVersion over the adopted connection: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			const proven = parseRelayRevision(revision);
			if (proven === null || proven.protocol < kind.requireProtocol) {
				await browser.disconnect().catch(() => undefined);
				throw new ToolError(
					relayProtocolTooOldMessage(
						cdpUrl,
						proven?.protocol ?? LEGACY_RELAY_PROTOCOL,
						kind.requireProtocol,
						kind.supervisor,
					),
				);
			}
			const mismatch =
				proven.binding !== "bound"
					? `it is ${proven.binding || "unbound"}, not bound`
					: proven.fingerprint !== expectedFingerprint
						? `it serves Chrome profile install ${proven.fingerprint || "(none)"}, not ${expectedFingerprint ?? "(none)"}`
						: null;
			if (mismatch) {
				await browser.disconnect().catch(() => undefined);
				throw new ToolError(
					`omp browser relay at ${cdpUrl}: the relay puppeteer connected to is not the one that answered /json/version — ${mismatch}. Another relay took the port between the check and the connection; retry, and stop the stray relay (omp ps --global browser-relay list).`,
				);
			}
		}
		return {
			key: browserKey(kind),
			kind,
			browser,
			cdpUrl,
			generation,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}

	const exe = kind.path;
	if (!path.isAbsolute(exe)) {
		throw new ToolError(
			`app.path must be absolute (got ${JSON.stringify(exe)}). Pass the binary inside Foo.app/Contents/MacOS/, not the .app bundle.`,
		);
	}
	const appArgs = kind.args ?? [];
	const reused = await findReusableCdp(exe, { signal: opts.signal, appArgs });
	let cdpUrl: string;
	let pid: number;
	let subprocess: Subprocess | undefined;
	if (reused) {
		logger.debug("Reusing existing CDP endpoint for attach", { exe, pid: reused.pid, cdpUrl: reused.cdpUrl });
		cdpUrl = reused.cdpUrl;
		pid = reused.pid;
	} else {
		const port = await findFreeCdpPort();
		const launchArgs = [...appArgs, `--remote-debugging-port=${port}`];
		const child = Bun.spawn([exe, ...launchArgs], {
			cwd: opts.cwd,
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		child.unref();
		subprocess = child;
		pid = child.pid;
		cdpUrl = `http://127.0.0.1:${port}`;
		try {
			await waitForCdp(cdpUrl, 30_000, opts.signal);
		} catch (err) {
			await gracefulKillTreeOnce(child.pid).catch(() => undefined);
			if (err instanceof ToolAbortError) throw err;
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new ToolError(`Failed to attach to ${path.basename(exe)} on ${cdpUrl}: ${(err as Error).message}`);
		}
	}

	const puppeteer = await loadPuppeteer();
	let browser: Browser;
	try {
		browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
	} catch (err) {
		if (subprocess) await gracefulKillTreeOnce(subprocess.pid);
		throw new ToolError(`Connected to ${cdpUrl} but puppeteer.connect failed: ${(err as Error).message}`);
	}
	return {
		key: browserKey(kind),
		kind,
		browser,
		cdpUrl,
		pid,
		subprocess,
		refCount: 0,
		stealth: { browserSession: null, override: null },
	};
}

export function holdBrowser(handle: BrowserHandle): void {
	handle.refCount++;
}

export async function releaseBrowser(handle: BrowserHandle, opts: ReleaseBrowserOptions): Promise<void> {
	handle.refCount = Math.max(0, handle.refCount - 1);
	if (handle.refCount === 0) {
		// Only evict if the registry still points at THIS handle. After a disconnect,
		// `acquireBrowser` may have already replaced the entry with a fresh live handle
		// under the same key; deleting blindly would orphan that new browser.
		if (browsers.get(handle.key) === handle) browsers.delete(handle.key);
		await disposeBrowserHandle(handle, opts);
	}
}

async function disposeBrowserHandle(handle: BrowserHandle, opts: ReleaseBrowserOptions): Promise<void> {
	if ("client" in handle) {
		handle.client.close();
		return;
	}
	if (handle.kind.kind === "headless") {
		if (handle.sharedDaemon) {
			// The broker owns the Chromium; this process only drops its CDP
			// connection. `kill` is scoped to spawned-app browsers — stopping the
			// shared daemon here would tear down every other session's tabs. The
			// daemon dies with the last omp client in the project (broker idle
			// teardown), or via an explicit stop (`write proc://<name>/kill`).
			if (handle.browser.connected) {
				try {
					handle.browser.disconnect();
				} catch (err) {
					logger.debug("Failed to disconnect from shared browser", { error: (err as Error).message });
				}
			}
			return;
		}
		if (handle.browser.connected) {
			// Puppeteer's `browser.close()` resolves only once the Chromium
			// process fully exits. A wedged Chromium (a known Windows failure
			// mode) leaves this await pending forever, freezing `releaseTab` in
			// the "Closing tab" phase (issue #5260). Bound it, then SIGKILL the
			// process tree so cleanup always completes.
			const proc = handle.browser.process();
			try {
				await withTimeout(handle.browser.close(), HEADLESS_CLOSE_TIMEOUT_MS, "Timed out closing headless browser");
			} catch (err) {
				logger.debug("Failed to close headless browser; force-killing", { error: (err as Error).message });
				if (proc?.pid !== undefined) await gracefulKillTreeOnce(proc.pid).catch(() => undefined);
			}
		}
		// OMP owns the profile directory (puppeteer's temp cleanup is disabled by
		// our explicit --user-data-dir), so remove it now the process tree has
		// exited. Tolerant of the Windows lock-held window (issue #7058).
		if (handle.userDataDir) await removeUserDataDir(handle.userDataDir);
		return;
	}
	// Connected and relay browsers belong to the user: drop our CDP link, never kill.
	if (handle.kind.kind === "connected" || handle.kind.kind === "relay") {
		if (handle.browser.connected) {
			try {
				handle.browser.disconnect();
			} catch (err) {
				logger.debug("Failed to disconnect from remote browser", { error: (err as Error).message });
			}
		}
		return;
	}
	if (handle.browser.connected) {
		try {
			handle.browser.disconnect();
		} catch (err) {
			logger.debug("Failed to disconnect from spawned browser", { error: (err as Error).message });
		}
	}
	// A discovered CDP PID is borrowed, not ours to kill on close or abort.
	if (opts.kill && handle.subprocess && handle.subprocess.exitCode === null) {
		await gracefulKillTreeOnce(handle.subprocess.pid);
	}
}

/**
 * Attach to the machine-global broker-owned Chromium. Failures surface as
 * `ToolError` — a CLI-host process never silently falls back to a private
 * Chromium, so a broken broker cannot quietly recreate per-process launch
 * storms or throwaway profiles.
 */
async function openSharedHeadlessHandle(
	kind: Extract<PuppeteerBrowserKind, { kind: "headless" }>,
	opts: AcquireBrowserOptions,
): Promise<PuppeteerBrowserHandle> {
	if (kind.allowFileAccess) {
		throw new ToolError(
			"browser.open({ allow_file_access:true }) requires a process-local Chromium launch and cannot be applied to the shared agent browser. Use app.path to launch a dedicated browser.",
		);
	}
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	try {
		const shared = await ensureSharedBrowser({
			headless: kind.headless,
			viewport: vp,
			signal: opts.signal,
		});
		if (!shared) {
			throw new ToolError(
				"Agent browser daemon unavailable (global broker start or Chromium launch failed); no throwaway profile is created. Check `omp ps` for omp.browser.* daemons under ~/.omp/run/daemons/global/browser-agent and ~/.omp/logs for details",
			);
		}
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.connect({
			browserWSEndpoint: shared.wsEndpoint,
			defaultViewport: kind.headless
				? {
						width: vp.width,
						height: vp.height,
						deviceScaleFactor: vp.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
					}
				: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		// Targets left behind by omp processes that died without teardown are
		// swept by the tab supervisor on the first tab acquisition for this
		// handle (issue #10022) — it knows the page-level protections and the
		// browser generation; the registry only hands out the connection.
		return {
			key: browserKey(kind),
			kind,
			browser,
			sharedDaemon: {
				name: shared.daemonName,
				runtimeDir: shared.runtimeDir,
				profileDir: shared.profileDir,
				generation: shared.generation,
			},
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	} catch (err) {
		if (err instanceof ToolAbortError || err instanceof ToolError) throw err;
		if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");
		throw new ToolError(`Agent browser attach failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Test-only accessor for the module-global browsers map. */
export function getBrowsersMapForTest(): ReadonlyMap<string, BrowserHandle> {
	return browsers;
}

/**
 * Puppeteer's root CDP connection — the browser session itself. `browser.target()`
 * cannot stand in for it on the relay: the bridge announces no `browser` target
 * and its `Target.attachToTarget` only knows tab/page ids. Puppeteer's own
 * `newPage()` sends `Target.createTarget` on this connection.
 */
export function rootCdpConnection(browser: Browser): Connection {
	// `_connection` is `@internal` on CdpBrowser and absent from the public
	// `Browser` typings; nothing public exposes the browser session.
	const internal = browser as unknown as { _connection?: Connection };
	if (!internal._connection) throw new ToolError("Browser root CDP connection is unavailable");
	return internal._connection;
}
