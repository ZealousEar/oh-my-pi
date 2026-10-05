/**
 * Runtime proof for the abandoned reaper on a real headless Chromium and a
 * local `Bun.serve` fixture: the page probe recognises a login page (password
 * field) and unsaved input and retains those tabs; a plain page is closed once
 * the injected clock passes six hours; a run refreshes the meaningful clock;
 * the relay-style pre-input resume issues lifecycle/focus CDP calls.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { chromiumAvailable } from "../../../test/tools/chromium-probe";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../index";
import { acquireBrowser } from "./registry";
import {
	acquireTab,
	getTabsMapForTest,
	probeTargetProtection,
	reapAbandonedTabs,
	releaseAllTabs,
	releaseTab,
	resumeOwnedUserDrivenTabForTest,
	runInTab,
	setTabClockForTest,
	type WorkerTabSession,
} from "./tab-supervisor";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const SIX_HOURS = 6 * 3_600_000;
const OWNER = `lifecycle-rt-${process.pid}`;
const READ = {
	surface: "browser" as const,
	tier: "read" as const,
	action: "browser.tab.observe",
	consequential: false,
	raw: false,
	summary: "observe",
};

function session(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

describe.skipIf(!CHROMIUM_AVAILABLE)("abandoned reaper — real Chromium + local fixture", () => {
	let server: ReturnType<typeof Bun.serve> | undefined;
	let origin = "";
	let clockNow = Date.now();
	let restore: (() => void) | undefined;

	beforeAll(() => {
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				const body =
					url.pathname === "/login"
						? `<form><input name="user"><input type="password" name="pw"></form>`
						: url.pathname === "/draft"
							? `<textarea id="t"></textarea>`
							: `<p>plain</p>`;
				return new Response(`<!doctype html><title>${url.pathname}</title>${body}`, {
					headers: { "Content-Type": "text/html" },
				});
			},
		});
		origin = `http://127.0.0.1:${server.port}`;
		restore = setTabClockForTest(() => clockNow);
	});

	afterEach(async () => {
		for (const name of getTabsMapForTest().keys()) await releaseTab(name, { kill: false }).catch(() => undefined);
	});

	afterAll(async () => {
		// Close the test browser here rather than relying on puppeteer's
		// process-exit hook (which a killed runner never reaches).
		await releaseAllTabs({ kill: true });
		restore?.();
		server?.stop(true);
	});

	it("retains login and dirty pages, closes the plain page after six idle hours, and a run refreshes the clock", async () => {
		const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		const s = session();
		const open = (name: string, path: string) =>
			acquireTab(`${OWNER}-${name}`, browser, {
				url: `${origin}${path}`,
				timeoutMs: 30_000,
				ownerSessionId: OWNER,
				session: s,
			});
		const login = await open("login", "/login");
		const draft = await open("draft", "/draft");
		const plain = await open("plain", "/plain");
		const touched = await open("touched", "/plain");
		await runInTab(draft.tab.name, {
			code: "await page.evaluate(() => { document.querySelector('#t').value = 'unsent reply'; });",
			timeoutMs: 30_000,
			session: s,
			automation: { ...READ, target: origin, summary: "fixture setup (read tier for the test harness only)" },
		});

		const loginProbe = await probeTargetProtection(
			(login.tab as WorkerTabSession).browser.browser,
			login.tab.targetId,
		);
		expect(loginProbe.loginPath).toBe(true);
		expect(loginProbe.credentialField).toBe(true);
		const draftProbe = await probeTargetProtection(
			(draft.tab as WorkerTabSession).browser.browser,
			draft.tab.targetId,
		);
		expect(draftProbe.unsavedInput).toBe(true);
		expect(draftProbe.loginPath).toBe(false);

		clockNow += SIX_HOURS - 1_000;
		await runInTab(touched.tab.name, {
			code: "return 1;",
			timeoutMs: 30_000,
			session: s,
			automation: { ...READ, target: origin },
		});
		clockNow += 2_000;
		const result = await reapAbandonedTabs({ idleMs: SIX_HOURS, ownerId: OWNER, downloads: () => false });
		expect(result.closed).toEqual([plain.tab.name]);
		expect(result.retained).toEqual({
			[login.tab.name]: "login",
			[draft.tab.name]: "unsaved-input",
			[touched.tab.name]: "fresh",
		});
		expect(getTabsMapForTest().has(plain.tab.name)).toBe(false);
		expect(getTabsMapForTest().has(login.tab.name)).toBe(true);
		expect(getTabsMapForTest().has(draft.tab.name)).toBe(true);
		// The page behind the closed tab is gone; the others still answer.
		const liveUrls =
			browser.kind.kind === "headless" && "browser" in browser ? browser.browser.targets().map(t => t.url()) : [];
		expect(liveUrls.filter(u => u.endsWith("/plain"))).toHaveLength(1); // only `touched`
		expect(liveUrls.filter(u => u.endsWith("/login"))).toHaveLength(1);
	}, 180_000);

	it("pre-input resume sends lifecycle active + focus emulation to the owned tab", async () => {
		const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		const { tab } = await acquireTab(`${OWNER}-resume`, browser, {
			url: `${origin}/plain`,
			timeoutMs: 30_000,
			ownerSessionId: OWNER,
		});
		// Real CDP roundtrip; a failure would reject and the run path would proceed regardless.
		await resumeOwnedUserDrivenTabForTest(tab as WorkerTabSession);
		const s = session();
		const result = await runInTab(tab.name, {
			code: "return await page.evaluate(() => document.hasFocus());",
			timeoutMs: 30_000,
			session: s,
			automation: { ...READ, target: origin },
		});
		expect(result.returnValue).toBe(true);
	}, 120_000);
});
