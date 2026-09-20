/**
 * OMP Browser Relay — MV3 service worker (0.2.0).
 *
 * Dumb pipe by design: all CDP orchestration lives in the relay server. This
 * worker (1) keeps a websocket to the relay, (2) executes its RPCs against
 * `chrome.debugger`/`chrome.tabs`, and (3) streams tab + debugger events back.
 *
 * Service-worker lifetime: the open websocket plus a periodic ping keeps the
 * worker alive while connected (Chrome 116+); a chrome.alarms tick revives it
 * and re-dials after Chrome reaps it while disconnected.
 *
 * Tab identity: every tab the relay CREATES gets a per-tab UUID ("marker")
 * kept in chrome.storage.session, so it lives exactly as long as Chrome's tab
 * ids do. Markers — never the group title — identify OMP-owned tabs and the
 * ONE OMP group per window. A user dragging a marked tab out of that group is
 * a persistent opt-out (chrome.storage.local, keyed by marker) that survives
 * relay restarts and service-worker restarts. Groups are never dissolved on
 * relay disconnect; the next connection reuses them. User groups that merely
 * share the title are never touched: only marked tabs are ever moved.
 *
 * Profile identity: `ompInstallId` (chrome.storage.local) is minted once per
 * extension install per Chrome profile and reported in `hello`; the relay
 * binds to exactly one install and closes any other with 4403.
 *
 * This file is the single source: `bun scripts/build-extension.ts` bundles it
 * into `coding-agent/src/tools/browser/relay/extension-assets/background.js.txt`.
 */
import type {
	ExtToRelayMessage,
	RelayToExtMessage,
	TabSnapshot,
} from "../../coding-agent/src/tools/browser/relay/protocol";

const DEFAULT_PORT = 9224;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
/** Relay close codes for a profile it will not serve (see relay/protocol.ts). */
const CLOSE_PROFILE_UNBOUND = 4401;
const CLOSE_PROFILE_MISMATCH = 4403;
/** After a profile rejection or an identity-persistence failure: never hammer a relay / retry the mint at once. */
const REJECTED_BACKOFF_MS = 60_000;
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

let ws: WebSocket | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let pingTimer: NodeJS.Timeout | null = null;
/** `Date.now()` before which no dial is attempted (set by a 4401/4403 close or a failed identity persist). */
let rejectedUntil = 0;
const relayInitiatedDetachTabs = new Set<number>();

interface RelaySettings {
	port: number;
	token: string;
}

async function loadSettings(): Promise<RelaySettings> {
	const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: "" });
	const port = Number(stored.port);
	return {
		port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
		token: typeof stored.token === "string" ? stored.token : "",
	};
}

// ---- durable identity ------------------------------------------------------
// session: { generation, ompTabs: {tabId: marker}, ompGroups: {windowId: groupId} }
// local:   { ompOptOut: {marker: true}, ompInstallId }

interface Identity {
	/** Per-Chrome-run UUID (session storage). */
	generation: string;
	/** Per-install UUID (local storage; survives Chrome restarts). */
	installId: string;
	/** tabId → marker of tabs the relay created. */
	tabs: Record<string, string>;
	/** windowId → the window's OMP group id. */
	groups: Record<string, number>;
	/** marker → true once the user dragged that tab out of the OMP group. */
	optOut: Record<string, boolean>;
}

/**
 * Loaded identity; `identityPromise` memoizes the load itself so concurrent
 * callers never mint two ids. A failed load (Chrome storage unavailable)
 * clears the memo so the next dial retries; no hello ever carries an id that
 * was not stored and read back.
 */
let identity: Identity | null = null;
let identityPromise: Promise<Identity> | null = null;

function loadIdentity(): Promise<Identity> {
	identityPromise ??= readIdentity().catch(err => {
		identityPromise = null;
		throw err;
	});
	return identityPromise;
}

/** Persist `key` = `value` in `area` and prove it by reading it back; throws otherwise. */
async function persistId(area: "local" | "session", key: string, value: string): Promise<void> {
	await chrome.storage[area].set({ [key]: value });
	const readBack = await chrome.storage[area].get({ [key]: "" });
	if (readBack[key] !== value) throw new Error(`chrome.storage.${area} did not retain ${key}`);
}

async function readIdentity(): Promise<Identity> {
	const stored = await chrome.storage.session.get({ generation: "", ompTabs: {}, ompGroups: {} });
	const local = await chrome.storage.local.get({ ompOptOut: {}, ompInstallId: "" });
	let generation = typeof stored.generation === "string" ? stored.generation : "";
	if (!generation) {
		generation = crypto.randomUUID();
		await persistId("session", "generation", generation);
	}
	let installId = typeof local.ompInstallId === "string" ? local.ompInstallId : "";
	if (!installId) {
		installId = crypto.randomUUID();
		await persistId("local", "ompInstallId", installId);
	}
	identity = {
		generation,
		installId,
		tabs: stored.ompTabs && typeof stored.ompTabs === "object" ? (stored.ompTabs as Record<string, string>) : {},
		groups:
			stored.ompGroups && typeof stored.ompGroups === "object" ? (stored.ompGroups as Record<string, number>) : {},
		optOut: local.ompOptOut && typeof local.ompOptOut === "object" ? (local.ompOptOut as Record<string, boolean>) : {},
	};
	return identity;
}

function saveIdentity(): void {
	if (!identity) return;
	chrome.storage.session.set({ ompTabs: identity.tabs, ompGroups: identity.groups }).catch(() => {});
}

function saveOptOut(): void {
	if (!identity) return;
	chrome.storage.local.set({ ompOptOut: identity.optOut }).catch(() => {});
}

function markerOf(tabId: number): string | undefined {
	const marker = identity?.tabs[String(tabId)];
	return typeof marker === "string" ? marker : undefined;
}

async function markTab(tabId: number): Promise<string> {
	const id = await loadIdentity();
	const existing = id.tabs[String(tabId)];
	if (typeof existing === "string") return existing;
	const marker = crypto.randomUUID();
	id.tabs[String(tabId)] = marker;
	saveIdentity();
	return marker;
}

function snapshot(tab: ChromeTab): TabSnapshot | null {
	if (tab.id === undefined) return null;
	const marker = markerOf(tab.id);
	const snap: TabSnapshot = {
		tabId: tab.id,
		url: tab.url ?? tab.pendingUrl ?? "",
		title: tab.title ?? "",
		active: tab.active,
		windowId: tab.windowId,
		pinned: tab.pinned,
		groupId: tab.groupId,
	};
	if (marker) {
		snap.ompMarker = marker;
		if (identity?.optOut[marker]) snap.optOut = true;
	}
	return snap;
}

// ---- grouping ----------------------------------------------------------------

/**
 * Serialize group mutations. Chrome's query→group→set-title sequence is not
 * atomic: two concurrent runs both miss the not-yet-titled group and mint
 * duplicate "omp" groups in the same window.
 */
let groupOps: Promise<unknown> = Promise.resolve();
/** >0 while a relay-initiated group mutation runs: its onUpdated echoes are not user drags. */
let groupOpInFlight = 0;

function enqueueGroupOp<T>(fn: () => Promise<T>): Promise<T> {
	const result = groupOps.then(fn, fn);
	groupOps = result.catch(() => {});
	return result;
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
	ompMarker?: string;
	optOut?: boolean;
}

interface ReconcileInput {
	title: string;
	groups: ReconcileGroup[];
	tabs: ReconcileTab[];
	/** windowId → group id remembered from the last reconcile. */
	storedGroups: Record<string, number>;
	/** Adopted (unmarked) tabs the relay asked to group this time. */
	requested?: number[];
}

interface ReconcilePlan {
	/** windowId → the group every OMP tab of that window belongs in (existing groups only). */
	canonical: Record<string, number>;
	moves: Array<{ groupId: number; tabIds: number[] }>;
	/** Windows with OMP tabs but no usable group yet. */
	creates: Array<{ windowId: number; tabIds: number[] }>;
}

/**
 * Pure reconciliation: choose ONE OMP group per window (the stored id when it
 * still exists in that window with the title, else the same-titled group
 * holding the most marked tabs — never a same-titled group with no marked
 * tab), move stray marked tabs and requested ungrouped adopted tabs into it,
 * and create a group only for windows that have none.
 */
function planGroupReconcile(input: ReconcileInput): ReconcilePlan {
	const requested = new Set(input.requested ?? []);
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

async function reconcileInput(title: string, requested: number[]): Promise<ReconcileInput> {
	const id = await loadIdentity();
	const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
	return {
		title,
		groups: groups.map(g => ({ id: g.id, windowId: g.windowId, title: g.title ?? "" })),
		tabs: tabs
			.filter((t): t is ChromeTab & { id: number } => t.id !== undefined)
			.map(t => {
				const marker = markerOf(t.id);
				return {
					tabId: t.id,
					windowId: t.windowId,
					groupId: t.groupId,
					pinned: t.pinned,
					ompMarker: marker,
					optOut: marker ? !!id.optOut[marker] : false,
				};
			}),
		storedGroups: id.groups,
		requested,
	};
}

/**
 * Group the requested tabs into their window's single OMP group, merging
 * duplicate OMP groups and reusing the stored one. Returns {grouped}.
 */
async function groupTabs(tabIds: number[], title: string, color: string): Promise<{ grouped: Record<string, number> }> {
	const id = await loadIdentity();
	const requested: number[] = [];
	for (const tabId of tabIds) {
		try {
			const tab = await chrome.tabs.get(tabId);
			if (!tab.pinned && tab.id !== undefined) requested.push(tab.id);
		} catch {
			// Tab vanished between the relay's decision and now.
		}
	}
	const plan = planGroupReconcile(await reconcileInput(title, requested));
	const grouped: Record<string, number> = {};
	groupOpInFlight++;
	try {
		for (const move of plan.moves) {
			await chrome.tabs.group({ tabIds: move.tabIds, groupId: move.groupId });
			for (const tabId of move.tabIds) grouped[String(tabId)] = move.groupId;
		}
		for (const create of plan.creates) {
			const groupId = await chrome.tabs.group({ tabIds: create.tabIds });
			plan.canonical[String(create.windowId)] = groupId;
			for (const tabId of create.tabIds) grouped[String(tabId)] = groupId;
		}
		id.groups = plan.canonical;
		saveIdentity();
		for (const groupId of Object.values(plan.canonical)) {
			await chrome.tabGroups.update(groupId, { title, color }).catch(() => {});
		}
	} finally {
		groupOpInFlight--;
	}
	// Requested tabs already sitting in their canonical group count as grouped.
	for (const tabId of requested) {
		if (grouped[String(tabId)] !== undefined) continue;
		try {
			const tab = await chrome.tabs.get(tabId);
			const canonical = plan.canonical[String(tab.windowId)];
			if (canonical !== undefined && tab.groupId === canonical) grouped[String(tabId)] = canonical;
		} catch {
			// Tab vanished; it is simply not reported as grouped.
		}
	}
	return { grouped };
}

/** Ungroup adopted tabs only: a marked (OMP-created) tab keeps its group. */
async function ungroupTabs(tabIds: number[]): Promise<void> {
	const adopted = tabIds.filter(tabId => markerOf(tabId) === undefined);
	if (adopted.length === 0) return;
	groupOpInFlight++;
	try {
		await chrome.tabs.ungroup(adopted).catch(() => {});
	} finally {
		groupOpInFlight--;
	}
}

/**
 * A marked tab leaving its OMP group while no group op is running is the user
 * dragging it out: remember that forever (per marker).
 */
async function noteUserRegroup(tab: ChromeTab): Promise<void> {
	if (tab.id === undefined || groupOpInFlight > 0) return;
	const marker = markerOf(tab.id);
	if (!marker || !identity) return;
	const canonical = identity.groups[String(tab.windowId)];
	if (canonical === undefined) return;
	if (tab.groupId !== canonical && !identity.optOut[marker]) {
		identity.optOut[marker] = true;
		saveOptOut();
	}
}

// ---- relay link -----------------------------------------------------------------

function post(msg: ExtToRelayMessage): void {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function setBadge(connected: boolean, text = connected ? "on" : "off"): Promise<void> {
	try {
		await chrome.action.setBadgeText({ text });
		await chrome.action.setBadgeBackgroundColor({
			color: connected ? "#1a7f37" : text === "!" ? "#b42318" : "#8b8b8b",
		});
	} catch {
		// Badge is cosmetic; never let it break the relay loop.
	}
}

async function buildHello(): Promise<ExtToRelayMessage> {
	const id = await loadIdentity();
	const [tabs, targets] = await Promise.all([chrome.tabs.query({}), chrome.debugger.getTargets()]);
	// Forget markers of tabs that no longer exist (missed onRemoved while the worker slept).
	const live = new Set(tabs.map(tab => String(tab.id)));
	for (const key of Object.keys(id.tabs)) if (!live.has(key)) delete id.tabs[key];
	saveIdentity();
	const snapshots: TabSnapshot[] = [];
	for (const tab of tabs) {
		const snap = snapshot(tab);
		if (snap) snapshots.push(snap);
	}
	const attachedTabIds: number[] = [];
	for (const target of targets) {
		if (target.attached && target.tabId !== undefined) attachedTabIds.push(target.tabId);
	}
	const versionMatch = /Chrome\/[\d.]+/.exec(navigator.userAgent);
	return {
		t: "hello",
		userAgent: navigator.userAgent,
		browserVersion: versionMatch?.[0] ?? "Chrome/unknown",
		tabs: snapshots,
		attachedTabIds,
		generation: id.generation,
		extensionVersion: EXTENSION_VERSION,
		installId: id.installId,
	};
}

async function runRpc(msg: Extract<RelayToExtMessage, { t: "rpc" }>): Promise<unknown> {
	switch (msg.op) {
		case "attach":
			await chrome.debugger.attach({ tabId: msg.tabId }, "1.3");
			return {};
		case "detach":
			relayInitiatedDetachTabs.add(msg.tabId);
			try {
				await chrome.debugger.detach({ tabId: msg.tabId });
				return {};
			} catch (error) {
				relayInitiatedDetachTabs.delete(msg.tabId);
				throw error;
			}
		case "send":
			return await chrome.debugger.sendCommand(
				msg.sessionId ? { tabId: msg.tabId, sessionId: msg.sessionId } : { tabId: msg.tabId },
				msg.method,
				msg.params,
			);
		case "createTab": {
			const tab = await chrome.tabs.create({ url: msg.url, active: msg.active ?? true });
			if (tab.id === undefined) throw new Error("created tab has no id");
			await markTab(tab.id);
			const snap = snapshot(tab);
			if (!snap) throw new Error("created tab has no id");
			return { tab: snap };
		}
		case "removeTab":
			await chrome.tabs.remove(msg.tabId);
			return {};
		case "activateTab": {
			const tab = await chrome.tabs.get(msg.tabId);
			await chrome.windows.update(tab.windowId, { focused: true });
			await chrome.tabs.update(msg.tabId, { active: true });
			return {};
		}
		case "group":
			return await enqueueGroupOp(() => groupTabs(msg.tabIds, msg.title, msg.color));
		case "ungroup":
			await enqueueGroupOp(() => ungroupTabs(msg.tabIds));
			return {};
	}
}

function handleRelayMessage(raw: string): void {
	let msg: RelayToExtMessage;
	try {
		msg = JSON.parse(raw) as RelayToExtMessage;
	} catch {
		return;
	}
	if (msg.t === "pong") return;
	void runRpc(msg)
		.then(result => post({ t: "rpcResult", id: msg.id, ok: true, result }))
		.catch((err: unknown) => {
			post({ t: "rpcResult", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
		});
}

function scheduleReconnect(): void {
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	setTimeout(() => void connect(), delay);
}

async function connect(): Promise<void> {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
	if (Date.now() < rejectedUntil) return;
	try {
		await loadIdentity();
	} catch {
		// Identity could not be stored and read back: never dial with an id the
		// next worker start would not reproduce. Show it and retry later.
		rejectedUntil = Date.now() + REJECTED_BACKOFF_MS;
		void setBadge(false, "!");
		setTimeout(() => void connect(), REJECTED_BACKOFF_MS);
		return;
	}
	const settings = await loadSettings();
	const url = `ws://127.0.0.1:${settings.port}/ext${settings.token ? `?token=${encodeURIComponent(settings.token)}` : ""}`;
	const socket = new WebSocket(url);
	ws = socket;
	socket.onopen = () => {
		reconnectDelay = RECONNECT_MIN_MS;
		void setBadge(true);
		void buildHello().then(hello => post(hello));
		clearInterval(pingTimer ?? undefined);
		pingTimer = setInterval(() => post({ t: "ping" }), PING_INTERVAL_MS);
	};
	socket.onmessage = event => {
		if (typeof event.data === "string") handleRelayMessage(event.data);
	};
	socket.onclose = event => {
		if (ws !== socket) return;
		ws = null;
		if (pingTimer !== null) {
			clearInterval(pingTimer);
			pingTimer = null;
		}
		// Groups are left in place: the next relay connection reuses them.
		if (event.code === CLOSE_PROFILE_UNBOUND || event.code === CLOSE_PROFILE_MISMATCH) {
			// The relay refused this Chrome profile: show it and never hammer that
			// relay (the keepalive alarm honours the backoff too).
			rejectedUntil = Date.now() + REJECTED_BACKOFF_MS;
			void setBadge(false, "!");
			setTimeout(() => void connect(), REJECTED_BACKOFF_MS);
			return;
		}
		void setBadge(false);
		scheduleReconnect();
	};
	socket.onerror = () => {
		socket.close();
	};
}

// ---- event streaming ---------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
	if (source.tabId === undefined) return;
	post({ t: "cdpEvent", tabId: source.tabId, sessionId: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
	if (source.tabId === undefined) return;
	const relayInitiated = relayInitiatedDetachTabs.delete(source.tabId);
	post({ t: "detached", tabId: source.tabId, reason, relayInitiated });
});

chrome.tabs.onCreated.addListener(tab => {
	const snap = snapshot(tab);
	if (snap) post({ t: "tabCreated", tab: snap });
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
	if (changeInfo.groupId !== undefined) void noteUserRegroup(tab);
	const snap = snapshot(tab);
	if (snap) post({ t: "tabUpdated", tab: snap });
});

chrome.tabs.onRemoved.addListener(tabId => {
	if (identity && identity.tabs[String(tabId)] !== undefined) {
		delete identity.tabs[String(tabId)];
		saveIdentity();
	}
	post({ t: "tabRemoved", tabId });
});

// ---- lifecycle ----------------------------------------------------------------

chrome.alarms.create("omp-relay-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
	if (alarm.name === "omp-relay-keepalive") void connect();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local") return;
	if (!changes.port && !changes.token) return;
	// New endpoint or token: the rejection no longer applies.
	rejectedUntil = 0;
	ws?.close();
	void connect();
});

chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());

void connect();
