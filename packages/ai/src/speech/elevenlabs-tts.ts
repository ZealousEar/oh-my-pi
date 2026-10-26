import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { postSpeechRequest } from "./transport";
import type { SpeechOptions, SpeechRequest, SpeechResult } from "./types";

/** Premade "George" (British male narration voice). */
export const DEFAULT_ELEVENLABS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
/** Per-request character limit of `eleven_multilingual_v2`, the strictest bundled model. */
export const ELEVENLABS_MAX_TEXT_LENGTH = 10_000;
export const DEFAULT_ELEVENLABS_PCM_SAMPLE_RATE = 24_000;
const PCM_SAMPLE_RATES = [8_000, 16_000, 22_050, 24_000, 44_100, 48_000] as const;
const MP3_FORMATS: Record<string, true> = {
	"22050_32": true,
	"44100_32": true,
	"44100_64": true,
	"44100_96": true,
	"44100_128": true,
	"44100_192": true,
};
/** ElevenLabs clamps `voice_settings.speed` to this range. */
const SPEED_RANGE = { min: 0.7, max: 1.2 } as const;

function outputFormat(request: SpeechRequest): string {
	if (request.format === "mp3") {
		const key = `${request.sampleRate ?? 44_100}_${Math.round((request.bitRate ?? 128_000) / 1000)}`;
		if (!MP3_FORMATS[key]) throw new AIError.ValidationError(`elevenlabs-tts does not support mp3_${key} output`);
		return `mp3_${key}`;
	}
	if (request.format === "pcm" || request.format === "wav") {
		const rate = request.sampleRate ?? DEFAULT_ELEVENLABS_PCM_SAMPLE_RATE;
		if (!(PCM_SAMPLE_RATES as readonly number[]).includes(rate)) {
			throw new AIError.ValidationError(`elevenlabs-tts does not support a ${rate} Hz sample rate`);
		}
		return `${request.format}_${rate}`;
	}
	throw new AIError.ValidationError(`elevenlabs-tts does not support ${request.format} output; use mp3, wav or pcm`);
}

/**
 * ElevenLabs text-to-speech: `POST /v1/text-to-speech/{voice_id}?output_format=…`
 * authenticated with `xi-api-key`. `pcm` is raw 16-bit little-endian mono.
 */
export async function synthesizeElevenLabsSpeech(
	model: Model<Api>,
	request: SpeechRequest,
	options: SpeechOptions,
): Promise<SpeechResult> {
	if (request.text.length > ELEVENLABS_MAX_TEXT_LENGTH) {
		throw new AIError.ValidationError(
			`elevenlabs-tts input exceeds the ${ELEVENLABS_MAX_TEXT_LENGTH}-character limit`,
		);
	}
	if (request.instructions !== undefined) {
		throw new AIError.ValidationError("elevenlabs-tts does not support instructions");
	}
	const format = outputFormat(request);
	const payload: Record<string, unknown> = { text: request.text, model_id: model.id };
	if (request.speed !== undefined) {
		payload.voice_settings = { speed: Math.min(SPEED_RANGE.max, Math.max(SPEED_RANGE.min, request.speed)) };
	}
	const voice = encodeURIComponent(request.voice ?? DEFAULT_ELEVENLABS_VOICE_ID);
	return postSpeechRequest(
		model,
		`/text-to-speech/${voice}?output_format=${format}`,
		payload,
		request.format,
		options,
		key => ({ "xi-api-key": key }),
	);
}
