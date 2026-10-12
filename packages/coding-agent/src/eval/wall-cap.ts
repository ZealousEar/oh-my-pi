/**
 * Abort reason for the non-pausable per-call wall-clock cap (`tools.wallCapMs`).
 *
 * Named `TimeoutError` so every backend classifies it as a timeout (kernel
 * interrupt, JS worker reset) exactly like the per-cell watchdog; it carries
 * the cap so timeout annotations report the limit that actually fired.
 */
export class WallCapTimeoutError extends Error {
	override readonly name = "TimeoutError";

	constructor(readonly capMs: number) {
		super(`Wall-clock cap tools.wallCapMs=${capMs} reached`);
	}
}

/** Duration of the limit that fired: the wall cap when it caused the abort, else the cell timeout. */
export function firedTimeoutMs(reason: unknown, cellTimeoutMs: number | undefined): number | undefined {
	return reason instanceof WallCapTimeoutError ? reason.capMs : cellTimeoutMs;
}
