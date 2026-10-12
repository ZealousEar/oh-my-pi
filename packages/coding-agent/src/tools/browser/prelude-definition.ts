import type { ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { HostEvalPreludeDefinition } from "../../eval/preludes";
import relayGuidance from "../../prompts/system/browser-relay.md" with { type: "text" };
import userSessionGuidance from "../../prompts/system/browser-user-session.md" with { type: "text" };
import x11Guidance from "../../prompts/system/browser-x11.md" with { type: "text" };
import browserCoreDescription from "../../prompts/tools/browser-core.md" with { type: "text" };
import browserDescription from "../../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../../sdk";
import { redactUrlForLog } from "../../utils/redact-url";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import browserJavascript from "./prelude.js" with { type: "text" };
import browserPython from "./prelude.py" with { type: "text" };
import type { BrowserKind } from "./registry";
import { isLoopbackRelayUrl } from "./relay/kind";
import { cfgBrowserCdpUrl, cfgBrowserEnabled, cfgBrowserRelayUrl } from "./settings";

/**
 * The browser eval documentation. Its Linux X11 notes follow the browser's host: they reach agents on Linux, and
 * elsewhere when a configured browser (`browser.cdpUrl`, `browser.relayUrl`) is on another machine, which may be Linux.
 */
export function browserDocumentation(settings: Settings, platform: NodeJS.Platform = process.platform): string {
	return prompt.render(browserDescription, { x11Guidance: browserX11Guidance(settings, platform) });
}

function browserX11Guidance(settings: Settings, platform: NodeJS.Platform = process.platform): string | undefined {
	const remoteBrowser = [cfgBrowserCdpUrl.get(settings), cfgBrowserRelayUrl.get(settings)].some(
		url => typeof url === "string" && url.trim() !== "" && !isLoopbackRelayUrl(url.trim()),
	);
	return platform === "linux" || remoteBrowser ? x11Guidance.trim() : undefined;
}

/**
 * What the relay guidance tells the model: `only` when the relay is the session's only browser
 * (`PI_BROWSER_RELAY=only`), `default` when an open without `app` goes to the relay and `app: "auto"` to `fallback`.
 */
export type BrowserRelayGuidance = { mode: "only" } | { mode: "default"; fallback: BrowserKind };

/** Read-tier helpers and host actions; mirrors `CALL_TIERS` in ../browser.ts (the dispatch gate is authoritative). */
const BROWSER_READ_ACTIONS: Readonly<Record<string, true>> = {
	ariaSnapshot: true,
	attr: true,
	boundingBox: true,
	box: true,
	clearConsole: true,
	clearRequests: true,
	console: true,
	cookies: true,
	count: true,
	devices: true,
	dialog: true,
	diffScreenshot: true,
	downloads: true,
	errors: true,
	extract: true,
	frames: true,
	harStart: true,
	harStop: true,
	html: true,
	initScripts: true,
	isChecked: true,
	isEnabled: true,
	isHidden: true,
	isVisible: true,
	list: true,
	metrics: true,
	observe: true,
	pdf: true,
	probe: true,
	profileStart: true,
	profileStop: true,
	reactInspect: true,
	reactRenders: true,
	reactSuspense: true,
	reactTree: true,
	recordRestart: true,
	recordStart: true,
	recordStop: true,
	recording: true,
	requests: true,
	routes: true,
	saveState: true,
	screenshot: true,
	status: true,
	storage: true,
	styles: true,
	tabs: true,
	text: true,
	title: true,
	traceStart: true,
	traceStop: true,
	url: true,
	value: true,
	vitals: true,
	waitFor: true,
	waitForDownload: true,
	waitForSelector: true,
	waitForText: true,
	waitForUrl: true,
	webmcpEvents: true,
	webmcpList: true,
};
const BROWSER_NAVIGATION_ACTIONS: Readonly<Record<string, true>> = {
	back: true,
	close: true,
	focus: true,
	forward: true,
	goto: true,
	highlight: true,
	hover: true,
	mouseMove: true,
	open: true,
	pushState: true,
	reload: true,
	scroll: true,
	scrollIntoView: true,
	wheel: true,
};

/** Coarse wrapper tier; the lifecycle enforces the dispatch-specific automation capability. */
export function browserApproval(args: unknown): ToolApprovalDecision {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return "exec";
	const record = args as Record<string, unknown>;
	if (typeof record.action !== "string") return "exec";
	if (Object.hasOwn(BROWSER_READ_ACTIONS, record.action)) return "read";
	if (Object.hasOwn(BROWSER_NAVIGATION_ACTIONS, record.action)) return "write";
	if (record.action !== "call") return "exec";
	if (!Array.isArray(record.chain) || record.chain.length === 0) return "exec";
	const terminal = record.chain.at(-1);
	if (terminal === null || typeof terminal !== "object" || Array.isArray(terminal)) return "exec";
	const method = Reflect.get(terminal, "method");
	if (typeof method !== "string") return "exec";
	if (Object.hasOwn(BROWSER_READ_ACTIONS, method)) return "read";
	return Object.hasOwn(BROWSER_NAVIGATION_ACTIONS, method) ? "write" : "exec";
}

/** Build the browser eval facade after an eval runtime first requests preludes. */
export function createBrowserPreludeDefinition(
	session: ToolSession,
	host: Pick<HostEvalPreludeDefinition, "invoke" | "status"> & {
		/** Relay guidance to render; unset while an open without `app` stays out of the user's Chrome. */
		relay?: BrowserRelayGuidance;
	},
): HostEvalPreludeDefinition {
	return {
		name: "browser",
		// Read per use: the definition is built once per session, while the browser settings it follows can change.
		get documentation() {
			return browserDocumentation(session.settings);
		},
		firstCallDocumentation: browserCoreDescription,
		get guidance() {
			const mode = host.relay;
			const fallback = mode?.mode === "default" ? mode.fallback : undefined;
			const relay = mode
				? prompt.render(relayGuidance, {
						only: mode.mode === "only",
						// The block reaches the model provider: never echo userinfo or token params.
						cdpUrl: fallback?.kind === "connected" ? redactUrlForLog(fallback.cdpUrl) : undefined,
						tern: fallback?.kind === "tern",
						cmux: fallback?.kind === "cmux",
					})
				: undefined;
			return prompt.render(userSessionGuidance, { relay, x11: browserX11Guidance(session.settings) }).trim();
		},
		javascript: browserJavascript,
		python: browserPython,
		exports: ["browser"],
		approval: browserApproval,
		automationSurface: "browser",
		enabled: () => cfgBrowserEnabled.get(session.settings),
		invoke: host.invoke,
		status: host.status,
	};
}
