import { describe, expect, it } from "bun:test";
import type { Answer, JudgmentRequest, JudgmentResult, JudgmentState, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { DecisionJudge } from "@oh-my-pi/pi-coding-agent/judgment/decision";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { grantAutomationScope } from "@oh-my-pi/pi-coding-agent/tools/automation-policy";
import { createComputerPrelude } from "@oh-my-pi/pi-coding-agent/tools/computer";
import {
	buildCuaDispatch,
	CuaDesktopSurface,
	interpretCuaActionResult,
	parseCuaCallOutput,
	selectDesktopBackend,
} from "@oh-my-pi/pi-coding-agent/tools/computer/cua-backend";
import {
	CUA_DRIVER_MIN_VERSION,
	CUA_DRIVER_TELEMETRY_ENV,
	type CuaDriverDetection,
	type CuaDriverExec,
	type CuaSpawnEnv,
	cuaSpawnEnv,
} from "@oh-my-pi/pi-coding-agent/tools/computer/cua-driver";
import type { ComputerController } from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import type { ComputerTaskResult } from "@oh-my-pi/pi-coding-agent/tools/computer/task/types";

// ── Fake driver ─────────────────────────────────────────────────────────────
//
// Speaks exactly what `cua-driver` 0.28.2 prints for the probes and for
// `call` (rust/crates/cua-driver/src/{cli.rs,serve.rs}): structuredContent as
// JSON on stdout with exit 0 (refusals included), stderr + non-zero exit when
// the daemon is absent, gated, or the tool is unknown. Element tokens follow
// cua-driver-core `element_token.rs` (`s<8 hex>:<index>`) and are superseded
// by the next snapshot of the same window (`element_cache.rs`).

interface FakeElement {
	role: string;
	label?: string;
	value?: string;
	enabled?: boolean;
	actions?: string[];
	frame?: { x: number; y: number; w: number; h: number };
}

interface FakeWindow {
	window_id: number;
	pid: number;
	app_name: string;
	title: string;
	bounds: { x: number; y: number; width: number; height: number };
	is_on_screen: boolean;
	z_index: number | null;
}

type Reply = { stdout?: string; stderr?: string; code?: number; killed?: boolean };

function defaultElements(): FakeElement[] {
	return [
		{ role: "AXTextField", label: "Name", value: "", actions: ["AXConfirm"], frame: { x: 10, y: 10, w: 200, h: 24 } },
		{ role: "AXButton", label: "Apply", actions: ["AXPress"], frame: { x: 10, y: 40, w: 60, h: 24 } },
		{ role: "AXButton", label: "Retry", enabled: false, actions: ["AXPress"], frame: { x: 80, y: 40, w: 60, h: 24 } },
		{
			role: "AXCheckBox",
			label: "Remember me",
			value: "0",
			actions: ["AXPress"],
			frame: { x: 10, y: 70, w: 120, h: 20 },
		},
		{
			role: "AXPopUpButton",
			label: "Format",
			value: "plain",
			actions: ["AXPress", "AXShowMenu"],
			frame: { x: 10, y: 100, w: 90, h: 24 },
		},
	];
}

class FakeCuaDriver {
	version = CUA_DRIVER_MIN_VERSION;
	daemonRunning = true;
	permissions: { accessibility: boolean; screen_recording: boolean } = { accessibility: true, screen_recording: true };
	/** Daemon still inside its first-launch permission gate: every tool call exits 75. */
	gatePending = false;
	windows: FakeWindow[] = [
		{
			window_id: 4201,
			pid: 555,
			app_name: "Code",
			title: "Editor",
			bounds: { x: 0, y: 0, width: 400, height: 300 },
			is_on_screen: true,
			z_index: 9,
		},
		{
			window_id: 77,
			pid: 900,
			app_name: "Terminal",
			title: "zsh",
			bounds: { x: 500, y: 0, width: 300, height: 300 },
			is_on_screen: true,
			z_index: 3,
		},
	];
	elements: FakeElement[] = defaultElements();
	snapshots = 0;
	latestSnapshot = 0;
	readonly probes: Array<{ args: string[]; env: CuaSpawnEnv }> = [];
	readonly calls: Array<{ tool: string; args: Record<string, unknown>; env: CuaSpawnEnv; timeoutMs: number }> = [];
	/** Mutates the tree before the nth snapshot answers. */
	beforeSnapshot?: (snapshot: number, driver: FakeCuaDriver) => void;
	/** Overrides the structured action result (or the whole process reply) for one tool. */
	actionReply?: (tool: string, args: Record<string, unknown>) => Record<string, unknown> | Reply | undefined;

	readonly exec: CuaDriverExec = async (_command, args, timeoutMs, env) => {
		const reply = this.#reply(args, timeoutMs, env);
		return {
			stdout: reply.stdout ?? "",
			stderr: reply.stderr ?? "",
			code: reply.code ?? 0,
			killed: reply.killed === true,
		};
	};

	token(index: number, snapshot = this.latestSnapshot): string {
		return `s${snapshot.toString(16).padStart(8, "0")}:${index}`;
	}

	#reply(args: string[], timeoutMs: number, env: CuaSpawnEnv): Reply {
		if (args[0] !== "call") {
			this.probes.push({ args, env });
			if (args[0] === "--version") return { stdout: `cua-driver ${this.version}\n` };
			if (args[0] === "status") {
				return this.daemonRunning
					? {
							stdout:
								"Cua Driver daemon is running\n  socket: /tmp/cua-driver.sock\n  pid: 4242\n  permission mode: standard (default)\n",
						}
					: { stderr: "Cua Driver daemon is not running\n", code: 1 };
			}
			if (args[0] === "permissions") {
				return this.daemonRunning
					? {
							stdout: JSON.stringify({
								...this.permissions,
								screen_recording_capturable: null,
								direct_capture_status: "not_checked",
								source: { attribution: "driver-daemon", pid: 4242 },
							}),
						}
					: { stdout: JSON.stringify({ daemon_running: false, status: "unknown", reason: "no daemon" }) };
			}
			return { stderr: `unknown probe ${args.join(" ")}`, code: 2 };
		}
		const tool = args[1] ?? "";
		const parsed: unknown = JSON.parse(args[2] ?? "{}");
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("fake driver: non-object args");
		const request = parsed as Record<string, unknown>;
		this.calls.push({ tool, args: request, env, timeoutMs });
		if (!this.daemonRunning) {
			return {
				stderr:
					"Cua Driver daemon is not running on /tmp/cua-driver.sock.\nStart it first with: cua-driver serve --socket /tmp/cua-driver.sock\n",
				code: 1,
			};
		}
		if (this.gatePending) {
			return {
				stderr:
					"permissions_pending: macOS Accessibility or Screen Recording permission is still pending; no action started, retry after the permission gate completes\n",
				code: 75,
			};
		}
		const override = tool === "click" || tool === "set_value" ? this.actionReply?.(tool, request) : undefined;
		if (override && ("stdout" in override || "stderr" in override || "killed" in override)) return override as Reply;
		switch (tool) {
			case "list_windows":
				return { stdout: JSON.stringify({ windows: this.windows, current_space_id: 1 }) };
			case "get_window_state":
				return { stdout: JSON.stringify(this.#windowState(request)) };
			case "click":
			case "set_value":
				return { stdout: JSON.stringify(override ?? this.#action(tool, request)) };
			default:
				return { stderr: `Unknown tool: ${tool}\n`, code: 64 };
		}
	}

	#windowState(request: Record<string, unknown>): Record<string, unknown> {
		const window = this.windows.find(entry => entry.window_id === request.window_id);
		if (!window) {
			return {
				code: "window_id_not_found",
				effect: "refused",
				message: `window_id ${String(request.window_id)} no longer exists`,
			};
		}
		if (window.pid !== request.pid) {
			return { code: "window_owner_pid_mismatch", effect: "refused", owner_pid: window.pid };
		}
		if (request.include_screenshot !== false) throw new Error("fake driver: a screenshot was requested");
		this.snapshots += 1;
		this.beforeSnapshot?.(this.snapshots, this);
		this.latestSnapshot = this.snapshots;
		const cap = typeof request.max_elements === "number" ? request.max_elements : 2_000;
		const elements = this.elements.slice(0, cap).map((element, index) => ({
			element_index: index,
			element_token: this.token(index),
			role: element.role,
			depth: 1,
			parent_index: 0,
			...(element.label !== undefined ? { label: element.label } : {}),
			...(element.value !== undefined ? { value: element.value } : {}),
			...(element.enabled !== undefined ? { enabled: element.enabled } : {}),
			...(element.actions && element.actions.length > 0 ? { actions: element.actions } : {}),
			...(element.frame ? { frame: element.frame } : {}),
		}));
		return {
			pid: window.pid,
			window_id: window.window_id,
			snapshot_id: this.token(0).replace(/:0$/, ""),
			elements,
			element_count: this.elements.length,
			returned_element_count: elements.length,
			truncated: elements.length < this.elements.length,
			window_bounds: window.bounds,
			app_name: window.app_name,
			window_title: window.title,
		};
	}

	#resolveToken(token: unknown): { index: number } | { refused: Record<string, unknown> } {
		const refuse = (code: string, message: string): { refused: Record<string, unknown> } => ({
			refused: { status: "refused", refusal: { code, message } },
		});
		if (typeof token !== "string") return refuse("missing_element_target", "element_token is required");
		const match = /^s([0-9a-f]{8}):(\d+)$/.exec(token);
		if (!match) return refuse("invalid_element_token", `malformed element_token ${token}`);
		if (Number.parseInt(match[1]!, 16) !== this.latestSnapshot) {
			return refuse("stale_element_token", "element_token is stale; call get_window_state again to refresh");
		}
		return { index: Number.parseInt(match[2]!, 10) };
	}

	#action(tool: string, request: Record<string, unknown>): Record<string, unknown> {
		const resolved = this.#resolveToken(request.element_token);
		if ("refused" in resolved) return resolved.refused;
		const element = this.elements[resolved.index];
		if (!element) {
			return {
				status: "refused",
				refusal: { code: "invalid_element_token", message: "element_index out of range" },
			};
		}
		if (tool === "click") {
			const target = request.target;
			if (target === null || typeof target !== "object" || (target as { kind?: unknown }).kind !== "window") {
				return {
					status: "refused",
					refusal: { code: "invalid_target", message: "click requires a window target" },
				};
			}
			if (request.delivery_mode !== "background") {
				return { status: "refused", refusal: { code: "foreground_required", message: "unexpected delivery_mode" } };
			}
			if (element.enabled === false) {
				return { effect: "suspected_noop", route: "accessibility", delivery: { mode: "background" } };
			}
			if (element.role === "AXCheckBox") element.value = element.value === "1" ? "0" : "1";
			return {
				effect: "confirmed",
				route: "accessibility",
				delivery: { mode: "background" },
				evidence: [{ kind: "value_readback" }],
			};
		}
		if (typeof request.value !== "string") {
			return { status: "refused", refusal: { code: "invalid_arguments", message: "set_value requires value" } };
		}
		element.value = request.value;
		return {
			effect: "confirmed",
			route: "accessibility",
			delivery: { mode: "background" },
			evidence: [{ kind: "value_readback" }],
		};
	}
}

// ── Judge + prelude harness ─────────────────────────────────────────────────

interface JudgeRecord {
	ids: string[];
	labels: string[];
	state: JudgmentState;
}

interface JudgeStep {
	pick: (ids: string[], labels: string[]) => string;
}

/** Deterministic in-memory judge: no network, no model, scripted selections. */
class ScriptedJudge implements DecisionJudge {
	readonly kind = "online" as const;
	readonly label = "scripted-test-judge";
	readonly records: JudgeRecord[] = [];
	readonly #steps: JudgeStep[];
	readonly #fallback: JudgeStep;

	constructor(steps: JudgeStep[], fallback: JudgeStep = { pick: () => "blocked" }) {
		this.#steps = [...steps];
		this.#fallback = fallback;
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
		this.records.push({ ids, labels, state: request.state });
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
			answers[id] = { type: "noul", noul: 1 };
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

function byLabel(needle: string): JudgeStep {
	return {
		pick: (ids, labels) => {
			const index = labels.findIndex(label => label.includes(needle));
			if (index < 0) throw new Error("no candidate labelled " + needle + " in " + labels.join(" | "));
			return ids[index]!;
		},
	};
}

/** A controller that must never be reached when the Cua backend runs; reaching it is the native-path sentinel. */
function sentinelController(): ComputerController {
	return {
		async run() {
			throw new Error("native controller reached");
		},
		async capabilities() {
			throw new Error("native controller reached");
		},
		async close() {},
	};
}

function toolSession(overrides: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: import.meta.dir,
		hasUI: false,
		settings: Settings.isolated({
			"computer.enabled": true,
			"computer.task.backend": "cua",
			// Any existing file satisfies the detection's existence probe; every process is the fake.
			"computer.driverBin": import.meta.path,
			...overrides,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

interface RunOptions {
	judge: ScriptedJudge;
	driver?: FakeCuaDriver;
	settings?: Record<string, unknown>;
	authorized?: boolean;
}

async function runTask(
	params: Record<string, unknown>,
	options: RunOptions,
): Promise<{ result: ComputerTaskResult; driver: FakeCuaDriver; text: string }> {
	const driver = options.driver ?? new FakeCuaDriver();
	const session = toolSession(options.settings);
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
			task: "Cua task fixture",
		});
	}
	const prelude = createComputerPrelude(session, sentinelController, {
		createJudge: () => options.judge,
		createValueResolver: () => async () => ({ ok: false, reason: "no value route in this test" }),
		driverExec: () => driver.exec,
	});
	const invoked = await prelude.invoke({ action: "task", ...params }, { session, toolCallId: "cua-task" });
	const details = invoked.details;
	if (details === null || typeof details !== "object" || !("value" in details))
		throw new Error("task returned no result details");
	const text = invoked.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
	return { result: details.value as ComputerTaskResult, driver, text };
}

const searched = ["/Applications/CuaDriver.app/Contents/MacOS/cua-driver", "cua-driver (PATH)"];

function installed(overrides: Partial<Extract<CuaDriverDetection, { installed: true }>> = {}): CuaDriverDetection {
	return {
		installed: true,
		path: "/opt/cua-driver",
		version: CUA_DRIVER_MIN_VERSION,
		daemonRunning: true,
		permissions: { accessibility: "granted", screenRecording: "granted" },
		modes: { observe: true, act: true, screenshot: true },
		usable: true,
		blockers: [],
		raw: {},
		...overrides,
	};
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("desktop backend selection", () => {
	it("falls back to native under auto and fails closed under cua, naming every missing prerequisite", () => {
		const missing: CuaDriverDetection = { installed: false, searched };
		expect(selectDesktopBackend("auto", missing)).toMatchObject({ kind: "native", mode: "auto" });
		expect(selectDesktopBackend("auto", missing).reason).toContain("not installed");
		expect(() => selectDesktopBackend("cua", missing)).toThrow(
			/computer\.task\.backend is 'cua'[\s\S]*not installed[\s\S]*cua-driver \(PATH\)[\s\S]*permissions grant/,
		);

		const old = installed({
			version: "0.23.2",
			usable: false,
			blockers: [`driver version 0.23.2 is below the required ${CUA_DRIVER_MIN_VERSION}`],
		});
		expect(selectDesktopBackend("auto", old)).toMatchObject({ kind: "native", version: "0.23.2" });
		expect(() => selectDesktopBackend("cua", old)).toThrow(`below the required ${CUA_DRIVER_MIN_VERSION}`);

		const down = installed({
			daemonRunning: false,
			usable: false,
			blockers: ["driver daemon is not running (this agent never starts it)"],
		});
		expect(selectDesktopBackend("auto", down).kind).toBe("native");
		expect(() => selectDesktopBackend("cua", down)).toThrow("daemon is not running");

		const denied = installed({
			permissions: { accessibility: "granted", screenRecording: "denied" },
			modes: { observe: true, act: false, screenshot: false },
			usable: false,
			blockers: ["driver lacks macOS Screen Recording permission"],
			remediation: "Screen Recording: switch CuaDriver on",
		});
		expect(selectDesktopBackend("auto", denied)).toMatchObject({
			kind: "native",
			permissions: { accessibility: "granted", screenRecording: "denied" },
		});
		expect(() => selectDesktopBackend("cua", denied)).toThrow(
			/Screen Recording permission[\s\S]*switch CuaDriver on/,
		);

		const usable = installed();
		expect(selectDesktopBackend("auto", usable)).toMatchObject({
			kind: "cua",
			version: CUA_DRIVER_MIN_VERSION,
			permissions: { accessibility: "granted", screenRecording: "granted" },
		});
		expect(selectDesktopBackend("cua", usable).kind).toBe("cua");
		expect(selectDesktopBackend("native", usable)).toMatchObject({ kind: "native", mode: "native" });
	});

	it("probes read-only, then fails closed or falls back through the real prelude", async () => {
		const gated = new FakeCuaDriver();
		gated.daemonRunning = false;
		await expect(
			runTask(
				{ goal: "apply the change", window: { app: "Code" } },
				{ judge: new ScriptedJudge([]), driver: gated },
			),
		).rejects.toThrow(
			/computer\.task\.backend is 'cua'[\s\S]*daemon is not running[\s\S]*Accessibility permission is unknown/,
		);
		expect(gated.probes.map(probe => probe.args)).toEqual([
			["--version"],
			["status"],
			["permissions", "status", "--json"],
		]);
		expect(gated.calls).toHaveLength(0);

		const fallback = new FakeCuaDriver();
		fallback.permissions = { accessibility: true, screen_recording: false };
		await expect(
			runTask(
				{ goal: "apply the change", window: { app: "Code" } },
				{ judge: new ScriptedJudge([]), driver: fallback, settings: { "computer.task.backend": "auto" } },
			),
		).rejects.toThrow("native controller reached");
		expect(fallback.calls).toHaveLength(0);

		const untouched = new FakeCuaDriver();
		await expect(
			runTask(
				{ goal: "apply the change", window: { app: "Code" } },
				{ judge: new ScriptedJudge([]), driver: untouched, settings: { "computer.task.backend": "native" } },
			),
		).rejects.toThrow("native controller reached");
		expect(untouched.probes).toHaveLength(0);
	});
});

describe("cua dispatch validation", () => {
	const window = { pid: 555, windowId: 4201 };

	it("builds the documented click and set_value requests and refuses what the driver cannot express", () => {
		expect(buildCuaDispatch({ kind: "press", ref: "s00000003:1", axAction: "AXPress" }, window)).toEqual({
			ok: true,
			dispatch: {
				tool: "click",
				args: {
					target: { kind: "window", pid: 555, window_id: 4201 },
					element_token: "s00000003:1",
					delivery_mode: "background",
					action: "press",
				},
			},
		});
		expect(buildCuaDispatch({ kind: "press", ref: "s00000003:4", axAction: "AXShowMenu" }, window)).toMatchObject({
			ok: true,
			dispatch: { tool: "click", args: { action: "show_menu" } },
		});
		expect(buildCuaDispatch({ kind: "set-value", ref: "s00000003:0", text: "Ada" }, window)).toEqual({
			ok: true,
			dispatch: {
				tool: "set_value",
				args: { pid: 555, window_id: 4201, element_token: "s00000003:0", value: "Ada" },
			},
		});
		expect(buildCuaDispatch({ kind: "click", ref: "e2" }, window)).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/not a Cua element_token/),
		});
		expect(buildCuaDispatch({ kind: "set-value", ref: "s00000003:0" }, window)).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/no text/),
		});
		expect(buildCuaDispatch({ kind: "press", ref: "s00000003:1", axAction: "AXIncrement" }, window)).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/no "AXIncrement" action/),
		});
		expect(
			buildCuaDispatch({ kind: "scroll-to-visible", ref: "s00000003:1", axAction: "AXScrollToVisible" }, window),
		).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/no AXScrollToVisible/),
		});
		expect(buildCuaDispatch({ kind: "focus", ref: "s00000003:1" }, window)).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/no focus tool/),
		});
		expect(buildCuaDispatch({ kind: "click", ref: "s00000003:1" }, { pid: 0, windowId: 4201 })).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/pid/),
		});
	});

	it("rejects malformed arguments before any driver process is spawned", async () => {
		const driver = new FakeCuaDriver();
		const surface = new CuaDesktopSurface({
			driverPath: "/opt/cua-driver",
			env: cuaSpawnEnv("off", {}),
			exec: driver.exec,
		});
		expect(await surface.execute({ kind: "click", ref: "s00000001:1" }, { id: "4201", app: "Code" })).toEqual({
			status: "rejected",
			reason: "no window has been observed through the driver yet",
		});
		const window = await surface.resolveWindow({ app: "Code" });
		await surface.observe(window.id, 100);
		const spawned = driver.calls.length;
		expect(await surface.execute({ kind: "click", ref: "e2" }, window)).toMatchObject({
			status: "rejected",
			reason: expect.stringMatching(/not a Cua element_token/),
		});
		expect(await surface.execute({ kind: "set-value", ref: driver.token(0) }, window)).toMatchObject({
			status: "rejected",
			reason: expect.stringMatching(/no text/),
		});
		expect(driver.calls).toHaveLength(spawned);
	});
});

describe("cua surface", () => {
	it("observes without screenshots, normalises roles and tokens, and refuses a stale snapshot token", async () => {
		const driver = new FakeCuaDriver();
		const surface = new CuaDesktopSurface({
			driverPath: "/opt/cua-driver",
			env: cuaSpawnEnv("off", {}),
			exec: driver.exec,
		});
		const window = await surface.resolveWindow({ app: "Code" });
		expect(window).toMatchObject({ id: "4201", app: "Code", title: "Editor", pid: 555, focused: true });
		expect((await surface.resolveWindow("focused")).id).toBe("4201");
		await expect(surface.resolveWindow({ title: "nope" })).rejects.toThrow("no window matches");

		const first = await surface.observe(window.id, 100);
		expect(driver.calls.at(-1)).toMatchObject({
			tool: "get_window_state",
			args: { pid: 555, window_id: 4201, include_screenshot: false, max_elements: 100 },
		});
		expect(first.window).toMatchObject({
			id: "4201",
			app: "Code",
			title: "Editor",
			bounds: { width: 400, height: 300 },
		});
		expect(first.nodes.map(node => [node.role, node.nativeRole, node.title, node.enabled])).toEqual([
			["textfield", "AXTextField", "Name", true],
			["button", "AXButton", "Apply", true],
			["button", "AXButton", "Retry", false],
			["checkbox", "AXCheckBox", "Remember me", true],
			["popupbutton", "AXPopUpButton", "Format", true],
		]);
		expect(first.nodes[1]!.ref).toBe("s00000001:1");
		expect(first.nodes[1]!.frame).toEqual({ x: 10, y: 40, width: 60, height: 24 });
		expect(first.nodeCount).toBe(5);

		const staleToken = first.nodes[1]!.ref;
		const second = await surface.observe(window.id, 100);
		expect(second.nodes[1]!.ref).toBe("s00000002:1");
		expect(await surface.execute({ kind: "press", ref: staleToken, axAction: "AXPress" }, window)).toEqual({
			status: "stale",
			reason: "stale_element_token: element_token is stale; call get_window_state again to refresh",
		});
		expect(await surface.execute({ kind: "press", ref: second.nodes[1]!.ref, axAction: "AXPress" }, window)).toEqual({
			status: "applied",
			detail: "click confirmed via accessibility",
		});

		driver.windows = driver.windows.filter(entry => entry.window_id !== 4201);
		expect(await surface.observe(window.id, 100)).toEqual({
			window: null,
			nodes: [],
			nodeCount: 0,
			truncated: false,
		});
	});

	it("rechecks focused window identity in the driver immediately before dispatch", async () => {
		const driver = new FakeCuaDriver();
		const surface = new CuaDesktopSurface({
			driverPath: "/opt/cua-driver",
			env: cuaSpawnEnv("off", {}),
			exec: driver.exec,
		});
		const window = await surface.resolveWindow({ app: "Code" });
		const observed = await surface.observe(window.id, 100);
		driver.windows[0]!.z_index = 1;
		driver.windows[1]!.z_index = 10;
		const clicksBefore = driver.calls.filter(call => call.tool === "click").length;
		expect(
			await surface.execute({ kind: "press", ref: observed.nodes[1]!.ref, axAction: "AXPress" }, window),
		).toEqual({
			status: "rejected",
			reason: "focused window changed before Cua desktop dispatch",
		});
		expect(driver.calls.filter(call => call.tool === "click")).toHaveLength(clicksBefore);
	});

	it("maps every driver answer to a typed outcome and never throws on failure", async () => {
		const driver = new FakeCuaDriver();
		const surface = new CuaDesktopSurface({
			driverPath: "/opt/cua-driver",
			env: cuaSpawnEnv("off", {}),
			exec: driver.exec,
		});
		const window = await surface.resolveWindow("4201");
		const observed = await surface.observe(window.id, 100);
		const press = { kind: "press" as const, ref: observed.nodes[1]!.ref, axAction: "AXPress" };

		driver.actionReply = () => ({
			effect: "unverifiable",
			route: "synthetic_events",
			escalation: { target: "foreground", reason: "effect_unconfirmed" },
		});
		expect(await surface.execute(press, window)).toEqual({
			status: "unknown",
			reason: "click effect unverifiable via synthetic_events (driver suggests foreground: effect_unconfirmed)",
		});
		driver.actionReply = () => ({ effect: "suspected_noop", route: "accessibility" });
		expect(await surface.execute(press, window)).toMatchObject({
			status: "applied",
			detail: expect.stringMatching(/suspects a no-op/),
		});
		driver.actionReply = () => ({ code: "ambiguous_window_target", effect: "refused", candidates: [] });
		expect(await surface.execute(press, window)).toMatchObject({
			status: "stale",
			reason: expect.stringMatching(/ambiguous_window_target/),
		});
		driver.actionReply = () => ({
			status: "refused",
			refusal: { code: "foreground_required", message: "retry after background failed" },
		});
		expect(await surface.execute(press, window)).toEqual({
			status: "rejected",
			reason: "foreground_required: retry after background failed",
		});
		driver.actionReply = () => ({ stdout: "✅ clicked\n" });
		expect(await surface.execute(press, window)).toMatchObject({
			status: "unknown",
			reason: expect.stringMatching(/no structured result/),
		});
		driver.actionReply = () => ({ killed: true });
		expect(await surface.execute(press, window)).toMatchObject({
			status: "unknown",
			reason: expect.stringMatching(/cut off/),
		});
		driver.actionReply = undefined;
		driver.gatePending = true;
		expect(await surface.execute(press, window)).toMatchObject({
			status: "rejected",
			reason: expect.stringMatching(/exited 75: permissions_pending/),
		});
		driver.gatePending = false;
		driver.daemonRunning = false;
		expect(await surface.execute(press, window)).toMatchObject({
			status: "rejected",
			reason: expect.stringMatching(/daemon is not running/),
		});

		expect(parseCuaCallOutput("click", { stdout: "", stderr: "boom", code: 3, killed: false })).toMatchObject({
			ok: false,
			failure: "unknown",
		});
		expect(interpretCuaActionResult("set_value", { route: "accessibility" })).toEqual({
			status: "unknown",
			reason: "set_value returned no action effect",
		});
	});
});

describe("computer.task on the cua backend", () => {
	it("denies a Cua task mutation without an exact app/action grant", async () => {
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

	it("sets the caller value through set_value, verifies by re-observing, and reports cua provenance", async () => {
		const judge = new ScriptedJudge([byLabel('"Name"'), { pick: () => "done" }]);
		const { result, driver, text } = await runTask(
			{
				goal: "put the reviewer name in the Name field",
				window: { app: "Code" },
				values: { Name: "Ada" },
				expect: { find: { role: "textfield", value: "Ada" } },
			},
			{ judge },
		);
		expect(result.status).toBe("done");
		const setValue = driver.calls.find(call => call.tool === "set_value");
		expect(setValue?.args).toEqual({ pid: 555, window_id: 4201, element_token: "s00000002:0", value: "Ada" });
		// The step records the candidate's own token (decision snapshot); dispatch used the fresh one.
		expect(result.steps[0]).toMatchObject({
			kind: "set-value",
			ref: "s00000001:0",
			valueSource: "caller",
			outcome: { status: "applied", detail: "set_value confirmed via accessibility" },
			changed: true,
		});
		expect(result.verification).toMatchObject({ verified: true, method: "cua-reobserve+expect(find)" });
		expect(result.backend).toMatchObject({
			kind: "cua",
			mode: "cua",
			version: CUA_DRIVER_MIN_VERSION,
			permissions: { accessibility: "granted", screenRecording: "granted" },
			driver: { installed: true, usable: true },
		});
		expect(text).toContain("backend: cua (computer.task.backend=cua");
		expect(
			driver.calls.every(call => call.tool !== "get_window_state" || call.args.include_screenshot === false),
		).toBe(true);
		const offered = judge.records[0]!.labels.join(" | ");
		expect(offered).toContain('press button "Apply"');
		expect(offered).not.toContain("Retry");
	});

	it("dispatches set_value once even when the judge keeps picking the field (receipt RUN-2026-09-18T22-06-04)", async () => {
		const driver = new FakeCuaDriver();
		driver.elements = [
			{ role: "AXTextArea", value: "smoke doc\n", actions: ["AXShowMenu"], frame: { x: 0, y: 0, w: 300, h: 200 } },
		];
		const judge = new ScriptedJudge([byLabel("caller value")], { pick: () => "done" });
		const { result } = await runTask(
			{
				goal: "replace the document text with 2026-09-18-CUA",
				window: { app: "Code" },
				values: { document: "2026-09-18-CUA" },
				expect: { find: { role: "textarea", value: "2026-09-18-CUA" } },
			},
			{ judge, driver },
		);
		expect(result.status).toBe("done");
		expect(driver.calls.filter(call => call.tool === "set_value")).toHaveLength(1);
		expect(result.steps.map(step => step.kind)).toEqual(["set-value", "done"]);
		expect(judge.records[1]!.labels.join(" | ")).not.toContain("caller value");
	});

	it("keeps every spawned driver process on the telemetry policy", async () => {
		const silent = await runTask(
			{ goal: "apply the change", window: { app: "Code" }, maxActions: 1 },
			{ judge: new ScriptedJudge([byLabel("Apply")]) },
		);
		const silentEnvs = [
			...silent.driver.probes.map(probe => probe.env),
			...silent.driver.calls.map(call => call.env),
		];
		expect(silentEnvs.length).toBeGreaterThan(4);
		expect(silentEnvs.every(env => env[CUA_DRIVER_TELEMETRY_ENV] === "false")).toBe(true);

		const deferred = await runTask(
			{ goal: "apply the change", window: { app: "Code" }, maxActions: 1 },
			{ judge: new ScriptedJudge([byLabel("Apply")]), settings: { "computer.cua.telemetry": "driver" } },
		);
		const deferredEnvs = [
			...deferred.driver.probes.map(probe => probe.env),
			...deferred.driver.calls.map(call => call.env),
		];
		expect(deferredEnvs.every(env => !(CUA_DRIVER_TELEMETRY_ENV in env))).toBe(true);
	});

	it("withholds consequential actions unless the caller authorizes them", async () => {
		const sendOnly = (): FakeCuaDriver => {
			const driver = new FakeCuaDriver();
			driver.elements = [
				{ role: "AXButton", label: "Send message", actions: ["AXPress"], frame: { x: 10, y: 10, w: 90, h: 24 } },
			];
			return driver;
		};
		const gated = new ScriptedJudge([]);
		const withheld = await runTask(
			{ goal: "send the draft", window: { app: "Code" } },
			{ judge: gated, driver: sendOnly() },
		);
		expect(withheld.result.status).toBe("blocked");
		expect(withheld.result.notes.join(" ")).toContain("Send message");
		expect(withheld.driver.calls.filter(call => call.tool === "click")).toHaveLength(0);
		expect(gated.records).toHaveLength(0);

		const allowed = new ScriptedJudge([byLabel("Send message"), { pick: () => "done" }]);
		const offered = await runTask(
			{
				goal: "send the draft",
				window: { app: "Code" },
				allowConsequential: true,
				expect: { titleIncludes: "Editor" },
			},
			{ judge: allowed, driver: sendOnly() },
		);
		expect(offered.result.status).toBe("done");
		expect(offered.driver.calls.filter(call => call.tool === "click").map(call => call.args)).toEqual([
			{
				target: { kind: "window", pid: 555, window_id: 4201 },
				element_token: "s00000002:0",
				delivery_mode: "background",
				action: "press",
			},
		]);
	});

	it("refuses a stale target when the tree changed during the decision and dispatches nothing", async () => {
		const driver = new FakeCuaDriver();
		driver.beforeSnapshot = (snapshot, fake) => {
			if (snapshot === 2) fake.elements = fake.elements.filter(element => element.label !== "Apply");
		};
		const judge = new ScriptedJudge([byLabel("Apply"), { pick: () => "blocked" }]);
		const { result } = await runTask({ goal: "apply the change", window: { app: "Code" } }, { judge, driver });
		expect(result.steps[0]!.outcome).toMatchObject({ status: "stale", reason: "element is no longer present" });
		expect(driver.calls.filter(call => call.tool === "click")).toHaveLength(0);
		expect(result.status).toBe("blocked");
	});

	it("reconciles an unverifiable effect by re-observing and never repeats that action", async () => {
		const driver = new FakeCuaDriver();
		driver.actionReply = (tool, args) => {
			if (tool !== "click" || args.element_token !== driver.token(3)) return undefined;
			const checkbox = driver.elements[3]!;
			checkbox.value = "1";
			return { effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background" } };
		};
		const judge = new ScriptedJudge([byLabel("Remember me"), { pick: () => "blocked" }]);
		const { result } = await runTask({ goal: "remember the login", window: { app: "Code" } }, { judge, driver });
		expect(result.steps[0]!.outcome).toMatchObject({
			status: "unknown",
			reason: expect.stringMatching(/unverifiable/),
		});
		expect(result.steps[0]!.reconciliation).toContain("treating the action as landed");
		expect(judge.records[1]!.labels.join(" | ")).not.toContain("Remember me");
	});
});
