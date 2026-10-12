import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { HerdrCli } from "../../src/task/pane/herdr-cli";
import {
	PANE_RESULT_SENTINEL,
	type PaneSubagentOptions,
	parsePaneResultFile,
	runPaneSubagent,
} from "../../src/task/pane/herdr-backend";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { createFakeHerdr, envelope, errorEnvelope, type FakeHerdr, type FakeHerdrResponse } from "./pane-fake-herdr";

const AGENT_ID = "ReviewScout";
const RESULT_BODY = "# Findings\n\nThe pane child wrote this file.";
/** A result file that follows the delivery protocol: header, body, sentinel. */
const RESULT_FILE = `resolved-model: mock/mock-1\n\n${RESULT_BODY}\n${PANE_RESULT_SENTINEL}\n`;
/**
 * Every backend test drives a real fake `herdr` executable (a `sh` shim that
 * execs a bun script per control-plane call), so its wall time is bound to
 * process spawn latency. Under full-suite load that can exceed bun's 5 s
 * default; the tests themselves never wait on the clock.
 */
const SPAWN_TEST_TIMEOUT_MS = 30_000;

let fake: FakeHerdr | undefined;
let artifactsDir: string | undefined;

afterEach(() => {
	fake?.cleanup();
	fake = undefined;
	if (artifactsDir) fs.rmSync(artifactsDir, { recursive: true, force: true });
	artifactsDir = undefined;
});

function outputPath(): string {
	artifactsDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "omp-pane-artifacts-"));
	return path.join(artifactsDir, `${AGENT_ID}.md`);
}

/** Scenario for a session-targeted run that succeeds end to end. */
function happyScenario(overrides: Record<string, FakeHerdrResponse> = {}): Record<string, FakeHerdrResponse> {
	return {
		"workspace create": {
			stdout: envelope({
				workspace: { workspace_id: "w1" },
				tab: { tab_id: "w1:t1" },
				root_pane: { pane_id: "w1:p1", workspace_id: "w1" },
			}),
		},
		"pane split": { stdout: envelope({ pane: { pane_id: "w1:p2", workspace_id: "w1" } }) },
		"pane layout": {
			stdout: envelope({
				layout: { focused_pane_id: "w1:p1", panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 50 } }] },
			}),
		},
		"pane close": { stdout: envelope({ type: "ok" }) },
		"workspace close": { stdout: envelope({ type: "ok" }) },
		"agent list": { stdout: envelope({ agents: [] }) },
		"agent start": { stdout: envelope({ type: "agent_started" }) },
		"agent prompt": {
			stdout: envelope({ state: "idle" }),
			writeFile: { path: outputPath(), content: RESULT_FILE },
		},
		"agent read": { stdout: envelope({ text: "pane transcript tail" }) },
		"agent send-keys": { stdout: envelope({ type: "ok" }) },
		"agent wait": { stdout: envelope({ state: "idle" }) },
		...overrides,
	};
}

function paneOptions(
	herdr: FakeHerdr,
	overrides: Partial<PaneSubagentOptions> = {},
	progress?: AgentProgress[],
): PaneSubagentOptions {
	const dir = path.dirname(outputPath());
	return {
		cli: new HerdrCli({ bin: herdr.bin, cwd: dir, session: "omp-next-test" }),
		target: { kind: "session", session: "omp-next-test" },
		socketPath: "/tmp/omp-next-test/herdr.sock",
		id: AGENT_ID,
		index: 0,
		agentName: "scout",
		agentSource: "bundled",
		systemPrompt: "You are a read-only scout.",
		task: "<task>review</task>",
		assignment: "Review the diff",
		cwd: dir,
		artifactsDir: dir,
		modelPatterns: ["mock/mock-1"],
		modelRole: "smol",
		readyTimeoutMs: 30_000,
		promptTimeoutMs: 600_000,
		keepPane: false,
		...(progress ? { onProgress: p => progress.push(p) } : {}),
		...overrides,
	};
}

describe("pane result file protocol", () => {
	test("separates the model header and the sentinel from the body", () => {
		expect(parsePaneResultFile(RESULT_FILE)).toEqual({
			body: RESULT_BODY,
			resolvedModel: "mock/mock-1",
			complete: true,
		});
		expect(parsePaneResultFile(`${RESULT_BODY}\n${PANE_RESULT_SENTINEL}`)).toEqual({
			body: RESULT_BODY,
			resolvedModel: undefined,
			complete: true,
		});
		expect(parsePaneResultFile("resolved-model: a/b\n\npartial")).toEqual({
			body: "partial",
			resolvedModel: "a/b",
			complete: false,
		});
		// The sentinel only counts as the last line.
		expect(parsePaneResultFile(`${PANE_RESULT_SENTINEL}\nmore`).complete).toBe(false);
	});
});

describe("herdr pane backend", () => {
	test(
		"creates a workspace, starts the agent, prompts it, and returns the artifact",
		async () => {
			fake = createFakeHerdr(happyScenario());
			const progress: AgentProgress[] = [];
			const outcome = await runPaneSubagent(paneOptions(fake, {}, progress));

			expect(fake.keys()).toEqual([
				"workspace create",
				"agent list",
				"agent start",
				"agent prompt",
				"workspace close",
			]);

			const calls = fake.calls();
			expect(calls[0]).toEqual([
				"--session",
				"omp-next-test",
				"workspace",
				"create",
				"--cwd",
				path.dirname(outputPath()),
				"--label",
				`omp-task-${AGENT_ID}`,
				"--no-focus",
			]);
			const start = calls[2] ?? [];
			expect(start.slice(2)).toEqual([
				"agent",
				"start",
				"reviewscout",
				"--kind",
				"omp",
				"--pane",
				"w1:p1",
				"--timeout",
				"30000",
				"--",
				"--model",
				"mock/mock-1",
			]);
			const promptCall = fake.calls()[3] ?? [];
			expect(promptCall.slice(2, 5)).toEqual(["agent", "prompt", "reviewscout"]);
			expect(promptCall.slice(6)).toEqual(["--wait", "--timeout", "600000"]);
			// The prompt carries the role, the assignment, the exact artifact path,
			// and the delivery protocol the parent enforces.
			expect(promptCall[5]).toContain("You are a read-only scout.");
			expect(promptCall[5]).toContain("Review the diff");
			expect(promptCall[5]).toContain(outputPath());
			expect(promptCall[5]).toContain("resolved-model:");
			expect(promptCall[5]).toContain(PANE_RESULT_SENTINEL);

			expect(outcome.resultSource).toBe("artifact-file");
			expect(outcome.result.resultSource).toBe("artifact-file");
			expect(outcome.lifecycle).toBe("ready-for-review");
			expect(outcome.identity).toEqual({
				session: "omp-next-test",
				socketPath: "/tmp/omp-next-test/herdr.sock",
				workspaceId: "w1",
				paneId: "w1:p1",
				agentName: "reviewscout",
				ownsWorkspace: true,
			});
			expect(outcome.result.exitCode).toBe(0);
			expect(outcome.result.error).toBeUndefined();
			expect(outcome.result.output).toBe(RESULT_BODY);
			expect(outcome.result.outputPath).toBe(outputPath());
			expect(outcome.result.resolvedModel).toBe("mock/mock-1");
			expect(outcome.result.resolvedModelVerified).toBe(true);
			expect(fs.readFileSync(outputPath(), "utf8")).toBe(RESULT_FILE);
			expect(outcome.result.stderr).toContain("worker identity: session=omp-next-test");
			expect(outcome.result.stderr).toContain("not proof");

			const intents = progress.map(p => p.lastIntent);
			expect(intents).toContain("pane w1:p1 · working");
			expect(intents.at(-1)).toBe("pane w1:p1 · ready-for-review");
			expect(progress.at(-1)?.status).toBe("completed");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"a sealed result without the model header fails instead of being attributed to the requested selector",
		async () => {
			fake = createFakeHerdr(
				happyScenario({
					"agent prompt": {
						stdout: envelope({ state: "idle" }),
						writeFile: { path: outputPath(), content: `${RESULT_BODY}\n${PANE_RESULT_SENTINEL}\n` },
					},
				}),
			);
			const outcome = await runPaneSubagent(paneOptions(fake));
			expect(outcome.result.exitCode).toBe(1);
			expect(outcome.result.error).toContain("resolved-model:");
			expect(outcome.result.output).toBe("");
			expect(outcome.result.outputPath).toBeUndefined();
			expect(outcome.result.resolvedModel).toBeUndefined();
			expect(outcome.result.resolvedModelVerified).toBe(false);
			expect(outcome.resultSource).toBe("none");
			expect(outcome.lifecycle).toBe("needs-attention");
			expect(outcome.result.stderr).toContain(RESULT_BODY);
			expect(fake.keys()).toContain("workspace close");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"forwards the whole model fallback chain, the thinking level, and the tool allowlist",
		async () => {
			fake = createFakeHerdr(happyScenario());
			await runPaneSubagent(
				paneOptions(fake, {
					modelPatterns: ["provider/primary", "provider/fallback"],
					thinkingLevel: ThinkingLevel.Max,
					toolNames: ["eval", "bash"],
				}),
			);
			const start = fake.calls()[2] ?? [];
			expect(start.slice(start.indexOf("--") + 1)).toEqual([
				"--models",
				"provider/primary,provider/fallback",
				"--thinking",
				"max",
				"--tools",
				"eval,bash",
			]);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"an explicit empty tool allowlist launches the child with --no-tools instead of its defaults",
		async () => {
			fake = createFakeHerdr(happyScenario());
			await runPaneSubagent(paneOptions(fake, { toolNames: [] }));
			const start = fake.calls()[2] ?? [];
			expect(start.slice(start.indexOf("--") + 1)).toEqual(["--model", "mock/mock-1", "--no-tools"]);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"hands the child its remaining recursion budget as a settings overlay",
		async () => {
			fake = createFakeHerdr(happyScenario());
			await runPaneSubagent(paneOptions(fake, { childMaxRecursionDepth: 1, env: { PI_CONFIG_FILES: "/base.yml" } }));
			const overlay = path.join(path.dirname(outputPath()), `${AGENT_ID}.pane-config.yml`);
			expect(fake.calls()[0]?.slice(-3)).toEqual([
				"--env",
				`PI_CONFIG_FILES=/base.yml${path.delimiter}${overlay}`,
				"--no-focus",
			]);
			expect(fs.readFileSync(overlay, "utf8")).toBe("task:\n  maxRecursionDepth: 1\n");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"inside a pane it splits a sibling and closes only that pane",
		async () => {
			fake = createFakeHerdr(happyScenario());
			const outcome = await runPaneSubagent(
				paneOptions(fake, {
					cli: new HerdrCli({ bin: fake.bin, cwd: path.dirname(outputPath()) }),
					target: { kind: "current" },
					env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
				}),
			);

			expect(fake.keys()).toEqual([
				"pane layout",
				"pane split",
				"agent list",
				"agent start",
				"agent prompt",
				"pane close",
			]);
			const split = fake.calls()[1] ?? [];
			expect(split).toEqual([
				"pane",
				"split",
				"--current",
				"--direction",
				"right",
				"--cwd",
				path.dirname(outputPath()),
				"--no-focus",
			]);
			expect(fake.calls().at(-1)).toEqual(["pane", "close", "w1:p2"]);
			expect(outcome.identity.ownsWorkspace).toBe(false);
			expect(outcome.result.exitCode).toBe(0);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"a tall caller pane splits down",
		async () => {
			fake = createFakeHerdr(
				happyScenario({
					"pane layout": {
						stdout: envelope({
							layout: { panes: [{ pane_id: "w1:p1", rect: { width: 80, height: 60 } }] },
						}),
					},
				}),
			);
			await runPaneSubagent(
				paneOptions(fake, {
					cli: new HerdrCli({ bin: fake.bin, cwd: path.dirname(outputPath()) }),
					target: { kind: "current" },
					env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
				}),
			);
			expect(fake.calls()[1]?.slice(2, 5)).toEqual(["--current", "--direction", "down"]);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"injects pane environment and a unique agent name",
		async () => {
			fake = createFakeHerdr(
				happyScenario({ "agent list": { stdout: envelope({ agents: [{ name: "reviewscout" }] }) } }),
			);
			await runPaneSubagent(paneOptions(fake, { paneEnv: { PATH: "/shim:/usr/bin" } }));
			expect(fake.calls()[0]?.slice(-3)).toEqual(["--env", "PATH=/shim:/usr/bin", "--no-focus"]);
			expect(fake.calls()[2]?.[4]).toBe("reviewscout-2");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"a blocked child keeps its pane and reports where to answer",
		async () => {
			fake = createFakeHerdr(
				happyScenario({
					"agent prompt": { stdout: errorEnvelope("agent_blocked", "agent is waiting at a dialog"), code: 1 },
				}),
			);
			const outcome = await runPaneSubagent(paneOptions(fake));

			expect(fake.keys()).toEqual(["workspace create", "agent list", "agent start", "agent prompt", "agent read"]);
			expect(outcome.lifecycle).toBe("blocked-needs-user");
			expect(outcome.resultSource).toBe("pane-read");
			expect(outcome.result.exitCode).toBe(1);
			expect(outcome.result.error).toContain("blocked");
			expect(outcome.result.error).toContain("w1:p1");
			expect(outcome.result.output).toBe("pane transcript tail");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"a settled blocked state is reported without closing the pane",
		async () => {
			fake = createFakeHerdr(happyScenario({ "agent prompt": { stdout: envelope({ state: "blocked" }) } }));
			const outcome = await runPaneSubagent(paneOptions(fake));
			expect(fake.keys()).not.toContain("workspace close");
			expect(outcome.lifecycle).toBe("blocked-needs-user");
			expect(outcome.result.error).toContain("answer it there");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"a child that never becomes ready fails with its pane retained",
		async () => {
			fake = createFakeHerdr(
				happyScenario({
					"agent start": { stdout: errorEnvelope("agent_not_ready", "omp did not reach its prompt"), code: 1 },
				}),
			);
			const outcome = await runPaneSubagent(paneOptions(fake));

			expect(fake.keys()).toEqual(["workspace create", "agent list", "agent start", "agent read"]);
			expect(outcome.result.exitCode).toBe(1);
			expect(outcome.result.error).toContain("agent_not_ready");
			expect(outcome.result.stderr).toContain("retained");
			expect(outcome.lifecycle).toBe("failed");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"a stalled prompt fails with its pane retained",
		async () => {
			fake = createFakeHerdr(
				happyScenario({
					"agent prompt": { stdout: errorEnvelope("agent_prompt_stalled", "no lifecycle change"), code: 1 },
				}),
			);
			const outcome = await runPaneSubagent(paneOptions(fake));
			expect(fake.keys()).not.toContain("workspace close");
			expect(outcome.result.error).toContain("agent_prompt_stalled");
			expect(outcome.lifecycle).toBe("failed");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"cancellation interrupts the child and releases the owned workspace",
		async () => {
			// The fake holds the prompt call open until the run is torn down; the
			// abort lands once the call has been entered.
			fake = createFakeHerdr(
				happyScenario({ "agent prompt": { sleepMs: 30_000, stdout: envelope({ state: "idle" }) } }),
			);
			const controller = new AbortController();
			const run = runPaneSubagent(paneOptions(fake, { signal: controller.signal }));
			await fake.waitForCall("agent prompt");
			controller.abort();
			const outcome = await run;

			expect(fake.keys()).toEqual([
				"workspace create",
				"agent list",
				"agent start",
				"agent prompt",
				"agent send-keys",
				"agent wait",
				"workspace close",
			]);
			expect(fake.calls()[4]?.slice(2)).toEqual(["agent", "send-keys", "reviewscout", "ctrl+c"]);
			expect(outcome.result.aborted).toBe(true);
			expect(outcome.result.exitCode).toBe(1);
			expect(outcome.lifecycle).toBe("cancelling");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"an abort while the result is settling is honoured, never scraped into a success",
		async () => {
			// The child reports idle at once but never writes the file; the abort
			// lands inside the artifact settle window.
			fake = createFakeHerdr(
				happyScenario({
					"agent prompt": { stdout: envelope({ state: "idle" }) },
					"agent read": { stdout: envelope({ text: "still investigating" }) },
				}),
			);
			const controller = new AbortController();
			const run = runPaneSubagent(
				paneOptions(fake, {
					signal: controller.signal,
					// `idle` is published right before the artifact settle window opens.
					onProgress: progress => {
						if (progress.lastIntent?.endsWith("· idle")) controller.abort();
					},
				}),
			);
			const outcome = await run;

			expect(fake.keys()).toEqual([
				"workspace create",
				"agent list",
				"agent start",
				"agent prompt",
				"agent send-keys",
				"agent wait",
				"workspace close",
			]);
			expect(outcome.result.aborted).toBe(true);
			expect(outcome.result.exitCode).toBe(1);
			expect(outcome.result.output).toBe("");
			expect(outcome.resultSource).toBe("none");
			expect(outcome.lifecycle).toBe("cancelling");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test("an abort while the pane is being created issues no herdr call and starts no agent", async () => {
		// `creating-pane` is published synchronously before the first control-plane
		// call; an abort landing there must stop the run before any herdr process
		// is spawned, and nothing may run after the outcome settles.
		fake = createFakeHerdr(happyScenario());
		const controller = new AbortController();
		const outcome = await runPaneSubagent(
			paneOptions(fake, {
				signal: controller.signal,
				onProgress: progress => {
					if (progress.lastIntent === "pane · creating-pane") controller.abort();
				},
			}),
		);

		expect(fake.keys()).toEqual([]);
		expect(outcome.result.aborted).toBe(true);
		expect(outcome.result.exitCode).toBe(1);
		expect(outcome.result.error).toContain("cancelled while its pane was being created");
		expect(outcome.lifecycle).toBe("cancelling");
		expect(outcome.identity.paneId).toBeUndefined();
	});

	test(
		"keepPane leaves the pane open after a successful run",
		async () => {
			fake = createFakeHerdr(happyScenario());
			const outcome = await runPaneSubagent(paneOptions(fake, { keepPane: true }));
			expect(fake.keys()).not.toContain("workspace close");
			expect(outcome.result.exitCode).toBe(0);
			expect(outcome.result.stderr).toContain("keepPane");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"a child that goes idle without a result file fails; the transcript is evidence, not output",
		async () => {
			fake = createFakeHerdr(
				happyScenario({
					"agent prompt": { stdout: envelope({ state: "idle" }) },
					"agent read": { stdout: envelope({ text: "still investigating" }) },
				}),
			);
			const progress: AgentProgress[] = [];
			const outcome = await runPaneSubagent(paneOptions(fake, {}, progress));
			expect(outcome.result.exitCode).toBe(1);
			expect(outcome.result.error).toBe("child went idle without delivering a result file");
			expect(outcome.resultSource).toBe("pane-read");
			expect(outcome.result.resultSource).toBe("pane-read");
			expect(outcome.lifecycle).toBe("needs-attention");
			expect(progress.at(-1)?.status).toBe("failed");
			expect(outcome.result.output).toBe("");
			expect(outcome.result.outputPath).toBeUndefined();
			expect(outcome.result.stderr).toContain("still investigating");
			// Nothing is fabricated at the artifact path.
			expect(fs.existsSync(outputPath())).toBe(false);
			expect(fake.keys()).toContain("workspace close");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"a result file left over from an earlier run with the same id is never returned",
		async () => {
			fake = createFakeHerdr(
				happyScenario({
					"agent prompt": { stdout: envelope({ state: "idle" }) },
					"agent read": { stdout: envelope({ text: "" }) },
				}),
			);
			fs.writeFileSync(outputPath(), `resolved-model: old/model\n\nold child\n${PANE_RESULT_SENTINEL}\n`);
			const outcome = await runPaneSubagent(paneOptions(fake));
			expect(outcome.result.exitCode).toBe(1);
			expect(outcome.result.output).not.toContain("old child");
			expect(outcome.result.resolvedModel).toBeUndefined();
			expect(outcome.resultSource).toBe("none");
			expect(fs.existsSync(outputPath())).toBe(false);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	test(
		"a result file without the closing sentinel is partial and fails",
		async () => {
			fake = createFakeHerdr(
				happyScenario({
					"agent prompt": {
						stdout: envelope({ state: "idle" }),
						writeFile: { path: outputPath(), content: "resolved-model: mock/mock-1\n\n# Half written" },
					},
				}),
			);
			const outcome = await runPaneSubagent(paneOptions(fake));
			expect(outcome.result.exitCode).toBe(1);
			expect(outcome.result.error).toContain(PANE_RESULT_SENTINEL);
			expect(outcome.resultSource).toBe("none");
			expect(outcome.result.resultSource).toBe("none");
			expect(outcome.lifecycle).toBe("needs-attention");
			expect(outcome.result.output).toBe("");
			expect(outcome.result.outputPath).toBeUndefined();
			expect(outcome.result.stderr).toContain("# Half written");
			expect(fake.keys()).toContain("workspace close");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
});
