import type { ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import type { EvalPreludeDefinition } from "../../eval/preludes";
import browserDescription from "../../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../../sdk";
// @ts-expect-error Bun imports this declaration source as text instead of a TypeScript module.
import browserDeclarations from "./declarations.d.ts" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import browserJavascript from "./prelude.js" with { type: "text" };
import browserPython from "./prelude.py" with { type: "text" };

import { cfgBrowserEnabled } from "./settings";

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
	host: Pick<EvalPreludeDefinition, "invoke" | "status">,
): EvalPreludeDefinition {
	return {
		name: "browser",
		documentation: browserDescription,
		javascript: browserJavascript,
		python: browserPython,
		exports: ["browser"],
		codeModeDeclarations: browserDeclarations,
		approval: browserApproval,
		automationSurface: "browser",
		enabled: () => cfgBrowserEnabled.get(session.settings),
		invoke: host.invoke,
		status: host.status,
	};
}
