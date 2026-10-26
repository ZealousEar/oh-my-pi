/**
 * Streaming-synthesis session backed by a cloud speech API (ElevenLabs). Each
 * pushed segment becomes one raw-PCM request; requests run one at a time so
 * chunks arrive in push order, matching the local worker's contract.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ApiKey } from "@oh-my-pi/pi-ai/auth-retry";
import { DEFAULT_ELEVENLABS_PCM_SAMPLE_RATE, synthesizeSpeech } from "@oh-my-pi/pi-ai/speech";
import { AudioChunkChannel, type TtsStreamHandle } from "./tts-client";

export interface CloudSpeechStreamOptions {
	apiKey: ApiKey;
	voice: string;
	speed?: number;
	signal: AbortSignal;
}

export function createCloudSpeechStream(model: Model, options: CloudSpeechStreamOptions): TtsStreamHandle {
	const channel = new AudioChunkChannel();
	const { signal } = options;
	let index = 0;
	let ended = false;
	let queue = Promise.resolve();
	signal.addEventListener("abort", () => channel.close(), { once: true });

	const synthesize = async (text: string, segment: number): Promise<void> => {
		if (signal.aborted) return;
		const result = await synthesizeSpeech(
			model,
			{
				text,
				format: "pcm",
				voice: options.voice,
				sampleRate: DEFAULT_ELEVENLABS_PCM_SAMPLE_RATE,
				...(options.speed !== undefined && options.speed !== 1 ? { speed: options.speed } : {}),
			},
			{ apiKey: options.apiKey, signal },
		);
		// Raw 16-bit little-endian mono → [-1, 1] floats for the player.
		const samples = new Int16Array(result.audio.buffer, result.audio.byteOffset, result.audio.byteLength >> 1);
		const pcm = new Float32Array(samples.length);
		for (let i = 0; i < samples.length; i++) pcm[i] = samples[i]! / 32768;
		channel.push({ index: segment, text, pcm, sampleRate: DEFAULT_ELEVENLABS_PCM_SAMPLE_RATE });
	};

	return {
		push(text: string) {
			if (ended || signal.aborted) return;
			const segment = index++;
			queue = queue
				.then(() => synthesize(text, segment))
				.catch(error => channel.fail(error instanceof Error ? error : new Error(String(error))));
		},
		end() {
			if (ended) return;
			ended = true;
			queue = queue.then(() => channel.close());
		},
		chunks: channel.iterator(),
	};
}
