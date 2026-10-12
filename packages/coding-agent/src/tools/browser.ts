import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getWebKitHostPath, isRecord, logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { EvalPreludeContext, HostEvalPreludeDefinition } from "../eval/preludes";
import type { ToolSession } from "../sdk";
import { enforceInlineByteCap } from "./streaming-output";
import { CmuxUnavailableError, resolveCmuxKind } from "./browser/cmux/rpc";
import { type CdpTarget, describeCdpTargets, listCdpTargets, resolveSpawnArgs } from "./browser/attach";
import {
	acquireBrowser,
	browserKey,
	type BrowserKind,
	type BrowserKindTag,
	holdBrowser,
	normalizeConnectedCdpUrl,
	type PuppeteerBrowserKind,
	releaseBrowser,
} from "./browser/registry";
import { chromiumNeedsDownload, ensureChromiumExecutable } from "./browser/launch";
import { type EmulationViewport, viewportSchema } from "./browser/emulation";
import { sameAddress } from "./browser/navigation";
import { resolveInitScriptSources } from "./browser/open-options";
import type { BrowserRelayGuidance } from "./browser/prelude-definition";
import { isRelayOnly, resolveRelayKind } from "./browser/relay/kind";
import { relayExtensionNotice } from "./browser/relay/probe";
import { describeTernTargets, listTernBlocks, type TernTarget, ternTargets } from "./browser/tern/blocks";
import { resolveTernKind } from "./browser/tern/kind";
import { isTernUnavailable } from "./browser/tern/wire";
import { ownsTerminal } from "./browser/terminal-owner";
import { WebKitUnavailableError } from "./browser/webkit/host";
import { installWebKitEngine, webKitEngineToInstall } from "./browser/webkit/install";
import { resolveWebKitKind, VIEWER_PLATFORMS } from "./browser/webkit/kind";
import type { AriaSnapshotOptions } from "./browser/aria/aria-snapshot";
import { originOf, type ScreenshotResult } from "./browser/tab-protocol";
import type { ExecuteTaskParams } from "./browser/task/run";
import type { BrowserTaskResult } from "./browser/task/types";
import type { OutputMeta } from "./output-meta-format";
import type { Viewport } from "puppeteer-core";
import {
	type AcquireTabResult,
	acquireTab,
	cancelIdleCloseForOwner,
	dropHeadlessTabs,
	getTab,
	listTabs,
	reapAbandonedTabs,
	releaseAllTabs,
	releaseTabsForOwner,
	releaseIdleTabsForOwner,
	releaseTab,
	runInTab,
	setWebKitTabsShown,
	type TabSession,
	type TernTabSession,
	ternBlocksTaken,
} from "./browser/tab-supervisor";
import { renderTabCall, tabCallBudgetSeconds } from "./browser/tab-call";
import { resolveToCwd } from "./path-utils";
import { renderFunctionRun, renderStatusCallChain } from "./run-code";
import { ToolAbortError, throwIfAborted } from "./tool-errors";
import { ToolError } from "./tool-errors";
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
	cfgBrowserTern,
	cfgBrowserWebKit,
	cfgBrowserWebKitPath,
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
export { isRelayOnly, type RelayKind, resolveRelayKind } from "./browser/relay/kind";
export { type TernKind, resolveTernKind } from "./browser/tern/kind";
export { resolveWebKitKind, type WebKitKind } from "./browser/webkit/kind";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

const DEFAULT_TAB_NAME = "main";
const BROWSER_RUN_SCOPE: readonly string[] = ["tab", "page", "browser", "wait", "assert"];

/** Browsers `app` names by keyword; any other `app` is a CDP endpoint URL or an executable path. */
const APP_KEYWORDS: readonly string[] = ["relay", "tern", "webkit", "chromium", "own", "auto"];

/** A `scheme://` string names a CDP endpoint to attach to; Windows drive paths (`C:\`) do not match. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

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

const tabCallStepSchema = type({
	method: "string",
	args: "unknown[]",
});

const browserSchema = type({
	action: type("'open' | 'close' | 'run' | 'call' | 'tabs' | 'targets' | 'task'").describe("operation"),
	"name?": type("string").describe("tab id (default 'main')"),
	"url?": type("string").describe("url to open"),
	"app?": type("string").describe(
		"browser to drive: 'relay' (the user's Chrome), 'tern' (Tern picture-in-picture), 'webkit', 'chromium' (managed), 'own' (omp's own browser: WebKit if installed, else Chromium), 'auto' (default choice without the relay), a CDP endpoint URL to attach to, or an executable path to spawn",
	),
	"argv?": type("string[]").describe("extra cli args when app is an executable path"),
	"target?": type("string").describe(
		"URL/title substring picking the page to drive; inside Tern, adopts the user's browser block (or its id)",
	),
	"viewport?": viewportSchema,
	"wait_until?": type("'load' | 'domcontentloaded' | 'networkidle' | 'networkidle0' | 'networkidle2'").describe(
		"navigation wait condition",
	),
	"dialogs?": type("'accept' | 'dismiss'").describe("auto-handle dialogs"),
	"allowed_domains?": type("string[]").describe("allowed request hostnames"),
	"init_scripts?": type("string[]").describe("document-start JavaScript sources or cwd-relative file paths"),
	"downloads?": type("string").describe("cwd-relative download directory"),
	"user_agent?": type("string").describe("tab user agent override"),
	"insecure?": type("boolean").describe("ignore invalid HTTPS certificates"),
	"headed?": type("boolean").describe("override the configured display mode: a window for the tab (true) or none"),
	"code?": type("string").describe("js body to run in tab"),
	"fn?": type("string").describe("serialized JavaScript function to run in tab"),
	"args?": type("unknown[]").describe("arguments passed to a serialized function"),
	"chain?": tabCallStepSchema.array(),
	"timeout?": type("number").describe("timeout in seconds"),
	"all?": type("boolean").describe("release every managed tab this agent opened"),
	"kill?": type("boolean").describe("also kill spawned-app browsers"),
	"persist?": type("boolean").describe(
		"keep tab live across turn settle and idle close; on a relay tab omp opened, keep it open after the session ends",
	),
	"new_tab?": type("boolean").describe(
		"open a fresh omp-owned tab instead of adopting one (relay or an attached CDP endpoint)",
	),
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
	action: BrowserParams["action"];
	name: string;
	url?: string;
	browser?: BrowserKindTag;
	/** `open` on a relay/connected browser: true for an omp-owned tab, false for an adopted user tab. */
	owned?: boolean;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	screenshots?: ScreenshotResult[];
	value?: unknown;
}

/** Surfaced when the relay is the selected identity (`app: "relay"` or `browser.relay`) but `PI_BROWSER_RELAY=0` turned it off. */
export const RELAY_DISABLED_MESSAGE =
	"Browser relay is the configured browser identity (browser.relay) but PI_BROWSER_RELAY=0 disabled it; " +
	"re-enable the relay, or choose a different identity explicitly per call " +
	'(app: "own" or "chromium" for omp\'s own browser, an executable path, or a CDP endpoint URL). No other profile is used implicitly.';

/**
 * The browser an open drives, by precedence: an explicit `app` (an executable
 * path or CDP URL, or a keyword: `relay`, `tern`, `webkit`, `chromium`, `own`),
 * the relay, `browser.cdpUrl`, Tern (inside a Tern pane; `target` selects it
 * over the `browser.tern` setting to adopt a block; `headed` does not opt out),
 * a cmux surface, then omp's own browser ({@link ownBrowserKind}). `app: "auto"`
 * is that chain without the relay. Tern and cmux are automatic only while no
 * other omp owns the terminal, and none of the user's own surfaces (relay, Tern,
 * cmux) is automatic for a subagent. With `PI_BROWSER_RELAY=only` (a session
 * started from the extension's side panel) every open, a subagent's included,
 * goes to the relay, and any `app` but `"relay"` throws. `app: "tern"` and `app: "webkit"` are explicit:
 * they throw when Tern or omp's WebKit host is unavailable.
 *
 * The relay is an identity, not a preference: when `app: "relay"` or the
 * `browser.relay` setting selects it and `PI_BROWSER_RELAY=0` disables it, the
 * call fails ({@link RELAY_DISABLED_MESSAGE}) instead of silently driving a
 * different cookie jar. Exported for tests.
 */
export function resolveBrowserKind(
	params: BrowserParams,
	session: ToolSession,
	env: Record<string, string | undefined> = process.env,
): BrowserKind {
	const app = params.app;
	if (isRelayOnly(env)) {
		if (app !== undefined && app !== "relay") {
			throw new ToolError(
				`This session drives the user's Chrome through the omp extension and has no other browser; app: ${JSON.stringify(app)} is unavailable. Omit app or pass app: "relay".`,
			);
		}
		const relayKind = resolveRelayKind(
			{ url: env.PI_PANEL_RELAY_URL ?? cfgBrowserRelayUrl.get(session.settings) },
			env,
		);
		if (relayKind) return relayKind;
	}
	if (app !== undefined && URL_SCHEME.test(app)) {
		return { kind: "connected", cdpUrl: app.replace(/\/+$/, "") };
	}
	if (app && !APP_KEYWORDS.includes(app)) {
		const exe = resolveToCwd(app, session.cwd);
		const args = resolveSpawnArgs(exe, params.argv, session.cwd);
		if (params.insecure && !args.includes("--ignore-certificate-errors")) {
			args.push("--ignore-certificate-errors");
		}
		if (!args.includes("--allow-file-access-from-files")) {
			args.push("--allow-file-access-from-files");
		}
		return { kind: "spawned", path: exe, args };
	}
	const relayUrl = cfgBrowserRelayUrl.get(session.settings);
	// Explicit app: "relay" wins over every setting; PI_BROWSER_RELAY stays the
	// final kill switch, but a kill switch disables the browser — it never
	// re-points the agent at a different cookie jar.
	if (app === "relay") {
		const relayKind = resolveRelayKind({ settingEnabled: true, url: relayUrl }, env);
		if (relayKind) return relayKind;
		throw new Error(RELAY_DISABLED_MESSAGE);
	}
	if (app === "tern") {
		const ternKind = resolveTernKind({ settingEnabled: true }, env);
		if (!ternKind) {
			throw new ToolError(
				'app: "tern" requires running inside a Tern pane (TERN_PANE_SOCKET and TERN_PANE are not set) with PI_BROWSER_TERN not set to 0.',
			);
		}
		return ternKind;
	}
	if (app === "webkit") {
		const webkitKind = resolveWebKitKind(
			{ settingEnabled: true, settingPath: cfgBrowserWebKitPath.get(session.settings) },
			env,
		);
		if (!webkitKind) {
			throw new ToolError(
				`app: "webkit" requires omp's WebKit engine, and none is installed: its host executable must be ${getWebKitHostPath()}, or be named by PI_BROWSER_WEBKIT_PATH or the browser.webkitPath setting, with PI_BROWSER_WEBKIT not set to 0.`,
			);
		}
		return webkitKind;
	}
	if (app === "chromium") return chromiumKind(params, session);
	if (app === "own") return ownBrowserKind(params, session, env);
	// Relay before cdpUrl among settings: enabling the opt-out-by-default relay
	// is a deliberate identity selection (the user's own logged-in Chrome), while
	// cdpUrl is a standing endpoint. A configured relay is the default identity,
	// not a preference: when it is disabled by the environment the call fails
	// instead of silently driving another profile. An explicit app wins. A `/tan`
	// clone (task depth 0) keeps its parent's defaults; subagents never get the relay implicitly.
	const subagent = (session.taskDepth ?? 0) > 0;
	if (app !== "auto" && !subagent) {
		const settingEnabled = cfgBrowserRelay.get(session.settings);
		const relayKind = resolveRelayKind({ settingEnabled, url: relayUrl }, env);
		if (relayKind) return relayKind;
		if (settingEnabled) throw new Error(RELAY_DISABLED_MESSAGE);
	}
	const configuredCdpUrl = cfgBrowserCdpUrl.get(session.settings)?.trim();
	if (configuredCdpUrl) {
		return { kind: "connected", cdpUrl: configuredCdpUrl.replace(/\/+$/, "") };
	}
	// Tern and cmux show the tab beside the omp drawn in that terminal. An omp started from that
	// session's commands (`omp -p` from its bash tool, a script an eval cell runs) inherited the
	// pane env, and its tabs would float over the other session's work. A subagent has no pane of
	// its own either: its tabs would pile up over the parent's, so it skips both even when
	// PI_BROWSER_TERN=1 or PI_BROWSER_CMUX=1 forces them for the parent.
	const ownsPane = ownsTerminal(env);
	if (!subagent || params.target !== undefined) {
		// `target` inside Tern names a browser block to adopt: an explicit request, like `app: "tern"`.
		const ternKind = resolveTernKind(
			{ settingEnabled: params.target !== undefined || (ownsPane && cfgBrowserTern.get(session.settings)) },
			env,
		);
		if (ternKind) return ternKind;
	}
	if (!subagent) {
		const cmuxKind = resolveCmuxKind({ settingEnabled: ownsPane && cfgBrowserCmux.get(session.settings) }, env);
		if (cmuxKind) return cmuxKind;
	}
	return ownBrowserKind(params, session, env);
}

/**
 * omp's own browser, where an open ends when nothing else takes it: its
 * WebKit host when that backend is on (`browser.webkit`,
 * `PI_BROWSER_WEBKIT`; `app: "chromium"` opts one open out) and its
 * executable is installed (`PI_BROWSER_WEBKIT_PATH`, `browser.webkitPath`,
 * else `~/.o2/lib/abkit/ABHost`), and managed Chromium otherwise and for a
 * visible window (`headed: true`, or `browser.headless` off) where the engine
 * ships no viewer to show one.
 */
function ownBrowserKind(
	params: BrowserParams,
	session: ToolSession,
	env: Record<string, string | undefined> = process.env,
): BrowserKind {
	const chromium = chromiumKind(params, session);
	const webkit = resolveWebKitKind(
		{
			settingEnabled: cfgBrowserWebKit.get(session.settings),
			settingPath: cfgBrowserWebKitPath.get(session.settings),
		},
		env,
	);
	// A window is the viewer's to show: an engine without one leaves visible tabs to Chromium.
	if (!webkit || (!chromium.headless && !webkit.viewer)) return chromium;
	return webkit;
}

/** The Chromium browser an open launches when no attach/app mode applies and omp's WebKit host does not take it. */
function chromiumKind(
	params: BrowserParams,
	session: ToolSession,
): Extract<PuppeteerBrowserKind, { kind: "headless" }> {
	const headless = params.headed === undefined ? cfgBrowserHeadless.get(session.settings) : !params.headed;
	return {
		kind: "headless",
		headless,
		insecure: params.insecure,
	};
}

/** Create the enabled-only browser host prelude for one tool session. */
export function createBrowserPrelude(session: ToolSession): HostEvalPreludeDefinition {
	// Eval-first-use boundary: source/declaration assets stay unloaded until a
	// JavaScript or Python kernel actually asks for its enabled preludes.
	const { createBrowserPreludeDefinition } = require("./browser/prelude-definition");
	return createBrowserPreludeDefinition(session, {
		invoke: (parameters: unknown, context: EvalPreludeContext) => invokeBrowser(session, parameters, context),
		status: describeBrowserCall,
		// The documentation promises omp's own browser for an open without `app`; while
		// the relay takes that open, the prompt says so: the only browser in relay-only
		// mode, otherwise naming where `app: "auto"` goes instead.
		get relay(): BrowserRelayGuidance | undefined {
			return relayGuidanceOf(session);
		},
	});
}

/**
 * The relay guidance to render: `only` in relay-only mode, where `app: "auto"` goes while an open without `app`
 * takes the relay, else undefined. A relay the environment disabled makes that open fail
 * (`RELAY_DISABLED_MESSAGE`), so it has no fallback to name.
 */
function relayGuidanceOf(session: ToolSession): BrowserRelayGuidance | undefined {
	if (isRelayOnly()) return { mode: "only" };
	let defaultKind: BrowserKind;
	try {
		defaultKind = resolveBrowserKind({ action: "open" }, session);
	} catch {
		return undefined;
	}
	if (defaultKind.kind !== "relay") return undefined;
	return { mode: "default", fallback: resolveBrowserKind({ action: "open", app: "auto" }, session) };
}

/** Status-tree line for a completed browser call: `open main https://…`, `main.id(5).click()`, `close all`. */
function describeBrowserCall(parameters: unknown, result: AgentToolResult<unknown>): string | undefined {
	const parsed = browserSchema(withStringApp(parameters));
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
		case "call": {
			const chain = parsed.chain ?? [];
			return `${name}.${renderStatusCallChain(chain, (step, index) => browserTextStart(step.method, chain[index - 1]?.method))}`;
		}
		case "tabs":
			return "tabs";
		case "targets":
			return "targets";
		case "task": {
			const status =
				isRecord(result.details) && isRecord(result.details.value) ? result.details.value.status : undefined;
			const goal = parsed.goal?.trim().split("\n", 1)[0] ?? "";
			return `${name}.task(${JSON.stringify(goal)})${typeof status === "string" ? ` ${status}` : ""}`;
		}
	}
}

/**
 * Where the text a browser helper enters starts in its arguments: after the selector of a tab or
 * frame `fill`/`type`, first on an element handle and for clipboard and dialog text.
 */
function browserTextStart(method: string, previous: string | undefined): number | undefined {
	switch (method) {
		case "fill":
		case "type":
			return previous === undefined || previous === "frame" ? 1 : 0;
		case "clipboardWrite":
		case "handleDialog":
			return 0;
		default:
			return undefined;
	}
}

/**
 * Apply a change of the browser mode (`/browser headless|visible`). WebKit
 * tabs change now: each gains or loses its window, the page going on
 * untouched. A Chromium cannot change mode while it runs, so its headless
 * tabs are dropped and the next open launches it in the new mode.
 */
export async function applyBrowserModeChange(headless: boolean): Promise<void> {
	try {
		await setWebKitTabsShown(!headless);
	} finally {
		await dropHeadlessTabs();
	}
}

/**
 * Owner key for tabs this session opens: the agent's stable kernel owner id,
 * which survives `/new`, `/resume`, fork, and branch (unlike the conversation
 * session id) and is shared with its advisors, like eval kernels and computer
 * sessions. Subagents get their own.
 */
function tabOwnerId(session: ToolSession): string | undefined {
	return session.getEvalKernelOwnerId?.() ?? undefined;
}

/**
 * Best-effort idle-close sweep for the calling session's owned headless
 * tabs. Never throws — callers detach it (`void`) so a slow reap cannot
 * delay the open it follows.
 */
function sweepIdleOwnedTabs(session: ToolSession): Promise<number> {
	const ownerId = tabOwnerId(session);
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
	const parsed = browserSchema(withStringApp(parameters));
	if (parsed instanceof type.errors) {
		throw new ToolError(`browser received invalid arguments: ${parsed.summary}`);
	}

	try {
		throwIfAborted(context.signal);
		const requested =
			parsed.timeout ??
			(parsed.action === "call" || parsed.action === "run"
				? tabCallBudgetSeconds(parsed.chain, context.cellTimeoutMs)
				: undefined);
		const timeoutSeconds = clampTimeout("browser", requested, cfgToolsMaxTimeout.get(session.settings));
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
			case "targets":
				return await listTargets(session, parsed, details, timeoutMs, context.signal);
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

/**
 * `parameters` with an object `app` (`{tern: false}`, `{relay: true, target}`, `{cdp_url}`, `{path, args}`), the
 * shape `app` had before it became one string, read as the string call that means the same: its `target` and
 * `args` go top-level unless given there too.
 */
function withStringApp(parameters: unknown): unknown {
	if (!isRecord(parameters) || !isRecord(parameters.app)) return parameters;
	const legacy = parameters.app;
	const { app: _, ...rest } = parameters;
	const cdpUrl = legacy.cdp_url ?? legacy.cdpUrl;
	let app: string | undefined;
	if (typeof cdpUrl === "string") app = cdpUrl;
	else if (typeof legacy.path === "string") app = legacy.path;
	else if (legacy.relay === true) app = "relay";
	else if (legacy.tern === true) app = "tern";
	else if (legacy.tern === false) app = "own";
	else if (legacy.relay === false) app = "auto";
	const normalized: Record<string, unknown> = { ...rest };
	if (app !== undefined) normalized.app = app;
	const argv = legacy.args ?? legacy.argv;
	if (normalized.argv === undefined && Array.isArray(argv)) normalized.argv = argv;
	if (normalized.target === undefined && typeof legacy.target === "string") normalized.target = legacy.target;
	return normalized;
}

/** An open's `viewport` as Puppeteer sizes a page. */
function puppeteerViewport(viewport: EmulationViewport): Viewport {
	return {
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: viewport.scale,
		isMobile: viewport.isMobile,
		hasTouch: viewport.hasTouch,
	};
}

/**
 * Open (or reuse) a tab, falling back when the browser chosen automatically
 * cannot host it, and saying so in the result:
 * - A Tern PiP (not forced with `app: "tern"`) that Tern cannot show — no
 *   window, an unsupported platform, a refused or failed connection — goes to
 *   omp's own browser, as an open outside Tern would. Adopting a Tern block
 *   (`target`) never falls back: no other browser has that page.
 * - omp's WebKit host (not forced with `app: "webkit"`) that cannot start,
 *   cannot open its first tab, or could not be downloaded
 *   ({@link installWebKitForOpen}) goes to managed Chromium.
 * - A cmux surface (always an automatic choice) that fails to open goes to
 *   omp's own browser.
 *
 * A tab that already fell back keeps its browser.
 */
async function openBrowser(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	context: EvalPreludeContext,
): Promise<AgentToolResult<unknown>> {
	const { signal } = context;
	// `new_tab` preflight before any browser is downloaded, launched, or connected.
	if (params.new_tab) assertNewTabApplies(params, resolveBrowserKind(params, session));
	const webkitDownloadFailure = await installWebKitForOpen(session, params, signal);
	const resolved = resolveBrowserKind(params, session);
	const autoTern = resolved.kind === "tern" && params.app !== "tern" && params.target === undefined;
	const autoWebKit = params.app !== "webkit";
	const existing = getTab(name);
	// cmux is only ever chosen automatically; a live cmux tab under the name stays there.
	const autoCmux = resolved.kind === "cmux" && existing?.kindTag !== "cmux";
	const existingKind = existing?.browser.kind;
	let kind = resolved;
	if (autoTern && existing && existing.kindTag !== "tern") {
		kind = existing.browser.kind;
	} else if (
		existingKind?.kind === "headless" &&
		params.headed === undefined &&
		(!params.insecure || existingKind.insecure) &&
		(resolved.kind === "headless" || (resolved.kind === "webkit" && autoWebKit))
	) {
		// Reopening a managed Chromium tab without `headed` keeps the window mode it opened in.
		kind = existingKind;
	} else if (resolved.kind === "webkit" && autoWebKit && existing) {
		// A tab that fell back to Chromium keeps it, as does one opened while the WebKit host was not installed.
		const chromium = chromiumKind(params, session);
		if (browserKey(existing.browser.kind) === browserKey(chromium)) kind = chromium;
	}
	const startedAt = performance.now();
	/** Why each browser tried before `kind` could not take the open. */
	const failures: Array<{ backend: "tern" | "webkit" | "cmux"; reason: string }> =
		webkitDownloadFailure === undefined ? [] : [{ backend: "webkit", reason: webkitDownloadFailure }];
	// The WebKit engine always checks HTTPS certificates and has no mobile or touch emulation: such an open needs Chromium.
	const chromiumOnly = params.insecure
		? "it cannot ignore invalid HTTPS certificates (insecure)"
		: params.viewport?.isMobile || params.viewport?.hasTouch
			? "it cannot emulate a mobile or touch viewport"
			: undefined;
	if (kind.kind === "webkit" && chromiumOnly && !autoWebKit) {
		throw new ToolError(`app: "webkit" cannot take this open: ${chromiumOnly}. Pass app: "chromium", or omit app.`);
	}
	for (;;) {
		if (kind.kind === "webkit" && chromiumOnly) {
			failures.push({ backend: "webkit", reason: chromiumOnly });
			kind = chromiumKind(params, session);
		}
		const opened = kind.kind === "webkit" ? "omp's WebKit browser" : "Chromium";
		const notes = failures.map(failure =>
			failure.backend === "tern"
				? `Tern cannot show a browser here (${failure.reason}); opened ${opened} instead. Pass app: "own" to skip Tern, or app: "tern" to require it.`
				: failure.backend === "cmux"
					? `cmux could not open a browser surface here (${failure.reason}); opened ${opened} instead. Pass app: "own" to skip cmux.`
					: `omp's WebKit browser could not take this open (${failure.reason}); opened Chromium instead. Pass app: "chromium" to skip it, or app: "webkit" to require it.`,
		);
		const remainingMs = Math.max(1, timeoutMs - (performance.now() - startedAt));
		try {
			return await openOnKind(session, name, params, details, kind, remainingMs, notes, context);
		} catch (error) {
			if (signal?.aborted) throw error;
			let next: BrowserKind;
			if (kind.kind === "tern" && autoTern && isTernUnavailable(error)) {
				failures.push({ backend: "tern", reason: error.message });
				next = ownBrowserKind(params, session);
			} else if (kind.kind === "webkit" && autoWebKit && error instanceof WebKitUnavailableError) {
				failures.push({ backend: "webkit", reason: error.message });
				next = chromiumKind(params, session);
			} else if (kind.kind === "cmux" && autoCmux && error instanceof CmuxUnavailableError) {
				failures.push({ backend: "cmux", reason: error.message });
				next = ownBrowserKind(params, session);
			} else {
				throw error;
			}
			// A Tern, WebKit or cmux tab under this name whose window or host went away still holds the
			// name: release that one (and only that one) so the next browser's tab can take it.
			if (getTab(name)?.kindTag === kind.kind) {
				await releaseTab(name, { kill: false, timeoutMs }).catch(() => false);
			}
			logger.debug("Browser backend unavailable; falling back", {
				backend: kind.kind,
				next: next.kind,
				error: error.message,
			});
			kind = next;
		}
	}
}

/** `new_tab` only makes sense on a browser someone else drives, and never alongside a `target` to adopt. */
function assertNewTabApplies(params: BrowserParams, kind: BrowserKind): void {
	if (params.target !== undefined) {
		throw new ToolError(
			"browser open: new_tab and target are mutually exclusive — a fresh tab has no existing target to select.",
		);
	}
	if (kind.kind !== "relay" && kind.kind !== "connected") {
		throw new ToolError(
			`browser open: new_tab is only for user-driven browsers (app: "relay" or a CDP endpoint URL), not ${describeKind(kind)}; omp's own and spawned browsers already own their page.`,
		);
	}
}

/** Engine directories whose update failed in this process: their installed engine runs without another attempt. */
const failedWebKitUpdates = new Set<string>();

/**
 * Download omp's WebKit engine into its default location
 * ({@link webKitEngineToInstall}) before an open that needs it. A missing
 * engine is downloaded for an open with `app: "webkit"`, or one that otherwise
 * ends at managed Chromium (headless, or visible where released engines ship a
 * viewer) while Chromium itself would first be downloaded: with no browser
 * installed, omp's own engine comes before Chrome for Testing. An installed
 * engine is updated to ABKit's newest build before an open that would run it,
 * checked once per process. Like Chrome's download, it runs before the open's
 * deadline starts.
 *
 * Returns why an automatic download failed, for the open to go on to Chromium
 * saying so; for `app: "webkit"` a failed download throws. A failed update is
 * logged, and the open runs the engine already installed.
 */
async function installWebKitForOpen(
	session: ToolSession,
	params: BrowserParams,
	signal?: AbortSignal,
): Promise<string | undefined> {
	// The relay is the only browser: nothing omp runs itself needs installing (an explicit app throws at resolve).
	if (isRelayOnly()) return undefined;
	const explicit = params.app === "webkit";
	const pending = await webKitEngineToInstall({
		settingEnabled: explicit || cfgBrowserWebKit.get(session.settings),
		settingPath: cfgBrowserWebKitPath.get(session.settings),
	});
	if (pending === null) return undefined;
	const { engineDir } = pending;
	if (pending.installed) {
		if (failedWebKitUpdates.has(engineDir)) return undefined;
		if (!explicit && resolveBrowserKind(params, session).kind !== "webkit") return undefined;
		try {
			await untilAborted(signal, () => installWebKitEngine(engineDir));
		} catch (error) {
			if (signal?.aborted) throw error;
			failedWebKitUpdates.add(engineDir);
			logger.warn("Could not update omp's WebKit engine; running the installed one", {
				engineDir,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return undefined;
	}
	if (!explicit) {
		const kind = resolveBrowserKind(params, session);
		if (kind.kind !== "headless" || params.app === "chromium") return undefined;
		if (!kind.headless && !VIEWER_PLATFORMS.includes(process.platform)) return undefined;
		if (!(await chromiumNeedsDownload())) return undefined;
	}
	try {
		await untilAborted(signal, () => installWebKitEngine(engineDir));
		return undefined;
	} catch (error) {
		if (signal?.aborted) throw error;
		const cause = error instanceof Error ? error.message : String(error);
		if (explicit)
			throw new ToolError(`app: "webkit" requires omp's WebKit engine, which could not be downloaded: ${cause}`);
		return `its engine could not be downloaded: ${cause}`;
	}
}

async function openOnKind(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	kind: BrowserKind,
	timeoutMs: number,
	notes: readonly string[],
	context: EvalPreludeContext,
): Promise<AgentToolResult<unknown>> {
	const { signal } = context;
	const downloadsPath = params.downloads === undefined ? undefined : resolveToCwd(params.downloads, session.cwd);
	details.browser = kind.kind;

	// If a tab with this name already exists on a different browser kind, fail fast — caller must close first.
	const existing = getTab(name);
	if (existing && browserKey(existing.browser.kind) !== browserKey(kind)) {
		throw new ToolError(
			`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}, not ${describeKind(kind)}). Close it first, or reopen it with the app and headed it was opened with.`,
		);
	}
	// Chrome's extension debugger API exposes no Security domain, so the relay cannot honor the override.
	if (params.insecure && kind.kind === "relay") {
		throw new ToolError(
			'insecure is not supported through the Chrome relay: the extension debugger API does not expose the CDP Security domain. Pass app: "chromium" to use omp\'s Chromium instead.',
		);
	}
	// Chrome never lets an extension choose where downloads go. Refused here, before an existing tab is closed to reopen.
	if (params.downloads !== undefined && kind.kind === "relay") {
		throw new ToolError(
			"The omp browser relay cannot choose where Chrome saves downloads: open the tab without `downloads`, and tab.waitForDownload() and tab.downloads() report where Chrome saved each file.",
		);
	}

	// Policy: opening/navigating an OMP-owned tab is `navigate`; steering a
	// borrowed user tab to a URL is a mutation of the user's browser. A relay
	// open borrows only with `target` (otherwise omp opens its own tab); a
	// connected open borrows unless `new_tab` asks for an owned one; reuse
	// of a name keeps whatever that tab is. A bare adoption without URL only reads.
	const adopting = existing
		? existing.backend === "worker" && !existing.ownsPage
		: kind.kind === "relay"
			? params.target !== undefined
			: kind.kind === "connected" && !params.new_tab;
	gateBrowserAction(session, {
		surface: "browser",
		tier: adopting ? (params.url ? "mutate" : "read") : "navigate",
		action: adopting ? (params.url ? "browser.tab.goto" : "browser.tab.adopt") : "browser.tab.open",
		target: originOf(params.url),
		consequential: false,
		raw: false,
		// Ownership by construction: OMP creates the page (headless/spawned, a
		// relay open without a target, `new_tab`); anything else is the user's tab.
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
	// The step in flight when the deadline fires; a timeout names it.
	let stage = `launching or connecting to the browser (${describeKind(kind)})`;
	try {
		const browser = await untilAborted(openSignal, () =>
			acquireBrowser(kind, {
				cwd: session.cwd,
				viewport: params.viewport ? puppeteerViewport(params.viewport) : undefined,
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
		let relayNotice: string | null = null;
		try {
			// Read before the tab is acquired, so a cancel or the deadline landing during the read leaves no tab to close.
			if (kind.kind === "relay") {
				stage = "reading the relay extension version";
				relayNotice = await relayExtensionNotice(normalizeConnectedCdpUrl(kind.cdpUrl), openSignal);
				throwIfAborted(openSignal);
			}
			stage = `opening tab ${JSON.stringify(name)}`;
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
					params.insecure === true)
			) {
				stage = `closing tab ${JSON.stringify(name)} to reopen it`;
				await untilAborted(openSignal, () => releaseTab(name, { kill: false, timeoutMs }));
				stage = `opening tab ${JSON.stringify(name)}`;
			}
			result = await untilAborted(openSignal, () =>
				acquireTab(name, browser, {
					url: params.url,
					// Playwright's `networkidle` (no connections for 500 ms) is Puppeteer's `networkidle0`.
					waitUntil: params.wait_until === "networkidle" ? "networkidle0" : params.wait_until,
					viewport: params.viewport ? puppeteerViewport(params.viewport) : undefined,
					target: params.target,
					createTarget: params.new_tab,
					timeoutMs,
					deadlineStartMs: deadlineStart,
					dialogs: params.dialogs,
					allowedDomains: params.allowed_domains,
					initScripts,
					downloadsPath,
					userAgent: params.user_agent,
					insecure: params.insecure,
					visible: params.headed ?? !cfgBrowserHeadless.get(session.settings),
					signal: openSignal,
					ownerSessionId: tabOwnerId(session),
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
		if (userDrivenTab) details.owned = tab.ownsPage;
		const ownership = userDrivenTab ? (tab.ownsPage ? " (owned tab)" : " (adopted tab)") : "";
		// One line: the tab and its browser, where it landed unless that is the URL the call asked for, and its title.
		let opened = `${verb} tab ${JSON.stringify(name)} on ${describeBrowser(tab)}${ownership}`;
		if (!params.url || !sameAddress(params.url, url)) opened += `, at ${url}`;
		if (title) opened += `, titled ${JSON.stringify(title)}`;
		const lines = [
			opened,
			...(tab.backend === "tern" ? ternNotes(tab, params.viewport) : []),
			...notes,
			result.note,
			relayNotice,
		].filter((line): line is string => typeof line === "string");
		return toolResult(details).text(lines.join("\n")).done();
	} catch (error) {
		// Caller cancellation stays a ToolAbortError; the requested timeout
		// becomes a timeout ToolError naming the stalled step; anything else
		// passes through unchanged.
		if (signal?.aborted) throw error instanceof ToolAbortError ? error : new ToolAbortError();
		if (timeoutSignal.aborted) throw new ToolError(`Browser open timed out after ${timeoutMs}ms while ${stage}`);
		throw error;
	}
}

/**
 * The pages `target` can adopt, from the browser an open with `target` would drive: a Tern window's browser
 * blocks, the relay's Chrome pages, or the pages of an attached CDP endpoint. The relay and Tern are acquired as
 * an open does (the loopback relay starts on demand) and released again; a CDP endpoint answers its `/json` list.
 */
async function listTargets(
	session: ToolSession,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	// Resolve as an open naming a target: inside Tern that selects Tern even when the `browser.tern` setting is off.
	const kind = resolveBrowserKind({ ...params, target: params.target ?? "" }, session);
	if (kind.kind !== "tern" && kind.kind !== "relay" && kind.kind !== "connected") {
		throw new ToolError(
			`No pages to adopt here (the browser would be ${describeKind(kind)}): targets exist only inside a Tern pane (its browser blocks), with the omp relay (app: "relay" or the browser.relay setting), or at a CDP endpoint (app: "http://127.0.0.1:9222" or the browser.cdpUrl setting).`,
		);
	}
	details.browser = kind.kind;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const listSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		if (kind.kind === "connected") {
			const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
			const targets = await untilAborted(listSignal, () => listCdpTargets(cdpUrl, listSignal));
			details.value = targets;
			return toolResult(details)
				.text(describeCdpTargets(targets, `Pages at ${cdpUrl}`))
				.done();
		}
		const browser = await untilAborted(listSignal, () =>
			acquireBrowser(kind, { cwd: session.cwd, signal: listSignal }),
		);
		holdBrowser(browser);
		try {
			let targets: TernTarget[] | CdpTarget[];
			let text: string;
			if (kind.kind === "relay") {
				targets = await untilAborted(listSignal, () => listCdpTargets(kind.cdpUrl, listSignal));
				text = describeCdpTargets(targets, "Chrome pages via the relay");
			} else if ("tern" in browser) {
				const blocks = await listTernBlocks(browser.tern, { timeoutMs, signal: listSignal });
				const taken = ternBlocksTaken();
				targets = ternTargets(blocks, taken);
				text = describeTernTargets(blocks, taken);
			} else {
				throw new ToolError(`${describeKind(kind)} has no pages to adopt.`);
			}
			details.value = targets;
			return toolResult(details).text(text).done();
		} finally {
			await releaseBrowser(browser, { kill: false });
		}
	} catch (error) {
		if (signal?.aborted) throw error instanceof ToolAbortError ? error : new ToolAbortError();
		if (timeoutSignal.aborted) throw new ToolError(`Listing browser targets timed out after ${timeoutMs}ms`);
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
		const owned = tab === undefined || tab.backend !== "worker" || tab.ownsPage;
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
		// Only the caller's own tabs: another agent's tabs (a parent's, a sibling's)
		// are reaped when that agent disposes. No owner (SDK callers) keeps the
		// process-wide release.
		const ownerId = tabOwnerId(session);
		const count = await untilAborted(signal, () =>
			ownerId ? releaseTabsForOwner(ownerId, { kill, timeoutMs }) : releaseAllTabs({ kill, timeoutMs }),
		);
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
	const ownsTarget = tab !== undefined && (tab.backend !== "worker" || tab.ownsPage);
	const { displays, returnValue, screenshots } = await runInTab(name, {
		code,
		timeoutMs,
		signal: context.signal,
		session,
		waitsForDownload: params.action === "call" && params.chain?.[0]?.method === "waitForDownload",
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
		const alloc = await session.allocateOutputArtifact?.();
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, fullText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

function describeBrowser(tab: TabSession): string {
	if (tab.backend === "tern") {
		const adopted = tab.ternTab.adopted;
		if (!adopted) return `Tern browser picture-in-picture (pane ${tab.browser.kind.pane})`;
		return `the user's Tern browser block ${adopted.block} (${adopted.owner === null ? "docked" : "picture-in-picture"})`;
	}
	if (tab.backend === "webkit") {
		return tab.browser.webkit.isShown(tab.ternTab.block)
			? "omp's WebKit browser (in a window)"
			: "omp's headless WebKit browser";
	}
	const handle = tab.browser;
	if (!("browser" in handle)) {
		return `cmux browser (${handle.kind.surface ?? "split"})`;
	}
	switch (handle.kind.kind) {
		case "headless":
			return handle.kind.headless
				? `omp's headless Chromium${handle.sharedDaemon ? " (shared)" : ""}`
				: `omp's Chromium (in a window${handle.sharedDaemon ? ", shared" : ""})`;
		case "spawned":
			return `spawned ${handle.kind.path} (pid ${handle.pid ?? "?"})`;
		case "connected":
			return `connected ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
		case "relay":
			return `relay ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
	}
}

/** Where a Tern tab's page is for the user: whose block it is, whether it is on screen, and whether it got the size asked for. */
function ternNotes(tab: TernTabSession, requested: { width: number; height: number } | undefined): string[] {
	const notes: string[] = [];
	const adopted = tab.ternTab.adopted;
	// Tern sizes a PiP to fit its pane: the page may get less room than the open asked for.
	const actual = tab.info.viewport;
	if (
		!adopted &&
		requested &&
		actual &&
		(Math.abs(actual.width - requested.width) > 1 || Math.abs(actual.height - requested.height) > 1)
	) {
		notes.push(
			`Tern sized the picture-in-picture ${Math.round(actual.width)}x${Math.round(actual.height)}, not the requested ${requested.width}x${requested.height}; pass app: "own" for a page at exactly that size.`,
		);
	}
	if (adopted) {
		notes.push(
			`This is the user's own Tern browser block ${adopted.block} (${JSON.stringify(tab.info.title ?? "")} at ${tab.info.url}); closing the tab releases it to the user without closing it.`,
		);
	}
	if (tab.ternTab.shown === false) {
		notes.push(
			adopted
				? `Not on screen: the user is viewing another Tern tab or session. Block ${adopted.block} shows once they switch to the tab holding it; tell them where it is.`
				: `Not on screen: the user hid pictures in picture (⌃⌥⌘P), or this Tern shows them only in the tab holding this omp pane (block ${tab.browser.kind.pane}); tell them where it is.`,
		);
	}
	return notes;
}

function describeKind(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `managed Chromium (${kind.headless ? "headless" : "in a window"})`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "relay":
			return `relay:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.surface ?? "split"}`;
		case "tern":
			return `tern:pane ${kind.pane}`;
		case "webkit":
			return "omp's headless WebKit";
	}
}
