/**
 * The configured browser identity is a decision, not a preference: when the
 * relay is the configured identity and it is disabled or unreachable, `open`
 * fails with an actionable error and never drives another cookie jar
 * (managed agent profile, throwaway profile, cdpUrl). The managed profile is
 * reachable only through the explicit per-call `app.relay: false`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { RELAY_DISABLED_MESSAGE, resolveBrowserKind } from "@oh-my-pi/pi-coding-agent/tools/browser";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

const savedEnv = process.env.PI_BROWSER_RELAY;
afterEach(() => {
	if (savedEnv === undefined) delete process.env.PI_BROWSER_RELAY;
	else process.env.PI_BROWSER_RELAY = savedEnv;
});

function session(values: Record<string, unknown>): ToolSession {
	const settings = { get: (key: string) => values[key] };
	// Only `settings.get` and `cwd` are consulted by kind resolution.
	return { settings, cwd: "/tmp" } as unknown as ToolSession;
}

describe("browser identity resolution", () => {
	it("drives the relay by default when browser.relay is pinned", () => {
		delete process.env.PI_BROWSER_RELAY;
		expect(resolveBrowserKind({ action: "open" }, session({ "browser.relay": true }))).toEqual({
			kind: "relay",
			cdpUrl: "http://127.0.0.1:9224",
		});
	});

	it("fails closed instead of using the managed profile when the pinned relay is disabled by PI_BROWSER_RELAY=0", () => {
		process.env.PI_BROWSER_RELAY = "0";
		expect(() =>
			resolveBrowserKind(
				{ action: "open" },
				session({ "browser.relay": true, "browser.cdpUrl": "http://127.0.0.1:9222" }),
			),
		).toThrow(RELAY_DISABLED_MESSAGE);
		expect(() => resolveBrowserKind({ action: "open", app: { relay: true } }, session({}))).toThrow(
			RELAY_DISABLED_MESSAGE,
		);
	});

	it("reaches the managed profile only through the explicit per-call choice", () => {
		delete process.env.PI_BROWSER_RELAY;
		// The explicit opt-out selects the managed profile exactly: a configured
		// cdpUrl or cmux endpoint (a third identity) is not consulted.
		const kind = resolveBrowserKind(
			{ action: "open", app: { relay: false } },
			session({
				"browser.relay": true,
				"browser.cdpUrl": "http://127.0.0.1:9222",
				"browser.cmux": true,
				"browser.headless": true,
			}),
		);
		expect(kind).toEqual({ kind: "headless", headless: true });
	});
});

describe("unreachable relay", () => {
	it("is an error, not a switch to a headless profile", async () => {
		const { acquireBrowser, getBrowsersMapForTest } =
			await import("@oh-my-pi/pi-coding-agent/tools/browser/registry");
		delete process.env.PI_BROWSER_RELAY;
		const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		const port = closed.port;
		closed.stop(true);
		const kind = resolveBrowserKind(
			{ action: "open" },
			session({ "browser.relay": true, "browser.relayUrl": `http://127.0.0.1:${port}` }),
		);
		expect(kind.kind).toBe("relay");
		await expect(acquireBrowser(kind, { cwd: "/tmp" })).rejects.toThrow(/relay is not reachable/);
		expect([...getBrowsersMapForTest().values()].filter(handle => handle.kind.kind === "headless")).toEqual([]);
	});
});
