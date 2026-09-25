import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChainJudge, hasNativeJudge, judgePin } from "@oh-my-pi/pi-coding-agent/judgment";
import { judgeWithMeter, LoopMeter } from "@oh-my-pi/pi-coding-agent/judgment/decision";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { asGlobalFetch } from "../helpers/fetch-mock";

const JEV_LATEST = {
	id: "jev-latest",
	name: "JEV Latest",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as Model<Api>;
const JEV_PINNED = { ...JEV_LATEST, id: "jev-1.13.0", name: "JEV 1.13.0" } as Model<Api>;

const ONLINE = getBundledModel("anthropic", "claude-sonnet-4-6");
if (!ONLINE) throw new Error("Expected a bundled online judge model");

const PIN = "typesafe/jev-1.13.0";
const request = { state: "x", questions: { ok: { type: "noul" as const, instructions: "?" } } };

function makeRegistry(models: Model<Api>[], keys: Record<string, string>): ModelRegistry {
	const authStorage = createInMemoryAuthStorage();
	for (const provider in keys) authStorage.keys.setRuntime(provider, keys[provider]!);
	const registry = new ModelRegistry(authStorage, "/nonexistent/exact-pin-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	return registry;
}

function pinned(extra: Record<string, unknown> = {}): Settings {
	return Settings.isolated({ modelRoles: { judge: PIN }, "retry.fallbackChains": { judge: [] }, ...extra });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("exact judge pin", () => {
	it("is recognised only for a literal provider/id with an explicitly empty judge chain", () => {
		expect(judgePin(pinned())).toBe(PIN);
		expect(judgePin(Settings.isolated({ modelRoles: { judge: PIN } }))).toBeUndefined();
		expect(
			judgePin(Settings.isolated({ modelRoles: { judge: PIN }, "retry.fallbackChains": { judge: ["@tiny"] } })),
		).toBeUndefined();
		expect(judgePin(pinned({ modelRoles: { judge: "@tiny" } }))).toBeUndefined();
		expect(judgePin(pinned({ modelRoles: { judge: "typesafe/*" } }))).toBeUndefined();
	});

	it("fails closed when the pinned model is not discovered, naming the gap, without substituting jev-latest or the session model", async () => {
		const settings = pinned();
		const registry = makeRegistry([JEV_LATEST, ONLINE], { typesafe: "ts-key", [ONLINE.provider]: "online-key" });
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async () => {
				throw new Error("no transport may be asked");
			}),
		);

		expect(hasNativeJudge(settings, registry)).toBe(false);
		const judge = new ChainJudge({ settings, registry, sessionModel: ONLINE });
		expect(judge.pinnedModel).toBe(PIN);
		const failure = await judge.judge(request).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain(`pinned judge ${PIN} is unavailable`);
		expect(message).toContain("typesafe lists 1 model(s) but not this id");
		expect(message).toContain("nearest: typesafe/jev-latest");
		expect(message).toContain("admits no substitute");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("names the provider when it lists no models at all (credential, policy, or discovery gap)", async () => {
		const settings = pinned();
		const registry = makeRegistry([ONLINE], { [ONLINE.provider]: "online-key" });
		await expect(new ChainJudge({ settings, registry }).judge(request)).rejects.toThrow(
			/provider typesafe lists no available models — check its credential, disabled-provider policy, and model discovery/,
		);
	});

	it("answers through the exact pin and, when it fails, asks nothing else", async () => {
		const settings = pinned();
		const registry = makeRegistry([JEV_LATEST, JEV_PINNED, ONLINE], {
			typesafe: "ts-key",
			[ONLINE.provider]: "online-key",
		});
		const models: string[] = [];
		let status = 200;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (url, init) => {
				expect(String(url)).toBe("https://judge.example.test/v1/systemone");
				models.push((JSON.parse(String(init?.body)) as { model: string }).model);
				if (status !== 200) {
					return new Response('{"error":"unavailable"}', { status, headers: { "retry-after": "0" } });
				}
				return Response.json({
					model: "jev-1.13.0",
					answers: { ok: { type: "noul", noul: 0.8 } },
					usage: { input_tokens: 8, output_tokens: 2 },
				});
			}),
		);

		expect(hasNativeJudge(settings, registry)).toBe(true);
		const judge = new ChainJudge({ settings, registry, sessionModel: ONLINE });
		const meter = new LoopMeter({ maxCalls: 3, maxActions: 3, deadlineAt: Date.now() + 20_000 });
		const { result, provenance } = await judgeWithMeter(judge, meter, request);
		expect(result.model).toBe("jev-1.13.0");
		expect(models).toEqual(["jev-1.13.0"]);
		expect(provenance).toMatchObject({ backend: "native", distribution: "native", pinnedModel: PIN });
		expect(provenance.fallback).toBeUndefined();

		status = 503;
		models.length = 0;
		await expect(judgeWithMeter(judge, meter, request)).rejects.toThrow(/every judge candidate failed/);
		expect(new Set(models)).toEqual(new Set(["jev-1.13.0"]));
		expect(meter.calls).toBe(2);
		const failed = meter.attempts.at(-1);
		expect(failed).toMatchObject({ attempt: 2, nested: true, backend: "native", model: "jev-1.13.0" });
		expect(failed?.error).toMatch(/503/);
	});

	it("keeps the upstream session-model last resort only when no exact pin is configured", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: `${ONLINE.provider}/${ONLINE.id}` } });
		const registry = makeRegistry([ONLINE], { [ONLINE.provider]: "online-key" });
		const backup = { ...ONLINE, id: "claude-judge-backup", name: "Judge Backup" } as Model<Api>;
		const asked: string[] = [];
		await new ChainJudge({ settings, registry, sessionModel: backup })
			.withCandidate(async (candidate, kind) => {
				asked.push(`${kind}:${candidate.label}`);
				throw new Error("skip");
			})
			.catch(() => undefined);
		expect(asked).toHaveLength(2);

		asked.length = 0;
		await new ChainJudge({ settings: pinned(), registry, sessionModel: backup })
			.withCandidate(async (candidate, kind) => {
				asked.push(`${kind}:${candidate.label}`);
				throw new Error("skip");
			})
			.catch(() => undefined);
		expect(asked).toEqual([]);
	});
});
