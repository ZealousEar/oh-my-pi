/**
 * Which tabs and groups are omp's: a per-tab UUID ("marker") for every tab the relay created and each window's omp
 * group, both in `chrome.storage.session` so they live exactly as long as Chrome's tab and group ids do, and the
 * user's opt-outs in `chrome.storage.local`. Markers, never the group title, identify omp's tabs and its one group
 * per window.
 */

const TABS_KEY = "ompTabs";
const GROUPS_KEY = "ompGroups";
const OPT_OUT_KEY = "ompOptOut";

interface TabMarks {
	/** tabId → marker of each tab the relay created. */
	tabs: Record<string, string>;
	/** windowId → the window's omp group id. */
	groups: Record<string, number>;
	/** marker → true once the user dragged that tab out of the omp group. */
	optOut: Record<string, true>;
}

/** Loaded marks; {@link loading} memoizes the read so concurrent callers share one. */
let marks: TabMarks | null = null;
let loading: Promise<TabMarks> | null = null;

/** The entries of a stored record that `keep` accepts; a missing or malformed record is empty. */
function entriesOf<T>(value: unknown, keep: (entry: unknown) => entry is T): Record<string, T> {
	const kept: Record<string, T> = {};
	if (value === null || typeof value !== "object") return kept;
	for (const [key, entry] of Object.entries(value)) {
		if (keep(entry)) kept[key] = entry;
	}
	return kept;
}

/**
 * Read the marks from storage, once per worker start. Synchronous readers ({@link markerOf}, {@link optedOut},
 * {@link ompGroupOf}) see nothing until this resolved, so the hello awaits it before it snapshots any tab. A failed
 * read clears the memo and the next call retries.
 */
export function loadTabMarks(): Promise<void> {
	loading ??= (async () => {
		const [session, local] = await Promise.all([
			chrome.storage.session.get({ [TABS_KEY]: {}, [GROUPS_KEY]: {} }),
			chrome.storage.local.get({ [OPT_OUT_KEY]: {} }),
		]);
		marks = {
			tabs: entriesOf(session[TABS_KEY], (entry): entry is string => typeof entry === "string" && entry.length > 0),
			groups: entriesOf(session[GROUPS_KEY], (entry): entry is number => typeof entry === "number"),
			optOut: entriesOf(local[OPT_OUT_KEY], (entry): entry is true => entry === true),
		};
		return marks;
	})().catch((error: unknown) => {
		loading = null;
		throw error;
	});
	return loading.then(() => {});
}

/** Forget the loaded marks, as a service-worker restart does; the next {@link loadTabMarks} reads storage again. */
export function dropLoadedTabMarks(): void {
	marks = null;
	loading = null;
}

function saveSession(loaded: TabMarks): void {
	chrome.storage.session.set({ [TABS_KEY]: loaded.tabs, [GROUPS_KEY]: loaded.groups }).catch(() => {});
}

/** The marker of a tab the relay created; undefined for the user's own tabs. */
export function markerOf(tabId: number): string | undefined {
	return marks?.tabs[String(tabId)];
}

/** Whether the user dragged the tab carrying `marker` out of the omp group. */
export function optedOut(marker: string): boolean {
	return marks?.optOut[marker] === true;
}

/** The omp group of `windowId` as of the last reconcile. */
export function ompGroupOf(windowId: number): number | undefined {
	return marks?.groups[String(windowId)];
}

/** windowId → omp group id as of the last reconcile. */
export function ompGroups(): Record<string, number> {
	return marks?.groups ?? {};
}

/** Mark `tabId` as created by the relay and return its marker; a tab keeps the marker it already has. */
export async function markTab(tabId: number): Promise<string> {
	await loadTabMarks();
	if (!marks) throw new Error("tab marks did not load");
	const key = String(tabId);
	const existing = marks.tabs[key];
	if (existing) return existing;
	const marker = crypto.randomUUID();
	marks.tabs[key] = marker;
	saveSession(marks);
	return marker;
}

/** Drop the marker of a tab that closed. */
export function forgetTabMarker(tabId: number): void {
	if (!marks || marks.tabs[String(tabId)] === undefined) return;
	delete marks.tabs[String(tabId)];
	saveSession(marks);
}

/** Drop the markers of tabs not in `liveTabIds`: the worker slept through their `onRemoved`. */
export function pruneTabMarkers(liveTabIds: ReadonlySet<number>): void {
	if (!marks) return;
	let pruned = false;
	for (const key of Object.keys(marks.tabs)) {
		if (liveTabIds.has(Number(key))) continue;
		delete marks.tabs[key];
		pruned = true;
	}
	if (pruned) saveSession(marks);
}

/** Record each window's omp group after a reconcile. */
export function setOmpGroups(groups: Record<string, number>): void {
	if (!marks) return;
	marks.groups = groups;
	saveSession(marks);
}

/** Remember, across relay and worker restarts, that the user took the tab carrying `marker` out of the omp group. */
export function recordOptOut(marker: string): void {
	if (!marks || marks.optOut[marker]) return;
	marks.optOut[marker] = true;
	chrome.storage.local.set({ [OPT_OUT_KEY]: marks.optOut }).catch(() => {});
}
