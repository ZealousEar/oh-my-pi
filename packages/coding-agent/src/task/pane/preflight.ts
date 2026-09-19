/**
 * Backend selection and prerequisite checks for the HerdR pane task backend.
 *
 * Two admissible targets exist, and nothing else:
 *   - the calling pane, when omp really runs inside HerdR (`HERDR_ENV=1` or an
 *     authoritative pane id — see `isInsideHerdr`). New panes are siblings
 *     created with `pane split --current`.
 *   - an explicitly configured dedicated session (`task.herdr.session`), whose
 *     server must already be running. New panes live in their own workspace.
 *
 * The user's `default` session is deliberately not addressable: task subagents
 * must never appear in, or take focus inside, the session the user is driving
 * by hand.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, parseFlag } from "@oh-my-pi/pi-utils";
import { isInsideHerdr } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import type { Settings } from "../../config/settings";
import { HerdrCli, type HerdrCommandResult, resolveHerdrBinary } from "./herdr-cli";

/** `task.paneBackend` values. */
export const PANE_BACKENDS = ["auto", "native", "herdr"] as const;

export type PaneBackendSetting = (typeof PANE_BACKENDS)[number];

/** Relative path of the file `herdr integration install omp` writes into an omp agent dir. */
export const HERDR_OMP_EXTENSION_RELPATH = path.join("extensions", "herdr-omp-agent-state.ts");

/**
 * What the user must do before an explicitly requested pane spawn can run.
 * Named once so the error text, the settings description, and the docs agree.
 */
export const PANE_PREREQUISITE_HINT =
	"run omp inside a HerdR pane with the OMP integration installed, or set task.herdr.session to a dedicated session";

/** Resolved `task.paneBackend` / `task.herdr.*` configuration. */
export interface PaneBackendConfig {
	backend: PaneBackendSetting;
	/** Dedicated named session, or undefined to target the calling pane. */
	session: string | undefined;
	readyTimeoutMs: number;
	promptTimeoutMs: number;
	keepPane: boolean;
}

/** Where the backend may create panes. */
export type PaneTarget = { kind: "current" } | { kind: "session"; session: string };

/** Outcome of {@link requestPaneBackend}. */
export type PaneBackendRequest =
	/** Run natively. */
	| { use: false }
	/**
	 * Run in a pane. `strict` requests came from `visible: true` or
	 * `task.paneBackend=herdr`, so a failed preflight is an error rather than a
	 * silent downgrade to the native backend.
	 */
	| { use: true; strict: boolean };

export interface PaneBackendRequestOptions {
	config: PaneBackendConfig;
	/** Per-item `visible: true`. */
	visible?: boolean;
	env?: NodeJS.ProcessEnv;
}

/** Capabilities the requested run needs that a pane-hosted omp cannot provide. */
export interface PaneCapabilityProbe {
	/** A caller or agent output schema was selected. */
	outputSchema: boolean;
	/** The run was requested in an isolation worktree. */
	isolated: boolean;
	/** Kernel-defined eval tools were exposed to the child. */
	customTools: boolean;
	/** The child would hold the `task` tool and spawn its own children. */
	nestedSpawn: boolean;
	/** Parent MCP servers would be proxied into the child. */
	mcpProxies: boolean;
	/** An advisor was configured for this agent. */
	advisor: boolean;
	/** Prewalk hand-off was configured for this agent. */
	prewalk: boolean;
	/**
	 * The parent session is restricted (plan mode or an explicit host tool
	 * allowlist). A fresh pane omp has no restricted mode: it would discover
	 * extensions, MCP, LSP, and hub the parent never granted.
	 */
	restrictedSession: boolean;
}

/**
 * A successful preflight also reports the control-plane socket of the running
 * server. Pane and workspace ids are only unique within one HerdR server, so
 * durable worker identity must be scoped by session name plus socket path.
 */
export type PanePreflight =
	| { ok: true; cli: HerdrCli; target: PaneTarget; socketPath: string | undefined }
	| { ok: false; reason: string };

export interface PanePreflightOptions {
	config: PaneBackendConfig;
	cwd: string;
	capabilities: PaneCapabilityProbe;
	env?: NodeJS.ProcessEnv;
	/** Directory prepended to the `herdr` lookup path; tests inject a fake CLI. */
	binPath?: string;
	/**
	 * Agent dir the child will run with (`PI_CODING_AGENT_DIR`). The omp
	 * integration must be installed there, not merely somewhere HerdR reports.
	 */
	agentDir?: string;
	signal?: AbortSignal;
}

/** Read the pane-backend settings block. */
export function readPaneBackendConfig(settings: Settings): PaneBackendConfig {
	const configured = settings.get("task.herdr.session")?.trim();
	return {
		backend: settings.get("task.paneBackend"),
		session: configured || undefined,
		readyTimeoutMs: settings.get("task.herdr.readyTimeoutMs"),
		promptTimeoutMs: settings.get("task.herdr.promptTimeoutMs"),
		keepPane: settings.get("task.herdr.keepPane"),
	};
}

/**
 * Decide whether this spawn asks for a pane at all.
 *
 * `OMP_TASK_HERDR` is the final override in both directions, exactly like
 * `PI_BROWSER_RELAY` over `browser.relay`: `0` is a hard kill switch even for
 * an explicit `visible: true`, `1` enables the auto path on a session that
 * left `task.paneBackend` at its default.
 */
export function requestPaneBackend(options: PaneBackendRequestOptions): PaneBackendRequest {
	const { config } = options;
	const env = options.env ?? process.env;
	const explicit = options.visible === true || config.backend === "herdr";
	if (!parseFlag(env.OMP_TASK_HERDR, explicit || config.backend === "auto")) return { use: false };
	if (explicit) return { use: true, strict: true };
	// `auto` is ambient-only: it never reaches out to a separate session, and it
	// never runs when this process is not really inside a HerdR pane.
	if (config.session !== undefined) return { use: false };
	if (!isInsideHerdr(env)) return { use: false };
	return { use: true, strict: false };
}

/**
 * Capabilities that must fail preflight instead of vanishing. A pane child is
 * an ordinary interactive omp process: it has no structured yield channel, no
 * parent worktree, no parent eval kernel, no parent MCP connections, no
 * advisor/prewalk wiring, and no restricted-session mode.
 */
export function describeUnsupportedCapabilities(capabilities: PaneCapabilityProbe): string[] {
	const rejected: string[] = [];
	if (capabilities.outputSchema) rejected.push("a structured outputSchema");
	if (capabilities.isolated) rejected.push("an isolated worktree");
	if (capabilities.customTools) rejected.push("eval-defined custom tools");
	if (capabilities.nestedSpawn) rejected.push("nested subagent spawning");
	if (capabilities.mcpProxies) rejected.push("proxied parent MCP tools");
	if (capabilities.advisor) rejected.push("an attached advisor");
	if (capabilities.prewalk) rejected.push("a prewalk hand-off");
	if (capabilities.restrictedSession)
		rejected.push("a restricted parent session (plan mode or an explicit tool allowlist)");
	return rejected;
}

/** True when `herdr status` reports a running server for the targeted session. */
function serverIsRunning(status: HerdrCommandResult): boolean {
	return /^\s+status:\s*running\s*$/m.test(status.stdout);
}

/**
 * Parse `herdr integration status` for the `omp` row. Returns undefined when
 * the subcommand is unavailable (older binary: usage text, exit 2), so the
 * caller can fall back to the installed extension file. `path` is the
 * extension file HerdR reports, which is where it actually installed.
 */
function parseOmpIntegration(
	status: HerdrCommandResult,
): { installed: boolean; detail: string; path: string | undefined } | undefined {
	const match = /^omp:\s*(.+)$/m.exec(status.stdout);
	if (!match) return undefined;
	const detail = match[1]?.trim() ?? "";
	const installedPath = /\(([^()]*herdr-omp-agent-state\.ts)\)\s*$/.exec(detail)?.[1];
	return { installed: !detail.startsWith("not installed"), detail, path: installedPath };
}

/** Resolve prerequisites and return a CLI bound to the admissible target. */
export async function preflightPaneBackend(options: PanePreflightOptions): Promise<PanePreflight> {
	const env = options.env ?? process.env;
	const { config } = options;

	const rejected = describeUnsupportedCapabilities(options.capabilities);
	if (rejected.length > 0) {
		return {
			ok: false,
			reason: `the HerdR pane backend cannot provide ${rejected.join(", ")}; run this subagent natively`,
		};
	}

	let target: PaneTarget;
	if (config.session !== undefined) {
		if (config.session === "default") {
			return {
				ok: false,
				reason:
					'task.herdr.session must name a dedicated session; "default" is the session the user drives by hand',
			};
		}
		target = { kind: "session", session: config.session };
	} else if (isInsideHerdr(env)) {
		target = { kind: "current" };
	} else {
		return { ok: false, reason: `omp is not running inside a HerdR pane: ${PANE_PREREQUISITE_HINT}` };
	}

	const bin = resolveHerdrBinary(options.binPath);
	if (!bin) {
		return { ok: false, reason: "the `herdr` binary is not on PATH; install HerdR (https://herdr.dev) first" };
	}
	const cli = new HerdrCli({
		bin,
		cwd: options.cwd,
		...(target.kind === "session" ? { session: target.session } : {}),
	});

	const status = await cli.exec(["status"], { signal: options.signal });
	if (!serverIsRunning(status)) {
		const label = target.kind === "session" ? `session "${target.session}"` : "the current HerdR session";
		return { ok: false, reason: `${label} has no running HerdR server; start it before spawning visible subagents` };
	}
	const socketPath = /^\s+socket:\s*(\S+)\s*$/m.exec(status.stdout)?.[1];

	const agentDir = options.agentDir ?? env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent");
	const extension = path.join(agentDir, HERDR_OMP_EXTENSION_RELPATH);
	const installHint = `run \`PI_CODING_AGENT_DIR=${agentDir} herdr integration install omp\``;
	const integration = await cli.exec(["integration", "status"], { signal: options.signal });
	const parsed = parseOmpIntegration(integration);
	if (parsed) {
		if (!parsed.installed) {
			return {
				ok: false,
				reason: `the HerdR omp integration is not installed (${parsed.detail}); ${installHint} so pane lifecycle states are reported`,
			};
		}
		// HerdR reports the install for its own environment's agent dir. The
		// child uses `agentDir`, so an install anywhere else is not usable.
		if (parsed.path !== undefined && path.resolve(parsed.path) !== path.resolve(extension)) {
			return {
				ok: false,
				reason: `the HerdR omp integration is installed at ${parsed.path}, but the pane child uses agent dir ${agentDir} (${extension}); ${installHint}`,
			};
		}
	} else {
		try {
			await fs.access(extension);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			return {
				ok: false,
				reason: `the HerdR omp integration is missing (${extension} not found); ${installHint}`,
			};
		}
	}

	return { ok: true, cli, target, socketPath };
}
