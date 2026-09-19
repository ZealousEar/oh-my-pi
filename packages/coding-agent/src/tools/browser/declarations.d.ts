/** Navigation lifecycle accepted by browser open and goto operations. */
type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";

/** Browser application or attachment selection. */
interface BrowserAppOptions {
	/** Absolute or cwd-relative browser/Electron executable to spawn. Chromium-family browsers launch on an omp-owned profile unless `args` sets `--user-data-dir`. */
	path?: string;
	/** HTTP Chrome DevTools Protocol discovery endpoint to attach to. */
	cdp_url?: string;
	/** Drive the user's existing Chrome tabs through the omp Browser Relay. */
	relay?: boolean;
	/** Extra command-line arguments for a spawned executable. */
	args?: string[];
	/** URL/title substring used to select an attached tab. */
	target?: string;
	/** Relay/CDP only: create a fresh omp-owned tab (closed by `browser.close`) instead of adopting the user's visible tab. Mutually exclusive with `target`. */
	new_tab?: boolean;
}

/** Requested browser page viewport. */
interface BrowserViewportOptions {
	/** Viewport width in CSS pixels. */
	width: number;
	/** Viewport height in CSS pixels. */
	height: number;
	/** Device scale factor. */
	scale?: number;
}

/** Options for opening or reusing a named browser tab. */
interface BrowserOpenOptions {
	/** Tab name; defaults to `"main"`. */
	name?: string;
	/** URL to navigate to after opening or reusing the tab. */
	url?: string;
	/** Browser process, CDP endpoint, or relay selection. */
	app?: BrowserAppOptions;
	/** Requested page viewport. */
	viewport?: BrowserViewportOptions;
	/** Navigation lifecycle to await. */
	wait_until?: BrowserWaitUntil;
	/** Automatic JavaScript-dialog policy. */
	dialogs?: "accept" | "dismiss";
	/** Keep the tab live across turn settle and idle close (default false). */
	persist?: boolean;
	/** Open timeout in seconds, excluding first-use browser installation. */
	timeout?: number;
}

/** Options for releasing managed browser tabs. */
interface BrowserCloseOptions {
	/** Tab name; defaults to `"main"`. */
	name?: string;
	/** Release every managed tab instead of one named tab. */
	all?: boolean;
	/** Terminate an owned spawned application after its last tab is released. */
	kill?: boolean;
	/** Whole-operation timeout in seconds. */
	timeout?: number;
}

/** Options for closing the current tab handle. */
interface BrowserTabCloseOptions {
	/** Terminate an owned spawned application after its last tab is released. */
	kill?: boolean;
	/** Whole-operation timeout in seconds. */
	timeout?: number;
}

/** Arguments and budget for code executed by `BrowserTab.run`. */
interface BrowserRunOptions<TArgs extends unknown[] = unknown[]> {
	/** Positional arguments passed after the run-scope object. */
	args?: TArgs;
	/** Execution timeout in seconds. */
	timeout?: number;
}

/** Options for a direct tab navigation. */
interface BrowserGotoOptions {
	/** Navigation lifecycle to await. */
	waitUntil?: BrowserWaitUntil;
}

/** Options for a structured accessibility observation. */
interface BrowserObserveOptions {
	/** Include non-interactive accessibility nodes. */
	includeAll?: boolean;
	/** Limit results to nodes inside the current viewport. */
	viewportOnly?: boolean;
}

/** Options for a Playwright-format ARIA snapshot. */
interface BrowserAriaSnapshotOptions {
	/** Maximum tree depth to render. */
	depth?: number;
	/** Append element bounding boxes. */
	boxes?: boolean;
}

/** Options for capturing a browser screenshot. */
interface BrowserScreenshotOptions {
	/** Capture one matching element instead of the page. */
	selector?: string;
	/** Capture the complete scrollable page. */
	fullPage?: boolean;
	/** Save without emitting an Eval image. */
	silent?: boolean;
}

/** Options for keyboard input through a direct tab helper. */
interface BrowserPressOptions {
	/** Send the key to one matching element. */
	selector?: string;
}

/** Options for bounded direct wait helpers. */
interface BrowserWaitOptions {
	/** Wait timeout in milliseconds. */
	timeout?: number;
}

/** Options for polling a predicate inside `tab.run`. */
interface BrowserPollOptions extends BrowserWaitOptions {
	/** Delay between predicate calls in milliseconds. */
	interval?: number;
}

/** Options for waiting on a selector. */
interface BrowserWaitForSelectorOptions extends BrowserWaitOptions {
	/** Require the matching element to be visible. */
	visible?: boolean;
	/** Require the matching element to be hidden. */
	hidden?: boolean;
}

/** Options for waiting on browser navigation inside `tab.run`. */
interface BrowserWaitForNavigationOptions extends BrowserWaitOptions {
	/** Navigation lifecycle to await. */
	waitUntil?: BrowserWaitUntil;
}

/** A point in page coordinates used by drag operations. */
interface BrowserPoint {
	/** Horizontal page coordinate. */
	readonly x: number;
	/** Vertical page coordinate. */
	readonly y: number;
}

/** Selector or page point accepted by drag operations. */
type BrowserDragTarget = string | BrowserPoint;

/** Element bounds in page coordinates. */
interface BrowserBoundingBox {
	/** Left edge. */
	x: number;
	/** Top edge. */
	y: number;
	/** Width. */
	width: number;
	/** Height. */
	height: number;
}

/** One element in a structured browser observation. */
interface BrowserObservationEntry {
	/** Numeric id accepted by `tab.id`. */
	id: number;
	/** Accessibility role. */
	role: string;
	/** Accessible name. */
	name?: string;
	/** Current accessible value. */
	value?: string | number;
	/** Accessible description. */
	description?: string;
	/** Declared keyboard shortcut. */
	keyshortcuts?: string;
	/** Serialized accessibility states. */
	states: string[];
}

/** Structured result returned by `tab.observe`. */
interface BrowserObservation {
	/** Current page URL. */
	url: string;
	/** Current page title. */
	title?: string;
	/** Current viewport. */
	viewport: {
		/** Viewport width. */
		width: number;
		/** Viewport height. */
		height: number;
		/** Device scale factor. */
		deviceScaleFactor?: number;
	};
	/** Current document scroll metrics. */
	scroll: {
		/** Horizontal scroll offset. */
		x: number;
		/** Vertical scroll offset. */
		y: number;
		/** Visible width. */
		width: number;
		/** Visible height. */
		height: number;
		/** Full scrollable width. */
		scrollWidth: number;
		/** Full scrollable height. */
		scrollHeight: number;
	};
	/** Observed accessibility elements. */
	elements: BrowserObservationEntry[];
}

/** Polling/sleep helper available to a browser run function. */
interface BrowserWait {
	/** Sleep for a number of milliseconds. */
	(milliseconds: number): Promise<void>;
	/** Poll until the predicate returns a truthy value. */
	<R>(predicate: () => R | Promise<R>, options?: BrowserPollOptions): Promise<R>;
}

/** Assertion helper available to a browser run function. */
interface BrowserAssert {
	/** Throw with `message` when `condition` is falsy. */
	(condition: unknown, message?: string): asserts condition;
}

/** Browser-tab helpers shared by direct and run-realm handles. Ordinary page mutations require an exact current-origin/action scope. */
interface BrowserTabHelpers {
	/** Return the current page title. */
	title(): Promise<string>;
	/** Navigate the page. */
	goto(url: string, options?: BrowserGotoOptions): Promise<void>;
	/** Capture a structured accessibility observation. */
	observe(options?: BrowserObserveOptions): Promise<BrowserObservation>;
	/** Capture a Playwright-format ARIA snapshot. */
	ariaSnapshot(selector?: string, options?: BrowserAriaSnapshotOptions): Promise<string>;
	/** Capture the page or one matching element and return the saved path. */
	screenshot(options?: BrowserScreenshotOptions): Promise<string>;
	/** Extract readable page content. */
	extract(format?: "text" | "markdown"): Promise<string>;
	/** Click the element matching `selector`. */
	click(selector: string): Promise<void>;
	/** Type text into the element matching `selector`. */
	type(selector: string, text: string): Promise<void>;
	/** Replace the value of the element matching `selector`. */
	fill(selector: string, value: string): Promise<void>;
	/** Press a keyboard key, optionally on a matching element. */
	press(key: string, options?: BrowserPressOptions): Promise<void>;
	/** Scroll by page-relative deltas. */
	scroll(deltaX: number, deltaY: number): Promise<void>;
	/** Drag from one selector or point to another. */
	drag(from: BrowserDragTarget, to: BrowserDragTarget): Promise<void>;
	/** Evaluate a function or source string in the page. Raw execution requires a whole-browser or exact-code capability. */
	evaluate<R, TArgs extends unknown[]>(fn: string | ((...args: TArgs) => R | Promise<R>), ...args: TArgs): Promise<R>;
	/** Scroll the matching element into view. */
	scrollIntoView(selector: string): Promise<void>;
	/** Select values in the matching `<select>` element. */
	select(selector: string, ...values: string[]): Promise<string[]>;
	/** Upload files through the matching file input. */
	uploadFile(selector: string, ...filePaths: string[]): Promise<void>;
	/** Wait for the current URL to match a string or regular expression. */
	waitForUrl(pattern: string | RegExp, options?: BrowserWaitOptions): Promise<string>;
}

/** An element handle returned by `BrowserTab.id` or `BrowserTab.ref`; mutation methods use the tab's current-origin permission boundary. */
interface BrowserElement {
	/** Click this element. */
	click(): Promise<void>;
	/** Type text into this element. */
	type(text: string): Promise<void>;
	/** Replace this element's value. */
	fill(value: string): Promise<void>;
	/** Press a keyboard key on this element. */
	press(key: string): Promise<void>;
	/** Hover this element. */
	hover(): Promise<void>;
	/** Focus this element. */
	focus(): Promise<void>;
	/** Select values when this element is a `<select>`. */
	select(...values: string[]): Promise<string[]>;
	/** Upload files when this element is a file input. */
	uploadFile(...filePaths: string[]): Promise<void>;
	/** Scroll this element into view. */
	scrollIntoView(): Promise<void>;
	/** Return this element's page-coordinate bounds. */
	boundingBox(): Promise<BrowserBoundingBox | null>;
	/** Report whether this element is visible. */
	isVisible(): Promise<boolean>;
	/** Report whether this element is hidden. */
	isHidden(): Promise<boolean>;
	/** Evaluate a function or source string with this element as the first argument. */
	evaluate<R, TArgs extends unknown[]>(
		fn: string | ((element: unknown, ...args: TArgs) => R | Promise<R>),
		...args: TArgs
	): Promise<R>;
}

/** Full tab helper available inside the isolated `tab.run` realm. */
interface BrowserTabRealm extends BrowserTabHelpers {
	/** Managed-tab name. */
	readonly name: string;
	/** Raw Puppeteer page object. */
	readonly page: unknown;
	/** Abort signal for the active run. */
	readonly signal?: AbortSignal;
	/** Return the current page URL synchronously. */
	url(): string;
	/** Wait for and return an actionable element handle. */
	waitFor(selector: string, options?: BrowserWaitOptions): Promise<BrowserElement>;
	/** Wait for and return an element handle, or `null` when it remains absent. */
	waitForSelector(selector: string, options?: BrowserWaitForSelectorOptions): Promise<BrowserElement | null>;
	/** Wait for a matching network response and return the raw response object. */
	waitForResponse(
		pattern: string | RegExp | ((response: unknown) => boolean | Promise<boolean>),
		options?: BrowserWaitOptions,
	): Promise<unknown>;
	/** Wait for the next navigation and return its raw response when available. */
	waitForNavigation(options?: BrowserWaitForNavigationOptions): Promise<unknown | null>;
	/** Resolve a numeric observation id to an element handle. */
	id(id: number): Promise<BrowserElement>;
	/** Resolve an ARIA snapshot reference to an element handle. */
	ref(id: string): Promise<BrowserElement>;
}

/** Scope object passed as the first argument to a browser run function. */
interface BrowserRunScope {
	/** Full tab helper for the current run realm. */
	readonly tab: BrowserTabRealm;
	/** Raw Puppeteer page object. */
	readonly page: unknown;
	/** Raw Puppeteer browser object. */
	readonly browser: unknown;
	/** Polling and sleep helper. */
	readonly wait: BrowserWait;
	/** Assertion helper. */
	readonly assert: BrowserAssert;
}

/** Caller postconditions for `tab.task`; every supplied check must hold, and at least one is required for `done`. */
interface BrowserTaskExpect {
	/** The final URL must contain this substring. */
	urlIncludes?: string;
	/** The final visible page text must contain this substring. */
	textIncludes?: string;
	/** This selector must match a visible element at the end. */
	selector?: string;
}

/** Options for one bounded goal-directed task. */
interface BrowserTaskOptions {
	/** What to accomplish on this tab. */
	goal: string;
	/**
	 * Field values the caller authorizes, keyed by the field's label, placeholder,
	 * or form name. A key is used only when it equals one of those exactly
	 * (case, whitespace, and Unicode compatibility folded); unmatched keys are
	 * reported in `unusedValues` and never typed.
	 */
	values?: Record<string, string>;
	/** Checks that must pass before the result reports `done`; without any, the best status is `unverified`. */
	expect?: BrowserTaskExpect;
	/** Action bound; tightens `browser.task.maxActions`, never exceeds it. */
	maxActions?: number;
	/** Bound on metered calls (judgments plus text-helper completions); tightens `browser.task.maxCalls`, never exceeds it. */
	maxCalls?: number;
	/** Whole-task deadline in seconds; defaults to `browser.task.deadlineSec`. */
	timeout?: number;
	/**
	 * Permit controls classified consequential (submit, pay, delete, confirm, share, publish, sign out, ...,
	 * from the accessible name, visible text, aria-label, title, or select option; mixed-script names fail closed).
	 */
	allowConsequential?: boolean;
}

/** Which judge answered a step and how trustworthy its probabilities are. */
interface BrowserTaskProvenance {
	/** `typesafe`, `local`, or `online`. */
	backend: string;
	label: string;
	model: string;
	/** `native` probabilities, or `synthetic` one-hot from a chat keyword. */
	distribution: "native" | "synthetic";
	fallback?: string;
	costUsd: number | "unknown";
	durationMs: number;
	/** Confidence of the operation choice. */
	confidence: number;
	/** Probability the chosen target carried. */
	probability: number;
}

/** One executed (or refused) step of a task. */
interface BrowserTaskStep {
	n: number;
	operation: "CLICK" | "TYPE_TEXT" | "SELECT" | "SCROLL" | "WAIT" | "DONE" | "BLOCKED" | "ABSTAIN";
	/** Candidate id inside the operation's target head. */
	target?: string;
	label: string;
	/** `applied`, `rejected`, `stale`, or `unknown`. */
	outcome: string;
	/** For a refused consequential control: the keyword and which name carried it, or `unreadable label`. */
	reason?: string;
	/** `null` when the step performed no action. */
	pageChanged: boolean | null;
	ms: number;
	text?: string;
	textSource?: "values" | "model";
	/** Set when this step's `unknown` outcome withheld the action from later decisions. */
	quarantined?: true;
	provenance: BrowserTaskProvenance;
}

/** Evidence gathered independently of the model's own DONE claim. */
interface BrowserTaskVerification {
	/** `true` only when a caller `expect` check held; `"unknown"` when none was supplied. */
	verified: boolean | "unknown";
	method: string;
	detail?: string;
}

/** One remote attempt the task made: a judgment, a failed transport behind it, or a text-helper completion. */
interface BrowserTaskAttempt {
	backend: string;
	label: string;
	api: string;
	provider: string;
	model: string;
	distribution: "native" | "synthetic";
	fallback?: { from: string; reason?: string };
	usage: { input: number; output: number; cost: { total: number } };
	costUsd: number | "unknown";
	durationMs: number;
	/** 1-based logical call number; nested transport attempts share it. */
	attempt: number;
	/** Set when the attempt produced no answer. */
	error?: string;
	/** Set on a failed transport attempt behind a logical call. */
	nested?: true;
	/** Set on text-helper completions. */
	helper?: string;
}

/** An action withheld after an `unknown` outcome. */
interface BrowserTaskQuarantine {
	operation: string;
	label: string;
	documentKey: string;
	step: number;
}

/** Result of one `tab.task` run. */
interface BrowserTaskResult {
	status: "done" | "unverified" | "blocked" | "abstain" | "exhausted" | "error";
	reason?: string;
	goal: string;
	tab: string;
	steps: BrowserTaskStep[];
	verification: BrowserTaskVerification;
	/** How many atomic observations the loop took. */
	observationRevisions: number;
	budget: { calls: number; actions: number; elapsedMs: number; maxCalls: number; maxActions: number };
	/** `calls` are logical metered calls; `attempts` counts transport attempts behind them. */
	usage: { calls: number; attempts: number; input: number; output: number; costUsd: number | "unknown" };
	/** Every remote attempt, failed and nested ones included. */
	attempts: BrowserTaskAttempt[];
	backend: { kind: string; label: string; model?: string; distribution?: string; fallback?: string };
	/** `false` only when every derived candidate was offered to the judge. */
	candidatesTruncated: boolean;
	candidateFallback?: string;
	/** Widget families present but not drivable (canvas, file upload, frames, shadow roots). */
	unsupported?: string[];
	/** `values` keys that matched no field exactly and were never typed; present when `values` was given. */
	unusedValues?: string[];
	/** Actions withheld after an `unknown` outcome. */
	quarantined?: BrowserTaskQuarantine[];
}

/** A named browser tab handle returned by `browser.open` or `browser.tab`. */
interface BrowserTab extends BrowserTabHelpers {
	/** Immutable managed-tab name. */
	readonly name: string;
	/** Return the current page URL. */
	url(): Promise<string>;
	/** Wait for an actionable selector and report whether it appeared. */
	waitFor(selector: string, options?: BrowserWaitOptions): Promise<boolean>;
	/** Wait for a selector and report whether it appeared. */
	waitForSelector(selector: string, options?: BrowserWaitForSelectorOptions): Promise<boolean>;
	/** Return a numeric observation-id element proxy. */
	id(id: number): BrowserElement;
	/** Return an ARIA-reference element proxy. */
	ref(id: string): BrowserElement;
	/**
	 * Run one bounded goal-directed task on this tab: atomic observation, one
	 * typed judgment per step, guarded execution, independently verified
	 * completion. Every mutation is authorized immediately before dispatch
	 * against the current origin and exact action. Releases the tab when it
	 * finishes unless it was opened with `persist: true`.
	 */
	task(options: BrowserTaskOptions): Promise<BrowserTaskResult>;
	/** Run a serialized function in the tab runtime. Raw execution requires a whole-browser or exact-code capability. */
	run<R, TArgs extends unknown[]>(
		fn: (scope: BrowserRunScope, ...args: TArgs) => R | Promise<R>,
		options?: BrowserRunOptions<TArgs>,
	): Promise<R>;
	/** Run a JavaScript function body in the tab runtime. Raw execution requires a whole-browser or exact-code capability. */
	run<R = unknown>(code: string, options?: BrowserRunOptions): Promise<R>;
	/** Release this managed tab. */
	close(options?: BrowserTabCloseOptions): Promise<void>;
}

/** Session-scoped browser facade available in JavaScript Eval. */
declare const browser: {
	/** Open or reuse a tab and return its handle. */
	open(options?: BrowserOpenOptions): Promise<BrowserTab>;
	/** Return a handle for an existing named tab without opening it. */
	tab(name?: string): BrowserTab;
	/** Release one or all managed tabs. */
	close(options?: BrowserCloseOptions): Promise<void>;
};
