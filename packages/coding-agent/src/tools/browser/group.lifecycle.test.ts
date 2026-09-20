/**
 * Bounded, marker-identified tab groups — proven against the SHIPPED
 * extension asset (the bytes `omp browser-relay install` writes), not a
 * mirror: the worker chooses ONE OMP group per window by marked membership
 * or the stored id, merges concurrent requests into it, never dissolves
 * groups on reconnect, persists a user's drag-out as an opt-out, skips pinned
 * tabs, mints markers for the tabs it creates, reports its durable identity in
 * `hello`, and backs off after the relay rejects its Chrome profile. The bridge
 * side keeps marked (OMP-created) tabs grouped across client disconnects and
 * extension reconnects, publishes markers and the generation, and only
 * ungroups adopted tabs when their driver leaves.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
	removeRelayBindingFixture,
	TEST_HELLO_IDENTITY,
	writeRelayBindingFixture,
} from "../../../test/tools/relay-binding-fixture";
import {
	EXTENSION_MANIFEST_VERSION,
	ExtensionHarness,
	FAKE_USER_AGENT,
} from "../../../test/tools/relay-extension-harness";
import { RelayBridge, type RelaySocket } from "./relay/bridge";
import type { RelayRpcRequest, RelayToExtMessage, TabSnapshot } from "./relay/protocol";
import { RELAY_CLOSE_PROFILE_MISMATCH, RELAY_CLOSE_PROFILE_UNBOUND } from "./relay/protocol";

const TITLE = "omp";
const BINDING_PATH = await writeRelayBindingFixture();
afterAll(() => removeRelayBindingFixture(BINDING_PATH));

const GROUP = { op: "group", title: TITLE, color: "cyan" } as const;

describe("the shipped extension (extension-assets/background.js.txt)", () => {
	it("dials the relay and says hello with its durable identity, manifest version, and tab snapshots", async () => {
		const harness = new ExtensionHarness();
		harness.addTab({ id: 1, url: "https://a.example/", title: "A" });
		harness.load();
		const socket = await harness.connectRelay();
		expect(socket.url).toBe("ws://127.0.0.1:9224/ext");
		// generation is per Chrome run (session storage); installId is per install
		// (local storage): whatever the worker stored is exactly what it announces.
		const generation = harness.session.data.generation;
		const installId = harness.local.data.ompInstallId;
		expect(typeof generation).toBe("string");
		expect(typeof installId).toBe("string");
		expect(generation).not.toBe(installId);
		expect(socket.frame("hello")).toEqual({
			t: "hello",
			userAgent: FAKE_USER_AGENT,
			browserVersion: "Chrome/153.0.0.0",
			tabs: [
				{ tabId: 1, url: "https://a.example/", title: "A", active: false, windowId: 1, pinned: false, groupId: -1 },
			],
			attachedTabIds: [],
			generation,
			extensionVersion: "0.2.0",
			installId,
		});
		expect(EXTENSION_MANIFEST_VERSION).toBe("0.2.0");
		expect(harness.badge.text).toBe("on");
	});

	it("a restarted service worker keeps the persisted install id and generation instead of minting new ones", async () => {
		const first = new ExtensionHarness();
		first.load();
		const firstHello = (await first.connectRelay()).frame("hello")!;
		const second = new ExtensionHarness({ local: first.local.data, session: first.session.data });
		second.load();
		const hello = (await second.connectRelay()).frame("hello")!;
		expect(hello.installId).toBe(firstHello.installId);
		expect(hello.generation).toBe(firstHello.generation);
	});

	it("never dials with an id it could not persist: storage failure → '!' badge and a 60 s retry, then hello with the stored id", async () => {
		const harness = new ExtensionHarness();
		harness.local.failSet = true;
		harness.load();
		await harness.settle();
		expect(harness.sockets).toHaveLength(0);
		expect(harness.badge).toEqual({ text: "!", color: "#b42318" });
		expect("ompInstallId" in harness.local.data).toBe(false);

		harness.local.failSet = false;
		harness.advance(59_999);
		harness.fireAlarm();
		await harness.settle();
		expect(harness.sockets).toHaveLength(0);
		harness.advance(1);
		const hello = (await harness.connectRelay()).frame("hello")!;
		expect(hello.installId).toBe(harness.local.data.ompInstallId);
		expect(hello.generation).toBe(harness.session.data.generation);

		// The next worker start reads the same id back instead of minting again.
		const restarted = new ExtensionHarness({ local: harness.local.data, session: harness.session.data });
		restarted.load();
		expect((await restarted.connectRelay()).frame("hello")!.installId).toBe(hello.installId);
	});

	it("a per-run generation that cannot be persisted blocks the dial the same way", async () => {
		const harness = new ExtensionHarness();
		harness.session.failSet = true;
		harness.load();
		await harness.settle();
		expect(harness.sockets).toHaveLength(0);
		expect(harness.badge.text).toBe("!");
		harness.session.failSet = false;
		harness.advance(60_000);
		const hello = (await harness.connectRelay()).frame("hello")!;
		expect(hello.generation).toBe(harness.session.data.generation);
	});

	it("groups requested tabs into ONE group per window, titled and coloured, and reports every grouped tab", async () => {
		const harness = new ExtensionHarness();
		harness.addTab({ id: 1, windowId: 1 });
		harness.addTab({ id: 2, windowId: 1 });
		harness.addTab({ id: 3, windowId: 2 });
		harness.load();
		await harness.connectRelay();
		const result = await harness.rpc(1, { ...GROUP, tabIds: [1, 2, 3] });
		const [g1] = harness.groupsInWindow(1);
		const [g2] = harness.groupsInWindow(2);
		expect(harness.groupsInWindow(1)).toHaveLength(1);
		expect(harness.groupsInWindow(2)).toHaveLength(1);
		expect(result).toEqual({
			t: "rpcResult",
			id: 1,
			ok: true,
			result: { grouped: { "1": g1!.id, "2": g1!.id, "3": g2!.id } },
		});
		expect(g1).toMatchObject({ title: TITLE, color: "cyan" });
		expect(g2).toMatchObject({ title: TITLE, color: "cyan" });
		expect(harness.session.data.ompGroups).toEqual({ "1": g1!.id, "2": g2!.id });
	});

	it("two concurrent group RPCs for the same window merge into one group instead of minting two", async () => {
		const harness = new ExtensionHarness();
		harness.addTab({ id: 1 });
		harness.addTab({ id: 2 });
		harness.load();
		await harness.connectRelay();
		harness.socket.receive({ t: "rpc", id: 1, ...GROUP, tabIds: [1] });
		harness.socket.receive({ t: "rpc", id: 2, ...GROUP, tabIds: [2] });
		for (let i = 0; i < 50 && !(harness.socket.rpcResult(1) && harness.socket.rpcResult(2)); i++)
			await harness.settle();
		const [group] = harness.groupsInWindow(1);
		expect(harness.groupsInWindow(1)).toHaveLength(1);
		expect(harness.tabs.get(1)!.groupId).toBe(group!.id);
		expect(harness.tabs.get(2)!.groupId).toBe(group!.id);
		// Exactly one create; the second request became a move into the existing group.
		const groupCalls = harness.calls.filter(call => call.api === "tabs.group");
		expect(groupCalls.filter(call => (call.args[0] as { groupId?: number }).groupId === undefined)).toHaveLength(1);
		expect(groupCalls.filter(call => (call.args[0] as { groupId?: number }).groupId === group!.id)).toHaveLength(1);
	});

	it("a reconnect neither dissolves nor duplicates the group; a stray marked tab is moved back into the stored one", async () => {
		const harness = new ExtensionHarness();
		harness.addTab({ id: 1 });
		harness.load();
		await harness.connectRelay();
		const created = await harness.rpc(1, { op: "createTab", url: "about:blank", active: false });
		const tab = (created.result as { tab: TabSnapshot }).tab;
		await harness.rpc(2, { ...GROUP, tabIds: [1, tab.tabId] });
		const [group] = harness.groupsInWindow(1);
		const createsBefore = harness.calls.filter(call => call.api === "tabs.group").length;

		// Relay goes away (normal close): groups stay, the worker re-dials after its backoff.
		harness.socket.closeFromRelay(1000);
		expect(harness.groupsInWindow(1)).toHaveLength(1);
		expect(harness.tabs.get(1)!.groupId).toBe(group!.id);
		harness.advance(1_000);
		await harness.settle();
		expect(harness.sockets).toHaveLength(2);
		await harness.connectRelay();
		const hello = harness.socket.frame("hello")!;
		expect(hello.generation).toBe(harness.session.data.generation);
		expect((hello.tabs as TabSnapshot[]).find(snap => snap.tabId === tab.tabId)).toMatchObject({
			ompMarker: tab.ompMarker,
			groupId: group!.id,
		});

		// The relay asks again (its reconnect regroup): everything already sits in the stored group → no mutation.
		const again = await harness.rpc(3, { ...GROUP, tabIds: [tab.tabId] });
		expect(harness.calls.filter(call => call.api === "tabs.group")).toHaveLength(createsBefore);
		expect((again.result as { grouped: Record<string, number> }).grouped).toEqual({ [String(tab.tabId)]: group!.id });
		expect(harness.groupsInWindow(1)).toHaveLength(1);

		// A marked tab that somehow left the group (not by the user) is moved back, never into a new group.
		harness.tabs.get(tab.tabId)!.groupId = -1;
		await harness.rpc(4, { ...GROUP, tabIds: [] });
		expect(harness.tabs.get(tab.tabId)!.groupId).toBe(group!.id);
		expect(harness.groupsInWindow(1)).toHaveLength(1);
	});

	it("a user dragging a marked tab out is a persisted opt-out that survives reconnects and worker restarts", async () => {
		const harness = new ExtensionHarness();
		harness.load();
		await harness.connectRelay();
		const created = await harness.rpc(1, { op: "createTab", url: "about:blank" });
		const tab = (created.result as { tab: TabSnapshot }).tab;
		await harness.rpc(2, { ...GROUP, tabIds: [tab.tabId] });
		const [group] = harness.groupsInWindow(1);
		expect(harness.tabs.get(tab.tabId)!.groupId).toBe(group!.id);

		harness.userMoveTab(tab.tabId, -1);
		await harness.settle();
		expect(harness.local.data.ompOptOut).toEqual({ [tab.ompMarker!]: true });

		// Same worker: the tab is left alone and reported as opted out.
		await harness.rpc(3, { ...GROUP, tabIds: [] });
		expect(harness.tabs.get(tab.tabId)!.groupId).toBe(-1);
		harness.socket.closeFromRelay(1000);
		harness.advance(1_000);
		const hello = (await harness.connectRelay()).frame("hello")!;
		expect((hello.tabs as TabSnapshot[]).find(snap => snap.tabId === tab.tabId)).toMatchObject({
			ompMarker: tab.ompMarker,
			optOut: true,
			groupId: -1,
		});

		// Fresh worker (Chrome reaped it) with the same storage: still honoured.
		const restarted = new ExtensionHarness({ local: harness.local.data, session: harness.session.data });
		restarted.addTab({ ...harness.tabs.get(tab.tabId)! });
		restarted.load();
		await restarted.connectRelay();
		await restarted.rpc(1, { ...GROUP, tabIds: [tab.tabId] });
		expect(restarted.tabs.get(tab.tabId)!.groupId).toBe(-1);
		expect(restarted.calls.filter(call => call.api === "tabs.group")).toHaveLength(0);
	});

	it("never groups pinned tabs, even when requested", async () => {
		const harness = new ExtensionHarness();
		harness.addTab({ id: 9, pinned: true });
		harness.load();
		await harness.connectRelay();
		const result = await harness.rpc(1, { ...GROUP, tabIds: [9] });
		expect(result.result).toEqual({ grouped: {} });
		expect(harness.calls.filter(call => call.api === "tabs.group")).toHaveLength(0);
		expect(harness.groupsInWindow(1)).toHaveLength(0);
	});

	it("mints a marker for each tab it creates (background by request) and forgets it when the tab is removed", async () => {
		const harness = new ExtensionHarness();
		harness.load();
		await harness.connectRelay();
		const created = await harness.rpc(1, { op: "createTab", url: "https://x.example/", active: false });
		const tab = (created.result as { tab: TabSnapshot }).tab;
		expect(harness.calls.find(call => call.api === "tabs.create")?.args).toEqual([
			{ url: "https://x.example/", active: false },
		]);
		expect(typeof tab.ompMarker).toBe("string");
		expect(harness.session.data.ompTabs).toEqual({ [String(tab.tabId)]: tab.ompMarker });
		// Chrome fires onCreated before the create call resolves, so only the RPC result carries the marker.
		expect(harness.socket.frames.find(frame => frame.t === "tabCreated")).toEqual({
			t: "tabCreated",
			tab: {
				tabId: tab.tabId,
				url: "https://x.example/",
				title: "Example",
				active: false,
				windowId: 1,
				pinned: false,
				groupId: -1,
			},
		});

		await harness.rpc(2, { op: "removeTab", tabId: tab.tabId });
		expect(harness.tabs.has(tab.tabId)).toBe(false);
		expect(harness.session.data.ompTabs).toEqual({});
		expect(harness.socket.frames.find(frame => frame.t === "tabRemoved")).toEqual({
			t: "tabRemoved",
			tabId: tab.tabId,
		});
	});

	it("ungroups only adopted tabs; marked tabs keep their group", async () => {
		const harness = new ExtensionHarness();
		harness.addTab({ id: 1 });
		harness.load();
		await harness.connectRelay();
		const created = await harness.rpc(1, { op: "createTab", url: "about:blank" });
		const marked = (created.result as { tab: TabSnapshot }).tab.tabId;
		await harness.rpc(2, { ...GROUP, tabIds: [1, marked] });
		const [group] = harness.groupsInWindow(1);
		await harness.rpc(3, { op: "ungroup", tabIds: [1, marked] });
		expect(harness.tabs.get(1)!.groupId).toBe(-1);
		expect(harness.tabs.get(marked)!.groupId).toBe(group!.id);
		expect(harness.calls.filter(call => call.api === "tabs.ungroup").map(call => call.args)).toEqual([[[1]]]);
	});

	it.each([
		["profile-mismatch", RELAY_CLOSE_PROFILE_MISMATCH],
		["profile-unbound", RELAY_CLOSE_PROFILE_UNBOUND],
	])(
		"after the relay closes with %s it shows '!' and backs off 60 s before dialing again, alarms included",
		async (reason, code) => {
			const harness = new ExtensionHarness();
			harness.load();
			await harness.connectRelay();
			harness.socket.closeFromRelay(code, reason);
			await harness.settle();
			expect(harness.badge).toEqual({ text: "!", color: "#b42318" });
			harness.advance(59_999);
			harness.fireAlarm();
			await harness.settle();
			expect(harness.sockets).toHaveLength(1);
			harness.advance(1);
			await harness.settle();
			expect(harness.sockets).toHaveLength(2);
			expect(harness.socket.url).toBe("ws://127.0.0.1:9224/ext");
		},
	);

	it("a normal close reconnects with exponential backoff and an 'off' badge", async () => {
		const harness = new ExtensionHarness();
		harness.load();
		await harness.connectRelay();
		harness.socket.closeFromRelay(1006);
		await harness.settle();
		expect(harness.badge).toEqual({ text: "off", color: "#8b8b8b" });
		harness.advance(999);
		await harness.settle();
		expect(harness.sockets).toHaveLength(1);
		harness.advance(1);
		await harness.settle();
		expect(harness.sockets).toHaveLength(2);
		harness.socket.closeFromRelay(1006);
		harness.advance(1_999);
		await harness.settle();
		expect(harness.sockets).toHaveLength(2);
		harness.advance(1);
		await harness.settle();
		expect(harness.sockets).toHaveLength(3);
	});
});

type ExtRpc<Op extends RelayRpcRequest["op"]> = { t: "rpc"; id: number } & Extract<RelayRpcRequest, { op: Op }>;

class FakeExtSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	readonly #acked = new Set<number>();
	send(text: string): void {
		this.messages.push(JSON.parse(text) as RelayToExtMessage);
	}
	close(): void {}
	rpcs<Op extends RelayRpcRequest["op"]>(op: Op): Array<ExtRpc<Op>> {
		return this.messages.filter((msg): msg is ExtRpc<Op> => msg.t === "rpc" && msg.op === op);
	}
	pending<Op extends RelayRpcRequest["op"]>(op: Op): Array<ExtRpc<Op>> {
		return this.rpcs(op).filter(msg => !this.#acked.has(msg.id));
	}
	markAcked(id: number): void {
		this.#acked.add(id);
	}
}

class FakeCdpSocket implements RelaySocket {
	readonly messages: Array<Record<string, unknown>> = [];
	send(text: string): void {
		this.messages.push(JSON.parse(text) as Record<string, unknown>);
	}
	close(): void {}
	resultOf(id: number): Record<string, unknown> | undefined {
		const msg = this.messages.find(m => m.id === id);
		return msg && "result" in msg && msg.result && typeof msg.result === "object"
			? (msg.result as Record<string, unknown>)
			: undefined;
	}
}

function snap(overrides: Partial<TabSnapshot> & { tabId: number }): TabSnapshot {
	return {
		url: "https://example.com/",
		title: "Example",
		active: false,
		windowId: 1,
		pinned: false,
		groupId: -1,
		...overrides,
	};
}

function hello(bridge: RelayBridge, ext: FakeExtSocket, tabs: TabSnapshot[], generation = "gen-A"): void {
	bridge.extConnected(ext);
	bridge.extMessage(
		ext,
		JSON.stringify({
			t: "hello",
			userAgent: "t",
			browserVersion: "Chrome/153.0.0.0",
			tabs,
			attachedTabIds: [],
			generation,
			...TEST_HELLO_IDENTITY,
		}),
	);
}

/** Extension double: answers group RPCs by putting every requested tab into `groupId`. */
function ackGroup(bridge: RelayBridge, ext: FakeExtSocket, groupId: number): number {
	let answered = 0;
	for (const rpc of ext.pending("group")) {
		ext.markAcked(rpc.id);
		const grouped: Record<string, number> = {};
		for (const tabId of rpc.tabIds) grouped[String(tabId)] = groupId;
		bridge.extMessage(ext, JSON.stringify({ t: "rpcResult", id: rpc.id, ok: true, result: { grouped } }));
		answered++;
	}
	return answered;
}

function ackAll(bridge: RelayBridge, ext: FakeExtSocket, op: RelayRpcRequest["op"], result: unknown = {}): void {
	for (const rpc of ext.pending(op)) {
		ext.markAcked(rpc.id);
		bridge.extMessage(ext, JSON.stringify({ t: "rpcResult", id: rpc.id, ok: true, result }));
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

let seq = 500;

describe("RelayBridge — marker-based groups", () => {
	it("publishes the generation and the created tab's marker, keeps the marked tab grouped when its driver disconnects, and reuses the group on reconnect", async () => {
		const bridge = new RelayBridge({ group: { title: TITLE, color: "cyan" }, bindingPath: BINDING_PATH });
		const ext = new FakeExtSocket();
		hello(bridge, ext, [snap({ tabId: 1 })]);
		expect(bridge.versionInfo("ws://x/cdp")["OMP-Browser-Generation"]).toBe("gen-A");

		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const createId = ++seq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: createId,
				method: "Target.createTarget",
				params: { url: "about:blank", background: true },
			}),
		);
		await flush();
		// The extension marks the tab it creates.
		for (const rpc of ext.pending("createTab")) {
			ext.markAcked(rpc.id);
			bridge.extMessage(
				ext,
				JSON.stringify({
					t: "rpcResult",
					id: rpc.id,
					ok: true,
					result: { tab: snap({ tabId: 2, ompMarker: "marker-b" }) },
				}),
			);
		}
		await flush();
		expect(cdp.resultOf(createId)).toEqual({ targetId: "PAGE2" });
		expect(bridge.markerOf("PAGE2")).toBe("marker-b");
		expect(bridge.markerOf("PAGE1")).toBeUndefined();
		expect(ackGroup(bridge, ext, 10)).toBe(1);
		await flush();
		expect(bridge.groupStateForTest()[2]).toBe(10);

		// Driver goes away: an adopted tab would be ungrouped; a marked tab stays.
		bridge.cdpClosed(conn);
		await flush();
		expect(ext.rpcs("ungroup")).toHaveLength(0);
		expect(bridge.groupStateForTest()[2]).toBe(10);

		// Extension reconnects (service-worker restart / relay restart) with the tab still in group 10.
		const groupRpcsBefore = ext.rpcs("group").length;
		bridge.extClosed(ext);
		hello(bridge, ext, [snap({ tabId: 1 }), snap({ tabId: 2, ompMarker: "marker-b", groupId: 10 })]);
		await flush();
		expect(ext.rpcs("group").length).toBe(groupRpcsBefore + 1);
		const regroup = ext.pending("group")[0]!;
		expect(regroup.tabIds).toEqual([2]);
		// (The shipped extension answers this by reusing stored group 10 — see "the shipped extension" below.)
		ackGroup(bridge, ext, 10);
		await flush();
		expect(bridge.groupStateForTest()[2]).toBe(10);
		// Repeated opens/reconnects never produced a second group id for this window.
		const groupIds = new Set(
			Object.values(bridge.groupStateForTest()).filter((id): id is number => id !== undefined),
		);
		expect([...groupIds]).toEqual([10]);
	});

	it("an adopted tab still leaves the group when its driver disconnects, and a persisted opt-out is honoured on hello", async () => {
		const bridge = new RelayBridge({ group: { title: TITLE, color: "cyan" }, bindingPath: BINDING_PATH });
		const ext = new FakeExtSocket();
		hello(bridge, ext, [snap({ tabId: 1 }), snap({ tabId: 3, ompMarker: "marker-c", optOut: true })]);
		await flush();
		// Opted-out marked tab: never requested.
		expect(ext.rpcs("group")).toHaveLength(0);

		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const attachId = ++seq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: attachId,
				method: "Target.attachToTarget",
				params: { targetId: "PAGE1", flatten: true },
			}),
		);
		ackAll(bridge, ext, "attach");
		await flush();
		const sessionId = cdp.resultOf(attachId)?.sessionId;
		expect(typeof sessionId).toBe("string");
		bridge.cdpMessage(conn, JSON.stringify({ id: ++seq, sessionId, method: "OMP.claimTarget" }));
		await flush();
		expect(ackGroup(bridge, ext, 10)).toBe(1);
		await flush();
		expect(bridge.groupStateForTest()[1]).toBe(10);
		bridge.cdpClosed(conn);
		await flush();
		expect(ext.rpcs("ungroup").map(rpc => rpc.tabIds)).toEqual([[1]]);
		expect(bridge.groupStateForTest()[1]).toBeUndefined();
	});
});
