/**
 * Native skill recommendation.
 *
 * Ranks the session's enabled, non-hidden skill catalog against one task
 * description. The catalog is derived locally; the judge only ever answers
 * with candidate ids it was handed ({@link ActionCandidate}), so a hallucinated
 * or stale id is a backend error rather than a recommendation.
 *
 * Composition follows the TypeSafe skill-suggestion cookbook: one `Choice`
 * per window ranks the skills relatively (its probabilities are the ranking)
 * beside an independent `any_applicable` gate; then one further request asks
 * an absolute `fits` noul per finalist, because a `Choice` settles *which*
 * skill while each noul can be low for every skill.
 *
 * Bounds and honesty rules:
 *  - A catalog larger than `skills.recommend.maxCandidatesPerRequest` is split
 *    into near-equal windows and *every* window is scored (one metered
 *    judgment call each). A subset is never silently ranked, and no window is
 *    left with a single real option, whose probability would be 1 by
 *    construction.
 *  - Every window also offers a `none` option ("no listed skill applies") so
 *    the judge can decline; `none` contributes no relevance to any skill.
 *  - The finalists (the ranked skills the caller's `limit` admits) each get
 *    their own `fits` noul in one extra request; a finalist set whose best
 *    `fits` is under {@link FITS_NO_MATCH} is reported as no match.
 *  - Results are cached per (task, catalog digest, judgment config, limit,
 *    explicit names). The catalog digest also drives a monotonic generation: a
 *    request whose generation is no longer current is rejected, not cached,
 *    and reported as `stale` so the caller can re-run once.
 *  - When the judge cannot be resolved, fails, or the loop budget is spent,
 *    the module degrades to a deterministic lexical overlap search and says so
 *    (`mode: "search"` plus a fallback reason).
 *  - Skill descriptions are untrusted text from skill files: what the judge
 *    sees is NFKC-normalised, control-stripped, and capped at
 *    {@link JUDGE_DESCRIPTION_CHARS} characters.
 */
import type { JudgmentState, NoulQuestion, Questions } from "@oh-my-pi/pi-ai";
import { logger, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import {
	type ActionCandidate,
	decideAmongCandidates,
	type DecisionProvenance,
	type ExecutionOutcome,
	judgeWithMeter,
	LoopBudgetExceeded,
	LoopMeter,
	MAX_CHOICE_OPTIONS,
	type ObservationIdentity,
	type VerificationEvidence,
} from "../judgment/decision";
import type { JudgmentUsage, ResolvedJudge } from "../judgment/index";
import applicableInstructions from "../prompts/system/skill-recommend-applicable.md" with { type: "text" };
import fitsCriteriaTemplate from "../prompts/system/skill-recommend-fits-criteria.md" with { type: "text" };
import fitsTemplate from "../prompts/system/skill-recommend-fits.md" with { type: "text" };
import selectInstructions from "../prompts/system/skill-recommend-select.md" with { type: "text" };
import type { Skill } from "./skills";

/** Noul id answered alongside the per-window selection. */
const APPLICABLE = "any_applicable";

/** Prefix of the per-finalist absolute applicability nouls. */
const FITS_PREFIX = "fits_";

/**
 * Best per-finalist `fits` below which the catalog is reported as having no
 * match (the cookbook's `FITS_THRESHOLD`).
 */
const FITS_NO_MATCH = 0.3;

/** Choice option letting the judge decline every skill in the window. */
const NONE_ID = "none";
const NONE_RUBRIC = "no listed skill applies";

/** Catalog index carried by the `none` candidate; never a real skill. */
const NONE_INDEX = -1;

/**
 * Fewest real skills a window may hold: a lone option's probability is 1 by
 * construction, which would let a remainder window outrank every full one.
 */
const MIN_WINDOW_SKILLS = 2;

/**
 * Smallest usable `maxCandidatesPerRequest`: balancing a catalog into windows
 * of at most this size always leaves every window with at least
 * {@link MIN_WINDOW_SKILLS} skills.
 */
const MIN_WINDOW_SIZE = 2 * MIN_WINDOW_SKILLS - 1;

/** Longest description (after normalisation) sent to the judge for one skill. */
export const JUDGE_DESCRIPTION_CHARS = 300;

/**
 * `any_applicable` at or above which the window's top skill is surfaced even
 * when its own probability sits under `minRelevance`.
 */
const APPLICABLE_KEEP_TOP = 0.5;

/** Window-level `any_applicable` below which the catalog is reported as having no match. */
const APPLICABLE_NO_MATCH = 0.35;

/**
 * Wording carried into the tool output verbatim: the no-match verdict is a
 * threshold on a relevance signal, not a calibrated correctness claim.
 */
export const NO_MATCH_CAVEAT = "This is a heuristic threshold on a relevance signal, not calibrated correctness.";

/** Per-call judgment timeout; the meter clamps it to the loop deadline. */
const CALL_TIMEOUT_MS = 12_000;

/** Total wall-clock budget for one recommendation, under the 20s tool timeout. */
const DEFAULT_DEADLINE_MS = 16_000;

/** `/skill:name` invocation tokens. */
const SKILL_COMMAND_RE = /\/skill:([A-Za-z0-9][\w.-]*)/g;

/** `skill://name` internal URLs. */
const SKILL_URL_RE = /skill:\/\/([A-Za-z0-9][\w.-]*)/g;

/** Word-ish runs used both for explicit name tokens and lexical scoring. */
const TOKEN_RE = /[A-Za-z0-9]+/g;

/** Lexical fallback weights: a task term hitting the skill name beats one hitting its description. */
const NAME_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 1;

/** Terms carrying no discriminative signal in the lexical fallback. */
const STOP_WORDS = new Set([
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"can",
	"do",
	"for",
	"from",
	"how",
	"in",
	"into",
	"is",
	"it",
	"me",
	"my",
	"of",
	"on",
	"or",
	"please",
	"that",
	"the",
	"then",
	"this",
	"to",
	"use",
	"using",
	"with",
]);

export interface SkillRecommendConfig {
	enabled: boolean;
	/** Skills sent in one judgment request; clamped to `[3, MAX_CHOICE_OPTIONS - 1]` (the `none` option takes one slot). */
	maxCandidatesPerRequest: number;
	/** Minimum selection probability a skill needs to be reported. */
	minRelevance: number;
	/** LRU capacity of the per-recommender result cache. */
	cacheEntries: number;
}

/** Read `skills.recommend.*` into a validated, clamped config. */
export function readSkillRecommendConfig(settings: Settings): SkillRecommendConfig {
	return {
		enabled: settings.get("skills.recommend.enabled"),
		maxCandidatesPerRequest: clampWindowSize(settings.get("skills.recommend.maxCandidatesPerRequest")),
		minRelevance: Math.max(0, Math.min(1, settings.get("skills.recommend.minRelevance"))),
		cacheEntries: Math.max(1, Math.trunc(settings.get("skills.recommend.cacheEntries"))),
	};
}

/** Window size the recommender actually uses; the `none` option occupies one choice slot. */
function clampWindowSize(value: number): number {
	return Math.max(MIN_WINDOW_SIZE, Math.min(MAX_CHOICE_OPTIONS - 1, Math.trunc(value)));
}

/**
 * Judge-facing form of untrusted skill text: NFKC-normalised so look-alike
 * glyphs cannot smuggle a different reading, ANSI/control characters removed,
 * and capped so one description cannot dominate the request.
 */
export function judgeDescription(text: string): string {
	const clean = sanitizeText(text.normalize("NFKC")).replace(/\s+/g, " ").trim();
	return clean.length <= JUDGE_DESCRIPTION_CHARS ? clean : `${clean.slice(0, JUDGE_DESCRIPTION_CHARS - 1)}…`;
}

export interface SkillRecommendRequest {
	task: string;
	/** Maximum ranked (non-explicit) skills to return. */
	limit?: number;
	/** Enabled, non-hidden skills to rank. */
	catalog: readonly Skill[];
	/** Skill names the caller mandates; always returned, never scored away. */
	explicit?: string[];
}

export interface SkillRecommendation {
	name: string;
	description: string;
	filePath: string;
	/** Selection probability within the skill's window, or the lexical overlap score. */
	relevance: number;
	/** `any_applicable` for the window the skill was scored in; 1 for explicit/lexical entries. */
	windowApplicable: number;
	/** The skill's own absolute `fits` noul, answered independently of the other skills; 1 for explicit/lexical entries. */
	applicable: number;
	/** Why the skill is in the list. */
	reason: "explicit" | "semantic" | "search";
}

export interface SkillRecommendResult {
	recommendations: SkillRecommendation[];
	/** `semantic` = judge-scored; `search` = deterministic lexical fallback. */
	mode: "semantic" | "search";
	/** Why the semantic path was not used. */
	fallbackReason?: string;
	/** Highest `any_applicable` across windows; `undefined` in search mode. */
	anyApplicable?: number;
	/** Whether the judge signalled that nothing in the catalog materially applies. */
	noMatch: boolean;
	/** Caveat that must be shown with {@link noMatch}. */
	noMatchCaveat: string;
	/** The catalog changed under the request; the result was discarded, not cached. */
	stale: boolean;
	cacheHit: boolean;
	/** Judgment requests the catalog was split across (1 when it fits). */
	windows: number;
	catalogSize: number;
	/** Explicit names that matched nothing in the catalog. */
	unmatchedExplicit: string[];
	observation: ObservationIdentity;
	outcome: ExecutionOutcome;
	verification: VerificationEvidence;
	/** Every judgment attempt, failed calls included. */
	attempts: DecisionProvenance[];
	usage: { calls: number; input: number; output: number; costUsd: number | "unknown" };
	durationMs: number;
}

/** Per-request hooks handed to the judge factory; nothing here outlives one `recommend` call. */
export interface JudgeHooks {
	/** Receives the usage of every judgment attempt made for this request. */
	onUsage?: (usage: JudgmentUsage) => void;
}

export interface SkillRecommenderDeps {
	config: SkillRecommendConfig;
	/**
	 * Resolves the judge for one request. Throwing here (no registry, no
	 * credential) is a normal outcome and routes to the lexical fallback.
	 */
	judge: (hooks: JudgeHooks) => ResolvedJudge;
	/** Digest of the judgment configuration; participates in the cache key. */
	judgmentDigest: string;
}

export interface RecommendOptions extends JudgeHooks {
	signal?: AbortSignal;
	/** Wall-clock budget override, mainly for tests. */
	deadlineMs?: number;
}

interface CandidateArgs {
	/** Index into the caller's catalog array, or {@link NONE_INDEX} for the decline option. */
	index: number;
}

interface CatalogWindow {
	skills: readonly Skill[];
	/** Catalog index of `skills[0]`. */
	offset: number;
}

interface CatalogScores {
	/** Catalog index -> selection probability inside its window. */
	probability: Map<number, number>;
	/** Catalog index -> its window's `any_applicable`. */
	applicable: Map<number, number>;
	anyApplicable: number;
	windows: number;
	/** Catalog index -> its own `fits` noul; only finalists are asked. */
	fits: Map<number, number>;
	/** Highest `fits` among the finalists; 0 when there was none to ask about. */
	maxFits: number;
}

/** One ranked (non-explicit) semantic entry before it becomes a recommendation. */
interface RankedIndex {
	index: number;
	relevance: number;
	windowApplicable: number;
}

/**
 * Sanitize skill names into decision-safe candidate ids, keeping a stable
 * id/name ordering. Ids must satisfy the decision module's
 * `/^[A-Za-z][A-Za-z0-9_-]{0,31}$/`; collisions take a numeric suffix.
 */
export function buildCandidateIds(names: readonly string[]): string[] {
	const used = new Set<string>();
	const ids: string[] = [];
	for (const name of names) {
		let base = name.replaceAll(/[^A-Za-z0-9_-]/g, "_");
		if (!/^[A-Za-z]/.test(base)) base = `s_${base}`;
		base = base.slice(0, 32);
		let id = base;
		for (let n = 2; used.has(id); n++) {
			const suffix = `_${n}`;
			id = `${base.slice(0, 32 - suffix.length)}${suffix}`;
		}
		used.add(id);
		ids.push(id);
	}
	return ids;
}

/** Stable content digest of a catalog: identity is name + description + backing file. */
export function catalogDigest(catalog: readonly Skill[]): string {
	let joined = "";
	for (const skill of catalog) joined += `${skill.name}\u0000${skill.description}\u0000${skill.filePath}\u0001`;
	return `${catalog.length}:${Bun.hash(joined).toString(36)}`;
}

/** Lowercase, de-noised term runs; shared by explicit-name matching and lexical scoring. */
function tokenize(text: string): string[] {
	const tokens: string[] = [];
	TOKEN_RE.lastIndex = 0;
	for (let match = TOKEN_RE.exec(text); match !== null; match = TOKEN_RE.exec(text)) {
		const token = match[0].toLowerCase();
		if (token.length > 1 && !STOP_WORDS.has(token)) tokens.push(token);
	}
	return tokens;
}

/** Names the task mandates: `/skill:name`, `skill://name`, or an exact name token. */
export function parseExplicitSkillNames(task: string, catalog: readonly Skill[]): string[] {
	const found = new Set<string>();
	for (const pattern of [SKILL_COMMAND_RE, SKILL_URL_RE]) {
		pattern.lastIndex = 0;
		for (let match = pattern.exec(task); match !== null; match = pattern.exec(task)) found.add(match[1]);
	}
	// Exact whole-name mention only: a name must survive as one token run, so an
	// unrelated substring can never claim a skill.
	const byLower = new Map<string, string>();
	for (const skill of catalog) byLower.set(skill.name.toLowerCase(), skill.name);
	for (const word of task.toLowerCase().split(/[^A-Za-z0-9._/-]+/)) {
		const hit = byLower.get(word);
		if (hit) found.add(hit);
	}
	return [...found];
}

/** Deterministic weighted-overlap scoring used when no judge is available. */
export function lexicalScores(task: string, catalog: readonly Skill[]): number[] {
	const terms = tokenize(task);
	if (terms.length === 0) return catalog.map(() => 0);
	const max = terms.length * NAME_WEIGHT;
	return catalog.map(skill => {
		const nameTokens = new Set(tokenize(skill.name));
		const descriptionTokens = new Set(tokenize(skill.description));
		let score = 0;
		for (const term of terms) {
			if (nameTokens.has(term)) score += NAME_WEIGHT;
			else if (descriptionTokens.has(term)) score += DESCRIPTION_WEIGHT;
		}
		return score / max;
	});
}

/** Ranks a skill catalog against a task, cached per catalog generation. */
export class SkillRecommender {
	readonly #deps: SkillRecommenderDeps;
	readonly #cache = new Map<string, CatalogScores>();
	#digest: string | undefined;
	#generation = 0;

	constructor(deps: SkillRecommenderDeps) {
		this.#deps = deps;
	}

	/** Current catalog generation; bumped whenever a call observes a new digest. */
	get generation(): number {
		return this.#generation;
	}

	async recommend(request: SkillRecommendRequest, options: RecommendOptions = {}): Promise<SkillRecommendResult> {
		const startedAt = Date.now();
		const task = request.task.trim();
		if (task.length === 0) throw new Error("recommend: task must not be empty");
		const catalog = request.catalog.filter(skill => skill.hide !== true);
		const limit = Math.max(1, Math.trunc(request.limit ?? 5));
		const digest = catalogDigest(catalog);
		const generation = this.#syncGeneration(digest);
		const observation: ObservationIdentity = {
			surface: "skill-catalog",
			scope: "session",
			revision: generation,
			capturedAt: startedAt,
			digest,
		};

		const explicitNames = new Set<string>(parseExplicitSkillNames(task, catalog));
		for (const name of request.explicit ?? []) explicitNames.add(name);
		const byLower = new Map<string, Skill>();
		for (const skill of catalog) byLower.set(skill.name.toLowerCase(), skill);
		const explicit: Skill[] = [];
		const unmatchedExplicit: string[] = [];
		for (const name of explicitNames) {
			const skill = byLower.get(name.trim().toLowerCase());
			if (skill) explicit.push(skill);
			else unmatchedExplicit.push(name);
		}
		explicit.sort((a, b) => a.name.localeCompare(b.name));
		const common = { task, catalog, explicit, unmatchedExplicit, limit, observation, startedAt };

		if (catalog.length === 0) {
			return this.#finish({
				...common,
				scores: undefined,
				mode: "search",
				fallbackReason: "the enabled skill catalog is empty",
				attempts: [],
				meter: undefined,
				cacheHit: false,
			});
		}

		// The finalists asked about in the `fits` request depend on `limit` and on
		// which skills were explicit, so both are part of the identity.
		const cacheKey = Bun.hash(
			`${task}\u0000${digest}\u0000${this.#deps.judgmentDigest}\u0000${limit}\u0000${explicit.map(skill => skill.name).join("\u0001")}`,
		).toString(36);
		const cached = this.#cache.get(cacheKey);
		if (cached) {
			// Refresh LRU recency.
			this.#cache.delete(cacheKey);
			this.#cache.set(cacheKey, cached);
			return this.#finish({
				...common,
				scores: cached,
				mode: "semantic",
				attempts: [],
				meter: undefined,
				cacheHit: true,
			});
		}

		const windows = chunkCatalog(catalog, clampWindowSize(this.#deps.config.maxCandidatesPerRequest));
		// One call per window, plus the `fits` request over the finalists.
		const meter = new LoopMeter({
			maxCalls: windows.length + 1,
			maxActions: windows.length + 1,
			deadlineAt: startedAt + (options.deadlineMs ?? DEFAULT_DEADLINE_MS),
			signal: options.signal,
		});
		let judge: ResolvedJudge;
		try {
			judge = this.#deps.judge({ onUsage: options.onUsage });
		} catch (error) {
			return this.#finish({
				...common,
				scores: undefined,
				mode: "search",
				fallbackReason: `judge unavailable: ${error instanceof Error ? error.message : String(error)}`,
				attempts: meter.attempts,
				meter,
				cacheHit: false,
			});
		}

		let scores: CatalogScores;
		try {
			scores = await this.#score(judge, meter, task, catalog, windows, options.signal);
			// The finalists are known only once every window has answered, so their
			// absolute `fits` nouls are a second request by necessity; a catalog the
			// window gate already rejected is not asked about again.
			if (scores.anyApplicable >= APPLICABLE_NO_MATCH) {
				const isExplicit = new Set(explicit.map(skill => skill.name));
				const finalists = this.#rankSemantic(catalog, scores, isExplicit)
					.slice(0, limit)
					.map(entry => entry.index);
				await this.#fits(judge, meter, task, catalog, finalists, scores, options.signal);
			}
		} catch (error) {
			if (options.signal?.aborted) throw error;
			const reason =
				error instanceof LoopBudgetExceeded
					? `judgment budget spent (${error.limit})`
					: `judgment failed: ${error instanceof Error ? error.message : String(error)}`;
			logger.debug("skill-recommend: semantic scoring failed; using lexical fallback", {
				reason,
				windows: windows.length,
			});
			return this.#finish({
				...common,
				scores: undefined,
				mode: "search",
				fallbackReason: reason,
				attempts: meter.attempts,
				meter,
				cacheHit: false,
			});
		}

		// The catalog moved while the request was in flight: the selections were
		// made against a revision that no longer exists. Discard without caching.
		if (this.#generation !== generation) {
			return {
				recommendations: [],
				mode: "semantic",
				anyApplicable: scores.anyApplicable,
				noMatch: false,
				noMatchCaveat: NO_MATCH_CAVEAT,
				stale: true,
				cacheHit: false,
				windows: scores.windows,
				catalogSize: catalog.length,
				unmatchedExplicit,
				observation,
				outcome: {
					status: "stale",
					reason: `skill catalog changed during scoring (revision ${generation} -> ${this.#generation})`,
					observed: { ...observation, revision: this.#generation, capturedAt: Date.now() },
				},
				verification: {
					verified: "unknown",
					method: "catalog-reresolve",
					observation,
					detail: "catalog revision advanced before the selections could be reconciled",
				},
				attempts: meter.attempts,
				usage: meter.totalUsage(),
				durationMs: Date.now() - startedAt,
			};
		}

		if (this.#cache.size >= this.#deps.config.cacheEntries) {
			const oldest = this.#cache.keys().next();
			if (!oldest.done) this.#cache.delete(oldest.value);
		}
		this.#cache.set(cacheKey, scores);
		return this.#finish({ ...common, scores, mode: "semantic", attempts: meter.attempts, meter, cacheHit: false });
	}

	/** Bump the generation when the observed catalog digest differs from the last one. */
	#syncGeneration(digest: string): number {
		if (this.#digest !== digest) {
			this.#digest = digest;
			this.#generation++;
		}
		return this.#generation;
	}

	/** Score every window; a window failure fails the whole semantic path. */
	async #score(
		judge: ResolvedJudge,
		meter: LoopMeter,
		task: string,
		catalog: readonly Skill[],
		windows: readonly CatalogWindow[],
		signal: AbortSignal | undefined,
	): Promise<CatalogScores> {
		const probability = new Map<number, number>();
		const applicable = new Map<number, number>();
		let anyApplicable = 0;
		for (const window of windows) {
			// Balanced windowing guarantees this; a lone option would score 1 by construction.
			if (windows.length > 1 && window.skills.length < MIN_WINDOW_SKILLS) {
				throw new Error(`recommend: window of ${window.skills.length} skill(s) violates the balancing invariant`);
			}
			// `none` is reserved first so a skill literally named "none" takes a suffix.
			const [noneId, ...ids] = buildCandidateIds([NONE_ID, ...window.skills.map(skill => skill.name)]);
			const candidates: ActionCandidate<CandidateArgs>[] = window.skills.map((skill, index) => ({
				id: ids[index],
				label: judgeDescription(skill.name),
				args: { index: window.offset + index },
				rubric: judgeDescription(skill.description),
			}));
			candidates.push({ id: noneId, label: NONE_RUBRIC, args: { index: NONE_INDEX }, rubric: NONE_RUBRIC });
			const decision = await decideAmongCandidates(
				judge,
				meter,
				{
					state: {
						task,
						skills: window.skills.map((skill, index) => ({
							id: ids[index],
							name: judgeDescription(skill.name),
							description: judgeDescription(skill.description),
						})),
						none: { id: noneId, meaning: NONE_RUBRIC },
					},
					instructions: selectInstructions,
					candidates,
					extras: { nouls: { [APPLICABLE]: { type: "noul", instructions: applicableInstructions } } },
				},
				{ signal, callTimeoutMs: CALL_TIMEOUT_MS },
			);
			meter.checkpoint("action");
			meter.actions++;
			const indexById = new Map(candidates.map(candidate => [candidate.id, candidate.args.index]));
			const windowApplicable = decision.nouls[APPLICABLE]?.noul ?? 0;
			anyApplicable = Math.max(anyApplicable, windowApplicable);
			for (const entry of decision.ranking) {
				const index = indexById.get(entry.id);
				// An id outside the local table is a backend error, not a recommendation.
				if (index === undefined) throw new Error(`recommend: backend ranked unknown candidate "${entry.id}"`);
				// Mass on `none` is a decline: it lifts no skill.
				if (index === NONE_INDEX) continue;
				probability.set(index, entry.probability);
				applicable.set(index, windowApplicable);
			}
		}
		if (probability.size !== catalog.length) {
			throw new Error(`recommend: scored ${probability.size} of ${catalog.length} skills`);
		}
		return { probability, applicable, anyApplicable, windows: windows.length, fits: new Map(), maxFits: 0 };
	}

	/**
	 * Ask one absolute `fits` noul per finalist in a single request. Each is
	 * answered on its own, so every finalist can come back low; the best one
	 * gates the no-match verdict. Nothing to ask about is not a call.
	 */
	async #fits(
		judge: ResolvedJudge,
		meter: LoopMeter,
		task: string,
		catalog: readonly Skill[],
		finalists: readonly number[],
		scores: CatalogScores,
		signal: AbortSignal | undefined,
	): Promise<void> {
		if (finalists.length === 0) return;
		const skills = finalists.map(index => catalog[index]);
		const ids = buildCandidateIds(skills.map(skill => skill.name));
		const state: JudgmentState = {
			task,
			skills: skills.map((skill, position) => ({
				id: ids[position],
				name: judgeDescription(skill.name),
				description: judgeDescription(skill.description),
			})),
		};
		const questions: Questions = {};
		for (const [position, skill] of skills.entries()) {
			const context = { name: judgeDescription(skill.name), index: position };
			const question: NoulQuestion = {
				type: "noul",
				instructions: prompt.render(fitsTemplate, context),
				criteria: {
					true: prompt.render(fitsCriteriaTemplate, { ...context, yes: true }).trim(),
					false: prompt.render(fitsCriteriaTemplate, { ...context, yes: false }).trim(),
				},
			};
			questions[FITS_PREFIX + ids[position]] = question;
		}
		const { result } = await judgeWithMeter(
			judge,
			meter,
			{ state, questions },
			{ signal, callTimeoutMs: CALL_TIMEOUT_MS },
		);
		meter.checkpoint("action");
		meter.actions++;
		for (const [position, index] of finalists.entries()) {
			const answer = result.answers[FITS_PREFIX + ids[position]];
			if (answer?.type !== "noul")
				throw new Error(`recommend: backend did not answer fits for "${skills[position].name}"`);
			scores.fits.set(index, answer.noul);
			scores.maxFits = Math.max(scores.maxFits, answer.noul);
		}
	}

	/**
	 * The ranked (non-explicit) semantic entries in delivery order. The single
	 * strongest skill survives `minRelevance` whenever the judge says something
	 * in the catalog does apply: a one-hot chat distribution puts all mass on
	 * one id, so a strict filter would still keep it, while a flat native
	 * distribution would otherwise drop every candidate. A window that chose
	 * `none` leaves no mass to keep.
	 */
	#rankSemantic(catalog: readonly Skill[], scores: CatalogScores, isExplicit: ReadonlySet<string>): RankedIndex[] {
		const keepTop = scores.anyApplicable >= APPLICABLE_KEEP_TOP;
		let topIndex = -1;
		let topScore = 0;
		for (const [index, value] of scores.probability) {
			const combined = value * (scores.applicable.get(index) ?? 0);
			if (combined > topScore) {
				topScore = combined;
				topIndex = index;
			}
		}
		const ranked: RankedIndex[] = [];
		for (const [index, value] of scores.probability) {
			if (isExplicit.has(catalog[index].name)) continue;
			if (value <= 0) continue;
			if (value < this.#deps.config.minRelevance && !(keepTop && index === topIndex)) continue;
			ranked.push({ index, relevance: value, windowApplicable: scores.applicable.get(index) ?? 0 });
		}
		// Every window holds at least two real options plus `none`, so each
		// probability is a genuine share of its window; cross-window ordering
		// uses that share x the window's applicability. The per-skill `fits`
		// noul is an absolute signal reported beside it, never folded into the
		// relative ordering.
		ranked.sort(
			(a, b) =>
				b.relevance * b.windowApplicable - a.relevance * a.windowApplicable ||
				catalog[a.index].name.localeCompare(catalog[b.index].name),
		);
		return ranked;
	}

	/** Assemble the delivered result from explicit picks plus scores (semantic or lexical). */
	#finish(input: {
		task: string;
		catalog: readonly Skill[];
		explicit: readonly Skill[];
		unmatchedExplicit: string[];
		limit: number;
		observation: ObservationIdentity;
		startedAt: number;
		scores: CatalogScores | undefined;
		mode: "semantic" | "search";
		fallbackReason?: string;
		attempts: DecisionProvenance[];
		meter: LoopMeter | undefined;
		cacheHit: boolean;
	}): SkillRecommendResult {
		const { catalog, scores, mode } = input;
		const isExplicit = new Set(input.explicit.map(skill => skill.name));
		const recommendations: SkillRecommendation[] = input.explicit.map(skill => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			relevance: scores?.probability.get(catalog.indexOf(skill)) ?? 1,
			windowApplicable: 1,
			applicable: 1,
			reason: "explicit",
		}));

		const ranked: SkillRecommendation[] = [];
		let noMatch: boolean;
		if (scores) {
			// Either gate says nothing applies: the window-level `any_applicable`
			// or, once the finalists were asked individually, their best `fits`.
			noMatch =
				scores.anyApplicable < APPLICABLE_NO_MATCH || (scores.fits.size > 0 && scores.maxFits < FITS_NO_MATCH);
			// A no-match verdict lists nothing: a forced pick beside "nothing applies"
			// would contradict itself.
			if (!noMatch) {
				for (const entry of this.#rankSemantic(catalog, scores, isExplicit).slice(0, input.limit)) {
					const skill = catalog[entry.index];
					ranked.push({
						name: skill.name,
						description: skill.description,
						filePath: skill.filePath,
						relevance: entry.relevance,
						windowApplicable: entry.windowApplicable,
						applicable: scores.fits.get(entry.index) ?? 0,
						reason: "semantic",
					});
				}
			}
		} else {
			const lexical = lexicalScores(input.task, catalog);
			for (const [index, skill] of catalog.entries()) {
				if (isExplicit.has(skill.name)) continue;
				if (lexical[index] < this.#deps.config.minRelevance) continue;
				ranked.push({
					name: skill.name,
					description: skill.description,
					filePath: skill.filePath,
					relevance: lexical[index],
					windowApplicable: 1,
					applicable: 1,
					reason: "search",
				});
			}
			noMatch = ranked.length === 0;
			ranked.sort((a, b) => b.relevance - a.relevance || a.name.localeCompare(b.name));
			ranked.length = Math.min(ranked.length, input.limit);
		}
		recommendations.push(...ranked);

		const resolvable = recommendations.every(entry => catalog.some(skill => skill.name === entry.name));
		return {
			recommendations,
			mode,
			fallbackReason: input.fallbackReason,
			anyApplicable: scores?.anyApplicable,
			noMatch,
			noMatchCaveat: NO_MATCH_CAVEAT,
			stale: false,
			cacheHit: input.cacheHit,
			windows: scores?.windows ?? 0,
			catalogSize: catalog.length,
			unmatchedExplicit: input.unmatchedExplicit,
			observation: input.observation,
			outcome: { status: "applied", detail: `${recommendations.length} recommendation(s) via ${mode}` },
			verification: {
				verified: resolvable,
				method: "catalog-reresolve",
				observation: input.observation,
				detail: resolvable
					? "every returned skill resolves in the observed catalog revision"
					: "a returned skill no longer resolves in the observed catalog revision",
			},
			attempts: input.attempts,
			usage: input.meter?.totalUsage() ?? { calls: 0, attempts: 0, input: 0, output: 0, costUsd: 0 },
			durationMs: Date.now() - input.startedAt,
		};
	}
}

/**
 * Split the catalog into near-equal windows of at most `size` skills. With
 * `size >= MIN_WINDOW_SIZE` every window of a multi-window split holds at
 * least {@link MIN_WINDOW_SKILLS} skills, so no window's probabilities are
 * forced by a lack of alternatives.
 */
function chunkCatalog(catalog: readonly Skill[], size: number): CatalogWindow[] {
	if (catalog.length <= size) return [{ skills: catalog, offset: 0 }];
	const count = Math.ceil(catalog.length / size);
	const base = Math.floor(catalog.length / count);
	let extra = catalog.length % count;
	const windows: CatalogWindow[] = [];
	let offset = 0;
	for (let i = 0; i < count; i++) {
		const length = extra > 0 ? base + 1 : base;
		if (extra > 0) extra--;
		windows.push({ skills: catalog.slice(offset, offset + length), offset });
		offset += length;
	}
	return windows;
}
