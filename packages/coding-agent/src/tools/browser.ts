import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isRecord, logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { EvalPreludeContext, EvalPreludeDefinition } from "../eval/preludes";
import type { ToolSession } from "../sdk";
import { enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { resolveCmuxKind } from "./browser/cmux/rpc";
import { resolveSpawnArgs } from "./browser/attach";
import {
	acquireBrowser,
	browserKey,
	type BrowserHandle,
	type BrowserKind,
	type BrowserKindTag,
	holdBrowser,
	releaseBrowser,
} from "./browser/registry";
import { ensureChromiumExecutable } from "./browser/launch";
import { resolveInitScriptSources } from "./browser/open-options";
import { resolveRelayKind } from "./browser/relay/kind";
import type { AriaSnapshotOptions } from "./browser/aria/aria-snapshot";
import { originOf, type ScreenshotResult } from "./browser/tab-protocol";
import type { ExecuteTaskParams } from "./browser/task/run";
import type { BrowserTaskResult } from "./browser/task/types";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import {
	type AcquireTabResult,
	acquireTab,
	cancelIdleCloseForOwner,
	dropHeadlessTabs,
	getTab,
	listTabs,
	reapAbandonedTabs,
	releaseAllTabs,
	releaseIdleTabsForOwner,
	releaseTab,
	runInTab,
} from "./browser/tab-supervisor";
import { renderTabCall } from "./browser/tab-call";
import { resolveToCwd } from "./path-utils";
import { renderCallChain, renderFunctionRun } from "./run-code";
import { ToolAbortError, throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";
import {
	type AutomationAction,
	type AutomationTier,
	automationDeniedError,
	decideAutomationAction,
	fingerprintAutomationCode,
	fingerprintAutomationValue,
	getAutomationScopes,
} from "./automation-policy";

import {
	cfgBrowserCdpUrl,
	cfgBrowserCmux,
	cfgBrowserHeadless,
	cfgBrowserIdleCloseSec,
	cfgBrowserRelay,
	cfgBrowserRelayUrl,
	cfgBrowserTabsAbandonedIdleHours,
	cfgBrowserTaskAllowConsequential,
	cfgBrowserTaskDeadlineSec,
	cfgBrowserTaskMaxActions,
	cfgBrowserTaskMaxCalls,
} from "./browser/settings";
import { cfgToolsMaxTimeout } from "./settings";

export type { AriaSnapshotOptions } from "./browser/aria/aria-snapshot";

/** First-use boundary for the generated Playwright ARIA evaluator bundle. */
export function buildAriaSnapshotScript(selector: string | undefined, options: AriaSnapshotOptions = {}): string {
	return require("./browser/aria/aria-snapshot").buildAriaSnapshotScript(selector, options);
}

/** First-use boundary for ARIA-ref parsing; keeps evaluator construction out of tool registration. */
export function parseAriaRefSelector(selector: string): string | null {
	return require("./browser/aria/aria-snapshot").parseAriaRefSelector(selector);
}

export { cmuxSnapshotToObservation, mapWaitUntil, resolveCmuxKind, serializeEval } from "./browser/cmux/rpc";
export { CmuxSocketClient } from "./browser/cmux/socket-client";
export {
	extractMarkdownOutline,
	extractReadableFromHtml,
	filterMarkdownSections,
	type ReadableExtractOptions,
	type ReadableFormat,
	type ReadableResult,
} from "./browser/readable";
export {
	ariaSnapshotBaselineKey,
	collectAriaSnapshotRefs,
	diffAriaSnapshot,
	postProcessAriaSnapshot,
	type AriaSnapshotBaseline,
	type AriaSnapshotDiffResult,
	type SnapshotPostProcessOptions,
} from "./browser/snapshot-plus";
export { DEFAULT_RELAY_URL, type RelayKind, resolveRelayKind } from "./browser/relay/kind";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

const DEFAULT_TAB_NAME = "main";
const BROWSER_RUN_SCOPE: readonly string[] = ["tab", "page", "browser", "wait", "assert"];

/**
 * Policy tier of every allowlisted `call` helper (`tab.<method>`, frame and
 * `tab.id(n).<method>`). `read` never changes page state (observation,
 * status, buffers, recordings, exports); `navigate` moves or scrolls an owned
 * page; everything that enters input, changes page/network/storage state, or
 * touches the user's clipboard is `mutate`. Anything not listed here is a
 * mutation by default, and every `run`, `evaluate`, raw `page`/`browser` is
 * raw arbitrary access (`mutate` + `raw`).
 */
const CALL_TIERS: Record<string, AutomationTier> = {
	// Observation and status.
	url: "read",
	title: "read",
	observe: "read",
	ariaSnapshot: "read",
	screenshot: "read",
	diffScreenshot: "read",
	pdf: "read",
	extract: "read",
	text: "read",
	html: "read",
	value: "read",
	attr: "read",
	styles: "read",
	count: "read",
	box: "read",
	boundingBox: "read",
	isVisible: "read",
	isHidden: "read",
	isEnabled: "read",
	isChecked: "read",
	waitFor: "read",
	waitForSelector: "read",
	waitForText: "read",
	waitForUrl: "read",
	waitForDownload: "read",
	frames: "read",
	dialog: "read",
	downloads: "read",
	devices: "read",
	initScripts: "read",
	routes: "read",
	requests: "read",
	clearRequests: "read",
	console: "read",
	errors: "read",
	clearConsole: "read",
	metrics: "read",
	vitals: "read",
	cookies: "read",
	storage: "read",
	saveState: "read",
	recording: "read",
	recordStart: "read",
	recordStop: "read",
	recordRestart: "read",
	traceStart: "read",
	traceStop: "read",
	profileStart: "read",
	profileStop: "read",
	harStart: "read",
	harStop: "read",
	reactTree: "read",
	reactInspect: "read",
	reactRenders: "read",
	reactSuspense: "read",
	webmcpList: "read",
	webmcpEvents: "read",
	// Moving an owned page.
	goto: "navigate",
	back: "navigate",
	forward: "navigate",
	reload: "navigate",
	pushState: "navigate",
	scroll: "navigate",
	scrollIntoView: "navigate",
	wheel: "navigate",
	focus: "navigate",
	hover: "navigate",
	mouseMove: "navigate",
	highlight: "navigate",
	// Input, page/network/storage state, clipboard.
	click: "mutate",
	clickAt: "mutate",
	dblclick: "mutate",
	check: "mutate",
	uncheck: "mutate",
	type: "mutate",
	fill: "mutate",
	press: "mutate",
	keyDown: "mutate",
	keyUp: "mutate",
	mouseDown: "mutate",
	mouseUp: "mutate",
	select: "mutate",
	drag: "mutate",
	uploadFile: "mutate",
	handleDialog: "mutate",
	setDialogs: "mutate",
	addInitScript: "mutate",
	removeInitScript: "mutate",
	allowedDomains: "mutate",
	route: "mutate",
	unroute: "mutate",
	request: "mutate",
	setCookies: "mutate",
	clearCookies: "mutate",
	setStorage: "mutate",
	clearStorage: "mutate",
	loadState: "mutate",
	emulate: "mutate",
	reactEnable: "mutate",
	webmcpInvoke: "mutate",
	clipboardRead: "mutate",
	clipboardWrite: "mutate",
	clipboardCopy: "mutate",
	clipboardPaste: "mutate",
};
/**
 * Value-bearing helpers: which arguments are the entered value(s). On the tab
 * (`tab.type(selector, text)`, `tab.press(key)`, `tab.select(selector, ...v)`,
 * `tab.uploadFile(selector, ...paths)`) the selector comes first except for
 * key/clipboard/state helpers; on an element handle (`tab.id(n).type(text)`)
 * values start at 0. Every value argument is fingerprinted (never logged) so
 * a changed value needs fresh approval.
 */
const VALUE_ARG_START: Record<string, { tab: number; element: number }> = {
	type: { tab: 1, element: 0 },
	fill: { tab: 1, element: 0 },
	select: { tab: 1, element: 0 },
	uploadFile: { tab: 1, element: 0 },
	press: { tab: 0, element: 0 },
	keyDown: { tab: 0, element: 0 },
	keyUp: { tab: 0, element: 0 },
	clipboardWrite: { tab: 0, element: 0 },
	setCookies: { tab: 0, element: 0 },
	setStorage: { tab: 0, element: 0 },
	loadState: { tab: 0, element: 0 },
};

/** Stable, non-secret fingerprint of every entered value in argument order; undefined when none. */
function fingerprintCallValues(method: string, args: readonly unknown[], onElement: boolean): string | undefined {
	const start = VALUE_ARG_START[method];
	if (!start) return undefined;
	const values = args.slice(onElement ? start.element : start.tab);
	if (values.length === 0) return undefined;
	return fingerprintAutomationValue(JSON.stringify(values));
}

/**
 * Build the policy descriptor for a `run`/`call` dispatch. A call chain is
 * classified by its terminal helper; `evaluate` anywhere in the chain is raw.
 * `run` (code or fn) is always raw: the policy never inspects code content,
 * but every raw action carries `codeFingerprint` — the sha256 prefix of the
 * EXACT rendered source handed to the worker (`code`, i.e. the code string,
 * `renderFunctionRun(fn, args)` or `renderTabCall(chain)`), so a user grant
 * can bind raw access to that source and nothing else.
 */
export function classifyBrowserDispatch(
	params: Pick<BrowserParams, "action" | "chain" | "name">,
	pageUrl: string | undefined,
	code: string,
	tab: { ownsTarget: boolean; invocationId?: string },
): AutomationAction {
	const target = originOf(pageUrl);
	const name = params.name ?? DEFAULT_TAB_NAME;
	const codeFingerprint = fingerprintAutomationCode(code);
	const identity = { ownsTarget: tab.ownsTarget, ...(tab.invocationId ? { invocationId: tab.invocationId } : {}) };
	const where = `tab ${JSON.stringify(name)}${tab.ownsTarget ? "" : " (adopted user tab)"}`;
	if (params.action !== "call") {
		return {
			surface: "browser",
			tier: "mutate",
			action: "browser.tab.run",
			target,
			consequential: false,
			raw: true,
			summary: `arbitrary code in ${where} (tab.run)`,
			codeFingerprint,
			...identity,
		};
	}
	const chain = params.chain ?? [];
	const terminal = chain[chain.length - 1];
	const method = terminal?.method ?? "";
	if (!terminal || chain.some(step => step.method === "evaluate")) {
		return {
			surface: "browser",
			tier: "mutate",
			action: "browser.tab.evaluate",
			target,
			consequential: false,
			raw: true,
			summary: `raw page evaluation in ${where}`,
			codeFingerprint,
			...identity,
		};
	}
	const tier = CALL_TIERS[method] ?? "mutate";
	const valueFingerprint = fingerprintCallValues(method, terminal.args, chain.length === 2);
	const navigateTarget =
		method === "goto" && typeof terminal.args[0] === "string" ? originOf(terminal.args[0]) : target;
	return {
		surface: "browser",
		tier,
		action: `browser.tab.${method}`,
		target: navigateTarget,
		consequential: false,
		raw: false,
		summary: `${method} on ${where} at ${navigateTarget}`,
		...(valueFingerprint !== undefined ? { valueFingerprint } : {}),
		...identity,
	};
}

/** Decide a non-run action (open/close) against the session scopes; deny throws `AUTOMATION_DENIED`. */
function gateBrowserAction(session: ToolSession, action: AutomationAction): void {
	const now = Date.now();
	const verdict = decideAutomationAction(action, { scopes: getAutomationScopes(session, now), now });
	if (verdict.verdict === "deny") throw automationDeniedError(verdict);
}

const appSchema = type({
	"path?": type("string").describe("binary path to spawn"),
	"cdp_url?": type("string").describe("existing cdp endpoint"),
	"relay?": type("boolean").describe("drive the user's own tabs via the omp browser relay"),
	"args?": type("string[]").describe("extra cli args"),
	"target?": type("string").describe("substring to pick a window"),
	"new_tab?": type("boolean").describe("open a fresh omp-owned tab instead of adopting one (relay/connected)"),
});

const tabCallStepSchema = type({
	method: "string",
	args: "unknown[]",
});

const browserSchema = type({
	action: type("'open' | 'close' | 'run' | 'call' | 'tabs' | 'task'").describe("operation"),
	"name?": type("string").describe("tab id (default 'main')"),
	"url?": type("string").describe("url to open"),
	"app?": appSchema,
	"viewport?": {
		width: "number",
		height: "number",
		"scale?": "number",
	},
	"wait_until?": type("'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'").describe(
		"navigation wait condition",
	),
	"dialogs?": type("'accept' | 'dismiss'").describe("auto-handle dialogs"),
	"allowed_domains?": type("string[]").describe("allowed request hostnames"),
	"init_scripts?": type("string[]").describe("document-start JavaScript sources or cwd-relative file paths"),
	"downloads?": type("string").describe("cwd-relative download directory"),
	"user_agent?": type("string").describe("tab user agent override"),
	"ignore_https_errors?": type("boolean").describe("ignore invalid HTTPS certificates"),
	"allow_file_access?": type("boolean").describe("allow file URLs to read local files"),
	"headed?": type("boolean").describe("override the configured browser display mode"),
	"code?": type("string").describe("js body to run in tab"),
	"fn?": type("string").describe("serialized JavaScript function to run in tab"),
	"args?": type("unknown[]").describe("arguments passed to a serialized function"),
	"chain?": tabCallStepSchema.array(),
	"timeout?": type("number").describe("timeout in seconds"),
	"all?": type("boolean").describe("release every managed tab"),
	"kill?": type("boolean").describe("also kill spawned-app browsers"),
	"persist?": type("boolean").describe("keep tab live across turn settle and idle close"),
	"goal?": type("string").describe("task: what to accomplish on this tab"),
	"values?": type({ "[string]": "string" }).describe("task: field values the caller authorizes, by field label"),
	"expect?": type({
		"urlIncludes?": "string",
		"textIncludes?": "string",
		"selector?": "string",
	}).describe("task: independent completion checks"),
	"maxActions?": type("number").describe("task: action bound"),
	"maxCalls?": type("number").describe("task: judgment-call bound"),
	"allowConsequential?": type("boolean").describe("task: permit submit/pay/delete-style controls"),
});

type BrowserParams = typeof browserSchema.infer;

interface BrowserPreludeDetails {
	meta?: OutputMeta;
	action: "open" | "close" | "run" | "call" | "tabs" | "task";
	name: string;
	url?: string;
	browser?: BrowserKindTag;
	/** `open` on a relay/connected browser: true for an omp-owned tab, false for an adopted user tab. */
	owned?: boolean;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	screenshots?: ScreenshotResult[];
	value?: unknown;
}

/** Surfaced when the relay is the configured identity but `PI_BROWSER_RELAY=0` turned it off. */
export const RELAY_DISABLED_MESSAGE =
	"Browser relay is the configured browser identity (browser.relay) but PI_BROWSER_RELAY=0 disabled it; " +
	"re-enable the relay, or choose a different identity explicitly per call " +
	"(app.relay: false for the managed agent profile, app.path, or app.cdp_url). No other profile is used implicitly.";

/** Which browser a call drives: explicit `app` options win, then the configured identity. Exported for tests. */
export function resolveBrowserKind(params: BrowserParams, session: ToolSession): BrowserKind {
	const app = params.app;
	if (app?.cdp_url) {
		return { kind: "connected", cdpUrl: app.cdp_url.replace(/\/+$/, "") };
	}
	if (app?.path) {
		const exe = resolveToCwd(app.path, session.cwd);
		const args = resolveSpawnArgs(exe, app.args, session.cwd);
		if (params.ignore_https_errors && !args.includes("--ignore-certificate-errors")) {
			args.push("--ignore-certificate-errors");
		}
		if (params.allow_file_access && !args.includes("--allow-file-access-from-files")) {
			args.push("--allow-file-access-from-files");
		}
		return { kind: "spawned", path: exe, args };
	}
	const relayUrl = cfgBrowserRelayUrl.get(session.settings);
	// Explicit app.relay wins over every setting; PI_BROWSER_RELAY stays the
	// final kill switch, but a kill switch disables the browser — it never
	// re-points the agent at a different cookie jar.
	if (app?.relay) {
		const relayKind = resolveRelayKind({ settingEnabled: true, url: relayUrl });
		if (relayKind) return relayKind;
		throw new Error(RELAY_DISABLED_MESSAGE);
	}
	// `app.relay: false` is the explicit choice of the managed agent profile
	// (a separate cookie jar): it selects exactly that identity and never falls
	// through to a configured cdpUrl/cmux endpoint, which would be a third one.
	if (app?.relay === false) {
		const headless = params.headed === undefined ? cfgBrowserHeadless.get(session.settings) : !params.headed;
		return {
			kind: "headless",
			headless,
			ignoreHttpsErrors: params.ignore_https_errors,
			allowFileAccess: params.allow_file_access,
		};
	}
	// Relay before cdpUrl among settings: enabling the opt-out-by-default relay
	// is a deliberate identity selection (the user's own logged-in Chrome), while
	// cdpUrl is a standing endpoint. A configured relay is the default identity,
	// not a preference: when it is disabled by the environment the call fails
	// instead of silently driving the managed profile.
	{
		const settingEnabled = cfgBrowserRelay.get(session.settings);
		const relayKind = resolveRelayKind({ settingEnabled, url: relayUrl });
		if (relayKind) return relayKind;
		if (settingEnabled) throw new Error(RELAY_DISABLED_MESSAGE);
	}
	const configuredCdpUrl = cfgBrowserCdpUrl.get(session.settings)?.trim();
	if (configuredCdpUrl) {
		return { kind: "connected", cdpUrl: configuredCdpUrl.replace(/\/+$/, "") };
	}
	const cmuxKind = resolveCmuxKind({
		settingEnabled: cfgBrowserCmux.get(session.settings),
	});
	if (cmuxKind) {
		return cmuxKind;
	}
	const headless = params.headed === undefined ? cfgBrowserHeadless.get(session.settings) : !params.headed;
	return {
		kind: "headless",
		headless,
		ignoreHttpsErrors: params.ignore_https_errors,
		allowFileAccess: params.allow_file_access,
	};
}

/** Create the enabled-only browser host prelude for one tool session. */
export function createBrowserPrelude(session: ToolSession): EvalPreludeDefinition {
	// Eval-first-use boundary: source/declaration assets stay unloaded until a
	// JavaScript or Python kernel actually asks for its enabled preludes.
	const { createBrowserPreludeDefinition } = require("./browser/prelude-definition");
	return createBrowserPreludeDefinition(session, {
		invoke: (parameters: unknown, context: EvalPreludeContext) => invokeBrowser(session, parameters, context),
		status: describeBrowserCall,
	});
}

/** Status-tree line for a completed browser call: `open main https://…`, `main.id(5).click()`, `close all`. */
function describeBrowserCall(parameters: unknown, result: AgentToolResult<unknown>): string | undefined {
	const parsed = browserSchema(parameters);
	if (parsed instanceof type.errors) return undefined;
	const name = parsed.name ?? DEFAULT_TAB_NAME;
	switch (parsed.action) {
		case "open": {
			const url = isRecord(result.details) ? result.details.url : undefined;
			return typeof url === "string" && url.length > 0 ? `open ${name} ${url}` : `open ${name}`;
		}
		case "close":
			return parsed.all ? "close all" : `close ${name}`;
		case "run":
			return `${name}.run(${parsed.fn !== undefined ? "fn" : (parsed.code?.trim().split("\n", 1)[0] ?? "")})`;
		case "call":
			return `${name}.${renderCallChain(parsed.chain ?? [])}`;
		case "tabs":
			return "tabs";
		case "task": {
			const status =
				isRecord(result.details) && isRecord(result.details.value) ? result.details.value.status : undefined;
			const goal = parsed.goal?.trim().split("\n", 1)[0] ?? "";
			return `${name}.task(${JSON.stringify(goal)})${typeof status === "string" ? ` ${status}` : ""}`;
		}
	}
}

/** Drop headless tabs so a browser mode change applies to the next open. */
export async function restartBrowserForModeChange(): Promise<void> {
	await dropHeadlessTabs();
}

/**
 * Best-effort idle-close sweep for the calling session's owned headless
 * tabs. Never throws — callers detach it (`void`) so a slow reap cannot
 * delay the open it follows.
 */
function sweepIdleOwnedTabs(session: ToolSession): Promise<number> {
	const ownerId = session.getSessionId?.() ?? undefined;
	if (!ownerId) return Promise.resolve(0);
	const abandonedMs = abandonedIdleMs(session);
	const abandoned =
		abandonedMs > 0
			? reapAbandonedTabs({ idleMs: abandonedMs, ownerId }).then(result => result.closed.length)
			: Promise.resolve(0);
	const idleSec = cfgBrowserIdleCloseSec.get(session.settings);
	if (!(idleSec > 0)) {
		cancelIdleCloseForOwner(ownerId);
		return abandoned;
	}
	return Promise.all([abandoned, releaseIdleTabsForOwner(ownerId, { idleMs: idleSec * 1000 })])
		.then(([reaped, idle]) => reaped + idle)
		.catch((error: unknown) => {
			logger.debug("Browser idle-close sweep failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return 0;
		});
}

/** `browser.tabs.abandonedIdleHours` as milliseconds; 0 when disabled or unconfigured. */
function abandonedIdleMs(session: ToolSession): number {
	const hours = cfgBrowserTabsAbandonedIdleHours.get(session.settings);
	return hours > 0 ? hours * 3_600_000 : 0;
}

async function invokeBrowser(
	session: ToolSession,
	parameters: unknown,
	context: EvalPreludeContext,
): Promise<AgentToolResult<unknown>> {
	const parsed = browserSchema(parameters);
	if (parsed instanceof type.errors) {
		throw new ToolError(`browser received invalid arguments: ${parsed.summary}`);
	}

	try {
		throwIfAborted(context.signal);
		const timeoutSeconds = clampTimeout("browser", parsed.timeout, cfgToolsMaxTimeout.get(session.settings));
		const timeoutMs = timeoutSeconds * 1000;
		const name = parsed.name ?? DEFAULT_TAB_NAME;
		const details: BrowserPreludeDetails = { action: parsed.action, name };

		switch (parsed.action) {
			case "open":
				return await openBrowser(session, name, parsed, details, timeoutMs, context);
			case "close":
				return await closeBrowser(session, name, parsed, details, timeoutMs, context);
			case "tabs":
				details.value = listTabs();
				return toolResult(details).done();
			case "run":
			case "call":
				return await runBrowser(session, name, parsed, details, timeoutMs, context);
			case "task":
				return await taskBrowser(session, name, parsed, details, timeoutMs, context);
		}
	} catch (error) {
		if (error instanceof ToolAbortError) throw error;
		if (error instanceof Error && error.name === "AbortError") {
			throw new ToolAbortError();
		}
		throw error;
	}
}

async function openBrowser(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	context: EvalPreludeContext,
): Promise<AgentToolResult<unknown>> {
	const { signal } = context;
	const kind = resolveBrowserKind(params, session);
	const downloadsPath = params.downloads === undefined ? undefined : resolveToCwd(params.downloads, session.cwd);
	details.browser = kind.kind;

	// If a tab with this name already exists on a different browser kind, fail fast — caller must close first.
	const existing = getTab(name);
	if (existing && browserKey(existing.browser.kind) !== browserKey(kind)) {
		throw new ToolError(
			`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}). Close it first.`,
		);
	}

	// `new_tab` preflight before any browser is downloaded, launched, or
	// connected: it only makes sense on a browser someone else drives.
	if (params.app?.new_tab) {
		if (params.app.target) {
			throw new ToolError(
				"browser open: app.new_tab and app.target are mutually exclusive — a fresh tab has no existing target to select.",
			);
		}
		if (kind.kind !== "relay" && kind.kind !== "connected") {
			throw new ToolError(
				`browser open: app.new_tab is only for user-driven browsers (app.relay or app.cdp_url), not ${describeKind(kind)}; headless and spawned browsers already own their page.`,
			);
		}
	}

	// Policy: opening/navigating an OMP-owned tab is `navigate`; steering an
	// adopted user tab to a URL is a mutation of the user's browser. Adoption
	// happens on a user-driven browser without `new_tab` (or reuse of a name
	// that already holds an adopted tab); a bare adoption without URL only reads.
	const userDriven = kind.kind === "relay" || kind.kind === "connected";
	const adopting = existing
		? existing.backend === "worker" && !existing.ownsTarget
		: userDriven && !params.app?.new_tab;
	gateBrowserAction(session, {
		surface: "browser",
		tier: adopting ? (params.url ? "mutate" : "read") : "navigate",
		action: adopting ? (params.url ? "browser.tab.goto" : "browser.tab.adopt") : "browser.tab.open",
		target: originOf(params.url),
		consequential: false,
		raw: false,
		// Ownership by construction: OMP creates the page (headless/spawned) or
		// the target (`app.new_tab`); anything else is the user's tab.
		ownsTarget: !adopting,
		invocationId: context.toolCallId,
		summary: `${adopting ? "adopt user tab" : "open owned tab"} ${JSON.stringify(name)}${params.url ? ` at ${originOf(params.url)}` : ""}`,
	});

	// First browser use may have to download Chrome for Testing (~180 MB).
	// That is a one-time install, not part of the open, so it runs before the
	// deadline below starts: charged against the 30s default it timed out on
	// connections where installation alone exceeds that budget.
	// The download promise is module-cached, so a caller abort here leaves it
	// finishing in the background and the next open picks up the result.
	if (kind.kind === "headless") await untilAborted(signal, () => ensureChromiumExecutable());

	// The requested timeout must cover the *entire* open — browser
	// acquisition (CDP discovery/connect), queued tab acquisition, worker
	// creation, and navigation — not only `acquireTab`. Compose one deadline
	// from the caller signal and `params.timeout` and thread it through both
	// stages so a stalled acquisition rejects at the requested boundary.
	// Capture the deadline start as well: `acquireTab` counts its
	// worker-init time against this same budget via `deadlineStartMs`
	// instead of restarting the clock after acquisition.
	const deadlineStart = performance.now();
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const openSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		const browser = await untilAborted(openSignal, () =>
			acquireBrowser(kind, {
				cwd: session.cwd,
				viewport: params.viewport
					? {
							width: params.viewport.width,
							height: params.viewport.height,
							deviceScaleFactor: params.viewport.scale,
						}
					: undefined,
				signal: openSignal,
			}),
		);

		// Hold one open-acquisition lease across the whole tab acquisition.
		// A freshly-created browser sits in the registry at refCount 0 until a
		// tab takes a hold; without this lease an abort/timeout mid-acquisition
		// (or a sibling open of a different tab name on the same browser that
		// fails) could dispose it out from under this operation. The lease is
		// released exactly once — the success and failure paths are mutually
		// exclusive — transferring ownership to the published tab on success or
		// rolling the fresh browser back on failure.
		holdBrowser(browser);
		let result: AcquireTabResult;
		try {
			const initScripts = await untilAborted(openSignal, () =>
				resolveInitScriptSources(params.init_scripts, session.cwd),
			);
			// Worker-init options cannot be applied to a live tab: recycle it so the
			// reopened tab starts with them.
			if (
				existing &&
				(initScripts.length > 0 ||
					params.downloads !== undefined ||
					params.user_agent !== undefined ||
					params.ignore_https_errors === true)
			) {
				await untilAborted(openSignal, () => releaseTab(name, { kill: false, timeoutMs }));
			}
			result = await untilAborted(openSignal, () =>
				acquireTab(name, browser, {
					url: params.url,
					waitUntil: params.wait_until,
					viewport: params.viewport
						? {
								width: params.viewport.width,
								height: params.viewport.height,
								deviceScaleFactor: params.viewport.scale,
							}
						: undefined,
					target: params.app?.target,
					createTarget: params.app?.new_tab,
					timeoutMs,
					deadlineStartMs: deadlineStart,
					dialogs: params.dialogs,
					allowedDomains: params.allowed_domains,
					initScripts,
					downloadsPath,
					userAgent: params.user_agent,
					ignoreHttpsErrors: params.ignore_https_errors,
					signal: openSignal,
					ownerSessionId: session.getSessionId?.() ?? undefined,
					// Omitted stays undefined: creation defaults it to false
					// while reuse by the owner leaves a set value alone.
					persist: params.persist,
					session,
					invocationId: context.toolCallId,
					abandonedIdleMs: abandonedIdleMs(session),
				}),
			);
		} catch (error) {
			await releaseBrowser(browser, {
				kill: "subprocess" in browser && browser.subprocess !== undefined,
			});
			throw error;
		}
		await releaseBrowser(browser, { kill: false });
		// Opportunistic idle-close sweep for long turns that rarely settle:
		// close owned tabs idle past the timeout. Detached by design (same
		// as the orphan-target sweep on attach) — failures only log. Freeze
		// is deliberately NOT done here: freezing a sibling with an
		// in-flight run would stall it mid-execution, while turn_end is
		// race-free by construction (all tool results are paired).
		void sweepIdleOwnedTabs(session);

		const tab = result.tab;
		const url = tab.info.url;
		const title = tab.info.title ?? "";
		details.url = url;
		details.viewport = tab.info.viewport;
		const verb = result.created ? "Opened" : "Reused";
		// On a user-driven browser say whose tab this is: an owned tab is
		// omp's to navigate and close; an adopted one is the user's.
		const userDrivenTab = tab.backend === "worker" && (tab.kindTag === "relay" || tab.kindTag === "connected");
		if (userDrivenTab) details.owned = tab.ownsTarget;
		const ownership = userDrivenTab ? (tab.ownsTarget ? " (owned tab)" : " (adopted tab)") : "";
		const lines = [
			`${verb} tab ${JSON.stringify(name)} on ${describeBrowser(browser)}${ownership}`,
			`URL: ${url}`,
			title ? `Title: ${title}` : null,
		].filter((line): line is string => typeof line === "string");
		return toolResult(details).text(lines.join("\n")).done();
	} catch (error) {
		// Caller cancellation stays a ToolAbortError; the requested timeout
		// becomes a timeout ToolError; anything else passes through unchanged.
		if (signal?.aborted) throw error instanceof ToolAbortError ? error : new ToolAbortError();
		if (timeoutSignal.aborted) throw new ToolError(`Browser open timed out after ${timeoutMs}ms`);
		throw error;
	}
}

async function closeBrowser(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	context: EvalPreludeContext,
): Promise<AgentToolResult<unknown>> {
	const { signal } = context;
	const kill = !!params.kill;
	// Closing an OMP-owned tab is `navigate`; releasing an adopted user tab
	// only detaches (release never closes it) and is a read-tier act.
	const gateClose = (tabName: string): void => {
		const tab = getTab(tabName);
		const owned = tab === undefined || tab.backend !== "worker" || tab.ownsTarget;
		gateBrowserAction(session, {
			surface: "browser",
			tier: owned ? "navigate" : "read",
			action: owned ? "browser.tab.close" : "browser.tab.detach",
			target: originOf(tab?.info.url),
			consequential: false,
			raw: false,
			ownsTarget: owned,
			invocationId: context.toolCallId,
			summary: `${owned ? "close owned" : "detach adopted"} tab ${JSON.stringify(tabName)}`,
		});
	};
	if (params.all) {
		gateClose(name);
		const count = await untilAborted(signal, () => releaseAllTabs({ kill, timeoutMs }));
		const text = `Released ${count} managed tab${count === 1 ? "" : "s"}`;
		return toolResult(details).text(text).done();
	}
	gateClose(name);
	const closed = await untilAborted(signal, () => releaseTab(name, { kill, timeoutMs }));
	const text = closed ? `Released managed tab ${JSON.stringify(name)}` : `No tab named ${JSON.stringify(name)}`;
	return toolResult(details).text(text).done();
}

function resolveBrowserRunCode(params: BrowserParams): string {
	if (params.action === "call") return renderTabCall(params.chain ?? []);
	const code = params.code?.trim();
	const fn = params.fn?.trim();
	if ((code === undefined || code.length === 0) === (fn === undefined || fn.length === 0)) {
		throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
	}
	if (fn !== undefined && fn.length > 0) {
		return renderFunctionRun(fn, BROWSER_RUN_SCOPE, params.args ?? []);
	}
	return code ?? "";
}

async function runBrowser(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	context: EvalPreludeContext,
): Promise<AgentToolResult<unknown>> {
	const code = resolveBrowserRunCode(params);
	const tab = getTab(name);
	if (tab) {
		details.browser = tab.browser.kind.kind;
		details.url = tab.info.url;
	}
	// Ownership from supervisor state (the gate re-derives it authoritatively
	// at dispatch; this keeps the descriptor and its summary truthful).
	const ownsTarget = tab !== undefined && (tab.backend !== "worker" || tab.ownsTarget);
	const { displays, returnValue, screenshots } = await runInTab(name, {
		code,
		timeoutMs,
		signal: context.signal,
		session,
		invocationId: context.toolCallId,
		automation: classifyBrowserDispatch(params, tab?.info.url, code, {
			ownsTarget,
			invocationId: context.toolCallId,
		}),
	});

	if (screenshots.length) details.screenshots = screenshots;

	if (returnValue !== undefined) details.value = returnValue;
	const content = [...displays];
	const textOnly = content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(part => part.text)
		.join("\n");
	// Final defense at the host-result boundary: a single run can display
	// tens of KB (large JSON returns, dumped observations). Cap the combined
	// text inline; the full text stays recoverable via the artifact footer
	// when allocation succeeds.
	const cappedText = await enforceInlineByteCap(textOnly, {
		saveArtifact: full => saveBrowserOutputArtifact(session, full),
	});
	const nonText = content.filter(part => part.type !== "text");
	if (cappedText.length === 0) return toolResult(details).content(nonText).done();
	return toolResult(details)
		.content([...nonText, { type: "text", text: cappedText }])
		.done();
}

/** Typed view of the lazily-required task runner. */
interface TaskRunner {
	executeBrowserTask(session: ToolSession, params: ExecuteTaskParams): Promise<BrowserTaskResult>;
	renderTaskResult(result: BrowserTaskResult): string;
}

/**
 * Goal-directed task over one named tab: local candidate derivation, one
 * metered judgment request per step, guarded execution, and independent
 * verification of the model's DONE.
 *
 * Eval-first-use boundary: the loop pulls in the judgment stack and its prompt
 * assets, which an ordinary open/observe/click never needs.
 */
async function taskBrowser(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	context: EvalPreludeContext,
): Promise<AgentToolResult<unknown>> {
	const { signal } = context;
	const goal = params.goal?.trim();
	if (goal === undefined || goal.length === 0) {
		throw new ToolError("Action 'task' requires a non-empty 'goal'.");
	}
	const tab = getTab(name);
	if (tab) {
		details.browser = tab.browser.kind.kind;
		details.url = tab.info.url;
	}
	const runner: TaskRunner = require("./browser/task/run");
	// An explicit `timeout` is the caller's deadline for the whole task;
	// otherwise the task setting applies rather than the 30s per-call default.
	const deadlineMs = params.timeout === undefined ? cfgBrowserTaskDeadlineSec.get(session.settings) * 1000 : timeoutMs;
	const result = await runner.executeBrowserTask(session, {
		name,
		goal,
		...(params.values === undefined ? {} : { values: params.values }),
		...(params.expect === undefined ? {} : { expect: params.expect }),
		...(params.maxActions === undefined ? {} : { maxActions: params.maxActions }),
		...(params.maxCalls === undefined ? {} : { maxCalls: params.maxCalls }),
		allowConsequential: params.allowConsequential ?? cfgBrowserTaskAllowConsequential.get(session.settings),
		deadlineMs,
		maxActionsDefault: cfgBrowserTaskMaxActions.get(session.settings),
		maxCallsDefault: cfgBrowserTaskMaxCalls.get(session.settings),
		// Approve-once scopes granted during this invocation bind to it.
		invocationId: context.toolCallId,
		...(signal ? { signal } : {}),
	});
	details.value = result;
	return toolResult(details).text(runner.renderTaskResult(result)).done();
}

/** Persist over-cap browser run output as a session artifact; mirrors the bash minimizer's save path. */
async function saveBrowserOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("browser-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, fullText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

function describeBrowser(handle: BrowserHandle): string {
	if (!("browser" in handle)) {
		return `cmux browser (${handle.kind.surface ?? "split"})`;
	}
	switch (handle.kind.kind) {
		case "headless":
			return `headless browser (${handle.kind.headless ? "hidden" : "visible"}${handle.sharedDaemon ? ", shared" : ""})`;
		case "spawned":
			return `spawned ${handle.kind.path} (pid ${handle.pid ?? "?"})`;
		case "connected":
			return `connected ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
		case "relay":
			return `relay ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
	}
}

function describeKind(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless ${kind.headless ? "hidden" : "visible"}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "relay":
			return `relay:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.surface ?? "split"}`;
	}
}
