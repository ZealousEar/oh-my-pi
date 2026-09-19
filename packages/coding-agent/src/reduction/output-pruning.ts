import type { JudgmentState, Model, NoulAnswer, NoulQuestion, Questions } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { judgeWithMeter, LoopBudgetExceeded } from "../judgment/decision";
import needsAllTemplate from "../prompts/tools/bash-output-prune-needs-all.md" with { type: "text" };
import omitCriteriaTemplate from "../prompts/tools/bash-output-prune-omit-criteria.md" with { type: "text" };
import omitTemplate from "../prompts/tools/bash-output-prune-omit.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";
import { PLACEHOLDER_RE } from "../secrets/placeholder";
import { isDiagnosticLine, isVerificationReceiptLine } from "./protection";
import { hasRetentionRequirement, type TaskContext } from "./task-context";
import {
	admitReductionJudge,
	contentHash,
	isReductionSkip,
	prepareEgressText,
	resolveReductionPolicy,
	reductionCost,
	untouchedReceipt,
	type OmittedSpan,
	type ReductionJudge,
	type ReductionReceipt,
	type ReductionSkip,
	type ReductionSpan,
	type ReductionStage,
} from "./contract";

export type OutputSegmentKind = "protected" | "candidate" | "neutral";
export interface OutputSegment extends ReductionSpan {
	kind: OutputSegmentKind;
	text: string;
	lineStart: number;
	lineEnd: number;
	lineCount: number;
	rule?: "noise" | "blank-run" | "repeated-line";
}
interface OutputLine extends ReductionSpan {
	text: string;
	body: string;
	line: number;
	kind: OutputSegmentKind;
	rule?: OutputSegment["rule"];
}
export interface DeterministicPruneResult {
	omittedSpans: OmittedSpan[];
}
export interface SemanticPruneInput {
	baseline: string;
	command: string;
	cwd?: string;
	exitCode: number;
	segments: readonly OutputSegment[];
	alreadyOmitted?: readonly OmittedSpan[];
	maxSegments: number;
	admission: ReductionJudge;
	obfuscator?: SecretObfuscator;
	signal?: AbortSignal;
	task: TaskContext;
}
export interface SemanticPruneResult {
	omittedSpans: OmittedSpan[];
	skipped?: ReductionSkip;
	preserveAll?: boolean;
}
export interface PruneBashOutputInput {
	baseline: string;
	/** Normalized command output before Bash appends wall-time, exit, and metadata notices. */
	output?: string;
	/** The raw command read an artifact recovery locator and must never be reduced again. */
	recoveryRead?: boolean;
	command: string;
	cwd?: string;
	exitCode: number;
	tokenizer: { countTokens(text: string): number };
	settings: Settings;
	task?: TaskContext;
	registry?: ModelRegistry;
	sessionId?: string;
	sessionModel?: Model;
	archive(text: string): Promise<string | undefined>;
	existingArtifactId?: string;
	signal?: AbortSignal;
	identity?: string;
	obfuscator?: SecretObfuscator;
	/** Scripted in-memory judge seam. Production callers leave this unset. */
	admission?: ReductionJudge;
}
export interface PruneBashOutputResult {
	visible: string;
	receipt?: ReductionReceipt;
}

/**
 * Bounds of one semantic request, in characters, so it never exceeds the judge's
 * documented per-request ceiling regardless of tokenizer differences. Larger
 * candidate spans are never sent; they stay in the visible output.
 */
export const SEMANTIC_REQUEST_CHARS = 60_000;
export const SEMANTIC_SEGMENT_CHARS = 40_000;
const PATH_REFERENCE_RE = /(?:^|\s)(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|[A-Za-z0-9_.-]+[\\/])?[^\s:]+:\d+(?::\d+)?(?:\b|$)/u;
const RESULT_COUNT_RE = /\b\d+\s+(?:pass|passed|fail|failed|tests?|files?|packages?|errors?|warnings?)\b/iu;
const STATUS_RE =
	/(?:Command exited|exit(?:ed)?(?:\s+code|\s+status)?|status:|wall time:|elapsed:|timed out|aborted|cancelled|output truncated|raw output:|artifact:\/\/)/iu;
const URL_RE = /\b(?:https?|file):\/\/\S+/iu;
const ABSOLUTE_PATH_RE = /(?:^|\s)(?:\/[^\s]|[A-Za-z]:[\\/])/u;
const NOISE_RE =
	/(?:^|\s)(?:Downloading|Fetching|Compiling|Resolving|Building|Linking|Installing)\b|\badded\s+\d+\s+packages?\b|npm WARN deprecated|(?:^|\s)[✓✔](?:\s|$)|^\s*PASS(?:\s|\()/iu;
const PERCENT_RE = /(?:\b\d{1,3}(?:\.\d+)?%\b|\[[#=*>.\-\s]{5,}\]|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/u;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const DIFF_RE = /^(?:diff --git\b|@@\s|---\s|\+\+\+\s)/mu;
const GIT_LOG_RE = /^(?:commit\s+[0-9a-f]{7,}|Author:\s|Date:\s{2,})/imu;
const LS_LONG_RE = /^[bcdlps-][rwxStTs-]{9}[+@.]?\s+\d+\s+\S+\s+\S+\s+\d+\s+/u;

function splitLines(text: string): OutputLine[] {
	if (!text) return [];
	const lines: OutputLine[] = [];
	let start = 0;
	let line = 1;
	while (start < text.length) {
		const newline = text.indexOf("\n", start);
		const end = newline < 0 ? text.length : newline + 1;
		const value = text.slice(start, end);
		const body = value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
		lines.push({ start, end, text: value, body, line, kind: "neutral" });
		start = end;
		line++;
	}
	return lines;
}
function hasSecretPlaceholder(text: string): boolean {
	PLACEHOLDER_RE.lastIndex = 0;
	const found = PLACEHOLDER_RE.test(text);
	PLACEHOLDER_RE.lastIndex = 0;
	return found;
}
function isProtectedLine(line: string): boolean {
	return (
		isDiagnosticLine(line) ||
		isVerificationReceiptLine(line) ||
		PATH_REFERENCE_RE.test(line) ||
		RESULT_COUNT_RE.test(line) ||
		STATUS_RE.test(line) ||
		URL_RE.test(line) ||
		ABSOLUTE_PATH_RE.test(line) ||
		hasSecretPlaceholder(line)
	);
}
function structuralJsonLines(lines: readonly OutputLine[]): boolean {
	if (!lines.length) return false;
	const count = lines.filter(line => {
		const text = line.body.trim();
		return (
			!text ||
			/^[{}[\],]+$/u.test(text) ||
			/^"(?:[^"\\]|\\.)+"\s*:/u.test(text) ||
			/^-?\d/u.test(text) ||
			/^"(?:[^"\\]|\\.)*",?$/u.test(text) ||
			/^(?:true|false|null),?$/u.test(text)
		);
	}).length;
	return count / lines.length >= 0.6;
}
function isTableLike(lines: readonly OutputLine[]): boolean {
	const nonblank = lines.filter(line => line.body.trim());
	if (nonblank.length < 3) return false;
	const rows = nonblank.filter(
		line => [...line.body].filter(char => char === "|" || char === "\t").length >= 2,
	).length;
	return rows / nonblank.length >= 0.6;
}

export function detectProtectedFormat(baseline: string, command?: string): ReductionSkip | undefined {
	if (CONTROL_RE.test(baseline)) return { reason: "protected-format", detail: "binary or control-character output" };
	const lines = splitLines(baseline);
	const trimmed = baseline.trim();
	if (trimmed) {
		try {
			JSON.parse(trimmed);
			return { reason: "protected-format", detail: "JSON output" };
		} catch {
			if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && structuralJsonLines(lines))
				return { reason: "protected-format", detail: "JSON-like output" };
		}
	}
	if (DIFF_RE.test(baseline) || (/^---\s/mu.test(baseline) && /^\+\+\+\s/mu.test(baseline)))
		return { reason: "protected-format", detail: "diff or patch output" };
	if (/^\s*```/mu.test(baseline)) return { reason: "protected-format", detail: "fenced code output" };
	if (isTableLike(lines)) return { reason: "protected-format", detail: "table-like output" };
	if (GIT_LOG_RE.test(baseline)) return { reason: "protected-format", detail: "git log listing" };
	const nonblank = lines.filter(line => line.body.trim());
	if (nonblank.length >= 3 && nonblank.filter(line => LS_LONG_RE.test(line.body)).length / nonblank.length >= 0.6)
		return { reason: "protected-format", detail: "file listing" };
	if (command && /(?:^|[;&|]\s*|\n\s*)(?:git\s+log|ls|cat|bat|head|tail|sed\s+-n)(?:\s|$)/u.test(command.trim()))
		return { reason: "protected-format", detail: "command requested an explicit listing or file view" };
	return undefined;
}

export function segmentOutput(baseline: string): OutputSegment[] {
	const lines = splitLines(baseline);
	if (!lines.length) return [];
	const tail = Math.max(0, lines.length - 8);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (index < 3 || index >= tail || isProtectedLine(line.body)) line.kind = "protected";
		else if (!line.body.trim()) {
			line.kind = "candidate";
			line.rule = "blank-run";
		} else if (NOISE_RE.test(line.body) || PERCENT_RE.test(line.body)) {
			line.kind = "candidate";
			line.rule = "noise";
		}
	}
	let start = 0;
	while (start < lines.length) {
		let end = start + 1;
		while (end < lines.length && lines[end].body === lines[start].body) end++;
		if (end - start >= 2) {
			for (let index = start; index < end; index++) {
				if (lines[index].kind === "protected") continue;
				lines[index].kind = "candidate";
				lines[index].rule = lines[index].body.trim() ? "repeated-line" : "blank-run";
			}
		}
		start = end;
	}
	const segments: OutputSegment[] = [];
	for (const line of lines) {
		const previous = segments.at(-1);
		if (previous && previous.kind === line.kind && previous.rule === line.rule) {
			previous.end = line.end;
			previous.text += line.text;
			previous.lineEnd = line.line;
			previous.lineCount++;
		} else {
			segments.push({
				start: line.start,
				end: line.end,
				text: line.text,
				kind: line.kind,
				lineStart: line.line,
				lineEnd: line.line,
				lineCount: 1,
				...(line.rule ? { rule: line.rule } : {}),
			});
		}
	}
	return segments;
}
function firstLineEnd(text: string): number {
	const newline = text.indexOf("\n");
	return newline < 0 ? text.length : newline + 1;
}
function markerFor(removed: string, reason: string): string {
	const lines = countLines(removed);
	const newline = removed.includes("\r\n") ? "\r\n" : "\n";
	return `[… pruned ${lines} ${lines === 1 ? "line" : "lines"} (${reason}) …]${newline}`;
}
function markerSavesCharacters(removed: string, reason: string): boolean {
	return removed.length >= 48 && removed.length > markerFor(removed, reason).length;
}
export function pruneDeterministically(
	segments: readonly OutputSegment[],
	policy: "full" | "conservative" = "full",
): DeterministicPruneResult {
	const omittedSpans: OmittedSpan[] = [];
	for (const segment of segments) {
		if (segment.kind !== "candidate" || !segment.rule) continue;
		if (segment.rule === "repeated-line" && segment.lineCount >= 2) {
			const prefix = firstLineEnd(segment.text);
			const removed = segment.text.slice(prefix);
			const reason = `repeated-line ×${segment.lineCount - 1}`;
			if (markerSavesCharacters(removed, reason))
				omittedSpans.push({
					start: segment.start + prefix,
					end: segment.end,
					reason,
				});
		} else if (segment.rule === "blank-run" && segment.lineCount >= 5) {
			const prefix = firstLineEnd(segment.text);
			const removed = segment.text.slice(prefix);
			const reason = `blank-run ×${segment.lineCount - 1}`;
			if (markerSavesCharacters(removed, reason))
				omittedSpans.push({
					start: segment.start + prefix,
					end: segment.end,
					reason,
				});
		} else if (policy === "full" && segment.rule === "noise" && segment.lineCount >= 5) {
			omittedSpans.push({ start: segment.start, end: segment.end, reason: "recognized-noise" });
		}
	}
	return { omittedSpans };
}
function countLines(text: string): number {
	if (!text) return 0;
	let count = 0;
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++;
	return text.endsWith("\n") ? count : count + 1;
}
function normalize(omissions: readonly OmittedSpan[]): OmittedSpan[] {
	const result: OmittedSpan[] = [];
	for (const span of omissions
		.filter(span => span.end > span.start)
		.toSorted((a, b) => a.start - b.start || a.end - b.end)) {
		if (!result.at(-1) || span.start >= result.at(-1)!.end) result.push({ ...span });
	}
	return result;
}
function render(baseline: string, omissions: readonly OmittedSpan[]): string {
	let cursor = 0;
	let output = "";
	for (const omission of normalize(omissions)) {
		const removed = baseline.slice(omission.start, omission.end);
		const reason = omission.probability === undefined ? omission.reason : "judge";
		output += baseline.slice(cursor, omission.start) + markerFor(removed, reason);
		cursor = omission.end;
	}
	return output + baseline.slice(cursor);
}
/** Whether `segment` lies inside a span the rules already omitted. */
function ruleOmitted(segment: OutputSegment, omissions: readonly OmittedSpan[]): boolean {
	return omissions.some(span => span.start <= segment.start && span.end >= segment.end);
}
/**
 * Segments the judge sees: every unprotected run of at least three lines,
 * including runs the rules already omitted — `needs_every_line` must be judged
 * over the complete picture so a stated or implied enumeration can bring the
 * rule-omitted runs back. Largest first.
 */
function candidates(segments: readonly OutputSegment[], omissions: readonly OmittedSpan[]): OutputSegment[] {
	return segments
		.filter(
			segment =>
				segment.kind !== "protected" &&
				segment.lineCount >= 3 &&
				(ruleOmitted(segment, omissions) ||
					omissions.every(span => span.start >= segment.end || span.end <= segment.start)),
		)
		.toSorted((a, b) => b.text.length - a.text.length || a.start - b.start);
}
/** A finite noul probability, or `undefined` when the judge gave no usable answer. */
function answerValue(answer: unknown): number | undefined {
	if (!answer || typeof answer !== "object" || (answer as Partial<NoulAnswer>).type !== "noul") return undefined;
	const value = (answer as NoulAnswer).noul;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function edge(lines: readonly OutputLine[], tail: boolean): string {
	return (tail ? lines.slice(-20) : lines.slice(0, 20)).map(line => line.text).join("");
}

/** Greedy batches of at most `limit` segments whose combined text stays within the request bound. */
function batchSegments(segments: readonly OutputSegment[], limit: number, fixedChars: number): OutputSegment[][] {
	const batches: OutputSegment[][] = [];
	let current: OutputSegment[] = [];
	let chars = fixedChars;
	for (const segment of segments) {
		if (current.length >= limit || chars + segment.text.length > SEMANTIC_REQUEST_CHARS) {
			if (current.length) batches.push(current);
			current = [];
			chars = fixedChars;
		}
		current.push(segment);
		chars += segment.text.length;
	}
	if (current.length) batches.push(current);
	return batches;
}

export async function pruneSemantically(input: SemanticPruneInput): Promise<SemanticPruneResult> {
	const omittedSpans: OmittedSpan[] = [];
	const alreadyOmitted = input.alreadyOmitted ?? [];
	const eligible = candidates(input.segments, alreadyOmitted);
	if (!eligible.length)
		return {
			omittedSpans,
			skipped: { reason: "no-useful-reduction", detail: "no semantic spans of at least 3 lines" },
		};
	const semantic = eligible.filter(segment => segment.text.length <= SEMANTIC_SEGMENT_CHARS);
	if (!semantic.length)
		return {
			omittedSpans,
			skipped: {
				reason: "facts-exceed-capacity",
				detail: `every candidate span exceeds ${SEMANTIC_SEGMENT_CHARS} characters; kept without judgment`,
			},
		};
	const limit = Math.max(1, Math.floor(input.maxSegments));
	const lines = splitLines(input.baseline);
	const safe = (text: string): string => prepareEgressText(text, input.obfuscator);
	const command = safe(input.command);
	const cwd = input.cwd === undefined ? undefined : safe(input.cwd);
	const outputHead = safe(edge(lines, false));
	const outputTail = safe(edge(lines, true));
	const task = {
		original_request: safe(input.task.originalRequest),
		latest_request: safe(input.task.latestRequest),
		latest_reply: safe(input.task.latestReply),
		standing_requirements: input.task.requirements.map(safe),
	};
	const fixedChars =
		command.length +
		(cwd?.length ?? 0) +
		outputHead.length +
		outputTail.length +
		task.original_request.length +
		task.latest_request.length +
		task.latest_reply.length +
		task.standing_requirements.reduce((total, requirement) => total + requirement.length, 0);
	const batches = batchSegments(semantic, limit, fixedChars);
	for (const [offset, batch] of batches.entries()) {
		const stateSegments = batch.map((segment, index) => ({
			index,
			line_range: `${segment.lineStart}-${segment.lineEnd}`,
			text: safe(segment.text),
		}));
		const state: JudgmentState = {
			command,
			...(cwd === undefined ? {} : { cwd }),
			exit_code: input.exitCode,
			output_head: outputHead,
			output_tail: outputTail,
			segments: stateSegments,
			task,
		};
		const questions: Record<string, NoulQuestion> = {};
		if (offset === 0)
			questions.needs_every_line = {
				type: "noul",
				instructions: prompt.render(needsAllTemplate, { command }).trim(),
				criteria: {
					true: prompt.render(needsAllTemplate, { command, criterion: true, yes: true }).trim(),
					false: prompt.render(needsAllTemplate, { command, criterion: true, yes: false }).trim(),
				},
			};
		// Runs the rules already omitted are shown (complete) but not re-asked about.
		for (let index = 0; index < batch.length; index++) {
			const segment = batch[index];
			if (!segment || ruleOmitted(segment, alreadyOmitted)) continue;
			questions[`omit_${index}`] = {
				type: "noul",
				instructions: prompt
					.render(omitTemplate, { i: index, command, line_range: stateSegments[index]?.line_range ?? "" })
					.trim(),
				criteria: {
					true: prompt.render(omitCriteriaTemplate, { yes: true }).trim(),
					false: prompt.render(omitCriteriaTemplate, { yes: false }).trim(),
				},
			};
		}
		if (Object.keys(questions).length === 0) continue;
		try {
			const { result } = await judgeWithMeter(
				input.admission.judge,
				input.admission.meter,
				{ state, questions: questions as Questions },
				{
					signal: input.signal,
					callTimeoutMs: input.admission.policy.maxLatencyMs,
					pinnedModel: input.admission.judge.pinnedModel,
				},
			);
			if (offset === 0) {
				const needsEveryLine = answerValue(result.answers.needs_every_line);
				// The exhaustiveness guard was not answered: nothing may be removed on this output.
				if (needsEveryLine === undefined)
					return {
						omittedSpans: [],
						preserveAll: true,
						skipped: { reason: "judge-unavailable", detail: "no answer for needs_every_line; nothing removed" },
					};
				if (needsEveryLine >= 0.5)
					return {
						omittedSpans: [],
						preserveAll: true,
						skipped: {
							reason: "judge-preserved",
							detail: "judge identified count-sensitive or exhaustive output",
						},
					};
			}
			for (let index = 0; index < batch.length; index++) {
				if (!(`omit_${index}` in questions)) continue;
				const probability = answerValue(result.answers[`omit_${index}`]);
				const segment = batch[index];
				// A missing answer keeps the span; only an answered ≥ 0.85 omits it.
				if (segment && probability !== undefined && probability >= 0.85)
					omittedSpans.push({ start: segment.start, end: segment.end, reason: `omit_${index}`, probability });
			}
		} catch (error) {
			if (error instanceof LoopBudgetExceeded)
				return {
					omittedSpans,
					skipped: {
						reason: error.limit === "aborted" ? "aborted" : "budget-exhausted",
						detail: error.message,
					},
				};
			return {
				omittedSpans,
				skipped: { reason: "judge-unavailable", detail: error instanceof Error ? error.message : String(error) },
			};
		}
	}
	return { omittedSpans };
}

function complement(length: number, omissions: readonly OmittedSpan[]): ReductionSpan[] {
	const kept: ReductionSpan[] = [];
	let cursor = 0;
	for (const omission of normalize(omissions)) {
		if (cursor < omission.start) kept.push({ start: cursor, end: omission.start });
		cursor = omission.end;
	}
	if (cursor < length) kept.push({ start: cursor, end: length });
	return kept;
}
function unchangedReceipt(
	input: PruneBashOutputInput,
	tokens: number,
	skipped: ReductionSkip,
	started: number,
	stages: ReductionStage[] = [],
	admission?: ReductionJudge,
): ReductionReceipt {
	return untouchedReceipt(
		{
			kind: "bash-output",
			identity: input.identity ?? input.command,
			contentHash: contentHash(input.baseline),
		},
		tokens,
		input.existingArtifactId ? `artifact://${input.existingArtifactId}` : "inline",
		skipped,
		stages,
		admission?.meter.attempts.slice() ?? [],
		reductionCost(admission?.meter, performance.now() - started),
	);
}
function useful(before: number, after: number): boolean {
	const saved = before - after;
	return saved >= 200 && before > 0 && saved / before >= 0.15;
}

export async function pruneBashOutput(input: PruneBashOutputInput): Promise<PruneBashOutputResult> {
	const mode = input.settings.get("bash.outputPruning.mode");
	if (mode === "off") return { visible: input.baseline };
	const started = performance.now();
	const baselineTokens = input.tokenizer.countTokens(input.baseline);
	if (input.recoveryRead)
		return {
			visible: input.baseline,
			receipt: unchangedReceipt(input, baselineTokens, { reason: "already-reduced" }, started),
		};
	if (baselineTokens < Math.max(0, input.settings.get("bash.outputPruning.minTokens")))
		return {
			visible: input.baseline,
			receipt: unchangedReceipt(input, baselineTokens, { reason: "below-threshold" }, started),
		};
	const protectedFormat = detectProtectedFormat(input.output ?? input.baseline, input.command);
	if (protectedFormat)
		return { visible: input.baseline, receipt: unchangedReceipt(input, baselineTokens, protectedFormat, started) };

	const taskUnavailable = input.task === undefined || input.task.coverage === "none";
	if (input.task && hasRetentionRequirement(input.task)) {
		const detail = input.task.requirements[0]?.slice(0, 120);
		return {
			visible: input.baseline,
			receipt: unchangedReceipt(
				input,
				baselineTokens,
				{ reason: "standing-requirement", ...(detail ? { detail } : {}) },
				started,
			),
		};
	}

	const segments = segmentOutput(input.baseline);
	const deterministicStarted = performance.now();
	let omissions = pruneDeterministically(segments, taskUnavailable ? "conservative" : "full").omittedSpans;
	const deterministicVisible = render(input.baseline, omissions);
	const stages: ReductionStage[] = [
		{
			kind: "deterministic",
			label: taskUnavailable ? "bash-output-content-free" : "bash-output-rules",
			tokensBefore: baselineTokens,
			tokensAfter: input.tokenizer.countTokens(deterministicVisible),
			durationMs: performance.now() - deterministicStarted,
			...(omissions.length
				? {}
				: {
						skipped: taskUnavailable
							? { reason: "context-unavailable" as const }
							: { reason: "no-useful-reduction" as const },
					}),
		},
	];
	let admission: ReductionJudge | undefined;
	let semanticSkip: ReductionSkip | undefined;
	if (mode === "semantic") {
		const semanticBefore = input.tokenizer.countTokens(deterministicVisible);
		const semanticStarted = performance.now();
		if (taskUnavailable)
			semanticSkip = { reason: "context-unavailable", detail: "no user task context is available" };
		else if (input.exitCode !== 0) semanticSkip = { reason: "protected-format", detail: "non-zero exit" };
		else if (resolveReductionPolicy(input.settings).egress === "off")
			semanticSkip = { reason: "egress-disabled", detail: "reduction.egress is off; deterministic stages only" };
		else if (input.admission) admission = input.admission;
		else if (!input.registry)
			semanticSkip = { reason: "judge-unavailable", detail: "no model registry is available" };
		else {
			const admitted = admitReductionJudge({
				settings: input.settings,
				registry: input.registry,
				...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
				...(input.sessionModel === undefined ? {} : { sessionModel: input.sessionModel }),
				...(input.signal === undefined ? {} : { signal: input.signal }),
			});
			if (isReductionSkip(admitted)) semanticSkip = admitted;
			else admission = admitted;
		}
		if (admission && input.task) {
			const result = await pruneSemantically({
				baseline: input.baseline,
				command: input.command,
				...(input.cwd === undefined ? {} : { cwd: input.cwd }),
				exitCode: input.exitCode,
				segments,
				task: input.task,
				alreadyOmitted: omissions,
				maxSegments: input.settings.get("bash.outputPruning.maxSegments"),
				admission,
				...(input.obfuscator === undefined ? {} : { obfuscator: input.obfuscator }),
				...(input.signal === undefined ? {} : { signal: input.signal }),
			});
			omissions = result.preserveAll ? [] : normalize([...omissions, ...result.omittedSpans]);
			semanticSkip = result.skipped;
		}
		stages.push({
			kind: "semantic",
			label: "jev-output-selection",
			tokensBefore: semanticBefore,
			tokensAfter: input.tokenizer.countTokens(render(input.baseline, omissions)),
			durationMs: performance.now() - semanticStarted,
			...(semanticSkip ? { skipped: semanticSkip } : {}),
		});
	}
	if (!omissions.length)
		return {
			visible: input.baseline,
			receipt: unchangedReceipt(
				input,
				baselineTokens,
				semanticSkip ?? (taskUnavailable ? { reason: "context-unavailable" } : { reason: "no-useful-reduction" }),
				started,
				stages,
				admission,
			),
		};
	const body = render(input.baseline, omissions);
	const estimate = `${body}\n[pruned output: ${baselineTokens}→0 tokens; original: artifact://00000000]`;
	if (!useful(baselineTokens, input.tokenizer.countTokens(estimate)))
		return {
			visible: input.baseline,
			receipt: unchangedReceipt(
				input,
				baselineTokens,
				{ reason: "no-useful-reduction", detail: "savings below 15% or 200 tokens" },
				started,
				stages,
				admission,
			),
		};
	let artifactId: string | undefined;
	try {
		artifactId = await input.archive(input.baseline);
	} catch (error) {
		return {
			visible: input.baseline,
			receipt: unchangedReceipt(
				input,
				baselineTokens,
				{
					reason: "archive-failed",
					detail: error instanceof Error ? error.message : String(error),
				},
				started,
				stages,
				admission,
			),
		};
	}
	if (!artifactId)
		return {
			visible: input.baseline,
			receipt: unchangedReceipt(input, baselineTokens, { reason: "archive-failed" }, started, stages, admission),
		};
	let visibleTokens = input.tokenizer.countTokens(body);
	let visible = "";
	for (let iteration = 0; iteration < 8; iteration++) {
		visible = `${body}\n[pruned output: ${baselineTokens}→${visibleTokens} tokens; original: artifact://${artifactId}]`;
		const measured = input.tokenizer.countTokens(visible);
		if (measured === visibleTokens) break;
		visibleTokens = measured;
	}
	visibleTokens = input.tokenizer.countTokens(visible);
	return {
		visible,
		receipt: {
			version: 1,
			source: {
				kind: "bash-output",
				identity: input.identity ?? input.command,
				contentHash: contentHash(input.baseline),
				originalArtifactId: artifactId,
			},
			stages,
			baselineTokens,
			visibleTokens,
			protectedSpans: segments
				.filter(segment => segment.kind === "protected")
				.map(segment => ({ start: segment.start, end: segment.end })),
			keptSpans: complement(input.baseline.length, omissions),
			omittedSpans: omissions,
			recovery: { locator: `artifact://${artifactId}` },
			decisions: admission?.meter.attempts.slice() ?? [],
			cost: reductionCost(admission?.meter, performance.now() - started),
		},
	};
}
