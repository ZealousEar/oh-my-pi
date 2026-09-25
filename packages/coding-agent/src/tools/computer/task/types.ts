/**
 * Contracts for `computer.task`: the bounded semantic desktop goal loop.
 *
 * Every shape here is local. The judge only ever answers with a candidate id;
 * the executable arguments ({@link DesktopActionArgs}) are derived from a
 * single observation of one window and never from model text.
 */
import type {
	DecisionProvenance,
	ExecutionOutcome,
	ObservationIdentity,
	VerificationEvidence,
} from "../../../judgment/decision";
import type { JudgeKind } from "../../../judgment";
import type { DesktopBackendKind, DesktopBackendMode } from "../cua-backend";
import type { CuaDriverDetection, CuaDriverPermissions } from "../cua-driver";

/** Window filter matched against the owning app name and title, as `computer.windows` uses. */
export interface ComputerTaskWindowFilter {
	app?: string;
	title?: string;
}

/** Explicit target: an opaque window id, a unique app/title filter, or the literal `focused`. */
export type ComputerTaskWindowTarget = string | ComputerTaskWindowFilter;

/** Independent completion checks evaluated by re-observing the window. */
export interface ComputerTaskExpect {
	titleIncludes?: string;
	find?: { role?: string; title?: string; value?: string };
}

export interface ComputerTaskOptions {
	goal: string;
	app?: string;
	window?: ComputerTaskWindowTarget;
	/** Field values the caller authorizes, matched to editable nodes by title/description/role. */
	values?: Record<string, string>;
	expect?: ComputerTaskExpect;
	maxActions?: number;
	maxCalls?: number;
	/** Wall-clock budget in seconds. */
	timeout?: number;
	/** Required before a send/delete/purchase-class action may be offered to the judge. */
	allowConsequential?: boolean;
}

/** What a candidate does when executed. `wait`/`reobserve`/`done`/`blocked`/`abstain` are reserved control actions. */
export type DesktopActionKind =
	| "press"
	| "click"
	| "set-value"
	| "focus"
	| "scroll-to-visible"
	| "wait"
	| "reobserve"
	| "done"
	| "blocked"
	| "abstain";

/** Locally derived, locally executable arguments of one candidate. */
export interface DesktopActionArgs {
	kind: DesktopActionKind;
	/** AX ref from the observation the candidate was derived from. */
	ref?: string;
	role?: string;
	title?: string;
	/** Native AX action name for `press`/`scroll-to-visible`. */
	axAction?: string;
	/** Caller-authorized text; absent on a `set-value` candidate whose text is resolved at execution time. */
	text?: string;
	/** Key of `options.values` the text came from. */
	valueKey?: string;
	waitMs?: number;
}

/** One accessibility node of an observation, structured (never the text tree). */
export interface DesktopNode {
	ref: string;
	role: string;
	nativeRole: string;
	title?: string;
	description?: string;
	value?: string;
	enabled: boolean;
	focused: boolean;
	childCount: number;
	frame?: { x: number; y: number; width: number; height: number };
	actions: string[];
	/** Role of the nearest enclosing sheet/dialog/alert, when the backend can see the ancestry. */
	container?: string;
}

/** Window identity and geometry at observation time. */
export interface DesktopWindowInfo {
	id: string;
	app: string;
	title: string;
	pid?: number;
	bounds: { x: number; y: number; width: number; height: number };
	focused: boolean;
}

/** One structured observation of one window. */
export interface DesktopObservation {
	identity: ObservationIdentity;
	window: DesktopWindowInfo;
	nodes: DesktopNode[];
	/** Nodes the native query returned before local filtering. */
	nodeCount: number;
	/** Native query hit its node cap, so the tree is partial. */
	truncated: boolean;
}

/** Where a `set-value` text came from. */
export type DesktopValueSource = "caller" | "model";

export interface ComputerTaskStep {
	index: number;
	/** Candidate id the judge answered with. */
	action: string;
	label: string;
	kind: DesktopActionKind;
	ref?: string;
	valueSource?: DesktopValueSource;
	outcome: ExecutionOutcome;
	/** Observation the candidate list was derived from. */
	observation: { revision: number; digest: string; nodeCount: number; truncated: boolean };
	/** How an `unknown` outcome was reconciled against a fresh observation. */
	reconciliation?: string;
	/** Whether the window content changed after the action. */
	changed?: boolean;
	probability: number;
	durationMs: number;
	provenance: DecisionProvenance;
}

/**
 * `done` requires a caller-supplied expectation to hold on re-observation;
 * `unverified` is a completion claim only the model corroborated; `failed` is
 * a transport/backend error after the loop started (attempts still accounted).
 */
export type ComputerTaskStatus =
	| "done"
	| "unverified"
	| "blocked"
	| "abstained"
	| "unsupported"
	| "exhausted"
	| "failed";

/** Which judge answered, mirrored from the decision provenance; `unknown` when no attempt named a backend. */
export interface ComputerTaskJudgeInfo {
	kind: JudgeKind | "unknown";
	label: string;
	model: string;
	distribution: "native" | "synthetic";
	fallback?: { from: string; reason?: string };
}

export interface ComputerTaskBackend {
	/** The path that actually executed actions. Only one path ever runs. */
	kind: DesktopBackendKind;
	/** `computer.task.backend` the selection was made under. */
	mode: DesktopBackendMode;
	/** Why this backend ran. */
	reason: string;
	driver: CuaDriverDetection;
	/** Driver version the selection was made against; present whenever the driver is installed. */
	version?: string;
	/** Grant snapshot the selection was made against; present whenever the driver is installed. */
	permissions?: CuaDriverPermissions;
	judge: ComputerTaskJudgeInfo;
}

export interface ComputerTaskResult {
	status: ComputerTaskStatus;
	reason?: string;
	goal: string;
	window: DesktopWindowInfo;
	steps: ComputerTaskStep[];
	verification: VerificationEvidence;
	/** Number of observations taken; each candidate list belongs to exactly one. */
	observationRevisions: number;
	budget: {
		maxCalls: number;
		maxActions: number;
		calls: number;
		actions: number;
		deadlineAt: number;
	};
	usage: { calls: number; attempts: number; input: number; output: number; costUsd: number | "unknown" };
	backend: ComputerTaskBackend;
	/** Provenance of every judgment and helper attempt, failed calls included. */
	attempts: DecisionProvenance[];
	/** Consequential actions withheld, candidate-window truncation, unverified DONE claims. */
	notes: string[];
}
