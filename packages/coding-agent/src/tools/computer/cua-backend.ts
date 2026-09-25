/**
 * Cua Driver action backend for `computer.task`.
 *
 * Every driver interaction is one bounded one-shot `cua-driver call <tool>
 * '<json>'` subprocess against the daemon the user already runs; omp never
 * starts the daemon, never opens the driver's MCP stdio server, and never
 * grants a permission. The wire contract this file encodes is the driver's
 * own (Cua Driver 0.28.2, `docs/content/docs/reference/cua-driver/`):
 *
 * - `list_windows` -> `{ windows: [{ window_id, pid, app_name, title, bounds,
 *   is_on_screen, z_index, ... }] }` (mcp-tools.mdx, contract/manifest.json).
 * - `get_window_state { pid, window_id, include_screenshot: false,
 *   max_elements }` -> `{ snapshot_id, elements: [{ element_index,
 *   element_token, role, label?, value?, enabled?, actions?, frame? }],
 *   element_count, truncated, degraded?, window_bounds, app_name,
 *   window_title }`; a vanished window is refused with `window_id_not_found`.
 * - `click { target: { kind: "window", pid, window_id }, element_token,
 *   delivery_mode: "background", action? }` and `set_value { pid,
 *   element_token, value }` return the closed action result
 *   `{ effect, route, delivery?, evidence?, escalation? }`
 *   (docs/action-result-contract.md); refusals are `{ status: "refused",
 *   refusal: { code, message } }` or `{ code, effect: "refused" }`.
 * - `cua-driver call` prints `structuredContent` as JSON on stdout and exits
 *   0 even for an `isError` result; a daemon that is absent, incompatible, or
 *   still inside its permission gate fails on stderr with a non-zero exit
 *   (rust/crates/cua-driver/src/cli.rs `run_call`, serve.rs
 *   `invoke_daemon_tool`).
 *
 * Element tokens (`s<8 hex>:<index>`) are minted per `get_window_state`
 * snapshot and superseded by the next snapshot of the same window
 * (cua-driver-core `element_token.rs`, `element_cache.rs`), which is exactly
 * the freshness rule the goal loop already enforces: it re-observes
 * immediately before dispatch and dispatches the fresh token.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ExecResult } from "../../exec/exec";
import {
	CUA_DRIVER_PREREQUISITES,
	type CuaDriverDetection,
	type CuaDriverExec,
	type CuaDriverPermissions,
	type CuaSpawnEnv,
	runCuaDriver,
} from "./cua-driver";
import { DIALOG_ROLES, type RawObservation } from "./task/observation";
import type { DesktopSurface, SurfaceActionOutcome } from "./task/surface";
import type { ComputerTaskWindowTarget, DesktopActionArgs, DesktopNode, DesktopWindowInfo } from "./task/types";

/** `computer.task.backend` setting. */
export type DesktopBackendMode = "auto" | "native" | "cua";

/** The path that actually executes actions; only one ever runs in a task. */
export type DesktopBackendKind = "native" | "cua";

export interface DesktopBackendSelection {
	kind: DesktopBackendKind;
	mode: DesktopBackendMode;
	driver: CuaDriverDetection;
	/** Driver version the selection was made against; present whenever the driver is installed. */
	version?: string;
	/** Grant snapshot the selection was made against; present whenever the driver is installed. */
	permissions?: CuaDriverPermissions;
	/** Why this backend was chosen, for the task result. */
	reason: string;
}

/**
 * Choose the backend for one task. `auto` takes the driver only when every
 * prerequisite holds; `cua` is a hard requirement that fails closed naming
 * exactly what is missing; `native` never consults the driver.
 */
export function selectDesktopBackend(mode: DesktopBackendMode, driver: CuaDriverDetection): DesktopBackendSelection {
	const snapshot = driver.installed ? { version: driver.version, permissions: driver.permissions } : {};
	if (mode === "native") {
		return { kind: "native", mode, driver, ...snapshot, reason: "computer.task.backend is native" };
	}
	if (driver.installed && driver.usable) {
		return { kind: "cua", mode, driver, ...snapshot, reason: `Cua Driver ${driver.version} is usable` };
	}
	const blockers = driver.installed
		? driver.blockers
		: [`Cua Driver is not installed (searched ${driver.searched.join(", ")})`];
	if (mode === "auto") {
		return { kind: "native", mode, driver, ...snapshot, reason: `Cua Driver unavailable: ${blockers.join("; ")}` };
	}
	const lines = [
		"computer.task.backend is 'cua' but the Cua Driver cannot run this task:",
		...blockers.map(blocker => `- ${blocker}`),
	];
	if (driver.installed && driver.remediation) lines.push("", driver.remediation);
	lines.push("", CUA_DRIVER_PREREQUISITES);
	throw new ToolError(lines.join("\n"));
}

// ── Request contract ────────────────────────────────────────────────────────

/** `format_token` in cua-driver-core `element_token.rs`: `s` + 8 hex digits + `:` + element index. */
const ELEMENT_TOKEN_RE = /^s[0-9a-f]{8}:\d+$/;

/** `click.action` enum (mcp-tools.mdx): the AX actions the driver performs by name. */
const CLICK_ACTIONS: Record<string, CuaClickAction> = {
	axpress: "press",
	press: "press",
	axconfirm: "confirm",
	confirm: "confirm",
	axpick: "pick",
	pick: "pick",
	axcancel: "cancel",
	cancel: "cancel",
	axopen: "open",
	open: "open",
	axshowmenu: "show_menu",
	show_menu: "show_menu",
};

export type CuaClickAction = "press" | "show_menu" | "pick" | "confirm" | "cancel" | "open";

export type CuaWindowTarget = {
	kind: "window";
	pid: number;
	window_id: number;
};

export type CuaClickRequest = {
	target: CuaWindowTarget;
	element_token: string;
	delivery_mode: "background";
	action?: CuaClickAction;
};

export type CuaSetValueRequest = {
	pid: number;
	window_id: number;
	element_token: string;
	value: string;
};

export type CuaDispatch = { tool: "click"; args: CuaClickRequest } | { tool: "set_value"; args: CuaSetValueRequest };

/** Window identity as the driver addresses it. */
export interface CuaWindowIdentity {
	pid: number;
	windowId: number;
}

/**
 * Validate one locally derived action against the driver's request schema
 * before anything is spawned. A candidate the driver cannot express is
 * `rejected` here, never guessed into a different tool.
 */
export function buildCuaDispatch(
	args: DesktopActionArgs,
	window: CuaWindowIdentity,
): { ok: true; dispatch: CuaDispatch } | { ok: false; reason: string } {
	if (!Number.isSafeInteger(window.pid) || window.pid <= 0) {
		return { ok: false, reason: `window pid ${String(window.pid)} is not a positive integer` };
	}
	if (!Number.isSafeInteger(window.windowId) || window.windowId <= 0) {
		return { ok: false, reason: `window id ${String(window.windowId)} is not a positive integer` };
	}
	const token = args.ref;
	if (token === undefined || !ELEMENT_TOKEN_RE.test(token)) {
		return { ok: false, reason: `element ref ${JSON.stringify(token ?? "")} is not a Cua element_token` };
	}
	switch (args.kind) {
		case "press": {
			const action = CLICK_ACTIONS[(args.axAction ?? "press").toLowerCase()];
			if (action === undefined) {
				return {
					ok: false,
					reason: `Cua Driver click exposes no ${JSON.stringify(args.axAction)} action (accepts press, show_menu, pick, confirm, cancel, open)`,
				};
			}
			return {
				ok: true,
				dispatch: {
					tool: "click",
					args: {
						target: { kind: "window", pid: window.pid, window_id: window.windowId },
						element_token: token,
						delivery_mode: "background",
						action,
					},
				},
			};
		}
		case "click":
			return {
				ok: true,
				dispatch: {
					tool: "click",
					args: {
						target: { kind: "window", pid: window.pid, window_id: window.windowId },
						element_token: token,
						delivery_mode: "background",
					},
				},
			};
		case "set-value":
			if (typeof args.text !== "string") return { ok: false, reason: "set-value action carries no text" };
			return {
				ok: true,
				dispatch: {
					tool: "set_value",
					args: { pid: window.pid, window_id: window.windowId, element_token: token, value: args.text },
				},
			};
		case "focus":
			return { ok: false, reason: "Cua Driver exposes no focus tool; focus is a side effect of its input tools" };
		case "scroll-to-visible":
			return {
				ok: false,
				reason: "Cua Driver exposes no AXScrollToVisible action; its scroll tool synthesizes wheel events instead",
			};
		default:
			return { ok: false, reason: `${args.kind} is not a dispatchable desktop action` };
	}
}

// ── Response contract ───────────────────────────────────────────────────────

export type CuaCallResult =
	| { ok: true; structured: Record<string, unknown> }
	| { ok: false; failure: "rejected" | "stale" | "unknown"; reason: string };

/** Refusal codes that mean the addressed element or window no longer resolves. */
const STALE_CODES = new Set([
	"stale_element_token",
	"generation_mismatch",
	"invalid_element_token",
	"conflicting_element_target",
	"window_id_not_found",
	"window_target_not_found",
	"window_owner_pid_mismatch",
	"ambiguous_window_target",
]);

/** stderr of a `call` that never reached the actuator. */
const NOT_DISPATCHED_RE =
	/not running|incompatible|unknown tool|permissions_pending|policy|authoriz|denied|has ended|requires|invalid/i;

/** Exit codes the daemon uses for refusals raised before any tool ran (serve.rs). */
const NOT_DISPATCHED_EXIT_CODES = new Set([64, 75, 77]);

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Refusal shape of a structured payload, if it is one. */
export function cuaRefusal(structured: Record<string, unknown>): { code: string; message: string } | undefined {
	const refusal = record(structured.refusal);
	if (structured.status === "refused" && refusal) {
		return {
			code: typeof refusal.code === "string" ? refusal.code : "refused",
			message: typeof refusal.message === "string" ? refusal.message : "refused by the driver",
		};
	}
	if (structured.effect === "refused" || typeof structured.code === "string") {
		const code = typeof structured.code === "string" ? structured.code : "refused";
		const message = typeof structured.message === "string" ? structured.message : `refused by the driver (${code})`;
		return { code, message };
	}
	return undefined;
}

/**
 * Interpret one `cua-driver call` process result. Exit 0 with JSON on stdout
 * is the daemon's answer, refusals included; anything else never reached the
 * actuator unless the process was cut off mid-call.
 */
export function parseCuaCallOutput(tool: string, result: ExecResult): CuaCallResult {
	if (result.killed) {
		return { ok: false, failure: "unknown", reason: `cua-driver call ${tool} was cut off before it answered` };
	}
	const stderr = result.stderr.trim();
	if (result.code !== 0) {
		const notDispatched = NOT_DISPATCHED_EXIT_CODES.has(result.code) || NOT_DISPATCHED_RE.test(stderr);
		return {
			ok: false,
			failure: notDispatched ? "rejected" : "unknown",
			reason: `cua-driver call ${tool} exited ${result.code}: ${stderr || result.stdout.trim() || "no output"}`,
		};
	}
	const stdout = result.stdout.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		parsed = undefined;
	}
	const structured = record(parsed);
	if (!structured) {
		return {
			ok: false,
			failure: "unknown",
			reason: `cua-driver call ${tool} returned no structured result: ${stdout || stderr || "no output"}`,
		};
	}
	const refusal = cuaRefusal(structured);
	if (refusal) {
		return {
			ok: false,
			failure: STALE_CODES.has(refusal.code) ? "stale" : "rejected",
			reason: `${refusal.code}: ${refusal.message}`,
		};
	}
	return { ok: true, structured };
}

/** Map the closed action result to the loop's outcome vocabulary. */
export function interpretCuaActionResult(tool: string, structured: Record<string, unknown>): SurfaceActionOutcome {
	const effect = structured.effect;
	const route = typeof structured.route === "string" ? structured.route : "unknown route";
	const escalation = record(structured.escalation);
	const hint = escalation
		? ` (driver suggests ${String(escalation.target ?? escalation.recommended ?? "?")}: ${String(escalation.reason ?? "")})`
		: "";
	switch (effect) {
		case "confirmed":
			return { status: "applied", detail: `${tool} confirmed via ${route}` };
		case "suspected_noop":
			return { status: "applied", detail: `${tool} reached ${route} but the driver suspects a no-op${hint}` };
		case "unverifiable":
		case "partial":
			return { status: "unknown", reason: `${tool} effect ${effect} via ${route}${hint}` };
		default:
			return { status: "unknown", reason: `${tool} returned no action effect` };
	}
}

// ── Observation contract ────────────────────────────────────────────────────

/** Native AX role -> the loop's role vocabulary (`AXPopUpButton` -> `popupbutton`). */
const ROLE_ALIASES: Record<string, string> = { radiobutton: "radio" };

export function normaliseCuaRole(role: string): string {
	const stripped = (role.startsWith("AX") ? role.slice(2) : role).toLowerCase();
	return ROLE_ALIASES[stripped] ?? stripped;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseBounds(value: unknown): DesktopWindowInfo["bounds"] | undefined {
	const source = record(value);
	if (!source) return undefined;
	const x = finiteNumber(source.x);
	const y = finiteNumber(source.y);
	const width = finiteNumber(source.width);
	const height = finiteNumber(source.height);
	return x !== undefined && y !== undefined && width !== undefined && height !== undefined
		? { x, y, width, height }
		: undefined;
}

/** `list_windows` payload -> the loop's window roster; the frontmost on-screen window is `focused`. */
export function parseCuaWindows(structured: Record<string, unknown>): DesktopWindowInfo[] {
	const entries = Array.isArray(structured.windows) ? structured.windows : [];
	let topZ: number | undefined;
	const parsed: Array<{ window: DesktopWindowInfo; z: number | undefined; onScreen: boolean }> = [];
	for (const entry of entries) {
		const source = record(entry);
		if (!source) continue;
		const windowId = finiteNumber(source.window_id);
		const pid = finiteNumber(source.pid);
		const bounds = parseBounds(source.bounds);
		if (windowId === undefined || pid === undefined || !bounds) continue;
		const z = finiteNumber(source.z_index);
		const onScreen = source.is_on_screen === true;
		if (onScreen && z !== undefined && (topZ === undefined || z > topZ)) topZ = z;
		parsed.push({
			window: {
				id: String(windowId),
				app: optionalString(source.app_name) ?? "",
				title: optionalString(source.title) ?? "",
				pid,
				bounds,
				focused: false,
			},
			z,
			onScreen,
		});
	}
	return parsed.map(entry => ({
		...entry.window,
		focused: entry.onScreen && entry.z !== undefined && entry.z === topZ,
	}));
}

function parseElement(value: unknown, container: string | undefined): DesktopNode | undefined {
	const source = record(value);
	if (!source || typeof source.role !== "string") return undefined;
	const token = optionalString(source.element_token);
	if (!token) return undefined;
	const frame = record(source.frame);
	const x = frame ? finiteNumber(frame.x) : undefined;
	const y = frame ? finiteNumber(frame.y) : undefined;
	const w = frame ? finiteNumber(frame.w) : undefined;
	const h = frame ? finiteNumber(frame.h) : undefined;
	return {
		ref: token,
		role: normaliseCuaRole(source.role),
		nativeRole: source.role,
		title: optionalString(source.label),
		description: undefined,
		value: optionalString(source.value),
		enabled: source.enabled !== false,
		focused: false,
		childCount: 0,
		frame:
			x !== undefined && y !== undefined && w !== undefined && h !== undefined
				? { x, y, width: w, height: h }
				: undefined,
		actions: Array.isArray(source.actions)
			? source.actions.filter((action): action is string => typeof action === "string")
			: [],
		container,
	};
}

/**
 * Nearest sheet/dialog/alert ancestor of each element, walked through
 * `parent_index` (the nearest *actionable* ancestor the driver rendered; a
 * container without actions is invisible here, which the gate's
 * observation-level check compensates for).
 */
function containerByIndex(elements: unknown[]): Map<number, string> {
	const roles = new Map<number, { role: string; parent: number | undefined }>();
	for (const entry of elements) {
		const source = record(entry);
		const index = source ? finiteNumber(source.element_index) : undefined;
		if (!source || index === undefined || typeof source.role !== "string") continue;
		roles.set(index, { role: normaliseCuaRole(source.role), parent: finiteNumber(source.parent_index) });
	}
	const containers = new Map<number, string>();
	for (const [index, entry] of roles) {
		let parent = entry.parent;
		for (let hops = 0; parent !== undefined && hops < roles.size; hops++) {
			const ancestor = roles.get(parent);
			if (!ancestor) break;
			if (Object.hasOwn(DIALOG_ROLES, ancestor.role)) {
				containers.set(index, ancestor.role);
				break;
			}
			parent = ancestor.parent;
		}
	}
	return containers;
}

/** `get_window_state` payload -> one raw observation of the addressed window. */
export function parseCuaWindowState(
	structured: Record<string, unknown>,
	window: CuaWindowIdentity,
	fallback: Pick<DesktopWindowInfo, "app" | "title" | "bounds" | "focused">,
): RawObservation {
	const elements = Array.isArray(structured.elements) ? structured.elements : [];
	const containers = containerByIndex(elements);
	const nodes: DesktopNode[] = [];
	for (const entry of elements) {
		const source = record(entry);
		const index = source ? finiteNumber(source.element_index) : undefined;
		const node = parseElement(entry, index === undefined ? undefined : containers.get(index));
		if (node) nodes.push(node);
	}
	if (structured.degraded === true) {
		logger.debug("computer.task: cua get_window_state degraded", {
			windowId: window.windowId,
			reason: structured.degraded_reason,
		});
	}
	return {
		window: {
			id: String(window.windowId),
			app: optionalString(structured.app_name) ?? fallback.app,
			title: optionalString(structured.window_title) ?? fallback.title,
			pid: window.pid,
			bounds: parseBounds(structured.window_bounds) ?? fallback.bounds,
			focused: fallback.focused,
		},
		nodes,
		nodeCount: finiteNumber(structured.element_count) ?? nodes.length,
		truncated: structured.truncated === true || structured.elements_complete === false,
	};
}

// ── Surface ─────────────────────────────────────────────────────────────────

/** Per-call subprocess budget; `get_window_state` walks may take up to 20 s by the driver's own account. */
const CALL_TIMEOUT_MS = 30_000;

export interface CuaDesktopSurfaceOptions {
	/** Resolved driver executable from detection. */
	driverPath: string;
	/** Complete child environment for every spawned driver process (see `cuaSpawnEnv`). */
	env: CuaSpawnEnv;
	exec?: CuaDriverExec;
	/** Remaining loop budget; clamps the per-call timeout. */
	timeoutMs?: () => number;
}

interface ResolvedCuaWindow extends CuaWindowIdentity {
	info: DesktopWindowInfo;
}

/** The goal loop's desktop surface, driven through the user's running Cua Driver daemon. */
export class CuaDesktopSurface implements DesktopSurface {
	readonly kind = "cua" as const;
	readonly method = "cua-reobserve";
	readonly #driverPath: string;
	readonly #env: CuaSpawnEnv;
	readonly #exec: CuaDriverExec;
	readonly #timeoutMs: () => number;
	/** Windows this surface has resolved, by the loop's opaque id. */
	readonly #windows = new Map<string, ResolvedCuaWindow>();
	/** The window the last observation addressed; actions dispatch against it. */
	#current?: ResolvedCuaWindow;

	constructor(options: CuaDesktopSurfaceOptions) {
		this.#driverPath = options.driverPath;
		this.#env = options.env;
		this.#exec = options.exec ?? runCuaDriver;
		this.#timeoutMs = options.timeoutMs ?? (() => CALL_TIMEOUT_MS);
	}

	async #call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaCallResult> {
		const timeoutMs = Math.max(1_000, Math.min(CALL_TIMEOUT_MS, this.#timeoutMs()));
		let result: ExecResult;
		try {
			result = await this.#exec(
				this.#driverPath,
				["call", tool, JSON.stringify(args)],
				timeoutMs,
				this.#env,
				signal,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, failure: "unknown", reason: `cua-driver call ${tool} could not be run: ${message}` };
		}
		return parseCuaCallOutput(tool, result);
	}

	/** Read-only inventory through `list_windows`; a failure here is a hard error, never an empty desktop. */
	async #listWindows(signal?: AbortSignal): Promise<DesktopWindowInfo[]> {
		const listed = await this.#call("list_windows", {}, signal);
		if (!listed.ok) throw new ToolError(`computer.task: ${listed.reason}`);
		const windows = parseCuaWindows(listed.structured);
		for (const window of windows) {
			this.#windows.set(window.id, { pid: window.pid ?? 0, windowId: Number(window.id), info: window });
		}
		return windows;
	}

	async resolveWindow(target: ComputerTaskWindowTarget, signal?: AbortSignal): Promise<DesktopWindowInfo> {
		const windows = await this.#listWindows(signal);
		if (target === "focused") {
			const focused = windows.find(window => window.focused);
			if (!focused) throw new ToolError("computer.task: the driver reports no frontmost on-screen window");
			return focused;
		}
		if (typeof target === "string") {
			const window = windows.find(candidate => candidate.id === target);
			if (!window) throw new ToolError(`computer.task: no window matches id ${JSON.stringify(target)}`);
			return window;
		}
		const app = target.app?.toLowerCase();
		const title = target.title?.toLowerCase();
		const matches = windows.filter(
			window =>
				(app === undefined || window.app.toLowerCase().includes(app)) &&
				(title === undefined || window.title.toLowerCase().includes(title)),
		);
		if (matches.length === 0) throw new ToolError(`computer.task: no window matches ${JSON.stringify(target)}`);
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
		let resolved = this.#windows.get(windowId);
		if (!resolved) {
			await this.#listWindows(signal);
			resolved = this.#windows.get(windowId);
		}
		if (!resolved) return { window: null, nodes: [], nodeCount: 0, truncated: false };
		const state = await this.#call(
			"get_window_state",
			{
				pid: resolved.pid,
				window_id: resolved.windowId,
				include_screenshot: false,
				max_elements: Math.max(1, Math.trunc(maxNodes)),
			},
			signal,
		);
		if (!state.ok) {
			if (state.failure === "stale") {
				this.#windows.delete(windowId);
				return { window: null, nodes: [], nodeCount: 0, truncated: false };
			}
			throw new ToolError(`computer.task: ${state.reason}`);
		}
		this.#current = resolved;
		return parseCuaWindowState(state.structured, resolved, resolved.info);
	}

	async execute(
		args: DesktopActionArgs,
		expectedWindow: Pick<DesktopWindowInfo, "id" | "app">,
		signal?: AbortSignal,
	): Promise<SurfaceActionOutcome> {
		const window = this.#current;
		if (!window) return { status: "rejected", reason: "no window has been observed through the driver yet" };
		const built = buildCuaDispatch(args, window);
		if (!built.ok) return { status: "rejected", reason: built.reason };
		let windows: DesktopWindowInfo[];
		try {
			windows = await this.#listWindows(signal);
		} catch (error) {
			return { status: "rejected", reason: error instanceof Error ? error.message : String(error) };
		}
		const focused = windows.find(candidate => candidate.focused);
		if (!focused || focused.id !== expectedWindow.id || focused.app !== expectedWindow.app) {
			return { status: "rejected", reason: "focused window changed before Cua desktop dispatch" };
		}
		const { tool, args: request } = built.dispatch;
		const answer = await this.#call(tool, request, signal);
		if (!answer.ok) {
			logger.debug("computer.task: cua dispatch failed", { tool, failure: answer.failure, reason: answer.reason });
			return { status: answer.failure, reason: answer.reason };
		}
		return interpretCuaActionResult(tool, answer.structured);
	}
}
