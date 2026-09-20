import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { removeRelayBindingFixture, TEST_HELLO_IDENTITY, writeRelayBindingFixture } from "./relay-binding-fixture";

const EXTENSION_HELLO = {
	t: "hello",
	userAgent: "test",
	browserVersion: "Chrome/151.0.0.0",
	tabs: [],
	attachedTabIds: [],
	...TEST_HELLO_IDENTITY,
} as const;

/** 503 body of a legacy (protocol-1) relay: no `relayProtocol`, no binding. */
const LEGACY_UNAVAILABLE = {
	error: "relay extension is not connected",
	extensionSeen: false,
	uptimeMs: 60_000,
};

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

	it("fails fast when a legacy relay outlived the dial window without ever seeing an extension", async () => {
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json(LEGACY_UNAVAILABLE, { status: 503 }),
		});
		const started = performance.now();
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toEqual({
			kind: "no-extension",
			relayProtocol: 1,
		});
		expect(performance.now() - started).toBeLessThan(2_000);
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
