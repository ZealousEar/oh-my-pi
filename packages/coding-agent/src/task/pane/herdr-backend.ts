/**
 * HerdR pane execution backend for task subagents.
 *
 * The child is a real, visible, interactive omp process that HerdR starts in a
 * pane it owns. This backend only drives HerdR's control plane: it creates the
 * pane, starts the agent, delivers one prompt, waits for a settled lifecycle
 * state, and reads the durable markdown artifact the child was told to write.
 * Terminal text is never a result: a child that goes idle without delivering
 * the artifact has failed, and its transcript is attached only as evidence.
 *
 * Ownership is strict: the backend closes exactly the pane (or workspace) it
 * created, and nothing else, ever.
 *
 * Liveness is the enclosing job's concern: every lifecycle transition is
 * published through `onProgress`, and a background (async/eval) run relies on
 * its managed job's no-progress watch. The backend arms no timer of its own.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import paneSubagentPrompt from "../../prompts/task/pane-subagent.md" with { type: "text" };
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { AgentProgress, AgentSource, SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import {
	HERDR_CLI_ABORTED,
	type HerdrAgentList,
	type HerdrAgentRead,
	type HerdrAgentState,
	HerdrCliError,
	type HerdrCli,
	type HerdrLayoutResult,
	type HerdrPaneResult,
	type HerdrWorkspaceCreated,
} from "./herdr-cli";
import type { PaneTarget } from "./preflight";

/** Longest valid HerdR agent name (`[a-z][a-z0-9_-]{0,31}`). */
const AGENT_NAME_MAX = 32;

/** Extra CLI slack over a HerdR-side timeout, so HerdR reports the timeout first. */
const CLI_SLACK_MS = 5_000;

/** Bounded wait for the child to settle after an interrupt. */
const CANCEL_IDLE_GRACE_MS = 5_000;

/** How long to keep looking for the result artifact after the child went idle. */
const ARTIFACT_SETTLE_MS = 3_000;

/** Poll interval while waiting for the artifact; also the abort-check cadence. */
const ARTIFACT_POLL_MS = 250;

/** Terminal lines pulled back when the result artifact never appeared. */
const FALLBACK_READ_LINES = 200;

/** A wide pane splits to the right; a narrow or tall one splits down. */
const WIDE_PANE_RATIO = 2;

/** Last line the delivery protocol requires; a file without it is incomplete. */
export const PANE_RESULT_SENTINEL = "<!-- omp-pane-result:end -->";

/** First-line header carrying the model the child actually ran on. */
export const PANE_RESULT_MODEL_HEADER = "resolved-model:";

export interface PaneSubagentOptions {
	cli: HerdrCli;
	target: PaneTarget;
	/** Reserved agent/artifact id; the result artifact is `<artifactsDir>/<id>.md`. */
	id: string;
	index: number;
	/** Resolved agent definition name, reported as `SingleResult.agent`. */
	agentName: string;
	agentSource: AgentSource;
	/** The resolved agent system prompt, delivered as the prompt's role section. */
	systemPrompt?: string;
	/** Parent-session always-apply rule bodies scoped to this agent (unscoped ones the child rediscovers itself), delivered as the prompt's rules section. */
	rules?: string[];
	/** Rendered subagent user prompt, retained verbatim on the result. */
	task: string;
	assignment: string;
	description?: string;
	cwd: string;
	artifactsDir: string;
	/**
	 * Ordered model selectors for the child CLI. One pattern becomes `--model`;
	 * a fallback chain becomes `--models` so every candidate reaches the child.
	 */
	modelPatterns?: string[];
	modelOverride?: string | string[];
	modelRole?: string;
	/** Normalized tool allowlist forwarded as `--tools` (see `resolveSubagentToolPolicy`). */
	toolNames?: string[];
	/** Effective thinking selector forwarded as `--thinking`; per-spawn effort already applied. */
	thinkingLevel?: ConfiguredThinkingLevel;
	/**
	 * Recursion budget the child session keeps (`task.maxRecursionDepth` for a
	 * process starting at depth 0). Undefined leaves the child's own setting.
	 */
	childMaxRecursionDepth?: number;
	readyTimeoutMs: number;
	promptTimeoutMs: number;
	keepPane: boolean;
	/** Environment injected into the new pane (`--env KEY=VALUE`). */
	paneEnv?: Record<string, string>;
	/** Control-plane socket of the targeted server, from preflight. */
	socketPath?: string;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	env?: NodeJS.ProcessEnv;
}

/**
 * Durable identity of one pane worker. Workspace and pane ids (`w1`, `w1:p2`)
 * are only unique inside a single HerdR server, so every record scopes them by
 * session name and control-plane socket path.
 */
export interface PaneWorkerIdentity {
	/** Dedicated session name, or `"current"` for the calling pane's own session. */
	session: string;
	socketPath: string | undefined;
	workspaceId: string | undefined;
	paneId: string | undefined;
	/** HerdR agent name, unique among live agents of that server. */
	agentName: string;
	/** True when this run created the workspace and may therefore close it. */
	ownsWorkspace: boolean;
}

/**
 * Reported pane lifecycle, distinct from the native task status.
 * `ready-for-review` is deliberately separate from a bare `idle`: an idle pane,
 * or the mere existence of a result file, is not evidence that the child's own
 * verification passed. `needs-attention` means the child settled without
 * delivering a complete result and the parent must decide what to do.
 */
export type PaneLifecycle =
	| "creating-pane"
	| "starting-agent"
	| "working"
	| "blocked-needs-user"
	| "idle"
	| "ready-for-review"
	| "needs-attention"
	| "cancelling"
	| "failed";

export type PaneResultSource = NonNullable<SingleResult["resultSource"]>;

export interface PaneSubagentOutcome {
	result: SingleResult;
	/**
	 * Where the result text came from. `artifact-file` is authoritative;
	 * `pane-read` is scraped terminal output attached to a failure.
	 */
	resultSource: PaneResultSource;
	/** Last reported pane lifecycle state. */
	lifecycle: PaneLifecycle;
	identity: PaneWorkerIdentity;
	paneId?: string;
	/** Set only when this run created the workspace, i.e. owns it. */
	workspaceId?: string;
	/** Lifecycle phase timings, in milliseconds since the run started. */
	timings: Record<string, number>;
}

/** Parsed result file: protocol header and sentinel separated from the body. */
export interface PaneResultFile {
	/** Result text with the header and sentinel stripped. */
	body: string;
	/** Model named in the `resolved-model:` header, when present. */
	resolvedModel: string | undefined;
	/** True when the file ends with {@link PANE_RESULT_SENTINEL}. */
	complete: boolean;
}

/** Split a result file into its protocol header, body, and completion marker. */
export function parsePaneResultFile(text: string): PaneResultFile {
	let body = text;
	let resolvedModel: string | undefined;
	const firstLineEnd = body.indexOf("\n");
	const firstLine = (firstLineEnd === -1 ? body : body.slice(0, firstLineEnd)).trim();
	if (firstLine.toLowerCase().startsWith(PANE_RESULT_MODEL_HEADER)) {
		resolvedModel = firstLine.slice(PANE_RESULT_MODEL_HEADER.length).trim() || undefined;
		body = firstLineEnd === -1 ? "" : body.slice(firstLineEnd + 1);
	}
	const trimmed = body.trimEnd();
	const complete = trimmed === PANE_RESULT_SENTINEL || trimmed.endsWith(`\n${PANE_RESULT_SENTINEL}`);
	if (complete) body = trimmed.slice(0, trimmed.length - PANE_RESULT_SENTINEL.length);
	return { body: body.trim(), resolvedModel, complete };
}

/** Derive a valid, stable HerdR agent name from a reserved omp agent id. */
function paneAgentName(id: string): string {
	const slug = id
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[^a-z]+/, "");
	const base = (slug || `omp-${id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`).replace(/^[^a-z]+/, "omp-");
	return base.slice(0, AGENT_NAME_MAX).replace(/[-_]+$/, "") || "omp-task";
}

/** Best-effort text extraction from an `agent read` payload. */
function readText(payload: unknown): string {
	if (!isRecord(payload)) return "";
	if (typeof payload.text === "string") return payload.text;
	if (Array.isArray(payload.lines)) return payload.lines.filter(line => typeof line === "string").join("\n");
	if (isRecord(payload.read)) return readText(payload.read);
	return "";
}

type ArtifactRead =
	| { kind: "complete"; file: PaneResultFile }
	/** Sentinel-terminated but missing the `resolved-model:` header. */
	| { kind: "unattributed"; text: string }
	| { kind: "partial"; text: string }
	| { kind: "missing" }
	| { kind: "aborted" };

class PaneRun {
	#options: PaneSubagentOptions;
	#progress: AgentProgress;
	#startedAt = Date.now();
	/** Whole-second floor of the launch instant; artifacts older than this are not this run's. */
	#launchedAt = 0;
	#timings: Record<string, number> = {};
	#notes: string[] = [];
	#paneId: string | undefined;
	#ownedWorkspaceId: string | undefined;
	#agentStarted = false;
	#agentName: string;
	#outputPath: string;
	#configOverlayPath: string;
	#lifecycle: PaneLifecycle = "creating-pane";

	constructor(options: PaneSubagentOptions) {
		this.#options = options;
		this.#agentName = paneAgentName(options.id);
		this.#outputPath = path.join(options.artifactsDir, `${options.id}.md`);
		this.#configOverlayPath = path.join(options.artifactsDir, `${options.id}.pane-config.yml`);
		this.#progress = {
			index: options.index,
			id: options.id,
			agent: options.agentName,
			agentSource: options.agentSource,
			status: "pending",
			task: options.task,
			assignment: options.assignment,
			...(options.description ? { description: options.description } : {}),
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
			...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
			...(options.modelRole ? { modelRole: options.modelRole } : {}),
		};
	}

	#mark(label: string): void {
		this.#timings[label] = Date.now() - this.#startedAt;
	}

	get #aborted(): boolean {
		return this.#options.signal?.aborted === true;
	}

	/**
	 * Cancellable control-plane call. Once the run is aborted no further herdr
	 * process is spawned: the call fails at once with {@link HERDR_CLI_ABORTED},
	 * and every caller then routes through {@link #abortedOutcome}. Cleanup
	 * (interrupt, `agent wait`, closing the owned pane) deliberately bypasses
	 * this method so releasing what the run created still happens after abort.
	 */
	async #call<T>(args: readonly string[], timeoutMs?: number): Promise<T> {
		const { cli, signal } = this.#options;
		if (signal?.aborted) {
			throw new HerdrCliError(
				HERDR_CLI_ABORTED,
				`herdr ${args.slice(0, 2).join(" ")} was not issued: the pane subagent was cancelled`,
				-1,
				"",
			);
		}
		return cli.json<T>(args, {
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
			...(signal ? { signal } : {}),
		});
	}

	/**
	 * Publish a pane state transition: the task card shows `pane w1:p3 · working`.
	 * Native task status and pane lifecycle are reported separately, because a
	 * completed task whose pane merely went idle is only ready for review.
	 */
	#emit(status: AgentProgress["status"], lifecycle: PaneLifecycle): void {
		this.#lifecycle = lifecycle;
		this.#progress = {
			...this.#progress,
			status,
			durationMs: Date.now() - this.#startedAt,
			lastIntent: this.#paneId ? `pane ${this.#paneId} · ${lifecycle}` : `pane · ${lifecycle}`,
			recentTools: this.#progress.recentTools.slice(),
			recentOutput: this.#progress.recentOutput.slice(),
		};
		this.#options.onProgress?.(this.#progress);
	}

	/** Session- and socket-scoped record of the worker this run owns. */
	#identity(): PaneWorkerIdentity {
		return {
			session: this.#options.target.kind === "session" ? this.#options.target.session : "current",
			socketPath: this.#options.socketPath,
			workspaceId: this.#ownedWorkspaceId,
			paneId: this.#paneId,
			agentName: this.#agentName,
			ownsWorkspace: this.#ownedWorkspaceId !== undefined,
		};
	}

	/**
	 * Clear anything at the artifact path so only this child's write can be
	 * accepted, and write the settings overlay carrying the child's recursion
	 * budget. Failing here means no pane is created.
	 */
	async #prepareArtifacts(): Promise<void> {
		await fs.mkdir(this.#options.artifactsDir, { recursive: true });
		await fs.rm(this.#outputPath, { force: true });
		if (this.#options.childMaxRecursionDepth !== undefined) {
			await fs.writeFile(
				this.#configOverlayPath,
				`task:\n  maxRecursionDepth: ${this.#options.childMaxRecursionDepth}\n`,
			);
		} else {
			await fs.rm(this.#configOverlayPath, { force: true });
		}
		// Whole-second floor: filesystems with coarse mtime resolution truncate,
		// so a legitimate write in the launch second must still be accepted.
		this.#launchedAt = Math.floor(Date.now() / 1000) * 1000;
	}

	#envArgs(): string[] {
		const entries = Object.entries(this.#options.paneEnv ?? {});
		if (this.#options.childMaxRecursionDepth !== undefined) {
			const inherited = this.#options.env?.PI_CONFIG_FILES?.trim();
			entries.push([
				"PI_CONFIG_FILES",
				inherited ? `${inherited}${path.delimiter}${this.#configOverlayPath}` : this.#configOverlayPath,
			]);
		}
		return entries.flatMap(([key, value]) => ["--env", `${key}=${value}`]);
	}

	/** Create the pane this run owns, and record what may later be closed. */
	async #createPane(): Promise<void> {
		const { target, cwd, id } = this.#options;
		if (target.kind === "session") {
			const created = await this.#call<HerdrWorkspaceCreated>([
				"workspace",
				"create",
				"--cwd",
				cwd,
				"--label",
				`omp-task-${id}`,
				...this.#envArgs(),
				"--no-focus",
			]);
			this.#ownedWorkspaceId = created.workspace.workspace_id;
			this.#paneId = created.root_pane.pane_id;
			this.#mark("workspaceCreatedMs");
			return;
		}
		const split = await this.#call<HerdrPaneResult>([
			"pane",
			"split",
			"--current",
			"--direction",
			await this.#splitDirection(),
			"--cwd",
			cwd,
			...this.#envArgs(),
			"--no-focus",
		]);
		this.#paneId = split.pane.pane_id;
		this.#mark("paneSplitMs");
	}

	/**
	 * Split a wide caller pane to the right and a narrow or tall one down, so
	 * repeated spawns do not produce unusable columns. Terminal cells are about
	 * twice as tall as they are wide, hence the 2:1 comparison.
	 */
	async #splitDirection(): Promise<"right" | "down"> {
		const paneId = this.#options.env?.HERDR_PANE_ID;
		try {
			const layout = await this.#call<HerdrLayoutResult>(["pane", "layout", "--current"]);
			const target = paneId ?? layout.layout.focused_pane_id;
			const rect = layout.layout.panes.find(pane => pane.pane_id === target)?.rect;
			if (!rect) return "right";
			return rect.width >= rect.height * WIDE_PANE_RATIO ? "right" : "down";
		} catch (error) {
			logger.debug("pane backend: layout probe failed, defaulting to a right split", { error });
			return "right";
		}
	}

	/** Reserve a name no live agent holds; HerdR requires uniqueness. */
	async #reserveName(): Promise<void> {
		let live: HerdrAgentList;
		try {
			live = await this.#call<HerdrAgentList>(["agent", "list"]);
		} catch (error) {
			logger.debug("pane backend: agent list failed, using the derived name", { error });
			return;
		}
		const taken = new Set((live.agents ?? []).map(agent => agent.name).filter(name => typeof name === "string"));
		if (!taken.has(this.#agentName)) return;
		for (let suffix = 2; suffix < 100; suffix++) {
			const tail = `-${suffix}`;
			const candidate = `${this.#agentName.slice(0, AGENT_NAME_MAX - tail.length)}${tail}`;
			if (!taken.has(candidate)) {
				this.#agentName = candidate;
				return;
			}
		}
	}

	/** Start the child omp in the owned pane and wait for interactive readiness. */
	async #startAgent(): Promise<void> {
		const { readyTimeoutMs, modelPatterns, toolNames, thinkingLevel } = this.#options;
		const childArgs: string[] = [];
		if (modelPatterns?.length === 1) childArgs.push("--model", modelPatterns[0]);
		else if (modelPatterns && modelPatterns.length > 1) childArgs.push("--models", modelPatterns.join(","));
		if (thinkingLevel) childArgs.push("--thinking", thinkingLevel);
		// An explicit empty allowlist is a contract, not an omission: the child
		// starts with no tools rather than its defaults.
		if (toolNames !== undefined) {
			if (toolNames.length === 0) childArgs.push("--no-tools");
			else childArgs.push("--tools", toolNames.join(","));
		}
		this.#agentStarted = true;
		await this.#call<unknown>(
			[
				"agent",
				"start",
				this.#agentName,
				"--kind",
				"omp",
				"--pane",
				this.#paneId ?? "",
				"--timeout",
				String(readyTimeoutMs),
				...(childArgs.length > 0 ? ["--", ...childArgs] : []),
			],
			readyTimeoutMs + CLI_SLACK_MS,
		);
		this.#mark("agentReadyMs");
	}

	/** Deliver the single prompt and wait for the first settled lifecycle state. */
	async #prompt(): Promise<HerdrAgentState> {
		const { promptTimeoutMs } = this.#options;
		const text = prompt.render(paneSubagentPrompt, {
			role: this.#options.systemPrompt?.trim(),
			rules: this.#options.rules ?? [],
			assignment: this.#options.assignment,
			outputPath: this.#outputPath,
			paneId: this.#paneId,
		});
		const settled = await this.#call<HerdrAgentState>(
			["agent", "prompt", this.#agentName, text, "--wait", "--timeout", String(promptTimeoutMs)],
			promptTimeoutMs + CLI_SLACK_MS,
		);
		this.#mark("promptSettledMs");
		return settled;
	}

	/**
	 * Read the artifact, retrying briefly across the child's flush. Only a file
	 * written after launch counts; it is complete only when it carries the
	 * `resolved-model:` header and ends with the completion sentinel. An abort
	 * during the wait is honoured at once.
	 */
	async #readArtifact(): Promise<ArtifactRead> {
		const deadline = Date.now() + ARTIFACT_SETTLE_MS;
		let partial: string | undefined;
		for (;;) {
			if (this.#aborted) return { kind: "aborted" };
			try {
				const stat = await fs.stat(this.#outputPath);
				if (stat.mtimeMs >= this.#launchedAt) {
					const text = await fs.readFile(this.#outputPath, "utf8");
					const file = parsePaneResultFile(text);
					if (file.complete) {
						this.#mark("artifactReadMs");
						return file.resolvedModel ? { kind: "complete", file } : { kind: "unattributed", text };
					}
					if (text.trim()) partial = text;
				} else {
					logger.debug("pane backend: ignoring a result file older than this launch", {
						path: this.#outputPath,
						mtimeMs: stat.mtimeMs,
						launchedAt: this.#launchedAt,
					});
				}
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			if (Date.now() >= deadline) break;
			await Bun.sleep(ARTIFACT_POLL_MS);
		}
		if (this.#aborted) return { kind: "aborted" };
		return partial !== undefined ? { kind: "partial", text: partial } : { kind: "missing" };
	}

	/** Scrape the pane transcript as evidence of what the child was doing. */
	async #readPane(): Promise<string> {
		try {
			const payload = await this.#options.cli.json<HerdrAgentRead>([
				"agent",
				"read",
				this.#agentName,
				"--source",
				"recent-unwrapped",
				"--lines",
				String(FALLBACK_READ_LINES),
			]);
			return readText(payload);
		} catch (error) {
			logger.debug("pane backend: agent read failed", { error });
			return "";
		}
	}

	/** Close only what this run created. */
	async #closeOwned(): Promise<void> {
		if (this.#options.keepPane) {
			this.#notes.push(`pane ${this.#paneId ?? "?"} was left open (task.herdr.keepPane)`);
			return;
		}
		try {
			if (this.#ownedWorkspaceId) {
				await this.#options.cli.json<unknown>(["workspace", "close", this.#ownedWorkspaceId]);
			} else if (this.#paneId) {
				await this.#options.cli.json<unknown>(["pane", "close", this.#paneId]);
			}
			this.#mark("closedMs");
		} catch (error) {
			logger.warn("pane backend: failed to close the owned pane", {
				pane: this.#paneId,
				workspace: this.#ownedWorkspaceId,
				error,
			});
			this.#notes.push(`the owned pane ${this.#paneId ?? "?"} could not be closed automatically`);
		}
	}

	/** Interrupt the child, wait boundedly for it to settle, then release the pane. */
	async #cancel(): Promise<void> {
		this.#emit("aborted", "cancelling");
		if (this.#agentStarted) {
			try {
				await this.#options.cli.json<unknown>(["agent", "send-keys", this.#agentName, "ctrl+c"]);
				await this.#options.cli.json<unknown>(
					["agent", "wait", this.#agentName, "--until", "idle", "--timeout", String(CANCEL_IDLE_GRACE_MS)],
					{ timeoutMs: CANCEL_IDLE_GRACE_MS + CLI_SLACK_MS },
				);
			} catch (error) {
				logger.debug("pane backend: interrupt did not settle", { error });
			}
		}
		this.#mark("cancelledMs");
		await this.#closeOwned();
	}

	/** Cancel and report an aborted, never successful, result. */
	async #abortedOutcome(error: string): Promise<PaneSubagentOutcome> {
		await this.#cancel();
		return this.#outcome(this.#buildResult({ exitCode: 1, output: "", aborted: true, error }), "none");
	}

	#location(): string {
		const where = this.#options.target.kind === "session" ? ` in HerdR session ${this.#options.target.session}` : "";
		return `${this.#paneId ?? "unassigned pane"}${where}`;
	}

	#buildResult(fields: {
		exitCode: number;
		output: string;
		error?: string;
		aborted?: boolean;
		outputPath?: string;
		resolvedModel?: string;
		/** Evidence appended to stderr (partial file, scraped transcript). */
		evidence?: { label: string; text: string };
	}): SingleResult {
		const identity = this.#identity();
		const disclosures = [
			`ran as HerdR worker ${identity.agentName} in pane ${this.#location()}`,
			`worker identity: session=${identity.session} socket=${identity.socketPath ?? "unknown"} workspace=${identity.workspaceId ?? "-"} pane=${identity.paneId ?? "-"}`,
			fields.resolvedModel
				? `the child reported resolved-model: ${fields.resolvedModel} (self-reported, not observed by the parent)`
				: "the child did not report which model served the run (no resolved-model header)",
			"an idle pane and a written result are not proof that the child's own verification passed: review the work",
			"pane subagents cannot be messaged through agent:// writes and take no follow-up turns",
			"token and cost accounting stay in the pane session",
			...this.#notes,
		];
		if (fields.evidence?.text.trim()) {
			disclosures.push(`--- ${fields.evidence.label} ---`, fields.evidence.text.trim());
		}
		return {
			index: this.#options.index,
			id: this.#options.id,
			agent: this.#options.agentName,
			agentSource: this.#options.agentSource,
			task: this.#options.task,
			assignment: this.#options.assignment,
			...(this.#options.description ? { description: this.#options.description } : {}),
			exitCode: fields.exitCode,
			output: fields.output,
			stderr: disclosures.join("\n"),
			truncated: false,
			durationMs: Date.now() - this.#startedAt,
			tokens: 0,
			requests: 0,
			...(this.#options.modelOverride ? { modelOverride: this.#options.modelOverride } : {}),
			...(this.#options.modelRole ? { modelRole: this.#options.modelRole } : {}),
			...(fields.resolvedModel
				? { resolvedModel: fields.resolvedModel, resolvedModelVerified: true }
				: { resolvedModelVerified: false }),
			...(fields.outputPath ? { outputPath: fields.outputPath } : {}),
			...(fields.error ? { error: fields.error } : {}),
			...(fields.aborted ? { aborted: true } : {}),
			outputMeta: { lineCount: fields.output.split("\n").length, charCount: fields.output.length },
		};
	}

	#outcome(result: SingleResult, resultSource: PaneResultSource): PaneSubagentOutcome {
		const identity = this.#identity();
		result.resultSource = resultSource;
		logger.debug("pane subagent timing", {
			id: this.#options.id,
			resultSource,
			lifecycle: this.#lifecycle,
			...identity,
			...this.#timings,
		});
		return {
			result,
			resultSource,
			lifecycle: this.#lifecycle,
			identity,
			...(this.#paneId ? { paneId: this.#paneId } : {}),
			...(this.#ownedWorkspaceId ? { workspaceId: this.#ownedWorkspaceId } : {}),
			timings: this.#timings,
		};
	}

	async run(): Promise<PaneSubagentOutcome> {
		if (this.#aborted) {
			this.#emit("aborted", "cancelling");
			return this.#outcome(
				this.#buildResult({
					exitCode: 1,
					output: "",
					aborted: true,
					error: "the pane subagent was cancelled before its pane was created",
				}),
				"none",
			);
		}
		this.#emit("pending", "creating-pane");
		try {
			await this.#prepareArtifacts();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#emit("failed", "failed");
			return this.#outcome(
				this.#buildResult({
					exitCode: 1,
					output: "",
					error: `a stale result file at ${this.#outputPath} could not be removed, so no pane was started: ${message}`,
				}),
				"none",
			);
		}
		try {
			await this.#createPane();
		} catch (error) {
			if (this.#aborted) {
				return this.#abortedOutcome("the pane subagent was cancelled while its pane was being created");
			}
			throw error;
		}
		if (this.#aborted) return this.#abortedOutcome("the pane subagent was cancelled before its agent started");
		this.#emit("running", "starting-agent");
		await this.#reserveName();
		try {
			await this.#startAgent();
		} catch (error) {
			if (this.#aborted) return this.#abortedOutcome("the pane subagent was cancelled while its agent was starting");
			const message = error instanceof HerdrCliError ? error.message : String(error);
			const code = error instanceof HerdrCliError ? error.code : "start_failed";
			// The pane stays open on a readiness failure: HerdR keeps the name
			// usable for `agent read`/`send-keys`, which is the user's only way
			// to see what the child is stuck on.
			this.#notes.push(`pane ${this.#paneId ?? "?"} was retained so you can inspect the child (\`${code}\`)`);
			this.#emit("failed", "failed");
			return this.#outcome(
				this.#buildResult({
					exitCode: 1,
					output: await this.#readPane(),
					error: `the pane agent never became ready (${code}): ${message}`,
				}),
				"pane-read",
			);
		}

		if (this.#aborted) return this.#abortedOutcome("the pane subagent was cancelled before its prompt was delivered");
		this.#emit("running", "working");
		let settled: HerdrAgentState;
		try {
			settled = await this.#prompt();
		} catch (error) {
			if (this.#aborted) return this.#abortedOutcome("the pane subagent was cancelled");
			const code = error instanceof HerdrCliError ? error.code : "prompt_failed";
			const message = error instanceof HerdrCliError ? error.message : String(error);
			const excerpt = await this.#readPane();
			if (code === "agent_blocked") {
				// Blocked means HerdR recognized an approval or question UI. Only
				// the user can answer it, in the pane, so the pane is retained.
				this.#notes.push(`pane ${this.#paneId ?? "?"} is waiting for your answer and was left open`);
				this.#emit("failed", "blocked-needs-user");
				return this.#outcome(
					this.#buildResult({
						exitCode: 1,
						output: excerpt,
						error: `the pane agent is blocked on a prompt in pane ${this.#location()}; answer it there: ${message}`,
					}),
					"pane-read",
				);
			}
			this.#notes.push(`pane ${this.#paneId ?? "?"} was retained after \`${code}\``);
			this.#emit("failed", "failed");
			return this.#outcome(
				this.#buildResult({
					exitCode: 1,
					output: excerpt,
					error: `the pane agent did not settle (${code}): ${message}`,
				}),
				"pane-read",
			);
		}
		if (this.#aborted) return this.#abortedOutcome("the pane subagent was cancelled after its prompt settled");

		if (settled.state === "blocked") {
			this.#notes.push(`pane ${this.#paneId ?? "?"} is waiting for your answer and was left open`);
			this.#emit("failed", "blocked-needs-user");
			return this.#outcome(
				this.#buildResult({
					exitCode: 1,
					output: await this.#readPane(),
					error: `the pane agent is blocked on a prompt in pane ${this.#location()}; answer it there`,
				}),
				"pane-read",
			);
		}

		this.#emit("running", "idle");
		const artifact = await this.#readArtifact();
		if (artifact.kind === "aborted") {
			return this.#abortedOutcome("the pane subagent was cancelled while its result was being collected");
		}
		if (artifact.kind === "complete") {
			await this.#closeOwned();
			// Result collection happens before the owned pane is released, and
			// the pane is the only place the child's work is visible.
			this.#emit("completed", "ready-for-review");
			return this.#outcome(
				this.#buildResult({
					exitCode: 0,
					output: artifact.file.body,
					outputPath: this.#outputPath,
					...(artifact.file.resolvedModel ? { resolvedModel: artifact.file.resolvedModel } : {}),
				}),
				"artifact-file",
			);
		}
		if (artifact.kind === "unattributed") {
			// Sealed but unattributed: without the header the parent cannot tell
			// which model produced the text, so it is never accepted as a result.
			await this.#closeOwned();
			this.#emit("failed", "needs-attention");
			return this.#outcome(
				this.#buildResult({
					exitCode: 1,
					output: "",
					error: `the child's result file has no \`${PANE_RESULT_MODEL_HEADER}\` first line, so its model cannot be verified`,
					evidence: { label: "unattributed result file", text: artifact.text },
				}),
				"none",
			);
		}
		if (artifact.kind === "partial") {
			// The child wrote something but never closed the file with the
			// sentinel: the parent cannot tell a truncated write from a finished
			// one, so the run fails and the text is attached only as evidence.
			const file = parsePaneResultFile(artifact.text);
			await this.#closeOwned();
			this.#emit("failed", "needs-attention");
			return this.#outcome(
				this.#buildResult({
					exitCode: 1,
					output: "",
					error: `the child wrote an incomplete result file (missing the closing \`${PANE_RESULT_SENTINEL}\` line)`,
					...(file.resolvedModel ? { resolvedModel: file.resolvedModel } : {}),
					evidence: { label: "partial result file", text: artifact.text },
				}),
				"none",
			);
		}

		// The child went idle without writing the artifact. Its transcript is
		// evidence of what happened, never a result.
		const scraped = await this.#readPane();
		await this.#closeOwned();
		this.#emit("failed", "needs-attention");
		return this.#outcome(
			this.#buildResult({
				exitCode: 1,
				output: "",
				error: "child went idle without delivering a result file",
				evidence: { label: "pane transcript (not a result)", text: scraped },
			}),
			scraped.trim() ? "pane-read" : "none",
		);
	}
}

/**
 * Run one subagent in a HerdR pane. Resolves with a complete
 * {@link SingleResult}; rejects only when HerdR could not even create the pane.
 */
export async function runPaneSubagent(options: PaneSubagentOptions): Promise<PaneSubagentOutcome> {
	return new PaneRun(options).run();
}
