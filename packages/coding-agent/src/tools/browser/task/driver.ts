/**
 * Page contact for `tab.task`.
 *
 * One `runInTab` call per step, each rendering the static worker runtime with a
 * JSON request. Going through the supervisor keeps the existing ownership,
 * unfreeze, cancellation, and per-call deadline behaviour instead of opening a
 * second path to the page.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ToolSession } from "../../index";
import { renderFunctionRun } from "../../run-code";
import { fingerprintAutomationValue, type AutomationAction } from "../../automation-policy";
import { getTab, runInTab } from "../tab-supervisor";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import observeScript from "./observe.js" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import taskRuntime from "./runtime.js" with { type: "text" };
import type {
	TaskActOutcome,
	TaskActRequest,
	TaskDriver,
	TaskFreshState,
	TaskObserveRequest,
	TaskProbe,
	TaskSnapshot,
} from "./types";

/** Scope names the tab runtime injects into an evaluated run. */
export const TASK_RUN_SCOPE: readonly string[] = ["tab", "page", "browser", "wait", "assert"];

export interface TabDriverDeps {
	name: string;
	session: ToolSession;
	invocationId?: string;
	/** Per-step ceiling; the loop additionally passes a signal derived from its deadline. */
	stepTimeoutMs: number;
	signal?: AbortSignal;
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
	if (!isRecord(value)) throw new ToolError("browser.task: " + what + " returned no result");
	return value;
}

function requireString(record: Record<string, unknown>, key: string, what: string): string {
	const value = record[key];
	if (typeof value !== "string") throw new ToolError("browser.task: " + what + " returned no " + key);
	return value;
}

/** Validate the reader's payload before the loop trusts it as an observation. */
export function parseSnapshot(value: unknown): TaskSnapshot {
	const record = requireRecord(value, "observe");
	if (record.status === "error") {
		throw new ToolError("browser.task: " + String(record.reason ?? "observation failed"));
	}
	const snapshot = requireRecord(record.snapshot, "observe");
	if (!Array.isArray(snapshot.controls) || !isRecord(snapshot.guards) || typeof snapshot.documentKey !== "string") {
		throw new ToolError("browser.task: observation payload is malformed");
	}
	requireString(snapshot, "url", "observe");
	return snapshot as unknown as TaskSnapshot;
}

function parseOutcome(value: unknown): TaskActOutcome {
	const record = requireRecord(value, "act");
	const status = record.status;
	if (status === "applied") {
		return {
			status,
			...(typeof record.detail === "string" ? { detail: record.detail } : {}),
			...(typeof record.settled === "string" ? { settled: record.settled } : {}),
		};
	}
	if (status === "rejected" || status === "stale" || status === "unknown") {
		return { status, reason: typeof record.reason === "string" ? record.reason : "no reason reported" };
	}
	throw new ToolError("browser.task: act returned unknown status " + String(status));
}

function currentTabOrigin(name: string): string {
	const url = getTab(name)?.info.url;
	if (!url || url === "about:blank") return "about:blank";
	try {
		const origin = new URL(url).origin;
		return origin === "null" ? "about:blank" : origin;
	} catch {
		return "about:blank";
	}
}

function readAutomation(name: string, action: string, summary: string, invocationId?: string): AutomationAction {
	return {
		surface: "browser",
		tier: "read",
		action,
		target: currentTabOrigin(name),
		consequential: false,
		raw: false,
		summary,
		...(invocationId ? { invocationId } : {}),
	};
}

function actAutomation(name: string, request: TaskActRequest, invocationId?: string): AutomationAction {
	const value = request.text ?? request.value;
	return {
		surface: "browser",
		tier: request.kind === "SCROLL" ? "navigate" : "mutate",
		action: `browser.task.${request.kind}`,
		target: currentTabOrigin(name),
		consequential: request.consequential === true,
		raw: false,
		summary: `Run browser task ${request.kind} in tab ${name}`,
		...(invocationId ? { invocationId } : {}),
		...(value === undefined ? {} : { valueFingerprint: fingerprintAutomationValue(value) }),
	};
}

/** Drive one named managed tab through the supervisor. */
export function createTabDriver(deps: TabDriverDeps): TaskDriver {
	const selectAllKey = process.platform === "darwin" ? "Meta" : "Control";
	const call = async (
		request: Record<string, unknown>,
		signal: AbortSignal | undefined,
		automation: AutomationAction,
	): Promise<unknown> => {
		const code = renderFunctionRun(taskRuntime, TASK_RUN_SCOPE, [request]);
		const combined = deps.signal && signal ? AbortSignal.any([deps.signal, signal]) : (signal ?? deps.signal);
		const result = await runInTab(deps.name, {
			code,
			timeoutMs: deps.stepTimeoutMs,
			...(combined ? { signal: combined } : {}),
			session: deps.session,
			automation,
			...(deps.invocationId ? { invocationId: deps.invocationId } : {}),
		});
		return result.returnValue;
	};
	return {
		async observe(request: TaskObserveRequest, signal?: AbortSignal): Promise<TaskSnapshot> {
			return parseSnapshot(
				await call(
					{ op: "observe", script: observeScript, ...(request.settle ? { settle: request.settle } : {}) },
					signal,
					readAutomation(deps.name, "browser.task.observe", `Observe task tab ${deps.name}`, deps.invocationId),
				),
			);
		},
		async fresh(node: number | undefined, signal?: AbortSignal): Promise<TaskFreshState> {
			const record = requireRecord(
				await call(
					{ op: "fresh", node: node ?? null },
					signal,
					readAutomation(
						deps.name,
						"browser.task.fresh",
						`Check task tab ${deps.name} freshness`,
						deps.invocationId,
					),
				),
				"fresh",
			);
			return {
				documentKey: typeof record.documentKey === "string" ? record.documentKey : null,
				guard: typeof record.guard === "string" ? record.guard : null,
			};
		},
		async act(request: TaskActRequest, signal?: AbortSignal): Promise<TaskActOutcome> {
			return parseOutcome(
				await call(
					{
						op: "act",
						kind: request.kind,
						selectAllKey,
						...(request.node === undefined ? {} : { node: request.node }),
						...(request.text === undefined ? {} : { text: request.text }),
						...(request.value === undefined ? {} : { value: request.value }),
						...(request.deltaY === undefined ? {} : { deltaY: request.deltaY }),
						...(request.settleMs === undefined ? {} : { settleMs: request.settleMs }),
						...(request.expect === undefined ? {} : { expect: request.expect }),
					},
					signal,
					actAutomation(deps.name, request, deps.invocationId),
				),
			);
		},
		async probe(selector: string | undefined, signal?: AbortSignal): Promise<TaskProbe> {
			const record = requireRecord(
				await call(
					{ op: "probe", ...(selector === undefined ? {} : { selector }) },
					signal,
					readAutomation(deps.name, "browser.task.probe", `Probe task tab ${deps.name}`, deps.invocationId),
				),
				"probe",
			);
			if (record.status === "error") throw new ToolError("browser.task: " + String(record.reason));
			return {
				url: requireString(record, "url", "probe"),
				selectorPresent: typeof record.selectorPresent === "boolean" ? record.selectorPresent : null,
			};
		},
	};
}
