/** Input delivery: `background` targets the window without focusing it; `foreground` briefly activates it. */
type ComputerDelivery = "background" | "foreground";

/** Options shared by every native input helper. */
interface ComputerDeliveryOptions {
	delivery?: ComputerDelivery;
}

/** Options for pointer clicks. */
interface ComputerClickOptions extends ComputerDeliveryOptions {
	button?: "left" | "right" | "middle";
	count?: number;
	modifiers?: string[];
}

/** Options for pointer drags. */
interface ComputerDragOptions extends ComputerDeliveryOptions {
	modifiers?: string[];
}

/** Options for wheel scrolling; `dx`/`dy` are scroll units at the pointer position. */
interface ComputerScrollOptions extends ComputerDeliveryOptions {
	dx?: number;
	dy?: number;
}

/** Options for capturing a screenshot; `silent` skips the auto-displayed image. */
interface ComputerScreenshotOptions {
	silent?: boolean;
}

/** Options for an accessibility-tree snapshot. */
interface ComputerAxOptions {
	/** Include nodes that are normally pruned as non-interactive. */
	all?: boolean;
	maxDepth?: number;
}

/** Accessibility query matched against role, title, and value. */
interface ComputerAxQuery {
	role?: string;
	title?: string;
	value?: string;
	limit?: number;
}

/** Window filter matched against the owning app name and title. */
interface ComputerWindowFilter {
	app?: string;
	title?: string;
}

/** Rectangle in global desktop coordinates. */
interface ComputerBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** One capturable top-level window in global desktop coordinates. */
interface ComputerWindowInfo extends ComputerBounds {
	/** Opaque backend-defined id; never parse it. */
	id: string;
	app: string;
	title: string;
	pid?: number;
	focused: boolean;
}

/** Monitor geometry in both desktop coordinates and composite screenshot pixels. */
interface ComputerDisplay extends ComputerBounds {
	id: string;
	name: string;
	scale: number;
	pixelX: number;
	pixelY: number;
	pixelWidth: number;
	pixelHeight: number;
	isPrimary: boolean;
}

/** Saved screenshot frame; `width`/`height` are the emitted image size. */
interface ComputerScreenshotResult {
	path: string;
	width: number;
	height: number;
}

/** Native desktop backend and permission state. */
interface ComputerCapabilities {
	/** Active native backend identifier. */
	backend: string;
	/** Linux display-server kind when applicable. */
	displayServer?: string;
	capture: boolean;
	input: boolean;
	/** Whether OS accessibility automation is available. */
	ax: boolean;
	/** Whether input can target a background window. */
	backgroundWindowInput: boolean;
	deliveryModes: string[];
	capturePermission: string;
	inputPermission: string;
	axPermission: string;
	displayCount: number;
}

/** Live accessibility element resolved from a snapshot ref; expired refs throw `StaleRef`. Mutations require an exact focused-app/action scope. */
interface ComputerElement {
	/** Snapshot ref tag, e.g. `e5`. */
	readonly ref: string;
	readonly role: string;
	readonly nativeRole: string;
	readonly title?: string;
	readonly description?: string;
	readonly enabled: boolean;
	readonly focused: boolean;
	readonly childCount: number;
	value(): Promise<string | undefined>;
	setValue(value: string): Promise<void>;
	/** Bounds in global desktop coordinates, or null when the element has none. */
	bounds(): Promise<ComputerBounds | null>;
	attributes(): Promise<Record<string, string>>;
	actions(): Promise<string[]>;
	perform(action: string): Promise<void>;
	/** Perform the element's native press action; needs no screenshot. */
	press(): Promise<void>;
	/** Click the element's center with native input. */
	click(options?: ComputerDeliveryOptions): Promise<void>;
	focus(): Promise<void>;
	parent(): Promise<ComputerElement | null>;
	children(): Promise<ComputerElement[]>;
}

/** Native input helpers shared by the desktop root and window handles; mutations require an exact focused-app/action scope, and `x`/`y` use the most recent screenshot of the same target. */
interface ComputerInputTarget {
	screenshot(options?: ComputerScreenshotOptions): Promise<ComputerScreenshotResult>;
	click(x: number, y: number, options?: ComputerClickOptions): Promise<void>;
	doubleClick(x: number, y: number, options?: Omit<ComputerClickOptions, "count">): Promise<void>;
	move(x: number, y: number): Promise<void>;
	drag(points: Array<[number, number]>, options?: ComputerDragOptions): Promise<void>;
	scroll(x: number, y: number, options?: ComputerScrollOptions): Promise<void>;
	type(text: string, options?: ComputerDeliveryOptions): Promise<void>;
	/** Key chord such as `"cmd+shift+p"` or `["cmd", "shift", "p"]`. */
	press(chord: string | string[], options?: ComputerDeliveryOptions): Promise<void>;
}

/** Window handle resolved by `window`/`focusedWindow`; identity fields are a snapshot taken at resolution. */
interface ComputerWindow extends ComputerInputTarget {
	readonly id: string;
	readonly app: string;
	readonly title: string;
	readonly pid?: number;
	readonly bounds: ComputerBounds;
	readonly focused: boolean;
	raise(): Promise<void>;
	/** Formatted accessibility tree as one string, one node per line with `[ref=eN]` tags. */
	ax(options?: ComputerAxOptions): Promise<string>;
	find(query: ComputerAxQuery): Promise<ComputerElement[]>;
	/** Structured observation: refreshed window geometry plus every queried node with value, frame, and action names. */
	observe(options?: ComputerObserveOptions): Promise<ComputerObservation>;
	ref(ref: string): Promise<ComputerElement>;
}

/** Bounds on one structured observation. */
interface ComputerObserveOptions {
	/** Node cap for the accessibility query (1-1000, default 400). */
	maxNodes?: number;
}

/** One accessibility node of a structured observation, in global desktop coordinates. */
interface ComputerObservedNode extends Partial<ComputerBounds> {
	ref: string;
	role: string;
	nativeRole: string;
	title?: string;
	description?: string;
	value?: string;
	enabled: boolean;
	focused: boolean;
	childCount: number;
	/** Native AX action names, e.g. `AXPress`. */
	actions?: string[];
}

/** Structured accessibility observation of one window; `window` is null once it is gone. */
interface ComputerObservation {
	window: {
		id: string;
		app: string;
		title: string;
		pid?: number;
		bounds: ComputerBounds;
		focused: boolean;
	} | null;
	nodes: ComputerObservedNode[];
	nodeCount: number;
	/** The query hit `maxNodes`, so the node list is partial. */
	truncated: boolean;
}

/** Goal, target, and bounds for one `computer.task` run. */
interface ComputerTaskOptions {
	/** What to accomplish in the target window, in one sentence. */
	goal: string;
	/** Owning application name; combined with `window` when both are given. */
	app?: string;
	/** Exact opaque window id, a unique app/title filter, or `"focused"`. The focused window is never used implicitly. */
	window?: string | ComputerWindowFilter | "focused";
	/** Field values you authorize, matched to editable nodes by label or role. Unmatched fields are derived by a small model. */
	values?: Record<string, string>;
	/** Independent completion checks re-observed after the loop claims completion. */
	expect?: {
		titleIncludes?: string;
		find?: { role?: string; title?: string; value?: string };
	};
	/** Maximum desktop actions (default from `computer.task.maxActions`). */
	maxActions?: number;
	/** Maximum judgment calls (default from `computer.task.maxCalls`). */
	maxCalls?: number;
	/** Wall-clock budget in seconds (default from `computer.task.deadlineSec`). */
	timeout?: number;
	/** Required before send/delete/purchase-class actions are offered at all. */
	allowConsequential?: boolean;
}

/** One executed step of a desktop task. */
interface ComputerTaskStep {
	index: number;
	action: string;
	label: string;
	kind: string;
	ref?: string;
	/** Whether a typed value came from your `values` or from the small-model route. */
	valueSource?: "caller" | "model";
	/** `applied` | `rejected` | `stale` | `unknown`; `unknown` was reconciled by re-observation. */
	outcome: { status: string; reason?: string; detail?: string };
	observation: { revision: number; digest: string; nodeCount: number; truncated: boolean };
	reconciliation?: string;
	changed?: boolean;
	probability: number;
	durationMs: number;
}

/** Result of one desktop task; `done` only ever appears with `verification.verified === true`. */
interface ComputerTaskResult {
	status: "done" | "blocked" | "abstained" | "unsupported" | "exhausted";
	reason?: string;
	goal: string;
	window: { id: string; app: string; title: string; pid?: number; bounds: ComputerBounds; focused: boolean };
	steps: ComputerTaskStep[];
	verification: { verified: boolean | "unknown"; method: string; detail?: string };
	observationRevisions: number;
	budget: { maxCalls: number; maxActions: number; calls: number; actions: number; deadlineAt: number };
	usage: { calls: number; input: number; output: number; costUsd: number | "unknown" };
	backend: {
		/** The path that executed actions: the native accessibility backend or the user's running Cua Driver daemon. */
		kind: "native" | "cua";
		/** `computer.task.backend` the selection was made under. */
		mode: "auto" | "native" | "cua";
		reason: string;
		/** Cua Driver detection for this host; read-only probes, never started by the agent. */
		driver: Record<string, unknown>;
		/** Driver version and grant snapshot the selection used, when the driver is installed. */
		version?: string;
		permissions?: {
			accessibility: "granted" | "denied" | "unknown";
			screenRecording: "granted" | "denied" | "unknown";
		};
		judge: { kind: string; label: string; model: string; distribution: "native" | "synthetic" };
	};
	/** Withheld consequential actions, candidate windowing, unverified completion claims. */
	notes: string[];
}

/** Desktop helpers shared by the direct `computer` facade and the `desktop` object inside `computer.run`. */
interface ComputerDesktop extends ComputerInputTarget {
	displays(): Promise<ComputerDisplay[]>;
	windows(filter?: ComputerWindowFilter): Promise<ComputerWindowInfo[]>;
	/** Resolve exactly one window by opaque id or filter; ambiguous filters throw listing candidates. */
	window(selector: string | ComputerWindowFilter): Promise<ComputerWindow>;
	focusedWindow(): Promise<ComputerWindow | null>;
	/** Element under a global desktop coordinate. */
	elementAt(x: number, y: number): Promise<ComputerElement | null>;
	focusedElement(): Promise<ComputerElement | null>;
	ref(ref: string): Promise<ComputerElement>;
	readonly clipboard: {
		read(): Promise<string>;
		write(text: string): Promise<void>;
	};
}

/** Scope object passed as the first argument to a computer run function. */
interface ComputerRunScope {
	/** Persistent host-desktop facade; `capabilities()` is also available here. */
	readonly desktop: ComputerDesktop & { capabilities(): ComputerCapabilities };
	/** Sleep for milliseconds or poll a predicate until truthy. */
	readonly wait: (
		msOrPredicate: number | (() => unknown),
		options?: {
			/** Maximum polling time in milliseconds. */
			timeout?: number;
			/** Delay between predicate calls in milliseconds. */
			interval?: number;
		},
	) => Promise<unknown>;
	/** Throw with `message` when `condition` is falsy. */
	readonly assert: (condition: unknown, message?: string) => void;
}

/** Arguments and policy for code executed by `computer.run`. */
interface ComputerRunOptions {
	/** Positional arguments passed after the run-scope object. */
	args?: unknown[];
	/** Allow desktop inspection while blocking desktop-facade input and mutation. */
	read_only?: boolean;
	/** Execution timeout in seconds. */
	timeout?: number;
}

/** Session-scoped host-computer facade available in JavaScript Eval. Direct helpers each run one approved call. */
declare const computer: ComputerDesktop & {
	/** Run a serialized function in the persistent computer runtime. Writable raw execution requires an explicit whole-desktop or exact-code capability. */
	run<R>(
		fn: (scope: ComputerRunScope, ...args: unknown[]) => R | Promise<R>,
		options?: ComputerRunOptions,
	): Promise<Awaited<R>>;
	/** Run a JavaScript function body in the persistent computer runtime. Writable raw execution requires an explicit whole-desktop or exact-code capability. */
	run<R = unknown>(code: string, options?: ComputerRunOptions): Promise<R>;
	/**
	 * Pursue one goal in one explicitly targeted window: bounded observe/judge/
	 * act loop over the accessibility tree, with independent verification.
	 * Every mutation is authorized immediately before dispatch against a fresh
	 * observation of the focused application.
	 */
	task(options: ComputerTaskOptions): Promise<ComputerTaskResult>;
	/** Return native backend capabilities and permission state. */
	capabilities(): Promise<ComputerCapabilities | undefined>;
	/** End the persistent desktop session; later calls fail. */
	close(): Promise<void>;
};
