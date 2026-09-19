/**
 * The desktop surface the goal loop drives: window resolution, structured
 * observation, and action dispatch.
 *
 * The native surface goes through the existing allowlisted call chains of the
 * one {@link ComputerController} the session already owns, so the loop
 * inherits the supervisor's timeout, cancellation, and worker-recycle lifecycle
 * and never opens a second worker or a second input path. The Cua Driver
 * surface (`../cua-backend`) implements the same contract over the user's
 * running driver daemon.
 */
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ExecutionOutcome } from "../../../judgment/decision";
import { type ComputerCallStep, renderComputerCall } from "../call";
import type { ComputerSessionSnapshot } from "../protocol";
import type { ComputerController } from "../supervisor";
import { parseRawObservation, type RawObservation } from "./observation";
import type { DesktopActionArgs, DesktopWindowInfo, ComputerTaskWindowTarget } from "./types";

/** How an action dispatch failed, in {@link ExecutionOutcome} terms. */
export type ActionFailure = "stale" | "rejected" | "unknown";

/**
 * What a surface reports for one dispatch. A `stale` outcome names the reason
 * only; the loop attaches the observation it revalidated against.
 */
export type SurfaceActionOutcome = Exclude<ExecutionOutcome, { status: "stale" }> | { status: "stale"; reason: string };

const STALE_ERROR = /stale\s?ref|no element|element not found|invalid ref|unknown ref|generation/i;
const REJECTED_ERROR =
	/permissiondenied|permission is not granted|not supported|unsupported|read-only run|axunsupported|no actions|backgroundunavailable|background input unavailable/i;

/**
 * Classify a native dispatch error. Anything that is neither a stale reference
 * nor an outright refusal is `unknown`: the action may have landed, so the
 * loop must re-observe and reconcile instead of retrying.
 */
export function classifyActionError(error: unknown): ActionFailure {
	const message = error instanceof Error ? error.message : String(error);
	if (STALE_ERROR.test(message)) return "stale";
	if (REJECTED_ERROR.test(message)) return "rejected";
	return "unknown";
}

export interface DesktopSurface {
	/** Backend identity carried into the task result. */
	readonly kind: "native" | "cua";
	/** Prefix of every verification method string this surface's re-observation yields. */
	readonly method: string;
	resolveWindow(target: ComputerTaskWindowTarget, signal?: AbortSignal): Promise<DesktopWindowInfo>;
	observe(windowId: string, maxNodes: number, signal?: AbortSignal): Promise<RawObservation>;
	/** Dispatch one validated action; every failure is a typed outcome, never a thrown string. */
	execute(
		args: DesktopActionArgs,
		expectedWindow: Pick<DesktopWindowInfo, "id" | "app">,
		signal?: AbortSignal,
	): Promise<SurfaceActionOutcome>;
}

/** Per-call worker budget; the loop deadline clamps it further. */

/** Place an identity assertion in the same worker program immediately before a desktop mutation. */
export function renderExpectedFocusGuard(code: string, expectedWindow: Pick<DesktopWindowInfo, "id" | "app">): string {
	const expected = JSON.stringify(expectedWindow);
	return `const __ompExpectedWindow = ${expected};
const __ompFocusedWindow = await desktop.focusedWindow();
if (!__ompFocusedWindow || __ompFocusedWindow.id !== __ompExpectedWindow.id || __ompFocusedWindow.app !== __ompExpectedWindow.app) {
	throw new Error("PermissionDenied: focused window changed before desktop dispatch");
}
return await (async () => {
${code}
})();`;
}
const CALL_TIMEOUT_MS = 30_000;

export class ControllerDesktopSurface implements DesktopSurface {
	readonly kind = "native" as const;
	readonly method = "ax-reobserve";
	readonly #controller: ComputerController;
	readonly #snapshot: (readOnly: boolean) => ComputerSessionSnapshot;
	readonly #timeoutMs: () => number;

	constructor(
		controller: ComputerController,
		snapshot: (readOnly: boolean) => ComputerSessionSnapshot,
		timeoutMs: () => number = () => CALL_TIMEOUT_MS,
	) {
		this.#controller = controller;
		this.#snapshot = snapshot;
		this.#timeoutMs = timeoutMs;
	}

	async #call(
		chain: ComputerCallStep[],
		readOnly: boolean,
		signal?: AbortSignal,
		expectedWindow?: Pick<DesktopWindowInfo, "id" | "app">,
	): Promise<unknown> {
		const code = renderComputerCall(chain);
		const run = await this.#controller.run(
			expectedWindow ? renderExpectedFocusGuard(code, expectedWindow) : code,
			Math.max(1_000, Math.min(CALL_TIMEOUT_MS, this.#timeoutMs())),
			this.#snapshot(readOnly),
			signal,
		);
		return run.returnValue;
	}

	async resolveWindow(target: ComputerTaskWindowTarget, signal?: AbortSignal): Promise<DesktopWindowInfo> {
		if (target === "focused") {
			const focused = await this.#call([{ method: "focusedWindow", args: [] }], true, signal);
			const window = asWindow(focused);
			if (!window) throw new ToolError("computer.task: no window currently holds focus");
			return window;
		}
		if (typeof target === "string") {
			const window = asWindow(await this.#call([{ method: "window", args: [target] }], true, signal));
			if (!window) throw new ToolError(`computer.task: no window matches id ${JSON.stringify(target)}`);
			return window;
		}
		const listed = await this.#call([{ method: "windows", args: [target] }], true, signal);
		const matches = Array.isArray(listed)
			? listed.map(asWindow).filter((window): window is DesktopWindowInfo => window !== undefined)
			: [];
		if (matches.length === 0) {
			throw new ToolError(`computer.task: no window matches ${JSON.stringify(target)}`);
		}
		if (matches.length > 1) {
			const candidates = matches
				.map(window => `${window.id} ${window.app} ${JSON.stringify(window.title)}`)
				.join("\n");
			throw new ToolError(
				`computer.task: ${matches.length} windows match ${JSON.stringify(target)}; pass an exact window id:\n${candidates}`,
			);
		}
		return matches[0]!;
	}

	async observe(windowId: string, maxNodes: number, signal?: AbortSignal): Promise<RawObservation> {
		const payload = await this.#call(
			[
				{ method: "window", args: [windowId] },
				{ method: "observe", args: [{ maxNodes }] },
			],
			true,
			signal,
		);
		return parseRawObservation(payload);
	}

	async execute(
		args: DesktopActionArgs,
		expectedWindow: Pick<DesktopWindowInfo, "id" | "app">,
		signal?: AbortSignal,
	): Promise<SurfaceActionOutcome> {
		const ref = args.ref;
		if (ref === undefined) return { status: "rejected", reason: `${args.kind} action carries no element ref` };
		const root: ComputerCallStep = { method: "ref", args: [ref] };
		let chain: ComputerCallStep[];
		switch (args.kind) {
			case "press":
			case "scroll-to-visible":
				chain = [root, { method: "perform", args: [args.axAction ?? "press"] }];
				break;
			case "click":
				chain = [root, { method: "click", args: [] }];
				break;
			case "focus":
				chain = [root, { method: "focus", args: [] }];
				break;
			case "set-value":
				if (args.text === undefined) return { status: "rejected", reason: "set-value action carries no text" };
				chain = [root, { method: "setValue", args: [args.text] }];
				break;
			default:
				return { status: "rejected", reason: `${args.kind} is not a dispatchable desktop action` };
		}
		try {
			await this.#call(chain, false, signal, expectedWindow);
			return { status: "applied" };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { status: classifyActionError(error), reason };
		}
	}
}

/**
 * Narrow a window value from the worker. `window()` returns a handle snapshot
 * with nested `bounds`; `windows()` returns native roster entries with flat
 * `x/y/width/height`. Both are accepted.
 */
function asWindow(value: unknown): DesktopWindowInfo | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	if (typeof source.id !== "string") return undefined;
	const nested = source.bounds;
	const rect: Record<string, unknown> = nested !== null && typeof nested === "object" ? { ...nested } : source;
	const number = (field: string): number => (typeof rect[field] === "number" ? (rect[field] as number) : 0);
	return {
		id: source.id,
		app: typeof source.app === "string" ? source.app : "",
		title: typeof source.title === "string" ? source.title : "",
		pid: typeof source.pid === "number" ? source.pid : undefined,
		bounds: { x: number("x"), y: number("y"), width: number("width"), height: number("height") },
		focused: source.focused === true,
	};
}
