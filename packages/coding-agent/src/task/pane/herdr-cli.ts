/**
 * Bounded wrapper over the `herdr` control-plane CLI.
 *
 * Every herdr group command (`workspace`, `pane`, `agent`, `integration`)
 * prints one JSON envelope — `{"id":…,"result":{…}}` on success,
 * `{"error":{"code":…,"message":…},"id":…}` on a server error with exit status
 * 1 — so identifiers and lifecycle states are always read from the response
 * instead of predicted. Syntax errors exit 2 with plain usage text.
 *
 * The wrapper never spawns an interactive TUI: it only ever runs subcommands,
 * always with a timeout, and prepends `--session <name>` when this instance
 * targets a dedicated named session rather than the ambient (inside-pane) one.
 */
import { $which, isRecord, ptree, WhichCachePolicy } from "@oh-my-pi/pi-utils";

/** Ceiling for a single control-plane call (list/get/create/close/status). */
export const HERDR_CLI_TIMEOUT_MS = 15_000;

/** Error code used when herdr failed without a parseable JSON envelope. */
export const HERDR_CLI_FAILED = "herdr_cli_failed";

/** Error code used when the CLI call was aborted or hit its timeout. */
export const HERDR_CLI_ABORTED = "herdr_cli_aborted";

/** Structured herdr failure, keyed by the control plane's own error code. */
export class HerdrCliError extends Error {
	readonly code: string;
	readonly exitCode: number;
	/** Combined stdout/stderr, retained for user-facing diagnostics. */
	readonly output: string;

	constructor(code: string, message: string, exitCode: number, output: string) {
		super(message);
		this.name = "HerdrCliError";
		this.code = code;
		this.exitCode = exitCode;
		this.output = output;
	}
}

/** Raw outcome of one `herdr` invocation. */
export interface HerdrCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	aborted: boolean;
}

export interface HerdrCliInit {
	/** Absolute path to the `herdr` executable (see {@link resolveHerdrBinary}). */
	bin: string;
	/** Working directory for the CLI process. */
	cwd: string;
	/** Dedicated named session; omitted targets the ambient session of the calling pane. */
	session?: string;
	/** Default per-call timeout. */
	timeoutMs?: number;
	/** Extra environment entries merged over the parent environment. */
	env?: Record<string, string>;
}

export interface HerdrCallOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

interface HerdrEnvelope {
	result?: unknown;
	error?: { code?: unknown; message?: unknown };
}

/**
 * Locate the `herdr` executable. `binPath` is a directory that fully replaces
 * the PATH lookup, so tests inject a fake control plane deterministically
 * instead of mutating (or racing) the process environment.
 */
export function resolveHerdrBinary(binPath?: string): string | undefined {
	return $which("herdr", { PATH: binPath ?? Bun.env.PATH, cache: WhichCachePolicy.Bypass }) ?? undefined;
}

/** First JSON envelope in `text`, or undefined when there is none. */
function parseEnvelope(text: string): HerdrEnvelope | undefined {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;
		if (!("result" in parsed) && !("error" in parsed)) continue;
		const error = parsed.error;
		return {
			result: parsed.result,
			...(isRecord(error) ? { error: { code: error.code, message: error.message } } : {}),
		};
	}
	return undefined;
}

export class HerdrCli {
	readonly bin: string;
	readonly session: string | undefined;
	#cwd: string;
	#timeoutMs: number;
	#env: Record<string, string | undefined> | undefined;

	constructor(init: HerdrCliInit) {
		this.bin = init.bin;
		this.session = init.session;
		this.#cwd = init.cwd;
		this.#timeoutMs = init.timeoutMs ?? HERDR_CLI_TIMEOUT_MS;
		this.#env = init.env ? { ...Bun.env, ...init.env } : undefined;
	}

	/** Full argument vector, session-qualified when this CLI targets a named session. */
	argv(args: readonly string[]): string[] {
		return this.session ? ["--session", this.session, ...args] : [...args];
	}

	/** Run a subcommand, tolerating a non-zero exit. */
	async exec(args: readonly string[], options?: HerdrCallOptions): Promise<HerdrCommandResult> {
		const result = await ptree.exec([this.bin, ...this.argv(args)], {
			cwd: this.#cwd,
			...(this.#env ? { env: this.#env } : {}),
			...(options?.signal ? { signal: options.signal } : {}),
			timeout: options?.timeoutMs ?? this.#timeoutMs,
			allowNonZero: true,
			allowAbort: true,
			stderr: "full",
		});
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode ?? 0,
			aborted: Boolean(result.exitError?.aborted),
		};
	}

	/**
	 * Run a subcommand and return its `result` payload. Throws
	 * {@link HerdrCliError} carrying herdr's own error code (`agent_not_ready`,
	 * `agent_blocked`, `agent_prompt_stalled`, …) so callers branch on the
	 * documented lifecycle failures rather than on message text.
	 */
	async json<T>(args: readonly string[], options?: HerdrCallOptions): Promise<T> {
		const run = await this.exec(args, options);
		const combined = run.stdout + (run.stderr ? `\n${run.stderr}` : "");
		const envelope = parseEnvelope(combined);
		if (envelope?.error) {
			const code = typeof envelope.error.code === "string" ? envelope.error.code : HERDR_CLI_FAILED;
			const message = typeof envelope.error.message === "string" ? envelope.error.message : code;
			throw new HerdrCliError(code, message, run.exitCode, combined.trim());
		}
		if (run.aborted) {
			throw new HerdrCliError(
				HERDR_CLI_ABORTED,
				`herdr ${args.slice(0, 2).join(" ")} was aborted or timed out`,
				run.exitCode,
				combined.trim(),
			);
		}
		if (envelope && envelope.result !== undefined) return envelope.result as T;
		const detail = (run.stderr.trim() || run.stdout.trim()).split("\n")[0]?.trim();
		throw new HerdrCliError(
			HERDR_CLI_FAILED,
			detail || `herdr exited ${run.exitCode} without a JSON result`,
			run.exitCode,
			combined.trim(),
		);
	}
}

/** `pane_id`-bearing pane payload shared by `pane get`, `pane split`, `workspace create`. */
export interface HerdrPaneInfo {
	pane_id: string;
	workspace_id?: string;
	tab_id?: string;
	cwd?: string;
	agent_status?: string;
}

/** `herdr workspace create` result. */
export interface HerdrWorkspaceCreated {
	workspace: { workspace_id: string };
	tab?: { tab_id: string };
	root_pane: HerdrPaneInfo;
}

/** `herdr pane split` / `herdr pane get` result. */
export interface HerdrPaneResult {
	pane: HerdrPaneInfo;
}

/** `herdr pane layout` result; rects are terminal cells. */
export interface HerdrLayoutResult {
	layout: {
		focused_pane_id?: string;
		panes: Array<{ pane_id: string; rect: { width: number; height: number } }>;
	};
}

/** `herdr agent get` / `herdr agent prompt --wait` lifecycle payload. */
export interface HerdrAgentState {
	name?: string;
	pane_id?: string;
	state?: string;
	kind?: string;
	message?: string;
}

/** `herdr agent read` result. */
export interface HerdrAgentRead {
	text?: string;
	lines?: string[];
}

/** `herdr agent list` result. */
export interface HerdrAgentList {
	agents: HerdrAgentState[];
}
