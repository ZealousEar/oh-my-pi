/**
 * Runs the SHIPPED relay extension asset (`extension-assets/background.js.txt`,
 * the bytes `omp browser-relay install` writes) inside a fake `chrome` API,
 * a fake `WebSocket`, and a manual clock, so tests drive the real handlers
 * instead of a mirrored copy. Assertions go through the fake's call log and
 * state, never the asset's source text.
 */
import * as path from "node:path";

const ASSET_DIR = path.resolve(import.meta.dir, "../../src/tools/browser/relay/extension-assets");
const ASSET = await Bun.file(path.join(ASSET_DIR, "background.js.txt")).text();
const MANIFEST = JSON.parse(await Bun.file(path.join(ASSET_DIR, "manifest.json.txt")).text()) as { version: string };

export const EXTENSION_MANIFEST_VERSION = MANIFEST.version;
export const FAKE_USER_AGENT =
	"Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

export interface FakeTab {
	id: number;
	url: string;
	title: string;
	active: boolean;
	windowId: number;
	pinned: boolean;
	groupId: number;
}

export interface FakeGroup {
	id: number;
	windowId: number;
	title: string;
	color: string;
}

type Listener = (...args: unknown[]) => void;

class FakeEvent {
	readonly #listeners: Listener[] = [];
	addListener(listener: Listener): void {
		this.#listeners.push(listener);
	}
	removeListener(listener: Listener): void {
		const index = this.#listeners.indexOf(listener);
		if (index !== -1) this.#listeners.splice(index, 1);
	}
	emit(...args: unknown[]): void {
		for (const listener of this.#listeners.slice()) listener(...args);
	}
}

class FakeStorageArea {
	readonly data: Record<string, unknown> = {};
	/** When true every `set` rejects (Chrome storage unavailable). */
	failSet = false;
	constructor(
		private readonly onChanged: FakeEvent,
		private readonly areaName: string,
	) {}
	async get(defaults: Record<string, unknown>): Promise<Record<string, unknown>> {
		const out: Record<string, unknown> = {};
		for (const key in defaults) out[key] = key in this.data ? structuredClone(this.data[key]) : defaults[key];
		return out;
	}
	async set(items: Record<string, unknown>): Promise<void> {
		if (this.failSet) throw new Error(`chrome.storage.${this.areaName} is unavailable`);
		const changes: Record<string, unknown> = {};
		for (const key in items) {
			changes[key] = { oldValue: this.data[key], newValue: items[key] };
			this.data[key] = structuredClone(items[key]);
		}
		this.onChanged.emit(changes, this.areaName);
	}
}

/** One outbound websocket the extension opened; the test plays the relay side. */
export class FakeSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readyState = FakeSocket.CONNECTING;
	/** Frames the extension sent, parsed. */
	readonly frames: Array<Record<string, unknown>> = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly url: string) {}
	send(text: string): void {
		this.frames.push(JSON.parse(text) as Record<string, unknown>);
	}
	/** Extension-initiated close (normal code). */
	close(): void {
		this.#finish(1000, "");
	}
	/** Relay accepted the dial. */
	open(): void {
		this.readyState = FakeSocket.OPEN;
		this.onopen?.();
	}
	/** Relay → extension frame. */
	receive(frame: Record<string, unknown>): void {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
	/** Relay closed the socket with `code`. */
	closeFromRelay(code: number, reason = ""): void {
		this.#finish(code, reason);
	}
	#finish(code: number, reason: string): void {
		if (this.readyState === FakeSocket.CLOSED) return;
		this.readyState = FakeSocket.CLOSED;
		this.onclose?.({ code, reason });
	}
	frame<T extends string>(t: T): Record<string, unknown> | undefined {
		return this.frames.find(frame => frame.t === t);
	}
	rpcResult(id: number): Record<string, unknown> | undefined {
		return this.frames.find(frame => frame.t === "rpcResult" && frame.id === id);
	}
}

interface Timer {
	id: number;
	at: number;
	fn: () => void;
	interval?: number;
}

/** A loaded extension worker plus everything it can touch. */
export class ExtensionHarness {
	readonly tabs = new Map<number, FakeTab>();
	readonly groups = new Map<number, FakeGroup>();
	readonly sockets: FakeSocket[] = [];
	/** Every `chrome.*` call the extension made, in order. */
	readonly calls: Array<{ api: string; args: unknown[] }> = [];
	readonly storageOnChanged = new FakeEvent();
	readonly local: FakeStorageArea;
	readonly session: FakeStorageArea;
	readonly events = {
		tabsOnCreated: new FakeEvent(),
		tabsOnUpdated: new FakeEvent(),
		tabsOnRemoved: new FakeEvent(),
		debuggerOnEvent: new FakeEvent(),
		debuggerOnDetach: new FakeEvent(),
		onAlarm: new FakeEvent(),
		onInstalled: new FakeEvent(),
		onStartup: new FakeEvent(),
		actionOnClicked: new FakeEvent(),
	};
	badge: { text: string; color: string } = { text: "", color: "" };
	now = 1_700_000_000_000;
	#timers: Timer[] = [];
	#timerSeq = 0;
	#nextTabId = 100;
	#nextGroupId = 1000;
	#uuidSeq = 0;

	constructor(opts: { local?: Record<string, unknown>; session?: Record<string, unknown> } = {}) {
		this.local = new FakeStorageArea(this.storageOnChanged, "local");
		this.session = new FakeStorageArea(this.storageOnChanged, "session");
		Object.assign(this.local.data, opts.local ?? {});
		Object.assign(this.session.data, opts.session ?? {});
	}

	/** Seed a tab before or after load; returns it. */
	addTab(overrides: Partial<FakeTab> = {}): FakeTab {
		const tab: FakeTab = {
			id: overrides.id ?? this.#nextTabId++,
			url: "https://example.com/",
			title: "Example",
			active: false,
			windowId: 1,
			pinned: false,
			groupId: -1,
			...overrides,
		};
		this.tabs.set(tab.id, tab);
		return tab;
	}

	groupsInWindow(windowId: number): FakeGroup[] {
		return [...this.groups.values()].filter(group => group.windowId === windowId);
	}

	/** The user drags a tab into (`groupId`) or out of (-1) a group. */
	userMoveTab(tabId: number, groupId: number): void {
		const tab = this.tabs.get(tabId);
		if (!tab) throw new Error(`no tab ${tabId}`);
		tab.groupId = groupId;
		this.events.tabsOnUpdated.emit(tabId, { groupId }, { ...tab });
	}

	/** Chrome's keepalive alarm fires. */
	fireAlarm(): void {
		this.events.onAlarm.emit({ name: "omp-relay-keepalive" });
	}

	/** Advance the fake clock, running due timers in order (intervals repeat). */
	advance(ms: number): void {
		const end = this.now + ms;
		for (;;) {
			const due = this.#timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			this.now = Math.max(this.now, due.at);
			if (due.interval !== undefined) due.at += due.interval;
			else this.#timers.splice(this.#timers.indexOf(due), 1);
			due.fn();
		}
		this.now = end;
	}

	/** Let the extension's promise chains settle (no fake-timer advance). */
	async settle(): Promise<void> {
		for (let i = 0; i < 20; i++) await Bun.sleep(0);
	}

	/** Newest socket the extension dialed. */
	get socket(): FakeSocket {
		const socket = this.sockets.at(-1);
		if (!socket) throw new Error("the extension has not dialed");
		return socket;
	}

	/** Open the newest socket and wait for its hello. */
	async connectRelay(): Promise<FakeSocket> {
		await this.settle();
		const socket = this.socket;
		socket.open();
		await this.settle();
		if (!socket.frame("hello")) throw new Error("extension sent no hello");
		return socket;
	}

	/** Send an RPC and wait for its result frame. */
	async rpc(id: number, request: Record<string, unknown>): Promise<Record<string, unknown>> {
		this.socket.receive({ t: "rpc", id, ...request });
		for (let i = 0; i < 50; i++) {
			await this.settle();
			const result = this.socket.rpcResult(id);
			if (result) return result;
		}
		throw new Error(`rpc ${id} never answered`);
	}

	#record(api: string, ...args: unknown[]): void {
		this.calls.push({ api, args: structuredClone(args) });
	}

	#setGroup(tabIds: number[], groupId: number): void {
		for (const tabId of tabIds) {
			const tab = this.tabs.get(tabId);
			if (!tab) throw new Error(`No tab with id: ${tabId}.`);
			if (tab.groupId === groupId) continue;
			tab.groupId = groupId;
			this.events.tabsOnUpdated.emit(tabId, { groupId }, { ...tab });
		}
	}

	#chrome(): Record<string, unknown> {
		const events = this.events;
		const record = this.#record.bind(this);
		return {
			tabs: {
				query: async (queryInfo: Record<string, unknown>) => {
					record("tabs.query", queryInfo);
					return [...this.tabs.values()].map(tab => ({ ...tab }));
				},
				get: async (tabId: number) => {
					record("tabs.get", tabId);
					const tab = this.tabs.get(tabId);
					if (!tab) throw new Error(`No tab with id: ${tabId}.`);
					return { ...tab };
				},
				create: async (props: { url?: string; active?: boolean }) => {
					record("tabs.create", props);
					const tab = this.addTab({ url: props.url ?? "about:blank", active: props.active ?? true });
					events.tabsOnCreated.emit({ ...tab });
					return { ...tab };
				},
				remove: async (tabId: number) => {
					record("tabs.remove", tabId);
					const tab = this.tabs.get(tabId);
					if (!tab) throw new Error(`No tab with id: ${tabId}.`);
					this.tabs.delete(tabId);
					events.tabsOnRemoved.emit(tabId, { windowId: tab.windowId });
				},
				update: async (tabId: number, props: { active?: boolean }) => {
					record("tabs.update", tabId, props);
					const tab = this.tabs.get(tabId);
					if (!tab) throw new Error(`No tab with id: ${tabId}.`);
					if (props.active !== undefined) tab.active = props.active;
					return { ...tab };
				},
				group: async (options: { tabIds: number[]; groupId?: number }) => {
					record("tabs.group", options);
					let groupId = options.groupId;
					if (groupId === undefined) {
						const first = this.tabs.get(options.tabIds[0]!);
						if (!first) throw new Error(`No tab with id: ${options.tabIds[0]}.`);
						groupId = this.#nextGroupId++;
						this.groups.set(groupId, { id: groupId, windowId: first.windowId, title: "", color: "grey" });
					} else if (!this.groups.has(groupId)) {
						throw new Error(`No group with id: ${groupId}.`);
					}
					this.#setGroup(options.tabIds, groupId);
					return groupId;
				},
				ungroup: async (tabIds: number[]) => {
					record("tabs.ungroup", tabIds);
					this.#setGroup(tabIds, -1);
					for (const group of Array.from(this.groups.values())) {
						if (![...this.tabs.values()].some(tab => tab.groupId === group.id)) this.groups.delete(group.id);
					}
				},
				onCreated: events.tabsOnCreated,
				onUpdated: events.tabsOnUpdated,
				onRemoved: events.tabsOnRemoved,
			},
			tabGroups: {
				query: async (queryInfo: Record<string, unknown>) => {
					record("tabGroups.query", queryInfo);
					return [...this.groups.values()].map(group => ({ ...group }));
				},
				update: async (groupId: number, props: { title?: string; color?: string }) => {
					record("tabGroups.update", groupId, props);
					const group = this.groups.get(groupId);
					if (!group) throw new Error(`No group with id: ${groupId}.`);
					if (props.title !== undefined) group.title = props.title;
					if (props.color !== undefined) group.color = props.color;
					return { ...group };
				},
			},
			windows: {
				update: async (windowId: number, props: Record<string, unknown>) => {
					record("windows.update", windowId, props);
					return {};
				},
			},
			debugger: {
				attach: async (target: unknown, version: string) => record("debugger.attach", target, version),
				detach: async (target: unknown) => record("debugger.detach", target),
				sendCommand: async (target: unknown, method: string, params?: unknown) => {
					record("debugger.sendCommand", target, method, params);
					return {};
				},
				getTargets: async () => {
					record("debugger.getTargets");
					return [];
				},
				onEvent: events.debuggerOnEvent,
				onDetach: events.debuggerOnDetach,
			},
			storage: { local: this.local, session: this.session, onChanged: this.storageOnChanged },
			alarms: {
				create: (name: string, info: unknown) => record("alarms.create", name, info),
				onAlarm: events.onAlarm,
			},
			action: {
				setBadgeText: async (details: { text: string }) => {
					record("action.setBadgeText", details);
					this.badge = { ...this.badge, text: details.text };
				},
				setBadgeBackgroundColor: async (details: { color: string }) => {
					record("action.setBadgeBackgroundColor", details);
					this.badge = { ...this.badge, color: details.color };
				},
				onClicked: events.actionOnClicked,
			},
			runtime: {
				getManifest: () => ({ version: MANIFEST.version }),
				openOptionsPage: async () => record("runtime.openOptionsPage"),
				onInstalled: events.onInstalled,
				onStartup: events.onStartup,
			},
		};
	}

	/** Execute the shipped asset (a fresh service-worker start) against this harness's state. */
	load(): void {
		const harness = this;
		const WebSocketCtor = class extends FakeSocket {
			constructor(url: string) {
				super(url);
				harness.sockets.push(this);
			}
		};
		const run = new Function(
			"chrome",
			"WebSocket",
			"crypto",
			"navigator",
			"Date",
			"setTimeout",
			"clearTimeout",
			"setInterval",
			"clearInterval",
			ASSET,
		) as (...args: unknown[]) => void;
		run(
			this.#chrome(),
			WebSocketCtor,
			{ randomUUID: () => `uuid-${++this.#uuidSeq}` },
			{ userAgent: FAKE_USER_AGENT },
			{ now: () => this.now },
			(fn: () => void, ms: number) => {
				const id = ++this.#timerSeq;
				this.#timers.push({ id, at: this.now + ms, fn });
				return id;
			},
			(id: number) => {
				this.#timers = this.#timers.filter(timer => timer.id !== id);
			},
			(fn: () => void, ms: number) => {
				const id = ++this.#timerSeq;
				this.#timers.push({ id, at: this.now + ms, fn, interval: ms });
				return id;
			},
			(id: number | undefined) => {
				if (id !== undefined) this.#timers = this.#timers.filter(timer => timer.id !== id);
			},
		);
	}
}
