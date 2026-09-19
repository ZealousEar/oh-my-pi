import { describe, expect, it } from "bun:test";
import type { JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import {
	judgeWithMeter,
	LoopBudgetExceeded,
	LoopMeter,
	meterHelperCall,
} from "@oh-my-pi/pi-coding-agent/judgment/decision";
import type { ResolvedJudge, ResolvedJudgeOptions } from "@oh-my-pi/pi-coding-agent/judgment/index";

class FailingJudge implements ResolvedJudge {
	readonly kind = "online" as const;
	readonly label = "fixture/failing";
	calls = 0;
	async judge<Q extends Questions>(_request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		this.calls++;
		throw new Error("upstream 503");
	}
}

/** TypeSafe-fronted judge whose native request fails and whose chat fallback answers. */
class FallingBackJudge implements ResolvedJudge {
	readonly kind = "typesafe" as const;
	readonly label = "typesafe/jev-latest";
	readonly fallback = "llm" as const;
	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options?: ResolvedJudgeOptions,
	): Promise<JudgmentResult<Q>> {
		options?.onAttempt?.({
			api: "typesafe",
			provider: "typesafe",
			model: "jev-latest",
			usage: tokenUsage(0, 0),
			durationMs: 12,
			error: "TypeSafe API error (503)",
		});
		options?.onAttempt?.({
			api: "openai-codex",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			usage: tokenUsage(40, 2),
			durationMs: 300,
		});
		const answers = {} as JudgmentResult<Q>["answers"];
		for (const id in request.questions) {
			(answers as Record<string, unknown>)[id] = { type: "noul", noul: 0.9 };
		}
		return {
			api: "openai-codex",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			answers,
			usage: tokenUsage(40, 2),
		};
	}
}

/** Chat judge whose first completion parsed as nothing and whose format retry answered. */
class RetryingJudge implements ResolvedJudge {
	readonly kind = "online" as const;
	readonly label = "tiny/smol/default";
	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options?: ResolvedJudgeOptions,
	): Promise<JudgmentResult<Q>> {
		options?.onAttempt?.({
			api: "openai-codex",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			usage: tokenUsage(50, 8),
			durationMs: 200,
		});
		options?.onAttempt?.({
			api: "openai-codex",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			usage: tokenUsage(40, 2),
			durationMs: 150,
		});
		const answers = {} as JudgmentResult<Q>["answers"];
		for (const id in request.questions) {
			(answers as Record<string, unknown>)[id] = { type: "noul", noul: 0.9 };
		}
		return {
			api: "openai-codex",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			answers,
			usage: tokenUsage(40, 2),
		};
	}
}

const request = { state: { goal: "x" }, questions: { pick: { type: "noul" as const, instructions: "?" } } };

describe("judgeWithMeter", () => {
	it("keeps a failed call on the meter so usage.calls matches the spent call budget", async () => {
		// A loop that reports `budget.calls: 1` but `usage.calls: 0` after a
		// transport failure hides the spent attempt from cost/provenance reporting.
		const judge = new FailingJudge();
		const meter = new LoopMeter({ maxCalls: 3, maxActions: 3, deadlineAt: Date.now() + 10_000 });

		await expect(judgeWithMeter(judge, meter, request)).rejects.toThrow("upstream 503");

		expect(judge.calls).toBe(1);
		expect(meter.calls).toBe(1);
		expect(meter.attempts).toHaveLength(1);
		expect(meter.attempts[0]).toMatchObject({
			attempt: 1,
			error: "upstream 503",
			costUsd: "unknown",
			backend: "online",
		});
		expect(meter.totalUsage()).toMatchObject({ calls: 1, input: 0, output: 0, costUsd: "unknown" });
	});

	it("stops at the call bound before asking the judge again", async () => {
		const judge = new FailingJudge();
		const meter = new LoopMeter({ maxCalls: 1, maxActions: 1, deadlineAt: Date.now() + 10_000 });
		await expect(judgeWithMeter(judge, meter, request)).rejects.toThrow("upstream 503");

		await expect(judgeWithMeter(judge, meter, request)).rejects.toBeInstanceOf(LoopBudgetExceeded);
		expect(judge.calls).toBe(1);
		expect(meter.attempts).toHaveLength(1);
	});

	it("records the failed native attempt behind a chat fallback as its own nested row", async () => {
		// A TypeSafe→chat fallback used to appear as one chat row: the billable
		// failed native request vanished from the loop's accounting.
		const meter = new LoopMeter({ maxCalls: 3, maxActions: 3, deadlineAt: Date.now() + 10_000 });
		const { provenance } = await judgeWithMeter(new FallingBackJudge(), meter, request);

		expect(meter.calls).toBe(1);
		expect(meter.attempts).toHaveLength(2);
		expect(meter.attempts[0]).toMatchObject({
			attempt: 1,
			nested: true,
			api: "typesafe",
			distribution: "native",
			error: "TypeSafe API error (503)",
			costUsd: "unknown",
		});
		expect(meter.attempts[1]).toBe(provenance);
		expect(provenance).toMatchObject({
			attempt: 1,
			distribution: "synthetic",
			fallback: { from: "typesafe/jev-latest" },
		});
		expect(provenance.nested).toBeUndefined();
		expect(meter.totalUsage()).toMatchObject({ calls: 1, attempts: 2, input: 40, output: 2 });
	});

	it("keeps a billed completion whose answer was rejected and retried on the meter", async () => {
		// A chat judge that gets an unparseable answer issues a format-correction
		// completion; the first completion was billed but reported no transport
		// error, so it used to vanish from attempts, token totals, and cost.
		const meter = new LoopMeter({ maxCalls: 3, maxActions: 3, deadlineAt: Date.now() + 10_000 });
		const { provenance } = await judgeWithMeter(new RetryingJudge(), meter, request);

		expect(meter.calls).toBe(1);
		expect(meter.attempts).toHaveLength(2);
		expect(meter.attempts[0]).toMatchObject({
			attempt: 1,
			nested: true,
			model: "gpt-5.6-luna",
			error: "answer rejected; retried",
			usage: { input: 50, output: 8 },
		});
		expect(meter.attempts[1]).toBe(provenance);
		expect(meter.totalUsage()).toMatchObject({ calls: 1, attempts: 2, input: 90, output: 10 });
	});

	it("meters helper completions against the call bound and keeps failed ones", async () => {
		const meter = new LoopMeter({ maxCalls: 2, maxActions: 3, deadlineAt: Date.now() + 10_000 });
		const ok = await meterHelperCall(meter, "text-value", async () => ({
			value: "Ada",
			report: { api: "anthropic", provider: "anthropic", model: "claude-x", usage: tokenUsage(10, 3) },
		}));
		expect(ok.value).toBe("Ada");
		expect(ok.provenance).toMatchObject({ helper: "text-value", attempt: 1, model: "claude-x", costUsd: 0 });

		await expect(
			meterHelperCall(meter, "text-value", async () => {
				throw new Error("helper 500");
			}),
		).rejects.toThrow("helper 500");
		expect(meter.attempts).toHaveLength(2);
		expect(meter.attempts[1]).toMatchObject({ helper: "text-value", attempt: 2, error: "helper 500" });

		// The helper spent the whole call budget: a judgment must now be refused.
		await expect(judgeWithMeter(new FailingJudge(), meter, request)).rejects.toBeInstanceOf(LoopBudgetExceeded);
		expect(meter.calls).toBe(2);
	});
});
