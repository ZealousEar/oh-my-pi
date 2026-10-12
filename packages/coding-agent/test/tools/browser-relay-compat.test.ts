/**
 * Chrome-profile binding, observed through the real relay server: what an
 * unbound or mismatched extension install gets, what `/json/version` and
 * `/omp/binding` say about it, and what the consumer wait returns.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBaseConfigRoot, getBrowserRelayDir } from "@oh-my-pi/pi-utils";
import { readRelayBinding } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/binding";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import {
	DISCARDED_TABS_PROTOCOL_VERSION,
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

interface HelloOverrides {
	instanceId?: string;
	browserSession?: string;
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
						discardedTabsProtocol: DISCARDED_TABS_PROTOCOL_VERSION,
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

describe("relay protocol headers", () => {
	let relay: RelayServer | undefined;
	let bindingPath = "";
	let extension: FakeExtension | undefined;

	afterEach(async () => {
		extension?.close();
		extension = undefined;
		relay?.stop();
		relay = undefined;
		if (bindingPath) await removeRelayBindingFixture(bindingPath);
		bindingPath = "";
	});

	it("answers 200 with the protocol and binding headers for the bound install", async () => {
		bindingPath = await writeRelayBindingFixture(INSTALL_A);
		relay = startRelayServer({ port: 0, bindingPath });
		const port = relay.port;
		extension = new FakeExtension(port, { instanceId: INSTALL_A, browserSession: "g1" });
		await extension.opened;
		await until(async () => (await version(port)).status === 200, "ready");
		const { body } = await version(port);
		expect(body["OMP-Relay-Protocol"]).toBe("2");
		expect(body["OMP-Browser-Generation"]).toBe("g1");
		expect(body["OMP-Profile-Binding"]).toBe("bound");
		expect(body["OMP-Profile-Fingerprint"]).toBe(FP_A);
		expect(body.webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toBe("ready");
	});

	it("omits the binding headers when the binding is disabled", async () => {
		relay = startRelayServer({ port: 0, bindingPath: null });
		const port = relay.port;
		extension = new FakeExtension(port, { instanceId: INSTALL_A });
		await extension.opened;
		await until(async () => (await version(port)).status === 200, "ready");
		const { body } = await version(port);
		expect(body["OMP-Relay-Protocol"]).toBe("2");
		expect("OMP-Profile-Binding" in body).toBe(false);
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

	function dial(port: number, instanceId: string, browserSession = "g1"): FakeExtension {
		const ext = new FakeExtension(port, { instanceId, browserSession });
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
		expect(info.error).toContain(`relay extension from an unbound Chrome profile is connected (install ${FP_A})`);
		expect(relay!.bridge.ready).toBe(false);
		expect(await binding(port)).toEqual({
			state: "unbound",
			connectedInstallId: INSTALL_A,
			connectedFingerprint: FP_A,
			connectedBrowser: { browserVersion: "Chrome/151.0.0.0", userAgent: "FakeChrome/1" },
		});
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toBe("profile-unbound");
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
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toBe("ready");
	});

	it("bound: a lone foreign install is rejected and the 503 says so until the bound install returns", async () => {
		const port = await startUnbound();
		await bindRelayFixture(bindingPath, INSTALL_A);
		const intruder = dial(port, INSTALL_B);
		expect((await intruder.closed).code).toBe(RELAY_CLOSE_PROFILE_MISMATCH);
		const info = await unavailable(port);
		expect(info.reason).toBe("profile-mismatch");
		expect(info.boundSeen).toBe(false);
		expect(info.profileBinding).toEqual({
			state: "bound",
			boundFingerprint: FP_A,
			lastRejected: { fingerprint: FP_B, at: expect.any(String) },
		});
		expect(info.error).toBe(
			`relay extension install ${FP_B} was rejected: the relay is bound to Chrome profile install ${FP_A}; rebind explicitly (omp-relay-share bind) if the approved profile changed`,
		);
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toBe("profile-mismatch");

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
		const wait = waitForRelayExtension(`http://127.0.0.1:${port}`);
		// Real sockets: give the wait a couple of probe rounds (150 ms poll) to
		// prove it keeps polling rather than returning "profile-mismatch".
		await Bun.sleep(300);
		await dial(port, INSTALL_A, "g2").opened;
		expect(await wait).toBe("ready");
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
	});

	it("unbound: several installs stay connected, none is served, and binding one drops the others (4403)", async () => {
		const port = await startUnbound();
		const first = dial(port, INSTALL_A);
		const second = dial(port, INSTALL_B, "gB");
		await Promise.all([first.opened, second.opened]);
		await until(async () => Array.isArray((await binding(port)).connectedInstalls), "both installs connected");
		const installs = (await binding(port)).connectedInstalls as Array<{ installId: string }>;
		expect(installs.map(install => install.installId).sort()).toEqual([INSTALL_A, INSTALL_B].sort());
		expect((await unavailable(port)).reason).toBe("profile-unbound");
		expect(relay!.bridge.ready).toBe(false);

		await bindRelayFixture(bindingPath, INSTALL_B);
		const { status, body } = await version(port);
		expect(status).toBe(200);
		expect(body["OMP-Profile-Fingerprint"]).toBe(FP_B);
		expect(body["OMP-Browser-Generation"]).toBe("gB");
		expect(await first.closed).toEqual({ code: RELAY_CLOSE_PROFILE_MISMATCH, reason: "profile-mismatch" });
		expect(await Promise.race([second.closed.then(() => "closed"), Bun.sleep(50).then(() => "open")])).toBe("open");
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
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toBe("profile-invalid");
	});
});
