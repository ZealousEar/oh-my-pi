import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Answer, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { registerArtifactsDir } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { LoopMeter } from "@oh-my-pi/pi-coding-agent/judgment/decision";
import type { ResolvedJudge } from "@oh-my-pi/pi-coding-agent/judgment/index";
import { contentHash, resolveReductionPolicy, type ReductionJudge } from "@oh-my-pi/pi-coding-agent/reduction/contract";
import { pruneBashOutput } from "@oh-my-pi/pi-coding-agent/reduction/output-pruning";
import { collectTaskContext } from "@oh-my-pi/pi-coding-agent/reduction/task-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";

const cleanup: string[] = [];
const asyncManagers: AsyncJobManager[] = [];
const unregisterArtifactDirs: Array<() => void> = [];

interface OutputState {
	command: string;
	task: {
		original_request: string;
		latest_request: string;
		latest_reply: string;
		standing_requirements: string[];
	};
}

class ScriptedJudge implements ResolvedJudge {
	readonly kind = "online" as const;
	readonly label = "scripted-bash-output-pruner";
	readonly requests: JudgmentRequest[] = [];
	calls = 0;

	judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		this.calls++;
		this.requests.push(request);
		const answers: Record<string, Answer> = {};
		for (const id in request.questions) answers[id] = { type: "noul", noul: 0.05 };
		return Promise.resolve({
			api: "scripted",
			provider: "fake",
			model: "fake-output-judge",
			answers,
			usage: tokenUsage(12, 3),
		} as unknown as JudgmentResult<Q>);
	}
}

function admission(judge: ResolvedJudge, configured: Settings): ReductionJudge {
	const policy = resolveReductionPolicy(configured);
	return {
		judge,
		meter: new LoopMeter({
			maxCalls: policy.maxCallsPerPass,
			maxActions: 0,
			deadlineAt: Date.now() + policy.maxLatencyMs,
		}),
		policy,
	};
}

function pruningSettings(mode: "off" | "deterministic" | "semantic", asyncEnabled = false): Settings {
	return Settings.isolated({
		"async.enabled": asyncEnabled,
		"bash.autoBackground.enabled": false,
		"bash.outputPruning.mode": mode,
		"bash.outputPruning.minTokens": 0,
		"bash.outputPruning.maxSegments": 40,
		"reduction.egress": "selected",
		"reduction.maxCallsPerPass": 2,
		"reduction.maxLatencyMs": 5_000,
	});
}

async function harness(
	mode: "off" | "deterministic" | "semantic",
	asyncEnabled = false,
	userTurns: readonly string[] | null = ["Run the command and summarize the result."],
) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-prune-"));
	cleanup.push(cwd);
	unregisterArtifactDirs.push(registerArtifactsDir(cwd));
	let nextId = 0;
	const paths = new Map<string, string>();
	const manager = asyncEnabled ? new AsyncJobManager({}) : undefined;
	if (manager) asyncManagers.push(manager);
	const sessionManager = userTurns === null ? undefined : SessionManager.create(cwd, cwd);
	for (const [index, text] of (userTurns ?? []).entries()) {
		sessionManager?.appendMessage({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now() + index,
		});
	}
	const configured = pruningSettings(mode, asyncEnabled);
	const session = {
		cwd,
		hasUI: false,
		skills: [],
		settings: configured,
		getSessionFile: () => null,
		getSessionId: () => "bash-pruning-test",
		getArtifactsDir: () => cwd,
		getClientBridge: () => undefined,
		asyncJobManager: manager,
		...(sessionManager === undefined ? {} : { sessionManager }),
		getAgentId: () => "Main",
		allocateOutputArtifact: async (prefix: string) => {
			const id = String(++nextId);
			const artifactPath = path.join(cwd, `${id}.${prefix}.txt`);
			paths.set(id, artifactPath);
			return { id, path: artifactPath };
		},
	} as unknown as ToolSession;
	return { tool: wrapToolWithMetaNotice(new BashTool(session)), paths, manager, sessionManager, settings: configured };
}

afterEach(async () => {
	await Promise.all(asyncManagers.splice(0).map(manager => manager.dispose()));
	for (const unregister of unregisterArtifactDirs.splice(0)) unregister();
	await Promise.all(cleanup.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("BashTool output pruning", () => {
	it("prunes completed output after native execution and keeps an exact recovery artifact", async () => {
		const { tool, paths } = await harness("deterministic");
		const command =
			"for i in $(seq 1 2500); do printf 'Compiling %s\\n' \"$i\"; if [ \"$i\" -eq 1250 ]; then printf 'warning: middle diagnostic\\n'; fi; done; printf '2499 pass, 1 fail\\n'";
		const result = await tool.execute("prune-call", { command });
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		const receipt = result.details?.reduction;
		expect(text).toContain("[… pruned");
		expect(text).toContain("warning: middle diagnostic");
		expect(text).toContain("2499 pass, 1 fail");
		expect(text.match(/\[pruned output:/gu)).toHaveLength(1);
		expect(text).toContain(`original: ${receipt?.recovery.locator}]`);
		expect(receipt?.baselineTokens).toBeGreaterThan(receipt?.visibleTokens ?? 0);
		expect(result.details?.wallTimeMs).toBeNumber();
		expect(result.details?.timeoutSeconds).toBe(300);

		const artifactId = receipt?.source.originalArtifactId;
		expect(artifactId).toBeString();
		const artifactPath = artifactId ? paths.get(artifactId) : undefined;
		expect(artifactPath).toBeString();
		const archived = await fs.readFile(artifactPath as string, "utf8");
		expect(contentHash(archived)).toBe(receipt?.source.contentHash ?? "");
		expect(archived).toContain("Compiling 1");
		expect(archived).toContain("Compiling 2500");
		expect(archived).toContain("warning: middle diagnostic");
		expect(archived).toContain("2499 pass, 1 fail");
		expect(archived).toContain("Wall time:");
		const recovered = await tool.execute("recover-call", { command: `cat artifact://${artifactId}` });
		const recoveredText = recovered.content.find(block => block.type === "text")?.text ?? "";
		expect(recovered.details?.reduction?.skipped?.reason).toBe("already-reduced");
		expect(recoveredText).toContain(archived);
		expect(recoveredText).not.toContain("[pruned output:");
	});

	it("keeps the raw-stream locator and pruning recovery footer exactly once above 50KB", async () => {
		const { tool } = await harness("deterministic");
		const command = `for i in $(seq 1 6000); do printf 'Compiling %s with enough routine progress detail to exceed the inline output budget\\n' "$i"; done; printf '[raw output: artifact:%s%s999]\\n' '/' '/'`;
		const result = await tool.execute("large-prune-call", { command });
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(text.match(/\[raw output: artifact:\/\//gu)).toHaveLength(1);
		expect(text.match(/\[pruned output:/gu)).toHaveLength(1);
		expect(result.details?.reduction?.source.originalArtifactId).toBeString();
		expect(result.details?.meta?.truncation?.artifactId).toBeString();
	});

	it("keeps mode-off and timeout results on their existing paths", async () => {
		const disabled = await harness("off");
		const ordinary = await disabled.tool.execute("off-call", { command: "printf original" });
		expect(ordinary.content.find(block => block.type === "text")?.text).toContain("original");
		expect(ordinary.details?.reduction).toBeUndefined();

		const deterministic = await harness("deterministic");
		const timeout = await deterministic.tool.execute("timeout-call", { command: "sleep 2", timeout: 1 });
		expect(timeout.isError).toBeTrue();
		expect(timeout.details?.timedOut).toBeTrue();
		expect(timeout.details?.reduction).toBeUndefined();
	});

	it("uses deterministic pruning but skips semantic judgment for non-zero exits", async () => {
		const { tool } = await harness("semantic");
		const command =
			'for i in $(seq 1 360); do echo "Compiling package-$i with routine metadata and progress details"; done; exit 2';
		const result = await tool.execute("failed-call", { command });
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(result.isError).toBeTrue();
		expect(result.details?.exitCode).toBe(2);
		expect(text).toContain("[… pruned");
		expect(text).toContain("Command exited with code 2");
		const semantic = result.details?.reduction?.stages.find(stage => stage.kind === "semantic");
		expect(semantic?.skipped).toEqual({ reason: "protected-format", detail: "non-zero exit" });
	});

	it("prunes explicit async completion on the managed job path", async () => {
		const { tool, manager } = await harness("deterministic", true);
		const command =
			'for i in $(seq 1 360); do echo "Compiling package-$i with routine metadata and progress details"; done';
		const started = await tool.execute("async-prune-call", { command, async: true });
		const jobId = started.details?.async?.jobId;
		expect(jobId).toBeString();
		await manager?.waitForAll();
		const job = jobId ? manager?.getJob(jobId) : undefined;
		expect(job?.status).toBe("completed");
		expect(job?.resultText).toContain("[… pruned");
		expect(job?.resultText).toContain("[pruned output:");
		expect(job?.latestDetails?.reduction).toBeDefined();
	});

	it("uses standing task requirements to keep every install line and excludes unrelated private turns from judgment", async () => {
		const requirement =
			"Keep every `Installing` line — I need the exact count of packages installed and their names.";
		const privateTurn = "My VPN password is hunter2, don't tell anyone.";
		const latest = "Run the install now.";
		const installCommand = "for i in $(seq 1 600); do printf 'Installing pkg-%s\\n' \"$i\"; done; printf 'done\\n'";

		for (const mode of ["deterministic", "semantic"] as const) {
			const required = await harness(mode, false, [requirement, privateTurn, latest]);
			const judge = new ScriptedJudge();
			const result = await required.tool.execute(`required-${mode}`, { command: installCommand });
			const text = result.content.find(block => block.type === "text")?.text ?? "";
			expect(text.match(/^Installing pkg-/gmu)).toHaveLength(600);
			expect(text).not.toContain("[… pruned");
			expect(result.details?.reduction?.skipped).toEqual({
				reason: "standing-requirement",
				detail: requirement,
			});

			const task = collectTaskContext(required.sessionManager?.getBranch() ?? [], {
				maxChars: resolveReductionPolicy(required.settings).taskContextChars,
			});
			await pruneBashOutput({
				baseline: text,
				command: installCommand,
				exitCode: 0,
				tokenizer: { countTokens: value => Math.ceil(value.length / 4) },
				settings: pruningSettings("semantic"),
				task,
				admission: admission(judge, pruningSettings("semantic")),
				archive: async () => "unused",
			});
			expect(judge.calls).toBe(0);
		}

		const original = "Install dependencies for this workspace.";
		const unguarded = await harness("off", false, [original, privateTurn, latest]);
		const neutralCommand =
			"for i in $(seq 1 600); do printf 'worker detail %s with ordinary runtime metadata\\n' \"$i\"; done; printf 'done\\n'";
		const raw = await unguarded.tool.execute("semantic-context-source", { command: neutralCommand });
		const baseline = raw.content.find(block => block.type === "text")?.text ?? "";
		const configured = pruningSettings("semantic");
		const judge = new ScriptedJudge();
		const task = collectTaskContext(unguarded.sessionManager?.getBranch() ?? [], {
			maxChars: resolveReductionPolicy(configured).taskContextChars,
		});
		await pruneBashOutput({
			baseline,
			command: neutralCommand,
			exitCode: 0,
			tokenizer: { countTokens: value => Math.ceil(value.length / 4) },
			settings: configured,
			task,
			admission: admission(judge, configured),
			archive: async () => "unused",
		});
		expect(judge.calls).toBe(1);
		const request = judge.requests[0];
		const state = request?.state as unknown as OutputState;
		expect(state.task).toEqual({
			original_request: original,
			latest_request: latest,
			latest_reply: "",
			standing_requirements: [],
		});
		expect(Object.keys(request?.questions ?? {})[0]).toBe("needs_every_line");
		expect(JSON.stringify(request)).not.toContain("hunter2");
	});

	it("keeps distinct recognized noise without task coverage but still performs content-free collapses", async () => {
		const unavailable = await harness("semantic", false, null);
		const compilingCommand =
			"for i in $(seq 1 600); do printf 'Compiling target-%s with distinct metadata\\n' \"$i\"; done; printf 'done\\n'";
		const compiling = await unavailable.tool.execute("context-unavailable", { command: compilingCommand });
		const compilingText = compiling.content.find(block => block.type === "text")?.text ?? "";
		expect(compilingText.match(/^Compiling target-/gmu)).toHaveLength(600);
		expect(compilingText).not.toContain("[… pruned");
		expect(compiling.details?.reduction?.skipped?.reason).toBe("context-unavailable");

		const repeatedCommand =
			"printf 'head one\\nhead two\\nhead three\\n'; for i in $(seq 1 600); do printf 'same repeated progress line with enough detail to save space\\n'; done; for i in $(seq 1 10); do printf 'tail %s\\n' \"$i\"; done";
		const repeated = await unavailable.tool.execute("content-free-collapse", { command: repeatedCommand });
		const repeatedText = repeated.content.find(block => block.type === "text")?.text ?? "";
		expect(repeatedText).toContain("×599");
		expect(repeatedText.split("same repeated progress line with enough detail to save space")).toHaveLength(2);
		expect(repeated.details?.reduction?.stages.find(stage => stage.kind === "semantic")?.skipped?.reason).toBe(
			"context-unavailable",
		);

		const judge = new ScriptedJudge();
		await pruneBashOutput({
			baseline: compilingText,
			command: compilingCommand,
			exitCode: 0,
			tokenizer: { countTokens: value => Math.ceil(value.length / 4) },
			settings: pruningSettings("semantic"),
			admission: admission(judge, pruningSettings("semantic")),
			archive: async () => "unused",
		});
		expect(judge.calls).toBe(0);
	});

	it("treats a count request as a standing requirement even when the value lines look routine", async () => {
		const request = "How many batches took longer than 30 ms? Report each one.";
		const command =
			'for i in $(seq 1 800); do ms=$((20 + (i % 25))); printf \'[INFO] worker processed batch %s (%s ms)\\n\' "$i" "$ms"; done';
		for (const mode of ["deterministic", "semantic"] as const) {
			const { tool } = await harness(mode, false, [request]);
			const result = await tool.execute(`count-retention-${mode}`, { command });
			const text = result.content.find(block => block.type === "text")?.text ?? "";
			expect(text.match(/^\[INFO\] worker processed batch/gmu)).toHaveLength(800);
			expect(text).not.toContain("[… pruned");
			expect(result.details?.reduction?.skipped).toEqual({
				reason: "standing-requirement",
				detail: "How many batches took longer than 30 ms?",
			});
		}
	});

	it("honours the compaction boundary: summarized-away requirements neither gate pruning nor reach the judge", async () => {
		const stale = "Keep every Installing line — I need the exact count. Project codename Zephyr.";
		const current = "Run the install now.";
		const installCommand = "for i in $(seq 1 600); do printf 'Installing pkg-%s\\n' \"$i\"; done; printf 'done\\n'";
		const { tool, sessionManager, settings } = await harness("deterministic", false, [stale]);
		if (!sessionManager) throw new Error("Expected a session manager");
		const currentId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: current }],
			timestamp: Date.now(),
		});
		sessionManager.appendCompaction("earlier work summarized", undefined, currentId, 1_000);

		// Through the real tool: the pre-boundary requirement no longer stops rule-based pruning.
		const result = await tool.execute("post-boundary", { command: installCommand });
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain("[… pruned");
		expect(result.details?.reduction?.skipped).toBeUndefined();

		// The same collection the tool performs never yields the pre-boundary turn.
		const branch = sessionManager.getBranch();
		const boundary = branch.find(entry => entry.type === "compaction");
		if (boundary?.type !== "compaction") throw new Error("Expected a compaction entry");
		const task = collectTaskContext(branch, {
			maxChars: resolveReductionPolicy(settings).taskContextChars,
			boundaryId: boundary.firstKeptEntryId,
		});
		expect(task).toMatchObject({
			originalRequest: current,
			latestRequest: current,
			requirements: [],
			coverage: "full",
		});
		expect(JSON.stringify(task)).not.toContain("Zephyr");
		// A boundary the branch does not contain fails closed.
		expect(collectTaskContext(branch, { maxChars: 2_000, boundaryId: "missing" }).coverage).toBe("none");
	});

	it("treats ordinary count wording as a standing requirement", async () => {
		const request = "Give me the total number of packages installed and their names.";
		const installCommand = "for i in $(seq 1 600); do printf 'Installing pkg-%s\\n' \"$i\"; done; printf 'done\\n'";
		for (const mode of ["deterministic", "semantic"] as const) {
			const { tool } = await harness(mode, false, [request]);
			const result = await tool.execute(`count-${mode}`, { command: installCommand });
			const text = result.content.find(block => block.type === "text")?.text ?? "";
			expect(text.match(/^Installing pkg-/gmu)).toHaveLength(600);
			expect(result.details?.reduction?.skipped).toEqual({ reason: "standing-requirement", detail: request });
		}
	});

	it("returns the successful command result when task-context collection throws", async () => {
		const { tool, sessionManager } = await harness("deterministic");
		if (!sessionManager) throw new Error("Expected a session manager");
		sessionManager.getBranch = () => {
			throw new Error("corrupt branch");
		};
		const result = await tool.execute("context-failure", {
			command: "for i in $(seq 1 400); do printf 'Compiling %s\\n' \"$i\"; done; printf 'ok\\n'",
		});
		expect(result.isError).toBeFalsy();
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(text.match(/^Compiling /gmu)).toHaveLength(400);
		expect(text).toContain("ok");
		expect(result.details?.reduction).toBeUndefined();
	});
});
