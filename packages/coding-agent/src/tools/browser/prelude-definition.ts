import type { ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import type { EvalPreludeDefinition } from "../../eval/preludes";
import browserDescription from "../../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../../sdk";
// @ts-expect-error Bun imports this declaration source as text instead of a TypeScript module.
import browserDeclarations from "./declarations.d.ts" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import browserJavascript from "./prelude.js" with { type: "text" };
import browserPython from "./prelude.py" with { type: "text" };

const BROWSER_READ_ACTIONS: Readonly<Record<string, true>> = {
	ariaSnapshot: true,
	boundingBox: true,
	extract: true,
	isHidden: true,
	isVisible: true,
	list: true,
	observe: true,
	probe: true,
	screenshot: true,
	status: true,
	title: true,
	url: true,
	waitFor: true,
	waitForSelector: true,
	waitForUrl: true,
};
const BROWSER_NAVIGATION_ACTIONS: Readonly<Record<string, true>> = {
	back: true,
	close: true,
	forward: true,
	goto: true,
	open: true,
	reload: true,
	scroll: true,
	scrollIntoView: true,
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
		enabled: () => session.settings.get("browser.enabled"),
		invoke: host.invoke,
		status: host.status,
	};
}
