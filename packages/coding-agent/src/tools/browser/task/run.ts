/**
 * Host entry for `tab.task`: policy, judge resolution, budget, and lifecycle
 * around the decision loop.
 *
 * Refuses up front what it cannot do safely — a cmux tab (no Puppeteer page),
 * and a relay/CDP tab that was adopted as the user's visible foreground tab.
 * An autonomous task on a user-driven browser needs a tab that is omp's to
 * drive: one created with `app.new_tab` (owned, closed on release) or one
 * selected with an explicit `app.target`. Failing closed beats driving the
 * user's live session.
 */
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { logger } from "@oh-my-pi/pi-utils";
import type { DecisionJudge, LoopBudget } from "../../../judgment/decision";
import { journalJudgmentUsage, resolveJudge } from "../../../judgment/index";
import { deferAutomationDenialCleanup } from "../../automation-policy";
import type { ToolSession } from "../../index";
import { getTab, releaseTab } from "../tab-supervisor";
import { createTabDriver } from "./driver";
import { runBrowserTask } from "./loop";
import type { TextHelperDeps } from "./text-value";
import type { BrowserTaskOptions, BrowserTaskResult } from "./types";

/** Per-step page-contact ceiling; the loop tightens it to the remaining deadline. */
const STEP_TIMEOUT_MS = 60_000;
const TAB_RELEASE_TIMEOUT_MS = 5_000;

export interface ExecuteTaskParams extends BrowserTaskOptions {
	name: string;
	invocationId?: string;
	/** Deterministic internal judge override used by local fixtures. */
	judge?: DecisionJudge;
	/** Absolute wall-clock budget for the whole task, in milliseconds. */
	deadlineMs: number;
	maxActionsDefault: number;
	maxCallsDefault: number;
	signal?: AbortSignal;
}

/**
 * Bounds for one task. A per-call `maxCalls`/`maxActions` can only tighten
 * the configured default, never exceed it; the deadline is absolute.
 */
export function taskBudget(
	params: Pick<
		ExecuteTaskParams,
		"maxCalls" | "maxActions" | "maxCallsDefault" | "maxActionsDefault" | "deadlineMs" | "signal"
	>,
	now: number = Date.now(),
): LoopBudget {
	return {
		maxCalls: Math.max(1, Math.min(params.maxCalls ?? params.maxCallsDefault, params.maxCallsDefault)),
		maxActions: Math.max(1, Math.min(params.maxActions ?? params.maxActionsDefault, params.maxActionsDefault)),
		deadlineAt: now + Math.max(1_000, params.deadlineMs),
		...(params.signal ? { signal: params.signal } : {}),
	};
}

export async function executeBrowserTask(session: ToolSession, params: ExecuteTaskParams): Promise<BrowserTaskResult> {
	const tab = getTab(params.name);
	if (!tab || tab.state === "dead") {
		throw new ToolError(
			"browser.task: tab " +
				JSON.stringify(params.name) +
				" is not open. Open it first with browser.open({ name, url }).",
		);
	}
	if (tab.backend !== "worker") {
		throw new ToolError("browser.task: the cmux browser backend has no Puppeteer page and cannot run a task.");
	}
	if ((tab.kindTag === "relay" || tab.kindTag === "connected") && !tab.ownsTarget && !tab.activateForScreenshot) {
		throw new ToolError(
			"browser.task refuses to drive the user's visible tab: " +
				JSON.stringify(params.name) +
				" adopted the foreground tab of a relay/CDP browser. Reopen it with app.new_tab: true for a dedicated omp-owned tab, " +
				"or app.target naming a tab the user handed over.",
		);
	}

	const registry = session.modelRegistry;
	if (!registry) {
		throw new ToolError("browser.task: no model registry is available in this session to reach a judgment backend.");
	}
	const sessionId = session.getSessionId?.() ?? undefined;
	// Every judgment and helper completion lands on the session cost ledger.
	const onUsage = journalJudgmentUsage(session.sessionManager, "browser-task");
	const activeModel = session.getActiveModel?.();
	const judge: DecisionJudge =
		params.judge ??
		resolveJudge({
			settings: session.settings,
			registry,
			...(sessionId === undefined ? {} : { sessionId }),
			...(activeModel === undefined ? {} : { sessionModel: activeModel }),
			...(onUsage === undefined ? {} : { onUsage }),
		});
	const text: TextHelperDeps = {
		settings: session.settings,
		registry,
		...(sessionId === undefined ? {} : { sessionId }),
		...(onUsage === undefined ? {} : { onUsage }),
	};

	const budget = taskBudget(params);
	const stepTimeoutMs = Math.min(STEP_TIMEOUT_MS, Math.max(5_000, params.deadlineMs));
	const driver = createTabDriver({
		name: params.name,
		session,
		...(params.invocationId ? { invocationId: params.invocationId } : {}),
		stepTimeoutMs,
		...(params.signal ? { signal: params.signal } : {}),
	});

	let releaseDeferred = false;
	const release = async (): Promise<void> => {
		// Do not let a delayed approval cleanup close a replacement that reused
		// the same logical name while the user was deciding.
		if (getTab(params.name) !== tab) return;
		await releaseTab(params.name, { timeoutMs: TAB_RELEASE_TIMEOUT_MS }).catch((error: unknown) => {
			logger.debug("browser.task: releasing the task tab failed", {
				name: params.name,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		});
	};
	try {
		return await runBrowserTask({
			tabName: params.name,
			options: {
				goal: params.goal,
				...(params.values === undefined ? {} : { values: params.values }),
				...(params.expect === undefined ? {} : { expect: params.expect }),
				...(params.allowConsequential === undefined ? {} : { allowConsequential: params.allowConsequential }),
			},
			driver,
			judge,
			budget,
			text,
			stepTimeoutMs,
		});
	} catch (error) {
		if (!tab.persist) releaseDeferred = deferAutomationDenialCleanup(error, release);
		throw error;
	} finally {
		// Preserve a non-persisted tab only while the outer eval boundary asks
		// for authorization and retries. Deny, abort, retry success, and retry
		// failure all settle the attached cleanup.
		if (!tab.persist && !releaseDeferred) await release();
	}
}

/** One-screen summary of a task result for the Eval transcript. */
export function renderTaskResult(result: BrowserTaskResult): string {
	const lines: string[] = [
		"task " + result.status + (result.reason ? ": " + result.reason : ""),
		"goal: " + result.goal,
	];
	for (const step of result.steps) {
		lines.push(
			"  " +
				step.n +
				". " +
				step.operation +
				(step.target ? " " + step.target : "") +
				" " +
				JSON.stringify(step.label) +
				" -> " +
				step.outcome +
				(step.pageChanged === null ? "" : step.pageChanged ? " (page changed)" : " (no change)") +
				" " +
				step.ms +
				"ms" +
				(step.reason ? " — " + step.reason : ""),
		);
	}
	lines.push(
		"verification: " +
			String(result.verification.verified) +
			" via " +
			result.verification.method +
			(result.verification.detail ? " — " + result.verification.detail : ""),
	);
	lines.push(
		"budget: " +
			result.budget.calls +
			"/" +
			result.budget.maxCalls +
			" calls, " +
			result.budget.actions +
			"/" +
			result.budget.maxActions +
			" actions, " +
			result.budget.elapsedMs +
			"ms; observations " +
			result.observationRevisions,
	);
	lines.push(
		"backend: " +
			result.backend.kind +
			" (" +
			result.backend.label +
			(result.backend.model ? ", " + result.backend.model : "") +
			(result.backend.distribution ? ", " + result.backend.distribution + " distribution" : "") +
			(result.backend.fallback ? ", fell back from " + result.backend.fallback : "") +
			")",
	);
	if (result.candidatesTruncated) lines.push("candidates: " + (result.candidateFallback ?? "windowed"));
	if (result.unsupported?.length) lines.push("unsupported widgets: " + result.unsupported.join(", "));
	return lines.join("\n");
}
