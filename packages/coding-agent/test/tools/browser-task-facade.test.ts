import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";

/** Host stand-in: records the payload and answers with a fixed task result. */
function recorder(session: ToolSession, calls: unknown[]): EvalPreludeDefinition {
	const shipped = createBrowserPrelude(session);
	return {
		...shipped,
		invoke: parameters => {
			calls.push(parameters);
			const action = parameters !== null && typeof parameters === "object" ? Reflect.get(parameters, "action") : "";
			if (action === "task") {
				return Promise.resolve({
					content: [{ type: "text" as const, text: "task done" }],
					details: { value: { status: "done", steps: [], budget: { actions: 2 } } },
				});
			}
			return Promise.resolve({ content: [], details: { name: "facade" } });
		},
	};
}

function makeSession(getPreludes: () => readonly EvalPreludeDefinition[]): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalPreludes: getPreludes,
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.relay": false,
			"browser.cmux": false,
		}),
	};
}

afterAll(async () => {
	await Promise.all([disposeAllVmContexts(), disposeAllKernelSessions()]);
});

describe("tab.task facade", () => {
	it("sends the task payload and returns the host result in JavaScript", async () => {
		const calls: unknown[] = [];
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session = makeSession(() => definitions);
		definitions = [recorder(session, calls)];
		const result = await executeJs(
			[
				'const tab = await browser.open({ name: "facade" });',
				'const outcome = await tab.task({ goal: "book a room", values: { City: "Lisbon" }, expect: { urlIncludes: "/done" }, allowConsequential: true });',
				"print(outcome.status);",
				'try { await tab.task({ goal: "  " }); } catch (error) { print(error.message); }',
			].join("\n"),
			{ cwd: process.cwd(), sessionId: `browser-task-js-${crypto.randomUUID()}`, session },
		);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n")).toEqual([
			"task done",
			"done",
			"tab.task() requires a non-empty goal string",
		]);
		expect(calls).toContainEqual({
			action: "task",
			name: "facade",
			goal: "book a room",
			values: { City: "Lisbon" },
			expect: { urlIncludes: "/done" },
			allowConsequential: true,
		});
	});

	it("sends the task payload with keyword options in Python", async () => {
		const calls: unknown[] = [];
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session = makeSession(() => definitions);
		definitions = [recorder(session, calls)];
		const result = await executePython(
			[
				'tab = await browser.open(name="facade")',
				'outcome = await tab.task("book a room", values={"City": "Lisbon"}, maxActions=4, timeout=30)',
				'print(outcome["status"])',
				"try:",
				'    await tab.task("")',
				"except TypeError as error:",
				"    print(error)",
			].join("\n"),
			{
				cwd: process.cwd(),
				sessionId: `browser-task-py-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n")).toEqual([
			"task done",
			"done",
			"tab.task() requires a non-empty goal string",
		]);
		expect(calls).toContainEqual({
			action: "task",
			name: "facade",
			goal: "book a room",
			values: { City: "Lisbon" },
			maxActions: 4,
			timeout: 30,
		});
	});
});
