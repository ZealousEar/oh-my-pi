import { describe, expect, it, vi } from "bun:test";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval";
import { invokeEvalPrelude } from "@oh-my-pi/pi-coding-agent/eval";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import {
	type AutomationAction,
	automationDeniedError,
	decideAutomationAction,
	deferAutomationDenialCleanup,
	fingerprintAutomationCode,
	getAutomationScopes,
} from "@oh-my-pi/pi-coding-agent/tools/automation-policy";
import { browserApproval } from "@oh-my-pi/pi-coding-agent/tools/browser/prelude-definition";

function makeAutomationSession(
	denyBrowser = false,
	actionOverrides: Partial<AutomationAction> = {},
	onAllowed?: (toolCallId: string, action: AutomationAction) => Promise<void>,
	onDenied?: (error: Error) => void,
) {
	const definitions: EvalPreludeDefinition[] = [];
	const session: ToolSession = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({
			"tools.approvalMode": "yolo",
			"tools.approval": denyBrowser ? { browser: "deny" } : {},
		}),
		getEvalPreludes: () => definitions,
	};
	const action: AutomationAction = {
		surface: "browser",
		tier: "mutate",
		action: "browser.tab.click",
		target: "https://example.test",
		consequential: false,
		raw: false,
		summary: "Click the current page",
		...actionOverrides,
	};
	const invoke = vi.fn(
		async (_parameters: unknown, context: { toolCallId: string }): Promise<AgentToolResult<unknown>> => {
			const dispatched = { ...action, invocationId: context.toolCallId };
			const verdict = decideAutomationAction(dispatched, { scopes: getAutomationScopes(session), now: Date.now() });
			if (verdict.verdict === "deny") {
				const error = automationDeniedError(verdict);
				onDenied?.(error);
				throw error;
			}
			await onAllowed?.(context.toolCallId, dispatched);
			return { content: [{ type: "text", text: "clicked" }] };
		},
	);
	const definition: EvalPreludeDefinition = {
		name: "browser",
		documentation: "fixture",
		javascript: "",
		python: "",
		exports: ["browser"],
		approval: "exec",
		automationSurface: "browser",
		invoke,
	};
	definitions.push(definition);
	return { session, invoke };
}

function interactive(choice: string, select = vi.fn(async () => choice)): AgentToolContext {
	return { hasUI: true, ui: { select } } as unknown as AgentToolContext;
}

describe("browser and computer approval boundary", () => {
	it("keeps browser and computer execution on prompt under yolo or generic user allow", () => {
		const browser = { name: "browser", approval: "exec" as const };
		const computer = { name: "computer", approval: "exec" as const };
		expect(resolveApproval(browser, {}, "yolo")).toMatchObject({ policy: "prompt", source: "tool" });
		expect(resolveApproval(computer, {}, "yolo")).toMatchObject({ policy: "prompt", source: "tool" });
		expect(resolveApproval(browser, {}, "yolo", { browser: "allow" })).toMatchObject({
			policy: "prompt",
			source: "tool",
		});
		expect(resolveApproval(computer, {}, "yolo", { computer: "allow" })).toMatchObject({
			policy: "prompt",
			source: "tool",
		});
		// Read-tier browser calls and other exec tools keep ordinary yolo semantics.
		expect(resolveApproval({ name: "browser", approval: "read" }, {}, "yolo")).toMatchObject({ policy: "allow" });
		expect(resolveApproval({ name: "bash", approval: "exec" }, {}, "yolo")).toMatchObject({ policy: "allow" });
	});

	it("classifies browser inspection, navigation, mutation, and raw calls by tier", () => {
		expect(browserApproval({ action: "call", chain: [{ method: "observe", args: [] }] })).toBe("read");
		expect(browserApproval({ action: "tabs" })).toBe("read");
		expect(browserApproval({ action: "call", chain: [{ method: "goto", args: ["https://example.test"] }] })).toBe(
			"write",
		);
		expect(browserApproval({ action: "call", chain: [{ method: "click", args: ["button"] }] })).toBe("exec");
		expect(browserApproval({ action: "run" })).toBe("exec");
		expect(browserApproval({ action: "task", goal: "x" })).toBe("exec");
		expect(browserApproval({ action: "call", chain: [] })).toBe("exec");
		// The wrapper tier feeds the approval seam: a mutation still prompts under yolo
		// until an exact scope exists, while an inspection never does.
		const click = {
			name: "browser",
			approval: browserApproval({ action: "call", chain: [{ method: "click", args: ["b"] }] }),
		};
		expect(resolveApproval(click, {}, "yolo")).toMatchObject({ policy: "prompt", source: "tool" });
		const observe = {
			name: "browser",
			approval: browserApproval({ action: "call", chain: [{ method: "observe", args: [] }] }),
		};
		expect(resolveApproval(observe, {}, "yolo")).toMatchObject({ policy: "allow" });
	});

	it("propagates AUTOMATION_DENIED unchanged when no interactive UI can grant the exact scope", async () => {
		const { session, invoke } = makeAutomationSession();
		await expect(
			invokeEvalPrelude(
				"browser",
				{},
				{ session, toolCallId: "headless", context: { hasUI: false } as AgentToolContext },
			),
		).rejects.toThrow(/^AUTOMATION_DENIED:/);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(getAutomationScopes(session)).toHaveLength(0);
	});

	it("runs deferred resource cleanup when the user denies an exact scope", async () => {
		let cleanups = 0;
		const { session, invoke } = makeAutomationSession(false, {}, undefined, error => {
			deferAutomationDenialCleanup(error, () => {
				cleanups++;
			});
		});
		await expect(
			invokeEvalPrelude("browser", {}, { session, toolCallId: "deny-cleanup", context: interactive("Deny") }),
		).rejects.toThrow(/^AUTOMATION_DENIED:/);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(cleanups).toBe(1);
		expect(getAutomationScopes(session)).toHaveLength(0);
	});

	it("settles deferred cleanup when the approved retry fails with another denial", async () => {
		let cleanups = 0;
		const { session, invoke } = makeAutomationSession(false, {}, async (_toolCallId, action) => {
			const verdict = decideAutomationAction(action, { scopes: [], now: Date.now() });
			if (verdict.verdict !== "deny") throw new Error("fixture expected a denial");
			const error = automationDeniedError(verdict);
			deferAutomationDenialCleanup(error, () => {
				cleanups++;
			});
			throw error;
		});
		await expect(
			invokeEvalPrelude(
				"browser",
				{},
				{
					session,
					toolCallId: "retry-denial-cleanup",
					context: interactive("Approve for this target+action (60 min)"),
				},
			),
		).rejects.toThrow(/^AUTOMATION_DENIED:/);
		expect(invoke).toHaveBeenCalledTimes(2);
		expect(cleanups).toBe(1);
	});

	it("grants only the denied exact scope for sixty minutes and retries once", async () => {
		const { session, invoke } = makeAutomationSession();
		const select = vi.fn(async () => "Approve for this target+action (60 min)");
		const result = await invokeEvalPrelude(
			"browser",
			{},
			{
				session,
				toolCallId: "interactive",
				context: interactive("Approve for this target+action (60 min)", select),
			},
		);
		expect(result.content).toEqual([{ type: "text", text: "clicked" }]);
		expect(invoke).toHaveBeenCalledTimes(2);
		expect(select).toHaveBeenCalledWith("Allow browser browser.tab.click on https://example.test?", [
			"Approve for this target+action (60 min)",
			"Approve once",
			"Deny",
		]);
		expect(getAutomationScopes(session)).toHaveLength(1);
	});

	it("states the whole-browser boundary and mints an exact-code capability for raw approval", async () => {
		const codeFingerprint = fingerprintAutomationCode("return document.title");
		const { session } = makeAutomationSession(false, {
			action: "browser.tab.run",
			raw: true,
			codeFingerprint,
			summary: "Run arbitrary browser code",
		});
		const select = vi.fn(async () => "Approve this exact code (60 min)");
		await invokeEvalPrelude(
			"browser",
			{},
			{
				session,
				toolCallId: "raw-interactive",
				context: interactive("Approve this exact code (60 min)", select),
			},
		);
		expect(select).toHaveBeenCalledWith(
			"Allow browser browser.tab.run? This arbitrary-code capability reaches the whole relay browser identity, not only https://example.test.",
			["Approve this exact code (60 min)", "Approve this exact capability once", "Deny"],
		);
		expect(getAutomationScopes(session)[0]?.codeFingerprints).toEqual([codeFingerprint]);
		expect(getAutomationScopes(session)[0]?.rawAccess).toBeUndefined();
	});

	it("revokes an approve-once scope after the single retry", async () => {
		const { session, invoke } = makeAutomationSession();
		await invokeEvalPrelude(
			"browser",
			{},
			{
				session,
				toolCallId: "once",
				context: interactive("Approve once"),
			},
		);
		expect(invoke).toHaveBeenCalledTimes(2);
		expect(getAutomationScopes(session)).toHaveLength(0);
	});

	it("keeps approve-once bound while the approved retry overlaps another invocation", async () => {
		const retryStarted = Promise.withResolvers<void>();
		const retryRelease = Promise.withResolvers<void>();
		const { session } = makeAutomationSession(false, {}, async toolCallId => {
			if (toolCallId !== "approved") return;
			retryStarted.resolve();
			await retryRelease.promise;
		});
		const approved = invokeEvalPrelude(
			"browser",
			{},
			{
				session,
				toolCallId: "approved",
				context: interactive("Approve once"),
			},
		);
		await retryStarted.promise;
		await expect(
			invokeEvalPrelude(
				"browser",
				{},
				{ session, toolCallId: "concurrent", context: { hasUI: false } as AgentToolContext },
			),
		).rejects.toThrow(/^AUTOMATION_DENIED:/);
		retryRelease.resolve();
		await expect(approved).resolves.toMatchObject({ content: [{ text: "clicked" }] });
		expect(getAutomationScopes(session)).toHaveLength(0);
	});

	it("preserves an explicit user denial before exact-scope prompting", async () => {
		const { session, invoke } = makeAutomationSession(true);
		const select = vi.fn(async () => "Approve once");
		await expect(
			invokeEvalPrelude(
				"browser",
				{},
				{
					session,
					toolCallId: "denied",
					context: { ...interactive("Approve once", select), settings: session.settings } as AgentToolContext,
				},
			),
		).rejects.toThrow(/blocked by user policy/);
		expect(invoke).not.toHaveBeenCalled();
		expect(select).not.toHaveBeenCalled();
	});
});
