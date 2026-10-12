import { describe, expect, it } from "bun:test";
import type { JudgmentRequest, JudgmentResult, Questions, Usage } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import {
	buildCandidateIds,
	type SkillRecommendConfig,
	SkillRecommender,
} from "@oh-my-pi/pi-coding-agent/extensibility/skill-recommend";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { ChainJudgeOptions, JudgeKind } from "@oh-my-pi/pi-coding-agent/judgment";
import type { DecisionJudge } from "@oh-my-pi/pi-coding-agent/judgment/decision";

const CONFIG: SkillRecommendConfig = {
	enabled: true,
	maxCandidatesPerRequest: 200,
	minRelevance: 0.1,
	cacheEntries: 64,
};

const USAGE: Usage = {
	input: 12,
	output: 3,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

function skill(name: string, description: string): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		source: "test",
	};
}

interface FakeAnswer {
	/** Candidate id the fake judge selects. */
	choice: string;
	/** Optional full distribution; defaults to a one-hot on {@link choice}. */
	probabilities?: Record<string, number>;
	/** `any_applicable` probability; also every finalist's `fits` unless {@link fits} overrides it. */
	applicable: number;
	/** Per-finalist `fits` answers keyed by candidate id. */
	fits?: Record<string, number>;
}

interface FakeCall {
	/** Option ids of the `select` head; empty for the noul-only `fits` request. */
	ids: string[];
	/** Question ids in request order. */
	questions: Record<string, unknown>;
	state: unknown;
}

interface FakeJudge extends DecisionJudge {
	readonly calls: FakeCall[];
}

/** Deterministic in-memory judge: answers the candidate choice plus `any_applicable`, then the per-finalist `fits` nouls. */
function fakeJudge(
	respond: (ids: string[], call: number) => FakeAnswer | Promise<FakeAnswer>,
	kind: JudgeKind = "online",
): FakeJudge {
	const calls: FakeCall[] = [];
	const native = kind === "native";
	return {
		kind,
		label: "judge role chain",
		calls,
		async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
			const select = request.questions.select;
			const ids = select?.type === "choice" ? Object.keys(select.criteria) : [];
			calls.push({ ids, questions: request.questions, state: request.state });
			const answer = await respond(ids, calls.length);
			const answers: Record<string, unknown> = {};
			if (select?.type === "choice") {
				const probabilities: Record<string, number> =
					answer.probabilities ?? Object.fromEntries(ids.map(id => [id, id === answer.choice ? 1 : 0]));
				answers.select = { type: "choice", choice: answer.choice, probabilities, confidence: 1 };
			}
			for (const id in request.questions) {
				if (id === "select") continue;
				const fits = answer.fits?.[id.replace(/^fits_/, "")];
				answers[id] = { type: "noul", noul: fits ?? answer.applicable };
			}
			return {
				api: native ? "typesafe" : "openai-codex-responses",
				provider: native ? "typesafe" : "openai-codex",
				model: native ? "jev-1.13.0" : "gpt-5.6-sol",
				answers: answers as JudgmentResult<Q>["answers"],
				// An unpriced native route reports token counts only.
				usage: native ? tokenUsage(12, 3) : USAGE,
			};
		},
	};
}

/** Judge whose transport was reached and failed: reports the attempt, then throws. */
function failingJudge(message: string): DecisionJudge {
	return {
		label: "judge role chain",
		async judge<Q extends Questions>(_request: JudgmentRequest<Q>, options?: ChainJudgeOptions) {
			options?.onAttempt?.({
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				usage: tokenUsage(0, 0),
				durationMs: 5,
				error: message,
			});
			throw new Error(`judgment: every judge candidate failed: ${message}`);
		},
	};
}

/** Judge whose role chain admits no candidate: fails before any transport is asked, as `ChainJudge` does. */
function unavailableJudge(message: string): DecisionJudge {
	return {
		label: "judge role chain",
		async judge<Q extends Questions>(): Promise<JudgmentResult<Q>> {
			throw new Error(message);
		},
	};
}

function recommender(judge: DecisionJudge | (() => DecisionJudge), config: Partial<SkillRecommendConfig> = {}) {
	return new SkillRecommender({
		config: { ...CONFIG, ...config },
		judgmentDigest: "llm/",
		judge: typeof judge === "function" ? judge : () => judge,
	});
}

describe("SkillRecommender", () => {
	it("scores every window when the catalog exceeds one request, never leaving a window with one real option", async () => {
		const catalog = Array.from({ length: 5 }, (_, index) => skill(`skill-${index}`, `does thing ${index}`));
		const judge = fakeJudge(ids => ({ choice: ids[0], applicable: 0.9 }));
		const result = await recommender(judge, { maxCandidatesPerRequest: 3 }).recommend({
			task: "do thing 4",
			catalog,
			limit: 10,
		});

		// Two window requests, then one `fits` request over the finalists.
		expect(judge.calls.length).toBe(3);
		const windows = judge.calls.slice(0, 2);
		// Windows are balanced (3 + 2), and each also offers the `none` decline option.
		expect(windows.map(call => call.ids.filter(id => id !== "none").length)).toEqual([3, 2]);
		for (const call of windows) expect(call.ids).toContain("none");
		expect(result.windows).toBe(2);
		expect(result.mode).toBe("semantic");
		// One selection per window: no window was silently skipped.
		expect(result.recommendations.map(entry => entry.name)).toEqual(["skill-0", "skill-3"]);
	});

	it("does not let a small remainder window outrank a full window", async () => {
		const catalog = Array.from({ length: 21 }, (_, index) => skill(`skill-${index}`, `does thing ${index}`));
		const judge = fakeJudge((ids, call) => {
			if (call === 1) {
				const rest = (1 - 0.4) / (ids.length - 1);
				return {
					choice: ids[0],
					probabilities: Object.fromEntries(ids.map((id, index) => [id, index === 0 ? 0.4 : rest])),
					applicable: 0.9,
				};
			}
			// Nothing stands out in the second window: a flat distribution.
			return {
				choice: ids[0],
				probabilities: Object.fromEntries(ids.map(id => [id, 1 / ids.length])),
				applicable: 0.5,
			};
		});
		const result = await recommender(judge, { maxCandidatesPerRequest: 20 }).recommend({
			task: "do thing 0",
			catalog,
			limit: 3,
		});

		expect(result.windows).toBe(2);
		for (const call of judge.calls.slice(0, 2)) {
			expect(call.ids.filter(id => id !== "none").length).toBeGreaterThanOrEqual(2);
		}
		expect(result.recommendations[0].name).toBe("skill-0");
	});

	it("asks one absolute fits noul per finalist in a second request whose instructions name the skill and its state path", async () => {
		const catalog = [
			skill("deploy", "Deploy to Vercel"),
			skill("tmux", "Drive tmux"),
			skill("tweet", "Fetch tweets"),
		];
		const judge = fakeJudge(ids => ({
			choice: ids[0],
			probabilities: Object.fromEntries(ids.map(id => [id, id === "deploy" ? 0.6 : id === "tmux" ? 0.3 : 0.05])),
			applicable: 0.9,
			fits: { deploy: 0.8, tmux: 0.1 },
		}));
		const result = await recommender(judge).recommend({ task: "ship it to vercel", catalog, limit: 2 });

		expect(judge.calls.length).toBe(2);
		const fits = judge.calls[1];
		// Only the two finalists `limit` admits are asked about, each on its own.
		expect(Object.keys(fits.questions)).toEqual(["fits_deploy", "fits_tmux"]);
		expect(fits.state).toEqual({
			task: "ship it to vercel",
			skills: [
				{ id: "deploy", name: "deploy", description: "Deploy to Vercel" },
				{ id: "tmux", name: "tmux", description: "Drive tmux" },
			],
		});
		const question = fits.questions.fits_tmux as {
			type: string;
			instructions: string;
			criteria: Record<string, string>;
		};
		expect(question.type).toBe("noul");
		// The question carries its own meaning: the skill name and where it sits in the state.
		expect(question.instructions).toContain("`tmux`");
		expect(question.instructions).toContain("`skills[1]`");
		expect(question.instructions).toContain("on its own, not relative to the other listed skills");
		expect(question.criteria.true).toContain("`skills[1]`");
		expect(question.criteria.false).toContain("`skills[1]`");
		// The relative ordering is untouched; the absolute answer rides beside it.
		expect(result.recommendations.map(entry => [entry.name, entry.applicable])).toEqual([
			["deploy", 0.8],
			["tmux", 0.1],
		]);
		expect(result.noMatch).toBe(false);
	});

	it("reports no match when every finalist's own fits noul is low even though the window gate passed", async () => {
		const catalog = [skill("alpha", "alpha workflow"), skill("beta", "beta workflow")];
		const judge = fakeJudge(ids => ({ choice: ids[0], applicable: 0.9, fits: { alpha: 0.2, beta: 0.1 } }));
		const result = await recommender(judge).recommend({ task: "unrelated chore", catalog });

		expect(judge.calls.length).toBe(2);
		expect(result.noMatch).toBe(true);
		expect(result.recommendations).toEqual([]);
	});

	it("does not spend the fits request when the window gate already rejected the catalog", async () => {
		const catalog = [skill("alpha", "alpha workflow"), skill("beta", "beta workflow")];
		const judge = fakeJudge(ids => ({ choice: ids[0], applicable: 0.2 }));
		const result = await recommender(judge).recommend({ task: "unrelated chore", catalog });

		expect(judge.calls.length).toBe(1);
		expect(result.noMatch).toBe(true);
	});

	it("caps and normalises skill descriptions before they reach the judge", async () => {
		const catalog = [skill("alpha", `\x1b[31mﬁnance\x07 ${"x".repeat(600)}`)];
		const judge = fakeJudge(ids => ({ choice: ids[0], applicable: 0.9 }));
		await recommender(judge).recommend({ task: "alpha things", catalog });

		const state = judge.calls[0].state as { skills: Array<{ description: string }> };
		const description = state.skills[0].description;
		expect(description.length).toBeLessThanOrEqual(300);
		expect(description).toContain("finance");
		expect(description).not.toContain("\x1b");
		expect(description).not.toContain("\x07");
	});

	it("keeps explicitly named skills ahead of the ranking and never scores them away", async () => {
		const catalog = [skill("alpha", "alpha workflow"), skill("beta", "beta workflow")];
		const judge = fakeJudge(() => ({ choice: "beta", applicable: 0.9 }));
		const result = await recommender(judge).recommend({ task: "run /skill:alpha on the repo", catalog });

		expect(result.recommendations[0]).toMatchObject({ name: "alpha", reason: "explicit" });
		expect(result.recommendations.map(entry => entry.name)).toEqual(["alpha", "beta"]);
	});

	it("accepts skill:// urls, exact name tokens, and caller-supplied explicit names", async () => {
		const catalog = [skill("alpha", "a"), skill("beta", "b"), skill("gamma", "c"), skill("delta", "d")];
		const judge = fakeJudge(() => ({ choice: "delta", applicable: 0.9 }));
		const result = await recommender(judge).recommend({
			task: "read skill://alpha then apply Beta",
			catalog,
			explicit: ["gamma", "missing-skill"],
		});

		expect(result.recommendations.filter(entry => entry.reason === "explicit").map(entry => entry.name)).toEqual([
			"alpha",
			"beta",
			"gamma",
		]);
		expect(result.unmatchedExplicit).toEqual(["missing-skill"]);
	});

	it("reports no match with its caveat and lists no forced pick when nothing applies", async () => {
		const catalog = [skill("alpha", "alpha workflow"), skill("beta", "beta workflow")];
		const judge = fakeJudge(ids => ({ choice: ids[0], applicable: 0.2 }));
		const result = await recommender(judge).recommend({ task: "unrelated chore", catalog });

		expect(result.noMatch).toBe(true);
		expect(result.anyApplicable).toBe(0.2);
		expect(result.noMatchCaveat).toContain("not calibrated correctness");
		expect(result.recommendations).toEqual([]);
	});

	it("offers the judge a none option that contributes no relevance", async () => {
		const catalog = [skill("alpha", "alpha workflow"), skill("beta", "beta workflow")];
		const judge = fakeJudge(() => ({ choice: "none", applicable: 0.9 }));
		const result = await recommender(judge).recommend({ task: "unrelated chore", catalog });

		expect(judge.calls[0].ids).toContain("none");
		expect(result.mode).toBe("semantic");
		expect(result.recommendations).toEqual([]);
	});

	it("falls back to lexical search with a reason when the judge fails", async () => {
		const catalog = [
			skill("vercel-deploy", "Deploy applications to Vercel"),
			skill("arxiv-pdf-reader", "Convert arXiv PDFs to markdown"),
		];
		const result = await recommender(failingJudge("backend exploded")).recommend({
			task: "deploy the app to vercel",
			catalog,
		});

		expect(result.mode).toBe("search");
		expect(result.fallbackReason).toBe("judgment failed: judgment: every judge candidate failed: backend exploded");
		// The failed transport attempt stays on the record.
		expect(result.attempts).toHaveLength(1);
		expect(result.attempts[0]).toMatchObject({ provider: "openai-codex", nested: true, error: "backend exploded" });
		expect(result.recommendations[0].name).toBe("vercel-deploy");
		expect(result.recommendations[0].reason).toBe("search");
		expect(result.windows).toBe(0);
	});

	it("falls back when the judge answers with an id it was not offered", async () => {
		const catalog = [skill("alpha", "alpha workflow")];
		const result = await recommender(fakeJudge(() => ({ choice: "not_a_candidate", applicable: 0.9 }))).recommend({
			task: "alpha things",
			catalog,
		});

		expect(result.mode).toBe("search");
		expect(result.fallbackReason).toContain("not_a_candidate");
	});

	it("serves a repeated task from cache without a second judgment call", async () => {
		const catalog = [skill("alpha", "alpha workflow"), skill("beta", "beta workflow")];
		const judge = fakeJudge(() => ({ choice: "alpha", applicable: 0.9 }));
		const recommend = recommender(judge);
		const first = await recommend.recommend({ task: "alpha things", catalog });
		const second = await recommend.recommend({ task: "alpha things", catalog });

		expect(judge.calls.length).toBe(1);
		expect(first.cacheHit).toBe(false);
		expect(second.cacheHit).toBe(true);
		expect(second.attempts).toEqual([]);
		expect(second.recommendations.map(entry => entry.name)).toEqual(first.recommendations.map(entry => entry.name));
	});

	it("rejects an in-flight result whose catalog changed, and does not cache it", async () => {
		const catalogA = [skill("alpha", "alpha workflow")];
		const catalogB = [skill("alpha", "alpha workflow"), skill("beta", "beta workflow")];
		const gate = Promise.withResolvers<void>();
		const judge = fakeJudge(async (ids, call) => {
			if (call === 1) await gate.promise;
			return { choice: ids[0], applicable: 0.9 };
		});
		const recommend = recommender(judge);

		const pending = recommend.recommend({ task: "alpha things", catalog: catalogA });
		await Bun.sleep(5);
		const refreshed = await recommend.recommend({ task: "alpha things", catalog: catalogB });
		gate.resolve();
		const stale = await pending;

		expect(refreshed.stale).toBe(false);
		expect(stale.stale).toBe(true);
		expect(stale.recommendations).toEqual([]);
		expect(stale.outcome.status).toBe("stale");
		expect(stale.verification.verified).toBe("unknown");

		// The discarded result never entered the cache: re-asking costs a new call.
		const rerun = await recommend.recommend({ task: "alpha things", catalog: catalogA });
		expect(rerun.cacheHit).toBe(false);
		expect(rerun.stale).toBe(false);
		expect(judge.calls.length).toBe(3);
	});

	it("evicts the least recently used cache entry", async () => {
		const catalog = [skill("alpha", "alpha workflow")];
		const judge = fakeJudge(ids => ({ choice: ids[0], applicable: 0.9 }));
		const recommend = recommender(judge, { cacheEntries: 1 });
		await recommend.recommend({ task: "first task", catalog });
		await recommend.recommend({ task: "second task", catalog });
		const again = await recommend.recommend({ task: "first task", catalog });

		expect(again.cacheHit).toBe(false);
		// Each uncached task costs its window request plus the `fits` request.
		expect(judge.calls.length).toBe(6);
	});

	it("carries provenance distinguishing a native distribution from a synthetic one", async () => {
		const catalog = [skill("alpha", "alpha workflow")];
		const online = await recommender(fakeJudge(ids => ({ choice: ids[0], applicable: 0.9 }))).recommend({
			task: "alpha things",
			catalog,
		});
		const native = await recommender(fakeJudge(ids => ({ choice: ids[0], applicable: 0.9 }), "native")).recommend({
			task: "alpha things",
			catalog,
		});

		expect(online.attempts[0]).toMatchObject({ backend: "online", distribution: "synthetic" });
		expect(online.usage.costUsd).toBeCloseTo(0.003, 6);
		expect(native.attempts[0]).toMatchObject({ backend: "native", distribution: "native", model: "jev-1.13.0" });
		expect(native.usage.costUsd).toBe("unknown");
	});

	it("routes to lexical search when no judge can be resolved", async () => {
		const catalog = [skill("vercel-deploy", "Deploy applications to Vercel")];
		const result = await recommender(() => {
			throw new Error("no model registry in this session");
		}).recommend({ task: "deploy to vercel", catalog });

		expect(result.mode).toBe("search");
		expect(result.fallbackReason).toBe("judge unavailable: no model registry in this session");
		expect(result.attempts).toEqual([]);
	});

	it("reports an exact-pinned judge that admits no candidate as unavailable, never a substitute", async () => {
		const catalog = [skill("vercel-deploy", "Deploy applications to Vercel"), skill("tmux", "Drive tmux")];
		const gap =
			"judgment: pinned judge typesafe/jev-1.13.0 is unavailable (typesafe lists 2 model(s) but not this id); " +
			"the exact pin with an empty retry.fallbackChains.judge admits no substitute";
		const result = await recommender(unavailableJudge(gap)).recommend({ task: "deploy to vercel", catalog });

		expect(result.mode).toBe("search");
		expect(result.fallbackReason).toBe(`judge unavailable: ${gap}`);
		// The chain was asked once and no transport ever answered: one opaque failed row, nothing else.
		expect(result.attempts).toHaveLength(1);
		expect(result.attempts[0]).toMatchObject({ api: "none", backend: "unknown", error: gap });
		expect(result.recommendations.map(entry => [entry.name, entry.reason])).toEqual([["vercel-deploy", "search"]]);
	});
});

describe("buildCandidateIds", () => {
	it("sanitizes names into decision-safe ids and suffixes collisions", () => {
		expect(buildCandidateIds(["foo bar", "foo.bar", "foo-bar", "3d-model", "_leading"])).toEqual([
			"foo_bar",
			"foo_bar_2",
			"foo-bar",
			"s_3d-model",
			"s__leading",
		]);
	});

	it("keeps ids within the 32-character decision id bound", () => {
		const long = `${"a".repeat(40)}-one`;
		const ids = buildCandidateIds([long, long]);
		expect(ids[0]).toBe("a".repeat(32));
		expect(ids[1]).toBe(`${"a".repeat(30)}_2`);
		for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/);
	});
});
