import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { BashResult } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { TempDir } from "@oh-my-pi/pi-utils";

function sessionFor(root: string, wallCapMs: number): ToolSession {
	return {
		cwd: root,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"bashInterceptor.enabled": false,
			"bash.autoBackground.enabled": false,
			"tools.wallCapMs": wallCapMs,
		}),
	};
}

function bashResult(overrides: Partial<BashResult> = {}): BashResult {
	return {
		output: "ok\n",
		exitCode: 0,
		cancelled: false,
		timedOut: false,
		truncated: false,
		totalBytes: 3,
		totalLines: 1,
		outputBytes: 3,
		outputLines: 1,
		...overrides,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

/**
 * Defends the bounded-run contract for bash: `timeout: 0` no longer means an
 * unbounded command — the effective deadline handed to the executor is
 * min(requested-or-unbounded, tools.wallCapMs). If it regresses, a `timeout: 0`
 * command can run forever; if the notice regresses, the model reads a wall-cap
 * kill as an ordinary per-call timeout and retries with `timeout: 0` again.
 */
describe("BashTool wall-clock cap", () => {
	afterEach(() => vi.restoreAllMocks());

	it("bounds timeout: 0 by the wall cap and reports it in details", async () => {
		await using temp = await TempDir.create("@bash-wall-cap-");
		const spy = vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(bashResult());

		const result = await new BashTool(sessionFor(temp.path(), 5_000)).execute("zero", {
			command: "sleep 999",
			timeout: 0,
		});

		expect(spy.mock.calls[0]?.[1]?.timeout).toBe(5_000);
		expect(result.details?.timeoutSeconds).toBe(5);
		expect(result.details?.requestedTimeoutSeconds).toBe(0);
		expect(result.details?.timeoutDisabled).toBeUndefined();
	});

	it("leaves an explicit timeout below the cap unchanged", async () => {
		await using temp = await TempDir.create("@bash-wall-cap-");
		const spy = vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(bashResult());

		const result = await new BashTool(sessionFor(temp.path(), 5_000)).execute("explicit", {
			command: "true",
			timeout: 2,
		});

		expect(spy.mock.calls[0]?.[1]?.timeout).toBe(2_000);
		expect(result.details?.timeoutSeconds).toBe(2);
		expect(result.details?.requestedTimeoutSeconds).toBeUndefined();
	});

	it("keeps timeout: 0 unbounded when the wall cap is disabled", async () => {
		await using temp = await TempDir.create("@bash-wall-cap-");
		const spy = vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(bashResult());

		const result = await new BashTool(sessionFor(temp.path(), 0)).execute("uncapped", {
			command: "sleep 999",
			timeout: 0,
		});

		expect(spy.mock.calls[0]?.[1]?.timeout).toBe(0);
		expect(result.details?.timeoutDisabled).toBe(true);
		expect(result.details?.timeoutSeconds).toBeUndefined();
	});

	it("names the wall cap in the timeout annotation only when the cap is what fired", async () => {
		await using temp = await TempDir.create("@bash-wall-cap-");
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(
			bashResult({ output: "partial\n", exitCode: undefined, timedOut: true }),
		);
		const tool = new BashTool(sessionFor(temp.path(), 5_000));

		const capped = await tool.execute("capped-timeout", { command: "sleep 999", timeout: 0 });
		expect(capped.isError).toBe(true);
		expect(capped.details?.timedOut).toBe(true);
		const cappedText = textOf(capped);
		expect(cappedText).toContain("partial");
		expect(cappedText).toContain("Command timed out after 5 seconds");
		expect(cappedText).toContain("tools.wallCapMs=5000");

		const explicit = await tool.execute("explicit-timeout", { command: "sleep 999", timeout: 2 });
		expect(explicit.details?.timedOut).toBe(true);
		const explicitText = textOf(explicit);
		expect(explicitText).toContain("Command timed out after 2 seconds");
		expect(explicitText).not.toContain("tools.wallCapMs");
	});
});
