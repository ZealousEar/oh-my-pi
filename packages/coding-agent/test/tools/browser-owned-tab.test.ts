import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Answer, ChoiceAnswer, ChoiceQuestion, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ResolvedJudge } from "@oh-my-pi/pi-coding-agent/judgment/index";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort, waitForCdp } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { acquireBrowser, type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { RelayRpcRequest, TabSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { createOwnedTargetForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { createTabDriver } from "@oh-my-pi/pi-coding-agent/tools/browser/task/driver";
import { runBrowserTask } from "@oh-my-pi/pi-coding-agent/tools/browser/task/loop";
import { executeBrowserTask } from "@oh-my-pi/pi-coding-agent/tools/browser/task/run";
import { grantBrowserFixtureScope, loopbackOrigins } from "./browser-scope";
import { chromiumAvailable } from "./chromium-probe";
import { removeRelayBindingFixture, TEST_HELLO_IDENTITY, writeRelayBindingFixture } from "./relay-binding-fixture";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const FIXTURE_DIR = import.meta.dir + "/../fixtures/browser-task";

function makeSession(): ToolSession {
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

interface CdpPage {
	id: string;
	type: string;
	url: string;
}

/** Page targets as the browser itself reports them — independent of any Puppeteer connection. */
async function listPages(cdpUrl: string): Promise<CdpPage[]> {
	const targets = (await (await fetch(cdpUrl + "/json/list")).json()) as CdpPage[];
	return targets.filter(target => target.type === "page");
}

/** Judge that always picks the scripted operation, resolving its target by rubric label. */
class ScriptedJudge implements ResolvedJudge {
	readonly kind = "online" as const;
	readonly label = "scripted";
	#calls = 0;

	constructor(private readonly plans: ReadonlyArray<{ operation: string; label?: string }>) {}

	judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		const plan = this.plans[Math.min(this.#calls++, this.plans.length - 1)];
		if (!plan) throw new Error("scripted judge ran out of plans");
		const answers: Record<string, Answer> = {};
		for (const id in request.questions) {
			const question = request.questions[id];
			if (question?.type === "noul") {
				answers[id] = { type: "noul", noul: 0.95 };
				continue;
			}
			if (question?.type !== "choice") throw new Error("unexpected question type");
			let choice = Object.keys(question.criteria)[0] ?? "";
			if (id === "operation") choice = plan.operation;
			else if (id === plan.operation.toLowerCase() + "_target" && plan.label) choice = byLabel(question, plan.label);
			answers[id] = oneHot(question, choice);
		}
		const result = { api: "scripted", provider: "fake", model: "scripted", answers, usage: tokenUsage(9, 2) };
		return Promise.resolve(result as unknown as JudgmentResult<Q>);
	}
}

function byLabel(question: ChoiceQuestion, label: string): string {
	for (const [key, rubric] of Object.entries(question.criteria)) {
		if (typeof rubric === "string" && rubric.includes(label)) return key;
	}
	throw new Error("no candidate labelled " + JSON.stringify(label) + " in " + JSON.stringify(question.criteria));
}

function oneHot(question: ChoiceQuestion, choice: string): ChoiceAnswer {
	const probabilities: Record<string, number> = {};
	for (const key in question.criteria) probabilities[key] = key === choice ? 1 : 0;
	return { type: "choice", choice, probabilities, confidence: 1 };
}

describe.skipIf(!CHROMIUM_AVAILABLE)("browser open app.new_tab on a connected browser", () => {
	it("creates an omp-owned tab beside the user's, runs a task on it, and closes only that tab", async () => {
		const exe = await ensureChromiumExecutable();
		if (!exe) throw new Error("Expected a Chromium executable");
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-owned-tab-"));
		const port = await findFreeCdpPort();
		const cdpUrl = `http://127.0.0.1:${port}`;
		// Explicit profiles keep the real OS keystore, so bypass it here or macOS
		// blocks the spawn on a keychain-access dialog.
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
			port: 0,
			fetch(request) {
				const file = new URL(request.url).pathname === "/app.js" ? "/app.js" : "/fixture.html";
				const type = file === "/app.js" ? "text/javascript" : "text/html";
				return new Response(Bun.file(FIXTURE_DIR + file), { headers: { "content-type": type } });
			},
		});
		// The task clicks on the fixture origin: grant exactly that origin (both loopback spellings).
		const session = grantBrowserFixtureScope(makeSession(), loopbackOrigins(Number(server.url.port)));
		const prelude = createBrowserPrelude(session);
		const invoke = (parameters: unknown) => prelude.invoke(parameters, { session, toolCallId: "owned-tab" });
		const name = `owned-${crypto.randomUUID()}`;
		let opened = false;
		try {
			await waitForCdp(cdpUrl, 15_000);
			const before = await listPages(cdpUrl);
			const userPage = before[0];
			if (!userPage) throw new Error("Expected the launched browser to expose its startup page");

			const openResult = await invoke({
				action: "open",
				name,
				url: server.url.href,
				app: { cdp_url: cdpUrl, new_tab: true },
			});
			opened = true;
			expect(openResult.content).toEqual([
				{ type: "text", text: expect.stringContaining(`Opened tab "${name}" on connected`) },
			]);
			expect(openResult.content[0]).toMatchObject({ text: expect.stringContaining("(owned tab)") });
			expect(openResult.details).toMatchObject({ owned: true, url: server.url.href });

			// A new target appeared; the user's page is still there, unnavigated.
			const during = await listPages(cdpUrl);
			expect(during).toHaveLength(before.length + 1);
			expect(during.find(page => page.id === userPage.id)?.url).toBe(userPage.url);
			const ownedPage = during.find(page => page.id !== userPage.id);
			expect(ownedPage?.url).toBe(server.url.href);

			// The task policy admits the owned tab (it would refuse an adopted
			// visible tab); the next gate is the judgment backend.
			await expect(
				executeBrowserTask(session, {
					name,
					goal: "tick the offers box",
					deadlineMs: 10_000,
					maxActionsDefault: 3,
					maxCallsDefault: 3,
				}),
			).rejects.toThrow(/model registry/);

			// The loop drives the owned tab for real.
			const result = await runBrowserTask({
				tabName: name,
				options: { goal: "opt in to email offers", expect: { selector: "#news:checked" } },
				driver: createTabDriver({ name, session, stepTimeoutMs: 20_000 }),
				judge: new ScriptedJudge([{ operation: "CLICK", label: "Email me offers" }, { operation: "DONE" }]),
				budget: { maxCalls: 6, maxActions: 3, deadlineAt: Date.now() + 30_000 },
			});
			expect(result.status).toBe("done");
			expect(result.steps.map(step => [step.operation, step.outcome])).toEqual([
				["CLICK", "applied"],
				["DONE", "applied"],
			]);
			// The task ran on the owned tab, not the user's.
			expect((await listPages(cdpUrl)).find(page => page.id === userPage.id)?.url).toBe(userPage.url);

			// Closing an owned tab removes its target; the user's tab survives.
			const closeResult = await invoke({ action: "close", name });
			opened = false;
			expect(closeResult.content).toEqual([{ type: "text", text: `Released managed tab "${name}"` }]);
			const after = await listPages(cdpUrl);
			expect(after.map(page => page.id)).toEqual(before.map(page => page.id));
			expect(after[0]?.url).toBe(userPage.url);
		} finally {
			if (opened) await invoke({ action: "close", name }).catch(() => undefined);
			await server.stop(true);
			child.kill();
			await child.exited;
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 60_000);
});

/**
 * Stand-in for the Chrome extension: acknowledges every relay RPC, mints tab
 * snapshots for `createTab`, and reports `removeTab` back as `tabRemoved`.
 */
class FakeExtension {
	readonly rpcs: RelayRpcRequest[] = [];
	readonly #ws: WebSocket;
	readonly #ready: Promise<void>;
	#nextTabId = 7;

	constructor(port: number, initialTabs: TabSnapshot[]) {
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
						tabs: initialTabs,
						attachedTabIds: [],
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
				tabId: this.#nextTabId++,
				url: msg.url,
				title: "",
				active: msg.active ?? true,
				windowId: 1,
				pinned: false,
				groupId: -1,
			};
			result = { tab };
		} else if (msg.op === "removeTab") {
			const tabId = msg.tabId;
			queueMicrotask(() => this.#ws.send(JSON.stringify({ t: "tabRemoved", tabId })));
		}
		this.#ws.send(JSON.stringify({ t: "rpcResult", id: msg.id, ok: true, result }));
	}
}

describe("browser open app.new_tab on the relay bridge", () => {
	it("creates the tab in the background through the extension and removes it on close", async () => {
		const port = await findFreeCdpPort();
		const cdpUrl = `http://127.0.0.1:${port}`;
		const bindingPath = await writeRelayBindingFixture();
		const relay: RelayServer = startRelayServer({ port, bindingPath });
		const extension = new FakeExtension(port, []);
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

			const owned = await createOwnedTargetForTest(handle);
			// The relay minted a page target for the tab the extension created,
			// and asked for it in the background so the user's foreground stays.
			expect(owned.targetId).toBe("PAGE7");
			expect(extension.rpcs.filter(rpc => rpc.op === "createTab")).toEqual([
				expect.objectContaining({ op: "createTab", url: "about:blank", active: false }),
			]);
			expect(extension.rpcs.some(rpc => rpc.op === "activateTab")).toBe(false);

			await owned.close();
			expect(extension.rpcs.filter(rpc => rpc.op === "removeTab")).toEqual([
				expect.objectContaining({ op: "removeTab", tabId: 7 }),
			]);
		} finally {
			if (handle) await releaseBrowser(handle, { kill: false });
			extension.close();
			relay.stop();
			await removeRelayBindingFixture(bindingPath);
		}
	}, 15_000);
});
