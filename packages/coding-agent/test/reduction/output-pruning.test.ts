import { describe, expect, it } from "bun:test";
import type { Answer, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LoopMeter } from "@oh-my-pi/pi-coding-agent/judgment/decision";
import type { ResolvedJudge } from "@oh-my-pi/pi-coding-agent/judgment/index";
import { resolveReductionPolicy, type ReductionJudge } from "@oh-my-pi/pi-coding-agent/reduction/contract";
import type { TaskContext } from "@oh-my-pi/pi-coding-agent/reduction/task-context";
import {
	detectProtectedFormat,
	pruneBashOutput,
	pruneDeterministically,
	pruneSemantically,
	segmentOutput,
} from "@oh-my-pi/pi-coding-agent/reduction/output-pruning";

const tokenizer = { countTokens: (text: string) => Math.ceil(text.length / 4) };

function settings(mode: "off" | "deterministic" | "semantic", overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({
		"bash.outputPruning.mode": mode,
		"bash.outputPruning.minTokens": 0,
		"bash.outputPruning.maxSegments": 40,
		"reduction.egress": "selected",
		"reduction.maxCallsPerPass": 4,
		"reduction.maxLatencyMs": 10_000,
		...overrides,
	} as never);
}

interface OutputState {
	command: string;
	cwd?: string;
	exit_code: number;
	output_head: string;
	output_tail: string;
	segments: Array<{ index: number; line_range: string; text: string }>;
	task: {
		original_request: string;
		latest_request: string;
		latest_reply: string;
		standing_requirements: string[];
	};
}

class ScriptedJudge implements ResolvedJudge {
	readonly kind = "online" as const;
	readonly label = "scripted-output-pruner";
	readonly requests: JudgmentRequest[] = [];
	calls = 0;

	constructor(private readonly probability: (id: string, state: OutputState, call: number) => number) {}

	judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		this.calls++;
		this.requests.push(request);
		const answers: Record<string, Answer> = {};
		const state = request.state as unknown as OutputState;
		for (const id in request.questions) answers[id] = { type: "noul", noul: this.probability(id, state, this.calls) };
		return Promise.resolve({
			api: "scripted",
			provider: "fake",
			model: "fake-output-judge",
			answers,
			usage: tokenUsage(12, 3),
		} as unknown as JudgmentResult<Q>);
	}
}

function admission(judge: ResolvedJudge, configured: Settings, maxCalls = 4): ReductionJudge {
	return {
		judge,
		meter: new LoopMeter({ maxCalls, maxActions: 0, deadlineAt: Date.now() + 10_000 }),
		policy: resolveReductionPolicy(configured),
	};
}
const task: TaskContext = {
	originalRequest: "Build the project and summarize the result.",
	latestRequest: "Run the build now.",
	latestReply: "I am checking the build.",
	requirements: [],
	coverage: "full",
};

function semanticFixture(secret?: string): string {
	return [
		"command started",
		"environment ready",
		"phase begin",
		`routine alpha ${secret ?? "a"}`,
		"routine beta b",
		"routine gamma c",
		"routine delta d",
		"warning: retain this diagnostic",
		"valuable one",
		"valuable two",
		"valuable three",
		"valuable four",
		"tail one",
		"tail two",
		"tail three",
		"tail four",
		"tail five",
		"tail six",
		"tail seven",
		"tail eight",
	].join("\n");
}

function noisyFixture(count = 320): string {
	const firstRun = Math.floor(count / 2);
	return [
		"Error: preserve startup diagnostic",
		"target application",
		"profile release",
		...Array.from(
			{ length: firstRun },
			(_, index) => `Compiling package-${index} with routine dependency metadata and progress details`,
		),
		"warning: preserve this compiler diagnostic",
		...Array.from(
			{ length: count - firstRun },
			(_, index) => `Compiling package-${index + firstRun} with routine dependency metadata and progress details`,
		),
		"src/main.ts:42:7 important location",
		`${count - 1} pass, 1 fail`,
		"tail summary alpha",
		"tail summary beta",
		"tail summary gamma",
		"tail summary delta",
		"tail summary epsilon",
		"tail summary zeta",
	].join("\n");
}

describe("bash output pruning", () => {
	it("leaves disabled, below-threshold, and protected formats untouched", async () => {
		const baseline = noisyFixture();
		let archives = 0;
		const off = await pruneBashOutput({
			baseline,
			command: "build",
			exitCode: 0,
			tokenizer,
			settings: settings("off"),
			archive: async () => {
				archives++;
				return "1";
			},
		});
		expect(off.visible).toBe(baseline);
		expect(off.receipt).toBeUndefined();

		const below = await pruneBashOutput({
			baseline: "short",
			command: "echo short",
			exitCode: 0,
			tokenizer,
			settings: settings("deterministic", { "bash.outputPruning.minTokens": 100 }),
			archive: async () => {
				archives++;
				return "2";
			},
		});
		expect(below.visible).toBe("short");
		expect(below.receipt?.skipped?.reason).toBe("below-threshold");

		const json = JSON.stringify({ values: Array.from({ length: 500 }, (_, index) => index) }, null, 2);
		const protectedResult = await pruneBashOutput({
			baseline: json,
			command: "cat values.json",
			exitCode: 0,
			tokenizer,
			settings: settings("deterministic"),
			archive: async () => {
				archives++;
				return "3";
			},
		});
		expect(protectedResult.visible).toBe(json);
		expect(protectedResult.receipt?.skipped?.reason).toBe("protected-format");
		expect(detectProtectedFormat("```ts\nconst x = 1;\n```")?.reason).toBe("protected-format");
		const guarded = [
			"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
			"| name | value |\n| --- | --- |\n| a | b |",
			"plain\u0000binary",
		];
		for (const protectedBaseline of guarded) {
			const protectedFormat = await pruneBashOutput({
				baseline: protectedBaseline,
				command: "cat output",
				exitCode: 0,
				tokenizer,
				settings: settings("deterministic"),
				archive: async () => {
					archives++;
					return "guarded";
				},
			});
			expect(protectedFormat.visible).toBe(protectedBaseline);
			expect(protectedFormat.receipt?.skipped?.reason).toBe("protected-format");
		}
		expect(archives).toBe(0);
	});

	it("guards structured command output before Bash notices are appended", async () => {
		const output = JSON.stringify(
			[1, "two", true, false, null, ...Array.from({ length: 500 }, (_, index) => index)],
			null,
			2,
		);
		const baseline = `${output}\n\nWall time: 0.05 seconds`;
		const configured = settings("semantic");
		const judge = new ScriptedJudge(id => (id.startsWith("omit_") ? 0.99 : 0));
		const result = await pruneBashOutput({
			baseline,
			output,
			command: "jq '.' data.json",
			exitCode: 0,
			tokenizer,
			settings: configured,
			admission: admission(judge, configured),
			archive: async () => "unused",
		});
		expect(result.visible).toBe(baseline);
		expect(result.receipt?.skipped?.reason).toBe("protected-format");
		expect(judge.calls).toBe(0);
		expect(detectProtectedFormat('[\n1,\n"two",\ntrue,\nnull,\n]')?.detail).toBe("JSON-like output");
	});

	it("protects diagnostic class names and never offers them as semantic candidates", async () => {
		const baseline = [
			"head one",
			"head two",
			"head three",
			...Array.from({ length: 20 }, (_, index) => `routine before ${index}`),
			"TypeError: exploded in the middle",
			...Array.from({ length: 20 }, (_, index) => `routine after ${index}`),
			"tail one",
			"tail two",
			"tail three",
			"tail four",
			"tail five",
			"tail six",
			"tail seven",
			"tail eight",
		].join("\n");
		const segments = segmentOutput(baseline);
		expect(segments.find(segment => segment.text.includes("TypeError"))?.kind).toBe("protected");
		const configured = settings("semantic");
		const judge = new ScriptedJudge(() => 0);
		await pruneSemantically({
			baseline,
			command: "run workload",
			exitCode: 0,
			segments,
			maxSegments: 40,
			task,
			admission: admission(judge, configured),
		});
		const state = judge.requests[0]?.state as unknown as OutputState;
		expect(state.segments.some(segment => segment.text.includes("TypeError"))).toBeFalse();
	});

	it("protects bracketed log-level tags so a routine run around them is still offered without them", async () => {
		const baseline = [
			"$ ./worker --verbose",
			"booting",
			"ready",
			...Array.from({ length: 30 }, (_, index) => `[INFO] worker processed batch ${index}`),
			"[WARN] storage backend retried 3 times; falling back to local cache",
			...Array.from({ length: 30 }, (_, index) => `[INFO] worker processed batch ${30 + index}`),
			...Array.from({ length: 8 }, (_, index) => `tail ${index}`),
		].join("\n");
		const segments = segmentOutput(baseline);
		expect(segments.find(segment => segment.text.includes("[WARN]"))?.kind).toBe("protected");
		const configured = settings("semantic");
		const judge = new ScriptedJudge(id => (id.startsWith("omit_") ? 0.95 : 0.05));
		const result = await pruneSemantically({
			baseline,
			command: "./worker --verbose",
			exitCode: 0,
			segments,
			maxSegments: 40,
			task,
			admission: admission(judge, configured),
		});
		const state = judge.requests[0]?.state as unknown as OutputState;
		expect(state.segments).toHaveLength(2);
		expect(state.segments.some(segment => segment.text.includes("[WARN]"))).toBeFalse();
		// Both routine runs go; the warning line between them is untouched.
		expect(result.omittedSpans).toHaveLength(2);
		for (const span of result.omittedSpans) expect(baseline.slice(span.start, span.end)).not.toContain("[WARN]");
	});

	it("never sends a span over the segment bound and splits batches by request size", async () => {
		const huge = Array.from(
			{ length: 1_200 },
			(_, index) => `oversized routine line ${index} ${"x".repeat(40)}`,
		).join("\n");
		const medium = (tag: string) =>
			Array.from({ length: 400 }, (_, index) => `${tag} routine line ${index} ${"y".repeat(40)}`).join("\n");
		const baseline = [
			"h1",
			"h2",
			"h3",
			huge,
			"Error: boundary",
			medium("alpha"),
			"Error: boundary two",
			medium("beta"),
			"Error: boundary three",
			medium("gamma"),
			...Array.from({ length: 8 }, (_, index) => `tail ${index}`),
		].join("\n");
		expect(huge.length).toBeGreaterThan(40_000);
		const configured = settings("semantic");
		const judge = new ScriptedJudge(id => (id.startsWith("omit_") ? 0.95 : 0.05));
		const result = await pruneSemantically({
			baseline,
			command: "run",
			exitCode: 0,
			segments: segmentOutput(baseline),
			maxSegments: 40,
			task,
			admission: admission(judge, configured, 4),
		});
		const sent = judge.requests.flatMap(request => (request.state as unknown as OutputState).segments);
		expect(sent.some(segment => segment.text.includes("oversized"))).toBeFalse();
		expect(sent.map(segment => segment.text.slice(0, 5)).sort()).toEqual(["alpha", "beta ", "gamma"]);
		for (const request of judge.requests) {
			const state = request.state as unknown as OutputState;
			const chars = state.segments.reduce((total, segment) => total + segment.text.length, 0);
			expect(chars).toBeLessThanOrEqual(60_000);
		}
		expect(judge.calls).toBeGreaterThan(1);
		expect(result.omittedSpans).toHaveLength(3);
		expect(result.omittedSpans.some(span => baseline.slice(span.start, span.end).includes("oversized"))).toBeFalse();
	});

	it("prunes a long compile run, preserves evidence, and archives the exact baseline", async () => {
		const baseline = noisyFixture();
		let archived = "";
		const result = await pruneBashOutput({
			baseline,
			command: "bun run build",
			cwd: "/repo",
			exitCode: 0,
			tokenizer,
			settings: settings("deterministic"),
			task,
			archive: async text => {
				archived = text;
				return "77";
			},
		});
		expect(archived).toBe(baseline);
		expect(result.visible.match(/recognized-noise/gu)).toHaveLength(2);
		expect(result.visible).toContain("Error: preserve startup diagnostic");
		expect(result.visible).toContain("warning: preserve this compiler diagnostic");
		expect(result.visible).toContain("319 pass, 1 fail");
		expect(result.visible).toContain("[pruned output:");
		expect(result.visible).toContain("original: artifact://77]");
		expect(result.receipt?.source.contentHash).toHaveLength(64);
		expect(result.receipt?.source.originalArtifactId).toBe("77");
		expect(result.receipt?.baselineTokens).toBeGreaterThan(result.receipt?.visibleTokens ?? 0);
	});

	it("collapses repeated and blank runs while retaining the first repeated line", async () => {
		const repeated = "same progress with enough detail to make each repeated line materially long";
		const baseline = [
			"h1",
			"h2",
			"h3",
			...Array(80).fill(repeated),
			...Array(60).fill(""),
			"t1",
			"t2",
			"t3",
			"t4",
			"t5",
			"t6",
			"t7",
			"t8",
		].join("\n");
		const deterministic = pruneDeterministically(segmentOutput(baseline));
		expect(deterministic.omittedSpans.some(span => span.reason.startsWith("repeated-line ×"))).toBeTrue();
		expect(deterministic.omittedSpans.some(span => span.reason.startsWith("blank-run ×"))).toBeTrue();
		const result = await pruneBashOutput({
			baseline,
			command: "repeat output",
			exitCode: 0,
			tokenizer,
			settings: settings("deterministic"),
			archive: async () => "repeat",
		});
		expect(result.visible).toContain(repeated);
		expect(result.visible.split(repeated)).toHaveLength(2);
	});

	it("sends one multi-question request with complete segments and egress-safe text", async () => {
		const rawSecret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
		const baseline = semanticFixture(rawSecret);
		const configured = settings("semantic");
		const judge = new ScriptedJudge(id => (id === "omit_0" ? 0.9 : id === "omit_1" ? 0.6 : 0.1));
		const result = await pruneSemantically({
			baseline,
			command: `run --token ${rawSecret}`,
			cwd: "/repo",
			exitCode: 0,
			segments: segmentOutput(baseline),
			maxSegments: 40,
			admission: admission(judge, configured),
			task,
		});
		expect(judge.calls).toBe(1);
		const request = judge.requests[0];
		expect(Object.keys(request?.questions ?? {})).toEqual(["needs_every_line", "omit_0", "omit_1"]);
		const state = request?.state as unknown as OutputState;
		expect(state.task).toEqual({
			original_request: task.originalRequest,
			latest_request: task.latestRequest,
			latest_reply: task.latestReply,
			standing_requirements: [],
		});
		expect(state.segments[0]?.text.split("\n").filter(Boolean)).toHaveLength(4);
		expect(JSON.stringify(request)).not.toContain(rawSecret);
		expect(result.omittedSpans).toHaveLength(1);
		expect(admission(judge, configured).policy.egress).toBe("selected");
	});

	it("batches candidates, records attempts, and preserves unjudged remainder on budget exhaustion", async () => {
		const baseline = [
			"h1",
			"h2",
			"h3",
			"alpha 1",
			"alpha 2",
			"alpha 3",
			"warning: split one",
			"beta 1",
			"beta 2",
			"beta 3",
			"warning: split two",
			"gamma 1",
			"gamma 2",
			"gamma 3",
			"t1",
			"t2",
			"t3",
			"t4",
			"t5",
			"t6",
			"t7",
			"t8",
		].join("\n");
		const configured = settings("semantic");
		const judge = new ScriptedJudge(id => (id.startsWith("omit_") ? 0.95 : 0.05));
		const admitted = admission(judge, configured, 1);
		const result = await pruneSemantically({
			baseline,
			command: "run",
			exitCode: 0,
			segments: segmentOutput(baseline),
			maxSegments: 1,
			task,
			admission: admitted,
		});
		expect(judge.calls).toBe(1);
		expect(result.omittedSpans).toHaveLength(1);
		expect(result.skipped?.reason).toBe("budget-exhausted");
		expect(admitted.meter.attempts).toHaveLength(1);
		expect(Object.keys(judge.requests[0]?.questions ?? {})).toContain("needs_every_line");
		const completeJudge = new ScriptedJudge(id => (id.startsWith("omit_") ? 0.95 : 0.05));
		await pruneSemantically({
			baseline,
			command: "run",
			exitCode: 0,
			segments: segmentOutput(baseline),
			maxSegments: 1,
			task,
			admission: admission(completeJudge, configured, 4),
		});
		expect(completeJudge.calls).toBe(3);
		expect(Object.keys(completeJudge.requests[0]?.questions ?? {})).toContain("needs_every_line");
		for (const request of completeJudge.requests.slice(1))
			expect(Object.keys(request.questions)).not.toContain("needs_every_line");
	});

	it("lets needs_every_line override every proposed omission", async () => {
		const baseline = semanticFixture();
		const configured = settings("semantic");
		const judge = new ScriptedJudge(id => (id === "needs_every_line" ? 0.7 : 0.99));
		const result = await pruneSemantically({
			baseline,
			command: "enumerate all",
			exitCode: 0,
			segments: segmentOutput(baseline),
			maxSegments: 40,
			task,
			admission: admission(judge, configured),
		});
		expect(result.preserveAll).toBeTrue();
		expect(result.omittedSpans).toEqual([]);
		expect(result.skipped?.reason).toBe("judge-preserved");
	});

	it("keeps everything when needs_every_line is unanswered and keeps any span whose omit answer is missing", async () => {
		const baseline = semanticFixture();
		const configured = settings("semantic");
		// Judge answers only omit_0 (confidently) and nothing else.
		class PartialJudge extends ScriptedJudge {
			override judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
				this.calls++;
				this.requests.push(request);
				const answers: Record<string, Answer> = { omit_0: { type: "noul", noul: 0.99 } };
				return Promise.resolve({
					api: "scripted",
					provider: "fake",
					model: "fake-output-judge",
					answers,
					usage: tokenUsage(12, 3),
				} as unknown as JudgmentResult<Q>);
			}
		}
		const noGuard = new PartialJudge(() => 0);
		const guardless = await pruneSemantically({
			baseline,
			command: "run",
			exitCode: 0,
			segments: segmentOutput(baseline),
			maxSegments: 40,
			task,
			admission: admission(noGuard, configured),
		});
		expect(guardless.preserveAll).toBeTrue();
		expect(guardless.omittedSpans).toEqual([]);
		expect(guardless.skipped?.reason).toBe("judge-unavailable");

		// Guard answered low, omit_1 missing, omit_0 answered: only segment 0 goes.
		class MissingOmitJudge extends ScriptedJudge {
			override judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
				this.calls++;
				this.requests.push(request);
				const answers: Record<string, Answer> = {
					needs_every_line: { type: "noul", noul: 0.1 },
					omit_0: { type: "noul", noul: 0.99 },
				};
				return Promise.resolve({
					api: "scripted",
					provider: "fake",
					model: "fake-output-judge",
					answers,
					usage: tokenUsage(12, 3),
				} as unknown as JudgmentResult<Q>);
			}
		}
		const partial = await pruneSemantically({
			baseline,
			command: "run",
			exitCode: 0,
			segments: segmentOutput(baseline),
			maxSegments: 40,
			task,
			admission: admission(new MissingOmitJudge(() => 0), configured),
		});
		expect(partial.omittedSpans.map(span => span.reason)).toEqual(["omit_0"]);
	});

	it("shows rule-omitted runs to the judge so needs_every_line can bring them back", async () => {
		const baseline = noisyFixture();
		const configured = settings("semantic");
		const segments = segmentOutput(baseline);
		const rules = pruneDeterministically(segments).omittedSpans;
		expect(rules.length).toBeGreaterThan(0);
		const judge = new ScriptedJudge(id => (id === "needs_every_line" ? 0.9 : 0.99));
		const result = await pruneSemantically({
			baseline,
			command: "cargo build",
			exitCode: 0,
			segments,
			alreadyOmitted: rules,
			maxSegments: 40,
			task: { ...task, requirements: [] },
			admission: admission(judge, configured),
		});
		expect(judge.calls).toBe(1);
		const state = judge.requests[0]?.state as unknown as OutputState;
		// The compile runs the rules removed are in the state, complete, but not re-asked as omit questions.
		expect(state.segments.some(segment => segment.text.includes("Compiling package-0 "))).toBeTrue();
		expect(Object.keys(judge.requests[0]?.questions ?? {})).toEqual(["needs_every_line"]);
		expect(result.preserveAll).toBeTrue();
		// End to end: the baseline is what the model sees.
		const whole = await pruneBashOutput({
			baseline,
			command: "cargo build",
			exitCode: 0,
			tokenizer,
			settings: configured,
			task,
			admission: admission(new ScriptedJudge(id => (id === "needs_every_line" ? 0.9 : 0.99)), configured),
			archive: async () => "unused",
		});
		expect(whole.visible).toBe(baseline);
		expect(whole.receipt?.skipped?.reason).toBe("judge-preserved");
	});

	it("records egress denial without invoking a judge and reverts when archive fails", async () => {
		const baseline = noisyFixture();
		const configured = settings("semantic", { "reduction.egress": "off" });
		const deniedJudge = new ScriptedJudge(() => 1);
		const noEgress = await pruneBashOutput({
			baseline,
			command: "build",
			exitCode: 0,
			tokenizer,
			settings: configured,
			task,
			admission: admission(deniedJudge, configured),
			archive: async () => "10",
		});
		expect(noEgress.receipt?.stages.at(-1)?.skipped?.reason).toBe("egress-disabled");
		expect(deniedJudge.calls).toBe(0);

		const failedArchive = await pruneBashOutput({
			baseline,
			command: "build",
			exitCode: 0,
			tokenizer,
			settings: settings("deterministic"),
			task,
			archive: async () => undefined,
		});
		expect(failedArchive.visible).toBe(baseline);
		expect(failedArchive.receipt?.skipped?.reason).toBe("archive-failed");

		const rejectedArchive = await pruneBashOutput({
			baseline,
			command: "build",
			exitCode: 0,
			tokenizer,
			settings: settings("deterministic"),
			task,
			archive: async () => {
				throw new Error("disk unavailable");
			},
		});
		expect(rejectedArchive.visible).toBe(baseline);
		expect(rejectedArchive.receipt?.skipped).toEqual({ reason: "archive-failed", detail: "disk unavailable" });
	});

	it("reverts reductions below the absolute savings floor without archiving", async () => {
		const baseline = [
			"h1",
			"h2",
			"h3",
			...Array(50).fill("routine repeat"),
			"t1",
			"t2",
			"t3",
			"t4",
			"t5",
			"t6",
			"t7",
			"t8",
		].join("\n");
		let archiveCalled = false;
		const result = await pruneBashOutput({
			baseline,
			command: "repeat",
			exitCode: 0,
			tokenizer,
			settings: settings("deterministic"),
			archive: async () => {
				archiveCalled = true;
				return "unused";
			},
		});
		expect(result.visible).toBe(baseline);
		expect(result.receipt?.skipped?.reason).toBe("no-useful-reduction");
		expect(archiveCalled).toBeFalse();
	});
	it("keeps every retained byte stable and ordered across CRLF, tabs, and emoji", async () => {
		const baseline = [
			"α\theader",
			"β\theader",
			"γ\theader",
			...Array(400).fill("⠋\t50%"),
			"tail\t1",
			"tail\t2",
			"tail\t3",
			"tail\t4",
			"tail\t5",
			"tail\t6",
			"tail\t7",
			"tail\t8",
		].join("\r\n");
		const segments = segmentOutput(baseline);
		expect(segments.map(segment => segment.text).join("")).toBe(baseline);
		for (let index = 1; index < segments.length; index++) {
			expect(segments[index]?.start).toBe(segments[index - 1]?.end);
		}
		const result = await pruneBashOutput({
			baseline,
			command: "run progress",
			exitCode: 0,
			tokenizer,
			task,
			settings: settings("deterministic"),
			archive: async () => "crlf",
		});
		expect(result.receipt?.omittedSpans.length).toBeGreaterThan(0);
		let visibleCursor = 0;
		for (const span of result.receipt?.keptSpans ?? []) {
			const retained = baseline.slice(span.start, span.end);
			const visibleAt = result.visible.indexOf(retained, visibleCursor);
			expect(visibleAt).toBeGreaterThanOrEqual(visibleCursor);
			visibleCursor = visibleAt + retained.length;
		}
	});
});
