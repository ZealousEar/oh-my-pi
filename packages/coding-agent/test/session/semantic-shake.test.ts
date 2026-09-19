import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, DEFAULT_SHAKE_CONFIG } from "@oh-my-pi/pi-agent-core";
import type { ShakeConfig } from "@oh-my-pi/pi-agent-core/compaction";
import type {
	Answer,
	AssistantMessage,
	JudgmentRequest,
	JudgmentResult,
	NoulQuestion,
	Questions,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LoopMeter } from "@oh-my-pi/pi-coding-agent/judgment/decision";
import type { ResolvedJudge } from "@oh-my-pi/pi-coding-agent/judgment/index";
import { resolveReductionPolicy } from "@oh-my-pi/pi-coding-agent/reduction/contract";
import type { ShakeJudgeAdmission } from "@oh-my-pi/pi-coding-agent/reduction/semantic-shake";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { resolveCompactionMethodOrder } from "@oh-my-pi/pi-coding-agent/session/compaction-methods";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { formatShakeSummary, type ShakeResult } from "@oh-my-pi/pi-coding-agent/session/shake-types";
import { TempDir } from "@oh-my-pi/pi-utils";

const usage = {
	input: 16,
	output: 8,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 24,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Judged region as it appears in the request state. */
interface RegionState {
	index: number;
	tool: string;
	call: string;
	tokens: number;
	text: string;
}

interface ShakeState {
	goal: { original_request: string; latest_request: string; latest_reply: string; standing_requirements: string[] };
	regions: RegionState[];
}

/**
 * In-memory judge answering every `keep_<i>` Noul from the region text it
 * was shown: `probabilityFor(text)`; `undefined` leaves that question
 * unanswered. Never touches a network.
 */
class ScriptedNoulJudge implements ResolvedJudge {
	readonly kind = "online" as const;
	readonly label = "scripted";
	calls = 0;
	readonly requests: JudgmentRequest[] = [];

	constructor(private readonly probabilityFor: (text: string) => number | undefined) {}

	judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		this.calls++;
		this.requests.push(request);
		const state = request.state as unknown as ShakeState;
		const answers: Record<string, Answer> = {};
		for (const id in request.questions) {
			const question = request.questions[id];
			if (question?.type !== "noul") throw new Error(`unexpected question type for ${id}`);
			const index = Number(id.slice("keep_".length));
			const region = state.regions[index];
			if (!region) throw new Error(`question ${id} names no region`);
			const noul = this.probabilityFor(region.text);
			if (noul !== undefined) answers[id] = { type: "noul", noul };
		}
		const result = { api: "scripted", provider: "fake", model: "fake-judge", answers, usage: tokenUsage(12, 3) };
		return Promise.resolve(result as unknown as JudgmentResult<Q>);
	}

	/** Every request state, typed. */
	states(): ShakeState[] {
		return this.requests.map(request => request.state as unknown as ShakeState);
	}

	/** Every region text sent in any request. */
	sentTexts(): string[] {
		return this.states().flatMap(state => state.regions.map(region => region.text));
	}
}

/** Admission that hands out `judge` under a fresh meter of `maxCalls`. */
function admit(judge: ResolvedJudge, maxCalls = 3): ShakeJudgeAdmission {
	return deps => ({
		judge,
		meter: new LoopMeter({ maxCalls, maxActions: 0, deadlineAt: Date.now() + 10_000 }),
		policy: resolveReductionPolicy(deps.settings),
	});
}

/** Everything on the branch is eligible: no protect window, no savings gate. */
const OPEN_CONFIG: ShakeConfig = { ...DEFAULT_SHAKE_CONFIG, protectTokens: 0, minSavings: 0 };

describe("AgentSession shake semantic", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let settings: Settings;
	let events: AgentSessionEvent[];
	let apiInfo: { api: AssistantMessage["api"]; provider: AssistantMessage["provider"]; model: string };

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-semantic-shake-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		apiInfo = { api: model.api, provider: model.provider, model: model.id };

		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		settings = Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false });
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		session.subscribe(event => events.push(event));
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	function appendUser(text: string): void {
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	}

	function appendAssistantText(text: string): void {
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
			...apiInfo,
			stopReason: "stop",
			usage,
			timestamp: Date.now(),
		});
	}

	/** Seed an assistant(toolCall) → toolResult pair; the call's arguments are what the judge sees as `call`. */
	function seedToolResult(
		text: string,
		toolName = "bash",
		args: Record<string, unknown> = { command: "ls" },
		options: { details?: unknown; isError?: boolean } = {},
	): string {
		const toolCallId = `call_${toolName}_${Math.random().toString(36).slice(2)}`;
		sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "working" },
				{ type: "toolCall", id: toolCallId, name: toolName, arguments: args },
			],
			...apiInfo,
			stopReason: "toolUse",
			usage,
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			...(options.details === undefined ? {} : { details: options.details }),
			isError: options.isError === true,
			timestamp: Date.now(),
		});
		return toolCallId;
	}

	function branchToolResults(): ToolResultMessage[] {
		return sessionManager
			.getBranch()
			.filter(e => e.type === "message" && (e.message as { role?: string }).role === "toolResult")
			.map(e => (e as { message: ToolResultMessage }).message);
	}

	function resultText(message: ToolResultMessage): string {
		return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
	}

	function expectUntouched(message: ToolResultMessage, text: string): void {
		expect(resultText(message)).toBe(text);
		expect(message.prunedAt).toBeUndefined();
		expect(message.details).toBeUndefined();
	}

	async function archivedText(artifactId: string | undefined): Promise<string> {
		if (!artifactId) throw new Error("Expected shake artifact");
		const artifactPath = await sessionManager.getArtifactPath(artifactId);
		if (!artifactPath) throw new Error("Expected persisted shake artifact");
		return Bun.file(artifactPath).text();
	}

	const NEEDED = `needed: the port is 8443\n${"detail ".repeat(400)}`;
	const CONSUMED = `consumed: install log\n${"line ".repeat(400)}`;
	const keepNeeded = (text: string) => (text.startsWith("needed") ? 0.7 : 0.3);

	it("composes one request per batch: complete region text, bounded goal, one keep_<i> Noul per region", async () => {
		settings.set("compaction.semanticShake.maxRegionsPerCall", 2);
		settings.set("reduction.taskContextChars", 24);
		const request = "Please fix the TLS listener so the health check passes on the configured port.";
		appendUser(request);
		const first = `first ${"a ".repeat(500)}`;
		const second = `second ${"b ".repeat(300)}`;
		const third = `third ${"c ".repeat(100)}`;
		seedToolResult(first, "bash", { command: "cat config.yml" });
		seedToolResult(second, "read", { path: "src/server.ts" });
		seedToolResult(third, "grep", { pattern: "listen" });
		const reply = `Progress so far: ${"x".repeat(100)} END`;
		appendAssistantText(reply);
		const judge = new ScriptedNoulJudge(() => 0.9);

		const result = await session.shake("semantic", { config: OPEN_CONFIG, admitJudge: admit(judge) });

		expect(judge.calls).toBe(2);
		const [batch1, batch2] = judge.states();
		// Largest first, batched by maxRegionsPerCall.
		expect(batch1.regions.map(r => r.text)).toEqual([first, second]);
		expect(batch2.regions.map(r => r.text)).toEqual([third]);
		expect(batch1.regions.map(r => r.index)).toEqual([0, 1]);
		expect(batch1.regions[0]).toMatchObject({ tool: "bash", call: expect.stringContaining("cat config.yml") });
		expect(batch1.regions[1]).toMatchObject({ tool: "read", call: expect.stringContaining("src/server.ts") });
		expect(batch1.regions[0].tokens).toBeGreaterThan(0);
		// Goal context is bounded: requests keep their head, the reply its tail.
		expect(batch1.goal.original_request).toBe(request.slice(0, 24));
		expect(batch1.goal.latest_request).toBe(request.slice(0, 24));
		expect(batch1.goal.latest_reply).toBe(reply.slice(-24));
		expect(batch1.goal.standing_requirements).toEqual([]);
		expect(batch2.goal).toEqual(batch1.goal);
		// One Noul per region, keyed keep_<i>, with explicit criteria.
		expect(Object.keys(judge.requests[0].questions).sort()).toEqual(["keep_0", "keep_1"]);
		expect(Object.keys(judge.requests[1].questions)).toEqual(["keep_0"]);
		for (const request of judge.requests) {
			for (const question of Object.values(request.questions) as NoulQuestion[]) {
				expect(question.type).toBe("noul");
				expect(question.instructions.length).toBeGreaterThan(0);
				expect(typeof question.criteria?.true).toBe("string");
				expect(typeof question.criteria?.false).toBe("string");
			}
		}
		expect(result.selection).toMatchObject({
			candidates: 3,
			keptByJudge: 3,
			elided: 0,
			calls: 2,
			distribution: "synthetic",
		});
		expect(result.toolResultsDropped).toBe(0);
	});

	it("keeps regions at keep_i ≥ 0.5 untouched and elides a cleared one with a recovery placeholder and receipts", async () => {
		appendUser("finish the TLS listener");
		seedToolResult(NEEDED);
		seedToolResult(CONSUMED);
		const judge = new ScriptedNoulJudge(keepNeeded);

		const result = await session.shake("semantic", { config: OPEN_CONFIG, admitJudge: admit(judge) });

		expect(result.mode).toBe("semantic");
		expect(result.toolResultsDropped).toBe(1);
		expect(result.artifactId).toBeDefined();
		expect(result.selection).toMatchObject({
			candidates: 2,
			keptByJudge: 1,
			keptUncertain: 0,
			keptDuplicate: 0,
			keptProtected: 0,
			keptUnjudged: 0,
			elided: 1,
			calls: 1,
		});
		const [kept, elided] = branchToolResults();
		expectUntouched(kept, NEEDED);
		expect(elided.prunedAt).toBeGreaterThan(0);
		expect(resultText(elided)).toContain(`artifact://${result.artifactId}`);
		expect(resultText(elided)).toContain("shaken");
		const archived = await archivedText(result.artifactId);
		expect(archived).toContain(CONSUMED);
		expect(archived).not.toContain(NEEDED);
		// Receipts: one per candidate; the elided result carries its own beside the placeholder.
		const receipts = result.receipts ?? [];
		expect(receipts.map(r => r.source.identity).sort()).toEqual([kept.toolCallId, elided.toolCallId].sort());
		const elidedReceipt = receipts.find(r => r.source.identity === elided.toolCallId);
		expect(elidedReceipt).toMatchObject({
			version: 1,
			source: { kind: "tool-result", originalArtifactId: result.artifactId },
			recovery: { locator: `artifact://${result.artifactId}` },
			keptSpans: [],
			omittedSpans: [{ start: 0, end: CONSUMED.length, reason: "judge", probability: 0.3 }],
		});
		expect(elidedReceipt?.skipped).toBeUndefined();
		expect(elidedReceipt?.visibleTokens).toBeLessThan(elidedReceipt?.baselineTokens ?? 0);
		expect(elidedReceipt?.decisions.map(d => d.model)).toEqual(["fake-judge"]);
		expect((elided.details as { shake?: unknown } | undefined)?.shake).toEqual(elidedReceipt);
		const keptReceipt = receipts.find(r => r.source.identity === kept.toolCallId);
		expect(keptReceipt).toMatchObject({
			keptSpans: [{ start: 0, end: NEEDED.length }],
			omittedSpans: [],
			skipped: { reason: "no-useful-reduction", detail: "kept by judge" },
		});
	});

	it("keeps the baseline untouched when no recovery artifact can be written", async () => {
		appendUser("finish the TLS listener");
		seedToolResult(NEEDED);
		seedToolResult(CONSUMED);
		const judge = new ScriptedNoulJudge(keepNeeded);
		vi.spyOn(sessionManager, "allocateArtifactPath").mockRejectedValue(new Error("disk full"));
		vi.spyOn(sessionManager, "saveArtifact").mockResolvedValue(undefined as unknown as string);

		const result = await session.shake("semantic", { config: OPEN_CONFIG, admitJudge: admit(judge) });

		expect(result.toolResultsDropped).toBe(0);
		expect(result.artifactId).toBeUndefined();
		expect(result.selection).toMatchObject({ skipped: "archive-failed", elided: 0, keptUnjudged: 1, keptByJudge: 1 });
		const [first, second] = branchToolResults();
		expectUntouched(first, NEEDED);
		expectUntouched(second, CONSUMED);
		// Nothing was removed, so no receipt may claim an omission; the cleared region is kept unjudged.
		for (const receipt of result.receipts ?? []) {
			expect(receipt.omittedSpans).toEqual([]);
			expect(receipt.visibleTokens).toBe(receipt.baselineTokens);
		}
		const consumedReceipt = result.receipts?.find(r => r.source.identity === second.toolCallId);
		expect(consumedReceipt?.skipped?.reason).toBe("archive-failed");
	});

	it("shares one decision between regions with identical contents, elided twins included", async () => {
		appendUser("finish the TLS listener");
		seedToolResult(NEEDED);
		seedToolResult(CONSUMED);
		seedToolResult(NEEDED);
		seedToolResult(CONSUMED);
		const judge = new ScriptedNoulJudge(keepNeeded);

		const result = await session.shake("semantic", { config: OPEN_CONFIG, admitJudge: admit(judge) });

		expect(judge.calls).toBe(1);
		expect(Object.keys(judge.requests[0].questions)).toHaveLength(2);
		expect(judge.sentTexts().sort()).toEqual([CONSUMED, NEEDED].sort());
		expect(result.selection).toMatchObject({ candidates: 4, keptByJudge: 1, keptDuplicate: 1, elided: 2 });
		const texts = branchToolResults().map(resultText);
		expect(texts[0]).toBe(NEEDED);
		expect(texts[2]).toBe(NEEDED);
		expect(texts[1]).toContain("shaken");
		expect(texts[3]).toContain("shaken");
		const bases = (result.receipts ?? []).map(r => r.skipped?.detail ?? `elided:${r.omittedSpans[0]?.reason}`).sort();
		expect(bases).toEqual(["elided:judge", "elided:judge", "kept by duplicate", "kept by judge"]);
	});

	it("keeps every candidate unjudged, sends nothing, and writes no artifact when reduction.egress is off", async () => {
		appendUser("finish the TLS listener");
		seedToolResult(NEEDED);
		seedToolResult(CONSUMED);
		expect(settings.get("reduction.egress")).toBe("off");
		const allocate = vi.spyOn(sessionManager, "allocateArtifactPath");

		const result = await session.shake("semantic", { config: OPEN_CONFIG });

		expect(result.toolResultsDropped).toBe(0);
		expect(result.artifactId).toBeUndefined();
		expect(allocate).not.toHaveBeenCalled();
		expect(result.selection).toMatchObject({
			candidates: 2,
			keptByJudge: 0,
			keptUnjudged: 2,
			elided: 0,
			calls: 0,
			skipped: "egress-disabled",
		});
		expect(result.selection?.distribution).toBeUndefined();
		const [first, second] = branchToolResults();
		expectUntouched(first, NEEDED);
		expectUntouched(second, CONSUMED);
		for (const receipt of result.receipts ?? []) {
			expect(receipt.skipped).toMatchObject({ reason: "egress-disabled" });
			expect(receipt.omittedSpans).toEqual([]);
		}
	});

	it("applies the first batch's decisions and keeps the unjudged remainder when the call budget runs out", async () => {
		settings.set("compaction.semanticShake.maxRegionsPerCall", 1);
		appendUser("finish the TLS listener");
		const consumedLarge = `consumed: ${"line ".repeat(900)}`;
		seedToolResult(NEEDED);
		seedToolResult(consumedLarge);
		seedToolResult(CONSUMED);
		const judge = new ScriptedNoulJudge(keepNeeded);

		const result = await session.shake("semantic", { config: OPEN_CONFIG, admitJudge: admit(judge, 1) });

		// Largest first: only the large consumed result was judged before the budget ran out.
		expect(judge.calls).toBe(1);
		expect(judge.sentTexts()).toEqual([consumedLarge]);
		expect(result.selection).toMatchObject({ candidates: 3, keptByJudge: 0, keptUnjudged: 2, elided: 1, calls: 1 });
		expect(result.selection?.skipped).toBeUndefined();
		expect(result.toolResultsDropped).toBe(1);
		const [needed, elided, consumed] = branchToolResults();
		expectUntouched(needed, NEEDED);
		expectUntouched(consumed, CONSUMED);
		expect(elided.prunedAt).toBeGreaterThan(0);
		const archived = await archivedText(result.artifactId);
		expect(archived).toContain(consumedLarge);
		expect(archived).not.toContain(NEEDED);
		expect(archived).not.toContain(CONSUMED);
		const unjudged = (result.receipts ?? []).filter(r => r.source.identity !== elided.toolCallId);
		expect(unjudged.map(r => r.skipped?.reason)).toEqual(["budget-exhausted", "budget-exhausted"]);
	});

	it("never sends error results or results carrying diagnostics or verification receipts; they stay verbatim", async () => {
		appendUser("finish the TLS listener");
		const failed = `boom ${"x ".repeat(300)}`;
		const receipt = `12 pass\n 1 fail\n${"line ".repeat(300)}`;
		const diagnostic = `TypeError: listener is not a function\n${"frame ".repeat(300)}`;
		seedToolResult(failed, "bash", { command: "make" }, { isError: true });
		seedToolResult(receipt, "bash", { command: "bun test" });
		seedToolResult(diagnostic, "bash", { command: "node server.js" });
		seedToolResult(CONSUMED);
		const judge = new ScriptedNoulJudge(() => 0.1);

		const result = await session.shake("semantic", { config: OPEN_CONFIG, admitJudge: admit(judge) });

		expect(judge.calls).toBe(1);
		expect(judge.sentTexts()).toEqual([CONSUMED]);
		expect(JSON.stringify(judge.requests)).not.toContain("boom");
		expect(JSON.stringify(judge.requests)).not.toContain("1 fail");
		expect(JSON.stringify(judge.requests)).not.toContain("TypeError");
		expect(result.selection).toMatchObject({ candidates: 4, keptProtected: 3, elided: 1, calls: 1 });
		const [error, receiptResult, diagnosticResult, consumed] = branchToolResults();
		expectUntouched(error, failed);
		expectUntouched(receiptResult, receipt);
		expectUntouched(diagnosticResult, diagnostic);
		expect(consumed.prunedAt).toBeGreaterThan(0);
		const protectedReceipts = (result.receipts ?? []).filter(r => r.source.identity !== consumed.toolCallId);
		for (const protectedReceipt of protectedReceipts) {
			expect(protectedReceipt.skipped).toEqual({ reason: "no-useful-reduction", detail: "kept by protected" });
			expect(protectedReceipt.protectedSpans).toHaveLength(1);
			expect(protectedReceipt.decisions).toEqual([]);
		}
	});

	it("keeps an uncertain answer (0.35 ≤ keep_i < 0.5) and elides only a clear one", async () => {
		appendUser("finish the TLS listener");
		const uncertain = `maybe: ${"m ".repeat(400)}`;
		const cleared = `stale: ${"s ".repeat(400)}`;
		seedToolResult(NEEDED);
		seedToolResult(uncertain);
		seedToolResult(cleared);
		const judge = new ScriptedNoulJudge(text =>
			text.startsWith("needed") ? 0.7 : text.startsWith("maybe") ? 0.4 : 0.2,
		);

		const result = await session.shake("semantic", { config: OPEN_CONFIG, admitJudge: admit(judge) });

		expect(result.selection).toMatchObject({ candidates: 3, keptByJudge: 1, keptUncertain: 1, elided: 1, calls: 1 });
		const [needed, maybe, stale] = branchToolResults();
		expectUntouched(needed, NEEDED);
		expectUntouched(maybe, uncertain);
		expect(stale.prunedAt).toBeGreaterThan(0);
		const byId = new Map((result.receipts ?? []).map(r => [r.source.identity, r]));
		expect(byId.get(maybe.toolCallId)).toMatchObject({
			skipped: { reason: "no-useful-reduction", detail: "kept by uncertain" },
			omittedSpans: [],
		});
		expect(byId.get(stale.toolCallId)?.omittedSpans).toEqual([
			{ start: 0, end: cleared.length, reason: "judge", probability: 0.2 },
		]);
		expect(byId.get(needed.toolCallId)?.skipped).toEqual({ reason: "no-useful-reduction", detail: "kept by judge" });
	});

	it("keeps a region the judge left unanswered and still applies the other answers", async () => {
		appendUser("finish the TLS listener");
		const silent = `silent: ${"q ".repeat(400)}`;
		seedToolResult(NEEDED);
		seedToolResult(silent);
		seedToolResult(CONSUMED);
		const judge = new ScriptedNoulJudge(text => (text.startsWith("silent") ? undefined : keepNeeded(text)));

		const result = await session.shake("semantic", { config: OPEN_CONFIG, admitJudge: admit(judge) });

		expect(judge.calls).toBe(1);
		expect(result.selection).toMatchObject({ candidates: 3, keptByJudge: 1, keptUnjudged: 1, elided: 1, calls: 1 });
		const [needed, unanswered, consumed] = branchToolResults();
		expectUntouched(needed, NEEDED);
		expectUntouched(unanswered, silent);
		expect(consumed.prunedAt).toBeGreaterThan(0);
		const receipt = (result.receipts ?? []).find(r => r.source.identity === unanswered.toolCallId);
		expect(receipt?.skipped).toMatchObject({
			reason: "judge-unavailable",
			detail: expect.stringContaining("no answer"),
		});
	});

	it("never sends a region longer than 12 000 characters; it is kept unjudged", async () => {
		appendUser("finish the TLS listener");
		const oversized = `consumed: ${"z".repeat(13_000)}`;
		seedToolResult(oversized);
		seedToolResult(CONSUMED);
		const judge = new ScriptedNoulJudge(keepNeeded);

		const result = await session.shake("semantic", { config: OPEN_CONFIG, admitJudge: admit(judge) });

		expect(judge.calls).toBe(1);
		expect(judge.sentTexts()).toEqual([CONSUMED]);
		expect(result.selection).toMatchObject({ candidates: 2, keptUnjudged: 1, elided: 1 });
		const [large, consumed] = branchToolResults();
		expectUntouched(large, oversized);
		expect(consumed.prunedAt).toBeGreaterThan(0);
		const receipt = (result.receipts ?? []).find(r => r.source.identity === large.toolCallId);
		expect(receipt?.skipped?.reason).toBe("facts-exceed-capacity");
	});

	it("keeps everything without a call when the branch has no user request to judge against", async () => {
		seedToolResult(NEEDED);
		seedToolResult(CONSUMED);
		appendAssistantText("done");
		const judge = new ScriptedNoulJudge(keepNeeded);

		const result = await session.shake("semantic", { config: OPEN_CONFIG, admitJudge: admit(judge) });

		expect(judge.calls).toBe(0);
		expect(result.toolResultsDropped).toBe(0);
		expect(result.artifactId).toBeUndefined();
		expect(result.selection).toMatchObject({
			candidates: 2,
			keptUnjudged: 2,
			elided: 0,
			calls: 0,
			skipped: "context-unavailable",
		});
		const [first, second] = branchToolResults();
		expectUntouched(first, NEEDED);
		expectUntouched(second, CONSUMED);
		for (const receipt of result.receipts ?? []) expect(receipt.skipped?.reason).toBe("context-unavailable");
	});

	it("sends the four goal fields with a middle turn's standing requirement and never a private requirement-free turn", async () => {
		const original = "Please fix the TLS listener so the health check passes.";
		const privateTurn = "My manager is Priya and the budget code is 4471.";
		const requirement = "Keep every failing test name in the final report.";
		const latest = "Now write the release notes.";
		const reply = "Progress: the listener binds and the notes are drafted.";
		appendUser(original);
		seedToolResult(NEEDED);
		appendAssistantText("listener fixed");
		appendUser(privateTurn);
		appendAssistantText("noted");
		appendUser(`${requirement} Thanks.`);
		seedToolResult(CONSUMED);
		appendUser(latest);
		appendAssistantText(reply);
		const judge = new ScriptedNoulJudge(keepNeeded);

		await session.shake("semantic", { config: OPEN_CONFIG, admitJudge: admit(judge) });

		expect(judge.calls).toBe(1);
		const [state] = judge.states();
		expect(state.goal).toEqual({
			original_request: original,
			latest_request: latest,
			latest_reply: reply,
			standing_requirements: [requirement],
		});
		const wire = JSON.stringify(judge.requests);
		expect(wire).not.toContain("Priya");
		expect(wire).not.toContain("4471");
	});

	it("leaves fenced blocks alone in semantic mode; shake(elide) on the same branch still elides them", async () => {
		const block = `here is the log\n\`\`\`\n${"log line\n".repeat(400)}\`\`\``;
		appendUser(block);
		seedToolResult(CONSUMED);
		const judge = new ScriptedNoulJudge(() => 0.1);

		const semantic = await session.shake("semantic", { config: OPEN_CONFIG, admitJudge: admit(judge) });

		expect(semantic.toolResultsDropped).toBe(1);
		expect(semantic.blocksDropped).toBe(0);
		const userEntry = sessionManager.getBranch().find(e => e.type === "message" && e.message.role === "user");
		const userText = (userEntry as { message: { content: Array<{ type: string; text?: string }> } }).message
			.content[0]?.text;
		expect(userText).toBe(block);
		const archived = await archivedText(semantic.artifactId);
		expect(archived).not.toContain("log line");

		const mechanical = await session.shake("elide", { config: OPEN_CONFIG });

		expect(mechanical.blocksDropped).toBe(1);
		expect(mechanical.toolResultsDropped).toBe(0);
	});

	it("reuses a kept decision for the same task context and re-asks when a standing requirement is added", async () => {
		appendUser("finish the TLS listener");
		seedToolResult(NEEDED);
		seedToolResult(CONSUMED);
		const judge = new ScriptedNoulJudge(keepNeeded);
		const opts = { config: OPEN_CONFIG, admitJudge: admit(judge) };

		const first = await session.shake("semantic", opts);
		expect(judge.calls).toBe(1);
		expect(first.toolResultsDropped).toBe(1);

		// Same task context: the kept region is a candidate again but needs no call; the elided one is never re-offered.
		const second = await session.shake("semantic", opts);
		expect(judge.calls).toBe(1);
		expect(second.toolResultsDropped).toBe(0);
		expect(second.selection).toMatchObject({ candidates: 1, keptByJudge: 1, calls: 0 });
		expect(second.receipts?.[0]?.skipped).toEqual({ reason: "no-useful-reduction", detail: "kept by cache" });
		expectUntouched(branchToolResults()[0], NEEDED);

		// A new standing requirement changes the task context: the kept region is judged again.
		const requirement = "Never change the port without asking.";
		appendUser(requirement);
		const third = await session.shake("semantic", opts);
		expect(judge.calls).toBe(2);
		expect(judge.states()[1].regions.map(r => r.text)).toEqual([NEEDED]);
		expect(judge.states()[1].goal.standing_requirements).toEqual([requirement]);
		expect(third.selection).toMatchObject({ candidates: 1, keptByJudge: 1, calls: 1 });
	});

	it("never offers protected tool results or the protect window to the judge", async () => {
		appendUser("finish the TLS listener");
		seedToolResult(`skill ${"s ".repeat(500)}`, "skill", { name: "deploy" });
		seedToolResult(`skill read ${"r ".repeat(500)}`, "read", { path: "skill://deploy/SKILL.md" });
		seedToolResult(`recovered ${"a ".repeat(500)}`, "read", { path: "artifact://3" });
		seedToolResult(
			`recovered by meta ${"m ".repeat(500)}`,
			"read",
			{ path: "/tmp/artifacts/3.shake.log" },
			{ details: { meta: { source: { type: "internal", value: "artifact://3" } } } },
		);
		seedToolResult(CONSUMED);
		appendUser(`newer context\n${"tail ".repeat(2_000)}`);
		const recent = `recent ${"q ".repeat(500)}`;
		seedToolResult(recent);
		const judge = new ScriptedNoulJudge(() => 0.1);

		const result = await session.shake("semantic", {
			config: { ...DEFAULT_SHAKE_CONFIG, protectTokens: 1_500, minSavings: 0 },
			admitJudge: admit(judge),
		});

		expect(judge.calls).toBe(1);
		expect(judge.sentTexts()).toEqual([CONSUMED]);
		expect(result.selection).toMatchObject({ candidates: 1, keptByJudge: 0, elided: 1 });
		expect(result.toolResultsDropped).toBe(1);
		const texts = branchToolResults().map(resultText);
		expect(texts.filter(text => text.includes("shaken"))).toHaveLength(1);
		expect(texts.at(-1)).toBe(recent);
	});

	it("formats the selection into the operator summary", async () => {
		appendUser("finish the TLS listener");
		seedToolResult(NEEDED);
		seedToolResult(CONSUMED);
		const judge = new ScriptedNoulJudge(keepNeeded);

		const result = await session.shake("semantic", { config: OPEN_CONFIG, admitJudge: admit(judge) });

		const summary = formatShakeSummary(result);
		expect(summary).toContain("Shook 1 tool result");
		// Structural facts of the selection note, not its copy.
		expect(summary).toMatch(/kept 1 of 2/u);
		expect(summary).toMatch(/1 needed/u);
		expect(summary).toMatch(/elided 1/u);
	});

	describe("auto-compaction method", () => {
		const triggerThreshold = () => {
			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		};

		it("is a usable threshold method that dispatches shake(semantic) and emits the semantic-shake action", async () => {
			expect(resolveCompactionMethodOrder(["semantic-shake"])).toEqual(["semantic-shake"]);
			settings.set("compaction.methodOrder", ["semantic-shake", "shake"]);
			settings.set("compaction.thresholdPercent", 1);
			settings.set("contextPromotion.enabled", false);
			const reclaimed: ShakeResult = {
				mode: "semantic",
				toolResultsDropped: 2,
				blocksDropped: 0,
				tokensFreed: 10_000,
				selection: {
					candidates: 3,
					keptByJudge: 1,
					keptUncertain: 0,
					keptDuplicate: 0,
					keptProtected: 0,
					keptUnjudged: 0,
					elided: 2,
					calls: 1,
					durationMs: 42,
					distribution: "native",
				},
			};
			const shakeSpy = vi.spyOn(session, "shake").mockResolvedValue(reclaimed);

			triggerThreshold();
			await session.waitForIdle();

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			expect(shakeSpy).toHaveBeenCalledWith("semantic", expect.anything());
			expect(events.filter(e => e.type === "auto_compaction_start")).toEqual([
				expect.objectContaining({ reason: "threshold", action: "semantic-shake" }),
			]);
			expect(events.filter(e => e.type === "auto_compaction_end")).toEqual([
				expect.objectContaining({ action: "semantic-shake", skipped: false, aborted: false }),
			]);
			const notice = events.find(e => e.type === "notice" && e.message.includes("Auto-semantic-shake"));
			if (notice?.type !== "notice") throw new Error("Expected the semantic-shake notice");
			expect(notice.level).toBe("info");
			const message = String(notice.message);
			expect(message).toMatch(/kept 1 of 3/u);
			expect(message).toMatch(/elided 2/u);
			expect(message).toMatch(/native/u);
		});

		it("frees nothing with egress off and clearly reports the kept counts, the skip reason, and the next method on fallback", async () => {
			settings.set("compaction.methodOrder", ["semantic-shake", "shake"]);
			settings.set("compaction.thresholdPercent", 1);
			settings.set("compaction.semanticShake.protectTokens", 0);
			settings.set("contextPromotion.enabled", false);
			expect(settings.get("reduction.egress")).toBe("off");
			appendUser("finish the TLS listener");
			// Past the auto config's minSavings gate, so both results are real candidates.
			const bigNeeded = `needed: the port is 8443\n${"detail ".repeat(3_000)}`;
			const bigConsumed = `consumed: install log\n${"line ".repeat(3_000)}`;
			seedToolResult(bigNeeded);
			seedToolResult(bigConsumed);
			const shakeSpy = vi.spyOn(session, "shake");

			triggerThreshold();
			await session.waitForIdle();

			expect(shakeSpy.mock.calls.map(call => call[0])).toEqual(["semantic", "elide"]);
			expect(
				events.filter(e => e.type === "auto_compaction_start").map(e => (e as { action: string }).action),
			).toEqual(["semantic-shake", "shake"]);
			const [semanticEnd, shakeEnd] = events.filter(e => e.type === "auto_compaction_end");
			if (semanticEnd?.type !== "auto_compaction_end") throw new Error("Expected the semantic-shake end event");
			expect(semanticEnd).toMatchObject({ action: "semantic-shake", skipped: true, aborted: false });
			const message = semanticEnd.errorMessage ?? "";
			expect(message).toContain("Auto-semantic-shake: kept 2 of 2 (2 unjudged), elided 0, 0 calls");
			expect(message).toContain("egress-disabled");
			expect(message).toMatch(/still over threshold — falling back to shake\.$/);
			expect(shakeEnd).toMatchObject({ action: "shake" });
			const semanticResult = (await shakeSpy.mock.results[0]?.value) as ShakeResult;
			expect(semanticResult).toMatchObject({ toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 });
			expect(semanticResult.selection).toMatchObject({ candidates: 2, keptUnjudged: 2, skipped: "egress-disabled" });
			expect(semanticResult.artifactId).toBeUndefined();
		});
	});
});
