/**
 * Two-pass semantic ranking over locally derived excerpts (bounded `find`).
 *
 * A `Choice` question's probabilities sum to 1, so *something* always ranks
 * first even when nothing answers the query. The independent `exists` noul is
 * therefore carried alongside the ranking and never folded into it — the
 * caller reports the two separately.
 *
 * A native `Choice` accepts at most {@link MAX_CHOICE_OPTIONS} options, so
 * larger excerpt sets are windowed: every excerpt is scored exactly once in
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
	type DecisionJudge,
	type DecisionProvenance,
	decideAmongCandidates,
	type LoopMeter,
	MAX_CHOICE_OPTIONS,
	type ObservationIdentity,
} from "../../judgment/decision";
import existsCriteriaTemplate from "../../prompts/tools/find-exists-criteria.md" with { type: "text" };
import existsTemplate from "../../prompts/tools/find-exists-question.md" with { type: "text" };
import selectTemplate from "../../prompts/tools/find-select-question.md" with { type: "text" };
import type { Excerpt } from "./excerpts";

/** Excerpt text sent in the judgment state, per excerpt. Longer excerpts are cut with an ellipsis. */
const STATE_TEXT_BUDGET = 1200;

/** Excerpt preview used as the choice option's rubric; the full text lives in the state. */
const OPTION_PREVIEW_BUDGET = 160;

/** `answerPresent` at or above this reads as a real answer in the selected sources. */
export const ANSWER_PRESENT_HIGH = 0.7;

/** Below this, the selected sources almost certainly do not contain the answer. */
export const ANSWER_PRESENT_LOW = 0.35;

export interface RankedExcerpt {
	excerpt: Excerpt;
	score: number;
}

export interface RankingOutcome {
	results: RankedExcerpt[];
	/** Independent probability that any selected excerpt answers the query. */
	answerPresent: number;
	windows: number;
	passes: number;
	/** Excerpts that entered at least one judgment request. */
	scored: number;
	/** First-pass finalists `limit` admitted but the per-window cap of pass two could not seat. */
	finalistsDropped: number;
	provenance: DecisionProvenance[];
}

function clip(text: string, budget: number): string {
	return text.length <= budget ? text : `${text.slice(0, budget - 1)}…`;
}

function stateFor(query: string, excerpts: readonly Excerpt[]): JudgmentState {
	return {
		query,
		passages: excerpts.map(excerpt => ({
			id: excerpt.id,
			source: `${excerpt.given}:${excerpt.startLine}-${excerpt.endLine}`,
			text: clip(excerpt.text, STATE_TEXT_BUDGET),
		})),
	};
}

function candidatesFor(excerpts: readonly Excerpt[]): ActionCandidate<Excerpt>[] {
	return excerpts.map(excerpt => ({
		id: excerpt.id,
		label: `${excerpt.given}:${excerpt.startLine}-${excerpt.endLine} — ${clip(excerpt.text.replace(/\s+/g, " ").trim(), OPTION_PREVIEW_BUDGET)}`,
		args: excerpt,
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

/** Split excerpts into windows no larger than the judge's option cap. */
export function windowExcerpts(excerpts: readonly Excerpt[], windowSize: number): Excerpt[][] {
	const size = Math.max(1, Math.min(windowSize, MAX_CHOICE_OPTIONS));
	const windows: Excerpt[][] = [];
	for (let i = 0; i < excerpts.length; i += size) windows.push(excerpts.slice(i, i + size));
	return windows;
}

/** Identity of the excerpt set a ranking was computed against. */
export function observationOf(excerpts: readonly Excerpt[]): ObservationIdentity {
	const hasher = new Bun.CryptoHasher("sha256");
	const sources = new Set<string>();
	for (const excerpt of excerpts) {
		hasher.update(`${excerpt.resolved}:${excerpt.startLine}:${excerpt.endLine}\n`);
		sources.add(excerpt.resolved);
	}
	return {
		surface: "passages",
		scope: Array.from(sources).sort().join(" "),
		revision: excerpts.length,
		capturedAt: Date.now(),
		digest: hasher.digest("hex").slice(0, 16),
	};
}

async function scoreWindow(options: {
	judge: DecisionJudge;
	meter: LoopMeter;
	query: string;
	excerpts: readonly Excerpt[];
	callTimeoutMs: number;
	signal?: AbortSignal;
}): Promise<{ scores: Map<string, number>; exists: number }> {
	options.meter.checkpoint("action");
	const decision = await decideAmongCandidates(
		options.judge,
		options.meter,
		{
			state: stateFor(options.query, options.excerpts),
			instructions: prompt.render(selectTemplate, { query: options.query }),
			candidates: candidatesFor(options.excerpts),
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
 * Rank every excerpt, then re-rank the finalists when more than one window was
 * needed. Pass-one probabilities are only comparable inside their own window,
 * so a multi-window run always spends one extra call to put the finalists on a
 * single scale. Every window seats the same number of finalists in that call.
 */
export async function rankExcerpts(options: {
	judge: DecisionJudge;
	meter: LoopMeter;
	query: string;
	excerpts: readonly Excerpt[];
	windowSize: number;
	limit: number;
	callTimeoutMs: number;
	signal?: AbortSignal;
}): Promise<RankingOutcome> {
	const windows = windowExcerpts(options.excerpts, options.windowSize);
	const byId = new Map(options.excerpts.map(excerpt => [excerpt.id, excerpt]));
	let answerPresent = 0;
	const finalists: Excerpt[] = [];
	const firstPassScores = new Map<string, number>();
	const capacity = Math.min(options.windowSize, MAX_CHOICE_OPTIONS);
	const perWindow = windows.length > 1 ? Math.max(1, Math.floor(capacity / windows.length)) : options.limit;
	let finalistsDropped = 0;

	for (const window of windows) {
		const { scores, exists } = await scoreWindow({
			judge: options.judge,
			meter: options.meter,
			query: options.query,
			excerpts: window,
			callTimeoutMs: options.callTimeoutMs,
			signal: options.signal,
		});
		answerPresent = Math.max(answerPresent, exists);
		const ordered = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
		for (const [id, score] of ordered) firstPassScores.set(id, score);
		const admitted = Math.min(options.limit, ordered.length);
		finalistsDropped += Math.max(0, admitted - perWindow);
		for (const [id] of ordered.slice(0, Math.min(admitted, perWindow))) {
			const excerpt = byId.get(id);
			if (excerpt) finalists.push(excerpt);
		}
	}
	// More windows than the window can seat is a degenerate configuration
	// (windowSize² < excerpts): the hard option cap still wins, and the
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
			excerpts: finalists,
			callTimeoutMs: options.callTimeoutMs,
			signal: options.signal,
		});
		answerPresent = Math.max(answerPresent, exists);
		finalScores = scores;
		passes = 2;
	}

	const pool = passes === 2 ? finalists : options.excerpts;
	const results = pool
		.map(excerpt => ({ excerpt, score: finalScores.get(excerpt.id) ?? 0 }))
		.sort((a, b) => b.score - a.score || a.excerpt.id.localeCompare(b.excerpt.id))
		.slice(0, options.limit);

	return {
		results,
		answerPresent,
		windows: windows.length,
		passes,
		scored: options.excerpts.length,
		finalistsDropped,
		provenance: options.meter.attempts.slice(),
	};
}
