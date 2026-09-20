/**
 * Pinned relay deployment: the fork refuses to adopt a relay speaking a lower
 * protocol than required, starts the relay through its supervisor instead of
 * spawning its own build, and a supervised `serve` takes the port over from a
 * foreign relay once it exits. Every port here is ephemeral.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bindRelayPort } from "@oh-my-pi/pi-coding-agent/cli/browser-relay-cli";
import { closeDaemonClients } from "@oh-my-pi/pi-coding-agent/launch/client";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureRelayDaemon } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/daemon";
import {
	DEFAULT_RELAY_URL,
	RELAY_REQUIRE_PROTOCOL_ENV,
	RELAY_SUPERVISOR_ENV,
	resolveRelayKind,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/kind";
import type { RelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { removeRelayBindingFixture, writeRelayBindingFixture } from "./relay-binding-fixture";

/** 503 body of a stock/legacy relay (18.2.6 / 18.1.10): no protocol field at all. */
const LEGACY_UNAVAILABLE = { error: "relay extension is not connected", extensionSeen: false, uptimeMs: 1_000 };
/** 503 body of the pinned relay. */
const PINNED_UNAVAILABLE = {
	...LEGACY_UNAVAILABLE,
	relayProtocol: 2,
	profileBinding: { state: "unbound" },
};

function serveJson(body: unknown, port = 0): Bun.Server<undefined> {
	return Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json(body, { status: 503 }) });
}

/** Bound TCP port of a test server (Bun types it optional). */
function portOf(server: Bun.Server<undefined>): number {
	if (server.port === undefined) throw new Error("test server has no port");
	return server.port;
}

describe("resolveRelayKind pinning env", () => {
	it("populates requireProtocol and the launchd supervisor from valid values", () => {
		expect(
			resolveRelayKind(
				{ settingEnabled: true },
				{ [RELAY_REQUIRE_PROTOCOL_ENV]: "2", [RELAY_SUPERVISOR_ENV]: "launchd:ai.omp.browser-relay" },
			),
		).toEqual({
			kind: "relay",
			cdpUrl: DEFAULT_RELAY_URL,
			requireProtocol: 2,
			supervisor: { kind: "launchd", label: "ai.omp.browser-relay" },
		});
	});

	it("accepts `none` as the adopt-only supervisor", () => {
		expect(resolveRelayKind({ settingEnabled: true }, { [RELAY_SUPERVISOR_ENV]: "none" })).toEqual({
			kind: "relay",
			cdpUrl: DEFAULT_RELAY_URL,
			supervisor: { kind: "none" },
		});
	});

	it("leaves the kind unpinned only when the variables are absent; present-but-empty fails closed", () => {
		expect(resolveRelayKind({ settingEnabled: true }, {})).toEqual({ kind: "relay", cdpUrl: DEFAULT_RELAY_URL });
		expect(() => resolveRelayKind({ settingEnabled: true }, { [RELAY_REQUIRE_PROTOCOL_ENV]: "" })).toThrow(
			RELAY_REQUIRE_PROTOCOL_ENV,
		);
		expect(() => resolveRelayKind({ settingEnabled: true }, { [RELAY_SUPERVISOR_ENV]: " " })).toThrow(
			RELAY_SUPERVISOR_ENV,
		);
	});

	it("fails closed on malformed values", () => {
		expect(() => resolveRelayKind({ settingEnabled: true }, { [RELAY_REQUIRE_PROTOCOL_ENV]: "abc" })).toThrow(
			RELAY_REQUIRE_PROTOCOL_ENV,
		);
		expect(() => resolveRelayKind({ settingEnabled: true }, { [RELAY_REQUIRE_PROTOCOL_ENV]: "0" })).toThrow(
			RELAY_REQUIRE_PROTOCOL_ENV,
		);
		expect(() => resolveRelayKind({ settingEnabled: true }, { [RELAY_SUPERVISOR_ENV]: "systemd:x" })).toThrow(
			RELAY_SUPERVISOR_ENV,
		);
		expect(() => resolveRelayKind({ settingEnabled: true }, { [RELAY_SUPERVISOR_ENV]: "launchd:bad label" })).toThrow(
			RELAY_SUPERVISOR_ENV,
		);
		// Disabled relay mode never inspects the pinning variables.
		expect(resolveRelayKind({ settingEnabled: false }, { [RELAY_SUPERVISOR_ENV]: "systemd:x" })).toBeNull();
	});
});

describe("ensureRelayDaemon", () => {
	let tempHome = "";
	const savedEnv: Record<string, string | undefined> = {};
	const servers: Bun.Server<undefined>[] = [];

	// Every test gets its own HOME so "no broker dir" assertions never depend on order.
	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-pinning-home-"));
		for (const key of ["HOME", "USERPROFILE", "PI_CONFIG_DIR", "OMP_DAEMON_IDLE_GRACE_MS"]) {
			savedEnv[key] = process.env[key];
		}
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		process.env.PI_CONFIG_DIR = ".omp";
		process.env.OMP_DAEMON_IDLE_GRACE_MS = "200";
		spyOn(os, "homedir").mockReturnValue(tempHome);
	});

	afterEach(async () => {
		for (const server of servers.splice(0)) server.stop(true);
		await closeDaemonClients();
		spyOn(os, "homedir").mockRestore();
		for (const key in savedEnv) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		// Real broker process: its idle grace (200 ms) must elapse before its runtime dir disappears.
		await Bun.sleep(400);
		await fs.rm(tempHome, { recursive: true, force: true });
	});

	const globalBrokerDir = () => path.join(tempHome, ".omp", "run", "daemons", "global", "browser-relay");

	it("refuses a legacy/stock relay when a protocol is required, before touching any broker", async () => {
		const legacy = serveJson(LEGACY_UNAVAILABLE);
		servers.push(legacy);
		const cdpUrl = `http://127.0.0.1:${legacy.port}`;
		await expect(ensureRelayDaemon({ cdpUrl, requireProtocol: 2 })).rejects.toThrow(
			`omp browser relay at ${cdpUrl} is a legacy/stock relay (protocol 1); this omp requires protocol 2. Stop it with \`omp ps --global browser-relay stop omp.browser.relay\``,
		);
		await expect(
			ensureRelayDaemon({
				cdpUrl,
				requireProtocol: 2,
				supervisor: { kind: "launchd", label: "ai.omp.browser-relay" },
			}),
		).rejects.toThrow("launchctl kickstart -k gui/");
		expect(await fs.exists(globalBrokerDir())).toBe(false);
	});

	it("supervised: nothing serving and the supervisor cannot be kicked → fails closed without spawning a broker", async () => {
		const port = await findFreeCdpPort();
		const kicked: string[] = [];
		await expect(
			ensureRelayDaemon({
				cdpUrl: `http://127.0.0.1:${port}`,
				supervisor: { kind: "launchd", label: "ai.omp.browser-relay" },
				kickstart: async label => {
					kicked.push(label);
					return false;
				},
			}),
		).rejects.toThrow("pinned browser relay service ai.omp.browser-relay is not loaded or did not start");
		expect(kicked).toEqual(["ai.omp.browser-relay"]);
		expect(await fs.exists(globalBrokerDir())).toBe(false);
	});

	it("supervised: a kickstart that brings up the pinned relay is adopted", async () => {
		const port = await findFreeCdpPort();
		const result = await ensureRelayDaemon({
			cdpUrl: `http://127.0.0.1:${port}`,
			requireProtocol: 2,
			supervisor: { kind: "launchd", label: "ai.omp.browser-relay" },
			kickstart: async () => {
				// The job starts asynchronously, like launchd.
				setTimeout(() => servers.push(serveJson(PINNED_UNAVAILABLE, port)), 300);
				return true;
			},
		});
		expect(result).toBe(true);
		expect(await fs.exists(globalBrokerDir())).toBe(false);
	});

	it("adopt-only (supervisor none): nothing serving → exact error, no kickstart, no broker", async () => {
		const port = await findFreeCdpPort();
		const cdpUrl = `http://127.0.0.1:${port}`;
		let kicks = 0;
		await expect(
			ensureRelayDaemon({
				cdpUrl,
				supervisor: { kind: "none" },
				kickstart: async () => {
					kicks++;
					return true;
				},
			}),
		).rejects.toThrow(
			`no omp browser relay is serving ${cdpUrl} and this channel is adopt-only (${RELAY_SUPERVISOR_ENV}=none); start the legacy relay or run the launcher cutover.`,
		);
		expect(kicks).toBe(0);
		expect(await fs.exists(globalBrokerDir())).toBe(false);
	});

	it("adopt-only (supervisor none): an already-serving legacy relay is adopted without a broker lease", async () => {
		const legacy = serveJson(LEGACY_UNAVAILABLE);
		servers.push(legacy);
		expect(await ensureRelayDaemon({ cdpUrl: `http://127.0.0.1:${legacy.port}`, supervisor: { kind: "none" } })).toBe(
			true,
		);
		expect(await fs.exists(globalBrokerDir())).toBe(false);
		// A downgrade is still refused under the requirement, without a launchctl hint.
		await expect(
			ensureRelayDaemon({
				cdpUrl: `http://127.0.0.1:${legacy.port}`,
				supervisor: { kind: "none" },
				requireProtocol: 2,
			}),
		).rejects.toThrow(
			/protocol 1\); this omp requires protocol 2\. Stop it with `omp ps --global browser-relay stop omp\.browser\.relay`, then retry\.$/,
		);
	});

	it("supervised: an already-serving pinned relay is adopted without any kickstart", async () => {
		const pinned = serveJson(PINNED_UNAVAILABLE);
		servers.push(pinned);
		let kicks = 0;
		expect(
			await ensureRelayDaemon({
				cdpUrl: `http://127.0.0.1:${pinned.port}`,
				requireProtocol: 2,
				supervisor: { kind: "launchd", label: "ai.omp.browser-relay" },
				kickstart: async () => {
					kicks++;
					return true;
				},
			}),
		).toBe(true);
		expect(kicks).toBe(0);
	});

	it("adopts a legacy relay when nothing is required, and a pinned-shaped relay under the requirement (broker lease held)", async () => {
		const legacy = serveJson(LEGACY_UNAVAILABLE);
		const pinned = serveJson(PINNED_UNAVAILABLE);
		servers.push(legacy, pinned);
		expect(await ensureRelayDaemon({ cdpUrl: `http://127.0.0.1:${legacy.port}` })).toBe(true);
		expect(await ensureRelayDaemon({ cdpUrl: `http://127.0.0.1:${pinned.port}`, requireProtocol: 2 })).toBe(true);
		// Upstream semantics: adoption goes through the machine-global broker lease.
		expect(await fs.exists(globalBrokerDir())).toBe(true);
	}, 30_000);
});

describe("bindRelayPort", () => {
	let bindingPath = "";
	let relay: RelayServer | undefined;
	const servers: Bun.Server<undefined>[] = [];

	beforeAll(async () => {
		bindingPath = await writeRelayBindingFixture();
	});

	afterAll(async () => {
		await removeRelayBindingFixture(bindingPath);
	});

	afterEach(() => {
		relay?.stop();
		relay = undefined;
		for (const server of servers.splice(0)) server.stop(true);
	});

	it("binds a free port", async () => {
		const outcome = await bindRelayPort(0, { bindingPath });
		expect(outcome.kind).toBe("bound");
		if (outcome.kind !== "bound") return;
		relay = outcome.relay;
		expect((await fetch(`http://127.0.0.1:${relay.port}/json/version`)).status).toBe(503);
	});

	it("reports a same-protocol relay as already running", async () => {
		const pinned = serveJson(PINNED_UNAVAILABLE);
		servers.push(pinned);
		expect(await bindRelayPort(portOf(pinned), { bindingPath })).toEqual({ kind: "already-running", protocol: 2 });
	});

	it("reports an older relay (protocol 1) and a non-relay owner as foreign when not supervised", async () => {
		const legacy = serveJson(LEGACY_UNAVAILABLE);
		const stranger = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hi") });
		servers.push(legacy, stranger);
		expect(await bindRelayPort(portOf(legacy), { bindingPath })).toEqual({ kind: "foreign", protocol: 1 });
		expect(await bindRelayPort(portOf(stranger), { bindingPath })).toEqual({ kind: "foreign", protocol: null });
	});

	it("supervised: waits for the foreign relay to exit and then takes the port over", async () => {
		const legacy = serveJson(LEGACY_UNAVAILABLE);
		servers.push(legacy);
		const port = portOf(legacy);
		const foreign: Array<number | null> = [];
		const started = performance.now();
		const pending = bindRelayPort(port, {
			bindingPath,
			supervised: true,
			retryMs: 200,
			onOccupied: protocol => foreign.push(protocol),
		});
		// Real port hand-over: the foreign server must hold the port across a few retries.
		await Bun.sleep(700);
		legacy.stop(true);
		const outcome = await pending;
		expect(outcome.kind).toBe("bound");
		if (outcome.kind !== "bound") return;
		relay = outcome.relay;
		expect(relay.port).toBe(port);
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(foreign).toEqual([1]);
	});

	it("supervised: a same-protocol owner is also waited out (exit 0 would just make launchd respawn the job)", async () => {
		const pinned = serveJson(PINNED_UNAVAILABLE);
		servers.push(pinned);
		const port = portOf(pinned);
		const occupied: Array<number | null> = [];
		const pending = bindRelayPort(port, {
			bindingPath,
			supervised: true,
			retryMs: 100,
			onOccupied: protocol => occupied.push(protocol),
		});
		// Real port hand-over: the other relay must hold the port across a retry.
		await Bun.sleep(250);
		pinned.stop(true);
		const outcome = await pending;
		expect(outcome.kind).toBe("bound");
		if (outcome.kind !== "bound") return;
		relay = outcome.relay;
		expect(relay.port).toBe(port);
		expect(occupied).toEqual([2]);
	});

	it("supervised: an abort while waiting gives up reporting the current owner instead of spinning", async () => {
		const legacy = serveJson(LEGACY_UNAVAILABLE);
		servers.push(legacy);
		const controller = new AbortController();
		const pending = bindRelayPort(portOf(legacy), {
			bindingPath,
			supervised: true,
			retryMs: 100,
			signal: controller.signal,
		});
		controller.abort();
		expect(await pending).toEqual({ kind: "foreign", protocol: 1 });
	});
});
