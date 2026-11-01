import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { refuselessModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("Refuseless model catalog", () => {
	test("pins the GLM ladder to the efforts the gateway accepts, which the lineage rule misses behind the -abliterated suffix", () => {
		// A 400 from the gateway on medium/xhigh/minimal is what regresses.
		for (const id of ["glm-5.3-abliterated", "glm-5.3-flash-abliterated"]) {
			const spec = seedModels<"openai-completions">("refuseless").find(model => model.id === id);
			const model = buildModel(spec!);
			expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
			expect(model.thinking?.defaultLevel).toBe(Effort.Low);
			expect(model.thinking?.requiresEffort).toBe(true);
		}
	});

	test("keeps live context windows and the effort dial for roster ids that are not bundled", async () => {
		const options = refuselessModelManagerOptions({
			apiKey: "refuseless-test-key",
			fetch: async () =>
				Response.json({
					data: [
						{
							id: "glm-9-abliterated",
							abliterated: true,
							context_length: 2_000_000,
							reasoning_efforts: ["low", "high"],
						},
						{ id: "plain-stock-model", abliterated: false, context_length: 64_000 },
					],
				}),
		});
		const models = new Map((await options.fetchDynamicModels?.())?.map(model => [model.id, model]));
		expect(models.get("glm-9-abliterated")).toMatchObject({ contextWindow: 2_000_000, reasoning: true });
		expect(models.get("plain-stock-model")).toMatchObject({ contextWindow: 64_000, reasoning: false });
	});

	test("requires a key before probing the roster", () => {
		expect(refuselessModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});
});
