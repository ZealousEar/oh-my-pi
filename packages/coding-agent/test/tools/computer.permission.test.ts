import { describe, expect, it } from "bun:test";
import type { Answer, ChoiceAnswer, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	automationDeniedError,
	decideAutomationAction,
	fingerprintAutomationValue,
	grantAutomationScope,
	withAutomationLease,
} from "@oh-my-pi/pi-coding-agent/tools/automation-policy";
import { createComputerPrelude } from "@oh-my-pi/pi-coding-agent/tools/computer";
import type { ComputerRunOk, ComputerSessionSnapshot } from "@oh-my-pi/pi-coding-agent/tools/computer/protocol";
import type { ComputerController } from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import type { DecisionJudge } from "@oh-my-pi/pi-coding-agent/judgment/decision";
import type { RawObservation } from "@oh-my-pi/pi-coding-agent/tools/computer/task/observation";
import { runComputerTask } from "@oh-my-pi/pi-coding-agent/tools/computer/task/loop";
import {
	renderExpectedFocusGuard,
	type DesktopSurface,
	type SurfaceActionOutcome,
} from "@oh-my-pi/pi-coding-agent/tools/computer/task/surface";
import type {
	ComputerTaskWindowTarget,
	DesktopActionArgs,
	DesktopWindowInfo,
} from "@oh-my-pi/pi-coding-agent/tools/computer/task/types";

class PermissionController implements ComputerController {
	readonly calls: Array<{ code: string; snapshot: ComputerSessionSnapshot }> = [];
	focused = { id: "window-1", app: "Code", title: "Editor", focused: true };

	async run(code: string, _timeoutMs: number, snapshot: ComputerSessionSnapshot): Promise<ComputerRunOk> {
		this.calls.push({ code, snapshot });
		return {
			displays: [],
			returnValue: code.includes("focusedWindow")
				? this.focused
				: code.includes("windows")
					? [this.focused]
					: undefined,
			screenshots: [],
		};
	}

	async capabilities(): Promise<undefined> {
		return undefined;
	}

	async close(): Promise<void> {}
}

function fixture() {
	const session: ToolSession = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "computer.enabled": true }),
	};
	const controller = new PermissionController();
	const definition = createComputerPrelude(session, () => controller);
	return { session, controller, definition };
}

const context = { session: undefined as unknown as ToolSession, toolCallId: "permission-test" };

const taskWindow: DesktopWindowInfo = {
	id: "window-1",
	app: "Code",
	title: "Editor",
	bounds: { x: 0, y: 0, width: 800, height: 600 },
	focused: true,
};

function choiceAnswer(criteria: Record<string, string | null>, choice: string): ChoiceAnswer {
	const probabilities: Record<string, number> = {};
	for (const key in criteria) probabilities[key] = key === choice ? 1 : 0;
	return { type: "choice", choice, probabilities, confidence: 1 };
}

class PressJudge implements DecisionJudge {
	readonly kind = "online" as const;
	readonly label = "permission-fixture";

	judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		const answers: Record<string, Answer> = {};
		for (const id in request.questions) {
			const question = request.questions[id];
			if (question?.type === "noul") {
				answers[id] = { type: "noul", noul: 0.9 };
				continue;
			}
			if (question?.type !== "choice") throw new Error("unexpected judgment question");
			const entries = Object.entries(question.criteria);
			const selected =
				entries.find(([, rubric]) => typeof rubric === "string" && rubric.toLowerCase().includes("press"))?.[0] ??
				entries[0]?.[0] ??
				"";
			answers[id] = choiceAnswer(question.criteria, selected);
		}
		return Promise.resolve({
			api: "fixture",
			provider: "fixture",
			model: "fixture",
			answers,
			usage: tokenUsage(1, 1),
		} as JudgmentResult<Q>);
	}
}

class FocusRaceSurface implements DesktopSurface {
	readonly kind: "native" | "cua";
	readonly method = "fixture-reobserve";
	readonly observations: RawObservation[];
	executeCount = 0;

	constructor(focusedOnRevalidation: boolean, kind: "native" | "cua" = "native") {
		this.kind = kind;
		const node = {
			ref: "e1",
			role: "button",
			nativeRole: "AXButton",
			title: "Save",
			enabled: true,
			focused: false,
			childCount: 0,
			frame: { x: 20, y: 20, width: 80, height: 30 },
			actions: ["AXPress"],
		};
		this.observations = [
			{ window: taskWindow, nodes: [node], nodeCount: 1, truncated: false },
			{ window: { ...taskWindow, focused: focusedOnRevalidation }, nodes: [node], nodeCount: 1, truncated: false },
		];
	}

	async resolveWindow(_target: ComputerTaskWindowTarget): Promise<DesktopWindowInfo> {
		return taskWindow;
	}

	async observe(): Promise<RawObservation> {
		return (
			this.observations.shift() ??
			this.observations.at(-1) ?? { window: taskWindow, nodes: [], nodeCount: 0, truncated: false }
		);
	}

	async execute(_args: DesktopActionArgs): Promise<SurfaceActionOutcome> {
		this.executeCount++;
		return { status: "applied" };
	}
}

function taskDeps(surface: DesktopSurface) {
	return {
		surface,
		judge: new PressJudge(),
		resolveValue: async () => {
			throw new Error("value resolution is not expected");
		},
		backend: {
			kind: surface.kind,
			mode: "native" as const,
			driver: { installed: false as const, searched: [] },
			reason: "permission fixture",
		},
		budget: { maxCalls: 2, maxActions: 1, deadlineAt: Date.now() + 10_000 },
	};
}

describe("computer dispatch permissions", () => {
	it("allows inspection without a scope and runs it in worker read-only mode", async () => {
		const { session, controller, definition } = fixture();
		const result = await definition.invoke(
			{ action: "call", chain: [{ method: "windows", args: [] }] },
			{ ...context, session },
		);
		expect(result.details).toMatchObject({ value: [controller.focused] });
		expect(controller.calls).toHaveLength(1);
		expect(controller.calls[0]?.snapshot.readOnly).toBe(true);
	});

	it("denies an unscoped mutation after a fresh focus read and before its dispatch", async () => {
		const { session, controller, definition } = fixture();
		await expect(
			definition.invoke({ action: "call", chain: [{ method: "click", args: [10, 20] }] }, { ...context, session }),
		).rejects.toThrow(/^AUTOMATION_DENIED:/);
		expect(controller.calls).toHaveLength(1);
		expect(controller.calls[0]?.code).toContain("focusedWindow");
		expect(controller.calls[0]?.snapshot.readOnly).toBe(true);
	});

	it("dispatches root keyboard input only with desktop-wide action and value capabilities", async () => {
		const { session, controller, definition } = fixture();
		grantAutomationScope(session, {
			surface: "computer",
			targets: ["desktop"],
			actions: ["computer.type"],
			consequential: false,
			desktopAccess: "broad",
			valueFingerprints: [fingerprintAutomationValue("approved")],
		});
		await expect(
			definition.invoke({ action: "call", chain: [{ method: "type", args: ["changed"] }] }, { ...context, session }),
		).rejects.toThrow(/^AUTOMATION_DENIED:/);
		expect(controller.calls).toHaveLength(1);
		await definition.invoke(
			{ action: "call", chain: [{ method: "type", args: ["approved"] }] },
			{ ...context, session },
		);
		expect(controller.calls).toHaveLength(3);
		expect(controller.calls[2]?.snapshot.readOnly).toBe(false);
	});

	it("rejects a background window selector before dispatch even with a matching app scope", async () => {
		const { session, controller, definition } = fixture();
		grantAutomationScope(session, {
			surface: "computer",
			targets: ["Code"],
			actions: ["computer.click"],
			consequential: false,
		});
		await expect(
			definition.invoke(
				{
					action: "call",
					chain: [
						{ method: "window", args: ["window-2"] },
						{ method: "click", args: [1, 2] },
					],
				},
				{ ...context, session },
			),
		).rejects.toThrow(/requested window is not the focused window/);
		expect(controller.calls).toHaveLength(1);
	});

	it("requires an explicit raw action scope for writable computer.run", async () => {
		const { session, controller, definition } = fixture();
		const raw = { action: "run", code: "return 1", read_only: false };
		await expect(definition.invoke(raw, { ...context, session })).rejects.toThrow(/^AUTOMATION_DENIED:/);
		grantAutomationScope(session, {
			surface: "computer",
			targets: ["Code"],
			actions: ["computer.run"],
			consequential: false,
			rawAccess: "broad",
		});
		await definition.invoke(raw, { ...context, session });
		expect(controller.calls.at(-1)?.snapshot.readOnly).toBe(false);
	});

	it("refuses a granted mutation while another holder has the desktop lease and dispatches nothing", async () => {
		const { session, controller, definition } = fixture();
		grantAutomationScope(session, {
			surface: "computer",
			targets: ["desktop"],
			actions: ["computer.press"],
			consequential: false,
			desktopAccess: "broad",
		});
		const press = { action: "call", chain: [{ method: "press", args: ["cmd+s"] }] };
		const holding = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const held = withAutomationLease({}, async () => {
			holding.resolve();
			await release.promise;
		});
		await holding.promise;
		try {
			await expect(definition.invoke(press, { ...context, session })).rejects.toThrow(/^AUTOMATION_BUSY:/);
			expect(controller.calls).toHaveLength(0);
		} finally {
			release.resolve();
			await held;
		}
		await definition.invoke(press, { ...context, session });
		expect(controller.calls.at(-1)?.snapshot.readOnly).toBe(false);
	});

	it("blocks worker dispatch when focus flips after authorization", async () => {
		let clicks = 0;
		const guarded = renderExpectedFocusGuard("await desktop.click(); return 'clicked';", {
			id: "window-1",
			app: "Code",
		});
		const execute = new Function("desktop", `return (async () => {${guarded}})();`) as (desktop: {
			focusedWindow(): Promise<{ id: string; app: string }>;
			click(): Promise<void>;
		}) => Promise<unknown>;
		await expect(
			execute({
				focusedWindow: async () => ({ id: "window-2", app: "Mail" }),
				click: async () => {
					clicks++;
				},
			}),
		).rejects.toThrow("focused window changed before desktop dispatch");
		expect(clicks).toBe(0);
	});

	it("blocks a focus race after judgment and dispatches nothing", async () => {
		const surface = new FocusRaceSurface(false);
		let authorizeCount = 0;
		const result = await runComputerTask(
			{ goal: "press Save", window: "focused" },
			{
				...taskDeps(surface),
				authorize: () => {
					authorizeCount++;
				},
			},
		);
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("focused window changed");
		expect(authorizeCount).toBe(0);
		expect(surface.executeCount).toBe(0);
	});

	it("routes a Cua task action through the permission gate after judgment and before dispatch", async () => {
		const surface = new FocusRaceSurface(true, "cua");
		let authorizeCount = 0;
		await expect(
			runComputerTask(
				{ goal: "press Save", window: "focused" },
				{
					...taskDeps(surface),
					authorize: request => {
						authorizeCount++;
						const verdict = decideAutomationAction(
							{
								surface: "computer",
								tier: "mutate",
								action: `computer.task.${request.action.kind}`,
								target: request.window.app,
								consequential: request.consequential,
								raw: false,
								summary: "Press Save in the focused app",
							},
							{ scopes: [], now: Date.now() },
						);
						if (verdict.verdict === "deny") throw automationDeniedError(verdict);
					},
				},
			),
		).rejects.toThrow(/^AUTOMATION_DENIED:/);
		expect(authorizeCount).toBe(1);
		expect(surface.executeCount).toBe(0);
	});
});
