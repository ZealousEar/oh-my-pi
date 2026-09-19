/**
 * Two-pass semantic ranking over locally derived passages.
 *
 * A `Choice` question's probabilities sum to 1, so *something* always ranks
 * first even when nothing answers the query. The independent `exists` noul is
 * therefore carried alongside the ranking and never folded into it — the
 * caller reports the two separately.
 *
 * A TypeSafe `Choice` accepts at most {@link MAX_CHOICE_OPTIONS} options, so
 * larger passage sets are windowed: every passage is scored exactly once in
 * pass one, and the per-window finalists are scored again in pass two so the
 * returned order comes from a single comparable distribution. Pass two is one
 * request, so each window may send at most `floor(windowSize / windows)`
 * finalists; anything the caller's `limit` would have admitted beyond that is
 * counted in `finalistsDropped` rather than silently crowded out by earlier
 * windows.
 */
import type { JudgmentState, NoulQuestion } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import {
	type ActionCandidate,
	type DecisionProvenance,
	decideAmongCandidates,
	type LoopMeter,
	MAX_CHOICE_OPTIONS,
	type ObservationIdentity,
} from "../../judgment/decision";
import type { ResolvedJudge } from "../../judgment";
import existsCriteriaTemplate from "../../prompts/system/semantic-find-exists-criteria.md" with { type: "text" };
import existsTemplate from "../../prompts/system/semantic-find-exists.md" with { type: "text" };
import selectTemplate from "../../prompts/system/semantic-find-select.md" with { type: "text" };
import type { Passage } from "./passages";

/** Passage text sent in the judgment state, per passage. Longer passages are elided in the middle. */
const STATE_TEXT_BUDGET = 1200;

/** Passage preview used as the choice option's rubric; the full text lives in the state. */
const OPTION_PREVIEW_BUDGET = 160;

/** `answerPresent` at or above this reads as a real answer in the selected sources. */
export const ANSWER_PRESENT_HIGH = 0.7;

/** Below this, the selected sources almost certainly do not contain the answer. */
export const ANSWER_PRESENT_LOW = 0.35;

export interface RankedPassage {
	passage: Passage;
	score: number;
}

export interface RankingOutcome {
	results: RankedPassage[];
	/** Independent probability that any selected passage answers the query. */
	answerPresent: number;
	windows: number;
	passes: number;
	/** Passages that entered at least one judgment request. */
	scored: number;
	/** First-pass finalists `limit` admitted but the per-window cap of pass two could not seat. */
	finalistsDropped: number;
	provenance: DecisionProvenance[];
}

function clip(text: string, budget: number): string {
	const collapsed = text.length <= budget ? text : `${text.slice(0, budget - 1)}…`;
	return collapsed;
}

function locationOf(passage: Passage): string {
	return `${passage.given}:${passage.startLine}-${passage.endLine}`;
}

function stateFor(query: string, passages: readonly Passage[]): JudgmentState {
	return {
		query,
		passages: passages.map(passage => ({
			id: passage.id,
			source: locationOf(passage),
			text: clip(passage.text, STATE_TEXT_BUDGET),
		})),
	};
}

function candidatesFor(passages: readonly Passage[]): ActionCandidate<Passage>[] {
	return passages.map(passage => ({
		id: passage.id,
		label: `${locationOf(passage)} — ${clip(passage.text.replace(/\s+/g, " ").trim(), OPTION_PREVIEW_BUDGET)}`,
		args: passage,
	}));
}

function existsQuestion(query: string): NoulQuestion {
	return {
		type: "noul",
		instructions: prompt.render(existsTemplate, { query }),
		criteria: {
			true: prompt.render(existsCriteriaTemplate, { yes: true }).trim(),
			false: prompt.render(existsCriteriaTemplate, { yes: false }).trim(),
		},
	};
}

/** Split passages into windows no larger than the judge's option cap. */
export function windowPassages(passages: readonly Passage[], windowSize: number): Passage[][] {
	const size = Math.max(1, Math.min(windowSize, MAX_CHOICE_OPTIONS));
	const windows: Passage[][] = [];
	for (let i = 0; i < passages.length; i += size) windows.push(passages.slice(i, i + size));
	return windows;
}

/** Identity of the passage set a ranking was computed against. */
export function observationOf(passages: readonly Passage[]): ObservationIdentity {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const passage of passages) hasher.update(`${passage.resolved}:${passage.startLine}:${passage.endLine}\n`);
	const sources = new Set(passages.map(passage => passage.resolved));
	return {
		surface: "passages",
		scope: Array.from(sources).sort().join(" "),
		revision: passages.length,
		capturedAt: Date.now(),
		digest: hasher.digest("hex").slice(0, 16),
	};
}

async function scoreWindow(options: {
	judge: ResolvedJudge;
	meter: LoopMeter;
	query: string;
	passages: readonly Passage[];
	callTimeoutMs: number;
	signal?: AbortSignal;
}): Promise<{ scores: Map<string, number>; exists: number }> {
	options.meter.checkpoint("action");
	const decision = await decideAmongCandidates(
		options.judge,
		options.meter,
		{
			state: stateFor(options.query, options.passages),
			instructions: prompt.render(selectTemplate, { query: options.query }),
			candidates: candidatesFor(options.passages),
			extras: { nouls: { exists: existsQuestion(options.query) } },
		},
		{ callTimeoutMs: options.callTimeoutMs, signal: options.signal },
	);
	options.meter.actions++;
	const scores = new Map<string, number>();
	for (const entry of decision.ranking) scores.set(entry.id, entry.probability);
	return { scores, exists: decision.nouls.exists?.noul ?? 0 };
}

/**
 * Rank every passage, then re-rank the finalists when more than one window was
 * needed. Pass-one probabilities are only comparable inside their own window,
 * so a multi-window run always spends one extra call to put the finalists on a
 * single scale. Every window seats the same number of finalists in that call.
 */
export async function rankPassages(options: {
	judge: ResolvedJudge;
	meter: LoopMeter;
	query: string;
	passages: readonly Passage[];
	windowSize: number;
	limit: number;
	callTimeoutMs: number;
	signal?: AbortSignal;
}): Promise<RankingOutcome> {
	const windows = windowPassages(options.passages, options.windowSize);
	const byId = new Map(options.passages.map(passage => [passage.id, passage]));
	let answerPresent = 0;
	const finalists: Passage[] = [];
	const firstPassScores = new Map<string, number>();
	const capacity = Math.min(options.windowSize, MAX_CHOICE_OPTIONS);
	const perWindow = windows.length > 1 ? Math.max(1, Math.floor(capacity / windows.length)) : options.limit;
	let finalistsDropped = 0;

	for (const window of windows) {
		const { scores, exists } = await scoreWindow({
			judge: options.judge,
			meter: options.meter,
			query: options.query,
			passages: window,
			callTimeoutMs: options.callTimeoutMs,
			signal: options.signal,
		});
		answerPresent = Math.max(answerPresent, exists);
		const ordered = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
		for (const [id, score] of ordered) firstPassScores.set(id, score);
		const admitted = Math.min(options.limit, ordered.length);
		finalistsDropped += Math.max(0, admitted - perWindow);
		for (const [id] of ordered.slice(0, Math.min(admitted, perWindow))) {
			const passage = byId.get(id);
			if (passage) finalists.push(passage);
		}
	}
	// More windows than the window can seat is a degenerate configuration
	// (windowSize² < passages): the hard option cap still wins, and the
	// unseated finalists are reported rather than silently dropped.
	if (finalists.length > MAX_CHOICE_OPTIONS) {
		finalistsDropped += finalists.length - MAX_CHOICE_OPTIONS;
		finalists.length = MAX_CHOICE_OPTIONS;
	}

	let passes = 1;
	let finalScores = firstPassScores;
	if (windows.length > 1 && finalists.length > 1) {
		const { scores, exists } = await scoreWindow({
			judge: options.judge,
			meter: options.meter,
			query: options.query,
			passages: finalists,
			callTimeoutMs: options.callTimeoutMs,
			signal: options.signal,
		});
		answerPresent = Math.max(answerPresent, exists);
		finalScores = scores;
		passes = 2;
	}

	const pool = passes === 2 ? finalists : options.passages;
	const results = pool
		.map(passage => ({ passage, score: finalScores.get(passage.id) ?? 0 }))
		.sort((a, b) => b.score - a.score || a.passage.id.localeCompare(b.passage.id))
		.slice(0, options.limit);

	return {
		results,
		answerPresent,
		windows: windows.length,
		passes,
		scored: options.passages.length,
		finalistsDropped,
		provenance: options.meter.attempts.slice(),
	};
}
