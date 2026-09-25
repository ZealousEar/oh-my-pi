import { describe, expect, it } from "bun:test";
import { executePythonWithKernel, type PythonKernelExecutor } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { KernelExecuteOptions, KernelExecuteResult } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { WallCapTimeoutError } from "@oh-my-pi/pi-coding-agent/eval/wall-cap";

class FakeKernel implements PythonKernelExecutor {
	private result: KernelExecuteResult;
	private onExecute: (options?: KernelExecuteOptions) => void;

	constructor(result: KernelExecuteResult, onExecute: (options?: KernelExecuteOptions) => void) {
		this.result = result;
		this.onExecute = onExecute;
	}

	async execute(_code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.onExecute(options);
		return this.result;
	}
}

describe("executePythonWithKernel cancellation", () => {
	it("annotates timeouts when cancelled", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: true, timedOut: true, stdinRequested: false },
			options => {
				options?.onChunk?.("tick\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "sleep(10)", { timeoutMs: 5000 });

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("eval cell timed out after 5s");
	});

	it("names the wall cap's duration when the cap, not a cell timeout, stopped a timeout-0 cell", async () => {
		const wallCap = new AbortController();
		const kernel = new FakeKernel({ status: "ok", cancelled: true, timedOut: true, stdinRequested: false }, () =>
			wallCap.abort(new WallCapTimeoutError(45_000)),
		);

		const result = await executePythonWithKernel(kernel, "sleep(120)", { signal: wallCap.signal });

		expect(result.output).toContain("eval cell timed out after 45s");
		expect(result.output).not.toContain("the configured timeout");
	});
});
