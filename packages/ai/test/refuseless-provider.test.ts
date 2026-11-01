import { describe, expect, test } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const glm = buildModel(
	seedModels<"openai-completions">("refuseless").find(model => model.id === "glm-5.3-abliterated")!,
);
const context: Context = {
	systemPrompt: ["You are a coding assistant."],
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

describe("Refuseless chat requests", () => {
	test("sends a gateway-accepted reasoning_effort and a plain system message", async () => {
		let payload: Record<string, unknown> | undefined;
		const controller = new AbortController();
		controller.abort();
		const stream = streamOpenAICompletions(glm, context, {
			reasoning: Effort.High,
			apiKey: "refuseless-test-key",
			signal: controller.signal,
			onPayload: body => {
				payload = body as Record<string, unknown>;
			},
		});
		await stream.result();
		expect(payload?.reasoning_effort).toBe("high");
		expect(payload).not.toHaveProperty("store");
		expect(payload?.messages).toEqual([
			expect.objectContaining({ role: "system" }),
			expect.objectContaining({ role: "user" }),
		]);
	});
});

describe("Refuseless API-key login", () => {
	test("rejects an invalid key by probing the keyed models endpoint", async () => {
		const login = getProviderDefinition("refuseless")!.login!;
		let endpoint = "";
		await expect(
			login({
				onAuth: () => {},
				onPrompt: async () => "invalid-test-key",
				fetch: async input => {
					endpoint = String(input);
					return Response.json({ error: { code: "invalid_key", message: "Invalid API key." } }, { status: 401 });
				},
			}),
		).rejects.toThrow();
		expect(endpoint).toBe("https://api.refuseless.com/v1/models");
	});
});
