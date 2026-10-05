/**
 * Types shared by the `tab.task` loop: the atomic observation returned by
 * `observe.js`, the requests answered by `runtime.js`, and the result the Eval
 * facade hands back.
 *
 * Every candidate the judge may choose carries LOCAL executable args; the judge
 * answers with ids only. Nothing here is model-authored.
 */
import type { DecisionProvenance, ExecutionOutcome, VerificationEvidence } from "../../../judgment/decision";

/** Operations the loop can offer. Only operations with at least one target are put to the judge. */
export type TaskOperation = "CLICK" | "TYPE_TEXT" | "SELECT" | "SCROLL" | "WAIT" | "DONE" | "BLOCKED" | "ABSTAIN";

export const TASK_OPERATIONS: readonly TaskOperation[] = [
	"CLICK",
	"TYPE_TEXT",
	"SELECT",
	"SCROLL",
	"WAIT",
	"DONE",
	"BLOCKED",
	"ABSTAIN",
];

/** One option of a native `<select>`. */
export interface TaskControlOption {
	value: string;
	label: string;
	disabled: boolean;
	selected: boolean;
}

/** One visible control from a single atomic page read. */
export interface TaskControl {
	/** Page-side registry id; actions resolve this node instead of re-querying. */
	node: number;
	role: string;
	/** Accessible name (aria-labelledby, aria-label, <label>, text, title, placeholder — first non-empty). */
	label: string;
	/** Visible inner text of a non-editable control; may disagree with `label` when ARIA masks it. */
	text?: string;
	/** Raw `aria-label`, when set. */
	ariaLabel?: string;
	/** Raw `title`, when set. */
	title?: string;
	/** Form `name` attribute, when set; a caller `values` key may name a field by it. */
	name?: string;
	/** Not `:disabled`, not `aria-disabled`, not `readOnly`. */
	enabled: boolean;
	multiline: boolean;
	bbox: { x: number; y: number; w: number; h: number };
	inViewport: boolean;
	/** `elementFromPoint` at the control's centre resolved to something else. */
	occluded: boolean;
	hit?: { x: number; y: number };
	value?: string;
	selectedLabel?: string;
	multiple?: boolean;
	options?: TaskControlOption[];
	optionsOmitted?: number;
	checked?: boolean;
	expanded?: boolean;
	selected?: boolean;
	placeholder?: string;
}

/** Result of one `observe.js` evaluation. */
export interface TaskSnapshot {
	url: string;
	title: string;
	text: string;
	viewport: { width: number; height: number };
	scroll: { x: number; y: number; height: number };
	scrollable: { down: boolean; up: boolean };
	controls: TaskControl[];
	/** Per-control guard signature keyed by node id; `null` once the node stops being actionable. */
	guards: Record<string, string | null>;
	documentKey: string;
	hiddenControls: number;
	omittedControls: number;
	readyState: string;
	/** Widget families present but not drivable by this loop. */
	unsupported: string[];
}

/** Locally derived executable arguments for one candidate. */
export interface TaskActionArgs {
	operation: TaskOperation;
	/** Target control, when the operation has one. */
	node?: number;
	label: string;
	role?: string;
	/** Native-select option value. */
	value?: string;
	/** Scroll delta in CSS pixels. */
	deltaY?: number;
	multiline?: boolean;
	/** Classified consequential; executable only with `allowConsequential`. */
	consequential?: boolean;
	/** Why: the matched keyword and which text carried it, or `unreadable label` for mixed-script names. */
	consequentialReason?: string;
}

export interface TaskObserveRequest {
	/** Post-input settle to run before reading, when the previous step typed or clicked. */
	settle?: { node?: number; kind?: string; budgetMs?: number };
}

export interface TaskFreshState {
	documentKey: string | null;
	guard: string | null;
}

export interface TaskActRequest {
	kind: TaskOperation;
	node?: number;
	text?: string;
	value?: string;
	deltaY?: number;
	settleMs?: number;
	/** Final policy flag derived from the selected local candidate. */
	consequential?: boolean;
	/**
	 * Document state (and target guard for node actions) the decision was made
	 * against. Every dispatch carries it; the worker answers `stale` on mismatch.
	 */
	expect?: { documentKey: string; guard: string | null };
}

export type TaskActOutcome =
	| { status: "applied"; detail?: string; settled?: string }
	| { status: "rejected" | "stale" | "unknown"; reason: string };

export interface TaskProbe {
	url: string;
	/** `null` when no selector was requested. */
	selectorPresent: boolean | null;
}

/**
 * Page contact for one task. The loop never touches Puppeteer directly. Each
 * call receives the loop's deadline signal so no page contact outlives the task.
 */
export interface TaskDriver {
	observe(request: TaskObserveRequest, signal?: AbortSignal): Promise<TaskSnapshot>;
	fresh(node: number | undefined, signal?: AbortSignal): Promise<TaskFreshState>;
	act(request: TaskActRequest, signal?: AbortSignal): Promise<TaskActOutcome>;
	probe(selector: string | undefined, signal?: AbortSignal): Promise<TaskProbe>;
}

/** What the caller asks for. */
export interface BrowserTaskOptions {
	goal: string;
	/**
	 * Caller-supplied field values, keyed by field label, placeholder, or form
	 * name; matched by exact normalised equality only and preferred over any
	 * model-written text.
	 */
	values?: Record<string, string>;
	/** Local postconditions; `done` requires at least one to hold on the final observation. */
	expect?: { urlIncludes?: string; textIncludes?: string; selector?: string };
	maxActions?: number;
	maxCalls?: number;
	timeoutMs?: number;
	allowConsequential?: boolean;
}

/** Which model wrote a field value, when no caller value matched. */
export interface TextHelperProvenance {
	api: string;
	provider: string;
	model: string;
	role: string;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
}

/** Compact provenance recorded per step; the full set is `BrowserTaskResult.attempts`. */
export interface TaskStepProvenance {
	backend: string;
	label: string;
	model: string;
	distribution: "native" | "synthetic";
	fallback?: string;
	costUsd: number | "unknown";
	durationMs: number;
	/** Confidence of the operation head. */
	confidence: number;
	/** Probability the chosen target carried in its head. */
	probability: number;
}

/**
 * An action whose effect could not be established (`unknown` outcome). It is
 * withheld from later decisions unless the caller's `expect` is still unmet on
 * a changed document and the action is non-consequential.
 */
export interface TaskQuarantine {
	operation: TaskOperation;
	label: string;
	/** Document the action was dispatched against. */
	documentKey: string;
	/** Step that produced the unknown outcome. */
	step: number;
}

export interface TaskStep {
	n: number;
	operation: TaskOperation;
	/** Candidate id inside the target head, when the operation had one. */
	target?: string;
	label: string;
	outcome: ExecutionOutcome["status"];
	reason?: string;
	/** `null` when the step performed no action (blocked, abstain, done). */
	pageChanged: boolean | null;
	ms: number;
	text?: string;
	textSource?: "values" | "model";
	helper?: TextHelperProvenance;
	/** Set when this step's unknown outcome quarantined its action. */
	quarantined?: true;
	provenance: TaskStepProvenance;
}

export interface TaskUsage {
	/** Logical metered calls (judgments and helper completions). */
	calls: number;
	/** Transport attempts behind those calls, failed and nested ones included. */
	attempts: number;
	input: number;
	output: number;
	costUsd: number | "unknown";
}

export interface BrowserTaskResult {
	status: "done" | "unverified" | "blocked" | "abstain" | "exhausted" | "error";
	reason?: string;
	goal: string;
	tab: string;
	steps: TaskStep[];
	verification: VerificationEvidence;
	/** How many atomic observations the loop took. */
	observationRevisions: number;
	budget: { calls: number; actions: number; elapsedMs: number; maxCalls: number; maxActions: number };
	usage: TaskUsage;
	/** Every remote attempt the loop made: judgments, failed transports behind them, helper completions. */
	attempts: DecisionProvenance[];
	backend: { kind: string; label: string; model?: string; distribution?: "native" | "synthetic"; fallback?: string };
	/** `false` only when every derived candidate was offered to the judge. */
	candidatesTruncated: boolean;
	/** Explicit fallback taken when candidates did not fit the choice cap. */
	candidateFallback?: string;
	/** Widgets the loop cannot drive (canvas, file upload, cross-document frames). */
	unsupported?: string[];
	/** Caller `values` keys that matched no field exactly and were therefore never typed. Present when `values` was given. */
	unusedValues?: string[];
	/** Actions withheld after an `unknown` outcome. */
	quarantined?: TaskQuarantine[];
}
