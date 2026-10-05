/**
 * One stable agent-browser identity: every channel/project resolves the same
 * profile directory and global broker scope, a launch on that directory keeps
 * its cookie store across browser restarts and independent registry instances,
 * and the throwaway path is only the labeled test/SDK fallback.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBaseConfigRoot } from "@oh-my-pi/pi-utils";
import { chromiumAvailable } from "../../../test/tools/chromium-probe";
import { launchHeadlessBrowser } from "./launch";
import {
	agentBrowserProfileDir,
	AGENT_BROWSER_BROKER_SCOPE,
	browserGenerationOf,
	sharedBrowserDaemonName,
} from "./shared-daemon";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

describe("agent browser identity", () => {
	it("resolves one profile directory regardless of channel profile or project", () => {
		const saved = process.env.OMP_PROFILE;
		try {
			process.env.OMP_PROFILE = "stock";
			const a = agentBrowserProfileDir();
			process.env.OMP_PROFILE = "daily-fork";
			const b = agentBrowserProfileDir();
			process.env.OMP_PROFILE = "dev-fork";
			const c = agentBrowserProfileDir();
			expect(a).toBe(b);
			expect(b).toBe(c);
			expect(a).toBe(path.join(getBaseConfigRoot(), "browser", "agent-profile"));
			expect(a.includes("/profiles/")).toBe(false);
			expect(a.includes("/agent/")).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.OMP_PROFILE;
			else process.env.OMP_PROFILE = saved;
		}
		expect(AGENT_BROWSER_BROKER_SCOPE).toBe("browser-agent");
		expect(sharedBrowserDaemonName(true)).toBe("omp.browser.headless");
	});

	it("derives the browser generation from the ws endpoint GUID", () => {
		expect(browserGenerationOf("ws://127.0.0.1:9333/devtools/browser/abc-123")).toBe("abc-123");
		expect(browserGenerationOf("ws://127.0.0.1:9224/cdp")).toBe("ws://127.0.0.1:9224/cdp");
	});
});

describe.skipIf(!CHROMIUM_AVAILABLE)("stable profile — cookie survival across launches", () => {
	let profileDir = "";
	let server: ReturnType<typeof Bun.serve> | undefined;
	let origin = "";

	beforeAll(async () => {
		profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lifecycle-profile-"));
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/set") {
					return new Response("set", {
						headers: { "Set-Cookie": "omp_login=synthetic-token; Path=/; Max-Age=86400; SameSite=Lax" },
					});
				}
				return new Response(
					`<!doctype html><title>fixture</title><p id="c">${req.headers.get("cookie") ?? ""}</p>`,
					{
						headers: { "Content-Type": "text/html" },
					},
				);
			},
		});
		origin = `http://127.0.0.1:${server.port}`;
	});

	afterAll(async () => {
		server?.stop(true);
		await fs.rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
	});

	it("keeps a cookie set in one browser instance visible to a second instance on the same profile", async () => {
		const first = await launchHeadlessBrowser({ headless: true, profileDir });
		try {
			expect(first.userDataDir).toBeUndefined(); // durable profile: nothing to delete on dispose
			const page = await first.browser.newPage();
			await page.goto(`${origin}/set`, { waitUntil: "load" });
			const cookies = await page.cookies(origin);
			expect(cookies.some(c => c.name === "omp_login")).toBe(true);
			await page.close();
		} finally {
			await first.browser.close();
		}
		const second = await launchHeadlessBrowser({ headless: true, profileDir });
		try {
			const page = await second.browser.newPage();
			await page.goto(`${origin}/`, { waitUntil: "load" });
			const text = await page.$eval("#c", el => el.textContent);
			expect(text).toContain("omp_login=synthetic-token");
			await page.close();
		} finally {
			await second.browser.close();
		}
		const mode = (await fs.stat(profileDir)).mode & 0o777;
		expect(mode & 0o077).toBe(0);
	}, 90_000);

	it("labels the no-profile path as throwaway (temp dir removed by the caller)", async () => {
		const launched = await launchHeadlessBrowser({ headless: true });
		try {
			expect(launched.userDataDir).toMatch(/omp-chrome-profile-/);
		} finally {
			await launched.browser.close();
			if (launched.userDataDir) await fs.rm(launched.userDataDir, { recursive: true, force: true });
		}
	}, 60_000);
});
