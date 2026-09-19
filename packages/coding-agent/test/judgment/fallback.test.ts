import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { AuthStorage, SqliteAuthCredentialStore, tokenUsage, TypeSafeJudge } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { judgeWithMeter, LoopMeter } from "@oh-my-pi/pi-coding-agent/judgment/decision";
import {
	type JudgmentAttempt,
	type ResolvedJudgeOptions,
	resolveJudge,
	TypeSafeFrontedJudge,
} from "@oh-my-pi/pi-coding-agent/judgment/index";
import { ONLINE_MEMORY_MODEL_KEY } from "@oh-my-pi/pi-coding-agent/tiny/models";

/** Stand-in for the online chat chain: answers every question, counts invocations, reports its attempt. */
class SpyLlmJudge {
	readonly label = "fixture/llm";
	calls = 0;
	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options?: ResolvedJudgeOptions,
	): Promise<JudgmentResult<Q>> {
		this.calls++;
		const answers: Record<string, unknown> = {};
		for (const id in request.questions) answers[id] = { type: "noul", noul: 0.9 };
		const usage = tokenUsage(10, 1);
		options?.onAttempt?.({
			api: "openai-completions",
			provider: "fixture",
			model: "fixture-chat",
			usage,
			durationMs: 1,
		});
		return {
			api: "openai-completions",
			provider: "fixture",
			model: "fixture-chat",
			answers: answers as JudgmentResult<Q>["answers"],
			usage,
		};
	}
}

const request = { state: { goal: "x" }, questions: { ok: { type: "noul" as const, instructions: "?" } } };

/** TypeSafe stand-in that is always down. `retry-after: 0` keeps the client's retries instant. */
let server: Bun.Server<undefined>;
let systemOneHits = 0;
let chatHits = 0;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(incoming) {
			const url = new URL(incoming.url);
			if (url.pathname === "/v1/systemone") {
				systemOneHits++;
				return new Response('{"error":"unavailable"}', { status: 503, headers: { "retry-after": "0" } });
			}
			chatHits++;
			return new Response("not a chat endpoint", { status: 404 });
		},
	});
});

afterAll(() => {
	server.stop(true);
});

function downTypeSafe(): TypeSafeJudge {
	return new TypeSafeJudge({ apiKey: "fixture-key", baseUrl: server.url.toString(), model: "jev-fixture" });
}

describe("TypeSafeFrontedJudge fallback policy", () => {
	it("llm: a failed TypeSafe call is answered by the LLM judge and flagged in provenance", async () => {
		const llm = new SpyLlmJudge();
		const judge = new TypeSafeFrontedJudge(downTypeSafe(), llm, "llm");
		const meter = new LoopMeter({ maxCalls: 2, maxActions: 2, deadlineAt: Date.now() + 20_000 });
		const before = systemOneHits;

		const { result, provenance } = await judgeWithMeter(judge, meter, request);

		expect(judge.fallback).toBe("llm");
		expect(systemOneHits - before).toBe(3);
		expect(llm.calls).toBe(1);
		expect(result.model).toBe("fixture-chat");
		expect(provenance).toMatchObject({
			backend: "typesafe",
			distribution: "synthetic",
			fallback: { from: "typesafe/jev-fixture" },
			attempt: 1,
		});
		expect(provenance.error).toBeUndefined();
	});

	it("llm: reports the failed TypeSafe attempt and then the chat attempt through onAttempt", async () => {
		const llm = new SpyLlmJudge();
		const judge = new TypeSafeFrontedJudge(downTypeSafe(), llm, "llm");
		const attempts: JudgmentAttempt[] = [];

		const result = await judge.judge(request, { onAttempt: attempt => attempts.push(attempt) });

		expect(result.model).toBe("fixture-chat");
		expect(attempts).toHaveLength(2);
		expect(attempts[0]).toMatchObject({ api: "typesafe", provider: "typesafe", model: "jev-fixture" });
		expect(attempts[0]?.error).toMatch(/503/);
		expect(attempts[0]?.usage.totalTokens).toBe(0);
		expect(attempts[1]).toMatchObject({ api: "openai-completions", model: "fixture-chat" });
		expect(attempts[1]?.error).toBeUndefined();
		expect(attempts[1]?.usage.input).toBe(10);
	});

	it("none: reports exactly the failed TypeSafe attempt", async () => {
		const llm = new SpyLlmJudge();
		const judge = new TypeSafeFrontedJudge(downTypeSafe(), llm, "none");
		const attempts: JudgmentAttempt[] = [];

		await expect(judge.judge(request, { onAttempt: attempt => attempts.push(attempt) })).rejects.toThrow(/503/);

		expect(attempts).toHaveLength(1);
		expect(attempts[0]?.error).toMatch(/503/);
		expect(llm.calls).toBe(0);
	});

	it("none: the TypeSafe error propagates, the failed attempt is metered, and the LLM judge is never asked", async () => {
		const llm = new SpyLlmJudge();
		const judge = new TypeSafeFrontedJudge(downTypeSafe(), llm, "none");
		const meter = new LoopMeter({ maxCalls: 2, maxActions: 2, deadlineAt: Date.now() + 20_000 });
		const before = systemOneHits;

		await expect(judgeWithMeter(judge, meter, request)).rejects.toThrow(/TypeSafe API error \(503\)/);

		expect(judge.fallback).toBe("none");
		expect(systemOneHits - before).toBe(3);
		expect(llm.calls).toBe(0);
		expect(meter.attempts).toHaveLength(1);
		expect(meter.attempts[0]).toMatchObject({ backend: "typesafe", api: "typesafe", attempt: 1 });
		expect(meter.attempts[0]?.error).toMatch(/503/);
		expect(meter.totalUsage()).toMatchObject({ calls: 1, input: 0, output: 0 });
	});

	it("none: a caller abort propagates as an abort, not as a TypeSafe failure", async () => {
		const llm = new SpyLlmJudge();
		const judge = new TypeSafeFrontedJudge(downTypeSafe(), llm, "none");
		const meter = new LoopMeter({ maxCalls: 2, maxActions: 2, deadlineAt: Date.now() + 20_000 });
		const before = systemOneHits;
		const controller = new AbortController();
		controller.abort();

		await expect(judgeWithMeter(judge, meter, request, { signal: controller.signal })).rejects.toMatchObject({
			name: "LoopBudgetExceeded",
			limit: "aborted",
		});
		expect(systemOneHits - before).toBe(0);
		expect(llm.calls).toBe(0);
		expect(meter.attempts).toHaveLength(1);
	});
});

describe("resolveJudge honours providers.judgmentFallback", () => {
	const previousBaseUrl = process.env.TYPESAFE_BASE_URL;
	let registry: ModelRegistry;

	beforeAll(() => {
		process.env.TYPESAFE_BASE_URL = server.url.toString();
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		authStorage.setRuntimeApiKey("typesafe", "fixture-key");
		registry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		if (previousBaseUrl === undefined) delete process.env.TYPESAFE_BASE_URL;
		else process.env.TYPESAFE_BASE_URL = previousBaseUrl;
	});

	it("none: exposes the policy and fails closed without touching any chat endpoint", async () => {
		const judge = resolveJudge({
			settings: Settings.isolated({
				"providers.judgmentProvider": "typesafe",
				"providers.judgmentFallback": "none",
			}),
			registry,
			backend: ONLINE_MEMORY_MODEL_KEY,
		});
		const meter = new LoopMeter({ maxCalls: 1, maxActions: 1, deadlineAt: Date.now() + 20_000 });
		const chatBefore = chatHits;

		expect(judge.kind).toBe("typesafe");
		expect(judge.fallback).toBe("none");
		await expect(judgeWithMeter(judge, meter, request)).rejects.toThrow(/TypeSafe API error \(503\)/);
		expect(chatHits).toBe(chatBefore);
		expect(meter.attempts[0]?.error).toMatch(/503/);
	});

	it("llm (default): consults the online chain after the TypeSafe failure", async () => {
		const judge = resolveJudge({
			settings: Settings.isolated({ "providers.judgmentProvider": "typesafe" }),
			registry,
			backend: ONLINE_MEMORY_MODEL_KEY,
		});
		expect(judge.fallback).toBe("llm");
		// No chat model is authenticated in this registry, so the chain reports
		// its own exhaustion instead of surfacing the TypeSafe 503.
		await expect(judge.judge(request)).rejects.toThrow(/tiny\/smol/);
	});

	it("is absent when TypeSafe is not in front", () => {
		const judge = resolveJudge({
			settings: Settings.isolated({ "providers.judgmentProvider": "llm" }),
			registry,
			backend: ONLINE_MEMORY_MODEL_KEY,
		});
		expect(judge.kind).toBe("online");
		expect(judge.fallback).toBeUndefined();
	});
});
