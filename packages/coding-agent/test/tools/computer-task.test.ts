import { describe, expect, it } from "bun:test";
import type { Answer, JudgmentRequest, JudgmentResult, JudgmentState, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ResolvedJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { grantAutomationScope } from "@oh-my-pi/pi-coding-agent/tools/automation-policy";
import { computerApproval, createComputerPrelude } from "@oh-my-pi/pi-coding-agent/tools/computer";
import type { CuaDriverDetection } from "@oh-my-pi/pi-coding-agent/tools/computer/cua-driver";
import type {
	ComputerSessionSnapshot,
	ComputerWorkerInbound,
	ComputerWorkerOutbound,
	ComputerWorkerTransport,
} from "@oh-my-pi/pi-coding-agent/tools/computer/protocol";
import type { ComputerController } from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import type { TextValueOutcome, TextValueRequest } from "@oh-my-pi/pi-coding-agent/tools/computer/task/text-value";
import type { ComputerTaskResult } from "@oh-my-pi/pi-coding-agent/tools/computer/task/types";
import { ComputerWorkerCore, type NativeDesktopSession } from "@oh-my-pi/pi-coding-agent/tools/computer/worker";
import type {
	AxNode,
	AxQuery,
	AxSnapshotOptions,
	DesktopCapabilities,
	DesktopDisplay,
	DesktopPoint,
	DesktopWindow,
} from "@oh-my-pi/pi-natives";

const capabilities: DesktopCapabilities = {
	backend: "fake",
	displayServer: "memory",
	capture: true,
	input: true,
	ax: true,
	backgroundWindowInput: true,
	deliveryModes: ["background", "foreground"],
	capturePermission: "granted",
	inputPermission: "granted",
	axPermission: "granted",
	displayCount: 1,
};

const driverAbsent: CuaDriverDetection = { installed: false, searched: ["cua-driver (PATH)"] };

function node(overrides: Partial<AxNode> & Pick<AxNode, "ref" | "role">): AxNode {
	return {
		nativeRole: "AX" + overrides.role,
		enabled: true,
		focused: false,
		childCount: 0,
		x: 10,
		y: 10,
		width: 60,
		height: 20,
		...overrides,
	};
}

/** Fake AX tree: one text field, one enabled button, one disabled button, a checkbox, and a popup. */
function defaultTree(): AxNode[] {
	return [
		node({ ref: "e1", role: "textfield", title: "Name", value: "", actions: ["AXConfirm"] }),
		node({ ref: "e2", role: "button", title: "Apply", actions: ["AXPress"] }),
		node({ ref: "e3", role: "button", title: "Retry", enabled: false, actions: ["AXPress"] }),
		node({ ref: "e4", role: "checkbox", title: "Remember me", value: "0", actions: ["AXPress"] }),
		node({ ref: "e5", role: "popupbutton", title: "Format", value: "plain", actions: ["AXPress", "AXShowMenu"] }),
	];
}

class TaskNativeSession implements NativeDesktopSession {
	readonly capabilities = capabilities;
	window: DesktopWindow | null = {
		id: "42",
		title: "Editor",
		app: "Code",
		pid: 123,
		x: 0,
		y: 0,
		width: 400,
		height: 300,
		focused: true,
	};
	nodes: AxNode[] = defaultTree();
	readonly performed: Array<{ ref: string; action: string }> = [];
	readonly setValues: Array<{ ref: string; value: string }> = [];
	queries = 0;
	/** Mutates the tree before the nth query answers, simulating a live window. */
	beforeQuery?: (query: number, session: TaskNativeSession) => void;
	/** Returns an error to throw instead of performing, simulating a failed dispatch. */
	performFailure?: (ref: string) => Error | undefined;
	/** Side effect of a successful press. */
	onPerform?: (ref: string, session: TaskNativeSession) => void;

	async listDisplays(): Promise<DesktopDisplay[]> {
		return [];
	}
	async listWindows(): Promise<DesktopWindow[]> {
		return this.window ? [this.window] : [];
	}
	async capture(target: string): Promise<{
		data: Uint8Array;
		width: number;
		height: number;
		sourceWidth: number;
		sourceHeight: number;
		target: string;
	}> {
		return { data: Uint8Array.of(137), width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, target };
	}
	async click(): Promise<void> {}
	async moveMouse(): Promise<void> {}
	async drag(_target: string, _points: DesktopPoint[]): Promise<void> {}
	async scroll(): Promise<void> {}
	async typeText(): Promise<void> {}
	async keyChord(_target: string, _keys: string[]): Promise<void> {}
	async raiseWindow(): Promise<void> {}
	async axSnapshot(_target: string, _opts?: AxSnapshotOptions | null): Promise<{ text: string }> {
		return { text: "- window [ref=e0]" };
	}
	async axQuery(_target: string, query: AxQuery): Promise<AxNode[]> {
		this.queries += 1;
		this.beforeQuery?.(this.queries, this);
		return this.nodes.slice(0, query.limit ?? 100);
	}
	async axElementAt(): Promise<AxNode | null> {
		return null;
	}
	async axFocused(): Promise<AxNode | null> {
		return null;
	}
	async axNode(ref: string): Promise<AxNode> {
		const found = this.nodes.find(candidate => candidate.ref === ref);
		if (!found) throw new Error("StaleRef: " + ref + " is no longer valid");
		return found;
	}
	async axAttributes(): Promise<Array<[string, string]>> {
		return [];
	}
	async axChildren(): Promise<AxNode[]> {
		return [];
	}
	async axParent(): Promise<AxNode | null> {
		return null;
	}
	async axPerform(ref: string, action: string): Promise<void> {
		const failure = this.performFailure?.(ref);
		if (failure) throw failure;
		this.performed.push({ ref, action });
		this.onPerform?.(ref, this);
	}
	async axSetValue(ref: string, value: string): Promise<void> {
		this.setValues.push({ ref, value });
		const found = this.nodes.find(candidate => candidate.ref === ref);
		if (found) found.value = value;
	}
	async axFocus(): Promise<void> {}
	async axClick(): Promise<void> {}
	async close(): Promise<void> {}
}

class MemoryTransport implements ComputerWorkerTransport {
	#handler?: (message: ComputerWorkerInbound) => void;
	readonly #waiters = new Set<{
		predicate: (message: ComputerWorkerOutbound) => boolean;
		resolve: (message: ComputerWorkerOutbound) => void;
	}>();
	readonly #outbound: ComputerWorkerOutbound[] = [];

	send(message: ComputerWorkerOutbound): void {
		this.#outbound.push(message);
		for (const waiter of this.#waiters) {
			if (!waiter.predicate(message)) continue;
			this.#waiters.delete(waiter);
			waiter.resolve(message);
		}
	}
	onMessage(handler: (message: ComputerWorkerInbound) => void): () => void {
		this.#handler = handler;
		return () => {
			if (this.#handler === handler) this.#handler = undefined;
		};
	}
	close(): void {}
	inbound(message: ComputerWorkerInbound): void {
		this.#handler?.(message);
	}
	waitFor(predicate: (message: ComputerWorkerOutbound) => boolean): Promise<ComputerWorkerOutbound> {
		const existing = this.#outbound.find(predicate);
		if (existing) return Promise.resolve(existing);
		const pending = Promise.withResolvers<ComputerWorkerOutbound>();
		this.#waiters.add({ predicate, resolve: pending.resolve });
		return pending.promise;
	}
}

/** Controller backed by the real worker core over an in-memory transport. */
function workerController(native: TaskNativeSession): ComputerController {
	const transport = new MemoryTransport();
	new ComputerWorkerCore(transport, () => native);
	let sequence = 0;
	return {
		async run(code: string, timeoutMs: number, snapshot: ComputerSessionSnapshot) {
			sequence += 1;
			const id = "task-" + sequence;
			transport.inbound({ type: "run", id, code, timeoutMs, session: snapshot });
			const message = await transport.waitFor(entry => entry.type === "result" && entry.id === id);
			if (message.type !== "result") throw new Error("unexpected worker message");
			if (!message.ok) throw new Error(message.error.message);
			return message.payload;
		},
		async capabilities() {
			return capabilities;
		},
		async close() {},
	};
}

interface JudgeRecord {
	ids: string[];
	labels: string[];
	state: JudgmentState;
	questions: string[];
	/** The full question bodies, so a test can pin what the judge was actually asked. */
	bodies: Questions;
}

interface JudgeStep {
	pick: (ids: string[], labels: string[]) => string;
}

/** Deterministic in-memory judge: no network, no model, scripted selections. */
class ScriptedJudge implements ResolvedJudge {
	readonly kind = "online" as const;
	readonly label = "scripted-test-judge";
	readonly records: JudgeRecord[] = [];
	readonly #steps: JudgeStep[];
	readonly #fallback: JudgeStep;
	readonly #noul: number;

	constructor(steps: JudgeStep[], options: { fallback?: JudgeStep; noul?: number } = {}) {
		this.#steps = [...steps];
		this.#fallback = options.fallback ?? { pick: () => "blocked" };
		this.#noul = options.noul ?? 1;
	}

	async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		const questions: Record<string, unknown> = request.questions;
		const answers: Record<string, Answer> = {};
		const select = questions.select;
		let ids: string[] = [];
		let labels: string[] = [];
		if (select !== undefined && select !== null && typeof select === "object" && "criteria" in select) {
			const criteria = (select as { criteria: Record<string, string | null> }).criteria;
			ids = Object.keys(criteria);
			labels = Object.values(criteria).map(value => value ?? "");
		}
		this.records.push({
			ids,
			labels,
			state: request.state,
			questions: Object.keys(questions),
			bodies: request.questions,
		});
		if (ids.length > 0) {
			const step = this.#steps.shift() ?? this.#fallback;
			const choice = step.pick(ids, labels);
			if (!ids.includes(choice)) throw new Error("scripted judge picked missing candidate " + choice);
			const probabilities: Record<string, number> = {};
			for (const id of ids) probabilities[id] = id === choice ? 1 : 0;
			answers.select = { type: "choice", choice, probabilities, confidence: 1 };
		}
		for (const id of Object.keys(questions)) {
			if (id === "select") continue;
			answers[id] = { type: "noul", noul: this.#noul };
		}
		return {
			api: "fake",
			provider: "fake",
			model: "scripted-judge",
			usage: tokenUsage(12, 3),
			answers,
		} as JudgmentResult<Q>;
	}
}

/** Picks the candidate whose offered label mentions `needle`. */
function byLabel(needle: string): JudgeStep {
	return {
		pick: (ids, labels) => {
			const index = labels.findIndex(label => label.includes(needle));
			if (index < 0) throw new Error("no candidate labelled " + needle + " in " + labels.join(" | "));
			return ids[index]!;
		},
	};
}

function toolSession(): ToolSession {
	return {
		cwd: import.meta.dir,
		hasUI: false,
		settings: Settings.isolated({ "computer.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

interface RunOptions {
	judge: ScriptedJudge;
	native?: TaskNativeSession;
	resolveValue?: (request: TextValueRequest) => Promise<TextValueOutcome>;
	signal?: AbortSignal;
	authorized?: boolean;
}

/** Invoke the host `task` action through the real prelude with injected judge and value seams. */
async function runTask(
	params: Record<string, unknown>,
	options: RunOptions,
): Promise<{ result: ComputerTaskResult; native: TaskNativeSession; text: string }> {
	const native = options.native ?? new TaskNativeSession();
	const session = toolSession();
	if (options.authorized !== false) {
		grantAutomationScope(session, {
			surface: "computer",
			targets: ["Code"],
			actions: [
				"computer.task.press",
				"computer.task.click",
				"computer.task.set-value",
				"computer.task.focus",
				"computer.task.scroll-to-visible",
			],
			consequential: true,
			task: "computer task fixture",
		});
	}
	const prelude = createComputerPrelude(session, () => workerController(native), {
		createJudge: () => options.judge,
		createValueResolver: () => async request =>
			(await options.resolveValue?.(request)) ?? { ok: false, reason: "no value route in this test" },
		detectDriver: async () => driverAbsent,
	});
	const invoked = await prelude.invoke(
		{ action: "task", ...params },
		{ session, toolCallId: "computer-task", signal: options.signal },
	);
	const details = invoked.details;
	if (details === null || typeof details !== "object" || !("value" in details)) {
		throw new Error("task returned no result details");
	}
	const text = invoked.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
	return { result: details.value as ComputerTaskResult, native, text };
}

describe("computer.task host contract", () => {
	it("classifies task as exec approval and rejects unknown fields", async () => {
		expect(computerApproval({ action: "task", goal: "do it" })).toBe("exec");
		await expect(runTask({ goal: "do it", surprise: true }, { judge: new ScriptedJudge([]) })).rejects.toThrow(
			"computer received invalid arguments",
		);
	});

	it("requires an explicit window target and never falls back to the focused window", async () => {
		await expect(runTask({ goal: "do it" }, { judge: new ScriptedJudge([]) })).rejects.toThrow(
			"requires an explicit target",
		);
		await expect(
			runTask({ goal: "do it", window: { app: "Nope" } }, { judge: new ScriptedJudge([]) }),
		).rejects.toThrow("no window matches");
	});
});

describe("computer.task goal loop", () => {
	it("denies a task mutation when the fixture has no exact app/action grant", async () => {
		const judge = new ScriptedJudge([byLabel('"Name"')]);
		await expect(
			runTask(
				{
					goal: "put the reviewer name in the Name field",
					window: { app: "Code" },
					values: { Name: "Ada" },
				},
				{ judge, authorized: false },
			),
		).rejects.toThrow(/^AUTOMATION_DENIED:/);
	});

	it("types the caller value, verifies the result, and never offers a disabled control", async () => {
		const judge = new ScriptedJudge([byLabel('"Name"'), { pick: () => "done" }]);
		const { result, native } = await runTask(
			{
				goal: "put the reviewer name in the Name field",
				window: { app: "Code" },
				values: { Name: "Ada" },
				expect: { find: { role: "textfield", value: "Ada" } },
			},
			{ judge },
		);
		expect(result.status).toBe("done");
		expect(native.setValues).toEqual([{ ref: "e1", value: "Ada" }]);
		expect(result.steps[0]).toMatchObject({
			kind: "set-value",
			ref: "e1",
			valueSource: "caller",
			outcome: { status: "applied" },
			changed: true,
		});
		expect(result.verification.verified).toBe(true);
		expect(result.verification.method).toContain("expect");
		expect(result.backend).toMatchObject({ kind: "native", mode: "auto" });
		expect(result.backend.driver.installed).toBe(false);
		expect(result.backend.judge).toMatchObject({ label: "scripted-test-judge", distribution: "synthetic" });
		expect(result.usage.calls).toBe(judge.records.length);
		const offered = judge.records[0]!.labels.join(" | ");
		expect(offered).toContain('press button "Apply"');
		expect(offered).not.toContain("Retry");
		expect(judge.records[0]!.ids).toEqual(
			expect.arrayContaining(["reobserve", "wait", "done", "blocked", "abstain"]),
		);
	});

	it("withholds consequential actions unless the caller authorizes them", async () => {
		const sendOnly = (): TaskNativeSession => {
			const session = new TaskNativeSession();
			session.nodes = [node({ ref: "e1", role: "button", title: "Send message", actions: ["AXPress"] })];
			return session;
		};
		const gated = new ScriptedJudge([]);
		const withheld = await runTask(
			{ goal: "send the draft", window: { app: "Code" } },
			{ judge: gated, native: sendOnly() },
		);
		expect(withheld.result.status).toBe("blocked");
		expect(withheld.result.notes.join(" ")).toContain("Send message");
		expect(withheld.result.steps).toHaveLength(0);
		expect(gated.records).toHaveLength(0);

		const allowedNative = sendOnly();
		const allowed = new ScriptedJudge([byLabel("Send message"), { pick: () => "done" }]);
		const offered = await runTask(
			{
				goal: "send the draft",
				window: { app: "Code" },
				allowConsequential: true,
				expect: { titleIncludes: "Editor" },
			},
			{ judge: allowed, native: allowedNative },
		);
		expect(allowed.records[0]!.labels.join(" | ")).toContain('press button "Send message"');
		expect(allowedNative.performed).toEqual([{ ref: "e1", action: "AXPress" }]);
		expect(offered.result.status).toBe("done");
	});

	it("reports a stale target instead of acting when the tree changed during the decision", async () => {
		const native = new TaskNativeSession();
		// The revalidation observation no longer contains the chosen node.
		native.beforeQuery = (query, session) => {
			if (query === 2) session.nodes = session.nodes.filter(entry => entry.ref !== "e2");
		};
		const judge = new ScriptedJudge([byLabel("Apply"), { pick: () => "blocked" }]);
		const { result } = await runTask({ goal: "apply the change", window: { app: "Code" } }, { judge, native });
		expect(result.steps[0]!.outcome).toMatchObject({ status: "stale", reason: "element is no longer present" });
		expect(native.performed).toEqual([]);
		expect(result.status).toBe("blocked");
		expect(result.observationRevisions).toBeGreaterThan(1);
	});

	it("reconciles an interrupted dispatch by re-observing and never repeats that action", async () => {
		const native = new TaskNativeSession();
		native.performFailure = ref => (ref === "e4" ? new Error("AXError -25200 while performing AXPress") : undefined);
		// The checkbox actually toggled despite the error surfacing.
		native.beforeQuery = (query, session) => {
			if (query !== 3) return;
			const checkbox = session.nodes.find(entry => entry.ref === "e4");
			if (checkbox) checkbox.value = "1";
		};
		const judge = new ScriptedJudge([byLabel("Remember me"), { pick: () => "blocked" }]);
		const { result } = await runTask({ goal: "remember the login", window: { app: "Code" } }, { judge, native });
		expect(result.steps[0]!.outcome.status).toBe("unknown");
		expect(result.steps[0]!.reconciliation).toContain("treating the action as landed");
		expect(judge.records[1]!.labels.join(" | ")).not.toContain("Remember me");
	});

	it("blocks after three consecutive actions that change nothing", async () => {
		const native = new TaskNativeSession();
		const judge = new ScriptedJudge([], { fallback: byLabel("Apply") });
		const { result } = await runTask({ goal: "apply the change", window: { app: "Code" } }, { judge, native });
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("no observable change");
		expect(native.performed).toHaveLength(3);
		expect(result.steps.every(step => step.outcome.status === "applied" && step.changed === false)).toBe(true);
	});

	it("treats an unverified completion claim as a proposal and refuses to report done", async () => {
		const judge = new ScriptedJudge([{ pick: () => "done" }, { pick: () => "done" }]);
		const { result } = await runTask(
			{ goal: "rename the document", window: { app: "Code" }, expect: { titleIncludes: "Renamed" } },
			{ judge },
		);
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("could not be independently verified");
		expect(result.verification.verified).toBe(false);
		expect(result.steps.map(step => step.outcome.status)).toEqual(["rejected", "rejected"]);
		expect(result.notes.join(" ")).toContain("unverified completion claim");
	});

	it("never offers or dispatches a set-value whose field already holds the caller value (receipt: double set_value)", async () => {
		// Receipt RUN-2026-09-18T22-06-04: step 1 set the textarea, the re-observation showed the
		// new value, yet step 2 was offered and dispatched as "set textarea <new value> to the caller value".
		const native = new TaskNativeSession();
		native.nodes = [node({ ref: "e3", role: "textarea", value: "smoke doc\n", actions: ["AXShowMenu"] })];
		const judge = new ScriptedJudge([byLabel("caller value")], { fallback: byLabel("caller value") });
		const { result } = await runTask(
			{
				goal: "replace the document text with 2026-09-18-CUA",
				window: { app: "Code" },
				values: { document: "2026-09-18-CUA" },
				maxActions: 3,
			},
			{ judge, native },
		);
		expect(native.setValues).toEqual([{ ref: "e3", value: "2026-09-18-CUA" }]);
		expect(result.steps[0]).toMatchObject({ kind: "set-value", outcome: { status: "applied" }, changed: true });
		// Second decision: no candidate mentions the caller value any more, so the scripted fallback
		// cannot pick it (the judge throws) and the loop reports failed - never a second dispatch.
		expect(result.status).toBe("failed");
		expect(judge.records[1]!.labels.join(" | ")).not.toContain("caller value");
		expect(judge.records[1]!.state).toMatchObject({ alreadySatisfied: ["2026-09-18-CUA"] });
		expect(result.notes.join(" ")).toContain("already holding their caller value");

		// Dispatch-time guard: the decision saw the old value, the revalidation sees the new one.
		const lagging = new TaskNativeSession();
		lagging.nodes = [node({ ref: "e3", role: "textarea", value: "smoke doc", actions: ["AXShowMenu"] })];
		lagging.beforeQuery = (query, session) => {
			if (query === 2) session.nodes[0]!.value = "2026-09-18-CUA";
		};
		const guard = new ScriptedJudge([byLabel("caller value"), { pick: () => "blocked" }]);
		const guarded = await runTask(
			{ goal: "replace the document text", window: { app: "Code" }, values: { document: "2026-09-18-CUA" } },
			{ judge: guard, native: lagging },
		);
		expect(lagging.setValues).toEqual([]);
		expect(guarded.result.steps[0]!.outcome).toMatchObject({
			status: "rejected",
			reason: expect.stringMatching(/already holds the caller value/),
		});
		expect(guarded.result.budget.actions).toBe(0);
	});

	it("never reports done on a model verdict alone: without a caller expect the status is unverified", async () => {
		const judge = new ScriptedJudge([{ pick: () => "done" }], { noul: 1 });
		const { result } = await runTask({ goal: "leave the form as it is", window: { app: "Code" } }, { judge });
		expect(result.status).toBe("unverified");
		expect(result.reason).toContain("model verdict only");
		expect(result.verification).toMatchObject({ verified: "unknown", method: "ax-reobserve+judge" });
		expect(result.verification.detail).toContain("model verdict only");
		expect(judge.records).toHaveLength(2);
	});

	it("gates generic confirm buttons inside a sheet and buttons of a destructive dialog, and confusable labels anywhere", async () => {
		const native = new TaskNativeSession();
		native.nodes = [
			node({ ref: "e0", role: "sheet", nativeRole: "AXSheet", actions: [] }),
			node({
				ref: "e1",
				role: "statictext",
				value: "Do you want to save the changes made to the document? Your changes will be lost.",
			}),
			node({ ref: "e2", role: "button", title: "Don't Save", actions: ["AXPress"] }),
			node({ ref: "e3", role: "button", title: "Cancel", actions: ["AXPress"] }),
			node({ ref: "e4", role: "button", title: "Save", actions: ["AXPress"] }),
			node({ ref: "e5", role: "button", title: "Rename\u200b", actions: ["AXPress"] }),
			node({ ref: "e6", role: "button", title: "Аpply", actions: ["AXPress"] }),
		];
		const judge = new ScriptedJudge([{ pick: () => "blocked" }]);
		const { result } = await runTask({ goal: "close the document", window: { app: "Code" } }, { judge, native });
		expect(result.status).toBe("blocked");
		// Only the dismissing button reaches the judge.
		const labels = judge.records[0]!.labels.filter(label => label.startsWith("press"));
		expect(labels).toEqual(['press button "Cancel"']);
		const gated = result.notes.join(" ");
		expect(gated).toContain("Don't Save");
		expect(gated).toContain("Save");
		expect(gated).toContain("Rename,");
		expect(gated).not.toContain("\u200b");
		expect(gated).toContain("Аpply");
		expect(gated).not.toContain("Cancel");

		// The same buttons on a plain toolbar are ordinary actions.
		const plain = new TaskNativeSession();
		plain.nodes = [
			node({ ref: "e1", role: "button", title: "Save", actions: ["AXPress"] }),
			node({ ref: "e2", role: "button", title: "OK", actions: ["AXPress"] }),
			node({ ref: "e3", role: "button", title: "Replace", actions: ["AXPress"] }),
		];
		const offered = new ScriptedJudge([{ pick: () => "blocked" }]);
		await runTask({ goal: "save", window: { app: "Code" } }, { judge: offered, native: plain });
		expect(offered.records[0]!.labels.join(" | ")).toContain('press button "OK"');
		expect(offered.records[0]!.labels.join(" | ")).toContain('press button "Replace"');
	});

	it("caps node values shown to the judge and never shows a secure field's value", async () => {
		const native = new TaskNativeSession();
		native.nodes = [
			node({ ref: "e1", role: "textarea", title: "Body", value: "x".repeat(100_000) }),
			node({ ref: "e2", role: "securetextfield", title: "Password", value: "hunter2" }),
			node({ ref: "e3", role: "securetextfield", value: "hunter3" }),
		];
		const judge = new ScriptedJudge([{ pick: () => "blocked" }]);
		await runTask({ goal: "fill the form", window: { app: "Code" } }, { judge, native });
		const state = judge.records[0]!.state as { nodes: Array<{ label: string; value: string | null }> };
		expect(state.nodes[0]!.value!.length).toBeLessThan(260);
		expect(state.nodes[0]!.value).toContain("100000 chars");
		expect(state.nodes[1]!.value).toBeNull();
		expect(state.nodes[2]!.value).toBeNull();
		expect(JSON.stringify(judge.records[0]!)).not.toContain("hunter");
	});

	it("sends the judge only decision-relevant state and asks completion as a yes/no noul over the fresh window", async () => {
		const judge = new ScriptedJudge([{ pick: () => "done" }], { noul: 0.9 });
		const { result } = await runTask({ goal: "apply the settings", window: { app: "Code" } }, { judge });

		// Loop bookkeeping (revision, digest) never reaches the judge; the tree's size and truncation do.
		const decision = judge.records[0]!;
		expect(decision.state).toMatchObject({ observation: { nodes: 5, nodeCount: 5, truncated: false } });
		expect(JSON.stringify(decision.state)).not.toContain("digest");
		expect(JSON.stringify(decision.state)).not.toContain("revision");
		const select = decision.bodies.select;
		if (select?.type !== "choice") throw new Error("expected a choice question");
		expect(select.instructions).toContain("`candidates`");
		expect(select.instructions).toContain("`history`");

		// The completion check is its own request over a re-observed window.
		const verify = judge.records[1]!;
		expect(verify.questions).toEqual(["goal_satisfied"]);
		const question = verify.bodies.goal_satisfied;
		if (question?.type !== "noul") throw new Error("expected a noul question");
		// Wire contract: a question naming the state paths it judges, with
		// distinct true/false criteria; the exact wording is not a contract.
		expect(question.instructions.split("\n")[0]).toMatch(/\?/);
		expect(question.instructions).toContain("`nodes`");
		expect(question.criteria?.true).toBeTruthy();
		expect(question.criteria?.false).toBeTruthy();
		expect(question.criteria?.true).not.toBe(question.criteria?.false);
		expect(verify.state).toMatchObject({ goal: "apply the settings", window: { app: "Code" } });
		expect(result.status).toBe("unverified");
	});

	it("returns a failed result carrying every attempt when the judge transport errors", async () => {
		const judge = new ScriptedJudge([{ pick: () => "reobserve" }, { pick: () => "not-a-candidate" }]);
		const { result } = await runTask({ goal: "apply the change", window: { app: "Code" } }, { judge });
		expect(result.status).toBe("failed");
		expect(result.reason).toContain("not-a-candidate");
		expect(result.attempts).toHaveLength(2);
		expect(result.usage.calls).toBe(2);
	});

	it("stops at the action bound and reports the spent budget", async () => {
		const judge = new ScriptedJudge([], { fallback: byLabel("Apply") });
		const { result } = await runTask({ goal: "apply the change", window: { app: "Code" }, maxActions: 1 }, { judge });
		expect(result.status).toBe("exhausted");
		expect(result.reason).toContain("action bound 1");
		expect(result.budget).toMatchObject({ maxActions: 1, actions: 1 });
	});

	it("uses the small-model value route only for unmatched fields and rejects an unusable reply", async () => {
		const requests: TextValueRequest[] = [];
		const judge = new ScriptedJudge([byLabel('"Name"'), { pick: () => "done" }]);
		const accepted = await runTask(
			{
				goal: "write today's date into the Name field",
				window: { app: "Code" },
				expect: { find: { role: "textfield", value: "2026-09-18" } },
			},
			{
				judge,
				resolveValue: async request => {
					requests.push(request);
					return {
						ok: true,
						text: "2026-09-18",
						model: "smol",
						provider: "fake",
						usage: tokenUsage(4, 2),
						durationMs: 1,
					};
				},
			},
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ field: "Name", role: "textfield", current: undefined });
		// The helper route is handed the loop meter so its attempts are budgeted and recorded.
		expect(requests[0]!.meter).toBeDefined();
		expect(accepted.result.steps[0]).toMatchObject({ valueSource: "model", outcome: { status: "applied" } });
		expect(accepted.result.status).toBe("done");

		const rejecting = new ScriptedJudge([byLabel('"Name"')], { fallback: { pick: () => "blocked" } });
		const refused = await runTask(
			{ goal: "write something into the Name field", window: { app: "Code" } },
			{
				judge: rejecting,
				resolveValue: async () => ({ ok: false, reason: "value model declined to supply a value" }),
			},
		);
		expect(refused.result.steps[0]!.outcome).toMatchObject({
			status: "rejected",
			reason: "value model declined to supply a value",
		});
		expect(refused.native.setValues).toEqual([]);
		expect(rejecting.records[1]!.labels.join(" | ")).not.toContain('"Name"');
	});

	it("reports unsupported for a window that exposes no actionable accessibility nodes", async () => {
		const native = new TaskNativeSession();
		native.nodes = [
			node({ ref: "e1", role: "image", title: "Chart" }),
			node({ ref: "e2", role: "statictext", value: "12 items" }),
		];
		const judge = new ScriptedJudge([]);
		const { result, text } = await runTask(
			{ goal: "click the chart legend", window: { app: "Code" } },
			{ judge, native },
		);
		expect(result.status).toBe("unsupported");
		expect(result.reason).toContain("visual-only");
		expect(judge.records).toHaveLength(0);
		expect(text).toContain("task unsupported");
		expect(text).toContain("cua-driver: not installed");
	});

	it("propagates cancellation as an abort", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			runTask(
				{ goal: "apply the change", window: { app: "Code" } },
				{ judge: new ScriptedJudge([]), signal: controller.signal },
			),
		).rejects.toMatchObject({ name: "ToolAbortError" });
	});
});
