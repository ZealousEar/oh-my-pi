import * as path from "node:path";
import { isCompiledBinary, isRecord, logger, untilAborted, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type { Browser, CDPSession } from "puppeteer-core";
import { ToolAbortError } from "../tool-errors";
import { ToolError } from "../tool-errors";
import {
	findFreeCdpPort,
	findReusableCdp,
	gracefulKillTreeOnce,
	probeCdpResponse,
	resolveSpawnArgs,
	waitForCdp,
} from "./attach";
import { type CmuxKind, CmuxUnavailableError } from "./cmux/rpc";
import { CmuxSocketClient } from "./cmux/socket-client";
import {
	BROWSER_PROTOCOL_TIMEOUT_MS,
	browserConnection,
	closeLaunchedBrowser,
	connectPuppeteer,
	DEFAULT_VIEWPORT,
	launchHeadlessBrowser,
	loadPuppeteer,
	removeUserDataDir,
	type UserAgentOverride,
} from "./launch";
import type { SharedTargetScope } from "./orphan-registry";
import type { RelayKind } from "./relay/kind";
import {
	LEGACY_RELAY_PROTOCOL,
	relayProtocolOf,
	relayUnavailableAt,
	requestRelayRestart,
	UPDATE_RELAY_EXTENSION,
	waitForRelayExtension,
} from "./relay/probe";
import { parseRelayRevision } from "./relay/protocol";
import { ensureSharedBrowser } from "./shared-daemon";
import type { TernKind } from "./tern/kind";
import { TernSocketClient } from "./tern/wire";
import type { UnitLease } from "./unit-lease";
import { WebKitHost } from "./webkit/host";
import type { WebKitKind } from "./webkit/kind";

export type PuppeteerBrowserKind =
	| {
			kind: "headless";
			headless: boolean;
			/** Process-local launch flag; shared browsers use the tab-scoped CDP override instead. */
			insecure?: boolean;
	  }
	| { kind: "spawned"; path: string; args?: string[] }
	| { kind: "connected"; cdpUrl: string }
	| RelayKind;

export type BrowserKind = PuppeteerBrowserKind | CmuxKind | TernKind | WebKitKind;

export type BrowserKindTag = BrowserKind["kind"];

interface BrowserHandleCommon {
	key: string;
	kind: BrowserKind;
	refCount: number;
}

export interface PuppeteerBrowserHandle extends BrowserHandleCommon {
	kind: PuppeteerBrowserKind;
	browser: Browser;
	/** Browser-level WebSocket endpoint tab workers attach through. */
	wsEndpoint: string;
	cdpUrl?: string;
	/** The browser's main process, which owns its windows on screen; unknown for connected endpoints and the relay. */
	pid?: number;
	/** OMP-owned TEMP Chromium profile removed on dispose. Only the labeled test/SDK fallback sets this. */
	userDataDir?: string;
	/** Daemon unit backing this handle; dispose disconnects instead of closing, kill routes to the daemon. */
	sharedDaemon?: { name: string; runtimeDir: string; profileDir: string; generation: string };
	/** Lease on the shared Chromium daemon unit this handle uses; released on dispose. */
	daemonLease?: UnitLease;
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

/** A connection to the Tern daemon whose browser PiPs host this handle's tabs. */
export interface TernBrowserHandle extends BrowserHandleCommon {
	kind: TernKind;
	/** The daemon connection every tab of this handle drives its PiP through. */
	tern: TernSocketClient;
}

/** omp's own WebKit host process, whose headless web views (one block each) are this handle's tabs. */
export interface WebKitBrowserHandle extends BrowserHandleCommon {
	kind: WebKitKind;
	/** The host process omp started and stops with the handle. */
	webkit: WebKitHost;
}

export type BrowserHandle = PuppeteerBrowserHandle | CmuxBrowserHandle | TernBrowserHandle | WebKitBrowserHandle;

/**
 * Durable-ownership scope for a browser handle, or undefined when the handle is
 * not the machine-global daemon-supervised agent Chromium (the only browser whose targets
 * outlive their creating process and thus need cross-process orphan reaping).
 */
export function sharedTargetScopeOf(handle: BrowserHandle): SharedTargetScope | undefined {
	if (!("browser" in handle)) return undefined;
	if (handle.kind.kind !== "headless" || !handle.sharedDaemon) return undefined;
	return { runtimeDir: handle.sharedDaemon.runtimeDir, daemonName: handle.sharedDaemon.name };
}

/** Controls bounded browser-handle teardown and identifies the owning resource in timeout diagnostics. */
export interface ReleaseBrowserOptions {
	kill: boolean;
	timeoutMs?: number;
	resource?: string;
}

const browsers = new Map<string, BrowserHandle>();
/**
 * In-flight opens by browser key, so concurrent acquisitions share one launch instead of storming Chromium.
 * `settled` resolves once the open settles or its caller aborts, whichever comes first.
 */
const pendingOpens = new Map<string, { settled: Promise<void> }>();

export function browserKey(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless:${kind.headless ? "1" : "0"}:${kind.insecure ? "tls" : ""}`;
		case "spawned":
			return `spawned:${JSON.stringify([kind.path, kind.args ?? []])}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "relay":
			return `relay:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.socketPath}`;
		case "tern":
			return `tern:${kind.socketPath}:${kind.pane}`;
		case "webkit":
			return `webkit:${kind.path}`;
	}
}

export interface AcquireBrowserOptions {
	cwd: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	signal?: AbortSignal;
	/** Ask a relay served by an older omp to restart from the installed one. Default true. */
	restartRelay?: boolean;
}

export async function acquireBrowser(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	if (kind.kind === "spawned") kind = { ...kind, args: resolveSpawnArgs(kind.path, kind.args, opts.cwd) };
	const key = browserKey(kind);
	for (;;) {
		const existing = browsers.get(key);
		if (existing) {
			if ("client" in existing) return existing;
			if (
				"tern" in existing
					? existing.tern.connected
					: "webkit" in existing
						? existing.webkit.client.connected
						: existing.browser.connected
			) {
				return existing;
			}
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
			await untilAborted(opts.signal, () => pending.settled);
			continue;
		}
		const open = openBrowserHandle(kind, opts);
		const settled = Promise.withResolvers<void>();
		const entry = { settled: settled.promise };
		// An open whose caller aborted is disposed below, never published, so it
		// stops being this key's single flight the moment its caller gives up:
		// waiters start a fresh attempt instead of waiting out a launch or connect
		// that may never return. Only the registered entry is removed, so a late
		// settlement cannot drop a replacement already in flight. A spawned app
		// keeps its key until its abandoned open has been disposed: that kills
		// the app, which a fresh attempt could otherwise adopt as a reusable endpoint.
		const clearEntry = () => {
			opts.signal?.removeEventListener("abort", clearEntry);
			if (pendingOpens.get(key) === entry) pendingOpens.delete(key);
			settled.resolve();
		};
		if (kind.kind !== "spawned") opts.signal?.addEventListener("abort", clearEntry, { once: true });
		pendingOpens.set(key, entry);
		let handle: BrowserHandle;
		try {
			handle = await open;
		} catch (error) {
			clearEntry();
			throw error;
		}
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
			clearEntry();
			throw new ToolAbortError("Browser open aborted");
		}
		browsers.set(key, handle);
		clearEntry();
		return handle;
	}
}

export function normalizeConnectedCdpUrl(rawCdpUrl: string): string {
	const cdpUrl = rawCdpUrl.replace(/\/+$/, "");
	if (/^wss?:\/\//i.test(cdpUrl)) {
		throw new ToolError(
			"browser app CDP URL must be the HTTP CDP discovery endpoint (for example http://127.0.0.1:9222), not a ws:// browser websocket URL.",
		);
	}
	return cdpUrl;
}

/** Refusal of a relay below the protocol `OMP_BROWSER_RELAY_REQUIRE_PROTOCOL` demands, naming how to replace it. */
function relayProtocolTooOldMessage(cdpUrl: string, found: number, required: number): string {
	return `omp browser relay at ${cdpUrl} is a legacy/stock relay (protocol ${found}); this omp requires protocol ${required}. Run \`omp browser-relay install\` with this omp and reload the omp extension in Chrome, then retry.`;
}

async function openBrowserHandle(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	if (kind.kind === "cmux") {
		const client = new CmuxSocketClient({ socketPath: kind.socketPath, password: kind.password });
		await client.connect().catch((error: unknown) => {
			if (error instanceof ToolError && !(error instanceof ToolAbortError)) {
				throw new CmuxUnavailableError(error.message);
			}
			throw error;
		});
		return {
			key: browserKey(kind),
			kind,
			client,
			surface: kind.surface,
			refCount: 0,
		};
	}
	if (kind.kind === "tern") {
		const tern = new TernSocketClient({ socketPath: kind.socketPath });
		await tern.connect();
		return { key: browserKey(kind), kind, tern, refCount: 0 };
	}
	if (kind.kind === "webkit") {
		return {
			key: browserKey(kind),
			kind,
			webkit: await WebKitHost.launch(kind.path, kind.viewer, opts.signal),
			refCount: 0,
		};
	}
	if (kind.kind === "headless") {
		// Every real omp process (session, subagent, worker — anything with a CLI
		// worker host) MUST go through the machine-global daemon-supervised Chromium
		// on the stable agent profile: per-process launches produced launch
		// storms, orphaned process trees and throwaway profiles whose logins
		// evaporated. That path fails closed (`openSharedHeadlessHandle` throws)
		// rather than creating a temp profile.
		if (isCompiledBinary() || workerHostEntry() !== null) {
			return await openSharedHeadlessHandle(kind, opts);
		}
		// TEST/SDK-ONLY FALLBACK: hosts without a CLI worker entry (bun test, SDK
		// embedding) cannot start the omp daemon. They get a process-local Chromium
		// on a temp profile that is deleted on dispose. Nothing durable lives
		// here, and it is never reachable from a CLI-hosted run.
		logger.warn("browser: process-local Chromium with a THROWAWAY profile (test/SDK host without a worker entry)", {
			headless: kind.headless,
		});
		const { browser, wsEndpoint, userDataDir } = await launchHeadlessBrowser({
			headless: kind.headless,
			viewport: opts.viewport,
			insecure: kind.insecure,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			wsEndpoint,
			pid: browser.process()?.pid,
			userDataDir,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}
	if (kind.kind === "connected") {
		const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
		await waitForCdp(cdpUrl, 5_000, opts.signal);
		const puppeteer = await loadPuppeteer();
		const browser = await connectPuppeteer(puppeteer, {
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			wsEndpoint: browser.wsEndpoint(),
			cdpUrl,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}
	if (kind.kind === "relay") {
		if (!kind.cdpUrl)
			throw new ToolError(
				"No local omp browser relay found. Open Chrome with the omp extension, or configure browser.relayUrl.",
			);
		const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
		// The omp extension's native host serves the relay while Chrome runs; nothing here starts it.
		let outcome = await waitForRelayExtension(cdpUrl, opts.signal);
		// A host from an older omp keeps serving across upgrades. Restart an incompatible one from the installed omp,
		// and a compatible older one only while no CDP client uses it; an older one that stays is still usable.
		if ((outcome === "outdated-relay" || outcome === "idle-older-relay") && opts.restartRelay !== false) {
			const idleOnly = outcome === "idle-older-relay";
			if (await requestRelayRestart(cdpUrl, { idleOnly, signal: opts.signal }))
				outcome = await waitForRelayExtension(cdpUrl, opts.signal, { restarted: true });
		}
		if (outcome === "unreachable") {
			throw new ToolError(
				`Nothing serves the omp browser relay at ${cdpUrl}: Chrome is not running with the omp extension. Open Chrome; if the extension is loaded, run \`omp browser-relay install\` to register its native host.`,
			);
		}
		if (outcome === "no-extension") {
			throw new ToolError(
				`The omp browser relay at ${cdpUrl} is up, but its browser never said hello. Reload the omp extension in Chrome.`,
			);
		}
		if (outcome === "profile-unbound" || outcome === "profile-mismatch" || outcome === "profile-invalid") {
			// The relay refused the Chrome profile that dialed: its 503 names the install and the fix.
			const refusal = await relayUnavailableAt(cdpUrl, opts.signal);
			throw new ToolError(
				`omp browser relay at ${cdpUrl}: ${refusal?.error || `the relay refused the connected Chrome profile (${outcome})`}`,
			);
		}
		// The relay reports the extension's per-Chrome-run generation (`OMP-Browser-Generation`); it scopes durable
		// relay tab records so a tab id recycled by a Chrome restart can never match an old record. The protocol is
		// derived from this same answer (the last one before puppeteer connects) so a relay swapped in after the wait
		// cannot slip under the requirement. The binding proof follows below, over the adopted connection itself.
		const version = await probeCdpResponse(`${cdpUrl}/json/version`, { timeoutMs: 2_000, signal: opts.signal });
		if (kind.requireProtocol !== undefined) {
			const found = relayProtocolOf(version) ?? LEGACY_RELAY_PROTOCOL;
			if (found < kind.requireProtocol) {
				throw new ToolError(relayProtocolTooOldMessage(cdpUrl, found, kind.requireProtocol));
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
		// After the protocol requirement: a stock relay fails on the requirement it
		// cannot meet, not on a capability it never advertised.
		if (outcome === "outdated-relay") {
			throw new ToolError(
				`The browser relay at ${cdpUrl} comes from an older omp. Run \`omp browser-relay install\` with this omp, then reload the omp extension in Chrome.`,
			);
		}
		if (outcome === "outdated-extension") {
			throw new ToolError(`The omp extension is out of date. ${UPDATE_RELAY_EXTENSION}`);
		}
		const puppeteer = await loadPuppeteer();
		const browser = await connectPuppeteer(puppeteer, {
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
				revision = (await browserConnection(browser).send("Browser.getVersion")).revision;
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
					relayProtocolTooOldMessage(cdpUrl, proven?.protocol ?? LEGACY_RELAY_PROTOCOL, kind.requireProtocol),
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
					`omp browser relay at ${cdpUrl}: the relay puppeteer connected to is not the one that answered /json/version — ${mismatch}. Another relay took the port between the check and the connection; retry, and quit the browser serving the stray relay.`,
				);
			}
		}
		return {
			key: browserKey(kind),
			kind,
			browser,
			wsEndpoint: browser.wsEndpoint(),
			cdpUrl,
			generation,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}

	const exe = kind.path;
	if (!path.isAbsolute(exe)) {
		throw new ToolError(
			`app must be an absolute executable path (got ${JSON.stringify(exe)}). Pass the binary inside Foo.app/Contents/MacOS/, not the .app bundle.`,
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
		browser = await connectPuppeteer(puppeteer, {
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
		wsEndpoint: browser.wsEndpoint(),
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
	if ("tern" in handle) {
		handle.tern.close();
		return;
	}
	if ("webkit" in handle) {
		// The host is omp's own process whoever asked: it stops with its last tab, `kill` or not.
		await handle.webkit.close();
		return;
	}
	if (handle.kind.kind === "headless") {
		if (handle.sharedDaemon) {
			// The daemon owns the Chromium; this process only drops its CDP
			// connection and its lease. `kill` is scoped to spawned-app browsers —
			// stopping the shared unit here would tear down every other session's
			// tabs. Chrome dies shortly after the last omp client in the project
			// releases its lease (unit idle policy), when its CDP endpoint stops
			// answering after a failed tab cleanup
			// (`stopSharedBrowserIfUnreachable`), or via an explicit stop
			// (`write proc://<name>/kill`).
			if (handle.browser.connected) {
				try {
					handle.browser.disconnect();
				} catch (err) {
					logger.debug("Failed to disconnect from shared browser", { error: (err as Error).message });
				}
			}
			await handle.daemonLease?.release();
			return;
		}
		if (handle.browser.connected) {
			await closeLaunchedBrowser({ browser: handle.browser, userDataDir: handle.userDataDir });
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
		await handle.daemonLease?.release();
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
 * Attach to the machine-global daemon-supervised agent Chromium. Failures
 * surface as `ToolError` — a CLI-host process never silently falls back to a
 * private Chromium, so a broken daemon cannot quietly recreate per-process
 * launch storms or throwaway profiles.
 */
async function openSharedHeadlessHandle(
	kind: Extract<PuppeteerBrowserKind, { kind: "headless" }>,
	opts: AcquireBrowserOptions,
): Promise<PuppeteerBrowserHandle> {
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	let lease: UnitLease | undefined;
	try {
		const shared = await ensureSharedBrowser({
			headless: kind.headless,
			viewport: vp,
			signal: opts.signal,
		});
		lease = shared.lease;
		const puppeteer = await loadPuppeteer();
		const browser = await connectPuppeteer(puppeteer, {
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
			wsEndpoint: shared.wsEndpoint,
			pid: shared.pid,
			sharedDaemon: {
				name: shared.daemonName,
				runtimeDir: shared.runtimeDir,
				profileDir: shared.profileDir,
				generation: shared.generation,
			},
			daemonLease: shared.lease,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	} catch (err) {
		await lease?.release();
		if (err instanceof ToolAbortError || err instanceof ToolError) throw err;
		if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");
		throw new ToolError(`Agent browser attach failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Test-only accessor for the module-global browsers map. */
export function getBrowsersMapForTest(): ReadonlyMap<string, BrowserHandle> {
	return browsers;
}
