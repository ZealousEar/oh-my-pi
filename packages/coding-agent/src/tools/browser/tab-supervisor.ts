import {
	getGlobalDaemonRuntimeDir,
	getProjectDir,
	getPuppeteerDir,
	logger,
	postmortem,
	Snowflake,
	withTimeout,
	workerHostEntry,
} from "@oh-my-pi/pi-utils";
import type { Browser, CDPSession, Connection, Page, Target } from "puppeteer-core";
import { callSessionTool } from "../../eval/js/tool-bridge";
import { webpExclusionForModel } from "@oh-my-pi/pi-tui/chat/image-loading";
import type { ToolSession } from "../index";
import { expandPath } from "../path-utils";
import { ToolAbortError } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { gracefulKillTreeOnce, pickElectronTarget, shouldPreserveConnectedBrowserFocus } from "./attach";
import { CmuxTab, runCmuxCode } from "./cmux/cmux-tab";
import { mapWaitUntil } from "./cmux/rpc";
import { BROWSER_PROTOCOL_TIMEOUT_MS, DEFAULT_VIEWPORT } from "./launch";
import {
	type AutomationAction,
	automationDeniedError,
	decideAutomationAction,
	fingerprintAutomationCode,
	getAutomationScopes,
} from "../automation-policy";
import {
	closeCdpTarget,
	forgetSharedTarget,
	type OrphanTarget,
	reapOrphanSharedTargets,
	recordSharedTarget,
	type SharedTargetScope,
	touchSharedTarget,
} from "./orphan-registry";
import { RELAY_DAEMON_NAME } from "./relay/daemon";
import {
	type BrowserHandle,
	type BrowserKindTag,
	type CmuxBrowserHandle,
	holdBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
	rootCdpConnection,
} from "./registry";
import {
	originOf,
	type ReadyInfo,
	type RunBinding,
	type RunErrorPayload,
	type RunResultOk,
	type SessionSnapshot,
	targetChangedDenial,
	type Transferable,
	type Transport,
	type WorkerInbound,
	type WorkerInitPayload,
	type WorkerOutbound,
} from "./tab-protocol";

// Coding-agent binary/bundle workers route through the CLI entrypoint with a
// hidden argv mode, so compiled/npm builds only need one JavaScript entry.

interface WorkerHandle {
	send(msg: WorkerInbound, transferList?: Transferable[]): void;
	onMessage(handler: (msg: WorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
	readonly mode: "worker" | "inline";
}

export type DialogPolicy = "accept" | "dismiss";

export interface PendingRun {
	resolve(result: RunResultOk): void;
	reject(error: unknown): void;
	session: ToolSession;
	signal?: AbortSignal;
	toolCalls: Map<string, AbortController>;
	/**
	 * Fires when `releaseTab` closes the tab out from under an in-flight run
	 * (sibling `browser close --all`, session-scoped reap, etc.). Composed
	 * into the cmux run's signal so `wait(...)`, cmux socket calls, and the
	 * facade proxies unwind promptly instead of blocking to the run's
	 * timeout. `pending.reject` still fires first so the awaiting caller
	 * sees the tab-close error immediately; `closeAc` propagates the
	 * cancellation into the still-running `runCmuxCode` body (issue #4499).
	 */
	closeAc?: AbortController;
}

interface TabSessionBase<TBrowser extends BrowserHandle = BrowserHandle> {
	name: string;
	browser: TBrowser;
	targetId: string;
	state: "alive" | "dead";
	info: ReadyInfo;
	pending: Map<string, PendingRun>;
	dialogPolicy?: DialogPolicy;
	kindTag: BrowserKindTag;
	/**
	 * Session id of the caller that CREATED the tab. Preserved across reuse so
	 * that dispose of the creating session can reap browser resources without
	 * yanking the tab out from under a subagent that only reused it.
	 * Undefined when the acquirer did not identify itself.
	 */
	ownerSessionId?: string;
	/**
	 * Opt out of settle-freeze and idle-close reaping. Recorded on the tab
	 * when created (never on reuse), mirroring `ownerSessionId`: keeping a
	 * tab live across turns is the creator's explicit decision.
	 */
	persist?: boolean;
	/**
	 * Wall-clock (`Date.now()`) of the last MEANINGFUL, tool-driven use:
	 * create, reuse, run start and run end. Websocket keepalives, settle
	 * freeze/unfreeze and passive page reloads never refresh it. Drives both
	 * the short-lived idle-close (`browser.idleCloseSec`) and the six-hour
	 * abandoned-tab reaper (`browser.tabs.abandonedIdleHours`), and is
	 * mirrored into the durable ownership record.
	 */
	lastActivityAt: number;
	/**
	 * True after a successful settle-freeze (`Page.setWebLifecycleState`
	 * frozen). Cleared on unfreeze/create. Freeze pauses rAF/timers so an
	 * idle animated page stops burning CPU/GPU; the renderer, worker, and
	 * DOM state stay alive for millisecond resume.
	 */
	frozen: boolean;
}

export interface WorkerTabSession extends TabSessionBase<PuppeteerBrowserHandle> {
	backend: "worker";
	worker: WorkerHandle;
	activateForScreenshot: boolean;
	/**
	 * The page is omp's to close: a headless page, or a target the supervisor
	 * created for `app.new_tab` on a relay/connected browser. False for an
	 * adopted user tab, which release never closes.
	 */
	ownsTarget: boolean;
}

export interface CmuxTabSession extends TabSessionBase<CmuxBrowserHandle> {
	backend: "cmux";
	cmuxTab: CmuxTab;
	cmuxOwnsSurface: boolean;
	cmuxAttachedSurface?: string;
}

export type TabSession = WorkerTabSession | CmuxTabSession;

export interface AcquireTabOptions {
	url?: string;
	waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	target?: string;
	/**
	 * Create a fresh omp-owned target instead of adopting an existing one.
	 * Relay and connected browsers only (headless already owns its page);
	 * mutually exclusive with `target`. The created tab is closed on release.
	 */
	createTarget?: boolean;
	signal?: AbortSignal;
	timeoutMs: number;
	/**
	 * `performance.now()` timestamp at which the caller's timeout budget
	 * started. Callers whose deadline began before this acquisition —
	 * `browser.ts` `open` starts its clock before `acquireBrowser` — pass it
	 * through so time spent in earlier phases within the caller's deadline
	 * counts against the worker-init budget instead of restarting it.
	 * Omit for a fresh clock.
	 */
	deadlineStartMs?: number;
	dialogs?: DialogPolicy;
	cmuxSurface?: string;
	/**
	 * Session id of the acquirer. Recorded on the tab when created (never on
	 * reuse) so `releaseTabsForOwner` can walk the shared tabs map on session
	 * dispose. Optional — omitting it opts the tab out of session-scoped reap.
	 */
	ownerSessionId?: string;
	/**
	 * Keep the tab live across turn settle and idle close. Recorded on the
	 * tab when created (never on reuse) so a later caller cannot silently
	 * extend another session's tab lifetime.
	 */
	persist?: boolean;
	/** Acquirer's tool session: supplies the user-granted automation scopes for reuse-time navigation. */
	session?: ToolSession;
	/** Acquirer's eval invocation (`toolCallId`): an approve-once scope for the reuse-time navigation binds to it. */
	invocationId?: string;
	/** `browser.tabs.abandonedIdleHours` in ms; governs the once-per-browser sweep of targets inherited from crashed owners. */
	abandonedIdleMs?: number;
}

export interface AcquireTabResult {
	tab: TabSession;
	created: boolean;
}

export interface RunInTabOptions {
	code: string;
	timeoutMs: number;
	signal?: AbortSignal;
	session: ToolSession;
	/**
	 * Policy descriptor for this dispatch. Decided by `decideAutomationAction`
	 * with the session's user-granted scopes immediately before the worker
	 * receives the code. Omitted → fail safe: the run is treated as raw
	 * arbitrary page access (`mutate` + `raw`, `browser.tab.run`), which no
	 * `"*"` scope covers.
	 */
	automation?: AutomationAction;
	/** Eval-prelude invocation (`toolCallId`); approve-once scopes bind to exactly this. */
	invocationId?: string;
}

export interface ReleaseTabOptions {
	kill?: boolean;
	/** Maximum time for each asynchronous cleanup resource before close fails with diagnostics. */
	timeoutMs?: number;
}

const tabs = new Map<string, TabSession>();
// Headless targets a worker created before dying during init (page-created).
// A killed worker can't close its own page; the supervisor closes the
// recorded target instead. A shared browser's other targets must never be
// touched.
const workerPageTargets = new WeakMap<WorkerHandle, string>();
// Per-name acquisition chain: serializes concurrent `acquireTab` calls for the
// same tab name so the existence check and `tabs.set` (separated by several
// awaits) cannot interleave and leak a worker + browser refCount.
const acquireChains = new Map<string, Promise<void>>();
const GRACE_MS = 750;
// Cold-start guard for the worker's `setup` handshake (realm usable: puppeteer
// loaded, browser connected, page acquired). On hosts where the worker's cold
// import stalls (observed: Bun worker inside a full RPC process), an
// unbounded first-attempt init would consume the caller's entire timeout
// before the inline fallback could engage. Budget: min(10s, remaining/3),
// floor 2s, where remaining is what the caller's budget has left at attempt start.
const SETUP_BUDGET_FLOOR_MS = 2_000;
const SETUP_BUDGET_CAP_MS = 10_000;
// Floor for the ready-phase budget: the 2s setup floor can consume more than
// a sub-3s caller's entire init budget, so the remaining-budget math must
// never hand raceWithTimeout a non-positive value.
const READY_BUDGET_FLOOR_MS = 500;
// Names of tabs the supervisor force-killed (timeout past grace, failed recycle),
// mapped to the kill reason. Lets the next `run` on that name explain WHY the tab
// vanished instead of a bare "not alive". Cleared when the name is opened again.
const killedTabs = new Map<string, string>();
const DEFAULT_TAB_CLOSE_TIMEOUT_MS = 5_000;
class RecoverableWorkerError extends ToolError {}
const REPORTED_INIT_FAILURE = Symbol("reported-init-failure");

type ReportedInitFailure = Error & { [REPORTED_INIT_FAILURE]?: true };

function markReportedInitFailure(error: Error): Error {
	(error as ReportedInitFailure)[REPORTED_INIT_FAILURE] = true;
	return error;
}

function isReportedInitFailure(error: unknown): boolean {
	return error instanceof Error && (error as ReportedInitFailure)[REPORTED_INIT_FAILURE] === true;
}

async function waitForTabCleanup<T>(
	tab: TabSession,
	timeoutMs: number,
	pendingResource: string,
	promise: Promise<T>,
): Promise<T> {
	const message = `Timed out after ${timeoutMs}ms closing ${tab.kindTag} browser tab ${JSON.stringify(tab.name)}; pending resource: ${pendingResource}`;
	try {
		return await withTimeout(promise, timeoutMs, message);
	} catch (error) {
		if (error instanceof Error && error.message === message) throw new ToolError(message);
		throw error;
	}
}

export function getTab(name: string): TabSession | undefined {
	return tabs.get(name);
}

export function acquireTab(name: string, browser: BrowserHandle, opts: AcquireTabOptions): Promise<AcquireTabResult> {
	// Keep the supervisor's Puppeteer handle connected until initialization,
	// worker termination, and abandoned-target cleanup have all been scheduled.
	// The tool caller's outer timeout can release its own lease before this
	// promise settles; without an acquisition-owned hold, cleanup would then
	// run through a disconnected handle and leave the worker's page behind.
	holdBrowser(browser);
	const prior = acquireChains.get(name) ?? Promise.resolve();
	const acquisition = prior.then(() => acquireTabImpl(name, browser, opts));
	const result = acquisition.then(
		async value => {
			await releaseBrowser(browser, { kill: false });
			return value;
		},
		async error => {
			await releaseBrowser(browser, { kill: false }).catch(() => undefined);
			throw error;
		},
	);
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	acquireChains.set(name, tail);
	void tail.then(() => {
		if (acquireChains.get(name) === tail) acquireChains.delete(name);
	});
	return result;
}

async function acquireTabImpl(
	name: string,
	browser: BrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	// Worker-init deadline: the inline-fallback retry passes this same start
	// so it can't restart the budget (which would let a cold import that
	// consumed most of it spend the phase floors again for another full
	// budget). Defaults to a fresh clock; callers whose own deadline started
	// earlier (browser acquisition is not part of this budget) pass theirs
	// through `deadlineStartMs` so that earlier time counts against it.
	const startedAt = opts.deadlineStartMs ?? performance.now();
	// Serialized opens can sit behind a slow predecessor in the per-name
	// chain; honor an abort at dequeue instead of spawning a worker and
	// browser hold nobody is waiting for.
	if (opts.signal?.aborted) {
		throw new ToolAbortError("Browser tab open aborted");
	}
	killedTabs.delete(name);
	// Temporary refCount hold so releasing an existing tab on the SAME browser
	// below cannot drop it to refCount 0 and dispose the instance we are about
	// to reuse (e.g. reopening the sole tab with a different dialogs policy).
	let tempHold = false;
	const existing = tabs.get(name);
	if (existing) {
		if (existing.browser === browser && existing.state === "alive") {
			const requestedCmuxSurface = "client" in browser ? (opts.cmuxSurface ?? browser.surface) : undefined;
			if (existing.backend === "cmux" && existing.cmuxAttachedSurface !== requestedCmuxSurface) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else if (opts.dialogs !== undefined && opts.dialogs !== existing.dialogPolicy) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else if (opts.createTarget && existing.backend === "worker" && !existing.ownsTarget) {
				// The caller asked for an omp-owned tab; the name currently
				// holds an adopted user tab. Release (never closes it) and
				// create the owned one instead of silently reusing.
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else {
				// Reuse counts as use: refresh the idle clock and resume a
				// settle-frozen page before driving it again. A refused
				// resume fails the open here with the same actionable
				// error a run would raise, instead of reporting a reuse
				// that can never execute.
				existing.lastActivityAt = now();
				// Resume BEFORE applying `persist` below: flipping the flag
				// first would make `isSettleManaged` reject this very
				// resume, so reopening a frozen tab with `persist: true`
				// would always fail.
				if (!(await unfreezeTabSession(existing))) {
					throw new ToolError(
						`Tab ${JSON.stringify(name)} is frozen and could not be resumed. Close and reopen it.`,
					);
				}
				// The creator may opt out later: an explicit `persist` on
				// reuse by the owning session updates the tab (omitted
				// leaves it). Reuse by any other session never changes it.
				// Applied after the resume above for the reason stated there.
				if (opts.persist !== undefined && existing.ownerSessionId === opts.ownerSessionId) {
					existing.persist = opts.persist;
				}
				const reuseScope = durableScopeOf(existing);
				if (reuseScope) {
					void touchSharedTarget(reuseScope, existing.targetId, {
						lastMeaningfulActivityAt: existing.lastActivityAt,
						persist: existing.persist === true,
					});
				}
				const reuseSteps: string[] = [];
				if (opts.viewport && browser.kind.kind !== "cmux") {
					const dsf = opts.viewport.deviceScaleFactor;
					reuseSteps.push(
						`await page.setViewport({ width: ${opts.viewport.width}, height: ${opts.viewport.height}, deviceScaleFactor: ${dsf === undefined ? "undefined" : String(dsf)} });`,
					);
				}
				if (opts.url) {
					reuseSteps.push(
						`await tab.goto(${JSON.stringify(opts.url)}, { waitUntil: ${JSON.stringify(opts.waitUntil ?? "load")} });`,
					);
				}
				if (reuseSteps.length) {
					// Reuse-time navigation is a dispatch like any other: an
					// OMP-owned tab navigates freely, steering an adopted user
					// tab to a new URL is a mutation of the user's browser.
					const owned = existing.backend !== "worker" || existing.ownsTarget;
					await runInTabWithSnapshot(
						name,
						{
							code: reuseSteps.join("\n"),
							timeoutMs: opts.timeoutMs,
							signal: opts.signal,
							session: opts.session,
							invocationId: opts.invocationId,
							automation: {
								surface: "browser",
								tier: owned ? "navigate" : "mutate",
								action: opts.url ? "browser.tab.goto" : "browser.tab.viewport",
								target: originOf(opts.url ?? existing.info.url),
								consequential: false,
								raw: false,
								ownsTarget: owned,
								summary: opts.url
									? `navigate ${owned ? "owned" : "adopted"} tab ${JSON.stringify(name)} to ${originOf(opts.url)}`
									: `set viewport on tab ${JSON.stringify(name)}`,
							},
						},
						{ cwd: getProjectDir() },
					);
				}
				refreshAbandonedDeadline();
				return { tab: tabs.get(name)!, created: false };
			}
		} else {
			if (existing.browser === browser) {
				holdBrowser(browser);
				tempHold = true;
			}
			await releaseTab(name, { kill: false });
		}
	}

	if ("client" in browser) {
		try {
			const result = await acquireCmuxTab(name, browser, opts);
			if (tempHold) await releaseBrowser(browser, { kill: false });
			return result;
		} catch (error) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
	}
	let initPayload: WorkerInitPayload;
	let worker: WorkerHandle;
	// Target `buildInitPayload` created for `createTarget`. The worker never
	// reports it (no `page-created`), so `closeAbandonedWorkerPage` cannot
	// reap it: every terminal failure path below closes it explicitly. The
	// inline-fallback retry keeps it — the second worker attaches to it.
	let ownedTargetId: string | undefined;
	try {
		initPayload = await buildInitPayload(browser, opts);
		if (initPayload.mode === "attach" && initPayload.ownsTarget) ownedTargetId = initPayload.targetId;
		worker = await spawnTabWorker();
	} catch (error) {
		closeAbandonedTarget(browser, ownedTargetId);
		// Failing before the worker took its own hold must release the
		// temporary one, or the browser's refCount never reaches 0 again.
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
		throw error;
	}
	// Init budget: the caller's timeout plus the supervisor grace — never a
	// fixed floor. A floor larger than the caller's budget would keep a wedged
	// worker (and its orphaned page on a shared browser) alive long after the
	// caller gave up; the phase floors inside initializeTabWorker keep each
	// phase positive for sub-second budgets, and the caller's abort signal is
	// the hard backstop for floor overshoot.
	const initBudgetMs = opts.timeoutMs + GRACE_MS;
	let info: ReadyInfo;
	try {
		info = await initializeTabWorker(worker, initPayload, initBudgetMs, startedAt);
	} catch (error) {
		// `BuildMessage`-class failures arrive asynchronously via the worker's `error` event,
		// after `spawnTabWorker`'s synchronous try/catch has already returned. Fall back to
		// the inline worker here so module-resolution failures don't poison every tab open.
		await worker.terminate().catch(() => undefined);
		// A headless worker that died mid-init may have already created its page in the
		// shared browser — a killed worker can't close it, so close the target the worker
		// reported (no-op when it never got that far).
		closeAbandonedWorkerPage(browser, worker);
		if (worker.mode === "inline" || isReportedInitFailure(error)) {
			closeAbandonedTarget(browser, ownedTargetId);
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
		// Fail fast once the caller's init budget is exhausted: its timeout has already
		// fired, so a retried result would only be discarded by the post-init abort check —
		// don't spend the phase floors' excess on a cold start nobody is waiting for.
		if (initBudgetExhausted(initBudgetMs, startedAt)) {
			closeAbandonedTarget(browser, ownedTargetId);
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
		logger.warn("Tab worker init failed; retrying with inline tab worker (no sync-loop guard)", {
			error: error instanceof Error ? error.message : String(error),
		});
		worker = await spawnInlineWorker();
		try {
			info = await initializeTabWorker(worker, initPayload, initBudgetMs, startedAt);
		} catch (inlineError) {
			await worker.terminate().catch(() => undefined);
			closeAbandonedWorkerPage(browser, worker);
			closeAbandonedTarget(browser, ownedTargetId);
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			const finalError = new ToolError(
				`Failed to start browser tab worker (inline fallback also failed): ${inlineError instanceof Error ? inlineError.message : String(inlineError)}`,
			);
			(finalError as { cause?: unknown }).cause = error;
			throw finalError;
		}
	}

	// If the caller aborted while we were spawning/initializing the worker, tear
	// the freshly-built worker down before publishing the tab so the browser
	// refCount (which `holdBrowser` below would take) never grows for a tab
	// nobody is waiting for. Mirror the error paths' `refCount === 0` release so
	// a fresh browser held by nothing but this aborted open is not orphaned in
	// the registry; a browser still leased/held elsewhere (refCount > 0) is left
	// for its owner to release.
	if (opts.signal?.aborted) {
		await worker.terminate().catch(() => undefined);
		closeAbandonedWorkerPage(browser, worker);
		closeAbandonedTarget(browser, ownedTargetId);
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false }).catch(() => undefined);
		throw new ToolAbortError("Browser tab open aborted");
	}

	holdBrowser(browser);
	if (tempHold) await releaseBrowser(browser, { kill: false });
	const tab: WorkerTabSession = {
		name,
		browser,
		targetId: info.targetId,
		backend: "worker",
		worker,
		state: "alive",
		info,
		pending: new Map(),
		dialogPolicy: opts.dialogs,
		kindTag: browser.kind.kind,
		activateForScreenshot: initPayload.mode === "headless" || initPayload.activateForScreenshot !== false,
		ownsTarget: ownedTargetId !== undefined || initPayload.mode === "headless",
		ownerSessionId: opts.ownerSessionId,
		persist: opts.persist ?? false,
		lastActivityAt: now(),
		frozen: false,
	};
	worker.onMessage(msg => handleTabMessage(tab, msg));
	tabs.set(name, tab);
	// Durably record ownership + lifecycle metadata for every target OMP
	// created in a browser that outlives this process, so another live omp
	// process can reap it if this one dies before its own teardown, and so
	// the abandoned-tab reaper can prove creation after a restart. Adopted
	// user tabs get no record — nothing can ever reap them.
	const scope = durableScopeOf(tab);
	if (scope) {
		void recordOwnedTarget(tab, scope, opts.ownerSessionId);
		// First tab on this browser handle: reap targets left by omp processes
		// that died without teardown. Detached so a slow sweep never delays the open.
		void sweepInheritedTargets(tab, opts.abandonedIdleMs ?? 0);
	}
	if (opts.abandonedIdleMs !== undefined && opts.abandonedIdleMs > 0) {
		// Arm (or shorten) the process-wide deadline so this tab is reaped even
		// if no further turn or open ever happens.
		armAbandonedDeadline({ idleMs: opts.abandonedIdleMs });
	} else {
		refreshAbandonedDeadline();
	}
	return { tab, created: true };
}

async function acquireCmuxTab(
	name: string,
	browser: CmuxBrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	const attachedSurface = opts.cmuxSurface ?? browser.surface;
	if (attachedSurface?.startsWith("surface:")) {
		throw new ToolError(
			"app.surface must be a surface UUID (e.g. CMUX_SURFACE_ID), not a 'surface:N' ref; omit it to open a new split",
		);
	}

	let surfaceId = attachedSurface;
	let initialUrl = opts.url;
	let ownsSurface = false;
	try {
		if (!surfaceId) {
			const params: Record<string, unknown> = { url: opts.url ?? "about:blank", focus: false };
			if (process.env.CMUX_WORKSPACE_ID) params.workspace_id = process.env.CMUX_WORKSPACE_ID;
			if (process.env.CMUX_SURFACE_ID) params.surface_id = process.env.CMUX_SURFACE_ID;
			const result = await browser.client.request("browser.open_split", params, { timeoutMs: opts.timeoutMs });
			if (typeof result.surface_id !== "string" || result.surface_id.length === 0) {
				throw new ToolError("cmux browser.open_split did not return a surface_id");
			}
			surfaceId = result.surface_id;
			ownsSurface = true;
			if (typeof result.url === "string" && result.url.length > 0) initialUrl = result.url;
			if (opts.url) {
				await browser.client.request(
					"browser.wait",
					{
						surface_id: surfaceId,
						load_state: mapWaitUntil(opts.waitUntil ?? "load"),
						timeout_ms: opts.timeoutMs,
					},
					{ timeoutMs: opts.timeoutMs },
				);
			}
		}

		const cmuxTab = new CmuxTab({ client: browser.client, surfaceId, url: initialUrl });
		if (attachedSurface && opts.url) {
			await cmuxTab.goto(opts.url, { waitUntil: opts.waitUntil ?? "load", timeoutMs: opts.timeoutMs });
		}
		const info = await cmuxTab.readyInfo(opts.viewport ?? DEFAULT_VIEWPORT);
		// If the caller aborted while we were opening the cmux surface, close the
		// surface (if we own it) instead of taking a browser hold on it.
		if (opts.signal?.aborted) {
			throw new ToolAbortError("Browser tab open aborted");
		}
		holdBrowser(browser);
		const tab: CmuxTabSession = {
			name,
			browser,
			targetId: surfaceId,
			backend: "cmux",
			cmuxTab,
			cmuxOwnsSurface: ownsSurface,
			state: "alive",
			info,
			pending: new Map(),
			dialogPolicy: opts.dialogs,
			kindTag: browser.kind.kind,
			cmuxAttachedSurface: attachedSurface,
			ownerSessionId: opts.ownerSessionId,
			persist: opts.persist ?? false,
			lastActivityAt: now(),
			frozen: false,
		};
		tabs.set(name, tab);
		return { tab, created: true };
	} catch (error) {
		if (ownsSurface && surfaceId) {
			await browser.client.request("surface.close", { surface_id: surfaceId }).catch(() => undefined);
		}
		throw error;
	}
}

export async function runInTab(name: string, opts: RunInTabOptions): Promise<RunResultOk> {
	return await runInTabWithSnapshot(
		name,
		{
			code: opts.code,
			timeoutMs: opts.timeoutMs,
			signal: opts.signal,
			session: opts.session,
			automation: opts.automation,
			invocationId: opts.invocationId,
		},
		{
			cwd: opts.session.cwd,
			browserScreenshotDir: expandBrowserScreenshotDir(opts.session),
			excludeWebP: webpExclusionForModel(opts.session.getActiveModel?.()),
		},
	);
}

/** Fail-safe descriptor for a dispatch that named no action: arbitrary page access. */
const RAW_RUN_ACTION: Omit<AutomationAction, "target"> = {
	surface: "browser",
	tier: "mutate",
	action: "browser.tab.run",
	consequential: false,
	raw: true,
	summary: "arbitrary browser code (tab.run)",
};

/** Verbs whose policy target is where the tab is GOING, not the page it is on. */
const DESTINATION_ACTIONS: ReadonlySet<string> = new Set(["browser.tab.goto"]);

/** Authoritative ownership for policy: OMP created this target (never the caller's word). */
function ownsTargetOf(tab: TabSession): boolean {
	return tab.backend !== "worker" || tab.ownsTarget;
}

/**
 * Decide one dispatch against the session's user-granted scopes. Called
 * immediately before the worker receives the code — after unfreeze, after
 * any task candidate selection — so it always sees the freshest scope set
 * and the page's current origin. Raw access (`tab.run`, `evaluate`, raw
 * Puppeteer/CDP) is `mutate` + `raw` no matter what the code contains, so a
 * "read-only looking" run cannot bypass the gate; every raw action carries
 * the fingerprint of the exact string the worker will execute. `ownsTarget`
 * is always overwritten from supervisor state: a caller cannot promote an
 * adopted user tab to "owned" to unlock free navigation.
 *
 * Returns the binding the worker must re-prove against the live document
 * for non-raw mutations (the decided origin), or undefined for reads and raw
 * runs (raw is authorized by code, not origin).
 */
function gateDispatch(
	tab: TabSession,
	opts: { code: string; session?: ToolSession; automation?: AutomationAction; invocationId?: string },
): RunBinding | undefined {
	const requested = opts.automation ?? { ...RAW_RUN_ACTION, target: originOf(tab.info.url) };
	const invocationId = requested.invocationId ?? opts.invocationId;
	const identity = { ownsTarget: ownsTargetOf(tab), ...(invocationId ? { invocationId } : {}) };
	const action: AutomationAction = requested.raw
		? {
				...requested,
				tier: "mutate",
				codeFingerprint: requested.codeFingerprint ?? fingerprintAutomationCode(opts.code),
				...identity,
			}
		: { ...requested, ...identity };
	const scopes = opts.session ? getAutomationScopes(opts.session, now()) : [];
	const verdict = decideAutomationAction(action, { scopes, now: now() });
	if (verdict.verdict === "deny") throw automationDeniedError(verdict);
	// Bind every decision that was ABOUT the current page (click/type/... on
	// the origin the tab showed when classified). Raw runs are authorized by
	// code, reads need no scope, and `goto` was decided for its destination —
	// the page it leaves is irrelevant to that grant. The rule deliberately
	// ignores `tab.info` here: a ready-info refresh landing between
	// classification and this gate must not turn a bound action into an
	// unbound one.
	if (action.raw || action.tier === "read" || DESTINATION_ACTIONS.has(action.action)) return undefined;
	return { target: action.target, action: action.action };
}

async function runInTabWithSnapshot(
	name: string,
	opts: {
		code: string;
		timeoutMs: number;
		signal?: AbortSignal;
		session?: ToolSession;
		automation?: AutomationAction;
		invocationId?: string;
	},
	snapshot: SessionSnapshot,
): Promise<RunResultOk> {
	const tab = tabs.get(name);
	if (!tab || tab.state === "dead") {
		const killed = killedTabs.get(name);
		throw new ToolError(
			killed
				? `Tab ${JSON.stringify(name)} was killed: ${killed}. Reopen it.`
				: `Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`,
		);
	}
	if (tab.pending.size > 0) throw new ToolError(`Tab ${JSON.stringify(name)} is busy`);
	// An already-aborted call never runs: without this early exit the worker
	// branch below would send `abort` before `run`, which the worker ignores
	// for a not-yet-active run and then execute anyway.
	if (opts.signal?.aborted) throw new ToolAbortError();
	// A run is use: refresh the meaningful-activity clock (idle-close and the
	// abandoned reaper). Refreshed BEFORE the policy gate so a denied attempt
	// awaiting a scope prompt cannot look abandoned meanwhile.
	tab.lastActivityAt = now();
	const id = Snowflake.next();
	const { promise, resolve, reject } = Promise.withResolvers<RunResultOk>();
	// `releaseTab` calls `pending.reject(closeError)` when the tab dies
	// out from under an in-flight run (sibling `browser close --all`,
	// session-scoped reap, etc.). Both backends below MUST end up awaiting
	// this same `promise` so:
	//   1. The caller sees `Tab ... was closed` immediately instead of
	//      blocking to the run's timeout, and
	//   2. `reject(...)` always has an attached handler — a zero-consumer
	//      rejection would fire `unhandledRejection` and the CLI's
	//      top-level handler would tear the whole session down, killing
	//      every other tab and subagent sharing the process (issue #4499).
	// The cmux branch also composes `closeAc.signal` into the run's abort
	// signal so `wait(...)`, cmux socket calls, and the facade proxies
	// unwind promptly when the tab is closed — otherwise a `wait(60_000)`
	// with no in-flight socket request would keep `runCmuxCode` blocked
	// until timeout even after the tab is gone.
	const closeAc = new AbortController();
	const pending: PendingRun = {
		resolve,
		reject,
		session: opts.session ?? ({} as ToolSession),
		signal: opts.signal,
		toolCalls: new Map(),
		closeAc,
	};
	// Register BEFORE the unfreeze await below. Settle-freeze guards on
	// `pending` (and undoes a transition already in flight when it observes
	// one at completion), so a turn-end freeze can neither start nor land
	// mid-run. Without this ordering a parent's settle could freeze a tab a
	// subagent is reusing between our unfreeze check and this registration,
	// stalling timer/rAF-dependent code to timeout.
	tab.pending.set(id, pending);
	// Observe the run promise from registration on: every exit below this
	// point (resume failure, teardown race) throws before the backends
	// attach their consumers, and an unobserved `pending.reject` would fire
	// `unhandledRejection` and tear the whole session down (issue #4499).
	promise.catch(() => undefined);
	// Resume a settle-frozen page before driving it — frozen rAF/timers would
	// otherwise hang the execution below. A refused resume fails the run
	// here with an actionable error instead of stalling to timeout.
	if (!(await unfreezeTabSession(tab))) {
		tab.pending.delete(id);
		throw new ToolError(`Tab ${JSON.stringify(name)} is frozen and could not be resumed. Close and reopen it.`);
	}
	// An abort that landed during the resume roundtrip must not dispatch:
	// the worker ignores `abort` for a run that was never started.
	if (opts.signal?.aborted) {
		tab.pending.delete(id);
		throw new ToolAbortError();
	}
	const current = tabs.get(name);
	if (current !== tab || current.state === "dead") {
		// A teardown won the race with our unfreeze roundtrip. Prefer its
		// close error when one was recorded (`releaseTab` rejects `pending`
		// synchronously, so it is already settled here); otherwise surface
		// the closure. `race` — not a bare `await promise` — so a teardown
		// that never settled the run cannot hang us.
		tab.pending.delete(id);
		const notAlive = new ToolError(`Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`);
		return await Promise.race([promise, Promise.reject(notAlive)]);
	}
	// Permission gate: the last thing before the code leaves this process.
	let binding: RunBinding | undefined;
	try {
		binding = gateDispatch(tab, opts);
	} catch (error) {
		tab.pending.delete(id);
		throw error;
	}
	// Background-tab throttling on a user-driven browser: a relay/connected
	// tab OMP owns but that is not the window's active tab stops producing
	// frames, so clicks/fills time out although the DOM looks fine (observed
	// on the 18.1.10 relay with a background Gemini tab). Resume it —
	// lifecycle `active` + focus emulation — right before input. Adopted user
	// tabs are left alone: emulating focus there changes the user's page.
	if (tab.backend === "worker" && tab.ownsTarget && (tab.kindTag === "relay" || tab.kindTag === "connected")) {
		await resumeOwnedUserDrivenTab(tab);
	}
	if (tab.backend === "cmux") {
		const runSignal = opts.signal ? AbortSignal.any([opts.signal, closeAc.signal]) : closeAc.signal;
		try {
			// Same live-document binding as the worker path: cmux has no
			// in-process page, so ask the surface for its current URL now.
			if (binding) {
				const live = await tab.cmuxTab.readyInfo(tab.info.viewport).catch(() => undefined);
				if (live) tab.info = live;
				if (!live || originOf(live.url) !== binding.target) {
					throw new ToolError(targetChangedDenial(binding, live?.url));
				}
			}
			// `runCmuxCode.then(resolve, reject)` publishes the run's real
			// outcome to `promise`, but `releaseTab` may have already
			// rejected it — `Promise.withResolvers` settles on the first
			// call and later resolve/reject are no-ops, so the tab-close
			// error still wins the race.
			runCmuxCode(tab.cmuxTab, {
				code: opts.code,
				timeoutMs: opts.timeoutMs,
				signal: runSignal,
				session: pending.session,
				snapshot,
			}).then(resolve, reject);
			return await promise;
		} finally {
			tab.pending.delete(id);
			// Completion is use too: a run outlasting the idle timeout must
			// not look stale to the sweep right after it finishes.
			tab.lastActivityAt = now();
			syncDurableActivity(tab);
			refreshAbandonedDeadline();
		}
	}
	const abort = (): void => {
		safeSend(tab, { type: "abort", id });
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(opts.signal?.reason);
	};
	if (opts.signal?.aborted) abort();
	else opts.signal?.addEventListener("abort", abort, { once: true });
	try {
		tab.worker.send({
			type: "run",
			id,
			name,
			code: opts.code,
			timeoutMs: opts.timeoutMs,
			session: snapshot,
			binding,
		});
		try {
			return await raceWithTimeout(
				promise,
				opts.timeoutMs + GRACE_MS,
				"Browser code execution hung past grace; tab killed",
				async reason => await forceKillTab(name, reason),
			);
		} catch (error) {
			const runTimedOut =
				error instanceof ToolError && error.message.startsWith("Browser code execution timed out after ");
			if (runTimedOut || error instanceof RecoverableWorkerError) {
				try {
					if (tab.worker.mode === "inline") {
						const reason = runTimedOut
							? "Browser code execution timed out; tab killed"
							: "Browser request interception cleanup failed; tab killed";
						await forceKillTab(name, reason);
					} else {
						await recycleTimedOutWorkerTab(tab, opts.timeoutMs + GRACE_MS);
					}
				} catch (recycleError) {
					logger.warn("Failed to recycle browser tab worker; killing tab", {
						error: recycleError instanceof Error ? recycleError.message : String(recycleError),
					});
					await forceKillTab(name, "Browser tab worker recovery failed; tab killed");
				}
			}
			throw error;
		}
	} finally {
		opts.signal?.removeEventListener("abort", abort);
		tab.pending.delete(id);
		// Completion is use too: a run outlasting the idle timeout must
		// not look stale to the sweep right after it finishes.
		tab.lastActivityAt = now();
		syncDurableActivity(tab);
		refreshAbandonedDeadline();
	}
}

/**
 * In-flight releases by tab object. A second `releaseTab` for a tab already
 * being torn down joins the first instead of redoubling teardown: without
 * this, a same-name acquire racing a sweep's release would publish a
 * replacement that the first release's unconditional delete then removes
 * (and the shared browser hold would release twice). Joiners share the
 * first release's outcome.
 */
const releaseInflight = new WeakMap<TabSession, { promise: Promise<boolean>; opts: ReleaseTabOptions }>();

export async function releaseTab(name: string, opts: ReleaseTabOptions = {}): Promise<boolean> {
	const tab = tabs.get(name);
	if (!tab) {
		logger.debug("releaseTab: unknown tab", { name });
		return false;
	}
	const ongoing = releaseInflight.get(tab);
	if (ongoing) {
		// Coalesce cleanup strength: a joining disposal must not lose its
		// kill request to an earlier non-killing close — `releaseBrowser`
		// reads `opts.kill` at teardown time, so the upgrade lands as long
		// as the first release has not finished. (Not directly testable
		// in-process: observing it needs a real spawned application.)
		ongoing.opts.kill = ongoing.opts.kill || opts.kill;
		const joined = await ongoing.promise;
		// The upgrade above lands too late when the first release already
		// passed `releaseBrowser`: verify a still-running spawned app is
		// terminated rather than trusting the joined outcome.
		if (opts.kill) await ensureSpawnedKilled(tab.browser);
		return joined;
	}
	const entry = { promise: releaseTabInner(tab, name, opts), opts };
	releaseInflight.set(tab, entry);
	try {
		return await entry.promise;
	} finally {
		releaseInflight.delete(tab);
	}
}

/**
 * Best-effort termination of a spawned app that outlived a joined teardown.
 * Fires only behind a live subprocess handle (kernel-tracked, so no
 * pid-reuse hazard): anything else already died or was never ours to kill.
 */
async function ensureSpawnedKilled(browser: BrowserHandle): Promise<void> {
	if (browser.kind.kind !== "spawned" || !("subprocess" in browser)) return;
	const { pid, subprocess } = browser;
	if (pid === undefined || !subprocess || subprocess.exitCode !== null) return;
	await gracefulKillTreeOnce(pid).catch(() => undefined);
}

/** Test hook for the kill guards without a live application. */
export function ensureSpawnedKilledForTest(browser: BrowserHandle): Promise<void> {
	return ensureSpawnedKilled(browser);
}

async function releaseTabInner(tab: TabSession, name: string, opts: ReleaseTabOptions): Promise<boolean> {
	const wasAlive = tab.state === "alive";
	tab.state = "dead";
	const closeError = postmortem.markExpectedCleanupError(new ToolError(`Tab ${JSON.stringify(name)} was closed`));
	for (const [id, pending] of tab.pending) {
		if (tab.backend === "worker") {
			try {
				tab.worker.send({ type: "abort", id, expectedCleanup: true });
			} catch {}
		}
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(closeError);
		// Propagate the closure into the cmux run's abort signal so
		// `wait(...)`, in-flight cmux socket calls, and the facade proxies
		// unwind promptly. Firing this BEFORE `pending.reject` means
		// `runCmuxCode` finishes with `ToolAbortError` and its `.then(reject)`
		// is a no-op — `promise` still settles with the tab-close error via
		// the `reject` call below. Without it, a run that isn't currently
		// making a socket request (e.g. `await wait(60_000)`) would keep
		// `runCmuxCode` blocked until timeout even after `pending.reject`
		// unblocked the caller (issue #4499 review feedback).
		pending.closeAc?.abort(closeError);
		pending.reject(closeError);
	}
	tab.pending.clear();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TAB_CLOSE_TIMEOUT_MS;
	if (tab.backend === "cmux") {
		let closeError: unknown;
		if (wasAlive && tab.cmuxOwnsSurface) {
			try {
				await waitForTabCleanup(
					tab,
					timeoutMs,
					`cmux surface ${JSON.stringify(tab.targetId)} (surface.close)`,
					tab.browser.client.request("surface.close", { surface_id: tab.targetId }, { timeoutMs }),
				);
			} catch (err) {
				if (isLastSurfaceCloseError(err)) {
					logger.debug("Leaving cmux browser surface open because it is the last surface in the workspace", {
						error: err instanceof Error ? err.message : String(err),
					});
				} else {
					closeError = err;
				}
			}
		}
		try {
			await releaseBrowser(tab.browser, {
				kill: opts.kill ?? false,
				timeoutMs,
				resource: `tab ${JSON.stringify(name)}`,
			});
		} catch (error) {
			closeError ??= error;
		} finally {
			tabs.delete(name);
		}
		if (closeError) throw closeError;
		return true;
	}
	let cleanupError: unknown;
	let forced = false;
	// The durable record is forgotten only once the target is confirmed
	// gone (worker closed it, or the supervisor's Page.close succeeded). A
	// target that survived a failed close stays recorded so a later sweep
	// (this process's crash transfer) can still find it.
	let targetClosed = !wasAlive;
	if (wasAlive) {
		try {
			tab.worker.send({ type: "close" });
			await waitForClosed(tab);
			targetClosed = true;
		} catch {
			forced = true;
		}
	}
	await tab.worker.terminate().catch(() => undefined);
	if (forced && tab.ownsTarget) {
		try {
			targetClosed = await waitForTabCleanup(
				tab,
				timeoutMs,
				`orphan CDP target ${JSON.stringify(tab.targetId)} (Page.close)`,
				closeOrphanTarget(tab),
			);
		} catch (error) {
			cleanupError = error;
		}
	}
	try {
		await releaseBrowser(tab.browser, {
			kill: opts.kill ?? false,
			timeoutMs,
			resource: `tab ${JSON.stringify(name)}`,
		});
	} catch (error) {
		cleanupError ??= error;
	} finally {
		tabs.delete(name);
		const scope = durableScopeOf(tab);
		if (scope && targetClosed) void forgetSharedTarget(scope, tab.targetId);
		refreshAbandonedDeadline();
	}
	if (cleanupError) throw cleanupError;
	return true;
}

export async function releaseAllTabs(opts: ReleaseTabOptions = {}): Promise<number> {
	const names = [...tabs.keys()];
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

export async function dropHeadlessTabs(): Promise<void> {
	const names = [...tabs.values()].filter(tab => tab.kindTag === "headless").map(tab => tab.name);
	for (const name of names) await releaseTab(name);
}

/**
 * Release every tab created by the given session id. Invoked from
 * `AgentSession.dispose()` so headless/spawned Chromium and workers the
 * session opened do not leak into the long-lived process — the module-global
 * `tabs`/`browsers` maps that back this tool are not otherwise walked by
 * session teardown. (Issue #3963.)
 *
 * Ownership is recorded ONLY on tab creation (`acquireTab` with
 * `ownerSessionId`), never on reuse: a subagent re-driving a tab another
 * session opened will not yank teardown responsibility away from the
 * creator. Tabs opened with no owner (e.g. from an SDK caller that doesn't
 * identify a session) are skipped and must be released explicitly.
 */
export async function releaseTabsForOwner(ownerId: string, opts: ReleaseTabOptions = {}): Promise<number> {
	if (!ownerId) return 0;
	const names = [...tabs.values()].filter(tab => tab.ownerSessionId === ownerId).map(tab => tab.name);
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

/**
 * Tabs this settle machinery may ever touch: OMP-launched headless puppeteer
 * tabs (`kindTag === "headless"` covers hidden and visible shared-daemon
 * tabs) that are alive and not opted out with `persist`. Connected, relay,
 * and spawned tabs drive the user's own pages/apps, and cmux surfaces are a
 * different backend with no CDP lifecycle — all are never frozen or reaped
 * here. Ownership follows the `releaseTabsForOwner` contract: recorded on
 * creation, never transferred by reuse.
 */
function isSettleManaged(tab: TabSession): boolean {
	return tab.backend === "worker" && tab.kindTag === "headless" && tab.state === "alive" && !tab.persist;
}

/**
 * Find the live puppeteer target backing a tab. Mirrors the tab worker's
 * attach scan: fast `_targetId` path first, CDP comparison across targets
 * otherwise. Returns undefined when the target is already gone.
 */
async function findTargetForTab(tab: WorkerTabSession): Promise<Target | undefined> {
	for (const target of tab.browser.browser.targets()) {
		if ((await targetIdForTarget(target).catch(() => "")) !== tab.targetId) continue;
		return target;
	}
	return undefined;
}

/**
 * Set a tab's web lifecycle state through a supervisor-owned CDP session —
 * no worker-protocol change needed; CDP allows multiple sessions per target.
 * `frozen` pauses rAF/timers (the SwiftShader burn in #8246); `active`
 * resumes. Best-effort in the safe direction: false when the tab is gone or
 * the protocol call fails, leaving `frozen` untouched so the next checkpoint
 * retries and close paths still apply.
 *
 * Race protocol (all flag reads/writes below run atomically between awaits):
 * runs register `pending` before driving the page, so a freeze that starts
 * after a run began stands down at the guard. A freeze already past the
 * guard when a run registers rechecks `pending` after its CDP roundtrip and
 * re-asserts `active` on the same session — a frozen frame already sent
 * cannot be unsent, so the undo guarantees the run never executes on a
 * frozen page. Unfreezing always proceeds: resuming is safe under any
 * pending state.
 */
async function setTabFrozen(tab: TabSession, frozen: boolean): Promise<boolean> {
	if (!isSettleManaged(tab) || tab.backend !== "worker") return false;
	if (tab.frozen === frozen) return false;
	if (frozen && tab.pending.size > 0) return false;
	const target = await findTargetForTab(tab).catch(() => undefined);
	if (!target) return false;
	const session = await target.createCDPSession().catch(() => null);
	if (!session) return false;
	try {
		await session.send("Page.enable").catch(() => undefined);
		await session.send("Page.setWebLifecycleState", { state: frozen ? "frozen" : "active" });
		if (tab.state !== "alive") return false;
		if (frozen) {
			if (tab.frozen) return false;
			if (tab.pending.size > 0 || tab.persist) {
				// A run registered, or the owner opted out with `persist`,
				// while our CDP roundtrip was in flight. Either way the
				// frozen frame may already have landed, so re-assert
				// `active` instead of recording frozen — a persist tab left
				// frozen could never resume (unfreeze is rejected by the
				// same persist eligibility gate).
				if (await sendLifecycleState(session, "active")) return false;
				// One retry for the in-flight run's sake: a brief frozen
				// blip is harmless (rAF just skips frames), but an
				// indefinite freeze stalls it to timeout.
				await Bun.sleep(100);
				if (await sendLifecycleState(session, "active")) return false;
				tab.frozen = true;
				return false;
			}
			tab.frozen = true;
			return true;
		}
		tab.frozen = false;
		return true;
	} catch (error) {
		logger.debug("Browser tab lifecycle transition failed; leaving tab lifecycle state unchanged", {
			name: tab.name,
			frozen,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	} finally {
		await session.detach().catch(() => undefined);
	}
}

/** Best-effort lifecycle write on an owned CDP session; false when the call fails. */
async function sendLifecycleState(session: CDPSession, state: "frozen" | "active"): Promise<boolean> {
	try {
		await session.send("Page.setWebLifecycleState", { state });
		return true;
	} catch {
		return false;
	}
}

/** Test hook for the lifecycle transition without a tabs-map entry. */
export function setTabFrozenForTest(tab: TabSession, frozen: boolean): Promise<boolean> {
	return setTabFrozen(tab, frozen);
}

/**
 * Resume a tab before driving it. Returns false only when the page target
 * exists but refuses the `active` transition even after one retry — the
 * page is most likely still paused, so the caller must not dispatch onto
 * it. A vanished target returns true: the run proceeds and surfaces the
 * real page error immediately instead of hanging to timeout.
 */
async function unfreezeTabSession(tab: TabSession): Promise<boolean> {
	if (!tab.frozen) return true;
	if (tab.backend === "worker") {
		const target = await findTargetForTab(tab).catch(() => undefined);
		// Page target gone: let the run proceed and surface the real page
		// error immediately instead of hanging to timeout.
		if (!target) return true;
	}
	if (await setTabFrozen(tab, false).catch(() => false)) return true;
	await Bun.sleep(100);
	return await setTabFrozen(tab, false).catch(() => false);
}

/** Test hook for the pre-run resume without a tabs-map entry. */
export function unfreezeTabSessionForTest(tab: TabSession): Promise<boolean> {
	return unfreezeTabSession(tab);
}

/**
 * Freeze every managed tab owned by `ownerId` (issue #8246). Turn-settle
 * checkpoint: an idle animated page stops burning CPU/GPU while keeping its
 * renderer, worker, and DOM state for millisecond resume on next use. Tabs
 * with in-flight runs are skipped at the guard; a freeze already past the
 * guard when a run registers undoes itself at completion (see
 * `setTabFrozen`), so neither path can stall a run mid-execution.
 */
export async function freezeTabsForOwner(ownerId: string): Promise<number> {
	if (!ownerId) return 0;
	let count = 0;
	for (const tab of tabs.values()) {
		if (tab.ownerSessionId !== ownerId) continue;
		if (await setTabFrozen(tab, true).catch(() => false)) count++;
	}
	return count;
}
/**
 * Idle-close eligibility: owned, settle-managed, no in-flight run, and idle
 * past the deadline. An executing tab is not idle even when its run outlasts
 * the timeout. Exported so the never-touch contract is unit-testable;
 * `releaseIdleTabsForOwner` walks the map with exactly this predicate.
 */
export function isIdleCloseCandidate(tab: TabSession, ownerId: string, nowMs: number, idleMs: number): boolean {
	return (
		tab.ownerSessionId === ownerId &&
		isSettleManaged(tab) &&
		tab.pending.size === 0 &&
		nowMs - tab.lastActivityAt >= idleMs
	);
}
/**
 * Close managed tabs owned by `ownerId` idle longer than `idleMs` — the
 * memory backstop under settle-freeze (frozen tabs still hold their renderer
 * and worker). Never throws: a wedged tab counts as unclosed and the sweep
 * continues, returning the partial count — reapers must not fail callers.
 */
export async function releaseIdleTabsForOwner(
	ownerId: string,
	opts: { idleMs: number } & ReleaseTabOptions = { idleMs: 0 },
): Promise<number> {
	if (!ownerId) return 0;
	const nowMs = now();
	const names = [...tabs.values()]
		.filter(tab => isIdleCloseCandidate(tab, ownerId, nowMs, opts.idleMs))
		.map(tab => tab.name);
	let count = 0;
	// Program-order token: a cancel landing after this increment suppresses
	// the re-arm below, so disabling mid-sweep cannot resurrect the deadline.
	const sweepSeq = ++idleCloseSeq;
	try {
		for (const name of names) {
			// Revalidate immediately before closing: an earlier close in this
			// loop awaits worker cleanup, during which a later candidate may
			// have been reused or started a run.
			const current = tabs.get(name);
			if (!current || !isIdleCloseCandidate(current, ownerId, now(), opts.idleMs)) continue;
			try {
				if (await releaseTab(name, opts)) count++;
			} catch (error) {
				// One tab's wedged cleanup must not abandon the remaining
				// candidates; the tab is already removed from the map, so
				// the next sweep (or close path) retries it.
				logger.debug("Failed to close idle browser tab; continuing sweep", {
					name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	} finally {
		// Leave the next deadline armed even when a close threw — unless
		// cancelled mid-sweep. Sweeps only fire on turns, opens, and timer
		// callbacks, so without re-arming the survivors would never close.
		if ((idleCloseCancelSeq.get(ownerId) ?? 0) <= sweepSeq) {
			armIdleCloseForOwner(ownerId, opts.idleMs);
		}
	}
	return count;
}

/** Per-owner one-shot timers arming the idle-close backstop. Always unref'd. */
const idleCloseTimers = new Map<string, NodeJS.Timeout>();

/**
 * Monotonic clock ordering sweeps against cancels: each sweep entry and
 * each cancel takes the next value, so a sweep can tell whether a cancel
 * landed mid-flight.
 */
let idleCloseSeq = 0;
/** Last cancel sequence per owner; sweeps re-arm only when uncancelled. */
const idleCloseCancelSeq = new Map<string, number>();

/** Recheck cadence when a firing sweep skips due-but-busy tabs. Overridable in tests. */
const IDLE_DUE_RETRY_MS = 30_000;

/**
 * Milliseconds until the owner's next managed tab goes idle, `0` when one
 * already is, or undefined when no managed tab is tracked. The sweep
 * checkpoints (turn settle, open) handle the due case synchronously; the
 * timer covers abandonment with no further activity.
 */
export function earliestIdleCloseInMs(ownerId: string, idleMs: number, nowMs: number = now()): number | undefined {
	if (!ownerId || !(idleMs > 0)) return undefined;
	let earliest: number | undefined;
	for (const tab of tabs.values()) {
		if (tab.ownerSessionId !== ownerId || !isSettleManaged(tab)) continue;
		const remaining = idleMs - (nowMs - tab.lastActivityAt);
		if (remaining <= 0) return 0;
		earliest = earliest === undefined ? remaining : Math.min(earliest, remaining);
	}
	return earliest;
}

/** Drop a pending idle-close deadline and invalidate a sweep in flight. */
export function cancelIdleCloseForOwner(ownerId: string): void {
	if (!ownerId) return;
	clearIdleCloseTimer(ownerId);
	idleCloseCancelSeq.set(ownerId, ++idleCloseSeq);
}

/** Test probe: whether the owner currently has an armed deadline. */
export function hasIdleCloseTimerForTest(ownerId: string): boolean {
	return idleCloseTimers.has(ownerId);
}

function clearIdleCloseTimer(ownerId: string): void {
	const existing = idleCloseTimers.get(ownerId);
	if (existing === undefined) return;
	idleCloseTimers.delete(ownerId);
	clearTimeout(existing);
}

/**
 * (Re)arm the owner-scoped one-shot that closes idle tabs when the timeout
 * elapses without further activity. Without this, a tab used in the final
 * turn before an idle session would sit until the next turn, open, or
 * dispose despite the advertised timeout. The timer is unref'd so it never
 * holds the process open (print/RPC exits are unaffected), firing
 * re-enters through `releaseIdleTabsForOwner` — which re-arms while
 * survivors remain — and disposal needs no cleanup since a fired sweep
 * over released tabs is a no-op. Due-but-busy survivors re-arm on a short
 * retry cadence instead of losing their deadline until the next sweep.
 * @param retryMs recheck cadence for due-but-busy survivors; keep well above zero.
 */
export function armIdleCloseForOwner(ownerId: string, idleMs: number, retryMs: number = IDLE_DUE_RETRY_MS): void {
	clearIdleCloseTimer(ownerId);
	const delay = earliestIdleCloseInMs(ownerId, idleMs);
	if (delay === undefined) return;
	const wait = delay <= 0 ? retryMs : Math.min(delay, 2_147_483_647);
	const timer = setTimeout(() => {
		idleCloseTimers.delete(ownerId);
		void releaseIdleTabsForOwner(ownerId, { idleMs })
			.then(() => armIdleCloseForOwner(ownerId, idleMs, retryMs))
			.catch(() => undefined);
	}, wait);
	timer.unref();
	idleCloseTimers.set(ownerId, timer);
}

/** Test-only accessor for the module-global tabs map. */
export function getTabsMapForTest(): Map<string, TabSession> {
	return tabs;
}

function isLastSurfaceCloseError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /last/i.test(message);
}

async function buildInitPayload(browser: PuppeteerBrowserHandle, opts: AcquireTabOptions): Promise<WorkerInitPayload> {
	const safeDir = getPuppeteerDir();
	const browserWSEndpoint = browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	if (browser.kind.kind === "headless") {
		if (opts.createTarget) throw new ToolError(NEW_TAB_KIND_ERROR);
		return {
			mode: "headless",
			browserWSEndpoint,
			safeDir,
			// Visible launches still need an OMP-owned page, stealth setup, and
			// independent lifecycle; only their fixed device emulation is disabled.
			emulateViewport: browser.kind.headless,
			viewport: opts.viewport,
			dialogs: opts.dialogs,
			url: opts.url,
			waitUntil: opts.waitUntil,
			timeoutMs: opts.timeoutMs,
		};
	}
	// Connected and relay browsers are user-driven. When no target is requested,
	// adopt the visible tab and avoid raising it before screenshots. An explicit
	// target may be backgrounded, so retain activation for target-correct pixels.
	const userDriven = browser.kind.kind === "connected" || browser.kind.kind === "relay";
	if (opts.createTarget) {
		if (opts.target) throw new ToolError(NEW_TAB_TARGET_ERROR);
		if (!userDriven) throw new ToolError(NEW_TAB_KIND_ERROR);
		const targetId = await createOwnedTarget(browser);
		return {
			mode: "attach",
			browserWSEndpoint,
			safeDir,
			targetId,
			dialogs: opts.dialogs,
			// The target starts at about:blank; the worker performs the one
			// navigation with the caller's wait condition and timeout.
			url: opts.url,
			waitUntil: opts.waitUntil,
			timeoutMs: opts.timeoutMs,
			// Nobody else looks at this tab: raise it for pixels, keep it
			// rendering while backgrounded, close it on release.
			activateForScreenshot: true,
			emulateFocus: true,
			ownsTarget: true,
		};
	}
	const activateForScreenshot = !userDriven || !shouldPreserveConnectedBrowserFocus(opts.target);
	const page = await pickElectronTarget(browser.browser, {
		matcher: opts.target,
		preferVisible: !activateForScreenshot,
	});
	const targetId = await targetIdForPage(page);
	return {
		mode: "attach",
		browserWSEndpoint,
		safeDir,
		targetId,
		dialogs: opts.dialogs,
		url: opts.url,
		waitUntil: opts.waitUntil,
		timeoutMs: opts.timeoutMs,
		activateForScreenshot,
	};
}

const NEW_TAB_TARGET_ERROR =
	"browser open: app.new_tab and app.target are mutually exclusive — a fresh tab has no existing target to select.";
const NEW_TAB_KIND_ERROR =
	"browser open: app.new_tab is only for user-driven browsers (app.relay or app.cdp_url); headless and spawned browsers already own their page.";

/**
 * Create a fresh page target for omp on a user-driven browser without
 * disturbing what the user is looking at: remember the foreground tab, create
 * the target in the background, and — for daemons that ignore `background`
 * and activate the new tab (the omp 18.1.x relay extension) — hand focus back.
 * Returns the new target id once the supervisor's Puppeteer connection sees it.
 */
async function createOwnedTarget(browser: PuppeteerBrowserHandle): Promise<string> {
	// Best-effort: a browser with no usable page has nothing to restore.
	const foreground = await pickElectronTarget(browser.browser, { preferVisible: true }).catch(() => undefined);
	const connection = rootCdpConnection(browser.browser);
	const { targetId } = await connection.send("Target.createTarget", { url: "about:blank", background: true });
	try {
		await waitForTargetById(browser.browser, targetId);
	} catch (error) {
		closeAbandonedTarget(browser, targetId);
		throw error;
	}
	if (foreground) await restoreForeground(connection, foreground, targetId);
	return targetId;
}

/** Test hook: create an owned target and hand back its supervisor-side close, without a worker. */
export async function createOwnedTargetForTest(
	browser: PuppeteerBrowserHandle,
): Promise<{ targetId: string; close(): Promise<boolean> }> {
	const targetId = await createOwnedTarget(browser);
	return { targetId, close: () => closeTargetById(browser, targetId) };
}

/**
 * Re-activate the tab the user had in front when creating the new one hid it.
 * Only a positively observed `hidden` triggers activation: raising a Chrome
 * window steals OS focus, so an unanswerable probe (or a daemon that honored
 * `background`) leaves things alone.
 */
async function restoreForeground(connection: Connection, foreground: Page, createdTargetId: string): Promise<void> {
	try {
		const targetId = await targetIdForPage(foreground);
		if (targetId === createdTargetId) return;
		const hidden = (await foreground.evaluate(() => document.visibilityState === "hidden")) === true;
		if (!hidden) return;
		await connection.send("Target.activateTarget", { targetId });
	} catch (error) {
		logger.debug("Could not restore the user's foreground tab after creating an owned target", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Wait until Puppeteer's target list carries a freshly created target id (mirrors the worker's headless page wait). */
async function waitForTargetById(browser: Browser, targetId: string): Promise<Target> {
	const isCreated = (candidate: Target) => privateTargetId(candidate) === targetId;
	return (
		browser.targets().find(isCreated) ??
		(await browser.waitForTarget(isCreated, { timeout: BROWSER_PROTOCOL_TIMEOUT_MS }))
	);
}

function handleTabMessage(tab: WorkerTabSession, msg: WorkerOutbound): void {
	if (msg.type === "result") {
		const pending = tab.pending.get(msg.id);
		if (!pending) return;
		tab.pending.delete(msg.id);
		if (msg.ok) {
			pending.resolve(msg.payload);
			return;
		}
		pending.reject(errorFromPayload(msg.error));
		return;
	}
	if (msg.type === "ready") {
		tab.info = msg.info;
		return;
	}
	if (msg.type === "tool-call") {
		void dispatchToolCall(tab, msg);
		return;
	}
	if (msg.type === "log") logWorkerMessage(msg);
}

async function dispatchToolCall(
	tab: WorkerTabSession,
	msg: Extract<WorkerOutbound, { type: "tool-call" }>,
): Promise<void> {
	const pending = tab.pending.get(msg.runId);
	if (!pending?.session.cwd) {
		safeSend(tab, {
			type: "tool-reply",
			id: msg.id,
			reply: {
				ok: false,
				error: { name: "ToolError", message: "No active run for tool call", isToolError: true, isAbort: false },
			},
		});
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	const onParentAbort = (): void => ctrl.abort(pending.signal?.reason);
	if (pending.signal?.aborted) onParentAbort();
	else pending.signal?.addEventListener("abort", onParentAbort, { once: true });
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.session,
			signal: ctrl.signal,
			emitStatus: () => {
				// Status events from tool calls aren't piped back to user code yet; the worker
				// already pushes its own helper status via the display channel.
			},
		});
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);
		pending.signal?.removeEventListener("abort", onParentAbort);
	}
}

function safeSend(tab: WorkerTabSession, msg: WorkerInbound): void {
	if (tab.state !== "alive") return;
	try {
		tab.worker.send(msg);
	} catch (err) {
		logger.debug("tab worker send failed", { error: err instanceof Error ? err.message : String(err) });
	}
}

function toErrorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { name: "Error", message: String(error), isAbort: false, isToolError: false };
}

async function recycleTimedOutWorkerTab(tab: WorkerTabSession, timeoutMs: number): Promise<void> {
	// Same deadline carry-over as acquireTabImpl: the inline-fallback retry
	// must not restart the recycle's init budget.
	const startedAt = performance.now();
	const oldWorker = tab.worker;
	await oldWorker.terminate().catch(() => undefined);
	const browserWSEndpoint = tab.browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	const payload: WorkerInitPayload = {
		mode: "attach",
		browserWSEndpoint,
		safeDir: getPuppeteerDir(),
		targetId: tab.targetId,
		dialogs: tab.dialogPolicy,
		// Unblock a wedged page (open JS dialog, hung navigation) before adopting it —
		// otherwise init stalls, times out, and the tab gets force-killed.
		recover: true,
		emulateFocus: tab.ownsTarget,
		timeoutMs,
		activateForScreenshot: tab.activateForScreenshot,
		ownsTarget: tab.ownsTarget,
	};
	let worker = await spawnTabWorker();
	try {
		const info = await initializeTabWorker(worker, payload, timeoutMs, startedAt);
		tab.worker = worker;
		tab.info = info;
		tab.state = "alive";
		worker.onMessage(msg => handleTabMessage(tab, msg));
	} catch (error) {
		await worker.terminate().catch(() => undefined);
		// The recycle's budget is exhausted: the run caller already timed out, so a
		// retried init can't beat its deadline — fail fast and let the caller
		// force-kill the tab instead of spending the phase floors' excess.
		if (initBudgetExhausted(timeoutMs, startedAt)) {
			throw error;
		}
		worker = await spawnInlineWorker();
		try {
			const info = await initializeTabWorker(worker, payload, timeoutMs, startedAt);
			tab.worker = worker;
			tab.info = info;
			tab.state = "alive";
			worker.onMessage(msg => handleTabMessage(tab, msg));
		} catch (inlineError) {
			await worker.terminate().catch(() => undefined);
			const finalError = new ToolError(
				`Failed to recycle timed-out browser tab worker (inline fallback also failed): ${inlineError instanceof Error ? inlineError.message : String(inlineError)}`,
			);
			Object.defineProperty(finalError, "cause", { value: error, configurable: true });
			throw finalError;
		}
	}
}

async function forceKillTab(name: string, reason: string): Promise<void> {
	const tab = tabs.get(name);
	if (!tab) return;
	killedTabs.set(name, reason);
	tab.state = "dead";
	const error = postmortem.markExpectedCleanupError(new ToolError(reason));
	for (const pending of tab.pending.values()) pending.reject(error);
	tab.pending.clear();
	if (tab.backend === "cmux") {
		await releaseBrowser(tab.browser, { kill: false });
		tabs.delete(name);
		return;
	}
	await tab.worker.terminate().catch(() => undefined);
	const targetClosed = tab.ownsTarget ? await closeOrphanTarget(tab) : true;
	await releaseBrowser(tab.browser, { kill: false });
	tabs.delete(name);
	const scope = durableScopeOf(tab);
	if (scope && targetClosed) void forgetSharedTarget(scope, tab.targetId);
	refreshAbandonedDeadline();
}

/**
 * Best-effort close of a specific page target in the browser. Close through
 * the browser CDP session rather than `page.close()`: a page whose navigation
 * wedged during initialization can make Puppeteer's page close wait for the
 * protocol timeout, retaining the cleanup hold for tens of seconds.
 */
async function closeTargetById(browser: PuppeteerBrowserHandle, targetId: string): Promise<boolean> {
	if (browser.kind.kind !== "relay") return await closeCdpTarget(browser.browser, targetId);
	// The relay bridge announces no browser target, so `closeCdpTarget`'s
	// browser-target session cannot exist there; the root connection is the
	// bridge's browser session. A tab the user already closed is not an error.
	try {
		await rootCdpConnection(browser.browser).send("Target.closeTarget", { targetId });
		return true;
	} catch (error) {
		logger.debug("Relay target close failed", {
			targetId,
			error: error instanceof Error ? error.message : String(error),
		});
		return error instanceof Error && /no target/i.test(error.message);
	}
}

// ---- durable ownership, clock, and the abandoned-tab reaper ---------------

/**
 * Injectable wall clock. Every lifecycle decision (idle-close, six-hour
 * abandoned reaper, durable activity stamps) reads this so tests can drive
 * the six-hour path without waiting. Production never overrides it.
 */
let clock: () => number = Date.now;
function now(): number {
	return clock();
}

/** Test seam: replace the supervisor clock; returns a restore function. */
export function setTabClockForTest(next: (() => number) | undefined): () => void {
	const previous = clock;
	clock = next ?? Date.now;
	return () => {
		clock = previous;
	};
}

/**
 * Durable-ownership scope for a tab, or undefined when nothing outlives this
 * process that a reaper could act on: the machine-global agent Chromium's
 * pages and relay tabs OMP created (`app.new_tab`) qualify; adopted user
 * tabs, process-local test browsers, spawned apps and cmux surfaces do not.
 */
function durableScopeOf(tab: TabSession): SharedTargetScope | undefined {
	if (tab.backend !== "worker" || !tab.ownsTarget) return undefined;
	const browser = tab.browser;
	if (browser.kind.kind === "headless" && browser.sharedDaemon) {
		return { runtimeDir: browser.sharedDaemon.runtimeDir, daemonName: browser.sharedDaemon.name };
	}
	if (browser.kind.kind === "relay") {
		return { runtimeDir: getGlobalDaemonRuntimeDir("browser-relay"), daemonName: RELAY_DAEMON_NAME };
	}
	return undefined;
}

/** Browser generation a target id belongs to; `unknown` (never matches a live generation) on a legacy relay. */
function durableGenerationOf(browser: PuppeteerBrowserHandle): string {
	return browser.sharedDaemon?.generation ?? browser.generation ?? "unknown";
}

/** Mirror the in-memory meaningful-activity stamp into the durable record (fire-and-forget). */
function syncDurableActivity(tab: TabSession): void {
	const scope = durableScopeOf(tab);
	if (!scope) return;
	void touchSharedTarget(scope, tab.targetId, { lastMeaningfulActivityAt: tab.lastActivityAt });
}

/**
 * Resume an OMP-owned tab on a user-driven browser before input: Chrome
 * throttles background tabs (no frames, deferred input), and the relay's
 * `chrome.debugger` path cannot raise the tab without stealing the user's
 * focus. Lifecycle `active` plus focus emulation keeps it interactive in the
 * background. Best-effort: a failure only logs and the dispatch proceeds.
 */
async function resumeOwnedUserDrivenTab(tab: WorkerTabSession): Promise<void> {
	const target = await findTargetForTab(tab).catch(() => undefined);
	if (!target) return;
	const session = await target.createCDPSession().catch(() => null);
	if (!session) return;
	try {
		await session.send("Page.enable").catch(() => undefined);
		await session.send("Page.setWebLifecycleState", { state: "active" }).catch(() => undefined);
		await session.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
	} finally {
		await session.detach().catch(() => undefined);
	}
}

/** Test hook for the pre-input resume without a tabs-map entry. */
export function resumeOwnedUserDrivenTabForTest(tab: WorkerTabSession): Promise<void> {
	return resumeOwnedUserDrivenTab(tab);
}

/** Page-level facts that protect a tab from the abandoned reaper. */
export interface TabProtectionProbe {
	/** URL path/query names a login/auth/verification step. */
	loginPath: boolean;
	/** A password or one-time-code field is present. */
	credentialField: boolean;
	/** A form control or contenteditable holds unsaved input, or the page registered `onbeforeunload`. */
	unsavedInput: boolean;
	/** The document is the visible tab of its window. */
	visible: boolean;
}

/** In-page probe, evaluated read-only through a supervisor-owned CDP session. Returns JSON-serialisable facts only. */
const PROTECTION_PROBE_EXPRESSION = String.raw`(() => {
	const loc = String(location.pathname + location.search);
	const loginPath = /(^|[\/?&#._-])(log-?in|sign-?in|auth|oauth|sso|password|passwd|verify|verification|otp|2fa|mfa|challenge|consent|checkpoint)([\/?&#._-]|$)/i.test(loc);
	const credentialField = !!document.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[name*="otp" i],input[name*="passcode" i]');
	let unsavedInput = typeof window.onbeforeunload === "function";
	if (!unsavedInput) {
		for (const el of document.querySelectorAll("input,textarea,select")) {
			if (el.disabled || el.readOnly) continue;
			if (el instanceof HTMLSelectElement) {
				for (const opt of el.options) if (opt.selected !== opt.defaultSelected) { unsavedInput = true; break; }
			} else if (el.type === "checkbox" || el.type === "radio") {
				if (el.checked !== el.defaultChecked) unsavedInput = true;
			} else if (el.type === "hidden" || el.type === "submit" || el.type === "button") {
				continue;
			} else if (el.value !== el.defaultValue && el.value !== "") {
				unsavedInput = true;
			}
			if (unsavedInput) break;
		}
	}
	if (!unsavedInput) {
		for (const el of document.querySelectorAll('[contenteditable=""],[contenteditable="true"],[role="textbox"]')) {
			if ((el.textContent || "").trim().length > 0) { unsavedInput = true; break; }
		}
	}
	return { loginPath, credentialField, unsavedInput, visible: document.visibilityState === "visible" };
})()`;

/**
 * Probe a page for reaper protections. Fails SAFE: any failure (no target,
 * no session, evaluation error, frozen renderer) reports every protection as
 * engaged so the tab is retained.
 */
export async function probeTargetProtection(browser: Browser, targetId: string): Promise<TabProtectionProbe> {
	const engaged: TabProtectionProbe = { loginPath: true, credentialField: true, unsavedInput: true, visible: true };
	let target: Target | undefined;
	for (const candidate of browser.targets()) {
		if ((await targetIdForTarget(candidate).catch(() => "")) === targetId) {
			target = candidate;
			break;
		}
	}
	if (!target) return engaged;
	const session = await target.createCDPSession().catch(() => null);
	if (!session) return engaged;
	try {
		const result = await withTimeout(
			session.send("Runtime.evaluate", {
				expression: PROTECTION_PROBE_EXPRESSION,
				returnByValue: true,
				awaitPromise: false,
			}),
			5_000,
			"protection probe timed out",
		);
		const value = result.result.value as Partial<TabProtectionProbe> | undefined;
		if (!value || result.exceptionDetails) return engaged;
		return {
			loginPath: value.loginPath !== false,
			credentialField: value.credentialField !== false,
			unsavedInput: value.unsavedInput !== false,
			visible: value.visible !== false,
		};
	} catch {
		return engaged;
	} finally {
		await session.detach().catch(() => undefined);
	}
}

/** Active downloads per browser handle, keyed by the initiating frame id (== page target id for main frames). */
const activeDownloads = new WeakMap<PuppeteerBrowserHandle, Map<string, Set<string>>>();
const downloadTrackers = new WeakSet<PuppeteerBrowserHandle>();

/**
 * Best-effort download tracking on the browser session: `Browser.setDownloadBehavior`
 * with events enabled reports begin/progress per frame. Relay browsers expose
 * no browser target, so the tracker silently does nothing there.
 */
async function ensureDownloadTracker(browser: PuppeteerBrowserHandle): Promise<void> {
	if (downloadTrackers.has(browser) || browser.kind.kind === "relay") return;
	downloadTrackers.add(browser);
	let session: CDPSession | null;
	try {
		session = await browser.browser.target().createCDPSession();
	} catch {
		return;
	}
	const byFrame = new Map<string, Set<string>>();
	activeDownloads.set(browser, byFrame);
	const guidFrame = new Map<string, string>();
	session.on("Browser.downloadWillBegin", (event: { frameId: string; guid: string }) => {
		guidFrame.set(event.guid, event.frameId);
		let guids = byFrame.get(event.frameId);
		if (!guids) {
			guids = new Set();
			byFrame.set(event.frameId, guids);
		}
		guids.add(event.guid);
	});
	session.on("Browser.downloadProgress", (event: { guid: string; state: string }) => {
		if (event.state === "inProgress") return;
		const frameId = guidFrame.get(event.guid);
		guidFrame.delete(event.guid);
		if (frameId === undefined) return;
		const guids = byFrame.get(frameId);
		guids?.delete(event.guid);
		if (guids?.size === 0) byFrame.delete(frameId);
	});
	try {
		await session.send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: true });
	} catch (error) {
		logger.debug("Browser download tracking unavailable; reaper treats downloads as unknown", {
			error: error instanceof Error ? error.message : String(error),
		});
		activeDownloads.delete(browser);
		await session.detach().catch(() => undefined);
	}
}

/** Whether a tracked download is in flight for a tab; `undefined` when tracking is unavailable on its browser. */
function hasActiveDownload(tab: WorkerTabSession): boolean | undefined {
	const byFrame = activeDownloads.get(tab.browser);
	if (!byFrame) return undefined;
	return (byFrame.get(tab.targetId)?.size ?? 0) > 0;
}

/** Why an abandoned-reaper candidate was retained (or `close` when nothing protects it). */
export type AbandonedVerdict =
	| "close"
	| "not-owned"
	| "persist"
	| "busy"
	| "fresh"
	| "download"
	| "login"
	| "unsaved-input"
	| "foreground"
	| "unprovable";

/** Injectable seams for the abandoned reaper; defaults touch the real page. */
export interface AbandonedReapOptions {
	/** Internal: a timer-driven sweep must not re-arm from inside the arm path. */
	rearm?: boolean;
	/** Idle threshold; `browser.tabs.abandonedIdleHours * 3_600_000`. Non-positive disables. */
	idleMs: number;
	/** Restrict to tabs created by this session; omitted sweeps every tab this process created. */
	ownerId?: string;
	/** Page probe override (tests). */
	probe?: (tab: WorkerTabSession) => Promise<TabProtectionProbe>;
	/** Download check override (tests). */
	downloads?: (tab: WorkerTabSession) => boolean | undefined;
	timeoutMs?: number;
}

/**
 * Decide whether one in-process tab is abandoned. Pure over the tab's state
 * plus the supplied probe results, so every protection is unit-testable:
 *  - only OMP-created targets (`ownsTarget`) — adopted user tabs are `not-owned`;
 *  - `persist`, an in-flight run, activity within `idleMs` retain;
 *  - an active (or unknowable) download retains;
 *  - login/auth URL or credential field, unsaved input, and being the visible
 *    tab of a user-driven window retain (headless has no user to protect).
 */
export function classifyAbandoned(
	tab: TabSession,
	nowMs: number,
	idleMs: number,
	probe: TabProtectionProbe | undefined,
	download: boolean | undefined,
): AbandonedVerdict {
	if (tab.backend !== "worker" || !tab.ownsTarget || tab.state !== "alive") return "not-owned";
	if (tab.persist) return "persist";
	if (tab.pending.size > 0) return "busy";
	if (!(idleMs > 0) || nowMs - tab.lastActivityAt < idleMs) return "fresh";
	if (download !== false) return "download";
	if (!probe) return "unprovable";
	if (probe.loginPath || probe.credentialField) return "login";
	if (probe.unsavedInput) return "unsaved-input";
	if (probe.visible && tab.kindTag !== "headless") return "foreground";
	return "close";
}

/**
 * Close OMP-created tabs of this process abandoned for `idleMs` (six hours by
 * default) unless protected. Distinct from the short `browser.idleCloseSec`
 * backstop: that one only ever touches non-persistent headless worker tabs
 * at turn settle; this one covers every tab OMP created — headless pages and
 * relay/connected `new_tab` targets — and consults the page before closing.
 * Never throws; a wedged close counts as retained.
 */
export async function reapAbandonedTabs(
	opts: AbandonedReapOptions,
): Promise<{ closed: string[]; retained: Record<string, AbandonedVerdict> }> {
	const closed: string[] = [];
	const retained: Record<string, AbandonedVerdict> = {};
	if (!(opts.idleMs > 0)) return { closed, retained };
	const candidates = [...tabs.values()].filter(
		(tab): tab is WorkerTabSession =>
			tab.backend === "worker" &&
			tab.ownsTarget &&
			(opts.ownerId === undefined || tab.ownerSessionId === opts.ownerId),
	);
	for (const tab of candidates) {
		// Cheap in-memory checks first; only a due, unprotected candidate pays for a page probe.
		const early = classifyAbandoned(tab, now(), opts.idleMs, undefined, false);
		if (early !== "unprovable") {
			retained[tab.name] = early;
			continue;
		}
		if (!opts.downloads) await ensureDownloadTracker(tab.browser);
		const download = (opts.downloads ?? hasActiveDownload)(tab);
		// A relay browser cannot report downloads; a page-level download there
		// is not distinguishable, so treat "unknown" as not-downloading ONLY on
		// relay (its owned tabs are protected by the visibility probe instead).
		const downloadKnown = download ?? (tab.kindTag === "relay" ? false : undefined);
		// A settle-frozen renderer may not service `Runtime.evaluate`; a timed
		// out probe would read as "all protections engaged" (a false `login`)
		// and spin the 15-minute retry forever. Resume first; a page that will
		// not resume is unprovable and stays. Refreeze afterwards when kept.
		const wasFrozen = tab.frozen;
		if (wasFrozen && !(await unfreezeTabSession(tab))) {
			retained[tab.name] = "unprovable";
			continue;
		}
		const probe = await (
			opts.probe ?? (candidate => probeTargetProtection(candidate.browser.browser, candidate.targetId))
		)(tab);
		const verdict = classifyAbandoned(tab, now(), opts.idleMs, probe, downloadKnown);
		if (verdict !== "close") {
			retained[tab.name] = verdict;
			if (wasFrozen && tabs.get(tab.name) === tab) await setTabFrozen(tab, true);
			continue;
		}
		// Revalidate against the live map: the probe awaited, and a run may have started.
		if (tabs.get(tab.name) !== tab || tab.pending.size > 0) {
			retained[tab.name] = "busy";
			continue;
		}
		try {
			if (await releaseTab(tab.name, { kill: false, timeoutMs: opts.timeoutMs })) closed.push(tab.name);
		} catch (error) {
			retained[tab.name] = "busy";
			logger.debug("Failed to close abandoned browser tab; continuing", {
				name: tab.name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (closed.length > 0) logger.debug("Closed abandoned browser tabs", { closed, retained });
	// Whatever survived (protected or not yet due) gets the next deadline.
	if (opts.rearm !== false) armAbandonedDeadline(opts);
	return { closed, retained };
}

// ---- abandoned deadline timer (the controller between turns) ------------------

/**
 * ONE per-process one-shot timer for the earliest owned-tab expiry. Turn
 * settle and open only run the reaper when they happen; a chat left idle for
 * six hours has neither, so this timer is what actually closes its tabs.
 * Always `unref()`'d: it never keeps a print/RPC process alive. Re-armed by
 * every reap, open, release and activity; cancelled on session dispose.
 * Owner scoping is deliberately process-wide — the timer sweeps every tab
 * this process created, each still judged by its own owner/persist state.
 */
let abandonedTimer: NodeJS.Timeout | undefined;
let abandonedTimerOpts: AbandonedReapOptions | undefined;
/** Retry cadence when the due candidate was protected (busy/login/dirty/...): recheck rather than wait a full period. */
const ABANDONED_RETRY_MS = 15 * 60_000;
/** Injectable timer primitives so the deadline path is testable without real waits. */
let abandonedTimers: {
	set: (fn: () => void, ms: number) => NodeJS.Timeout;
	clear: (timer: NodeJS.Timeout) => void;
} = {
	set: (fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref();
		return timer;
	},
	clear: timer => clearTimeout(timer),
};

/** Test seam: replace the deadline timer primitives; returns a restore function. */
export function setAbandonedTimersForTest(next: typeof abandonedTimers | undefined): () => void {
	const previous = abandonedTimers;
	abandonedTimers = next ?? previous;
	return () => {
		abandonedTimers = previous;
	};
}

/**
 * Milliseconds until the earliest owned tab reaches `idleMs` idle: `0` when
 * one already has, undefined when this process owns no eligible tab.
 * `persist` tabs and adopted tabs never produce a deadline.
 */
export function earliestAbandonedInMs(idleMs: number, nowMs: number = now()): number | undefined {
	if (!(idleMs > 0)) return undefined;
	let earliest: number | undefined;
	for (const tab of tabs.values()) {
		if (tab.backend !== "worker" || !tab.ownsTarget || tab.state !== "alive" || tab.persist) continue;
		const remaining = idleMs - (nowMs - tab.lastActivityAt);
		if (remaining <= 0) return 0;
		earliest = earliest === undefined ? remaining : Math.min(earliest, remaining);
	}
	return earliest;
}

/** Drop the pending deadline (session dispose, setting disabled). */
export function cancelAbandonedDeadline(): void {
	if (abandonedTimer !== undefined) abandonedTimers.clear(abandonedTimer);
	abandonedTimer = undefined;
	abandonedTimerOpts = undefined;
}

/** Test probe: whether a deadline is currently armed. */
export function hasAbandonedDeadlineForTest(): boolean {
	return abandonedTimer !== undefined;
}

/**
 * (Re)arm the deadline for the earliest owned-tab expiry. The firing sweep
 * runs `reapAbandonedTabs` with every protection and re-arms itself for the
 * survivors; a due-but-protected tab is rechecked on the retry cadence.
 */
export function armAbandonedDeadline(opts: AbandonedReapOptions): void {
	cancelAbandonedDeadline();
	if (!(opts.idleMs > 0)) return;
	const delay = earliestAbandonedInMs(opts.idleMs);
	if (delay === undefined) return;
	const wait = delay <= 0 ? ABANDONED_RETRY_MS : Math.min(delay, 2_147_483_647);
	// The timer sweeps every tab this process created, not only the arming session's.
	const sweep: AbandonedReapOptions = { ...opts, ownerId: undefined, rearm: false };
	abandonedTimerOpts = sweep;
	abandonedTimer = abandonedTimers.set(() => {
		abandonedTimer = undefined;
		void reapAbandonedTabs(sweep)
			.catch(() => undefined)
			.then(() => {
				// A cancel or newer arm during the sweep wins.
				if (abandonedTimer === undefined && abandonedTimerOpts === sweep) armAbandonedDeadline(sweep);
			});
	}, wait);
}

/** Activity/open/release hook: shorten or extend the armed deadline to match the tabs map. */
function refreshAbandonedDeadline(): void {
	if (abandonedTimerOpts) armAbandonedDeadline(abandonedTimerOpts);
}

/**
 * Policy for targets inherited from a crashed owner (`reapOrphanSharedTargets`
 * `decide` hook).
 *  - Headless (no user in front): a legacy id-only record proves OMP creation
 *    but nothing else and keeps the issue #10022 behaviour (close), as does a
 *    non-persistent v2 record; a `persist` record is honoured until idle past
 *    `idleMs` AND the page probe shows no login/unsaved-input protection.
 *  - Relay/connected (the user's visible browser): every record — persist or
 *    not — goes through the same idle + probe protections as a live-owned tab;
 *    a half-typed form is never closed 15 s after its owner crashed. Relay
 *    records must additionally match the live tab's marker (the extension's
 *    per-tab UUID); an unmarked or differently marked tab is never touched.
 */
export function orphanDecisionFor(
	browser: Browser,
	opts: { idleMs: number; kind: BrowserKindTag; liveMarkers?: ReadonlyMap<string, string> },
): (target: OrphanTarget) => Promise<"close" | "retain" | "discard"> {
	return async target => {
		const record = target.record;
		if (opts.kind === "relay") {
			if (!record?.marker) return "retain";
			const live = opts.liveMarkers?.get(target.targetId);
			if (live === undefined) return "discard"; // tab gone (or never marked): nothing to close
			if (live !== record.marker) return "retain";
		}
		if (!record) return opts.kind === "headless" ? "close" : "retain";
		if (opts.kind === "headless" && !record.persist) return "close";
		if (!(opts.idleMs > 0) || now() - record.lastMeaningfulActivityAt < opts.idleMs) return "retain";
		const probe = await probeTargetProtection(browser, target.targetId);
		if (probe.loginPath || probe.credentialField || probe.unsavedInput) return "retain";
		if (probe.visible && opts.kind !== "headless") return "retain";
		return "close";
	};
}

/** Browser handles whose inherited (crashed-owner) targets this process already swept. */
const inheritedSwept = new WeakSet<PuppeteerBrowserHandle>();

/** Close a target and confirm it: relay through the root connection, everything else through the browser session. */
async function closeTargetConfirmed(browser: PuppeteerBrowserHandle, targetId: string): Promise<boolean> {
	if (browser.kind.kind !== "relay") return await closeCdpTarget(browser.browser, targetId);
	try {
		await rootCdpConnection(browser.browser).send("Target.closeTarget", { targetId });
		return true;
	} catch (error) {
		return error instanceof Error && /no target/i.test(error.message);
	}
}

/** Bridge-side marker minting is asynchronous to `Target.createTarget`; a few short retries cover it. */
const RELAY_MARKER_ATTEMPTS = 5;
const RELAY_MARKER_RETRY_MS = 200;

/**
 * Durably record an OMP-created target. Relay targets additionally store the
 * extension's per-tab marker (from the bridge's extended `Target.getTargets`),
 * which is the only proof a later process may use before closing one — an
 * unmarked relay record is retained forever by `orphanDecisionFor`, so the
 * lookup is awaited (bounded) rather than skipped.
 */
async function recordOwnedTarget(
	tab: WorkerTabSession,
	scope: SharedTargetScope,
	ownerSessionId?: string,
): Promise<void> {
	let marker: string | undefined;
	if (tab.kindTag === "relay") {
		for (let attempt = 0; attempt < RELAY_MARKER_ATTEMPTS && marker === undefined; attempt++) {
			if (attempt > 0) await Bun.sleep(RELAY_MARKER_RETRY_MS);
			marker = (await relayLiveMarkers(tab.browser)).get(tab.targetId);
		}
		if (marker === undefined) {
			logger.warn("Relay tab recorded without a marker; only this process can reap it", {
				name: tab.name,
				targetId: tab.targetId,
			});
		}
	}
	await recordSharedTarget(scope, {
		targetId: tab.targetId,
		name: tab.name,
		ownerSessionId,
		channel: process.env.OMP_PROFILE || "default",
		persist: tab.persist === true,
		createdAt: tab.lastActivityAt,
		lastMeaningfulActivityAt: tab.lastActivityAt,
		generation: durableGenerationOf(tab.browser),
		...(marker !== undefined ? { marker } : {}),
	});
}

/** Test hook: the durable record for a hand-built owned tab, marker lookup included. */
export function recordOwnedTargetForTest(tab: WorkerTabSession, scope: SharedTargetScope): Promise<void> {
	return recordOwnedTarget(tab, scope, tab.ownerSessionId);
}

/** Test hook: live relay markers as the crash-transfer sweep reads them. */
export function relayLiveMarkersForTest(browser: PuppeteerBrowserHandle): Promise<Map<string, string>> {
	return relayLiveMarkers(browser);
}

/** Live relay tab markers (`PAGE<id>` → extension UUID) from the bridge's extended `Target.getTargets`. */
async function relayLiveMarkers(browser: PuppeteerBrowserHandle): Promise<Map<string, string>> {
	const markers = new Map<string, string>();
	try {
		const { targetInfos } = await rootCdpConnection(browser.browser).send("Target.getTargets");
		for (const info of targetInfos) {
			// The bridge extends CDP `TargetInfo` with `ompMarker`; puppeteer's type does not know it.
			const marker: unknown = "ompMarker" in info ? info.ompMarker : undefined;
			if (typeof marker === "string" && marker.length > 0) markers.set(info.targetId, marker);
		}
	} catch (error) {
		logger.debug("Relay marker discovery failed; inherited relay tabs are retained", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return markers;
}

/**
 * Once per browser handle: reap targets recorded by omp processes that died
 * without teardown (issue #10022), applying the same protections a live
 * owner would. Detached from the open that triggers it; failures only log.
 */
async function sweepInheritedTargets(tab: WorkerTabSession, idleMs: number): Promise<void> {
	const scope = durableScopeOf(tab);
	if (!scope || inheritedSwept.has(tab.browser)) return;
	inheritedSwept.add(tab.browser);
	const generation = durableGenerationOf(tab.browser);
	// A legacy relay reports no generation: nothing recorded there can be
	// proven to name a live tab, so nothing is touched.
	if (generation === "unknown") return;
	const browser = tab.browser;
	holdBrowser(browser);
	try {
		const liveMarkers = tab.kindTag === "relay" ? await relayLiveMarkers(browser) : undefined;
		await reapOrphanSharedTargets(undefined, scope, {
			generation,
			decide: orphanDecisionFor(browser.browser, { idleMs, kind: tab.kindTag, liveMarkers }),
			close: targetId => closeTargetConfirmed(browser, targetId),
		});
	} catch (error) {
		logger.debug("Inherited browser target sweep failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		await releaseBrowser(browser, { kill: false }).catch(() => undefined);
	}
}

/**
 * Best-effort cleanup for a forced-kill path: close the page the tab's worker
 * reported as created. A run caller is never a browser ref holder, so the
 * browser is still in the registry; the tab's browser is the only place that
 * page can be, so no targetId guesswork across multiple sessions.
 */
async function closeOrphanTarget(tab: WorkerTabSession): Promise<boolean> {
	return await closeTargetById(tab.browser, tab.targetId);
}

/**
 * Close the page a worker created (page-created) before dying during init.
 * A killed worker can't clean up after itself; a shared browser's other
 * targets must never be touched.
 */
function closeAbandonedWorkerPage(browser: PuppeteerBrowserHandle, worker: WorkerHandle): void {
	const targetId = workerPageTargets.get(worker);
	workerPageTargets.delete(worker);
	closeAbandonedTarget(browser, targetId);
}

/**
 * Fire-and-forget close of a target omp created but never published as a tab
 * (worker page or supervisor-created owned target): the caller has already
 * failed or timed out, so cleanup must not delay error propagation. No-op
 * without a target id.
 */
function closeAbandonedTarget(browser: PuppeteerBrowserHandle, targetId: string | undefined): void {
	if (!targetId) return;
	// The close outlives its caller, and every caller here may go on to release
	// the last browser reference — `closeTargetById` yields before it looks the
	// target up, so a disconnect in that gap turns the lookup into a caught
	// failure and leaves the page on the instance for good. Hold the browser
	// across the close instead of blocking on it: the hold defers the release
	// (and the dispose behind it) rather than cancelling one, so the refCount
	// ends where it would have, one turn later.
	holdBrowser(browser);
	void closeTargetById(browser, targetId)
		.catch(() => undefined)
		.finally(() => void releaseBrowser(browser, { kill: false }).catch(() => undefined));
}

async function waitForClosed(tab: WorkerTabSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = tab.worker.onMessage(msg => {
		if (msg.type === "closed") resolve();
	});
	try {
		await raceWithTimeout(promise, GRACE_MS, "Timed out closing browser tab worker");
	} finally {
		unsubscribe();
	}
}

function expandBrowserScreenshotDir(session: ToolSession): string | undefined {
	const value = session.settings.get("browser.screenshotDir") as string | undefined;
	return value ? expandPath(value) : undefined;
}

async function targetIdForPage(page: Page): Promise<string> {
	return await targetIdForTarget(page.target());
}

/** Puppeteer's cached target id (`CdpTarget._targetId`, private); undefined on foreign target implementations. */
function privateTargetId(target: Target): string | undefined {
	const internal = target as unknown as { _targetId?: unknown };
	return typeof internal._targetId === "string" ? internal._targetId : undefined;
}

async function targetIdForTarget(target: Target): Promise<string> {
	const fastTargetId = privateTargetId(target);
	if (fastTargetId) return fastTargetId;
	const session = await target.createCDPSession();
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		if (info.targetInfo?.targetId) return info.targetInfo.targetId;
		throw new ToolError("Target id unavailable from CDP target info");
	} finally {
		await session.detach().catch(() => undefined);
	}
}

function errorFromPayload(payload: RunErrorPayload): Error {
	const error = payload.recoverTab
		? new RecoverableWorkerError(payload.message)
		: payload.isAbort
			? new ToolAbortError()
			: payload.isToolError
				? new ToolError(payload.message)
				: new Error(payload.message);
	error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function logWorkerMessage(msg: Extract<WorkerOutbound, { type: "log" }>): void {
	if (msg.level === "debug") logger.debug(msg.msg, msg.meta);
	else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);
	else logger.error(msg.msg, msg.meta);
}

async function raceWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	reason: string,
	onTimeout?: (reason: string) => Promise<void>,
): Promise<T> {
	// Manual timer rather than `AbortSignal.timeout()`: under the Bun test
	// runner, a `Promise.race` with a never-settling bare member and an
	// `AbortSignal.timeout`-driven member never fires the signal's timer
	// (the timer queue wedges and even the runner's own per-test timeout
	// stops firing), so the timeout path hangs instead of rejecting. A
	// plain `setTimeout` fires reliably under both the runner and plain
	// execution (Bun 1.3.14).
	const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new ToolError(reason)), timeoutMs);
	try {
		return await Promise.race([promise, timeoutPromise]);
	} catch (error) {
		if (error instanceof ToolError && error.message === reason) await onTimeout?.(reason);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

async function spawnTabWorker(): Promise<WorkerHandle> {
	try {
		const hostEntry = workerHostEntry();
		const worker = hostEntry
			? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_tab"] })
			: new Worker(new URL("./tab-worker-entry.ts", import.meta.url).href, { type: "module" });
		return wrapBunWorker(worker);
	} catch (err) {
		logger.warn("Bun Worker spawn failed; using inline tab worker (no sync-loop guard)", {
			error: err instanceof Error ? err.message : String(err),
		});
		return spawnInlineWorker();
	}
}

function wrapBunWorker(worker: Worker): WorkerHandle {
	return {
		mode: "worker",
		send(msg, transferList) {
			worker.postMessage(msg, { transfer: transferList ?? [] });
		},
		onMessage(handler) {
			const wrap = (event: MessageEvent): void => handler(event.data as WorkerOutbound);
			worker.addEventListener("message", wrap);
			return () => worker.removeEventListener("message", wrap);
		},
		onError(handler) {
			const onError = (event: ErrorEvent): void => handler(errorFromWorkerEvent(event));
			const onMessageError = (event: MessageEvent): void =>
				handler(new ToolError(`Tab worker message error: ${String(event.data)}`));
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onMessageError);
			return () => {
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onMessageError);
			};
		},
		async terminate() {
			worker.terminate();
		},
	};
}

/**
 * Inline fallback for environments where Bun cannot compile or spawn the worker
 * entry. This preserves normal browser behavior but cannot interrupt synchronous
 * infinite loops because user code runs on the main thread.
 */
async function spawnInlineWorker(): Promise<WorkerHandle> {
	const hostListeners = new Set<(message: WorkerOutbound) => void>();
	const workerListeners = new Set<(message: WorkerInbound) => void>();
	const workerTransport: Transport = {
		send: msg =>
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(msg as WorkerOutbound);
			}),
		onMessage: handler => {
			const typed = handler as (message: WorkerInbound) => void;
			workerListeners.add(typed);
			return () => workerListeners.delete(typed);
		},
		close: () => {},
	};
	const { WorkerCore } = await import("./tab-worker");
	new WorkerCore(workerTransport, false);
	return {
		mode: "inline",
		send: msg =>
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(msg);
			}),
		onMessage: handler => {
			hostListeners.add(handler);
			return () => hostListeners.delete(handler);
		},
		onError: () => () => {},
		async terminate() {},
	};
}

/**
 * Init a tab worker under a single listener spanning the whole init: a short
 * `setup` handshake (bounded by the cold-start guard so a stalled cold start
 * triggers the inline fallback early) and the ready wait for page acquisition
 * and the first navigation. Both phases are bounded by the time LEFT of the
 * caller's `timeoutMs` budget, measured from `deadlineStart` (performance.now()
 * when the caller's budget began): a retried attempt — the inline fallback
 * after a failed isolated worker — passes the same start, so total init
 * across attempts stays within the caller's timeout instead of the retry
 * restarting the clock. A headless worker's `page-created` report (the new
 * target, sent before the slow post-creation CDP work) is recorded in
 * `workerPageTargets` so a supervisor that kills the worker during init
 * (budget exhausted, aborted open) can close exactly the page the worker
 * created — a killed worker can't clean up after itself. The listener is
 * never removed between the phases: the inline transport delivers messages
 * on microtasks, so a `ready` or `init-failed` emitted right after `setup`
 * (e.g. a fast `page.goto` rejection) could otherwise reach the
 * already-settled setup listener before a phase switch re-listens and be
 * dropped.
 */
async function initializeTabWorker(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
	deadlineStart: number = performance.now(),
): Promise<ReadyInfo> {
	// Derive both phase budgets from the remaining caller budget so a
	// retried attempt (inline fallback) cannot outlive the caller's timeout.
	// The floors keep the budgets positive when the remaining time is tiny;
	// the caller's abort signal remains the hard backstop for the overshoot.
	const remainingMs = timeoutMs - Math.round(performance.now() - deadlineStart);
	// Cold-start guard: min(10s, remaining/3), floor 2s (see SETUP_BUDGET_*).
	const setupBudgetMs = Math.max(SETUP_BUDGET_FLOOR_MS, Math.min(SETUP_BUDGET_CAP_MS, Math.floor(remainingMs / 3)));
	const setup = Promise.withResolvers<void>();
	const ready = Promise.withResolvers<ReadyInfo>();
	let setupDone = false;
	// Reject only the active phase's promise: the other one may never be
	// awaited (a phase that already failed leaves the rest un-run), so
	// rejecting it would be an unhandled rejection.
	const failStartup = (error: Error) => {
		(setupDone ? ready : setup).reject(error);
	};
	const unlisten = worker.onMessage(msg => {
		if (msg.type === "page-created") {
			// Record the headless target before the (potentially slow)
			// post-creation CDP work: if this init is killed before ready,
			// the supervisor closes exactly this target.
			workerPageTargets.set(worker, msg.targetId);
		} else if (msg.type === "setup") {
			setupDone = true;
			setup.resolve();
		} else if (msg.type === "ready") ready.resolve(msg.info);
		else if (msg.type === "init-failed") failStartup(markReportedInitFailure(errorFromPayload(msg.error)));
		else if (msg.type === "log") logWorkerMessage(msg);
	});
	const unlistenError = worker.onError(error => {
		failStartup(new ToolError(`Tab worker failed during startup: ${error.message}`));
	});
	try {
		worker.send({ type: "init", payload });
		await raceWithTimeout(setup.promise, setupBudgetMs, "Timed out waiting for tab worker setup");
		// The ready wait gets only what is left of the caller's budget at
		// this point; the floor covers sub-3s budgets where the 2s setup
		// floor alone exceeds it.
		const readyBudgetMs = Math.max(READY_BUDGET_FLOOR_MS, timeoutMs - Math.round(performance.now() - deadlineStart));
		return await raceWithTimeout(ready.promise, readyBudgetMs, "Timed out initializing browser tab worker");
	} finally {
		unlisten();
		unlistenError();
	}
}
/**
 * True once the caller's init budget (elapsed since `deadlineStart`) is fully
 * consumed. A retry from this point can't be published — the caller's timeout
 * has already fired, so the post-init abort check would discard the result
 * anyway — so callers fail fast instead of spending the phase floors' excess
 * on a cold start nobody is waiting for.
 */
function initBudgetExhausted(budgetMs: number, deadlineStart: number): boolean {
	return budgetMs - Math.round(performance.now() - deadlineStart) <= 0;
}

export function initializeTabWorkerForTest(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
	deadlineStart: number = performance.now(),
): Promise<ReadyInfo> {
	return initializeTabWorker(worker, payload, timeoutMs, deadlineStart);
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
	if (event.error instanceof Error) return event.error;
	if (event.message) return new Error(event.message);
	return new Error("Unknown tab worker error");
}
