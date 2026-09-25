/**
 * Cua Driver discovery for the desktop prelude.
 *
 * Detection only: the driver is reported so the agent knows whether a
 * driver-backed action path is even possible, and what is missing when it is
 * not. Nothing here starts the daemon, installs anything, or asks macOS for a
 * TCC grant - every probe is a bounded read-only subprocess.
 *
 * Probe contract (Cua Driver 0.28.2, docs/reference/cua-driver/cli-reference.mdx
 * and macos-permissions.mdx): `--version` prints `cua-driver X.Y.Z`; `status`
 * prints `Cua Driver daemon is running` (exit 0) or `Cua Driver daemon is not
 * running` on stderr (exit 1); `permissions status --json` prints the daemon's
 * `check_permissions {prompt:false}` payload (`accessibility`,
 * `screen_recording` booleans) or `{"daemon_running":false,"status":"unknown"}`
 * when no daemon answers under the driver's own identity.
 */
import * as os from "node:os";
import * as path from "node:path";
import { $which, logger, prompt, ptree, sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import type { ExecResult } from "../../exec/exec";
import cuaPrerequisites from "../../prompts/tools/computer-cua-driver.md" with { type: "text" };
import cuaPermissionRemediation from "../../prompts/tools/computer-cua-permissions.md" with { type: "text" };

/**
 * Minimum driver release this integration is written against: the
 * `element_token` + per-call `target` action contract, the closed
 * `effect`/`route` action result, and `permissions status --json` are all
 * documented for 0.28.2 (`docs/content/docs/reference/cua-driver/*.mdx`,
 * "Documented against Cua Driver 0.28.2").
 */
export const CUA_DRIVER_MIN_VERSION = "0.28.2";

/** macOS bundle location probed before `PATH`. */
export const CUA_DRIVER_APP_PATH = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";

/**
 * Environment override the driver documents for telemetry
 * (`docs/content/docs/reference/cua-driver/telemetry.mdx`): it takes precedence
 * over the persisted `cua-driver telemetry enable|disable` preference and is
 * scoped to the process it is set on.
 */
export const CUA_DRIVER_TELEMETRY_ENV = "CUA_DRIVER_RS_TELEMETRY_ENABLED";

/** Per-probe wall clock; a hung driver must never stall a desktop call. */
const PROBE_TIMEOUT_MS = 5_000;

/** Longest raw probe output retained in a detection result. */
const MAX_RAW_CHARS = 2_000;

/** Exactly what the prerequisite list for a driver-backed path requires. */
export const CUA_DRIVER_PREREQUISITES: string = cuaPrerequisites.trim();

/** TCC state of one permission as the driver reports it. */
export type CuaPermissionState = "granted" | "denied" | "unknown";

export interface CuaDriverPermissions {
	accessibility: CuaPermissionState;
	screenRecording: CuaPermissionState;
}

/**
 * What the driver's grant state allows, per the daemon's own rules: the AX
 * walk (`get_window_state` without a screenshot) needs Accessibility; any
 * input tool needs both grants because the standard daemon gates every tool
 * call until both are present (`permissions_pending`, exit 75); screenshots
 * need Screen Recording.
 */
export interface CuaPermissionModes {
	observe: boolean;
	act: boolean;
	screenshot: boolean;
}

/** Telemetry policy for the driver processes omp spawns; never a global preference change. */
export type CuaTelemetryPolicy = "off" | "driver";

/** Raw probe output, retained so a parse miss is still diagnosable. */
export interface CuaDriverRaw {
	version?: string;
	status?: string;
	permissions?: string;
}

export interface CuaDriverInstalled {
	installed: true;
	path: string;
	version?: string;
	/** Whether `status` reported a live daemon this agent did not start. */
	daemonRunning: boolean;
	permissions: CuaDriverPermissions;
	/** What the reported grants allow; `act` is what the goal loop needs. */
	modes: CuaPermissionModes;
	/** True only when the daemon runs, the version is new enough, and both permissions are granted. */
	usable: boolean;
	/** Human-readable blockers; empty when `usable`. */
	blockers: string[];
	/** Grant instructions, present when a permission is not granted. */
	remediation?: string;
	raw: CuaDriverRaw;
}

export interface CuaDriverMissing {
	installed: false;
	/** Every location probed, in order. */
	searched: string[];
}

export type CuaDriverDetection = CuaDriverInstalled | CuaDriverMissing;

/** Environment handed to every driver process omp spawns. */
export type CuaSpawnEnv = Record<string, string | undefined>;

/** Bounded command runner; injected in tests. `env` is the complete child environment. */
export type CuaDriverExec = (
	command: string,
	args: string[],
	timeoutMs: number,
	env: CuaSpawnEnv,
	signal?: AbortSignal,
) => Promise<ExecResult>;

/** Executable lookup on `PATH`; injected in tests. */
export type CuaDriverWhich = (command: string) => string | null;

export interface CuaDriverProbeOptions {
	/** `computer.driverBin` setting value. */
	driverBin?: string;
	/** Environment consulted for `CUA_DRIVER_BIN`; defaults to the process environment. */
	env?: Record<string, string | undefined>;
	/** `computer.cua.telemetry`; defaults to `off`. */
	telemetry?: CuaTelemetryPolicy;
	/** Bundle path probed before `PATH`; defaults to {@link CUA_DRIVER_APP_PATH}. */
	appPath?: string;
	exec?: CuaDriverExec;
	which?: CuaDriverWhich;
	/** Existence check for absolute candidates; defaults to a filesystem probe. */
	exists?: (path: string) => Promise<boolean>;
	signal?: AbortSignal;
}

/**
 * Child environment for a driver process: the caller's environment plus the
 * documented telemetry override when the policy is `off`. `driver` leaves the
 * driver's own persisted preference in force. Nothing here writes a config
 * file or runs `cua-driver telemetry disable`.
 */
export function cuaSpawnEnv(
	telemetry: CuaTelemetryPolicy,
	base: Record<string, string | undefined> = Bun.env,
): CuaSpawnEnv {
	if (telemetry === "driver") return { ...base };
	return { ...base, [CUA_DRIVER_TELEMETRY_ENV]: "false" };
}

/** Which of the driver's capabilities the reported grants permit. */
export function cuaPermissionModes(permissions: CuaDriverPermissions): CuaPermissionModes {
	const accessibility = permissions.accessibility === "granted";
	const screenRecording = permissions.screenRecording === "granted";
	return { observe: accessibility, act: accessibility && screenRecording, screenshot: screenRecording };
}

/** Default runner: one bounded subprocess, output captured, non-zero exits returned rather than thrown. */
export const runCuaDriver: CuaDriverExec = async (command, args, timeoutMs, env, signal) => {
	const result = await ptree.exec([command, ...args], {
		cwd: os.tmpdir(),
		env,
		signal,
		timeout: timeoutMs,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full",
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.exitCode ?? 0,
		killed: Boolean(result.exitError?.aborted),
	};
};

const defaultExists = async (path: string): Promise<boolean> => await Bun.file(path).exists();

const VERSION_RE = /\b(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/;
const DAEMON_RUNNING_RE = /\b(running|ready|listening|healthy|up)\b/i;
const DAEMON_STOPPED_RE = /\b(not running|stopped|offline|unavailable|dead)\b/i;

/**
 * Locate the driver executable without executing anything. Configured paths
 * must be absolute: a relative `computer.driverBin` or `$CUA_DRIVER_BIN` would
 * resolve against the working directory, i.e. whatever repository is open.
 */
async function resolveDriverPath(options: CuaDriverProbeOptions): Promise<{ path?: string; searched: string[] }> {
	const env = options.env ?? Bun.env;
	const which = options.which ?? (command => $which(command));
	const exists = options.exists ?? defaultExists;
	const searched: string[] = [];
	const configured: Array<[string, string | undefined]> = [
		["computer.driverBin", options.driverBin?.trim()],
		["CUA_DRIVER_BIN", env.CUA_DRIVER_BIN?.trim()],
	];
	for (const [source, candidate] of configured) {
		if (!candidate) continue;
		if (!path.isAbsolute(candidate)) {
			logger.warn("cua-driver: ignoring relative driver path", { source, value: candidate });
			searched.push(`${candidate} (ignored: ${source} must be an absolute path)`);
			continue;
		}
		searched.push(candidate);
		if (await exists(candidate)) return { path: candidate, searched };
	}
	const bundle = options.appPath ?? CUA_DRIVER_APP_PATH;
	searched.push(bundle);
	if (await exists(bundle)) return { path: bundle, searched };
	searched.push("cua-driver (PATH)");
	const onPath = which("cua-driver");
	return onPath ? { path: onPath, searched } : { searched };
}

/** Parse a semantic version out of arbitrary `--version` output; exported as the parse contract tests pin. */
export function parseCuaDriverVersion(output: string): string | undefined {
	return VERSION_RE.exec(output)?.[0];
}

/** Numeric comparison of dotted versions; prerelease suffixes are ignored. */
export function isCuaDriverVersionSupported(version: string | undefined, minimum = CUA_DRIVER_MIN_VERSION): boolean {
	if (!version) return false;
	const parse = (value: string): number[] =>
		value
			.split(/[-+]/, 1)[0]!
			.split(".")
			.map(part => Number.parseInt(part, 10) || 0);
	const actual = parse(version);
	const wanted = parse(minimum);
	for (let index = 0; index < Math.max(actual.length, wanted.length); index++) {
		const left = actual[index] ?? 0;
		const right = wanted[index] ?? 0;
		if (left !== right) return left > right;
	}
	return true;
}

function permissionFrom(value: unknown): CuaPermissionState {
	if (value === true) return "granted";
	if (value === false) return "denied";
	if (typeof value !== "string") return "unknown";
	const text = value.trim().toLowerCase();
	if (text === "granted" || text === "authorized" || text === "allowed" || text === "true") return "granted";
	if (
		text === "denied" ||
		text === "restricted" ||
		text === "notdetermined" ||
		text === "not-determined" ||
		text === "false"
	) {
		return "denied";
	}
	return "unknown";
}

function readField(record: Record<string, unknown>, keys: readonly string[]): unknown {
	for (const key of keys) {
		if (Object.hasOwn(record, key)) return record[key];
	}
	return undefined;
}

const ACCESSIBILITY_KEYS = ["accessibility", "ax", "accessibilityPermission", "accessibility_permission"] as const;
const SCREEN_KEYS = [
	"screenRecording",
	"screen_recording",
	"screenCapture",
	"screen_capture",
	"screenRecordingPermission",
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** One `permissions status` text line: `Accessibility:    ✅ granted` or `✅ Accessibility: granted.` */
const PERMISSION_LINE_RE = /^\W*(accessibility|screen recording)\W*(granted|not granted|denied|unknown)\b/i;

function permissionFromLine(line: string): CuaPermissionState {
	const state = line.toLowerCase();
	if (state === "granted") return "granted";
	return state === "not granted" || state === "denied" ? "denied" : "unknown";
}

/** Text form of `permissions status` (cli.rs `run_permissions_status`, macos-permissions.mdx). */
function parseCuaDriverPermissionsText(output: string): CuaDriverPermissions {
	const permissions: CuaDriverPermissions = { accessibility: "unknown", screenRecording: "unknown" };
	for (const line of output.split("\n")) {
		const stripped = line.replace(/[^\p{L}\p{N}\s:.]/gu, " ").trim();
		const match = PERMISSION_LINE_RE.exec(stripped);
		if (!match) continue;
		const state = permissionFromLine(match[2]!);
		if (match[1]!.toLowerCase() === "accessibility") permissions.accessibility = state;
		else permissions.screenRecording = state;
	}
	return permissions;
}

/** Parse `permissions status` output, `--json` or the documented text lines; unreadable output yields `unknown`. */
export function parseCuaDriverPermissions(output: string): CuaDriverPermissions {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return parseCuaDriverPermissionsText(output);
	}
	const root = asRecord(parsed);
	if (!root) return { accessibility: "unknown", screenRecording: "unknown" };
	const scope = asRecord(readField(root, ["permissions", "status", "data"])) ?? root;
	return {
		accessibility: permissionFrom(readField(scope, ACCESSIBILITY_KEYS)),
		screenRecording: permissionFrom(readField(scope, SCREEN_KEYS)),
	};
}

/**
 * Whether `status` output describes a daemon that is already running. The
 * real command answers on its first line (`Cua Driver daemon is running` on
 * stdout, exit 0; `Cua Driver daemon is not running` on stderr, exit 1) and
 * follows with policy lines that may legitimately contain words such as
 * `unavailable`, so only the first non-empty line decides.
 */
export function parseCuaDaemonRunning(result: ExecResult): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		parsed = undefined;
	}
	const root = asRecord(parsed);
	if (root) {
		const running = readField(root, ["running", "daemonRunning", "daemon_running", "alive"]);
		if (typeof running === "boolean") return running;
		const state = readField(root, ["status", "state"]);
		if (typeof state === "string") return DAEMON_RUNNING_RE.test(state) && !DAEMON_STOPPED_RE.test(state);
	}
	const firstLine = `${result.stdout}\n${result.stderr}`
		.split("\n")
		.map(line => line.trim())
		.find(line => line.length > 0);
	if (firstLine === undefined) return false;
	if (DAEMON_STOPPED_RE.test(firstLine)) return false;
	return result.code === 0 && DAEMON_RUNNING_RE.test(firstLine);
}

/**
 * Grant instructions for whichever permissions are not granted, in the
 * driver's own documented flow (`open -n -g -a CuaDriver --args serve`, then
 * `cua-driver permissions grant`); the grant belongs to `CuaDriver.app`, not
 * to the terminal that runs omp.
 */
export function permissionRemediationText(missing: {
	accessibility: boolean;
	screenRecording: boolean;
	daemonRunning?: boolean;
}): string {
	return prompt.render(cuaPermissionRemediation, missing).trim();
}

/**
 * Locate and describe the Cua Driver without touching it beyond three bounded
 * read-only probes (`--version`, `status`, `permissions status --json`).
 */
export async function detectCuaDriver(options: CuaDriverProbeOptions = {}): Promise<CuaDriverDetection> {
	const { path, searched } = await resolveDriverPath(options);
	if (!path) return { installed: false, searched };
	const exec = options.exec ?? runCuaDriver;
	const env = cuaSpawnEnv(options.telemetry ?? "off", options.env);
	const run = async (args: string[]): Promise<ExecResult | undefined> => {
		if (options.signal?.aborted) return undefined;
		try {
			return await exec(path, args, PROBE_TIMEOUT_MS, env, options.signal);
		} catch (error) {
			logger.debug("cua-driver: probe failed", {
				path,
				args,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	};
	const versionResult = await run(["--version"]);
	const statusResult = await run(["status"]);
	const permissionsResult = await run(["permissions", "status", "--json"]);
	// Raw output is kept for diagnosis but is untrusted subprocess text: strip
	// control sequences and bound it before it can reach tool details.
	const keep = (result: ExecResult): string =>
		truncate(sanitizeText(`${result.stdout}${result.stderr}`).trim(), MAX_RAW_CHARS);
	const raw: CuaDriverRaw = {};
	if (versionResult) raw.version = keep(versionResult);
	if (statusResult) raw.status = keep(statusResult);
	if (permissionsResult) raw.permissions = keep(permissionsResult);

	const version = raw.version ? parseCuaDriverVersion(raw.version) : undefined;
	const daemonRunning = statusResult ? parseCuaDaemonRunning(statusResult) : false;
	const permissions = permissionsResult
		? parseCuaDriverPermissions(permissionsResult.stdout)
		: { accessibility: "unknown" as CuaPermissionState, screenRecording: "unknown" as CuaPermissionState };
	const modes = cuaPermissionModes(permissions);

	const blockers: string[] = [];
	if (!isCuaDriverVersionSupported(version)) {
		blockers.push(`driver version ${version ?? "unknown"} is below the required ${CUA_DRIVER_MIN_VERSION}`);
	}
	if (!daemonRunning) blockers.push("driver daemon is not running (this agent never starts it)");
	const describeGrant = (name: string, state: CuaPermissionState): void => {
		if (state === "granted") return;
		blockers.push(
			state === "denied"
				? `driver lacks macOS ${name} permission`
				: `driver's macOS ${name} permission is unknown (no daemon answered under the driver's identity)`,
		);
	};
	describeGrant("Accessibility", permissions.accessibility);
	describeGrant("Screen Recording", permissions.screenRecording);
	const detection: CuaDriverInstalled = {
		installed: true,
		path,
		version,
		daemonRunning,
		permissions,
		modes,
		usable: blockers.length === 0,
		blockers,
		raw,
	};
	if (!modes.act) {
		detection.remediation = permissionRemediationText({
			accessibility: permissions.accessibility !== "granted",
			screenRecording: permissions.screenRecording !== "granted",
			daemonRunning,
		});
	}
	return detection;
}

/** One-line summary of a detection result for tool output. */
export function describeCuaDriver(detection: CuaDriverDetection): string {
	if (!detection.installed) return `cua-driver: not installed (searched ${detection.searched.join(", ")})`;
	const state = detection.usable ? "usable" : `unusable: ${detection.blockers.join("; ")}`;
	return `cua-driver ${detection.version ?? "unknown"} at ${detection.path} (${state})`;
}
