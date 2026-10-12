/**
 * Tab groups: the relay's one omp group per window (identified by the marked tabs it holds, never by title alone)
 * and the panel's titled conversation groups.
 */
import type { GroupRpcResult } from "../../../coding-agent/src/tools/browser/relay/protocol";
import { loadTabMarks, markerOf, ompGroupOf, ompGroups, optedOut, recordOptOut, setOmpGroups } from "./tab-marks";

/** Title of the relay's omp tab group; mirrored to session storage so a restarted service worker can still dissolve it. */
let relayGroupTitle: string | null = null;

/**
 * Serialize group mutations. Chrome's query→group→set-title sequence is not atomic: two concurrent runs both miss the
 * not-yet-titled group and mint duplicate "omp" groups in the same window.
 */
let groupOps: Promise<unknown> = Promise.resolve();
/** Above zero while a queued group mutation runs: the `onUpdated` it causes is not the user dragging a tab. */
let groupOpsRunning = 0;

/** Whether `ids` has an element, as `chrome.tabs.group`/`ungroup` require. */
export function isNonEmpty<T>(ids: T[]): ids is [T, ...T[]] {
	return ids.length > 0;
}

/** Run `fn` after every group mutation queued before it. */
export function enqueueGroupOp<T>(fn: () => Promise<T>): Promise<T> {
	const run = async () => {
		groupOpsRunning++;
		try {
			return await fn();
		} finally {
			groupOpsRunning--;
		}
	};
	const result = groupOps.then(run, run);
	groupOps = result.catch(() => {});
	return result;
}

async function loadRelayGroupTitle(): Promise<string | null> {
	if (relayGroupTitle) return relayGroupTitle;
	// Service worker restarted since the last group op; recover the title.
	const stored = await chrome.storage.session.get({ ompGroupTitle: "" }).catch(() => ({ ompGroupTitle: "" }));
	relayGroupTitle = typeof stored.ompGroupTitle === "string" && stored.ompGroupTitle ? stored.ompGroupTitle : null;
	return relayGroupTitle;
}

/** Unpinned tabs among `tabIds`, by window; grouping silently unpins, so pinned tabs are never touched. */
async function groupableByWindow(tabIds: number[]): Promise<Map<number, [number, ...number[]]>> {
	const byWindow = new Map<number, [number, ...number[]]>();
	for (const tabId of tabIds) {
		try {
			const tab = await chrome.tabs.get(tabId);
			if (tab.pinned || tab.id === undefined) continue;
			const bucket = byWindow.get(tab.windowId);
			if (bucket) bucket.push(tab.id);
			else byWindow.set(tab.windowId, [tab.id]);
		} catch {
			// Tab already closed.
		}
	}
	return byWindow;
}

type GroupColor = `${chrome.tabGroups.Color}`;
const GROUP_COLORS: readonly GroupColor[] = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

function isGroupColor(color: string): color is GroupColor {
	return GROUP_COLORS.some(known => known === color);
}

interface ReconcileGroup {
	id: number;
	windowId: number;
	title: string;
}

interface ReconcileTab {
	tabId: number;
	windowId: number;
	/** -1 when ungrouped. */
	groupId: number;
	pinned: boolean;
	/** Set on tabs the relay created. */
	ompMarker?: string;
	/** The user dragged this marked tab out of the omp group. */
	optOut?: boolean;
}

export interface ReconcileInput {
	title: string;
	groups: ReconcileGroup[];
	tabs: ReconcileTab[];
	/** windowId → group id remembered from the last reconcile. */
	storedGroups: Record<string, number>;
	/** Adopted (unmarked) tabs the relay asked to group this time. */
	requested: number[];
}

export interface ReconcilePlan {
	/** windowId → the group every omp tab of that window belongs in (existing groups only). */
	canonical: Record<string, number>;
	moves: Array<{ groupId: number; tabIds: number[] }>;
	/** Windows with omp tabs but no usable group yet. */
	creates: Array<{ windowId: number; tabIds: number[] }>;
}

/**
 * Choose ONE omp group per window: the stored id when it still exists in that window with the title, else the
 * same-titled group holding the most marked tabs, never a same-titled group with no marked tab (that one is the
 * user's). Marked tabs outside it and requested ungrouped adopted tabs move into it, which also merges duplicate
 * omp groups; a window with none gets a new group.
 */
export function planGroupReconcile(input: ReconcileInput): ReconcilePlan {
	const requested = new Set(input.requested);
	const groupById = new Map<number, ReconcileGroup>();
	for (const group of input.groups) groupById.set(group.id, group);
	const markedByGroup = new Map<number, number>();
	const windows = new Set<number>();
	for (const tab of input.tabs) {
		windows.add(tab.windowId);
		if (tab.ompMarker && tab.groupId !== -1 && groupById.has(tab.groupId)) {
			markedByGroup.set(tab.groupId, (markedByGroup.get(tab.groupId) ?? 0) + 1);
		}
	}
	const plan: ReconcilePlan = { canonical: {}, moves: [], creates: [] };
	for (const windowId of windows) {
		const key = String(windowId);
		const stored = input.storedGroups[key];
		const storedGroup = stored !== undefined ? groupById.get(stored) : undefined;
		let canonical: number | undefined =
			storedGroup && storedGroup.windowId === windowId && storedGroup.title === input.title
				? storedGroup.id
				: undefined;
		if (canonical === undefined) {
			let best = 0;
			for (const group of input.groups) {
				if (group.windowId !== windowId || group.title !== input.title) continue;
				const marked = markedByGroup.get(group.id) ?? 0;
				if (marked > best) {
					best = marked;
					canonical = group.id;
				}
			}
		}
		const movers: number[] = [];
		const newcomers: number[] = [];
		for (const tab of input.tabs) {
			if (tab.windowId !== windowId || tab.pinned) continue;
			const marked = tab.ompMarker !== undefined;
			if (marked && tab.optOut) continue;
			if (!marked && !requested.has(tab.tabId)) continue;
			// An adopted tab already inside some other (user) group stays there.
			if (!marked && tab.groupId !== -1 && tab.groupId !== canonical) continue;
			if (canonical !== undefined) {
				if (tab.groupId !== canonical) movers.push(tab.tabId);
			} else {
				newcomers.push(tab.tabId);
			}
		}
		if (canonical !== undefined) {
			plan.canonical[key] = canonical;
			if (movers.length > 0) plan.moves.push({ groupId: canonical, tabIds: movers });
		} else if (newcomers.length > 0) {
			plan.creates.push({ windowId, tabIds: newcomers });
		}
	}
	return plan;
}

/**
 * Move the requested tabs, and every marked tab that strayed, into their window's one omp group (relay `group` RPC).
 * The group is deliberately NOT dissolved when the relay disconnects: the next relay connection reuses it, and a tab
 * the user dragged out stays out. The user's own groups are never touched, the same title or not.
 */
export async function groupRelayTabs(tabIds: number[], title: string, color: string): Promise<GroupRpcResult> {
	if (!isGroupColor(color)) throw new Error(`unknown tab group color: ${color}`);
	relayGroupTitle = title;
	void chrome.storage.session.set({ ompGroupTitle: title });
	await loadTabMarks();
	const requested = [...(await groupableByWindow(tabIds)).values()].flat();
	const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
	const reconcileTabs: ReconcileTab[] = [];
	for (const tab of tabs) {
		if (tab.id === undefined) continue;
		const marker = markerOf(tab.id);
		reconcileTabs.push({
			tabId: tab.id,
			windowId: tab.windowId,
			groupId: tab.groupId,
			pinned: tab.pinned,
			ompMarker: marker,
			optOut: marker !== undefined && optedOut(marker),
		});
	}
	const plan = planGroupReconcile({
		title,
		groups: groups.map(group => ({ id: group.id, windowId: group.windowId, title: group.title ?? "" })),
		tabs: reconcileTabs,
		storedGroups: ompGroups(),
		requested,
	});
	const grouped: Record<string, number> = {};
	// Requested tabs already sitting in their window's omp group count as grouped.
	for (const tab of reconcileTabs) {
		const canonical = plan.canonical[String(tab.windowId)];
		if (canonical !== undefined && tab.groupId === canonical && requested.includes(tab.tabId)) {
			grouped[String(tab.tabId)] = canonical;
		}
	}
	for (const move of plan.moves) {
		if (!isNonEmpty(move.tabIds)) continue;
		await chrome.tabs.group({ tabIds: move.tabIds, groupId: move.groupId });
		for (const tabId of move.tabIds) grouped[String(tabId)] = move.groupId;
	}
	for (const create of plan.creates) {
		if (!isNonEmpty(create.tabIds)) continue;
		const groupId = await chrome.tabs.group({
			tabIds: create.tabIds,
			createProperties: { windowId: create.windowId },
		});
		plan.canonical[String(create.windowId)] = groupId;
		for (const tabId of create.tabIds) grouped[String(tabId)] = groupId;
	}
	setOmpGroups(plan.canonical);
	for (const groupId of Object.values(plan.canonical)) await chrome.tabGroups.update(groupId, { title, color });
	return { grouped };
}

/**
 * A marked tab that left its window's omp group while no group mutation of ours ran was dragged out by the user:
 * remember that, so no later reconcile moves it back.
 */
export function noteUserRegroup(tab: chrome.tabs.Tab): void {
	if (tab.id === undefined || groupOpsRunning > 0) return;
	const marker = markerOf(tab.id);
	if (marker === undefined) return;
	const canonical = ompGroupOf(tab.windowId);
	if (canonical !== undefined && tab.groupId !== canonical) recordOptOut(marker);
}

/**
 * Take `tabId` out of the relay's group before the relay closes it. Chrome saves every tab group, and closing a saved
 * group's last tab only closes the group, leaving an "omp" chip in the bookmarks bar per session; ungrouping deletes
 * it. Tabs in other groups are untouched: ungrouping the last tab of the user's own saved group would delete that one.
 */
export function ungroupRelayTab(tabId: number): Promise<void> {
	return enqueueGroupOp(async () => {
		const tab = await chrome.tabs.get(tabId).catch(() => null);
		if (!tab || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;
		const title = await loadRelayGroupTitle();
		if (!title) return;
		const group = await chrome.tabGroups.get(tab.groupId).catch(() => null);
		if (group?.title === title) await chrome.tabs.ungroup(tabId).catch(() => {});
	});
}

/**
 * Group a panel conversation's tabs under `title`, into `groupId` when given and still open. Never reuses a group by
 * title, and never the relay's omp group: dissolving that one on disconnect would scatter the conversation.
 */
export async function groupPanelTabs(tabIds: number[], title: string, groupId?: number): Promise<{ groupId: number }> {
	const ids = [...(await groupableByWindow(tabIds)).values()].flat();
	if (!isNonEmpty(ids)) throw new Error("no groupable tabs (closed or pinned)");
	const relayTitle = await loadRelayGroupTitle();
	const reuse = groupId === undefined ? null : await chrome.tabGroups.get(groupId).catch(() => null);
	let target: number;
	if (reuse && reuse.title !== relayTitle) {
		target = await chrome.tabs.group({ tabIds: ids, groupId: reuse.id });
	} else {
		const first = await chrome.tabs.get(ids[0]);
		target = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: first.windowId } });
	}
	await chrome.tabGroups.update(target, { title });
	return { groupId: target };
}
