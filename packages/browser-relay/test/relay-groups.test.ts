import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { enqueueGroupOp, groupRelayTabs, noteUserRegroup } from "../extension/worker/groups";
import { dropLoadedTabMarks, markTab } from "../extension/worker/tab-marks";
import { removeTab, snapshot } from "../extension/worker/tabs";

const NONE = -1;

interface FakeTab {
	id: number;
	windowId: number;
	groupId: number;
	pinned: boolean;
}

interface FakeGroup {
	id: number;
	windowId: number;
	title: string;
	color: string;
}

/** One `chrome.storage` area that keeps what it is given. */
class FakeStorageArea {
	#data: Record<string, unknown> = {};

	get = async (defaults: Record<string, unknown>) => ({ ...defaults, ...structuredClone(this.#data) });

	set = async (items: Record<string, unknown>) => {
		Object.assign(this.#data, structuredClone(items));
	};
}

/**
 * Chrome with saved tab groups: every group is saved on creation. Closing a group's last tab closes the group but
 * keeps it saved; ungrouping its last tab deletes the saved group.
 */
class SavingChrome {
	tabs = new Map<number, FakeTab>();
	/** Groups shown in the tab strip; a closed group leaves here but stays in {@link saved}. */
	open = new Map<number, FakeGroup>();
	saved = new Map<number, FakeGroup>();
	#nextGroup = 100;
	#session = new FakeStorageArea();
	#local = new FakeStorageArea();

	/** Move a tab between groups the way a user drag does. */
	drag(id: number, groupId: number): void {
		this.#move(this.#tab(id), groupId);
	}

	/** The tab as Chrome hands it to a `tabs` listener. */
	chromeTab(id: number): chrome.tabs.Tab {
		return { ...this.#tab(id), active: false, discarded: false } as chrome.tabs.Tab;
	}

	addTab(id: number, windowId = 1): void {
		this.tabs.set(id, { id, windowId, groupId: NONE, pinned: false });
	}

	createGroup(windowId: number, title: string): number {
		const group = { id: this.#nextGroup++, windowId, title, color: "grey" };
		this.open.set(group.id, group);
		this.saved.set(group.id, group);
		return group.id;
	}

	savedTitles(): string[] {
		return [...this.saved.values()].map(group => group.title);
	}

	#move(tab: FakeTab, groupId: number): void {
		const prev = tab.groupId;
		tab.groupId = groupId;
		if (prev !== NONE && !this.#hasTabs(prev)) {
			this.open.delete(prev);
			this.saved.delete(prev);
		}
	}

	#hasTabs(groupId: number): boolean {
		return [...this.tabs.values()].some(tab => tab.groupId === groupId);
	}

	#tab(id: number): FakeTab {
		const tab = this.tabs.get(id);
		if (!tab) throw new Error(`No tab with id: ${id}.`);
		return tab;
	}

	api() {
		return {
			storage: { session: this.#session, local: this.#local },
			tabs: {
				get: async (id: number) => ({ ...this.#tab(id) }),
				query: async ({ groupId }: { groupId?: number }) =>
					[...this.tabs.values()].filter(tab => groupId === undefined || tab.groupId === groupId),
				group: async (options: { tabIds: number[]; groupId?: number; createProperties?: { windowId: number } }) => {
					const groupId = options.groupId ?? this.createGroup(options.createProperties?.windowId ?? 1, "");
					for (const id of options.tabIds) this.#move(this.#tab(id), groupId);
					return groupId;
				},
				ungroup: async (ids: number | number[]) => {
					for (const id of [ids].flat()) this.#move(this.#tab(id), NONE);
				},
				remove: async (id: number) => {
					const tab = this.#tab(id);
					this.tabs.delete(id);
					if (tab.groupId !== NONE && !this.#hasTabs(tab.groupId)) this.open.delete(tab.groupId);
				},
			},
			tabGroups: {
				TAB_GROUP_ID_NONE: NONE,
				query: async ({ title, windowId }: { title?: string; windowId?: number }) =>
					[...this.open.values()].filter(
						group =>
							(title === undefined || group.title === title) &&
							(windowId === undefined || group.windowId === windowId),
					),
				get: async (id: number) => {
					const group = this.open.get(id);
					if (!group) throw new Error(`No group with id: ${id}.`);
					return { ...group };
				},
				update: async (id: number, props: { title?: string; color?: string }) => {
					const group = this.open.get(id);
					if (group) Object.assign(group, props);
					return group;
				},
			},
		};
	}
}

describe("relay tab groups under Chrome's saved groups", () => {
	let chromeBefore: PropertyDescriptor | undefined;
	let browser: SavingChrome;

	beforeEach(() => {
		chromeBefore = Object.getOwnPropertyDescriptor(globalThis, "chrome");
		browser = new SavingChrome();
		Reflect.set(globalThis, "chrome", browser.api());
		dropLoadedTabMarks();
	});

	afterEach(() => {
		if (chromeBefore) Object.defineProperty(globalThis, "chrome", chromeBefore);
		else Reflect.deleteProperty(globalThis, "chrome");
	});

	it("leaves no saved omp group behind after the relay closes its tabs, session after session", async () => {
		for (const tabId of [1, 2, 3]) {
			browser.addTab(tabId);
			await groupRelayTabs([tabId], "omp", "cyan");
			await removeTab(tabId);
		}
		expect(browser.savedTitles()).toEqual([]);
		expect(browser.tabs.size).toBe(0);
	});

	it("keeps the omp group while another relay tab remains in it", async () => {
		browser.addTab(1);
		browser.addTab(2);
		const { grouped } = await groupRelayTabs([1, 2], "omp", "cyan");
		await removeTab(1);
		expect(browser.savedTitles()).toEqual(["omp"]);
		expect(browser.tabs.get(2)?.groupId).toBe(grouped["2"]!);
	});

	it("closes a tab in the user's own saved group without deleting that group", async () => {
		await groupRelayTabs([], "omp", "cyan");
		browser.addTab(5);
		const groupId = browser.createGroup(1, "research");
		browser.tabs.get(5)!.groupId = groupId;
		await removeTab(5);
		expect(browser.savedTitles()).toEqual(["research"]);
		expect(browser.tabs.has(5)).toBe(false);
	});

	it("gathers the tabs the relay created into one group and leaves the user's same-titled group alone", async () => {
		for (const tabId of [1, 2, 3]) browser.addTab(tabId);
		await markTab(1);
		await markTab(2);
		const users = browser.createGroup(1, "omp");
		browser.drag(3, users);

		const { grouped } = await groupRelayTabs([1], "omp", "cyan");

		expect(grouped["1"]).not.toBe(users);
		expect(browser.tabs.get(2)?.groupId).toBe(grouped["1"]!);
		expect(browser.tabs.get(3)?.groupId).toBe(users);
	});

	it("merges a duplicate omp group back into the window's one group", async () => {
		browser.addTab(1);
		browser.addTab(2);
		await markTab(1);
		await markTab(2);
		const { grouped } = await groupRelayTabs([], "omp", "cyan");
		browser.drag(2, browser.createGroup(1, "omp"));

		await groupRelayTabs([], "omp", "cyan");

		expect(browser.tabs.get(2)?.groupId).toBe(grouped["1"]!);
		expect(browser.savedTitles()).toEqual(["omp"]);
	});

	it("reports a created tab's marker, and keeps a tab the user dragged out ungrouped across a worker restart", async () => {
		browser.addTab(1);
		browser.addTab(2);
		const marker = await markTab(1);
		await markTab(2);
		const { grouped } = await groupRelayTabs([], "omp", "cyan");
		expect(snapshot(browser.chromeTab(1))).toMatchObject({ ompMarker: marker, groupId: grouped["1"]! });

		browser.drag(1, NONE);
		noteUserRegroup(browser.chromeTab(1));
		dropLoadedTabMarks();
		await groupRelayTabs([], "omp", "cyan");

		expect(snapshot(browser.chromeTab(1))).toMatchObject({ ompMarker: marker, optOut: true, groupId: NONE });
		expect(browser.tabs.get(2)?.groupId).toBe(grouped["2"]!);
	});

	it("does not take the relay's own regrouping for the user dragging a tab out", async () => {
		browser.addTab(1);
		await markTab(1);
		await groupRelayTabs([], "omp", "cyan");

		await enqueueGroupOp(async () => {
			browser.drag(1, NONE);
			noteUserRegroup(browser.chromeTab(1));
		});

		expect(snapshot(browser.chromeTab(1))?.optOut).toBeUndefined();
	});
});
