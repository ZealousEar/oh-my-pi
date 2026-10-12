import { describe, expect, it } from "bun:test";
import type { JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import {
	decideAmongCandidates,
	type DecisionJudge,
	judgeWithMeter,
	LoopBudgetExceeded,
	LoopMeter,
	meterHelperCall,
} from "@oh-my-pi/pi-coding-agent/judgment/decision";
import type { ChainJudgeOptions } from "@oh-my-pi/pi-coding-agent/judgment/index";

class FailingJudge implements DecisionJudge {
	readonly kind = "online" as const;
	readonly label = "fixture/failing";
	calls = 0;
	async judge<Q extends Questions>(_request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		this.calls++;
		throw new Error("upstream 503");
	}
}

function noulAnswers<Q extends Questions>(request: JudgmentRequest<Q>): JudgmentResult<Q>["answers"] {
	const answers: Record<string, unknown> = {};
	for (const id in request.questions) answers[id] = { type: "noul", noul: 0.9 };
	return answers as JudgmentResult<Q>["answers"];
}

/** Role chain whose native candidate fails and whose next (chat) candidate answers. */
class FallingThroughJudge implements DecisionJudge {
	readonly label = "judge role chain";
	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options?: ChainJudgeOptions,
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
		return {
			api: "openai-codex",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			answers: noulAnswers(request),
			usage: tokenUsage(40, 2),
		};
	}
}

/** Chat judge whose first completion parsed as nothing and whose format retry answered. */
class RetryingJudge implements DecisionJudge {
	readonly kind = "online" as const;
	readonly label = "judge role chain";
	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options?: ChainJudgeOptions,
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
		return {
			api: "openai-codex",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			answers: noulAnswers(request),
			usage: tokenUsage(40, 2),
		};
	}
}

/** Native judge answering a choice with a calibrated distribution. */
class ChoosingJudge implements DecisionJudge {
	readonly label = "judge role chain";
	readonly pinnedModel = "typesafe/jev-1.13.0";
	constructor(readonly choice: string) {}
	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options?: ChainJudgeOptions,
	): Promise<JudgmentResult<Q>> {
		const usage = tokenUsage(20, 1);
		options?.onAttempt?.({ api: "typesafe", provider: "typesafe", model: "jev-1.13.0", usage, durationMs: 5 });
		const answers: Record<string, unknown> = {};
		for (const id in request.questions) {
			const question = request.questions[id];
			if (question.type === "choice") {
				const ids = Object.keys(question.criteria);
				const probabilities: Record<string, number> = {};
				for (const option of ids) probabilities[option] = option === this.choice ? 0.7 : 0.3 / (ids.length - 1);
				answers[id] = { type: "choice", choice: this.choice, probabilities, confidence: 0.7 };
			} else {
				answers[id] = { type: "noul", noul: 0.2 };
			}
		}
		return {
			api: "typesafe",
			provider: "typesafe",
			model: "jev-1.13.0",
			answers: answers as JudgmentResult<Q>["answers"],
			usage,
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

	it("records the failed native candidate the chain moved past as its own nested row", async () => {
		// A native→chat fall-through used to appear as one chat row: the failed
		// native request vanished from the loop's accounting.
		const meter = new LoopMeter({ maxCalls: 3, maxActions: 3, deadlineAt: Date.now() + 10_000 });
		const { provenance } = await judgeWithMeter(new FallingThroughJudge(), meter, request);

		expect(meter.calls).toBe(1);
		expect(meter.attempts).toHaveLength(2);
		expect(meter.attempts[0]).toMatchObject({
			attempt: 1,
			nested: true,
			api: "typesafe",
			backend: "native",
			distribution: "native",
			error: "TypeSafe API error (503)",
			costUsd: "unknown",
		});
		expect(meter.attempts[1]).toBe(provenance);
		expect(provenance).toMatchObject({
			attempt: 1,
			backend: "online",
			distribution: "synthetic",
			fallback: { from: "typesafe/jev-latest", reason: "TypeSafe API error (503)" },
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
		// Same model retried: not a fall-through.
		expect(provenance.fallback).toBeUndefined();
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

	it("maps a caller abort to the loop's aborted budget error before any transport is asked", async () => {
		const judge = new FailingJudge();
		const meter = new LoopMeter({ maxCalls: 2, maxActions: 2, deadlineAt: Date.now() + 20_000 });
		const controller = new AbortController();
		controller.abort();

		await expect(judgeWithMeter(judge, meter, request, { signal: controller.signal })).rejects.toMatchObject({
			name: "LoopBudgetExceeded",
			limit: "aborted",
		});
		expect(meter.attempts).toHaveLength(1);
	});
});

describe("decideAmongCandidates", () => {
	const candidates = [
		{ id: "click_submit", label: "Click Submit", args: { selector: "#submit" } },
		{ id: "type_name", label: "Type into Name", args: { selector: "#name" } },
		{ id: "done", label: "Task complete", args: null, rubric: "The goal is met" },
	];

	it("returns the exact local candidate, a ranking, native provenance, and the pinned model", async () => {
		const meter = new LoopMeter({ maxCalls: 2, maxActions: 2, deadlineAt: Date.now() + 10_000 });
		const decision = await decideAmongCandidates(new ChoosingJudge("type_name"), meter, {
			state: { goal: "fill the form" },
			instructions: "Pick the next action.",
			candidates,
			extras: { nouls: { complete: { type: "noul", instructions: "Is the goal met?" } } },
		});
		expect(decision.candidate).toBe(candidates[1]);
		expect(decision.ranking[0]).toEqual({ id: "type_name", probability: 0.7 });
		expect(decision.ranking).toHaveLength(3);
		expect(decision.nouls.complete).toEqual({ type: "noul", noul: 0.2 });
		expect(decision.provenance).toMatchObject({
			backend: "native",
			distribution: "native",
			pinnedModel: "typesafe/jev-1.13.0",
			model: "jev-1.13.0",
			costUsd: "unknown",
		});
		expect(meter.calls).toBe(1);
	});

	it("treats an unknown chosen id as a backend error, never an action", async () => {
		const meter = new LoopMeter({ maxCalls: 2, maxActions: 2, deadlineAt: Date.now() + 10_000 });
		await expect(
			decideAmongCandidates(new ChoosingJudge("ghost"), meter, {
				state: {},
				instructions: "Pick.",
				candidates,
			}),
		).rejects.toThrow('unknown candidate "ghost"');
	});

	it("rejects duplicate, malformed, and reserved candidate ids before asking the judge", async () => {
		const meter = new LoopMeter({ maxCalls: 2, maxActions: 2, deadlineAt: Date.now() + 10_000 });
		const judge = new ChoosingJudge("a");
		const bad = [
			[
				{ id: "a", label: "A", args: null },
				{ id: "a", label: "A again", args: null },
			],
			[{ id: "1bad", label: "starts with digit", args: null }],
			[{ id: "has space", label: "space", args: null }],
		];
		for (const list of bad) {
			await expect(
				decideAmongCandidates(judge, meter, { state: {}, instructions: "Pick.", candidates: list }),
			).rejects.toThrow(/decision:/);
		}
		await expect(
			decideAmongCandidates(judge, meter, {
				state: {},
				instructions: "Pick.",
				candidates,
				extras: { nouls: { select: { type: "noul", instructions: "clash" } } },
			}),
		).rejects.toThrow('"select" is reserved');
		expect(meter.calls).toBe(0);
	});
});
