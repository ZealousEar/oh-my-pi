/**
 * Wire protocol between the relay server and the Chrome extension.
 *
 * The extension dials out to `ws://127.0.0.1:<port>/ext` and exchanges JSON
 * messages. The relay drives the extension with numbered RPCs; the extension
 * pushes tab lifecycle and `chrome.debugger` events as they happen.
 *
 * Tab identity (extension 0.2.0): every tab the relay CREATES carries an
 * extension-minted per-tab UUID (`ompMarker`, kept in `chrome.storage.session`
 * so it dies with the Chrome run, exactly like tab ids). Markers — never the
 * group title — identify OMP-owned tabs and the one OMP group per window. A
 * user dragging a marked tab out of its group is a persistent opt-out
 * (`chrome.storage.local`, keyed by marker) that survives relay restarts.
 */

/** Minimal view of a Chrome tab shared between extension and relay. */
export interface TabSnapshot {
	tabId: number;
	url: string;
	title: string;
	active: boolean;
	windowId: number;
	/** Pinned tabs are never grouped (Chrome would silently unpin them). */
	pinned: boolean;
	/** Chrome tab group id; -1 when ungrouped. */
	groupId: number;
	/** Extension-minted UUID for a tab the relay created; absent on user tabs. */
	ompMarker?: string;
	/** The user pulled this marked tab out of the OMP group; never re-group it. */
	optOut?: boolean;
}

/** RPCs the relay may ask the extension to perform. */
export type RelayRpcRequest =
	| { op: "attach"; tabId: number }
	| { op: "detach"; tabId: number }
	| { op: "send"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	/** `active` false creates the tab in the background (CDP `Target.createTarget` `background`); omitted activates it. The created tab is marked. */
	| { op: "createTab"; url: string; active?: boolean }
	| { op: "removeTab"; tabId: number }
	| { op: "activateTab"; tabId: number }
	/**
	 * Add tabs to the window's single OMP group (found through marked members
	 * or the stored group id, never by title; duplicates are merged). Marked
	 * tabs that opted out and pinned tabs are skipped.
	 */
	| { op: "group"; tabIds: number[]; title: string; color: string }
	/** Ungroup adopted (unmarked) tabs the relay grouped; no-op for tabs it never grouped. */
	| { op: "ungroup"; tabIds: number[] };

/** Reply to the `group` RPC. */
export interface GroupRpcResult {
	/** tabId → groupId for every tab that ended up grouped. */
	grouped: Record<string, number>;
}

/** Messages sent relay → extension. */
export type RelayToExtMessage = ({ t: "rpc"; id: number } & RelayRpcRequest) | { t: "pong" };

/** Messages sent extension → relay. */
export type ExtToRelayMessage =
	| {
			t: "hello";
			userAgent: string;
			browserVersion: string;
			tabs: TabSnapshot[];
			/** Tabs that already have a `chrome.debugger` attachment (relay reconciles after a service-worker restart). */
			attachedTabIds: number[];
			/** Per-Chrome-run UUID (session storage); scopes durable relay tab records. Absent on the 0.1.0 extension. */
			generation?: string;
			/** Extension manifest version, so the relay can tell a legacy install apart. */
			extensionVersion?: string;
	  }
	| { t: "cdpEvent"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	| { t: "detached"; tabId: number; reason: string; relayInitiated?: boolean }
	| { t: "tabCreated"; tab: TabSnapshot }
	| { t: "tabUpdated"; tab: TabSnapshot }
	| { t: "tabRemoved"; tabId: number }
	| { t: "rpcResult"; id: number; ok: boolean; result?: unknown; error?: string }
	| { t: "ping" };

/** One Chrome tab group as the reconciler sees it. */
export interface GroupReconcileGroup {
	id: number;
	windowId: number;
	title: string;
}

/** One tab as the reconciler sees it (a subset of {@link TabSnapshot}). */
export interface GroupReconcileTab {
	tabId: number;
	windowId: number;
	groupId: number;
	pinned: boolean;
	ompMarker?: string;
	optOut?: boolean;
}

export interface GroupReconcileInput {
	/** Stable agent namespace: the title the OMP group carries. */
	title: string;
	groups: readonly GroupReconcileGroup[];
	tabs: readonly GroupReconcileTab[];
	/** Previously chosen OMP group per window (`String(windowId)` → groupId), validated against `groups`. */
	storedGroups: Readonly<Record<string, number>>;
	/** Tabs the caller wants grouped now (claimed or created); marked tabs are always candidates. */
	requested?: readonly number[];
}

export interface GroupReconcilePlan {
	/** Canonical OMP group per window after the plan runs (`String(windowId)` → groupId); absent when a window needs a new group. */
	canonical: Record<string, number>;
	/** Marked tabs (and requested adopted tabs) to move into an existing canonical group. */
	moves: Array<{ groupId: number; tabIds: number[] }>;
	/** Windows with no usable OMP group: create one from these tabs. */
	creates: Array<{ windowId: number; tabIds: number[] }>;
}

/**
 * Pure reconciliation shared (by mirroring) between the bridge tests and the
 * extension: ONE OMP group per window, identified by marked membership or the
 * stored id — never by title alone, so a user's own group named `omp` with no
 * marked tab is invisible here. Duplicate OMP groups (two groups in a window
 * both holding marked tabs) merge into the canonical one; only marked or
 * explicitly requested tabs ever move; pinned tabs and opted-out marked tabs
 * never move. Unmarked tabs of a duplicate group stay where they are.
 */
export function planGroupReconcile(input: GroupReconcileInput): GroupReconcilePlan {
	const requested = new Set(input.requested ?? []);
	const groupById = new Map<number, GroupReconcileGroup>();
	for (const group of input.groups) groupById.set(group.id, group);
	const markedByGroup = new Map<number, number>();
	const windows = new Set<number>();
	for (const tab of input.tabs) {
		windows.add(tab.windowId);
		if (tab.ompMarker && tab.groupId !== -1 && groupById.has(tab.groupId)) {
			markedByGroup.set(tab.groupId, (markedByGroup.get(tab.groupId) ?? 0) + 1);
		}
	}
	const plan: GroupReconcilePlan = { canonical: {}, moves: [], creates: [] };
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
			// An adopted (unmarked) tab sitting in some other group is the user's arrangement.
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
