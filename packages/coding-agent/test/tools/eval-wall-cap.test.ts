import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import type { ExecutorBackendExecOptions, ExecutorBackendResult } from "@oh-my-pi/pi-coding-agent/eval/backend";
import { EVAL_TIMEOUT_PAUSE_OP } from "@oh-my-pi/pi-coding-agent/eval/bridge-timeout";
import { WallCapTimeoutError } from "@oh-my-pi/pi-coding-agent/eval/wall-cap";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";

function makeSession(wallCapMs: number): ToolSession {
	return {
		cwd: "/tmp/eval-wall-cap-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "tools.wallCapMs": wallCapMs, "eval.autoBackground.enabled": false }),
	};
}

/**
 * Mock a JS cell that immediately parks on a bridge wait (pausing the idle
 * watchdog) and only returns once its signal aborts — or `release()` is called.
 * Returns the captured execute options so the test can watch the signal.
 */
function mockParkedCell(): {
	started: Promise<ExecutorBackendExecOptions>;
	release: () => void;
} {
	const started = Promise.withResolvers<ExecutorBackendExecOptions>();
	const released = Promise.withResolvers<void>();
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation(
		async (_code, options): Promise<ExecutorBackendResult> => {
			options.onChunk("partial output\n");
			options.onStatus?.({ op: EVAL_TIMEOUT_PAUSE_OP });
			started.resolve(options);
			const aborted = Promise.withResolvers<void>();
			options.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
			await Promise.race([aborted.promise, released.promise]);
			const cancelled = options.signal?.aborted === true;
			return {
				output: "partial output\n",
				exitCode: cancelled ? undefined : 0,
				cancelled,
				truncated: false,
				artifactId: undefined,
				totalLines: 1,
				totalBytes: 15,
				outputLines: 1,
				outputBytes: 15,
				displayOutputs: [],
			};
		},
	);
	return { started: started.promise, release: released.resolve };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

/**
 * Defends the bounded-run contract for eval: `tools.wallCapMs` is an absolute
 * per-call deadline that keeps counting while the per-cell idle watchdog is
 * paused on an agent()/completion() bridge wait, and that `timeout: 0` does not
 * lift. If it regresses, a cell parked on a never-returning bridge call runs
 * forever with nothing owner-visible.
 */
describe("EvalTool wall-clock cap", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("cancels a cell parked on a bridge wait once the cap elapses, even though the idle timer is paused", async () => {
		const cell = mockParkedCell();
		const tool = new EvalTool(makeSession(5_000));
		const resultPromise = tool.execute("call-wall-cap", {
			language: "js",
			code: "await agent('x').wait()",
			timeout: 1,
		});
		const options = await cell.started;

		// Past the 1s cell timeout: the idle watchdog is paused, so nothing fires.
		vi.advanceTimersByTime(2_000);
		expect(options.signal?.aborted).toBe(false);

		// The wall cap is not paused: it fires at 5s from the call start.
		vi.advanceTimersByTime(3_000);
		expect(options.signal?.aborted).toBe(true);
		// Backends classify it as a timeout by name and report the cap's duration from it.
		const reason = options.signal?.reason;
		expect(reason).toBeInstanceOf(WallCapTimeoutError);
		expect((reason as WallCapTimeoutError).name).toBe("TimeoutError");
		expect((reason as WallCapTimeoutError).capMs).toBe(5_000);

		const result = await resultPromise;
		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain("partial output");
		expect(text).toContain("tools.wallCapMs=5000");
		expect(result.details?.cells?.[0]?.status).toBe("error");
		expect(result.details?.cells?.[0]?.exitCode).toBeUndefined();
	});

	it("bounds a timeout: 0 cell by the wall cap", async () => {
		const cell = mockParkedCell();
		const tool = new EvalTool(makeSession(5_000));
		const resultPromise = tool.execute("call-wall-cap-unbounded", {
			language: "js",
			code: "while (true) {}",
			timeout: 0,
		});
		const options = await cell.started;

		vi.advanceTimersByTime(4_999);
		expect(options.signal?.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(options.signal?.aborted).toBe(true);

		const result = await resultPromise;
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("tools.wallCapMs=5000");
	});

	it("leaves a paused cell running indefinitely when the cap is disabled", async () => {
		const cell = mockParkedCell();
		const tool = new EvalTool(makeSession(0));
		const resultPromise = tool.execute("call-wall-cap-disabled", {
			language: "js",
			code: "await agent('x').wait()",
			timeout: 1,
		});
		const options = await cell.started;

		vi.advanceTimersByTime(60 * 60 * 1000);
		expect(options.signal?.aborted).toBe(false);

		cell.release();
		const result = await resultPromise;
		expect(result.isError).not.toBe(true);
		expect(result.details?.cells?.[0]?.status).toBe("complete");
	});
});
