import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import {
	DISCARDED_TABS_PROTOCOL_VERSION,
	RELAY_PROTOCOL_VERSION,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import {
	type RelayServer,
	type RelayUnavailableInfo,
	startRelayServer,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { removeRelayBindingFixture, TEST_HELLO_IDENTITY, writeRelayBindingFixture } from "./relay-binding-fixture";

const EXTENSION_HELLO = {
	t: "hello",
	userAgent: "test",
	browserVersion: "Chrome/151.0.0.0",
	tabs: [],
	attachedTabIds: [],
	...TEST_HELLO_IDENTITY,
} as const;

/** A 0.2.0-identified extension built before discarded-tab snapshots. */
const LEGACY_EXTENSION_HELLO = {
	t: "hello",
	userAgent: "test",
	browserVersion: "Chrome/151.0.0.0",
	tabs: [],
	attachedTabIds: [],
	...TEST_HELLO_IDENTITY,
	discardedTabsProtocol: undefined,
} as const;

/** 503 body of a legacy (protocol-1) relay: no `relayProtocol`, no binding, no `ompRelayVersion`. */
const LEGACY_UNAVAILABLE = {
	error: "relay extension is not connected",
	extensionSeen: false,
	uptimeMs: 60_000,
};

/** 200 body of a ready protocol-2 relay from this OMP version. */
function readyVersionBody(port: number | undefined, overrides: Record<string, string> = {}): Record<string, string> {
	return {
		Browser: "Chrome/151",
		"Protocol-Version": "1.3",
		"User-Agent": "test",
		"V8-Version": "",
		"WebKit-Version": "",
		webSocketDebuggerUrl: `ws://127.0.0.1:${port}/cdp`,
		ompRelayVersion: VERSION,
		ompRelayDiscardedTabsProtocol: String(DISCARDED_TABS_PROTOCOL_VERSION),
		ompExtensionDiscardedTabsProtocol: String(DISCARDED_TABS_PROTOCOL_VERSION),
		"OMP-Relay-Protocol": String(RELAY_PROTOCOL_VERSION),
		...overrides,
	};
}

describe("waitForRelayExtension", () => {
	let relay: RelayServer | undefined;
	let fake: Bun.Server<undefined> | undefined;
	let extension: WebSocket | undefined;
	let bindingPath = "";

	beforeAll(async () => {
		bindingPath = await writeRelayBindingFixture();
	});

	afterAll(async () => {
		await removeRelayBindingFixture(bindingPath);
	});

	afterEach(() => {
		extension?.close();
		relay?.stop();
		fake?.stop(true);
		extension = undefined;
		relay = undefined;
		fake = undefined;
	});

	it("gives up at once when nothing is listening instead of polling the dial window", async () => {
		const port = await findFreeCdpPort();
		const started = performance.now();
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toEqual({ kind: "unreachable" });
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("fails fast when this version's relay outlived the dial window without ever seeing an extension", async () => {
		const info: RelayUnavailableInfo = {
			ompRelayVersion: VERSION,
			error: "relay extension is not connected",
			extensionSeen: false,
			uptimeMs: 60_000,
			relayProtocol: RELAY_PROTOCOL_VERSION,
			profileBinding: { state: "unbound" },
		};
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json(info, { status: 503 }),
		});
		const started = performance.now();
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toEqual({
			kind: "no-extension",
			relayProtocol: RELAY_PROTOCOL_VERSION,
		});
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("identifies a legacy relay that never saw an extension as stale, without waiting for the dial window", async () => {
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json(LEGACY_UNAVAILABLE, { status: 503 }),
		});
		const started = performance.now();
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toEqual({
			kind: "outdated-relay",
			relayProtocol: 1,
		});
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("rejects an already-running relay without discarded-tab metadata", async () => {
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json({
					Browser: "Chrome/151",
					"Protocol-Version": "1.3",
					"User-Agent": "test",
					"V8-Version": "",
					"WebKit-Version": "",
					webSocketDebuggerUrl: `ws://127.0.0.1:${fake!.port}/cdp`,
					"OMP-Relay-Protocol": "2",
				}),
		});
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toEqual({
			kind: "outdated-relay",
			relayProtocol: 2,
		});
	});

	it("reports a stale relay before blaming its extension, even if the capability marker matches", async () => {
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json(
					readyVersionBody(fake!.port, { ompRelayVersion: "18.5.1", ompExtensionDiscardedTabsProtocol: "0" }),
				),
		});
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toEqual({
			kind: "outdated-relay",
			relayProtocol: 2,
		});
	});

	it("accepts a compatible relay from another OMP version", async () => {
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json(readyVersionBody(fake!.port, { ompRelayVersion: "18.5.1" })),
		});
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toEqual({
			kind: "ready",
			relayProtocol: 2,
		});
	});

	it("rejects a bound extension without discarded-tab snapshots, even when it has no tabs", async () => {
		relay = startRelayServer({ port: 0, bindingPath });
		const port = relay.port;
		extension = new WebSocket(`ws://127.0.0.1:${port}/ext`);
		extension.addEventListener("open", () => extension?.send(JSON.stringify(LEGACY_EXTENSION_HELLO)), { once: true });
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toEqual({
			kind: "outdated-extension",
			relayProtocol: 2,
		});
	});

	it("keeps polling a young relay and reports ready (protocol 2) once the bound extension handshakes", async () => {
		relay = startRelayServer({ port: 0, bindingPath });
		const port = relay.port;
		const wait = waitForRelayExtension(`http://127.0.0.1:${port}`);
		// The relay is serving 503 (young, no extension yet) before the extension dials in.
		expect((await fetch(`http://127.0.0.1:${port}/json/version`)).status).toBe(503);
		extension = new WebSocket(`ws://127.0.0.1:${port}/ext`);
		extension.addEventListener("open", () => extension?.send(JSON.stringify(EXTENSION_HELLO)), { once: true });
		expect(await wait).toEqual({ kind: "ready", relayProtocol: 2 });
	});
});
