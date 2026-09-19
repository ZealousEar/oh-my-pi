import { type Type, type } from "@oh-my-pi/omptype";
import type { AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";
import { once, sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import { callSessionTool } from "../eval/js/tool-bridge";
import type { EvalPreludeContext, EvalPreludeDefinition } from "../eval/preludes";
import { enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { type ComputerCallStep, isReadOnlyComputerCall, renderComputerCall } from "./computer/call";
import type { ComputerScreenshot, ComputerSessionSnapshot } from "./computer/protocol";
import { type ComputerController, ComputerSupervisor, registerComputerController } from "./computer/supervisor";
import { CuaDesktopSurface, type DesktopBackendSelection, selectDesktopBackend } from "./computer/cua-backend";
import {
	type CuaDriverDetection,
	type CuaDriverExec,
	cuaSpawnEnv,
	describeCuaDriver,
	detectCuaDriver,
} from "./computer/cua-driver";
import { runComputerTask, type ComputerTaskAuthorization } from "./computer/task/loop";
import { ControllerDesktopSurface, type DesktopSurface, renderExpectedFocusGuard } from "./computer/task/surface";
import { createTextValueResolver, type TextValueResolver } from "./computer/task/text-value";
import type { ComputerTaskResult } from "./computer/task/types";
import { type JudgmentUsage, type ResolvedJudge, resolveJudge } from "../judgment";
import type { LoopBudget } from "../judgment/decision";
import { ONLINE_MEMORY_MODEL_KEY } from "../tiny/models";
import type { ToolSession } from "./index";
import { renderCallChain, renderFunctionRun } from "./run-code";
import { throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { clampTimeout } from "./tool-timeouts";
import {
	automationDeniedError,
	decideAutomationAction,
	fingerprintAutomationCode,
	fingerprintAutomationValue,
	getAutomationScopes,
	withAutomationLease,
	type AutomationAction,
} from "./automation-policy";

// Image transports that cannot preserve native screenshot detail resize frames
// without returning transformed dimensions. Keep their native coordinate frames
// below the empirically verified threshold so pointer actions match what the
// model sees. Claude paths predate the resolved transport capability and retain
// their established model-family fallback.
const COORDINATE_SAFE_MAX_CAPTURE_WIDTH = 1280;
const COORDINATE_SAFE_MAX_CAPTURE_HEIGHT = 896;

function usesCoordinateSafeImageSizing(model: Model | undefined): boolean {
	if (!model) return false;
	const compat = model.compat;
	return (
		(!!compat && "supportsImageDetailOriginal" in compat && compat.supportsImageDetailOriginal === false) ||
		model.identity.class === "anthropic" ||
		(model.requestModelId !== undefined &&
			classifyModel(model.provider, model.requestModelId, { lenient: true }).class === "anthropic")
	);
}

interface ComputerRunParams {
	action: "run";
	code?: string;
	fn?: string;
	args?: unknown[];
	read_only?: boolean;
	timeout?: number;
}

interface ComputerCallParams {
	action: "call";
	chain: ComputerCallStep[];
	timeout?: number;
}

interface ComputerTaskActionParams {
	action: "task";
	goal: string;
	app?: string;
	window?: string | { app?: string; title?: string };
	values?: Record<string, string>;
	expect?: { titleIncludes?: string; find?: { role?: string; title?: string; value?: string } };
	maxActions?: number;
	maxCalls?: number;
	timeout?: number;
	allowConsequential?: boolean;
}

type ComputerParams =
	| ComputerRunParams
	| ComputerCallParams
	| ComputerTaskActionParams
	| { action: "capabilities" }
	| { action: "close" };
type ComputerParamsSchema = Type<ComputerParams>;

const getComputerParamsSchema: () => ComputerParamsSchema = once(() =>
	type({
		action: "'run'",
		"code?": type("string").describe(
			"JavaScript executed in the persistent computer session; top-level await allowed; `desktop`, `wait`, `assert` in scope",
		),
		"fn?": type("string").describe("serialized function receiving the computer run scope and positional args"),
		"args?": type("unknown[]").describe("positional function arguments"),
		"read_only?": type("boolean").describe(
			"true = desktop inspection only: screenshots and ax reads allowed, desktop input/mutation blocked",
		),
		"timeout?": type("number").describe("run budget in seconds"),
		"+": "reject",
	})
		.or({
			action: "'call'",
			chain: type({ method: "string", args: "unknown[]" })
				.array()
				.describe("desktop helper invocation with at most one window/element handle hop"),
			"timeout?": type("number").describe("run budget in seconds"),
			"+": "reject",
		})
		.or({
			action: "'task'",
			goal: type("string").describe("what to accomplish in the target window, in one sentence"),
			"app?": type("string").describe("owning application name of the target window"),
			"window?": type("string")
				.or({ "app?": "string", "title?": "string", "+": "reject" })
				.describe('exact opaque window id, "focused", or a unique app/title filter'),
			"values?": type({ "[string]": "string" }).describe("field values the caller authorizes, by field label"),
			"expect?": type({
				"titleIncludes?": "string",
				"find?": { "role?": "string", "title?": "string", "value?": "string", "+": "reject" },
				"+": "reject",
			}).describe("independent completion checks re-observed after the loop claims completion"),
			"maxActions?": type("number").describe("desktop action bound"),
			"maxCalls?": type("number").describe("judgment call bound"),
			"timeout?": type("number").describe("wall-clock budget in seconds"),
			"allowConsequential?": type("boolean").describe(
				"offer send/delete/purchase-class actions to the loop; withheld by default",
			),
			"+": "reject",
		})
		.or({ action: "'capabilities'", "+": "reject" })
		.or({ action: "'close'", "+": "reject" }),
);

interface ComputerPreludeDetails {
	code?: string;
	readOnly?: boolean;
	screenshots: ComputerScreenshot[];
	value?: unknown;
	backend?: string;
	capturePermission?: string;
	inputPermission?: string;
	axPermission?: string;
}

/** Creates the session-scoped controller used by the computer prelude. */
export type ComputerControllerFactory = (session: ToolSession) => ComputerController;

/** Judge, value-inference, and driver seams of `computer.task`; defaults resolve from the session. */
export interface ComputerTaskFactories {
	createJudge?: (session: ToolSession) => ResolvedJudge;
	createValueResolver?: (session: ToolSession) => TextValueResolver;
	/** Cua Driver detection; defaults to probing this host. */
	detectDriver?: (session: ToolSession, signal?: AbortSignal) => Promise<CuaDriverDetection>;
	/** Subprocess runner for every driver process (probes and `call`s); defaults to a bounded spawn. */
	driverExec?: (session: ToolSession) => CuaDriverExec;
}

/** Capability inspection, explicitly read-only runs, and inspection-only direct calls use read approval. */
export function computerApproval(args: unknown): ToolApprovalDecision {
	if (args === null || typeof args !== "object" || Array.isArray(args) || !("action" in args)) return "exec";
	if (args.action === "capabilities") return "read";
	if (args.action === "call") {
		// Malformed chains fall to exec here and fail schema validation at invoke time.
		try {
			return "chain" in args && Array.isArray(args.chain) && isReadOnlyComputerCall(args.chain) ? "read" : "exec";
		} catch {
			return "exec";
		}
	}
	// A desktop goal loop always dispatches input, so it stays on the exec tier
	// alongside normal runs; its own consequential gate is enforced in the loop.
	return args.action === "run" && "read_only" in args && args.read_only === true ? "read" : "exec";
}

/** Create the enabled-only computer host prelude for one tool session. */
export function createComputerPrelude(
	session: ToolSession,
	createController: ComputerControllerFactory = currentSession =>
		new ComputerSupervisor(currentSession, undefined, undefined, callSessionTool),
	taskFactories: ComputerTaskFactories = {},
): EvalPreludeDefinition {
	const controller = createController(session);
	const unregisterOwner = registerComputerController(session.getEvalKernelOwnerId?.() ?? undefined, controller);
	// Eval-first-use boundary: source/declaration assets stay unloaded until a
	// JavaScript or Python kernel actually asks for its enabled preludes.
	const { computerPreludeAssets } = require("./computer/prelude-definition");
	let closed = false;
	const lifetime: ComputerLifetime = {
		isClosed: () => closed,
		close: async () => {
			if (closed) return;
			closed = true;
			unregisterOwner();
			await controller.close();
		},
	};

	return {
		name: "computer",
		documentation: computerPreludeAssets.documentation,
		javascript: computerPreludeAssets.javascript,
		python: computerPreludeAssets.python,
		exports: ["computer"],
		codeModeDeclarations: computerPreludeAssets.codeModeDeclarations,
		approval: computerApproval,
		automationSurface: "computer",
		enabled: () => session.settings.get("computer.enabled") === true,
		invoke: async (parameters, context) => {
			const parsed = getComputerParamsSchema()(parameters);
			if (parsed instanceof type.errors) {
				throw new ToolError(`computer received invalid arguments: ${parsed.summary}`);
			}
			return await invokeComputer(session, controller, parsed, context, lifetime, taskFactories);
		},
		status: describeComputerCall,
	};
}

/** Status-tree line for a completed computer call: `desktop.window(3).focus()`, `run(fn)`, `close`. */
function describeComputerCall(parameters: unknown): string | undefined {
	const parsed = getComputerParamsSchema()(parameters);
	if (parsed instanceof type.errors) return undefined;
	switch (parsed.action) {
		case "call":
			return `desktop.${renderCallChain(parsed.chain)}`;
		case "run":
			return `run(${parsed.fn !== undefined ? "fn" : (parsed.code?.trim().split("\n", 1)[0] ?? "")})`;
		case "task":
			return `task(${parsed.goal.trim().split("\n", 1)[0] ?? ""})`;
		case "capabilities":
		case "close":
			return parsed.action;
	}
}

interface ComputerLifetime {
	isClosed(): boolean;
	close(): Promise<void>;
}

async function invokeComputer(
	session: ToolSession,
	controller: ComputerController,
	params: ComputerParams,
	context: EvalPreludeContext,
	lifetime: ComputerLifetime,
	taskFactories: ComputerTaskFactories,
): Promise<AgentToolResult<unknown>> {
	throwIfAborted(context.signal);

	switch (params.action) {
		case "run":
		case "call": {
			const code = resolveComputerRunCode(params);
			if (lifetime.isClosed()) throw new ToolError("Computer session is closed");
			if (params.action === "call" && isReadOnlyComputerCall(params.chain)) {
				return await runComputer(session, controller, params, code, context.signal);
			}
			if (params.action === "run" && params.read_only === true) {
				return await runComputer(session, controller, params, code, context.signal);
			}
			return await withAutomationLease(
				session,
				async () => {
					const expected = await authorizeDirectComputerMutation(
						session,
						controller,
						params,
						code,
						context.toolCallId,
						context.signal,
					);
					return await runComputer(
						session,
						controller,
						params,
						renderExpectedFocusGuard(code, expected),
						context.signal,
					);
				},
				context.signal,
			);
		}
		case "task":
			if (lifetime.isClosed()) throw new ToolError("Computer session is closed");
			return await withAutomationLease(
				session,
				async () => runDesktopTask(session, controller, params, context, taskFactories),
				context.signal,
			);
		case "capabilities": {
			const capabilities = lifetime.isClosed()
				? undefined
				: await controller.capabilities(buildComputerSnapshot(session, true), context.signal);
			const driver = await resolveDriverDetection(session, context.signal, taskFactories);
			throwIfAborted(context.signal);
			const details = capabilities ? { ...capabilities, driver } : undefined;
			return {
				content: [
					{
						type: "text",
						text: details
							? stringifyReturnValue(details)
							: `Computer capabilities unavailable\n${describeCuaDriver(driver)}`,
					},
				],
				details,
			};
		}
		case "close":
			await lifetime.close();
			throwIfAborted(context.signal);
			return { content: [{ type: "text", text: "Closed computer session" }] };
	}
}

const COMPUTER_RUN_SCOPE: readonly string[] = ["desktop", "wait", "assert"];

function resolveComputerRunCode(params: ComputerRunParams | ComputerCallParams): string {
	if (params.action === "call") return renderComputerCall(params.chain);
	const code = params.code?.trim();
	const fn = params.fn?.trim();
	const hasCode = code !== undefined && code.length > 0;
	const hasFunction = fn !== undefined && fn.length > 0;
	if (hasCode === hasFunction) {
		throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
	}
	if (hasFunction && fn !== undefined) {
		return renderFunctionRun(fn, COMPUTER_RUN_SCOPE, params.args ?? []);
	}
	if (hasCode && code !== undefined) return code;
	throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
}

/** Freezes the current session settings into the snapshot every worker command carries. */
function buildComputerSnapshot(session: ToolSession, readOnly: boolean): ComputerSessionSnapshot {
	const coordinateSafe = usesCoordinateSafeImageSizing(session.getActiveModel?.());
	const configuredMaxWidth = session.settings.get("computer.maxWidth");
	const configuredMaxHeight = session.settings.get("computer.maxHeight");
	return {
		cwd: session.cwd,
		sessionId: session.getEvalSessionId?.() ?? session.getSessionId?.() ?? "computer",
		captureMaxWidth: coordinateSafe
			? Math.min(configuredMaxWidth, COORDINATE_SAFE_MAX_CAPTURE_WIDTH)
			: configuredMaxWidth,
		captureMaxHeight: coordinateSafe
			? Math.min(configuredMaxHeight, COORDINATE_SAFE_MAX_CAPTURE_HEIGHT)
			: configuredMaxHeight,
		display: session.settings.get("computer.display") ?? "all",
		readOnly,
	};
}

function computerActionName(params: ComputerRunParams | ComputerCallParams): string {
	if (params.action === "run") return "computer.run";
	return `computer.${params.chain.at(-1)?.method ?? "call"}`;
}

function directValueFingerprint(params: ComputerRunParams | ComputerCallParams): string | undefined {
	if (params.action !== "call") return undefined;
	const terminal = params.chain.at(-1);
	if (
		terminal === undefined ||
		(terminal.method !== "type" && terminal.method !== "setValue" && terminal.method !== "clipboard.write")
	) {
		return undefined;
	}
	const value = terminal.args[0];
	return typeof value === "string" ? fingerprintAutomationValue(value) : undefined;
}

async function focusedWindowForAuthorization(
	session: ToolSession,
	controller: ComputerController,
	signal?: AbortSignal,
): Promise<{ id: string; app: string; title: string }> {
	const timeoutSeconds = clampTimeout("computer", 10, session.settings.get("tools.maxTimeout"));
	const run = await controller.run(
		renderComputerCall([{ method: "focusedWindow", args: [] }]),
		timeoutSeconds * 1_000,
		buildComputerSnapshot(session, true),
		signal,
	);
	throwIfAborted(signal);
	const value = run.returnValue;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ToolError("Computer mutation denied: no focused desktop window is available.");
	}
	const id = Reflect.get(value, "id");
	const app = Reflect.get(value, "app");
	const title = Reflect.get(value, "title");
	if (
		typeof id !== "string" ||
		id.length === 0 ||
		typeof app !== "string" ||
		app.length === 0 ||
		typeof title !== "string"
	) {
		throw new ToolError("Computer mutation denied: focused desktop window identity is unavailable.");
	}
	return { id, app, title };
}

async function authorizeDirectComputerMutation(
	session: ToolSession,
	controller: ComputerController,
	params: ComputerRunParams | ComputerCallParams,
	code: string,
	invocationId: string,
	signal?: AbortSignal,
): Promise<{ id: string; app: string }> {
	const focused = await focusedWindowForAuthorization(session, controller, signal);
	if (params.action === "call" && params.chain[0]?.method === "window") {
		const requestedWindow = params.chain[0].args[0];
		if (typeof requestedWindow === "string" && requestedWindow !== focused.id) {
			throw new ToolError("Computer mutation denied: the requested window is not the focused window.");
		}
		if (requestedWindow !== null && typeof requestedWindow === "object" && !Array.isArray(requestedWindow)) {
			const app = Reflect.get(requestedWindow, "app");
			const title = Reflect.get(requestedWindow, "title");
			const contains = (actual: string, filter: unknown): boolean =>
				filter === undefined ||
				(typeof filter === "string" && actual.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
			if (!contains(focused.app, app) || !contains(focused.title, title)) {
				throw new ToolError("Computer mutation denied: the requested window is not the focused window.");
			}
		}
	}
	const desktopWide = params.action === "call" && params.chain[0]?.method !== "window";
	const valueFingerprint = directValueFingerprint(params);
	const action: AutomationAction = {
		surface: "computer",
		tier: "mutate",
		action: computerActionName(params),
		target: desktopWide ? "desktop" : focused.app,
		consequential: false,
		raw: params.action === "run",
		summary:
			params.action === "run"
				? `Run raw desktop code after verifying the focused ${focused.app} window`
				: desktopWide
					? `Call ${computerActionName(params)} with desktop-wide input`
					: `Call ${computerActionName(params)} in the focused ${focused.app} window`,
		invocationId,
		...(desktopWide ? { desktopWide: true } : {}),
		...(valueFingerprint ? { valueFingerprint } : {}),
		...(params.action === "run" ? { codeFingerprint: fingerprintAutomationCode(code) } : {}),
	};
	const verdict = decideAutomationAction(action, { scopes: getAutomationScopes(session), now: Date.now() });
	if (verdict.verdict === "deny") throw automationDeniedError(verdict);
	return focused;
}

function authorizeComputerTaskMutation(
	session: ToolSession,
	request: ComputerTaskAuthorization,
	invocationId: string,
): void {
	const action: AutomationAction = {
		surface: "computer",
		tier: "mutate",
		action: `computer.task.${request.action.kind}`,
		target: request.window.app,
		consequential: request.consequential,
		raw: false,
		summary: `Run ${request.action.kind} in the focused ${request.window.app} window`,
		invocationId,
		...(request.action.text ? { valueFingerprint: fingerprintAutomationValue(request.action.text) } : {}),
	};
	const verdict = decideAutomationAction(action, { scopes: getAutomationScopes(session), now: Date.now() });
	if (verdict.verdict === "deny") throw automationDeniedError(verdict);
}

async function runComputer(
	session: ToolSession,
	controller: ComputerController,
	params: ComputerRunParams | ComputerCallParams,
	code: string,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	// Direct inspection calls run read-only so the desktop guard backs the read approval tier.
	const readOnly = params.action === "call" ? isReadOnlyComputerCall(params.chain) : (params.read_only ?? false);
	const timeoutSeconds = clampTimeout("computer", params.timeout, session.settings.get("tools.maxTimeout"));
	const snapshot = buildComputerSnapshot(session, readOnly);
	const run = await controller.run(code, timeoutSeconds * 1000, snapshot, signal);
	throwIfAborted(signal);

	const details: ComputerPreludeDetails = {
		code,
		readOnly: snapshot.readOnly,
		screenshots: run.screenshots,
	};
	if (run.returnValue !== undefined) details.value = run.returnValue;
	populateCapabilityDetails(details, run.capabilities);

	const text = run.displays
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map(content => content.text)
		.join("\n");
	const cappedText = await enforceInlineByteCap(text, {
		saveArtifact: full => saveComputerOutputArtifact(session, full),
	});
	const content: AgentToolResult<ComputerPreludeDetails>["content"] = [];
	if (cappedText) content.push({ type: "text", text: cappedText });
	for (const image of run.displays) {
		if (image.type === "image") content.push({ ...image, detail: "original" });
	}
	return { content, details };
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function populateCapabilityDetails(
	details: ComputerPreludeDetails,
	capabilities: DesktopCapabilities | undefined,
): void {
	if (!capabilities) return;
	details.backend = capabilities.backend;
	details.capturePermission = capabilities.capturePermission;
	details.inputPermission = capabilities.inputPermission;
	details.axPermission = capabilities.axPermission;
}

/** Persist over-cap computer run output as a session artifact; mirrors the browser run save path. */
async function saveComputerOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("computer-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, fullText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

/** Detect Cua Driver for this host, honouring the injected seams in tests. */
async function resolveDriverDetection(
	session: ToolSession,
	signal: AbortSignal | undefined,
	factories: ComputerTaskFactories,
): Promise<CuaDriverDetection> {
	if (factories.detectDriver) return await factories.detectDriver(session, signal);
	return await detectCuaDriver({
		driverBin: session.settings.get("computer.driverBin"),
		telemetry: session.settings.get("computer.cua.telemetry"),
		exec: factories.driverExec?.(session),
		signal,
	});
}

/**
 * Pick the backend for one task and build its surface. `native` never probes
 * the driver; `auto` and `cua` probe it read-only and select per the
 * prerequisites, with `cua` failing closed.
 */
async function resolveDesktopBackend(
	session: ToolSession,
	controller: ComputerController,
	budget: LoopBudget,
	signal: AbortSignal | undefined,
	factories: ComputerTaskFactories,
): Promise<{ backend: DesktopBackendSelection; surface: DesktopSurface }> {
	const settings = session.settings;
	const mode = settings.get("computer.task.backend");
	const driver: CuaDriverDetection =
		mode === "native" ? { installed: false, searched: [] } : await resolveDriverDetection(session, signal, factories);
	const backend = selectDesktopBackend(mode, driver);
	const remaining = (): number => budget.deadlineAt - Date.now();
	if (backend.kind === "cua" && driver.installed) {
		return {
			backend,
			surface: new CuaDesktopSurface({
				driverPath: driver.path,
				env: cuaSpawnEnv(settings.get("computer.cua.telemetry")),
				exec: factories.driverExec?.(session),
				timeoutMs: remaining,
			}),
		};
	}
	return {
		backend,
		surface: new ControllerDesktopSurface(
			controller,
			readOnly => buildComputerSnapshot(session, readOnly),
			remaining,
		),
	};
}

/** Record a judgment or value-inference attempt on the session usage ledger when one is reachable. */
function taskUsageRecorder(session: ToolSession): ((usage: JudgmentUsage) => void) | undefined {
	const manager = session.sessionManager;
	const appendModelUsage = manager?.appendModelUsage;
	const getSessionId = manager?.getSessionId;
	const getLeafId = manager?.getLeafId;
	if (!manager || !appendModelUsage || !getSessionId || !getLeafId) return undefined;
	const owner = { sessionId: getSessionId.call(manager), parentId: getLeafId.call(manager) };
	return usage => {
		const entryId = appendModelUsage.call(manager, { purpose: "computer-task", ...usage }, owner);
		if (entryId) owner.parentId = entryId;
	};
}

/**
 * Run one desktop goal loop. The judge, the value route, and the driver probe
 * are resolved from the session here so the loop itself stays pure and
 * testable; the loop drives the session's existing computer controller.
 */
async function runDesktopTask(
	session: ToolSession,
	controller: ComputerController,
	params: ComputerTaskActionParams,
	context: EvalPreludeContext,
	factories: ComputerTaskFactories,
): Promise<AgentToolResult<unknown>> {
	const settings = session.settings;
	const registry = session.modelRegistry;
	const onUsage = taskUsageRecorder(session);
	const sessionId = session.getSessionId?.() ?? undefined;
	let judge: ResolvedJudge;
	if (factories.createJudge) {
		judge = factories.createJudge(session);
	} else {
		if (!registry) throw new ToolError("computer.task requires a model registry in this session");
		judge = resolveJudge({
			settings,
			registry,
			backend: ONLINE_MEMORY_MODEL_KEY,
			sessionModel: session.getActiveModel?.(),
			sessionId,
			onUsage,
		});
	}
	let resolveValue: TextValueResolver;
	if (factories.createValueResolver) {
		resolveValue = factories.createValueResolver(session);
	} else {
		if (!registry) throw new ToolError("computer.task requires a model registry in this session");
		resolveValue = createTextValueResolver({ settings, registry, sessionId, onUsage });
	}
	const timeoutSeconds = clampTimeout(
		"computer",
		params.timeout ?? settings.get("computer.task.deadlineSec"),
		settings.get("tools.maxTimeout"),
	);
	const budget: LoopBudget = {
		maxCalls: Math.max(1, Math.trunc(params.maxCalls ?? settings.get("computer.task.maxCalls"))),
		maxActions: Math.max(1, Math.trunc(params.maxActions ?? settings.get("computer.task.maxActions"))),
		deadlineAt: Date.now() + timeoutSeconds * 1_000,
		signal: context.signal,
	};
	const { backend, surface } = await resolveDesktopBackend(session, controller, budget, context.signal, factories);
	const result = await runComputerTask(
		{
			goal: params.goal,
			app: params.app,
			window: params.window,
			values: params.values,
			expect: params.expect,
			allowConsequential: params.allowConsequential ?? settings.get("computer.task.allowConsequential"),
		},
		{
			surface,
			judge,
			resolveValue,
			backend,
			budget,
			signal: context.signal,
			authorize: request => authorizeComputerTaskMutation(session, request, context.toolCallId),
		},
	);
	throwIfAborted(context.signal);
	const details: ComputerPreludeDetails = { screenshots: [], value: result };
	return { content: [{ type: "text", text: summarizeDesktopTask(result) }], details };
}

/** One line of tool text from window-derived content: control characters stripped, newlines collapsed, bounded. */
function taskLine(text: string, maxChars = 200): string {
	return truncate(
		sanitizeText(text)
			.replace(/[\r\n\t]+/g, " ")
			.replace(/ {2,}/g, " ")
			.trim(),
		maxChars,
	);
}

/** Human-readable summary of a desktop task; the full result stays in `details.value`. */
function summarizeDesktopTask(result: ComputerTaskResult): string {
	const lines = [
		`task ${result.status}${result.reason ? `: ${taskLine(result.reason, 400)}` : ""}`,
		`goal: ${taskLine(result.goal, 400)}`,
		`window: ${result.window.id} ${taskLine(result.window.app, 80)} ${JSON.stringify(taskLine(result.window.title, 120))}`,
		`budget: ${result.budget.actions}/${result.budget.maxActions} actions, ${result.budget.calls}/${result.budget.maxCalls} judgment calls, ${result.observationRevisions} observations`,
		`verification: ${String(result.verification.verified)} via ${result.verification.method}${result.verification.detail ? ` (${taskLine(result.verification.detail, 300)})` : ""}`,
		`judge: ${result.backend.judge.label} ${result.backend.judge.model} (${result.backend.judge.distribution})${result.backend.judge.fallback ? ` [fallback from ${result.backend.judge.fallback.from}]` : ""}`,
		`backend: ${result.backend.kind} (computer.task.backend=${result.backend.mode}; ${taskLine(result.backend.reason, 300)})`,
		result.backend.mode === "native"
			? "cua-driver: not probed"
			: taskLine(describeCuaDriver(result.backend.driver), 400),
	];
	for (const step of result.steps) {
		const outcome = step.outcome;
		const why = outcome.status === "applied" ? outcome.detail : outcome.reason;
		lines.push(
			`  ${step.index}. ${taskLine(step.label)} -> ${outcome.status}${why ? ` (${taskLine(why)})` : ""}${step.reconciliation ? ` [${taskLine(step.reconciliation)}]` : ""}`,
		);
	}
	for (const note of result.notes) lines.push(`note: ${taskLine(note, 400)}`);
	return lines.join("\n");
}
