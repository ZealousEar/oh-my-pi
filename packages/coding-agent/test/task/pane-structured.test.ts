import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import * as discoveryModule from "../../src/task/discovery";
import { PANE_RESULT_SENTINEL } from "../../src/task/pane/herdr-backend";
import { HERDR_OMP_EXTENSION_RELPATH } from "../../src/task/pane/preflight";
import { runStructuredSubagent, type StructuredSubagentRequest } from "../../src/task/structured-subagent";
import type { AgentDefinition } from "../../src/task/types";
import type { Rule } from "../../src/capability/rule";
import type { ToolSession } from "../../src/tools";
import { createFakeHerdr, envelope, type FakeHerdr, type FakeHerdrResponse, runningStatus } from "./pane-fake-herdr";

/**
 * The structured runner reaches the pane backend through preflight, so the
 * fake `herdr` is placed on PATH and reports the integration for this
 * process's own agent dir — exactly what the child will run with.
 */
const AGENT: AgentDefinition = {
	name: "worker",
	description: "Pane worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["exec"],
	spawns: "*",
};

const ID = "PaneWorker";
/** Each run spawns several fake `herdr` processes; under full-suite load that can exceed bun's 5 s default. */
const SPAWN_TEST_TIMEOUT_MS = 30_000;

let fake: FakeHerdr | undefined;
let root: string | undefined;
const originalPath = process.env.PATH;

afterEach(() => {
	vi.restoreAllMocks();
	process.env.PATH = originalPath;
	fake?.cleanup();
	fake = undefined;
	if (root) fs.rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function artifactsDir(): string {
	root ??= fs.mkdtempSync(path.join(os.tmpdir(), "omp-pane-structured-"));
	return path.join(root, "session");
}

function scenario(overrides: Record<string, FakeHerdrResponse> = {}): Record<string, FakeHerdrResponse> {
	const extension = path.join(getAgentDir(), HERDR_OMP_EXTENSION_RELPATH);
	return {
		status: { stdout: runningStatus("/tmp/omp-next-test/herdr.sock") },
		"integration status": { stdout: `omp: current (v8) (${extension})\n` },
		"workspace create": {
			stdout: envelope({
				workspace: { workspace_id: "w1" },
				tab: { tab_id: "w1:t1" },
				root_pane: { pane_id: "w1:p1", workspace_id: "w1" },
			}),
		},
		"workspace close": { stdout: envelope({ type: "ok" }) },
		"agent list": { stdout: envelope({ agents: [] }) },
		"agent start": { stdout: envelope({ type: "agent_started" }) },
		"agent prompt": {
			stdout: envelope({ state: "idle" }),
			writeFile: {
				path: path.join(artifactsDir(), `${ID}.md`),
				content: `resolved-model: provider/fallback\n\n# Done\n${PANE_RESULT_SENTINEL}\n`,
			},
		},
		"agent read": { stdout: envelope({ text: "still investigating" }) },
		...overrides,
	};
}

function install(herdr: FakeHerdr): void {
	process.env.PATH = `${herdr.dir}${path.delimiter}${originalPath ?? ""}`;
}

function session(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: path.dirname(artifactsDir()),
		hasUI: false,
		settings: Settings.isolated({
			"task.paneBackend": "herdr",
			"task.herdr.session": "omp-next-test",
			"task.maxRecursionDepth": 2,
			"task.isolation.enabled": false,
			"task.enableLsp": true,
		}),
		getSessionFile: () => `${artifactsDir()}.jsonl`,
		getSessionSpawns: () => "*",
		getPlanModeState: () => undefined,
		...overrides,
	} as unknown as ToolSession;
}

function rule(name: string, content: string, extra: Partial<Rule> = {}): Rule {
	return {
		name,
		path: `/rules/${name}.md`,
		content,
		alwaysApply: true,
		_source: { provider: "project", providerName: "project", path: `/rules/${name}.md`, level: "project" },
		...extra,
	};
}

function request(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
	return {
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		identity: { id: ID },
		...overrides,
	};
}

describe("structured subagent on the pane backend", () => {
	it(
		"launches the child with the native model chain, effort, tool allowlist, and spawn budget",
		async () => {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
			fake = createFakeHerdr(scenario());
			install(fake);

			const settled = await runStructuredSubagent(
				request({ model: ["provider/primary", "provider/fallback"], effort: "hi" }),
			);

			const calls = fake.calls();
			const start = calls.find(argv => argv.includes("start")) ?? [];
			expect(start.slice(start.indexOf("--") + 1)).toEqual([
				"--models",
				"provider/primary,provider/fallback",
				"--thinking",
				"max",
				"--tools",
				"task,eval,bash",
			]);
			// Same recursion budget the native child would have at depth 1 of 2.
			const create = calls.find(argv => argv.includes("create")) ?? [];
			const env = create.filter((_, index) => create[index - 1] === "--env");
			expect(env).toContain(`PI_CODING_AGENT_DIR=${getAgentDir()}`);
			const overlay = path.join(artifactsDir(), `${ID}.pane-config.yml`);
			const configFiles = env.find(entry => entry.startsWith("PI_CONFIG_FILES="))?.slice("PI_CONFIG_FILES=".length);
			expect(configFiles?.split(path.delimiter).at(-1)).toBe(overlay);
			expect(fs.readFileSync(overlay, "utf8")).toBe("task:\n  maxRecursionDepth: 1\n");

			expect(settled.result.exitCode).toBe(0);
			expect(settled.result.output).toBe("# Done");
			expect(settled.result.resultSource).toBe("artifact-file");
			expect(settled.result.resolvedModel).toBe("provider/fallback");
			expect(settled.result.resolvedModelVerified).toBe(true);
			expect(settled.result.modelOverride).toEqual(["provider/primary", "provider/fallback"]);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"fails a strict request loudly instead of downgrading to the native backend",
		async () => {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
			fake = createFakeHerdr(
				scenario({ status: { stdout: "client:\n  version: 0.8.2\n\nserver:\n  status: not running\n" } }),
			);
			install(fake);

			await expect(runStructuredSubagent(request())).rejects.toMatchObject({
				kind: "preflight",
				message: expect.stringContaining('session "omp-next-test" has no running HerdR server'),
			});
			// Preflight stopped before any pane was created.
			expect(fake.keys()).toEqual(["status"]);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"reports an idle child without a result file as a failure at the task boundary",
		async () => {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
			fake = createFakeHerdr(scenario({ "agent prompt": { stdout: envelope({ state: "idle" }) } }));
			install(fake);

			const settled = await runStructuredSubagent(request());

			expect(settled.result.exitCode).toBe(1);
			expect(settled.result.error).toBe("child went idle without delivering a result file");
			expect(settled.result.resultSource).toBe("pane-read");
			expect(settled.result.output).toBe("");
			expect(settled.result.outputPath).toBeUndefined();
			expect(settled.result.stderr).toContain("still investigating");
			expect(settled.result.resolvedModelVerified).toBe(false);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"delivers only the parent's agent-scoped always-apply rules in the pane prompt",
		async () => {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
			fake = createFakeHerdr(scenario());
			install(fake);

			const settled = await runStructuredSubagent(
				request({
					session: session({
						rules: [
							rule("every-agent", "ALWAYS-RULE: never delete fixtures."),
							rule("worker-only", "WORKER-RULE: report line counts.", { agents: ["worker"] }),
							rule("other-agent", "REVIEWER-RULE: only comment.", { agents: ["reviewer"] }),
							rule("on-request", "REQUESTED-RULE: not always.", {
								alwaysApply: false,
								description: "Only when asked",
							}),
						],
					}),
				}),
			);
			expect(settled.result.exitCode).toBe(0);

			const promptCall = fake.calls().find(argv => argv.includes("prompt")) ?? [];
			const text = promptCall[promptCall.indexOf("prompt") + 2] ?? "";
			// The child rediscovers unscoped rules from disk itself, so only rules the
			// parent bucketed for this agent by `agents` scope are delivered; rules for
			// other agents and rulebook rules stay out.
			expect(text).toContain("WORKER-RULE: report line counts.");
			expect(text).not.toContain("ALWAYS-RULE");
			expect(text).not.toContain("REVIEWER-RULE");
			expect(text).not.toContain("REQUESTED-RULE");
			expect(text.indexOf("# Rules")).toBeLessThan(text.indexOf("# Assignment"));
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"omits the rules section when no parent rule is scoped to this agent",
		async () => {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
			fake = createFakeHerdr(scenario());
			install(fake);

			await runStructuredSubagent(
				request({
					session: session({
						rules: [
							rule("every-agent", "ALWAYS-RULE: never delete fixtures."),
							rule("other-agent", "REVIEWER-RULE: only comment.", { agents: ["reviewer"] }),
						],
					}),
				}),
			);

			const promptCall = fake.calls().find(argv => argv.includes("prompt")) ?? [];
			const text = promptCall[promptCall.indexOf("prompt") + 2] ?? "";
			expect(text).not.toContain("# Rules");
			expect(text).toContain("# Assignment");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
});
