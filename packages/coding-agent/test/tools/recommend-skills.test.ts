import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, JudgmentRequest, JudgmentResult, Model, Questions, Usage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SkillRecommender } from "@oh-my-pi/pi-coding-agent/extensibility/skill-recommend";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { JudgmentUsage } from "@oh-my-pi/pi-coding-agent/judgment";
import type { DecisionJudge } from "@oh-my-pi/pi-coding-agent/judgment/decision";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { RecommendSkillsTool } from "@oh-my-pi/pi-coding-agent/tools/recommend-skills";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const USAGE: Usage = {
	input: 20,
	output: 4,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 24,
	cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
};

const CATALOG: readonly Skill[] = [
	{
		name: "vercel-deploy",
		description: "Deploy applications to Vercel",
		filePath: "/skills/vercel-deploy/SKILL.md",
		baseDir: "/skills/vercel-deploy",
		source: "test",
	},
	{
		name: "arxiv-pdf-reader",
		description: "Fetch arXiv PDFs and convert them to markdown",
		filePath: "/skills/arxiv-pdf-reader/SKILL.md",
		baseDir: "/skills/arxiv-pdf-reader",
		source: "test",
	},
	{
		name: "hidden-helper",
		description: "Never listed",
		filePath: "/skills/hidden-helper/SKILL.md",
		baseDir: "/skills/hidden-helper",
		source: "test",
		hide: true,
	},
];

/** Deterministic in-memory judge: picks the first offered candidate, and answers every noul (window gate and per-finalist fits) with `applicable`. */
function firstCandidateJudge(
	applicable: number,
	hooks: { onUsage?: (usage: JudgmentUsage) => void } = {},
): DecisionJudge {
	return {
		label: "judge role chain",
		async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
			const select = request.questions.select;
			const answers: Record<string, unknown> = {};
			if (select?.type === "choice") {
				const ids = Object.keys(select.criteria).filter(id => id !== "none");
				answers.select = {
					type: "choice",
					choice: ids[0],
					probabilities: Object.fromEntries(
						ids.map((id, index) => [id, index === 0 ? 0.8 : 0.2 / (ids.length - 1 || 1)]),
					),
					confidence: 0.8,
				};
			}
			for (const id in request.questions) {
				if (id === "select") continue;
				answers[id] = { type: "noul", noul: applicable };
			}
			hooks.onUsage?.({
				role: "smol",
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				usage: USAGE,
				stopReason: "stop",
			});
			return {
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				answers: answers as JudgmentResult<Q>["answers"],
				usage: USAGE,
			};
		},
	};
}

function makeSession(
	overrides: Partial<Record<string, unknown>> = {},
	skills: readonly Skill[] = CATALOG,
	sessionManager?: SessionManager,
	modelRegistry?: ModelRegistry,
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		skills,
		settings: Settings.isolated(overrides),
		sessionManager,
		modelRegistry,
	};
}

const JEV_LATEST = {
	id: "jev-latest",
	name: "JEV Latest",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as Model<Api>;

/** Registry whose available catalog is exactly `models`, each provider credentialed. */
function makeRegistry(models: Model<Api>[], keys: Record<string, string>): ModelRegistry {
	const authStorage = createInMemoryAuthStorage();
	for (const provider in keys) authStorage.keys.setRuntime(provider, keys[provider]!);
	const registry = new ModelRegistry(authStorage, "/nonexistent/recommend-skills-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	return registry;
}

/** Holds every judge call until `release` resolves; `entered` fires per call that reached the judge. */
interface JudgeGate {
	entered: () => void;
	release: Promise<void>;
}

function fakeRecommender(applicable: number, gate?: JudgeGate): SkillRecommender {
	return new SkillRecommender({
		config: { enabled: true, maxCandidatesPerRequest: 200, minRelevance: 0.1, cacheEntries: 8 },
		judgmentDigest: "llm/",
		judge: hooks => {
			const judge = firstCandidateJudge(applicable, hooks);
			if (!gate) return judge;
			return {
				...judge,
				async judge(request, options) {
					gate.entered();
					await gate.release;
					return judge.judge(request, options);
				},
			};
		},
	});
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("recommend_skills", () => {
	it("is withheld when skill recommendation is disabled", () => {
		expect(RecommendSkillsTool.createIf(makeSession({ "skills.recommend.enabled": false }))).toBeNull();
		expect(RecommendSkillsTool.createIf(makeSession({ "skills.enabled": false }))).toBeNull();
		expect(RecommendSkillsTool.createIf(makeSession())).not.toBeNull();
	});

	it("declares skill:// reading so the system prompt keeps listing skills", () => {
		const tool = RecommendSkillsTool.createIf(makeSession());
		expect(tool?.readsSkillUris).toBe(true);
		expect(tool?.approval).toBe("read");
	});

	it("renders the ranking, the mode, and the judge provenance", async () => {
		const tool = new RecommendSkillsTool(makeSession(), fakeRecommender(0.9));
		const result = await tool.execute("call-1", { task: "deploy the app to vercel" });
		const text = textOf(result);

		expect(text).toContain("(mode: semantic)");
		expect(text).toContain("— relevance 0.80 (semantic) — Deploy applications to Vercel");
		expect(text).toContain("judge: online judge role chain · model openai-codex/gpt-5.6-sol · synthetic one-hot");
		// The window request plus the per-finalist `fits` request.
		expect(text).toContain("2 call(s) · cost $0.0040");
		// Hidden skills stay out of the ranked catalog.
		expect(result.details?.result.catalogSize).toBe(2);
		expect(text).not.toContain("hidden-helper");
	});

	it("reports the no-match verdict with its heuristic caveat and no forced pick", async () => {
		const tool = new RecommendSkillsTool(makeSession(), fakeRecommender(0.1));
		const result = await tool.execute("call-2", { task: "book a flight to tokyo" });
		const text = textOf(result);

		expect(text).toContain("No listed skill materially applies to this task (any_applicable 0.10).");
		expect(text).toContain("not calibrated correctness");
		expect(text.split("\n").some(line => line.startsWith("- "))).toBe(false);
		expect(result.details?.result.recommendations).toEqual([]);
	});

	it("sanitises skill text before echoing it into the tool output", async () => {
		const hostile: Skill = {
			name: "odd\tname",
			description: `line one\nline two\t\x1b[31mred\x1b[0m\x07 ${"x".repeat(600)}`,
			filePath: "/skills/odd/SKILL.md",
			baseDir: "/skills/odd",
			source: "test",
		};
		const tool = new RecommendSkillsTool(makeSession({}, [hostile]), fakeRecommender(0.9));
		const text = textOf(
			await tool.execute("call-7", { task: "odd things", explicit: ["odd\tname", "\x1b[2Jghost"] }),
		);

		expect(text).not.toContain("\t");
		expect(text).not.toContain("\x1b");
		expect(text).not.toContain("\x07");
		const row = text.split("\n").find(line => line.startsWith("- odd"));
		expect(row).toBeDefined();
		expect(row).toContain("line one line two red");
		expect(row!.length).toBeLessThan(600);
		expect(text).toContain("Not installed, ignored: ghost.");
	});

	it("chains each call's ledger entries from the leaf even when calls overlap", async () => {
		const manager = SessionManager.inMemory();
		const leafId = manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const release = Promise.withResolvers<void>();
		const bothEntered = Promise.withResolvers<void>();
		let entered = 0;
		const gate: JudgeGate = {
			entered: () => {
				if (++entered === 2) bothEntered.resolve();
			},
			release: release.promise,
		};
		const session = makeSession({}, CATALOG, manager);
		const tool = new RecommendSkillsTool(session, fakeRecommender(0.9, gate));

		const first = tool.execute("call-8a", { task: "deploy the app to vercel" });
		const second = tool.execute("call-8b", { task: "convert this arXiv PDF to markdown" });
		await bothEntered.promise;
		release.resolve();
		await Promise.all([first, second]);

		const usage = manager.getEntries().filter(entry => entry.type === "model_usage");
		// Each call makes a window request and a `fits` request: four entries.
		expect(usage).toHaveLength(4);
		// Each call starts its own chain at the leaf and chains its second request off
		// its own first one; neither hangs off the other call's entries.
		const roots = usage.filter(entry => entry.parentId === leafId);
		expect(roots).toHaveLength(2);
		const rootIds = new Set(roots.map(entry => entry.id));
		for (const entry of usage) {
			if (rootIds.has(entry.id)) continue;
			expect(rootIds.has(entry.parentId ?? "")).toBe(true);
		}
	});

	it("degrades to lexical search when the session has no model registry", async () => {
		const tool = RecommendSkillsTool.createIf(makeSession());
		const result = await tool!.execute("call-3", { task: "convert this arXiv PDF to markdown" });
		const text = textOf(result);

		expect(result.details?.result.mode).toBe("search");
		expect(text).toContain("(mode: search)");
		expect(text).toContain("judge: none · lexical name/description overlap");
		expect(text).toContain("arxiv-pdf-reader — relevance");
	});

	it("reports lexical mode naming the pin gap when the exact-pinned judge is unavailable, asking no other model", async () => {
		// modelRoles.judge pins jev-1.13.0 with an empty judge chain; the registry
		// only discovers jev-latest, so the chain admits nothing at all.
		const registry = makeRegistry([JEV_LATEST], { typesafe: "ts-key" });
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const tool = RecommendSkillsTool.createIf(
			makeSession(
				{ modelRoles: { judge: "typesafe/jev-1.13.0" }, "retry.fallbackChains": { judge: [] } },
				CATALOG,
				undefined,
				registry,
			),
		);
		const result = await tool!.execute("call-9", { task: "deploy the app to vercel" });
		const text = textOf(result);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(result.details?.result.mode).toBe("search");
		expect(result.details?.result.fallbackReason).toStartWith(
			"judge unavailable: judgment: pinned judge typesafe/jev-1.13.0 is unavailable (",
		);
		expect(result.details?.result.fallbackReason).toContain("admits no substitute");
		expect(text).toContain("(mode: search)");
		expect(text).toContain(
			"judge: none · lexical name/description overlap · judge unavailable: judgment: pinned judge",
		);
		expect(text).toContain("vercel-deploy — relevance");
	});

	it("keeps judgment provenance in details when the session ledger is unreachable", async () => {
		const tool = new RecommendSkillsTool(makeSession(), fakeRecommender(0.9));
		const result = await tool.execute("call-4", { task: "deploy to vercel" });

		expect(result.details?.usageLedger).toContain("session ledger unreachable");
		// The window request and the per-finalist `fits` request are both accounted.
		expect(result.details?.result.attempts).toHaveLength(2);
	});

	it("rejects a limit above the documented maximum", async () => {
		const tool = new RecommendSkillsTool(makeSession(), fakeRecommender(0.9));
		await expect(tool.execute("call-5", { task: "deploy", limit: 25 })).rejects.toThrow("limit must be 10 or less");
	});

	it("always includes an explicitly named skill", async () => {
		const tool = new RecommendSkillsTool(makeSession(), fakeRecommender(0.9));
		const text = textOf(await tool.execute("call-6", { task: "do the thing", explicit: ["arxiv-pdf-reader"] }));

		expect(text).toContain("arxiv-pdf-reader — relevance");
		expect(text).toContain("(explicit)");
	});
});
