import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AnswerFor, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { sessionResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/context";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import type { DecisionJudge } from "@oh-my-pi/pi-coding-agent/judgment/decision";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { FindTool } from "@oh-my-pi/pi-coding-agent/tools/jfind";
import { type BoundedFindOptions, runBounded } from "@oh-my-pi/pi-coding-agent/tools/jfind/bounded";
import type { FindAnswerVerdict } from "@oh-my-pi/pi-tui/tools/find";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "find-bounded");

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text" && typeof entry.text === "string")
		.map(entry => entry.text as string)
		.join("\n");
}

interface StatePassage {
	id: string;
	source: string;
	text: string;
}

/**
 * Deterministic stand-in for the real judgment backend.
 *
 * Scores come from a fixture map keyed by `path:start-end`; anything unlisted
 * gets a floor weight, so the returned distribution still sums to 1 exactly
 * like a real `Choice` answer. Records every request so windowing and the
 * two-pass contract are observable.
 */
class FixtureJudge implements DecisionJudge {
	readonly kind = "online" as const;
	readonly label = "fixture/deterministic";
	readonly requests: Array<{ ids: string[]; sources: string[] }> = [];

	constructor(
		private readonly weights: Record<string, number>,
		private readonly exists: number,
	) {}

	async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		const state = request.state as unknown as { query: string; passages: StatePassage[] };
		this.requests.push({
			ids: state.passages.map(passage => passage.id),
			sources: state.passages.map(passage => passage.source),
		});
		const raw = state.passages.map(passage => ({
			id: passage.id,
			weight: this.weights[passage.source] ?? 0.001,
		}));
		const total = raw.reduce((sum, entry) => sum + entry.weight, 0);
		const probabilities: Record<string, number> = {};
		for (const entry of raw) probabilities[entry.id] = entry.weight / total;
		const best = raw.reduce((a, b) => (b.weight > a.weight ? b : a));
		const answers: Record<string, unknown> = {
			select: { type: "choice", choice: best.id, probabilities, confidence: 0.9 },
		};
		for (const id in request.questions) {
			if (id === "select") continue;
			answers[id] = { type: "noul", noul: this.exists };
		}
		return {
			api: "openai-completions",
			provider: "fixture",
			model: "fixture-judge",
			answers: answers as { [K in keyof Q]: AnswerFor<Q[K]> },
			usage: tokenUsage(120, 8, 0.00012),
		};
	}
}

class ThrowingJudge implements DecisionJudge {
	readonly kind = "online" as const;
	readonly label = "fixture/throwing";
	async judge(): Promise<never> {
		throw new Error("judge endpoint returned 503");
	}
}

describe("find bounded mode", () => {
	let tmpDir: string;
	let artifactDir: string;
	let unregisterArtifacts: (() => void) | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "find-bounded-"));
		artifactDir = path.join(tmpDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		resetRegisteredArtifactDirsForTests();
		unregisterArtifacts = registerArtifactsDir(artifactDir);
	});

	afterEach(async () => {
		unregisterArtifacts?.();
		resetRegisteredArtifactDirsForTests();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function makeSession(overrides: Record<string, unknown> = {}): ToolSession {
		return {
			cwd: FIXTURES,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => artifactDir,
			settings: Settings.isolated({ "find.enabled": "on", ...overrides }),
		};
	}

	/** Run the bounded mode the way `FindTool` does, with an injected judge. */
	function run(
		judge: DecisionJudge,
		input: Pick<BoundedFindOptions, "query" | "paths" | "unit" | "limit" | "context">,
		overrides: Record<string, unknown> = {},
	) {
		const session = makeSession(overrides);
		return runBounded({
			...input,
			cwd: session.cwd,
			settings: session.settings,
			filesystem: new InternalUrlFilesystem({ context: sessionResolveContext(session), tier: "read" }),
			judge,
			usageRecorded: false,
		});
	}

	it("returns exact one-based locations whose excerpts still match the file on disk", async () => {
		const fileLines = (await Bun.file(path.join(FIXTURES, "handbook.txt")).text()).split("\n");
		const target = fileLines.findIndex(line => line.includes("borrow up to twelve items")) + 1;
		expect(target).toBeGreaterThan(0);

		const judge = new FixtureJudge({ [`handbook.txt:${target}-${target}`]: 40 }, 0.96);
		const result = await run(judge, {
			query: "how many items can a member borrow at once?",
			paths: ["handbook.txt"],
			limit: 3,
		});

		expect(result.details?.mode).toBe("bounded");
		const top = result.details?.results[0];
		expect(top).toEqual({
			path: "handbook.txt",
			resolved: path.join(FIXTURES, "handbook.txt"),
			startLine: target,
			endLine: target,
			score: expect.any(Number),
			snippet: fileLines[target - 1].trim(),
		});
		// The rendered excerpt must be re-readable verbatim at the reported range.
		const text = getText(result);
		expect(text).toContain(`handbook.txt:${target}-${target}  score `);
		expect(text).toContain(`*${target}:${fileLines[target - 1]}`);
		expect(text).toContain(` ${target - 1}:${fileLines[target - 2]}`);
		expect(result.details?.verification.verified).toBe(true);
		expect(result.details?.observation.surface).toBe("passages");
	});

	it("scores every passage once and re-ranks finalists on a second pass when windowed", async () => {
		const judge = new FixtureJudge({ "handbook.txt:13-13": 5 }, 0.9);
		const result = await run(
			judge,
			{ query: "who may join the library?", paths: ["handbook.txt"], limit: 4 },
			{ "semanticFind.passagesPerRequest": 50 },
		);

		const coverage = result.details?.coverage;
		if (!coverage) throw new Error("find returned no coverage");
		expect(coverage.files).toBe(1);
		expect(coverage.windows).toBeGreaterThan(1);
		expect(coverage.passes).toBe(2);
		expect(judge.requests.length).toBe(coverage.windows + 1);

		// Pass one covers the passage set exactly once; pass two re-scores finalists.
		const firstPassIds = judge.requests.slice(0, coverage.windows).flatMap(request => request.ids);
		expect(firstPassIds.length).toBe(coverage.passages);
		expect(new Set(firstPassIds).size).toBe(coverage.passages);
		const finalists = judge.requests.at(-1)?.ids ?? [];
		expect(finalists.length).toBeLessThanOrEqual(coverage.windows * 4);
		expect(finalists.every(id => firstPassIds.includes(id))).toBe(true);
		expect(getText(result)).toContain(`${coverage.windows} windows, 2 passes`);
		expect(result.details?.usage.calls).toBe(coverage.windows + 1);
	});

	it("skips oversized, binary, missing, directory, and selector inputs with a stated reason instead of reading part of them", async () => {
		const bigPath = path.join(tmpDir, "big.txt");
		await Bun.write(bigPath, "the answer is here\n".repeat(20_000));
		const binaryPath = path.join(tmpDir, "blob.bin");
		await Bun.write(binaryPath, new Uint8Array([104, 105, 0, 1, 2, 3]));
		await Bun.write(path.join(artifactDir, "0.bash.log"), "selector target\nsecond\n");

		const judge = new FixtureJudge({}, 0.9);
		const result = await run(
			judge,
			{
				query: "where is the answer?",
				paths: [
					path.join(FIXTURES, "notes.md"),
					bigPath,
					binaryPath,
					path.join(tmpDir, "missing.txt"),
					tmpDir,
					"artifact://0:1-1",
				],
			},
			{ "semanticFind.maxBytesPerFile": 4096 },
		);

		const reasons = new Map((result.details?.coverage.skipped ?? []).map(skip => [skip.path, skip.reason]));
		expect(reasons.get(bigPath)).toContain("exceeds semanticFind.maxBytesPerFile (4096)");
		expect(reasons.get(binaryPath)).toBe("binary content");
		expect(reasons.get(path.join(tmpDir, "missing.txt"))).toContain("unreadable");
		expect(reasons.get(tmpDir)).toBe(`directory — name files or a glob such as ${tmpDir}/*`);
		expect(reasons.get("artifact://0:1-1")).toContain("line-range selectors are not supported");
		expect(result.details?.coverage.files).toBe(1);
		const text = getText(result);
		expect(text).toContain("skipped");
		expect(text).toContain("binary content");
		// Nothing from a skipped source may reach the judge or the ranked output.
		expect(judge.requests.flatMap(request => request.sources).every(source => source.startsWith("/"))).toBe(true);
		expect(judge.requests.flatMap(request => request.sources).some(source => source.includes("notes.md"))).toBe(true);
		expect(text).not.toContain("the answer is here");
		expect(text).not.toContain("selector target");
	});

	it("reports answerPresent separately from the ranking at each verdict band", async () => {
		const bands: Array<{ exists: number; verdict: FindAnswerVerdict; phrase: string }> = [
			{ exists: 0.05, verdict: "absent", phrase: "likely absent from the selected files" },
			{ exists: 0.5, verdict: "partial", phrase: "partially addressed" },
			{ exists: 0.95, verdict: "present", phrase: "answered in the selected files" },
		];
		for (const band of bands) {
			// One passage dominates the ranking whatever the presence answer says.
			const result = await run(new FixtureJudge({ "notes.md:3-3": 500 }, band.exists), {
				query: "does the charter cover maritime salvage law?",
				paths: ["notes.md"],
				limit: 2,
			});
			expect(result.details?.verdict).toBe(band.verdict);
			expect(result.details?.answerPresent).toBeCloseTo(band.exists, 5);
			const text = getText(result);
			expect(text).toContain(`answerPresent ${band.exists.toFixed(2)}`);
			expect(text).toContain(band.phrase);
			// Ranking probabilities sum to 1: the top passage is confidently ranked
			// even when the independent presence answer says nothing answers.
			const top = result.details?.results[0];
			expect(top).toMatchObject({ path: "notes.md", startLine: 3, endLine: 3 });
			expect(top?.score).toBeGreaterThan(0.9);
		}
	});

	it("refuses to rank a subset when the file or passage caps are exceeded", async () => {
		await expect(
			run(
				new FixtureJudge({}, 0.9),
				{ query: "anything", paths: ["*.ts", "*.md", "*.txt"] },
				{
					"semanticFind.maxFiles": 2,
				},
			),
		).rejects.toThrow(/exceed semanticFind\.maxFiles \(2\); not read:/);

		await expect(
			run(
				new FixtureJudge({}, 0.9),
				{ query: "anything", paths: ["handbook.txt"] },
				{
					"semanticFind.maxPassages": 20,
				},
			),
		).rejects.toThrow(/exceed semanticFind\.maxPassages \(20\)/);
	});

	it("fails closed when the judge errors, still accounting for the failed attempt", async () => {
		const result = await run(new ThrowingJudge(), { query: "anything", paths: ["notes.md"] });

		expect(result.isError).toBe(true);
		expect(result.details?.results).toEqual([]);
		expect(result.details?.verdict).toBe("unknown");
		expect(result.details?.error).toContain("judge endpoint returned 503");
		// The failed transport attempt is carried, not discarded.
		expect(result.details?.provenance.length).toBeGreaterThanOrEqual(1);
		expect(result.details?.provenance.at(-1)?.error).toContain("503");
		expect(result.details?.usage.attempts).toBe(result.details?.provenance.length);
		const text = getText(result);
		expect(text).toContain("judge endpoint returned 503");
		expect(text).toContain("use grep for exact matches");
		expect(text).toMatch(/\b1 attempt\b/);
	});

	it("keeps every window represented in the finalist pass and reports finalists it had to drop", async () => {
		const judge = new FixtureJudge({ "handbook.txt:13-13": 5 }, 0.9);
		const result = await run(
			judge,
			{ query: "who may join the library?", paths: ["handbook.txt"], limit: 50 },
			{ "semanticFind.passagesPerRequest": 20 },
		);

		const coverage = result.details?.coverage;
		if (!coverage) throw new Error("find returned no coverage");
		expect(coverage.windows).toBeGreaterThan(1);
		expect(coverage.passes).toBe(2);
		const perWindow = Math.max(1, Math.floor(20 / coverage.windows));
		const finalists = judge.requests.at(-1)?.ids ?? [];
		expect(finalists.length).toBeLessThanOrEqual(20);
		expect(finalists.length).toBe(coverage.windows * perWindow);
		// Each first-pass window contributes its top finalists; none is crowded out.
		for (const request of judge.requests.slice(0, coverage.windows)) {
			expect(request.ids.filter(id => finalists.includes(id)).length).toBe(perWindow);
		}
		expect(coverage.finalistsDropped).toBeGreaterThan(0);
		expect(getText(result)).toContain(`${coverage.finalistsDropped} finalist`);
	});

	it("sanitises passage text before rendering it", async () => {
		const hostilePath = path.join(tmpDir, "hostile.txt");
		const hostileLine = "the\tanswer \x1b[31mis\x1b[0m here\x07";
		await Bun.write(hostilePath, ["prelude", hostileLine, "epilogue"].join("\n"));
		const judge = new FixtureJudge({ [`${hostilePath}:2-2`]: 30 }, 0.9);
		const result = await run(judge, { query: "where is the answer?", paths: [hostilePath], limit: 1 });

		const text = getText(result);
		expect(text).not.toContain("\x1b");
		expect(text).not.toContain("\x07");
		expect(text).not.toContain("\t");
		expect(text).toContain("*2:the");
		expect(text).toContain("answer is here");
		// Verification compares the raw excerpt against disk, unaffected by display sanitisation.
		expect(result.details?.verification.verified).toBe(true);
	});

	it("resolves internal URLs and keeps their locations addressable by the same URL", async () => {
		await Bun.write(
			path.join(artifactDir, "0.bash.log"),
			["prelude", "the spill threshold is decided in getSpillConfig", "epilogue"].join("\n"),
		);
		const judge = new FixtureJudge({ "artifact://0:2-2": 30 }, 0.92);
		const result = await run(judge, {
			query: "where is the spill threshold decided?",
			paths: ["artifact://0"],
			limit: 2,
		});

		expect(result.details?.results[0]).toMatchObject({ path: "artifact://0", startLine: 2, endLine: 2 });
		expect(getText(result)).toContain("artifact://0:2-2  score ");
		expect(judge.requests[0]?.sources).toContain("artifact://0:2-2");
		expect(result.details?.verification.verified).toBe(true);
	});

	it("reports a re-read mismatch when a source changes between ranking and rendering", async () => {
		const mutablePath = path.join(tmpDir, "mutable.txt");
		await Bun.write(mutablePath, ["first", "the answer", "third"].join("\n"));
		let ranked = false;
		const judge = new (class extends FixtureJudge {
			override async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
				if (!ranked) {
					ranked = true;
					await Bun.write(mutablePath, ["first", "the answer moved", "third"].join("\n"));
				}
				return super.judge(request);
			}
		})({ [`${mutablePath}:2-2`]: 30 }, 0.9);
		const result = await run(judge, { query: "where is the answer?", paths: [mutablePath], limit: 1 });
		expect(result.details?.verification.verified).toBe(false);
		expect(result.details?.verification.detail).toContain(`${mutablePath}:2-2`);
		expect(getText(result)).toContain("verification (false): source changed while ranking");
	});

	it("segments code by indentation-aware blocks and prose by line", async () => {
		const judge = new FixtureJudge({}, 0.8);
		await run(judge, { query: "how is the threshold converted to bytes?", paths: ["spill.ts"], limit: 3 });

		const sources = judge.requests[0]?.sources ?? [];
		expect(sources.length).toBeGreaterThan(0);
		// Blocks span more than one line and never exceed the 12-line cap.
		const spans = sources.map(source => {
			const [start, end] = source.split(":")[1].split("-").map(Number);
			return end - start + 1;
		});
		expect(Math.max(...spans)).toBeGreaterThan(1);
		expect(Math.max(...spans)).toBeLessThanOrEqual(12);
	});

	it("rejects mixed cascade and bounded arguments, and empty inputs, before asking any judge", async () => {
		const tool = new FindTool(makeSession());
		await expect(
			tool.execute("x", { query: "anything", grep_keywords: [], path: "handbook.txt", paths: ["notes.md"] }),
		).rejects.toThrow("pass one, not both");
		await expect(tool.execute("x", { query: "anything", grep_keywords: [], limit: 3 })).rejects.toThrow(
			"apply only to a bounded search",
		);
		// Without a model registry no judge can ever be resolved, so the bounded mode is refused up front.
		await expect(tool.execute("x", { query: "anything", grep_keywords: [], paths: ["notes.md"] })).rejects.toThrow(
			"find has no model registry",
		);
		const judge = new FixtureJudge({}, 0.9);
		await expect(run(judge, { query: "anything", paths: [] })).rejects.toThrow("at least one entry");
		await expect(run(judge, { query: "   ", paths: ["notes.md"] })).rejects.toThrow("non-empty");
		await expect(run(judge, { query: "anything", paths: ["nope-*.zzz"] })).rejects.toThrow(
			"no readable passages in nope-*.zzz (glob matched no files)",
		);
		expect(judge.requests).toHaveLength(0);
	});
});
