/**
 * Bounded, marker-identified tab groups.
 *
 * `planGroupReconcile` (mirrored verbatim in the extension) chooses ONE OMP
 * group per window by marked membership or the stored id — never by title —
 * merges duplicate OMP groups by moving only marked tabs, leaves user groups
 * titled `omp` alone, and never moves pinned or opted-out tabs. The bridge
 * keeps marked (OMP-created) tabs grouped across client disconnects and
 * extension reconnects, publishes markers and the generation, and only
 * ungroups adopted tabs when their driver leaves.
 */
import { describe, expect, it } from "bun:test";
import { RelayBridge, type RelaySocket } from "./relay/bridge";
import { planGroupReconcile, type RelayRpcRequest, type RelayToExtMessage, type TabSnapshot } from "./relay/protocol";

const TITLE = "omp";

describe("planGroupReconcile", () => {
	const marked = (
		tabId: number,
		groupId: number,
		windowId = 1,
		extra: Partial<Parameters<typeof planGroupReconcile>[0]["tabs"][number]> = {},
	) => ({
		tabId,
		windowId,
		groupId,
		pinned: false,
		ompMarker: `m-${tabId}`,
		...extra,
	});
	const user = (tabId: number, groupId: number, windowId = 1) => ({ tabId, windowId, groupId, pinned: false });

	it("reuses the stored group and moves only marked tabs into it (reconnect creates nothing)", () => {
		const plan = planGroupReconcile({
			title: TITLE,
			groups: [{ id: 10, windowId: 1, title: TITLE }],
			tabs: [marked(1, 10), marked(2, -1), user(3, -1)],
			storedGroups: { "1": 10 },
		});
		expect(plan).toEqual({ canonical: { "1": 10 }, moves: [{ groupId: 10, tabIds: [2] }], creates: [] });
	});

	it("merges duplicate OMP groups into the one with most marked tabs, leaving unmarked tabs where they are", () => {
		const plan = planGroupReconcile({
			title: TITLE,
			groups: [
				{ id: 10, windowId: 1, title: TITLE },
				{ id: 11, windowId: 1, title: TITLE },
			],
			tabs: [marked(1, 10), marked(2, 10), marked(3, 11), user(4, 11)],
			storedGroups: {},
		});
		expect(plan.canonical).toEqual({ "1": 10 });
		expect(plan.moves).toEqual([{ groupId: 10, tabIds: [3] }]);
		expect(plan.creates).toEqual([]);
	});

	it("never adopts a user's own group named omp when it holds no marked tab; creates a fresh group instead", () => {
		const plan = planGroupReconcile({
			title: TITLE,
			groups: [{ id: 42, windowId: 1, title: TITLE }],
			tabs: [user(7, 42), user(8, 42), marked(9, -1)],
			storedGroups: {},
		});
		expect(plan.canonical).toEqual({});
		expect(plan.moves).toEqual([]);
		expect(plan.creates).toEqual([{ windowId: 1, tabIds: [9] }]);
	});

	it("keeps groups per window, skips pinned and opted-out marked tabs, and only moves requested adopted tabs that are ungrouped", () => {
		const plan = planGroupReconcile({
			title: TITLE,
			groups: [
				{ id: 10, windowId: 1, title: TITLE },
				{ id: 20, windowId: 2, title: TITLE },
			],
			tabs: [
				marked(1, -1, 1, { optOut: true }),
				marked(2, -1, 1, { pinned: true }),
				marked(3, -1, 2),
				user(4, -1, 1),
				user(5, 99, 1),
				user(6, -1, 2),
			],
			storedGroups: { "1": 10, "2": 20 },
			requested: [4, 5],
		});
		expect(plan.canonical).toEqual({ "1": 10, "2": 20 });
		expect(plan.moves).toEqual([
			{ groupId: 10, tabIds: [4] },
			{ groupId: 20, tabIds: [3] },
		]);
		expect(plan.creates).toEqual([]);
	});

	it("a stored id that no longer exists or changed window/title is ignored", () => {
		const plan = planGroupReconcile({
			title: TITLE,
			groups: [{ id: 10, windowId: 2, title: TITLE }],
			tabs: [marked(1, -1, 1)],
			storedGroups: { "1": 10 },
		});
		expect(plan).toEqual({ canonical: {}, moves: [], creates: [{ windowId: 1, tabIds: [1] }] });
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
			extensionVersion: "0.2.0",
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
		const bridge = new RelayBridge({ group: { title: TITLE, color: "cyan" } });
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
					result: { tab: snap({ tabId: 2, ompMarker: "uuid-2" }) },
				}),
			);
		}
		await flush();
		expect(cdp.resultOf(createId)).toEqual({ targetId: "PAGE2" });
		expect(bridge.markerOf("PAGE2")).toBe("uuid-2");
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
		hello(bridge, ext, [snap({ tabId: 1 }), snap({ tabId: 2, ompMarker: "uuid-2", groupId: 10 })]);
		await flush();
		expect(ext.rpcs("group").length).toBe(groupRpcsBefore + 1);
		const regroup = ext.pending("group")[0]!;
		expect(regroup.tabIds).toEqual([2]);
		// The extension's plan for this hello creates nothing: stored group 10 exists and already holds the marked tab.
		const plan = planGroupReconcile({
			title: TITLE,
			groups: [{ id: 10, windowId: 1, title: TITLE }],
			tabs: [
				{ tabId: 1, windowId: 1, groupId: -1, pinned: false },
				{ tabId: 2, windowId: 1, groupId: 10, pinned: false, ompMarker: "uuid-2" },
			],
			storedGroups: { "1": 10 },
			requested: regroup.tabIds,
		});
		expect(plan.creates).toEqual([]);
		expect(plan.moves).toEqual([]);
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
		const bridge = new RelayBridge({ group: { title: TITLE, color: "cyan" } });
		const ext = new FakeExtSocket();
		hello(bridge, ext, [snap({ tabId: 1 }), snap({ tabId: 3, ompMarker: "uuid-3", optOut: true })]);
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
