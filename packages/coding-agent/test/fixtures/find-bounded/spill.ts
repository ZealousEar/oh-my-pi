/** Fixture: a miniature spill-decision module used by semantic-find tests. */
const DEFAULT_THRESHOLD_KB = 50;

export interface SpillConfig {
	thresholdBytes: number;
	headBytes: number;
	tailBytes: number;
}

export function getSpillConfig(thresholdKb: number, headKb: number, tailKb: number): SpillConfig {
	return {
		thresholdBytes: thresholdKb * 1024,
		headBytes: headKb * 1024,
		tailBytes: tailKb * 1024,
	};
}

export function shouldSpill(byteLength: number, config: SpillConfig): boolean {
	return byteLength > config.thresholdBytes;
}

export function defaultThresholdBytes(): number {
	return DEFAULT_THRESHOLD_KB * 1024;
}
