/**
 * Relay protocol identity and Chrome-profile binding, observed through the
 * real relay server: what a too-old or unbound/mismatched extension gets,
 * what `/json/version` and `/omp/binding` say about it, what the consumer
 * wait returns, and the ToolError texts the registry maps them to.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBaseConfigRoot, getBrowserRelayDir } from "@oh-my-pi/pi-utils";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { readRelayBinding } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/binding";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import {
	extensionProtocolOf,
	installFingerprint,
	RELAY_CLOSE_PROFILE_MISMATCH,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import {
	type RelayServer,
	type RelayUnavailableInfo,
	startRelayServer,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import {
	bindRelayFixture,
	removeRelayBindingFixture,
	TEST_INSTALL_ID,
	writeRelayBindingFixture,
} from "./relay-binding-fixture";

const INSTALL_A = TEST_INSTALL_ID;
const INSTALL_B = "bbbbbbbb-2222-4333-8444-bbbbbbbbbbbb";
const FP_A = installFingerprint(INSTALL_A);
const FP_B = installFingerprint(INSTALL_B);
const INSTALL_C = "cccccccc-2222-4333-8444-cccccccccccc";
const FP_C = installFingerprint(INSTALL_C);

interface HelloOverrides {
	extensionVersion?: string;
	installId?: string;
	generation?: string;
}

/** Minimal extension double: dials `/ext`, sends one hello, records how the relay closed it. */
class FakeExtension {
	readonly #ws: WebSocket;
	readonly opened: Promise<void>;
	readonly closed: Promise<{ code: number; reason: string }>;
	constructor(port: number, hello: HelloOverrides) {
		this.#ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
		const open = Promise.withResolvers<void>();
		const close = Promise.withResolvers<{ code: number; reason: string }>();
		this.opened = open.promise;
		this.closed = close.promise;
		this.#ws.addEventListener("error", () => open.reject(new Error("fake extension failed to connect")), {
			once: true,
		});
		this.#ws.addEventListener(
			"open",
			() => {
				this.#ws.send(
					JSON.stringify({
						t: "hello",
						userAgent: "FakeChrome/1",
						browserVersion: "Chrome/151.0.0.0",
						tabs: [],
						attachedTabIds: [],
						...hello,
					}),
				);
				open.resolve();
			},
			{ once: true },
		);
		this.#ws.addEventListener("close", event => close.resolve({ code: event.code, reason: event.reason }), {
			once: true,
		});
	}
	close(): void {
		this.#ws.close();
	}
}

async function version(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`http://127.0.0.1:${port}/json/version`);
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function unavailable(port: number): Promise<RelayUnavailableInfo> {
	const { status, body } = await version(port);
	expect(status).toBe(503);
	return body as unknown as RelayUnavailableInfo;
}

async function binding(port: number): Promise<Record<string, unknown>> {
	return (await (await fetch(`http://127.0.0.1:${port}/omp/binding`)).json()) as Record<string, unknown>;
}

async function until(condition: () => Promise<boolean>, what: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

describe("extensionProtocolOf", () => {
	it("maps manifest versions to relay protocols", () => {
		expect(extensionProtocolOf(undefined)).toBe(1);
		expect(extensionProtocolOf("0.1.0")).toBe(1);
		expect(extensionProtocolOf("0.1.9")).toBe(1);
		expect(extensionProtocolOf("garbage")).toBe(1);
		expect(extensionProtocolOf("0.2.0")).toBe(2);
		expect(extensionProtocolOf("0.2.1")).toBe(2);
		expect(extensionProtocolOf("0.10.0")).toBe(2);
		expect(extensionProtocolOf("1.0.0")).toBe(2);
	});
});

describe("getBrowserRelayDir", () => {
	it("is the same canonical ~/.omp/browser-relay for every channel profile", () => {
		const saved = process.env.OMP_PROFILE;
		try {
			const seen = new Set<string>();
			for (const profile of ["stock", "daily-fork", "dev-fork", undefined]) {
				if (profile === undefined) delete process.env.OMP_PROFILE;
				else process.env.OMP_PROFILE = profile;
				seen.add(getBrowserRelayDir());
			}
			expect([...seen]).toEqual([path.join(getBaseConfigRoot(), "browser-relay")]);
			expect([...seen][0]!.includes("/profiles/")).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.OMP_PROFILE;
			else process.env.OMP_PROFILE = saved;
		}
	});
});

describe("readRelayBinding", () => {
	it("distinguishes absent, malformed, and valid binding files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-binding-read-"));
		try {
			const file = path.join(dir, "binding.json");
			expect(readRelayBinding(file)).toEqual({ state: "unbound" });
			await Bun.write(file, "{not json");
			expect(readRelayBinding(file).state).toBe("invalid");
			await Bun.write(file, JSON.stringify({ boundAt: "x" }));
			expect(readRelayBinding(file).state).toBe("invalid");
			await Bun.write(file, JSON.stringify({ installId: INSTALL_A, boundAt: "2026-09-20T00:00:00Z", note: "n" }));
			expect(readRelayBinding(file)).toEqual({
				state: "bound",
				binding: { installId: INSTALL_A, boundAt: "2026-09-20T00:00:00Z", note: "n" },
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("relay protocol compatibility", () => {
	let relay: RelayServer | undefined;
	let bindingPath = "";
	const extensions: FakeExtension[] = [];

	afterEach(async () => {
		for (const ext of extensions.splice(0)) ext.close();
		relay?.stop();
		relay = undefined;
		if (bindingPath) await removeRelayBindingFixture(bindingPath);
		bindingPath = "";
	});

	async function start(): Promise<number> {
		bindingPath = await writeRelayBindingFixture(INSTALL_A);
		relay = startRelayServer({ port: 0, bindingPath });
		return relay.port;
	}

	function dial(port: number, hello: HelloOverrides): FakeExtension {
		const ext = new FakeExtension(port, hello);
		extensions.push(ext);
		return ext;
	}

	it("refuses a 0.1.0 extension: 503 names the required version, the bridge never becomes ready, the wait fails at once", async () => {
		const port = await start();
		const ext = dial(port, { extensionVersion: "0.1.0" });
		await ext.opened;
		await until(async () => (await unavailable(port)).reason === "extension-incompatible", "incompatible verdict");
		const info = await unavailable(port);
		expect(info.relayProtocol).toBe(2);
		expect(info.extensionIncompatible).toEqual({ version: "0.1.0", required: "0.2.0" });
		expect(info.error).toBe(
			"relay extension 0.1.0 is older than this relay requires (0.2.0); reinstall it (omp browser-relay install) and reload it in chrome://extensions",
		);
		expect(relay!.bridge.ready).toBe(false);
		expect(relay!.bridge.incompatibleExtension?.version).toBe("0.1.0");
		const started = performance.now();
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toEqual({
			kind: "incompatible-extension",
			version: "0.1.0",
			required: "0.2.0",
			relayProtocol: 2,
		});
		expect(performance.now() - started).toBeLessThan(1_000);
		// The socket stays open: the relay does not kick the old extension, it just never serves it.
		expect(await Promise.race([ext.closed.then(() => "closed"), Bun.sleep(150).then(() => "open")])).toBe("open");
	});

	it("treats a hello without extensionVersion as the 0.1.0 extension", async () => {
		const port = await start();
		await dial(port, { installId: INSTALL_A }).opened;
		await until(async () => (await unavailable(port)).reason === "extension-incompatible", "incompatible verdict");
		expect((await unavailable(port)).extensionIncompatible).toEqual({ version: "0.1.0", required: "0.2.0" });
	});

	it("answers 200 with the protocol and binding headers for the bound 0.2.0 extension", async () => {
		const port = await start();
		await dial(port, { extensionVersion: "0.2.0", installId: INSTALL_A, generation: "g1" }).opened;
		await until(async () => (await version(port)).status === 200, "ready");
		const { body } = await version(port);
		expect(body["OMP-Relay-Protocol"]).toBe("2");
		expect(body["OMP-Extension-Version"]).toBe("0.2.0");
		expect(body["OMP-Browser-Generation"]).toBe("g1");
		expect(body["OMP-Profile-Binding"]).toBe("bound");
		expect(body["OMP-Profile-Fingerprint"]).toBe(FP_A);
		expect(body.webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toEqual({ kind: "ready", relayProtocol: 2 });
	});
});

describe("relay protocol requirement in the registry", () => {
	const stockVersion = (req: Request) => ({
		Browser: "Chrome/151.0.0.0",
		"Protocol-Version": "1.3",
		"User-Agent": "stock",
		"V8-Version": "",
		"WebKit-Version": "",
		webSocketDebuggerUrl: `ws://${new URL(req.url).host}/cdp`,
	});

	it("refuses a ready stock/legacy relay (200 without OMP-Relay-Protocol) when the kind requires protocol 2", async () => {
		const stock = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => Response.json(stockVersion(req)) });
		try {
			const cdpUrl = `http://127.0.0.1:${stock.port}`;
			await expect(
				acquireBrowser({ kind: "relay", cdpUrl, requireProtocol: 2 }, { cwd: process.cwd() }),
			).rejects.toThrow(
				`omp browser relay at ${cdpUrl} is a legacy/stock relay (protocol 1); this omp requires protocol 2.`,
			);
		} finally {
			stock.stop(true);
		}
	});

	/**
	 * A port whose HTTP probes answer as a ready protocol-2 relay bound to A
	 * (what the registry checks before connecting) while the CDP websocket
	 * puppeteer opens is served by whatever `revision` says — the relay that
	 * took the port between preflight and connection.
	 */
	function swappedRelay(revision: string) {
		let cdpSockets = 0;
		let closedByClient = 0;
		const server = Bun.serve<undefined>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req, srv) {
				if (new URL(req.url).pathname === "/cdp") {
					cdpSockets++;
					return srv.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 });
				}
				return Response.json({
					...stockVersion(req),
					"OMP-Relay-Protocol": "2",
					"OMP-Profile-Binding": "bound",
					"OMP-Profile-Fingerprint": FP_A,
				});
			},
			websocket: {
				message(ws, raw) {
					// Enough of Chrome's browser session for puppeteer.connect to settle.
					const msg = JSON.parse(String(raw)) as { id: number; method: string };
					const results: Record<string, unknown> = {
						"Browser.getVersion": {
							protocolVersion: "1.3",
							product: "Chrome/151",
							revision,
							userAgent: "stock",
							jsVersion: "",
						},
						"Target.getBrowserContexts": { browserContextIds: [] },
						"Target.getTargets": { targetInfos: [] },
					};
					ws.send(JSON.stringify({ id: msg.id, result: results[msg.method] ?? {} }));
				},
				close() {
					closedByClient++;
				},
			},
		});
		return {
			cdpUrl: `http://127.0.0.1:${server.port}`,
			sockets: () => cdpSockets,
			closed: () => closedByClient,
			stop: () => server.stop(true),
		};
	}

	it.each([
		[
			"a stock/legacy relay (Chrome-style revision)",
			"@abc",
			"is a legacy/stock relay (protocol 1); this omp requires protocol 2.",
		],
		["a protocol-2 relay that is unbound", `omp-relay/2;binding=unbound;fp=`, "it is unbound, not bound"],
		[
			"a protocol-2 relay bound to another Chrome profile",
			`omp-relay/2;binding=bound;fp=${FP_B}`,
			`it serves Chrome profile install ${FP_B}, not ${FP_A}`,
		],
	])(
		"rejects and disconnects when puppeteer's connection lands on %s although the probes saw protocol 2 bound to A",
		async (_label, revision, message) => {
			const fake = swappedRelay(revision);
			try {
				await expect(
					acquireBrowser({ kind: "relay", cdpUrl: fake.cdpUrl, requireProtocol: 2 }, { cwd: process.cwd() }),
				).rejects.toThrow(message);
				expect(fake.sockets()).toBe(1);
				await until(async () => fake.closed() === 1, "browser disconnected");
			} finally {
				fake.stop();
			}
		},
	);

	it("accepts the connection when the revision proves protocol 2, bound, and the same fingerprint the probe reported", async () => {
		const fake = swappedRelay(`omp-relay/2;binding=bound;fp=${FP_A}`);
		try {
			const handle = await acquireBrowser(
				{ kind: "relay", cdpUrl: fake.cdpUrl, requireProtocol: 2 },
				{ cwd: process.cwd() },
			);
			try {
				expect(fake.sockets()).toBe(1);
				expect(fake.closed()).toBe(0);
			} finally {
				await releaseBrowser(handle, { kill: false });
			}
		} finally {
			fake.stop();
		}
	});
});

describe("relay profile binding", () => {
	let relay: RelayServer | undefined;
	let bindingPath = "";
	const extensions: FakeExtension[] = [];

	afterEach(async () => {
		for (const ext of extensions.splice(0)) ext.close();
		relay?.stop();
		relay = undefined;
		if (bindingPath) await removeRelayBindingFixture(bindingPath);
		bindingPath = "";
	});

	/** Relay with a binding file path that does not exist yet (unbound). */
	async function startUnbound(): Promise<number> {
		bindingPath = await writeRelayBindingFixture(INSTALL_A);
		await fs.rm(bindingPath);
		relay = startRelayServer({ port: 0, bindingPath });
		return relay.port;
	}

	function dial(port: number, installId: string, generation = "g1"): FakeExtension {
		const ext = new FakeExtension(port, { extensionVersion: "0.2.0", installId, generation });
		extensions.push(ext);
		return ext;
	}

	it("unbound: the hello is accepted but not ready; /omp/binding exposes the full install id for bind --from-connected", async () => {
		const port = await startUnbound();
		expect(await binding(port)).toEqual({ state: "unbound" });
		await dial(port, INSTALL_A).opened;
		await until(async () => (await unavailable(port)).reason === "profile-unbound", "unbound verdict");
		const info = await unavailable(port);
		expect(info.profileBinding).toEqual({ state: "unbound", connectedFingerprint: FP_A });
		expect(info.error).toBe(
			`relay extension from an unbound Chrome profile is connected (install ${FP_A}); bind it with the launcher runbook (omp-relay-share bind --from-connected) or reload the approved profile's extension`,
		);
		expect(relay!.bridge.ready).toBe(false);
		expect(await binding(port)).toEqual({
			state: "unbound",
			connectedInstallId: INSTALL_A,
			connectedFingerprint: FP_A,
			connectedBrowser: { browserVersion: "Chrome/151.0.0.0", userAgent: "FakeChrome/1" },
		});
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toEqual({
			kind: "profile-unbound",
			connectedFingerprint: FP_A,
			relayProtocol: 2,
		});
		await expect(
			acquireBrowser({ kind: "relay", cdpUrl: `http://127.0.0.1:${port}` }, { cwd: process.cwd() }),
		).rejects.toThrow(`relay extension from an unbound Chrome profile is connected (install ${FP_A}); bind it`);
	});

	it("binding while connected makes the next readiness query ready without a reconnect, and stops exposing the install id", async () => {
		const port = await startUnbound();
		await dial(port, INSTALL_A).opened;
		await until(async () => (await unavailable(port)).reason === "profile-unbound", "unbound verdict");
		await bindRelayFixture(bindingPath, INSTALL_A);
		const { status, body } = await version(port);
		expect(status).toBe(200);
		expect(body["OMP-Profile-Binding"]).toBe("bound");
		expect(body["OMP-Profile-Fingerprint"]).toBe(FP_A);
		const view = await binding(port);
		expect(view.state).toBe("bound");
		expect(view.boundFingerprint).toBe(FP_A);
		expect(view.connectedFingerprint).toBe(FP_A);
		expect("connectedInstallId" in view).toBe(false);
	});

	it("bound: the same install reconnecting with a new generation is ready again; another install is closed with 4403 and never touches the bound connection", async () => {
		const port = await startUnbound();
		await bindRelayFixture(bindingPath, INSTALL_A);
		const first = dial(port, INSTALL_A, "g1");
		await first.opened;
		await until(async () => (await version(port)).status === 200, "ready with g1");
		expect((await version(port)).body["OMP-Browser-Generation"]).toBe("g1");

		// Service-worker restart: same install, new generation, new socket.
		const second = dial(port, INSTALL_A, "g2");
		await second.opened;
		await until(async () => (await version(port)).body["OMP-Browser-Generation"] === "g2", "ready with g2");
		expect((await first.closed).code).not.toBe(RELAY_CLOSE_PROFILE_MISMATCH);

		// Another Chrome profile dials in while A is connected.
		const intruder = dial(port, INSTALL_B, "g9");
		await intruder.opened;
		expect(await intruder.closed).toEqual({ code: RELAY_CLOSE_PROFILE_MISMATCH, reason: "profile-mismatch" });
		expect(relay!.bridge.ready).toBe(true);
		const { status, body } = await version(port);
		expect(status).toBe(200);
		expect(body["OMP-Browser-Generation"]).toBe("g2");
		const view = await binding(port);
		expect(view.state).toBe("bound");
		expect(view.boundFingerprint).toBe(FP_A);
		expect(view.connectedFingerprint).toBe(FP_A);
		expect((view.lastRejected as { fingerprint: string }).fingerprint).toBe(FP_B);
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toEqual({ kind: "ready", relayProtocol: 2 });
	});

	it("bound: a lone foreign install is rejected and the 503 says so until the bound install returns", async () => {
		const port = await startUnbound();
		await bindRelayFixture(bindingPath, INSTALL_A);
		const intruder = dial(port, INSTALL_B);
		expect((await intruder.closed).code).toBe(RELAY_CLOSE_PROFILE_MISMATCH);
		const info = await unavailable(port);
		expect(info.reason).toBe("profile-mismatch");
		expect(info.boundSeen).toBe(false);
		expect(info.extensionSeen).toBe(false);
		expect(info.profileBinding).toEqual({
			state: "bound",
			boundFingerprint: FP_A,
			lastRejected: { fingerprint: FP_B, at: expect.any(String) },
		});
		expect(info.error).toBe(
			`relay extension install ${FP_B} was rejected: the relay is bound to Chrome profile install ${FP_A}; rebind explicitly (omp-relay-share bind) if the approved profile changed`,
		);
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toEqual({
			kind: "profile-mismatch",
			boundFingerprint: FP_A,
			rejectedFingerprint: FP_B,
			relayProtocol: 2,
		});
		await expect(
			acquireBrowser({ kind: "relay", cdpUrl: `http://127.0.0.1:${port}` }, { cwd: process.cwd() }),
		).rejects.toThrow(
			`relay extension install ${FP_B} was rejected: the relay is bound to Chrome profile install ${FP_A}`,
		);

		// The approved install comes back: the stale rejection no longer blocks readiness.
		await dial(port, INSTALL_A).opened;
		await until(async () => (await version(port)).status === 200, "bound install ready");
	});

	it("a rejected intruder after the bound install was connected: 503 says mismatch with boundSeen=true; the wait keeps polling and reports ready once it re-dials", async () => {
		const port = await startUnbound();
		await bindRelayFixture(bindingPath, INSTALL_A);
		const first = dial(port, INSTALL_A, "g1");
		await first.opened;
		await until(async () => (await version(port)).status === 200, "ready");
		first.close();
		await until(async () => (await version(port)).status === 503, "bound install gone");
		const intruder = dial(port, INSTALL_B);
		expect((await intruder.closed).code).toBe(RELAY_CLOSE_PROFILE_MISMATCH);
		const info = await unavailable(port);
		expect(info.reason).toBe("profile-mismatch");
		expect(info.boundSeen).toBe(true);
		expect(info.extensionSeen).toBe(true);
		expect(info.profileBinding).toMatchObject({
			state: "bound",
			boundFingerprint: FP_A,
			lastRejected: { fingerprint: FP_B, at: expect.any(String) },
		});
		const wait = waitForRelayExtension(`http://127.0.0.1:${port}`);
		// Real sockets: give the wait a couple of probe rounds (150 ms poll) to
		// prove it keeps polling rather than returning "profile-mismatch".
		await Bun.sleep(300);
		await dial(port, INSTALL_A, "g2").opened;
		expect(await wait).toEqual({ kind: "ready", relayProtocol: 2 });
	});

	it("a bound install connected at rejection time shields the 200; once it disconnects the retained rejection is reported with boundSeen=true", async () => {
		const port = await startUnbound();
		await bindRelayFixture(bindingPath, INSTALL_A);
		const first = dial(port, INSTALL_A, "g1");
		await first.opened;
		await until(async () => (await version(port)).status === 200, "ready");
		const intruder = dial(port, INSTALL_B);
		expect((await intruder.closed).code).toBe(RELAY_CLOSE_PROFILE_MISMATCH);
		expect((await version(port)).status).toBe(200);
		first.close();
		await until(async () => (await version(port)).status === 503, "bound install gone");
		const info = await unavailable(port);
		expect(info.reason).toBe("profile-mismatch");
		expect(info.boundSeen).toBe(true);
		expect(info.profileBinding).toMatchObject({
			state: "bound",
			boundFingerprint: FP_A,
			lastRejected: { fingerprint: FP_B, at: expect.any(String) },
		});
	});

	it("the wait fails with the mismatch verdict once the dial window passes without the bound install reviving", async () => {
		// A fake 503 whose uptime rule collapses the dial window at once (the
		// real 35 s window is not driven by fake timers), carrying a retained
		// rejection with boundSeen=true.
		const fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json(
					{
						error: "rejected",
						extensionSeen: false,
						uptimeMs: 60_000,
						relayProtocol: 2,
						reason: "profile-mismatch",
						boundSeen: true,
						profileBinding: {
							state: "bound",
							boundFingerprint: FP_A,
							lastRejected: { fingerprint: FP_B, at: "x" },
						},
					},
					{ status: 503 },
				),
		});
		try {
			expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toEqual({
				kind: "profile-mismatch",
				boundFingerprint: FP_A,
				rejectedFingerprint: FP_B,
				relayProtocol: 2,
			});
		} finally {
			fake.stop(true);
		}
	});

	it("unbound: a second install cannot displace the first connected one; it stays a silent candidate", async () => {
		const port = await startUnbound();
		const first = dial(port, INSTALL_A);
		await first.opened;
		await until(async () => (await binding(port)).connectedInstallId === INSTALL_A, "A connected");
		const second = dial(port, INSTALL_B);
		await second.opened;
		// Real sockets: B's hello has no observable acknowledgement; a bounded
		// wait proves neither socket was closed by it.
		const outcome = await Promise.race([
			second.closed.then(() => "second closed"),
			first.closed.then(() => "first closed"),
			Bun.sleep(200).then(() => "both open"),
		]);
		expect(outcome).toBe("both open");
		expect((await binding(port)).connectedInstallId).toBe(INSTALL_A);
		expect((await unavailable(port)).profileBinding).toEqual({ state: "unbound", connectedFingerprint: FP_A });
		// Binding A makes the relay ready for A; B remains ignored.
		await bindRelayFixture(bindingPath, INSTALL_A);
		expect((await version(port)).body["OMP-Profile-Fingerprint"]).toBe(FP_A);
	});

	it("unbound with A connected and B waiting: binding B rejects A (4403) and promotes B's cached hello without a re-dial", async () => {
		const port = await startUnbound();
		const first = dial(port, INSTALL_A);
		await first.opened;
		await until(async () => (await binding(port)).connectedInstallId === INSTALL_A, "A connected");
		const second = dial(port, INSTALL_B, "gB");
		await second.opened;
		// Real sockets: let B's hello reach the relay before binding.
		await Bun.sleep(100);
		await bindRelayFixture(bindingPath, INSTALL_B);
		const { status, body } = await version(port);
		expect(status).toBe(200);
		expect(body["OMP-Profile-Fingerprint"]).toBe(FP_B);
		expect(body["OMP-Browser-Generation"]).toBe("gB");
		expect(await first.closed).toEqual({ code: RELAY_CLOSE_PROFILE_MISMATCH, reason: "profile-mismatch" });
		expect(await Promise.race([second.closed.then(() => "closed"), Bun.sleep(50).then(() => "open")])).toBe("open");
	});

	it("unbound with A connected and B, C waiting: binding C rejects A and B (4403) and promotes C", async () => {
		const port = await startUnbound();
		const first = dial(port, INSTALL_A);
		await first.opened;
		await until(async () => (await binding(port)).connectedInstallId === INSTALL_A, "A connected");
		const third = dial(port, INSTALL_C, "gC");
		await third.opened;
		const second = dial(port, INSTALL_B, "gB");
		await second.opened;
		// Real sockets: let both waiting hellos reach the relay before binding.
		await Bun.sleep(100);
		await bindRelayFixture(bindingPath, INSTALL_C);
		const { status, body } = await version(port);
		expect(status).toBe(200);
		expect(body["OMP-Profile-Fingerprint"]).toBe(FP_C);
		expect(body["OMP-Browser-Generation"]).toBe("gC");
		expect((await first.closed).code).toBe(RELAY_CLOSE_PROFILE_MISMATCH);
		expect((await second.closed).code).toBe(RELAY_CLOSE_PROFILE_MISMATCH);
		expect(await Promise.race([third.closed.then(() => "closed"), Bun.sleep(50).then(() => "open")])).toBe("open");
	});

	it("unbound: when the connected install disconnects, a waiting second install becomes the connected one", async () => {
		const port = await startUnbound();
		const first = dial(port, INSTALL_A);
		await first.opened;
		await until(async () => (await binding(port)).connectedInstallId === INSTALL_A, "A connected");
		const second = dial(port, INSTALL_B);
		await second.opened;
		// Real sockets: let B's hello reach the relay before A leaves.
		await Bun.sleep(100);
		first.close();
		await until(async () => (await binding(port)).connectedInstallId === INSTALL_B, "B promoted");
		expect((await unavailable(port)).profileBinding).toEqual({ state: "unbound", connectedFingerprint: FP_B });
	});

	it("unbind (file removed) fails closed on the next readiness query while keeping the socket for a rebind", async () => {
		const port = await startUnbound();
		await bindRelayFixture(bindingPath, INSTALL_A);
		const ext = dial(port, INSTALL_A);
		await ext.opened;
		await until(async () => (await version(port)).status === 200, "ready");
		await fs.rm(bindingPath);
		const info = await unavailable(port);
		expect(info.reason).toBe("profile-unbound");
		expect(relay!.bridge.ready).toBe(false);
		expect((await binding(port)).connectedInstallId).toBe(INSTALL_A);
		await bindRelayFixture(bindingPath, INSTALL_A);
		expect((await version(port)).status).toBe(200);
	});

	it("rebinding to another install while one is connected drops it like a mismatched hello", async () => {
		const port = await startUnbound();
		await bindRelayFixture(bindingPath, INSTALL_A);
		const ext = dial(port, INSTALL_A);
		await ext.opened;
		await until(async () => (await version(port)).status === 200, "ready");
		await bindRelayFixture(bindingPath, INSTALL_B);
		const info = await unavailable(port);
		expect(info.reason).toBe("profile-mismatch");
		expect(await ext.closed).toEqual({ code: RELAY_CLOSE_PROFILE_MISMATCH, reason: "profile-mismatch" });
	});

	it("an invalid binding file fails closed with its parse error", async () => {
		const port = await startUnbound();
		await Bun.write(bindingPath, "{broken");
		await dial(port, INSTALL_A).opened;
		await until(async () => (await unavailable(port)).reason === "profile-invalid", "invalid verdict");
		const outcome = await waitForRelayExtension(`http://127.0.0.1:${port}`);
		expect(outcome.kind).toBe("profile-invalid");
		await expect(
			acquireBrowser({ kind: "relay", cdpUrl: `http://127.0.0.1:${port}` }, { cwd: process.cwd() }),
		).rejects.toThrow("relay binding file is invalid");
	});
});
