import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { DEFAULT_ELEVENLABS_VOICE_ID, synthesizeSpeech } from "../src/speech";

const model = getBundledModel("elevenlabs", "eleven_flash_v2_5");

function recordingFetch() {
	const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
		return new Response(new Uint8Array([0, 64]));
	}) as unknown as FetchImpl;
	return { calls, fetchImpl };
}

describe("elevenlabs-tts", () => {
	it("authenticates with xi-api-key and maps the voice, model and pcm format onto the request", async () => {
		const { calls, fetchImpl } = recordingFetch();
		const result = await synthesizeSpeech(
			model,
			{ text: "Hello", format: "pcm", voice: "voice 1", sampleRate: 24_000, speed: 2 },
			{ apiKey: "sk_secret", fetch: fetchImpl },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice%201?output_format=pcm_24000");
		expect(calls[0]!.headers["xi-api-key"]).toBe("sk_secret");
		expect(calls[0]!.headers.Authorization).toBeUndefined();
		// Speed is clamped to ElevenLabs' accepted 0.7–1.2 range.
		expect(calls[0]!.body).toEqual({ text: "Hello", model_id: "eleven_flash_v2_5", voice_settings: { speed: 1.2 } });
		expect(result.mimeType).toBe("audio/pcm");
	});

	it("defaults to the George voice and 44.1 kHz/128 kbps mp3", async () => {
		const { calls, fetchImpl } = recordingFetch();
		await synthesizeSpeech(model, { text: "Hi", format: "mp3" }, { apiKey: "k", fetch: fetchImpl });
		expect(calls[0]!.url).toBe(
			`https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
		);
	});

	it("rejects unsupported formats and sample rates before any request", async () => {
		const { calls, fetchImpl } = recordingFetch();
		await expect(
			synthesizeSpeech(model, { text: "Hi", format: "flac" }, { apiKey: "k", fetch: fetchImpl }),
		).rejects.toThrow("elevenlabs-tts does not support flac output");
		await expect(
			synthesizeSpeech(model, { text: "Hi", format: "wav", sampleRate: 11_025 }, { apiKey: "k", fetch: fetchImpl }),
		).rejects.toThrow("11025 Hz");
		expect(calls).toHaveLength(0);
	});
});
