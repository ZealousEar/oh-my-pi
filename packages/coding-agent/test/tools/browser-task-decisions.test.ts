import { afterEach, describe, expect, it } from "bun:test";
import type { Answer, ChoiceAnswer, JsonValue, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { type LoopBudget, LoopMeter } from "@oh-my-pi/pi-coding-agent/judgment/decision";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { getTabsMapForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { executeBrowserTask, taskBudget } from "@oh-my-pi/pi-coding-agent/tools/browser/task/run";
import type { TabSession } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ResolvedJudge } from "@oh-my-pi/pi-coding-agent/judgment/index";
import { deriveCandidates, snapshotDigest } from "@oh-my-pi/pi-coding-agent/tools/browser/task/candidates";
import { runBrowserTask } from "@oh-my-pi/pi-coding-agent/tools/browser/task/loop";
import {
	groundHelperValue,
	matchSuppliedValue,
	resolveTextValue,
	validateTextValue,
} from "@oh-my-pi/pi-coding-agent/tools/browser/task/text-value";
import type {
	TaskActOutcome,
	TaskActRequest,
	TaskControl,
	TaskDriver,
	TaskFreshState,
	TaskObserveRequest,
	TaskOperation,
	TaskProbe,
	TaskSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/task/types";

function control(partial: Partial<TaskControl> & { node: number; role: string; label: string }): TaskControl {
	return {
		enabled: true,
		multiline: false,
		bbox: { x: 10, y: 10, w: 80, h: 20 },
		inViewport: true,
		occluded: false,
		...partial,
	};
}

function snapshotOf(controls: TaskControl[], extra: Partial<TaskSnapshot> = {}): TaskSnapshot {
	const guards: Record<string, string | null> = {};
	for (const item of controls) guards[String(item.node)] = "guard-" + item.node + "-" + item.label;
	return {
		url: "https://fixture.test/form",
		title: "Form",
		text: "Reservation form",
		viewport: { width: 800, height: 600 },
		scroll: { x: 0, y: 0, height: 600 },
		scrollable: { down: false, up: false },
		controls,
		guards,
		documentKey: "doc-0",
		hiddenControls: 0,
		omittedControls: 0,
		readyState: "complete",
		unsupported: [],
		...extra,
	};
}

interface Plan {
	operation: TaskOperation;
	/** Passed through unchanged so an unknown id can be exercised. */
	target?: string;
}

function oneHot(criteria: Record<string, string | null>, choice: string): ChoiceAnswer {
	const probabilities: Record<string, number> = {};
	for (const key in criteria) probabilities[key] = key === choice ? 1 : 0;
	return { type: "choice", choice, probabilities, confidence: 1 };
}

/**
 * Deterministic in-memory judge: one-hot answers from a scripted plan list. A
 * plan whose operation the loop did not offer is skipped, so a script can
 * insist on an action and still end cleanly when the loop withholds it.
 */
class ScriptedJudge implements ResolvedJudge {
	readonly kind = "online" as const;
	readonly label = "scripted";
	calls = 0;
	readonly seen: Questions[] = [];
	readonly states: JsonValue[] = [];
	#next = 0;

	constructor(
		private readonly plans: readonly Plan[],
		private readonly goalSatisfied = 0.9,
	) {}

	judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		this.calls++;
		this.seen.push(request.questions);
		this.states.push(request.state);
		const operation = request.questions.operation;
		const offered = operation?.type === "choice" ? Object.keys(operation.criteria) : [];
		let plan = this.plans[Math.min(this.#next, this.plans.length - 1)];
		while (plan && offered.length > 0 && !offered.includes(plan.operation) && this.#next < this.plans.length - 1) {
			plan = this.plans[++this.#next];
		}
		if (!plan) throw new Error("scripted judge ran out of plans");
		this.#next++;
		const answers: Record<string, Answer> = {};
		for (const id in request.questions) {
			const question = request.questions[id];
			if (question?.type === "noul") {
				answers[id] = { type: "noul", noul: this.goalSatisfied };
				continue;
			}
			if (question?.type !== "choice") throw new Error("unexpected question type");
			const keys = Object.keys(question.criteria);
			const choice = id === "operation" ? plan.operation : (plan.target ?? keys[0] ?? "");
			answers[id] = oneHot(question.criteria, choice);
		}
		const result = {
			api: "scripted",
			provider: "fake",
			model: "fake-judge",
			answers,
			usage: tokenUsage(12, 3),
		};
		return Promise.resolve(result as unknown as JudgmentResult<Q>);
	}
}

/** Scripted page: a queue of observations and act outcomes, no browser. */
class FakeDriver implements TaskDriver {
	observeCount = 0;
	readonly acts: TaskActRequest[] = [];
	freshOverride?: TaskFreshState;
	/** Runs during the freshness check: the page work a decision waits on. */
	onFresh?: () => void;
	selectorPresent: boolean | null = null;

	constructor(
		private readonly snapshots: readonly TaskSnapshot[],
		private readonly outcomes: TaskActOutcome[] = [],
	) {}

	current(): TaskSnapshot {
		const index = Math.min(Math.max(this.observeCount - 1, 0), this.snapshots.length - 1);
		return this.snapshots[index] as TaskSnapshot;
	}

	observe(_request: TaskObserveRequest): Promise<TaskSnapshot> {
		const index = Math.min(this.observeCount, this.snapshots.length - 1);
		this.observeCount++;
		return Promise.resolve(this.snapshots[index] as TaskSnapshot);
	}

	fresh(node: number | undefined): Promise<TaskFreshState> {
		this.onFresh?.();
		if (this.freshOverride) return Promise.resolve(this.freshOverride);
		const snapshot = this.current();
		return Promise.resolve({
			documentKey: snapshot.documentKey,
			guard: node === undefined ? null : (snapshot.guards[String(node)] ?? null),
		});
	}

	act(request: TaskActRequest): Promise<TaskActOutcome> {
		this.acts.push(request);
		return Promise.resolve(this.outcomes.shift() ?? { status: "applied" });
	}

	probe(_selector?: string): Promise<TaskProbe> {
		return Promise.resolve({ url: this.current().url, selectorPresent: this.selectorPresent });
	}
}

function budgetOf(extra: Partial<LoopBudget> = {}): LoopBudget {
	return { maxCalls: 20, maxActions: 10, deadlineAt: Date.now() + 30_000, ...extra };
}

describe("browser task candidate derivation", () => {
	it("offers only actionable controls and describes the rest", () => {
		const set = deriveCandidates(
			snapshotOf([
				control({ node: 1, role: "button", label: "Continue" }),
				control({ node: 2, role: "button", label: "Apply voucher", enabled: false }),
				control({ node: 3, role: "button", label: "Covered action", occluded: true }),
				control({ node: 4, role: "textbox", label: "Full name" }),
			]),
		);
		expect(set.tables.get("CLICK")?.map(candidate => candidate.label)).toEqual(["Continue"]);
		expect(set.tables.get("TYPE_TEXT")?.map(candidate => candidate.label)).toEqual(["Full name"]);
		const rows = set.elements as Array<Record<string, unknown>>;
		expect(rows.find(row => row.label === "Apply voucher")).toMatchObject({ note: "disabled" });
		expect(rows.find(row => row.label === "Covered action")).toMatchObject({
			note: "covered by another element",
		});
		expect(rows.filter(row => typeof row.id === "string")).toHaveLength(2);
		expect(set.truncated).toBe(false);
	});

	it("expands a native select into one candidate per enabled option", () => {
		const set = deriveCandidates(
			snapshotOf([
				control({
					node: 1,
					role: "select",
					label: "Room type",
					value: "",
					options: [
						{ value: "", label: "Choose", disabled: true, selected: true },
						{ value: "single", label: "Single room", disabled: false, selected: false },
						{ value: "suite", label: "Suite", disabled: false, selected: false },
					],
				}),
			]),
		);
		const select = set.tables.get("SELECT") ?? [];
		expect(select.map(candidate => candidate.args.value)).toEqual(["single", "suite"]);
		expect(set.tables.has("CLICK")).toBe(false);
	});

	it("offers scroll targets only in the directions the page can scroll", () => {
		const set = deriveCandidates(
			snapshotOf([control({ node: 1, role: "button", label: "Continue" })], {
				scrollable: { down: true, up: false },
				scroll: { x: 0, y: 0, height: 4000 },
			}),
		);
		expect(set.tables.get("SCROLL")?.map(candidate => candidate.id)).toEqual(["down"]);
	});

	it("reports the reader cap as an explicit fallback rather than a silent subset", () => {
		const set = deriveCandidates(
			snapshotOf([control({ node: 1, role: "button", label: "Continue" })], { omittedControls: 7 }),
		);
		expect(set.truncated).toBe(true);
		expect(set.fallback).toContain("7 further controls");
	});

	it("ignores geometry in the digest so animation is not a change", () => {
		const base = snapshotOf([control({ node: 1, role: "button", label: "Continue" })]);
		const moved = snapshotOf([
			control({ node: 1, role: "button", label: "Continue", bbox: { x: 400, y: 900, w: 80, h: 20 } }),
		]);
		const renamed = snapshotOf([control({ node: 1, role: "button", label: "Continue now" })]);
		expect(snapshotDigest(moved)).toBe(snapshotDigest(base));
		expect(snapshotDigest(renamed)).not.toBe(snapshotDigest(base));
	});
});

describe("browser task loop", () => {
	const clickable = [control({ node: 1, role: "button", label: "Continue" })];

	it("verifies a proposed completion against a fresh observation and caller expectations", async () => {
		const driver = new FakeDriver([
			snapshotOf(clickable),
			snapshotOf(clickable, { url: "https://fixture.test/done", text: "Booked. Thank you." }),
		]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "book a room", expect: { urlIncludes: "/done", textIncludes: "Booked" } },
			driver,
			judge: new ScriptedJudge([{ operation: "DONE" }]),
			budget: budgetOf(),
		});
		expect(result.status).toBe("done");
		expect(result.verification.verified).toBe(true);
		expect(result.verification.method).toBe("dom-reobserve+expect+judge");
		expect(result.observationRevisions).toBe(2);
		expect(result.usage.calls).toBe(2);
		// Every remote attempt is exposed, not only the aggregate.
		expect(result.attempts.map(attempt => attempt.attempt)).toEqual([1, 2]);
		expect(result.usage.attempts).toBe(2);
	});

	it("never reports done without a caller postcondition, however confident the completion judgment is", async () => {
		const driver = new FakeDriver([snapshotOf(clickable)]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "book a room" },
			driver,
			judge: new ScriptedJudge([{ operation: "DONE" }], 0.9),
			budget: budgetOf(),
		});
		expect(result.status).toBe("unverified");
		expect(result.verification.verified).toBe("unknown");
		expect(result.verification.detail).toContain("no caller expect postcondition");
		expect(result.verification.detail).toContain("unchanged since the task started");
	});

	it("reports unverified when the caller expectation is not met by the fresh page", async () => {
		const driver = new FakeDriver([snapshotOf(clickable)]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "book a room", expect: { textIncludes: "Booked" } },
			driver,
			judge: new ScriptedJudge([{ operation: "DONE" }]),
			budget: budgetOf(),
		});
		expect(result.status).toBe("unverified");
		expect(result.verification.verified).toBe(false);
		expect(result.verification.detail).toContain("Booked");
	});

	it("rejects a completion the completion judgment does not support", async () => {
		const driver = new FakeDriver([snapshotOf(clickable)]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "book a room", expect: { textIncludes: "Reservation" } },
			driver,
			judge: new ScriptedJudge([{ operation: "DONE" }], 0.1),
			budget: budgetOf(),
		});
		expect(result.status).toBe("unverified");
		expect(result.verification.verified).toBe(false);
		expect(result.verification.detail).toContain("completion judgment");
	});

	it("treats a changed guard as stale, re-observes, and never sends the input", async () => {
		const driver = new FakeDriver([
			snapshotOf(clickable),
			snapshotOf(clickable, { text: "re-rendered", documentKey: "doc-1" }),
		]);
		driver.freshOverride = { documentKey: "doc-0", guard: "guard-1-Replaced label" };
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "click continue" },
			driver,
			judge: new ScriptedJudge([{ operation: "CLICK", target: "e1" }, { operation: "BLOCKED" }]),
			budget: budgetOf(),
		});
		expect(driver.acts).toHaveLength(0);
		expect(result.steps[0]).toMatchObject({ operation: "CLICK", outcome: "stale" });
		expect(result.observationRevisions).toBe(2);
	});

	it("stops after repeated stale targets instead of retrying forever", async () => {
		const driver = new FakeDriver([snapshotOf(clickable)]);
		driver.freshOverride = { documentKey: "doc-9", guard: null };
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "click continue" },
			driver,
			judge: new ScriptedJudge([{ operation: "CLICK", target: "e1" }]),
			budget: budgetOf(),
		});
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("kept changing");
		expect(result.steps.every(step => step.outcome === "stale")).toBe(true);
	});

	it("quarantines an unknown mutation: the same action is withheld even when the judge insists on it", async () => {
		const submit = [control({ node: 1, role: "button", label: "Continue" })];
		const driver = new FakeDriver(
			[
				snapshotOf(submit),
				snapshotOf(submit, { text: "navigated", documentKey: "doc-1" }),
				snapshotOf(submit, { text: "navigated", documentKey: "doc-1" }),
			],
			[{ status: "unknown", reason: "page changed while acting" }, { status: "applied" }],
		);
		const judge = new ScriptedJudge([
			{ operation: "CLICK", target: "e1" },
			{ operation: "CLICK", target: "e1" },
			{ operation: "BLOCKED" },
		]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "click continue" },
			driver,
			judge,
			budget: budgetOf(),
		});
		expect(driver.acts).toHaveLength(1);
		expect(result.steps[0]).toMatchObject({
			operation: "CLICK",
			outcome: "unknown",
			pageChanged: true,
			quarantined: true,
		});
		// The second decision was not offered CLICK at all and was told why.
		const second = judge.seen[1]?.operation;
		if (second?.type !== "choice") throw new Error("expected a choice question");
		expect(Object.keys(second.criteria)).not.toContain("CLICK");
		expect(judge.states[1]).toMatchObject({ quarantined: [{ operation: "CLICK", action: "Continue" }] });
		expect(result.quarantined).toEqual([{ operation: "CLICK", label: "Continue", documentKey: "doc-0", step: 1 }]);
		expect(result.status).toBe("blocked");
	});

	it("re-offers a quarantined action only when the caller postcondition is still unmet on a changed document", async () => {
		const submit = [control({ node: 1, role: "button", label: "Continue" })];
		const driver = new FakeDriver(
			[
				snapshotOf(submit),
				snapshotOf(submit, { text: "still here", documentKey: "doc-1" }),
				snapshotOf(submit, { text: "Booked", documentKey: "doc-2" }),
			],
			[{ status: "unknown", reason: "page changed while acting" }, { status: "applied" }],
		);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "click continue", expect: { textIncludes: "Booked" } },
			driver,
			judge: new ScriptedJudge([
				{ operation: "CLICK", target: "e1" },
				{ operation: "CLICK", target: "e1" },
				{ operation: "DONE" },
			]),
			budget: budgetOf(),
		});
		expect(driver.acts).toHaveLength(2);
		expect(result.steps.map(step => [step.operation, step.outcome])).toEqual([
			["CLICK", "unknown"],
			["CLICK", "applied"],
			["DONE", "applied"],
		]);
		expect(result.status).toBe("done");
	});

	it("keeps a quarantined consequential action withheld even when the postcondition is unmet", async () => {
		const submit = [control({ node: 1, role: "button", label: "Pay now" })];
		const driver = new FakeDriver(
			[snapshotOf(submit), snapshotOf(submit, { text: "processing", documentKey: "doc-1" })],
			[{ status: "unknown", reason: "page changed while acting" }, { status: "applied" }],
		);
		const judge = new ScriptedJudge([
			{ operation: "CLICK", target: "e1" },
			{ operation: "CLICK", target: "e1" },
			{ operation: "BLOCKED" },
		]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "pay", expect: { textIncludes: "Paid" }, allowConsequential: true },
			driver,
			judge,
			budget: budgetOf(),
		});
		expect(driver.acts).toHaveLength(1);
		expect(result.status).toBe("blocked");
	});

	it("blocks after three consecutive actions that change nothing", async () => {
		const driver = new FakeDriver([snapshotOf(clickable)]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "click continue" },
			driver,
			judge: new ScriptedJudge([{ operation: "CLICK", target: "e1" }]),
			budget: budgetOf(),
		});
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("changed nothing");
		expect(driver.acts).toHaveLength(3);
	});

	it("refuses a consequential control without approval and names it and the source", async () => {
		const consequential = [control({ node: 1, role: "button", label: "Confirm reservation" })];
		const driver = new FakeDriver([snapshotOf(consequential)]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "confirm the booking" },
			driver,
			judge: new ScriptedJudge([{ operation: "CLICK", target: "e1" }]),
			budget: budgetOf(),
		});
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain('consequential action requires approval: "Confirm reservation"');
		expect(result.reason).toContain('matched "confirm" in label');
		expect(driver.acts).toHaveLength(0);
		expect(result.steps[0]).toMatchObject({ outcome: "rejected" });
		expect(result.steps[0]?.reason).toContain('matched "confirm" in label');
	});

	it("classifies a native select by the option chosen, not only the select's own name", async () => {
		const action = [
			control({
				node: 1,
				role: "select",
				label: "Action",
				value: "",
				options: [
					{ value: "", label: "Choose", disabled: false, selected: true },
					{ value: "delete", label: "Delete account", disabled: false, selected: false },
				],
			}),
		];
		const driver = new FakeDriver([snapshotOf(action)]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "pick the second action" },
			driver,
			judge: new ScriptedJudge([{ operation: "SELECT", target: "e1o2" }]),
			budget: budgetOf(),
		});
		expect(driver.acts).toHaveLength(0);
		expect(result.status).toBe("blocked");
		expect(result.steps[0]?.reason).toContain('matched "delete" in option text');
	});

	it("classifies a control by its visible text when an aria-label masks it", async () => {
		const masked = [
			control({ node: 1, role: "button", label: "Continue", ariaLabel: "Continue", text: "Authorize payment" }),
		];
		const driver = new FakeDriver([snapshotOf(masked)]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "continue" },
			driver,
			judge: new ScriptedJudge([{ operation: "CLICK", target: "e1" }]),
			budget: budgetOf(),
		});
		expect(driver.acts).toHaveLength(0);
		expect(result.status).toBe("blocked");
		expect(result.steps[0]?.reason).toContain('matched "authorize" in visible text');
	});

	it("fails closed on a name that mixes writing systems", async () => {
		// Latin "P", "y", "now" around a Cyrillic "а": reads as "Pay now", is not.
		const homoglyph = [control({ node: 1, role: "button", label: "P\u0430y now" })];
		const driver = new FakeDriver([snapshotOf(homoglyph)]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "continue" },
			driver,
			judge: new ScriptedJudge([{ operation: "CLICK", target: "e1" }]),
			budget: budgetOf(),
		});
		expect(driver.acts).toHaveLength(0);
		expect(result.status).toBe("blocked");
		expect(result.steps[0]?.reason).toContain("unreadable label");
	});

	it("executes a consequential control once the caller allows it", async () => {
		const consequential = [control({ node: 1, role: "button", label: "Confirm reservation" })];
		const driver = new FakeDriver([
			snapshotOf(consequential),
			snapshotOf(consequential, { url: "https://fixture.test/done", text: "Booked", documentKey: "doc-1" }),
		]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "confirm the booking", allowConsequential: true },
			driver,
			judge: new ScriptedJudge([{ operation: "CLICK", target: "e1" }, { operation: "DONE" }]),
			budget: budgetOf(),
		});
		expect(driver.acts[0]).toMatchObject({ kind: "CLICK", node: 1 });
		expect(result.steps[0]).toMatchObject({ outcome: "applied", pageChanged: true });
	});

	it("fails closed when the backend answers with an id the local table does not contain", async () => {
		const driver = new FakeDriver([snapshotOf(clickable)]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "click continue" },
			driver,
			judge: new ScriptedJudge([{ operation: "CLICK", target: "e99" }]),
			budget: budgetOf(),
		});
		expect(result.status).toBe("error");
		expect(result.reason).toContain('unknown target "e99"');
		expect(driver.acts).toHaveLength(0);
	});

	it("types a caller-supplied value matched by field label", async () => {
		const field = [control({ node: 1, role: "textbox", label: "Full name" })];
		const driver = new FakeDriver([
			snapshotOf(field),
			snapshotOf(field, { text: "name entered", documentKey: "doc-1" }),
		]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "fill the form", values: { "full name": "Ada Lovelace" } },
			driver,
			judge: new ScriptedJudge([{ operation: "TYPE_TEXT", target: "e1" }, { operation: "DONE" }]),
			budget: budgetOf(),
		});
		expect(driver.acts[0]).toMatchObject({ kind: "TYPE_TEXT", node: 1, text: "Ada Lovelace" });
		expect(result.steps[0]).toMatchObject({ textSource: "values", text: "Ada Lovelace" });
		expect(result.unusedValues).toEqual([]);
	});

	it("never lets a page label that merely contains a caller key capture that value", async () => {
		const collector = [control({ node: 1, role: "textbox", label: "Billing email backup collector" })];
		const driver = new FakeDriver([snapshotOf(collector)]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "fill the form", values: { "Billing email": "private@example.test" } },
			driver,
			judge: new ScriptedJudge([{ operation: "TYPE_TEXT", target: "e1" }]),
			budget: budgetOf(),
		});
		expect(driver.acts).toHaveLength(0);
		expect(result.unusedValues).toEqual(["Billing email"]);
		expect(result.steps[0]).toMatchObject({ outcome: "rejected" });
	});

	it("sends the judge origin and path only, filled/empty instead of values, and never typed text", async () => {
		const form = [
			control({ node: 1, role: "textbox", label: "Full name", value: "" }),
			control({ node: 2, role: "textbox", label: "Email", value: "private@example.test" }),
			control({ node: 3, role: "button", label: "Help" }),
		];
		const filled = [
			control({ node: 1, role: "textbox", label: "Full name", value: "Ada Lovelace" }),
			control({ node: 2, role: "textbox", label: "Email", value: "private@example.test" }),
			control({ node: 3, role: "button", label: "Help" }),
		];
		const url = "https://fixture.test/form?token=secret#fragment";
		const driver = new FakeDriver([snapshotOf(form, { url }), snapshotOf(filled, { url, documentKey: "doc-1" })]);
		const judge = new ScriptedJudge([{ operation: "TYPE_TEXT", target: "e1" }, { operation: "BLOCKED" }]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "click Help", values: { "Full name": "Ada Lovelace" } },
			driver,
			judge,
			budget: budgetOf(),
		});
		expect(result.steps[0]).toMatchObject({ operation: "TYPE_TEXT", outcome: "applied", text: "Ada Lovelace" });
		expect(judge.states).toHaveLength(2);
		for (const [index, state] of judge.states.entries()) {
			const shipped = JSON.stringify(state) + JSON.stringify(judge.seen[index]);
			expect(shipped).not.toContain("secret");
			expect(shipped).not.toContain("fragment");
			expect(shipped).not.toContain("private@example.test");
			expect(shipped).not.toContain("Ada Lovelace");
		}
		expect(judge.states[0]).toMatchObject({ page: { url: "https://fixture.test/form" } });
		expect(judge.states[1]).toMatchObject({
			elements: [{ label: "Full name", filled: true }, { label: "Email", filled: true }, { label: "Help" }],
			recent_actions: [{ action: "Full name", operation: "TYPE_TEXT", outcome: "applied", page_changed: true }],
		});
		expect(JSON.stringify(judge.states[1])).not.toContain('"value"');
	});

	it("never dispatches input once the deadline passed during the freshness check", async () => {
		const field = [control({ node: 1, role: "textbox", label: "Full name" })];
		const driver = new FakeDriver([snapshotOf(field)]);
		const budget = budgetOf();
		// The page work a decision waits on outlives the deadline.
		driver.onFresh = () => {
			budget.deadlineAt = Date.now() - 1;
		};
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "fill the form", values: { "Full name": "Ada Lovelace" } },
			driver,
			judge: new ScriptedJudge([{ operation: "TYPE_TEXT", target: "e1" }]),
			budget,
		});
		expect(driver.acts).toHaveLength(0);
		expect(result.status).toBe("exhausted");
		expect(result.reason).toContain("deadline");
	});

	it("tightens per-call bounds to the configured defaults and never exceeds them", () => {
		const base = { maxCallsDefault: 5, maxActionsDefault: 8, deadlineMs: 10_000 };
		expect(taskBudget({ ...base, maxCalls: 50, maxActions: 80 }, 0)).toMatchObject({ maxCalls: 5, maxActions: 8 });
		expect(taskBudget({ ...base, maxCalls: 2, maxActions: 3 }, 0)).toMatchObject({ maxCalls: 2, maxActions: 3 });
		expect(taskBudget(base, 0)).toMatchObject({ maxCalls: 5, maxActions: 8, deadlineAt: 10_000 });
	});

	it("binds SCROLL to the document it was decided against", async () => {
		const driver = new FakeDriver(
			[
				snapshotOf(clickable, { scrollable: { down: true, up: false }, scroll: { x: 0, y: 0, height: 4000 } }),
				snapshotOf(clickable, { text: "replaced", documentKey: "doc-1" }),
			],
			[{ status: "stale", reason: "document state changed after the decision" }],
		);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "find the footer" },
			driver,
			judge: new ScriptedJudge([{ operation: "SCROLL", target: "down" }, { operation: "BLOCKED" }]),
			budget: budgetOf(),
		});
		expect(driver.acts[0]).toMatchObject({ kind: "SCROLL", expect: { documentKey: "doc-0", guard: null } });
		expect(result.steps[0]).toMatchObject({ operation: "SCROLL", outcome: "stale" });
		expect(result.observationRevisions).toBe(2);
	});

	it("types nothing when no caller value matches and no text helper is available", async () => {
		const field = [control({ node: 1, role: "textbox", label: "Full name" })];
		const driver = new FakeDriver([snapshotOf(field)]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "fill the form", values: { city: "Lisbon" } },
			driver,
			judge: new ScriptedJudge([{ operation: "TYPE_TEXT", target: "e1" }]),
			budget: budgetOf(),
		});
		expect(driver.acts).toHaveLength(0);
		expect(result.status).toBe("blocked");
		expect(result.steps[0]).toMatchObject({ outcome: "rejected" });
		expect(result.steps[0]?.reason).toContain("no text helper");
	});

	it("stops at the action bound with the steps it already took", async () => {
		const driver = new FakeDriver([
			snapshotOf(clickable),
			snapshotOf(clickable, { text: "changed", documentKey: "doc-1" }),
		]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "click continue" },
			driver,
			judge: new ScriptedJudge([{ operation: "CLICK", target: "e1" }]),
			budget: budgetOf({ maxActions: 1 }),
		});
		expect(result.status).toBe("exhausted");
		expect(result.reason).toContain("action bound 1");
		expect(result.steps).toHaveLength(1);
		expect(result.budget.actions).toBe(1);
	});

	it("stops at the call bound", async () => {
		const driver = new FakeDriver([snapshotOf(clickable)]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "click continue" },
			driver,
			judge: new ScriptedJudge([{ operation: "CLICK", target: "e1" }]),
			budget: budgetOf({ maxCalls: 1 }),
		});
		expect(result.status).toBe("exhausted");
		expect(result.reason).toContain("judgment call bound 1");
		expect(result.budget.calls).toBe(1);
	});

	it("reports cancellation as an error before touching the page", async () => {
		const driver = new FakeDriver([snapshotOf(clickable)]);
		const controller = new AbortController();
		controller.abort();
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "click continue" },
			driver,
			judge: new ScriptedJudge([{ operation: "CLICK", target: "e1" }]),
			budget: budgetOf({ signal: controller.signal }),
		});
		expect(result.status).toBe("error");
		expect(result.reason).toContain("abort");
		expect(result.steps).toHaveLength(0);
		expect(result.observationRevisions).toBe(0);
		expect(driver.observeCount).toBe(0);
	});

	it("hands back an abstain when the page needs an unsupported capability", async () => {
		const driver = new FakeDriver([snapshotOf(clickable, { unsupported: ["canvas", "iframe"] })]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "sign the canvas" },
			driver,
			judge: new ScriptedJudge([{ operation: "ABSTAIN" }]),
			budget: budgetOf(),
		});
		expect(result.status).toBe("abstain");
		expect(result.reason).toContain("canvas, iframe");
		expect(result.unsupported).toEqual(["canvas", "iframe"]);
	});

	it("offers an operation only when it has at least one target", async () => {
		const driver = new FakeDriver([snapshotOf(clickable)]);
		const judge = new ScriptedJudge([{ operation: "BLOCKED" }]);
		await runBrowserTask({
			tabName: "t",
			options: { goal: "click continue" },
			driver,
			judge,
			budget: budgetOf(),
		});
		const operation = judge.seen[0]?.operation;
		if (operation?.type !== "choice") throw new Error("expected a choice question");
		expect(Object.keys(operation.criteria).sort()).toEqual(["ABSTAIN", "BLOCKED", "CLICK", "DONE", "WAIT"]);
		expect(Object.keys(judge.seen[0] ?? {})).toEqual(["operation", "click_target"]);
	});

	it("states each target head's premise and offers a none option answered independently of the operation head", async () => {
		const form = [
			control({ node: 1, role: "textbox", label: "City", value: "" }),
			control({ node: 2, role: "button", label: "Search" }),
		];
		const driver = new FakeDriver([snapshotOf(form, { scrollable: { down: true, up: false } })]);
		const judge = new ScriptedJudge([{ operation: "BLOCKED" }]);
		await runBrowserTask({ tabName: "t", options: { goal: "search Lisbon" }, driver, judge, budget: budgetOf() });

		const questions = judge.seen[0] ?? {};
		expect(Object.keys(questions)).toEqual(["operation", "click_target", "type_text_target", "scroll_target"]);
		for (const [operation, head] of [
			["CLICK", "click_target"],
			["TYPE_TEXT", "type_text_target"],
			["SCROLL", "scroll_target"],
		] as const) {
			const question = questions[head];
			if (question?.type !== "choice") throw new Error("expected a choice question for " + head);
			// The premise is in the question itself: the model never sees the head's id.
			expect(question.instructions).toContain("Assuming the operation executed next on this page is " + operation);
			expect(question.instructions).toContain("used only when that choice is " + operation);
			expect(question.criteria.none).toContain("if " + operation + " ran next");
		}
		const scroll = questions.scroll_target;
		if (scroll?.type !== "choice") throw new Error("expected a choice question");
		expect(Object.keys(scroll.criteria)).toEqual(["down", "none"]);
		expect(scroll.instructions).toContain("Options are scroll directions");
		expect(scroll.instructions).not.toContain("Do not choose a field");
		const operation = questions.operation;
		if (operation?.type !== "choice") throw new Error("expected a choice question");
		expect(operation.instructions).toContain("`recent_actions`");
		expect(operation.instructions).toContain("`elements`");
	});

	it("takes the next-ranked operation when the chosen operation's target head declines every target", async () => {
		const driver = new FakeDriver([snapshotOf(clickable), snapshotOf(clickable)]);
		// The operation head says CLICK, but the CLICK target head answers `none`.
		const judge = new ScriptedJudge([{ operation: "CLICK", target: "none" }, { operation: "BLOCKED" }]);
		const result = await runBrowserTask({
			tabName: "t",
			options: { goal: "click continue" },
			driver,
			judge,
			budget: budgetOf(),
		});

		// No click was dispatched against a target the judge declined; the loop fell
		// through to the next-ranked operation without a target head (WAIT).
		expect(driver.acts.map(act => act.kind)).toEqual(["WAIT"]);
		expect(result.steps[0]).toMatchObject({ operation: "WAIT", outcome: "applied" });
		expect(result.steps[0]?.reason).toContain("CLICK declined by its target head");
		expect(result.status).toBe("blocked");
	});

	it("asks the completion noul as a yes/no question with true/false criteria over the fresh observation", async () => {
		const driver = new FakeDriver([snapshotOf(clickable), snapshotOf(clickable, { text: "Booked" })]);
		const judge = new ScriptedJudge([{ operation: "DONE" }]);
		await runBrowserTask({
			tabName: "t",
			options: { goal: "book a room", expect: { textIncludes: "Booked" } },
			driver,
			judge,
			budget: budgetOf(),
		});

		expect(Object.keys(judge.seen[1] ?? {})).toEqual(["goal_satisfied"]);
		const question = judge.seen[1]?.goal_satisfied;
		if (question?.type !== "noul") throw new Error("expected a noul question");
		// Wire contract: a question (not an imperative) naming the goal, with
		// distinct true/false criteria the judge scores against.
		expect(question.instructions.split("\n")[0]).toMatch(/\?$/);
		expect(question.instructions).toContain("book a room");
		expect(question.criteria?.true).toBeTruthy();
		expect(question.criteria?.false).toBeTruthy();
		expect(question.criteria?.true).not.toBe(question.criteria?.false);
		// The noul is asked over the re-observed page, not the one that proposed DONE.
		expect(judge.states[1]).toMatchObject({ page: { text: "Booked" } });
	});
});

describe("browser task field values", () => {
	const field = control({ node: 1, role: "textbox", label: "Email address" });

	it("matches a caller key only by exact normalised label, placeholder, or form name", () => {
		expect(matchSuppliedValue({ email: "a@b.c", "Email address": "exact@b.c" }, field)).toEqual({
			key: "Email address",
			value: "exact@b.c",
		});
		expect(matchSuppliedValue({ "  EMAIL   ADDRESS ": "folded@b.c" }, field)).toMatchObject({ value: "folded@b.c" });
		expect(matchSuppliedValue({ email: "a@b.c" }, field)).toBeUndefined();
		expect(matchSuppliedValue({ "Email address backup": "a@b.c" }, field)).toBeUndefined();
		expect(
			matchSuppliedValue({ "you@example.com": "p@b.c" }, { ...field, placeholder: "you@example.com" }),
		).toMatchObject({
			value: "p@b.c",
		});
		expect(matchSuppliedValue({ billing_email: "n@b.c" }, { ...field, name: "billing_email" })).toMatchObject({
			value: "n@b.c",
		});
	});

	it("accepts a helper value only when the goal or the caller values ground it", () => {
		const name = control({ node: 2, role: "textbox", label: "Full name" });
		expect(
			groundHelperValue({ text: "ATTACKER_VALUE", source: "goal" }, { goal: "fill the form", control: name }),
		).toMatchObject({
			ok: false,
			reason: expect.stringContaining("helper value not grounded"),
		});
		expect(
			groundHelperValue({ text: "Ada", source: "goal" }, { goal: "enter the full name Ada", control: name }),
		).toEqual({
			ok: true,
			text: "Ada",
		});
		expect(
			groundHelperValue(
				{ text: "Ada", source: "values" },
				{ goal: "fill the form", control: name, values: { "Full name": "Ada" } },
			),
		).toEqual({ ok: true, text: "Ada" });
		expect(
			groundHelperValue(
				{ text: "Ada!", source: "values" },
				{ goal: "fill the form", control: name, values: { "Full name": "Ada" } },
			),
		).toMatchObject({ ok: false, reason: expect.stringContaining("helper value not grounded") });
		expect(
			groundHelperValue({ text: "Ada", source: undefined }, { goal: "enter the full name Ada", control: name }),
		).toMatchObject({
			ok: false,
			reason: expect.stringContaining("helper value not grounded"),
		});
	});

	it("rejects a multi-line value for a single-line field", () => {
		expect(validateTextValue("one\ntwo", field)).toMatchObject({ ok: false });
		expect(validateTextValue("one\ntwo", { ...field, multiline: true })).toMatchObject({ ok: true });
	});

	it("rejects an over-cap value instead of truncating it", () => {
		expect(validateTextValue("x".repeat(2001), field)).toMatchObject({ ok: false });
	});

	it("rejects rather than guesses when no value matches and no helper is configured", async () => {
		const resolved = await resolveTextValue(
			{
				goal: "fill the form",
				control: field,
				snapshot: snapshotOf([field]),
				recent: [],
				values: { city: "Lisbon" },
			},
			new LoopMeter(budgetOf()),
		);
		expect(resolved.status).toBe("rejected");
	});
});

describe("browser task tab policy", () => {
	const names: string[] = [];

	function policySession(): ToolSession {
		return {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({ "browser.enabled": true }),
		};
	}

	function installTab(kindTag: string, overrides: Record<string, unknown>): string {
		const name = "task-policy-" + crypto.randomUUID();
		names.push(name);
		getTabsMapForTest().set(name, {
			name,
			state: "alive",
			backend: "worker",
			kindTag,
			persist: false,
			info: { url: "https://example.test/", viewport: { width: 800, height: 600 } },
			pending: new Map(),
			browser: { kind: { kind: kindTag } },
			...overrides,
		} as unknown as TabSession);
		return name;
	}

	afterEach(() => {
		for (const name of names.splice(0)) getTabsMapForTest().delete(name);
	});

	it("refuses to drive a relay tab that adopted the user's visible tab", async () => {
		const name = installTab("relay", { activateForScreenshot: false, ownsTarget: false });
		await expect(
			executeBrowserTask(policySession(), {
				name,
				goal: "do something",
				deadlineMs: 10_000,
				maxActionsDefault: 5,
				maxCallsDefault: 5,
			}),
		).rejects.toThrow(/visible tab.*app\.new_tab/s);
	});

	it("accepts an omp-owned relay tab, then needs a judgment backend", async () => {
		const name = installTab("relay", { activateForScreenshot: true, ownsTarget: true });
		await expect(
			executeBrowserTask(policySession(), {
				name,
				goal: "do something",
				deadlineMs: 10_000,
				maxActionsDefault: 5,
				maxCallsDefault: 5,
			}),
		).rejects.toThrow(/model registry/);
	});

	it("refuses the cmux backend, which has no Puppeteer page", async () => {
		const name = installTab("cmux", { backend: "cmux" });
		await expect(
			executeBrowserTask(policySession(), {
				name,
				goal: "do something",
				deadlineMs: 10_000,
				maxActionsDefault: 5,
				maxCallsDefault: 5,
			}),
		).rejects.toThrow(/cmux/);
	});

	it("requires the named tab to be open", async () => {
		await expect(
			executeBrowserTask(policySession(), {
				name: "task-policy-missing-" + crypto.randomUUID(),
				goal: "do something",
				deadlineMs: 10_000,
				maxActionsDefault: 5,
				maxCallsDefault: 5,
			}),
		).rejects.toThrow(/is not open/);
	});

	it("accepts a relay tab opened against an explicit target, then needs a judgment backend", async () => {
		const name = installTab("relay", { activateForScreenshot: true, ownsTarget: false });
		await expect(
			executeBrowserTask(policySession(), {
				name,
				goal: "do something",
				deadlineMs: 10_000,
				maxActionsDefault: 5,
				maxCallsDefault: 5,
			}),
		).rejects.toThrow(/model registry/);
	});
});
