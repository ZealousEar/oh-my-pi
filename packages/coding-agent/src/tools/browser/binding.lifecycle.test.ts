/**
 * Live-document binding and adopted-tab steering on a real Chromium with local
 * `Bun.serve` fixtures (reviews Sol #2 / Fable F2 and Sol #1):
 *  - an origin-scoped click grant does not follow the tab to another origin
 *    when the page navigates by itself between runs — the worker re-proves the
 *    origin immediately before dispatch and nothing reaches the new page;
 *  - a bare adoption of the user's tab (no `new_tab`) cannot be steered:
 *    goto/scroll/scrollIntoView/focus/hover are denied with no grant and the
 *    page stays where the user left it, while an OMP-created tab navigates.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromiumAvailable } from "../../../test/tools/chromium-probe";
import { Settings } from "../../config/settings";
import { grantAutomationScope } from "../automation-policy";
import { classifyBrowserDispatch, createBrowserPrelude } from "../browser";
import type { ToolSession } from "../index";
import { findFreeCdpPort, waitForCdp } from "./attach";
import { ensureChromiumExecutable } from "./launch";
import { acquireBrowser } from "./registry";
import { acquireTab, getTabsMapForTest, releaseAllTabs, releaseTab, runInTab } from "./tab-supervisor";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const OWNER = `lifecycle-bind-${process.pid}`;

function session(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.relay": false,
			"browser.cmux": false,
		}),
	};
}

describe.skipIf(!CHROMIUM_AVAILABLE)("live-document binding — real Chromium + two loopback origins", () => {
	let server: ReturnType<typeof Bun.serve> | undefined;
	let originA = "";
	let originB = "";
	let servedB = 0;
	let hitsB = 0;

	beforeAll(() => {
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/hit") {
					hitsB++;
					return new Response("ok");
				}
				if (url.pathname === "/b") {
					servedB++;
					return new Response(
						`<!doctype html><title>B</title><button id="b" onclick="fetch('/hit')">pay</button>`,
						{ headers: { "Content-Type": "text/html" } },
					);
				}
				// Page A schedules its own navigation to the OTHER origin (same server, different host).
				return new Response(
					`<!doctype html><title>A</title><button id="a">a</button><script>setTimeout(() => { location.href = ${JSON.stringify(`${originB}/b`)}; }, 250);</script>`,
					{ headers: { "Content-Type": "text/html" } },
				);
			},
		});
		originA = `http://127.0.0.1:${server.port}`;
		originB = `http://localhost:${server.port}`;
	});

	afterEach(async () => {
		for (const name of getTabsMapForTest().keys()) await releaseTab(name, { kill: false }).catch(() => undefined);
	});

	afterAll(async () => {
		await releaseAllTabs({ kill: true });
		server?.stop(true);
	});

	it("an A-scoped click never reaches B after the page moved by itself; B needs its own grant; goto is not bound", async () => {
		const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		const s = session();
		grantAutomationScope(s, {
			surface: "browser",
			targets: [originA],
			actions: ["browser.tab.click"],
			consequential: false,
		});
		const { tab } = await acquireTab(`${OWNER}-a`, browser, {
			url: `${originA}/a`,
			timeoutMs: 30_000,
			ownerSessionId: OWNER,
			session: s,
		});
		expect(tab.info.url).toBe(`${originA}/a`);
		// Wait for the page's OWN navigation to B — no worker run involved.
		const deadline = Date.now() + 10_000;
		while (servedB === 0) {
			if (Date.now() > deadline) throw new Error("fixture page never navigated to B");
			await Bun.sleep(25);
		}
		await Bun.sleep(200);

		// The reviewer's repro: a descriptor classified against the STALE url A.
		const stale = classifyBrowserDispatch(
			{ action: "call", name: tab.name, chain: [{ method: "click", args: ["#b"] }] },
			`${originA}/a`,
			"await tab.click('#b')",
			{ ownsTarget: true },
		);
		expect(stale.target).toBe(originA);
		await expect(
			runInTab(tab.name, { code: "await tab.click('#b')", timeoutMs: 10_000, session: s, automation: stale }),
		).rejects.toThrow(
			new RegExp(
				`^AUTOMATION_DENIED: browser\\.tab\\.click was authorized for ${originA} but the tab now shows ${originB}`,
			),
		);
		expect(hitsB).toBe(0);
		// The refusal also refreshed the cached URL, so the ordinary path classifies against B and is denied by policy.
		expect(tab.info.url).toBe(`${originB}/b`);
		const fresh = classifyBrowserDispatch(
			{ action: "call", name: tab.name, chain: [{ method: "click", args: ["#b"] }] },
			tab.info.url,
			"await tab.click('#b')",
			{ ownsTarget: true },
		);
		await expect(
			runInTab(tab.name, { code: "await tab.click('#b')", timeoutMs: 10_000, session: s, automation: fresh }),
		).rejects.toThrow(/^AUTOMATION_DENIED: /);
		expect(hitsB).toBe(0);

		// Positive control: a grant for B admits the click and it lands.
		grantAutomationScope(s, {
			surface: "browser",
			targets: [originB],
			actions: ["browser.tab.click"],
			consequential: false,
		});
		await runInTab(tab.name, {
			code: "await tab.click('#b'); await wait(300);",
			timeoutMs: 10_000,
			session: s,
			automation: fresh,
		});
		expect(hitsB).toBe(1);

		// `goto` is decided for its destination and never bound to the page it leaves:
		// an owned tab may navigate away even when classified against a stale URL.
		const away = classifyBrowserDispatch(
			{ action: "call", name: tab.name, chain: [{ method: "goto", args: [`${originA}/a`] }] },
			`${originA}/never-there`,
			"await tab.goto(...)",
			{ ownsTarget: true },
		);
		await runInTab(tab.name, {
			code: `await tab.goto(${JSON.stringify(`${originA}/a?stay`)});`,
			timeoutMs: 10_000,
			session: s,
			automation: away,
		});
		expect(tab.info.url).toBe(`${originA}/a?stay`);
	}, 120_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("adopted user tab — steering denied without a grant (review #1)", () => {
	it("goto/scroll/scrollIntoView/focus/hover on a bare adoption are denied and the page stays; an owned new_tab navigates", async () => {
		const exe = await ensureChromiumExecutable();
		if (!exe) throw new Error("Expected a Chromium executable");
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-adopted-"));
		const port = await findFreeCdpPort();
		const cdpUrl = `http://127.0.0.1:${port}`;
		const child = Bun.spawn(
			[
				exe,
				"--headless=new",
				"--no-sandbox",
				"--no-first-run",
				"--no-default-browser-check",
				"--use-mock-keychain",
				"--password-store=basic",
				`--user-data-dir=${path.join(root, "profile")}`,
				`--remote-debugging-port=${port}`,
			],
			{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
		);
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response("<!doctype html><title>local B</title><p id=b>b</p>", {
					headers: { "Content-Type": "text/html" },
				}),
		});
		const localB = `http://127.0.0.1:${server.port}/b`;
		const s = session();
		const prelude = createBrowserPrelude(s);
		const invoke = (parameters: unknown) => prelude.invoke(parameters, { session: s, toolCallId: "adopted-fixture" });
		const pages = async () =>
			(
				(await (await fetch(cdpUrl + "/json/list")).json()) as Array<{ id: string; type: string; url: string }>
			).filter(p => p.type === "page");
		const adopted = `adopted-${crypto.randomUUID()}`;
		const owned = `owned-${crypto.randomUUID()}`;
		try {
			await waitForCdp(cdpUrl, 15_000);
			const [userPage] = await pages();
			if (!userPage) throw new Error("Expected the launched browser to expose its startup page");

			// Bare adoption reads only: allowed with no grant.
			const open = await invoke({ action: "open", name: adopted, app: { cdp_url: cdpUrl } });
			expect(open.details).toMatchObject({ owned: false });

			// focus/hover live on element handles (`tab.ref(id).focus()`); the gate
			// decides before any ref is resolved, so the ref need not exist.
			for (const chain of [
				[{ method: "goto", args: [localB] }],
				[{ method: "scroll", args: [0, 100] }],
				[{ method: "scrollIntoView", args: ["body"] }],
				[
					{ method: "ref", args: ["e1"] },
					{ method: "focus", args: [] },
				],
				[
					{ method: "ref", args: ["e1"] },
					{ method: "hover", args: [] },
				],
			]) {
				const verb = chain[chain.length - 1]?.method;
				await expect(invoke({ action: "call", name: adopted, chain })).rejects.toThrow(
					new RegExp(`^AUTOMATION_DENIED: .*browser\\.tab\\.${verb}`),
				);
			}
			expect((await pages()).find(p => p.id === userPage.id)?.url).toBe(userPage.url);

			// An OMP-created tab beside it navigates freely (navigate tier, authoritative ownership).
			await invoke({ action: "open", name: owned, app: { cdp_url: cdpUrl, new_tab: true } });
			await invoke({ action: "call", name: owned, chain: [{ method: "goto", args: [localB] }] });
			const after = await pages();
			expect(after.find(p => p.id === userPage.id)?.url).toBe(userPage.url);
			expect(after.some(p => p.url === localB)).toBe(true);
		} finally {
			await invoke({ action: "close", name: owned }).catch(() => undefined);
			await invoke({ action: "close", name: adopted }).catch(() => undefined);
			await releaseAllTabs({ kill: true }).catch(() => undefined);
			server.stop(true);
			child.kill();
			await child.exited;
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 90_000);
});
