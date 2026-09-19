/**
 * Public shape of the `shake` operation, kept in a dependency-free leaf module
 * so slash-command registries and controllers can import `formatShakeSummary`
 * without pulling in the heavy `agent-session` module graph (which would form
 * an import cycle through the slash-command registry).
 */
import type { ReductionReceipt } from "../reduction/contract";

/**
 * Mode selector for `AgentSession.shake`. `elide` is the explicit mechanical
 * reduction: every eligible region goes behind a recoverable placeholder.
 * `semantic` elides only the tool results a bounded judgment, given the task
 * context, says are consumed; results that are protected evidence (errors,
 * diagnostics, verification receipts), duplicates of kept results, uncertain,
 * or that the judge could not be asked about (egress off, judge unavailable,
 * budget spent, oversized, no task context) all stay exactly as they are.
 */
export type ShakeMode = "elide" | "images" | "thinking" | "semantic";

/** How the semantic selection of one shake run was decided. */
export interface ShakeSelectionSummary {
	/** Eligible tool results considered. */
	candidates: number;
	/** Kept because the judge said the task still needs them (keep ≥ 0.5). */
	keptByJudge: number;
	/** Kept because the judge's answer was uncertain (keeping is the safe direction). */
	keptUncertain: number;
	/** Kept because their contents were identical to an already-kept result. */
	keptDuplicate: number;
	/** Kept without a judgment: errors, diagnostics, and verification receipts are protected in code. */
	keptProtected: number;
	/** Kept because no judgment could be obtained (egress off, judge unavailable, budget spent, oversized, no task context). */
	keptUnjudged: number;
	/** Elided to a recoverable placeholder because the judge said the task no longer needs them. */
	elided: number;
	/** Judgment calls made, and the wall clock they took. */
	calls: number;
	durationMs: number;
	/** `native`/`synthetic` distribution of the answering judge, when one answered. */
	distribution?: "native" | "synthetic";
	/** Why no judgment ran, when none did. */
	skipped?: string;
}

/** Outcome of an `AgentSession.shake` run. */
export interface ShakeResult {
	mode: ShakeMode;
	/** Whole tool-call results dropped. */
	toolResultsDropped: number;
	/** Large fenced/XML blocks dropped. */
	blocksDropped: number;
	/** Image blocks removed (images mode only). */
	imagesDropped?: number;
	/** Thinking blocks dropped (thinking mode only). */
	thinkingBlocksDropped?: number;
	/** Estimated context tokens reclaimed. */
	tokensFreed: number;
	/** Session artifact holding the dropped originals, when persisted. */
	artifactId?: string;
	/** Selection receipt (semantic mode only). */
	selection?: ShakeSelectionSummary;
	/** One receipt per judged candidate region, kept and elided alike (semantic mode only). */
	receipts?: ReductionReceipt[];
}

/** One-line operator summary of a {@link ShakeResult} (shared by TUI + ACP). */
export function formatShakeSummary(result: ShakeResult): string {
	if (result.mode === "images") {
		const n = result.imagesDropped ?? 0;
		return n === 0
			? "No images found in this session."
			: `Dropped ${n} image${n === 1 ? "" : "s"} from this session.`;
	}
	if (result.mode === "thinking") {
		const n = result.thinkingBlocksDropped ?? 0;
		return n === 0
			? "No thinking blocks found in this session."
			: `Dropped ${n} thinking block${n === 1 ? "" : "s"} from this session.`;
	}
	const parts: string[] = [];
	if (result.toolResultsDropped > 0) {
		parts.push(`${result.toolResultsDropped} tool result${result.toolResultsDropped === 1 ? "" : "s"}`);
	}
	if (result.blocksDropped > 0) {
		parts.push(`${result.blocksDropped} block${result.blocksDropped === 1 ? "" : "s"}`);
	}
	const selection = result.selection;
	const selectionNote = selection ? ` [semantic: ${describeShakeSelection(selection)}]` : "";
	if (parts.length === 0) return `Nothing to shake.${selectionNote}`;
	return `Shook ${parts.join(" + ")} (~${result.tokensFreed} tokens freed).${selectionNote}`;
}

/** Operator-facing measurement of one selection: `kept X of Y (…), elided N, C calls, T ms, <distribution|skip reason>`. */
export function describeShakeSelection(selection: ShakeSelectionSummary): string {
	const kept =
		selection.keptByJudge +
		selection.keptUncertain +
		selection.keptDuplicate +
		selection.keptProtected +
		selection.keptUnjudged;
	const bases: string[] = [];
	if (selection.keptByJudge) bases.push(`${selection.keptByJudge} needed`);
	if (selection.keptUncertain) bases.push(`${selection.keptUncertain} uncertain`);
	if (selection.keptDuplicate) bases.push(`${selection.keptDuplicate} duplicate`);
	if (selection.keptProtected) bases.push(`${selection.keptProtected} protected`);
	if (selection.keptUnjudged) bases.push(`${selection.keptUnjudged} unjudged`);
	const detail = bases.length ? ` (${bases.join(", ")})` : "";
	const tail = selection.skipped ?? selection.distribution ?? "no judgment";
	return `kept ${kept} of ${selection.candidates}${detail}, elided ${selection.elided}, ${selection.calls} call${selection.calls === 1 ? "" : "s"}, ${selection.durationMs} ms, ${tail}`;
}
