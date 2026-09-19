import { afterAll, describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Answer, ChoiceAnswer, ChoiceQuestion, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { grantAutomationScope } from "@oh-my-pi/pi-coding-agent/tools/automation-policy";
import type { ResolvedJudge } from "@oh-my-pi/pi-coding-agent/judgment/index";
import { invokeEvalPrelude, type EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { getTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { createTabDriver } from "@oh-my-pi/pi-coding-agent/tools/browser/task/driver";
import { runBrowserTask } from "@oh-my-pi/pi-coding-agent/tools/browser/task/loop";
import { executeBrowserTask } from "@oh-my-pi/pi-coding-agent/tools/browser/task/run";
import type {
	TaskDriver,
	TaskObserveRequest,
	TaskOperation,
	TaskSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const FIXTURE_DIR = import.meta.dir + "/../fixtures/browser-task";

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.relay": false,
			"browser.cmux": false,
		}),
	};
}

function serveFixture() {
	return Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/app.js") {
				return new Response(Bun.file(FIXTURE_DIR + "/app.js"), {
					headers: { "content-type": "text/javascript" },
				});
			}
			const file = path.startsWith("/done") ? "/done.html" : "/fixture.html";
			return new Response(Bun.file(FIXTURE_DIR + file), { headers: { "content-type": "text/html" } });
		},
	});
}

interface Plan {
	operation: TaskOperation;
	/** Matched against the candidate rubric, so ids never leak into the script. */
	label?: string;
}

/**
 * Deterministic judge that resolves a scripted plan to a real candidate id by
 * label. Keeps the fixture script readable while still exercising the loop's
 * id-only contract.
 */
class LabelJudge implements ResolvedJudge {
	readonly kind = "online" as const;
	readonly label = "label-scripted";
	calls = 0;

	constructor(private readonly plans: readonly Plan[]) {}

	judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		const plan = this.plans[Math.min(this.calls, this.plans.length - 1)];
		if (!plan) throw new Error("label judge ran out of plans");
		this.calls++;
		const answers: Record<string, Answer> = {};
		for (const id in request.questions) {
			const question = request.questions[id];
			if (question?.type === "noul") {
				answers[id] = { type: "noul", noul: 0.95 };
				continue;
			}
			if (question?.type !== "choice") throw new Error("unexpected question type");
			// Only the head named by the chosen operation can cause an action;
			// the others are answered but never validated by the loop.
			const owned = id === plan.operation.toLowerCase() + "_target";
			const choice =
				id === "operation"
					? plan.operation
					: owned
						? pickByLabel(question, plan)
						: (Object.keys(question.criteria)[0] ?? "");
			answers[id] = oneHot(question, choice);
		}
		const result = { api: "scripted", provider: "fake", model: "label-judge", answers, usage: tokenUsage(9, 2) };
		return Promise.resolve(result as unknown as JudgmentResult<Q>);
	}
}

function pickByLabel(question: ChoiceQuestion, plan: Plan): string {
	const wanted = plan.label;
	if (wanted === undefined) return Object.keys(question.criteria)[0] ?? "";
	for (const [key, rubric] of Object.entries(question.criteria)) {
		if (typeof rubric === "string" && rubric.includes(wanted)) return key;
	}
	throw new Error(
		"fixture script asked for " + JSON.stringify(wanted) + " but only saw " + JSON.stringify(question.criteria),
	);
}

function oneHot(question: ChoiceQuestion, choice: string): ChoiceAnswer {
	const probabilities: Record<string, number> = {};
	for (const key in question.criteria) probabilities[key] = key === choice ? 1 : 0;
	return { type: "choice", choice, probabilities, confidence: 1 };
}

const openTabs: Array<{ session: ToolSession; name: string }> = [];

async function openFixtureTab(session: ToolSession, url: string): Promise<string> {
	const prelude = createBrowserPrelude(session);
	const name = "task-fixture-" + crypto.randomUUID();
	await prelude.invoke({ action: "open", name, url }, { session, toolCallId: "open-" + name });
	openTabs.push({ session, name });
	return name;
}

async function reloadFixtureTab(session: ToolSession, name: string, url: string): Promise<void> {
	const prelude = createBrowserPrelude(session);
	await prelude.invoke(
		{ action: "call", name, chain: [{ method: "goto", args: [url] }] },
		{ session, toolCallId: "reload-" + crypto.randomUUID() },
	);
}

async function runTaskApprovalFixture(options: {
	persist: boolean;
	choice: "Approve for this target+action (60 min)" | "Approve once";
}): Promise<{ clicks: number; retainedAfterTask: boolean }> {
	let clicks = 0;
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === "/hit") {
				clicks++;
				return new Response("ok");
			}
			return new Response(
				`<!doctype html><button id="run" onclick="fetch('/hit',{method:'POST'}).then(()=>this.id='done')">Run action</button>`,
				{ headers: { "content-type": "text/html" } },
			);
		},
	});
	const name = "task-approval-" + crypto.randomUUID();
	const definitions: EvalPreludeDefinition[] = [];
	const session: ToolSession = {
		...makeSession(),
		modelRegistry: {} as NonNullable<ToolSession["modelRegistry"]>,
		getEvalPreludes: () => definitions,
	};
	const shipped = createBrowserPrelude(session);
	try {
		await shipped.invoke(
			{ action: "open", name, url: server.url.href, ...(options.persist ? { persist: true } : {}) },
			{ session, toolCallId: "task-approval-open" },
		);
		const definition: EvalPreludeDefinition = {
			name: "task-approval-fixture",
			documentation: "fixture",
			javascript: "",
			python: "",
			exports: ["taskApprovalFixture"],
			approval: "read",
			automationSurface: "browser",
			async invoke(_parameters, context) {
				const result = await executeBrowserTask(session, {
					name,
					invocationId: context.toolCallId,
					goal: "click Run action",
					expect: { selector: "#done" },
					deadlineMs: 30_000,
					maxActionsDefault: 3,
					maxCallsDefault: 6,
					judge: new LabelJudge([{ operation: "CLICK", label: "Run action" }, { operation: "DONE" }]),
				});
				return { content: [{ type: "text", text: result.status }] };
			},
		};
		definitions.push(definition);
		const result = await invokeEvalPrelude(
			definition.name,
			{},
			{
				session,
				toolCallId: "task-approval-invocation",
				context: {
					hasUI: true,
					ui: { select: async () => options.choice },
				} as unknown as AgentToolContext,
			},
		);
		expect(result.content).toEqual([{ type: "text", text: "done" }]);
		return { clicks, retainedAfterTask: getTab(name) !== undefined };
	} finally {
		await shipped
			.invoke({ action: "close", name }, { session, toolCallId: "task-approval-close" })
			.catch(() => undefined);
		await server.stop(true);
	}
}

afterAll(async () => {
	const prelude = openTabs[0] ? createBrowserPrelude(openTabs[0].session) : undefined;
	for (const tab of openTabs) {
		await prelude
			?.invoke({ action: "close", name: tab.name }, { session: tab.session, toolCallId: "close-" + tab.name })
			.catch(() => undefined);
	}
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser task against a real page", () => {
	it("reads every visible control atomically with state, occlusion, and options", async () => {
		const server = serveFixture();
		try {
			const session = makeSession();
			const name = await openFixtureTab(session, server.url.href);
			const driver = createTabDriver({ name, session, stepTimeoutMs: 20_000 });
			const snapshot: TaskSnapshot = await driver.observe({});

			const byLabel = (label: string) => snapshot.controls.find(control => control.label === label);
			expect(byLabel("Full name")).toMatchObject({ role: "textbox", enabled: true, occluded: false });
			expect(byLabel("City")).toMatchObject({ role: "combobox", expanded: false });
			expect(byLabel("Room type")).toMatchObject({ role: "select" });
			expect(byLabel("Room type")?.options?.map(option => option.value)).toEqual(["", "single", "double", "suite"]);
			expect(byLabel("Email me offers")).toMatchObject({ role: "checkbox", checked: false });
			expect(byLabel("Apply voucher")).toMatchObject({ enabled: false });
			expect(byLabel("Covered action")).toMatchObject({ occluded: true });
			// display:none controls are not readable at all.
			expect(byLabel("Secret action")).toBeUndefined();
			expect(snapshot.hiddenControls).toBeGreaterThan(0);
			expect(snapshot.documentKey.length).toBeGreaterThan(0);
			expect(snapshot.guards[String(byLabel("Full name")?.node)]).toBeString();
			expect(snapshot.scrollable.down).toBe(true);
			expect(snapshot.unsupported).toEqual([]);
		} finally {
			await server.stop(true);
		}
	}, 60_000);

	it("denies a real-page task mutation without an exact origin/action grant", async () => {
		const server = serveFixture();
		try {
			const session = makeSession();
			const name = await openFixtureTab(session, server.url.href);
			const driver = createTabDriver({ name, session, stepTimeoutMs: 20_000 });
			const snapshot = await driver.observe({});
			const control = snapshot.controls.find(candidate => candidate.label === "Full name");
			if (!control || snapshot.documentKey === null) throw new Error("fixture text field was not observed");
			await expect(
				driver.act({
					kind: "TYPE_TEXT",
					node: control.node,
					text: "Denied value",
					expect: {
						documentKey: snapshot.documentKey,
						guard: snapshot.guards[String(control.node)] ?? null,
					},
				}),
			).rejects.toThrow(/^AUTOMATION_DENIED:/);
		} finally {
			await server.stop(true);
		}
	}, 60_000);

	it("fills, autocompletes, selects, submits, and verifies the navigation it caused", async () => {
		const server = serveFixture();
		try {
			const session = makeSession();
			grantAutomationScope(session, {
				surface: "browser",
				targets: [server.url.origin],
				actions: ["browser.task.TYPE_TEXT", "browser.task.CLICK", "browser.task.SELECT"],
				consequential: true,
				task: "browser task fixture",
			});
			const name = await openFixtureTab(session, server.url.href);
			const driver = createTabDriver({ name, session, stepTimeoutMs: 20_000 });
			const result = await runBrowserTask({
				tabName: name,
				options: {
					goal: "book a suite in Lisbon for Ada Lovelace and confirm it",
					values: { "Full name": "Ada Lovelace", City: "Lis" },
					expect: { urlIncludes: "/done", textIncludes: "Booked", selector: "#receipt" },
					allowConsequential: true,
				},
				driver,
				judge: new LabelJudge([
					{ operation: "TYPE_TEXT", label: "Full name" },
					{ operation: "TYPE_TEXT", label: "City" },
					{ operation: "CLICK", label: "Lisbon" },
					{ operation: "SELECT", label: "Suite" },
					{ operation: "CLICK", label: "Email me offers" },
					{ operation: "CLICK", label: "Confirm reservation" },
					{ operation: "DONE" },
				]),
				budget: { maxCalls: 20, maxActions: 12, deadlineAt: Date.now() + 50_000 },
			});

			expect(result.steps.map(step => step.operation)).toEqual([
				"TYPE_TEXT",
				"TYPE_TEXT",
				"CLICK",
				"SELECT",
				"CLICK",
				"CLICK",
				"DONE",
			]);
			expect(result.steps.filter(step => step.outcome !== "applied")).toEqual([]);
			expect(result.status).toBe("done");
			expect(result.verification.verified).toBe(true);
			expect(result.budget.actions).toBe(6);
		} finally {
			await server.stop(true);
		}
	}, 90_000);

	it("detects a control replaced after the observation as stale and sends no input", async () => {
		const server = serveFixture();
		try {
			const session = makeSession();
			grantAutomationScope(session, {
				surface: "browser",
				targets: [server.url.origin],
				actions: ["browser.task.CLICK"],
				consequential: false,
				task: "stale-control fixture",
			});
			const name = await openFixtureTab(session, server.url.href);
			const real = createTabDriver({ name, session, stepTimeoutMs: 20_000 });
			let replaced = false;
			const driver: TaskDriver = {
				fresh: node => real.fresh(node),
				act: request => real.act(request),
				probe: selector => real.probe(selector),
				async observe(request: TaskObserveRequest): Promise<TaskSnapshot> {
					const snapshot = await real.observe(request);
					if (!replaced) {
						replaced = true;
						// Navigate between observation and decision so the old
						// document/control guard is stale without raw page code.
						await reloadFixtureTab(session, name, server.url.href);
					}
					return snapshot;
				},
			};
			const result = await runBrowserTask({
				tabName: name,
				options: { goal: "click the original label" },
				driver,
				judge: new LabelJudge([{ operation: "CLICK", label: "Original label" }, { operation: "BLOCKED" }]),
				budget: { maxCalls: 10, maxActions: 5, deadlineAt: Date.now() + 40_000 },
			});
			expect(result.steps[0]).toMatchObject({ operation: "CLICK", outcome: "stale" });
			expect(result.observationRevisions).toBeGreaterThan(1);
		} finally {
			await server.stop(true);
		}
	}, 90_000);

	it("keeps a default non-persisted task tab through 60-minute approval, retries once, and releases it", async () => {
		const result = await runTaskApprovalFixture({
			persist: false,
			choice: "Approve for this target+action (60 min)",
		});
		expect(result).toEqual({ clicks: 1, retainedAfterTask: false });
	}, 90_000);

	it("threads approve-once identity through a persisted browser task retry", async () => {
		const result = await runTaskApprovalFixture({ persist: true, choice: "Approve once" });
		expect(result).toEqual({ clicks: 1, retainedAfterTask: true });
	}, 90_000);
});
