/**
 * Relay crash-transfer proof (review F1): a relay `new_tab` target is recorded
 * WITH the extension's per-tab marker, and a dead owner's marked record is
 * actually swept by another process through the live-marker match — the path
 * `orphanDecisionFor` retains forever when the marker is missing.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findFreeCdpPort } from "./attach";
import {
	ownedSharedTargets,
	reapOrphanSharedTargets,
	resetOrphanRegistryForTest,
	type SharedTargetScope,
} from "./orphan-registry";
import { acquireBrowser, type BrowserHandle, releaseBrowser } from "./registry";
import type { RelayRpcRequest, TabSnapshot } from "./relay/protocol";
import { type RelayServer, startRelayServer } from "./relay/server";
import {
	createOwnedTargetForTest,
	orphanDecisionFor,
	recordOwnedTargetForTest,
	relayLiveMarkersForTest,
	type WorkerTabSession,
} from "./tab-supervisor";
import { TEST_HELLO_IDENTITY, writeRelayBindingFixture } from "../../../test/tools/relay-binding-fixture";

const GENERATION = "gen-relay-test";
const MARKER = "11111111-2222-4333-8444-555555555555";

/**
 * Extension stand-in: 0.2.0 hello (generation), marked `createTab` snapshots,
 * `removeTab` echoed as `tabRemoved`, and the page probe answered "nothing
 * protects" so the sweep's decision reaches the close.
 */
class FakeExtension {
	readonly rpcs: RelayRpcRequest[] = [];
	readonly #ws: WebSocket;
	readonly #ready: Promise<void>;

	constructor(port: number) {
		this.#ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#ready = promise;
		this.#ws.addEventListener("error", () => reject(new Error("fake extension failed to connect")), { once: true });
		this.#ws.addEventListener(
			"open",
			() => {
				this.#ws.send(
					JSON.stringify({
						t: "hello",
						userAgent: "test",
						browserVersion: "Chrome/151.0.0.0",
						tabs: [],
						attachedTabIds: [],
						generation: GENERATION,
						...TEST_HELLO_IDENTITY,
					}),
				);
				resolve();
			},
			{ once: true },
		);
		this.#ws.addEventListener("message", event => this.#onRpc(JSON.parse(String(event.data))));
	}

	ready(): Promise<void> {
		return this.#ready;
	}

	close(): void {
		this.#ws.close();
	}

	#onRpc(msg: { t: string; id: number } & RelayRpcRequest): void {
		if (msg.t !== "rpc") return;
		this.rpcs.push(msg);
		let result: unknown = {};
		if (msg.op === "createTab") {
			const tab: TabSnapshot = {
				tabId: 7,
				url: msg.url,
				title: "",
				active: msg.active ?? true,
				windowId: 1,
				pinned: false,
				groupId: -1,
				ompMarker: MARKER,
			};
			result = { tab };
		} else if (msg.op === "removeTab") {
			const tabId = msg.tabId;
			queueMicrotask(() => this.#ws.send(JSON.stringify({ t: "tabRemoved", tabId })));
		} else if (msg.op === "send" && msg.method === "Runtime.evaluate") {
			// The reaper's protection probe: a plain, background page.
			result = {
				result: { value: { loginPath: false, credentialField: false, unsavedInput: false, visible: false } },
			};
		}
		this.#ws.send(JSON.stringify({ t: "rpcResult", id: msg.id, ok: true, result }));
	}
}

const roots: string[] = [];
afterEach(async () => {
	resetOrphanRegistryForTest();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function tempScope(): Promise<SharedTargetScope> {
	const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-record-"));
	roots.push(runtimeDir);
	return { runtimeDir, daemonName: "omp.browser.relay" };
}

describe("relay durable records — marker recorded, dead owner swept by marker", () => {
	it("stores the extension marker on the new_tab record and a later process closes the dead owner's marked tab", async () => {
		const port = await findFreeCdpPort();
		const cdpUrl = `http://127.0.0.1:${port}`;
		const bindingPath = await writeRelayBindingFixture();
		roots.push(path.dirname(bindingPath));
		const relay: RelayServer = startRelayServer({ port, bindingPath });
		const extension = new FakeExtension(port);
		let handle: BrowserHandle | undefined;
		try {
			await extension.ready();
			const deadline = Date.now() + 2_000;
			while ((await fetch(cdpUrl + "/json/version")).status !== 200) {
				if (Date.now() > deadline) throw new Error("relay never reported its extension");
				await Bun.sleep(20);
			}
			handle = await acquireBrowser({ kind: "relay", cdpUrl }, { cwd: process.cwd() });
			if (!("browser" in handle)) throw new Error("Expected a Puppeteer relay handle");
			expect(handle.generation).toBe(GENERATION);

			const owned = await createOwnedTargetForTest(handle);
			expect(owned.targetId).toBe("PAGE7");
			const scope = await tempScope();
			const tab = {
				name: "relay-owned",
				browser: handle,
				targetId: owned.targetId,
				state: "alive",
				info: { url: "about:blank", viewport: { width: 1, height: 1 }, targetId: owned.targetId },
				pending: new Map(),
				kindTag: "relay",
				backend: "worker",
				activateForScreenshot: false,
				ownsTarget: true,
				ownerSessionId: "session-dead",
				persist: false,
				lastActivityAt: 1_000,
				frozen: false,
			} as unknown as WorkerTabSession;
			await recordOwnedTargetForTest(tab, scope);
			const [record] = ownedSharedTargets(scope);
			expect(record).toMatchObject({ targetId: "PAGE7", marker: MARKER, generation: GENERATION, persist: false });

			// The same file, seen by ANOTHER process after this one died: the
			// sweep matches the live marker and closes through the extension.
			const file = path.join(scope.runtimeDir, "omp.browser.relay.targets", `${process.pid}.json`);
			const ghost = path.join(scope.runtimeDir, "omp.browser.relay.targets", "4000777.json");
			await fs.rename(file, ghost);
			await Bun.write(ghost, JSON.stringify({ ...(await Bun.file(ghost).json()), pid: 4_000_777 }));
			resetOrphanRegistryForTest();
			const liveMarkers = await relayLiveMarkersForTest(handle);
			expect(liveMarkers.get("PAGE7")).toBe(MARKER);
			const closedIds: string[] = [];
			const count = await reapOrphanSharedTargets(undefined, scope, {
				isAlive: () => false,
				now: () => 10_000_000_000_000,
				generation: GENERATION,
				decide: orphanDecisionFor(handle.browser, { idleMs: 3_600_000, kind: "relay", liveMarkers }),
				close: async id => {
					closedIds.push(id);
					await owned.close();
					return true;
				},
			});
			expect(count).toBe(1);
			expect(closedIds).toEqual(["PAGE7"]);
			expect(extension.rpcs.filter(rpc => rpc.op === "removeTab")).toEqual([
				expect.objectContaining({ op: "removeTab", tabId: 7 }),
			]);
			expect(await Bun.file(ghost).exists()).toBe(false);

			// A marker mismatch (user tab that reused the id) is never touched.
			await Bun.write(
				ghost,
				JSON.stringify({ version: 2, pid: 4_000_778, updatedAt: 0, targets: [{ ...record, marker: "other" }] }),
			);
			resetOrphanRegistryForTest();
			const untouched: string[] = [];
			await reapOrphanSharedTargets(undefined, scope, {
				isAlive: () => false,
				now: () => 10_000_000_000_000,
				generation: GENERATION,
				decide: orphanDecisionFor(handle.browser, { idleMs: 3_600_000, kind: "relay", liveMarkers }),
				close: async id => {
					untouched.push(id);
					return true;
				},
			});
			expect(untouched).toEqual([]);
		} finally {
			if (handle) await releaseBrowser(handle, { kill: false });
			extension.close();
			relay.stop();
		}
	}, 20_000);
});
