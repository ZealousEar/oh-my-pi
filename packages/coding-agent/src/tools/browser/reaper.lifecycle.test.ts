/**
 * Abandoned-tab reaper and dispatch permission gate, driven with an injected
 * clock and stub tabs so the six-hour path runs in milliseconds.
 *
 * Contract: only OMP-created tabs (`ownsTarget`) can ever be closed; adopted
 * user tabs, `persist`, in-flight runs, login/credential pages, unsaved input,
 * downloads and foreground user-driven tabs are retained; a probe failure
 * retains; a denied dispatch surfaces as `AUTOMATION_DENIED` before the worker
 * sees any code; a read dispatch reaches the worker without a scope.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fingerprintAutomationCode, grantAutomationScope } from "../automation-policy";
import type { ToolSession } from "../index";
import { ownedSharedTargets, recordSharedTarget, resetOrphanRegistryForTest } from "./orphan-registry";
import type { WorkerInbound, WorkerOutbound } from "./tab-protocol";
import {
	type AbandonedVerdict,
	acquireTab,
	armAbandonedDeadline,
	cancelAbandonedDeadline,
	classifyAbandoned,
	earliestAbandonedInMs,
	getTabsMapForTest,
	hasAbandonedDeadlineForTest,
	orphanDecisionFor,
	reapAbandonedTabs,
	releaseTab,
	runInTab,
	setAbandonedTimersForTest,
	setTabClockForTest,
	type TabProtectionProbe,
	type WorkerTabSession,
} from "./tab-supervisor";

const SIX_HOURS = 6 * 3_600_000;
const T0 = 1_700_000_000_000;
let restoreClock: (() => void) | undefined;
let clockNow = T0;

function useClock(): void {
	restoreClock = setTabClockForTest(() => clockNow);
}

const CLEAR: TabProtectionProbe = { loginPath: false, credentialField: false, unsavedInput: false, visible: false };

/** Stub worker tab; `sent` records what reached the worker, and runs resolve immediately. */
function stubTab(
	name: string,
	overrides: Partial<WorkerTabSession> = {},
): { tab: WorkerTabSession; sent: WorkerInbound[]; closed: string[] } {
	const sent: WorkerInbound[] = [];
	const closed: string[] = [];
	const handlers: Array<(msg: WorkerOutbound) => void> = [];
	const tab: WorkerTabSession = {
		name,
		browser: {
			key: "stub",
			kind: { kind: "headless", headless: true },
			refCount: 10,
			browser: { targets: () => [], connected: true },
			stealth: { browserSession: null, override: null },
		} as unknown as WorkerTabSession["browser"],
		targetId: `target-${name}`,
		state: "alive",
		info: { url: "https://example.test/app", viewport: { width: 1, height: 1 }, targetId: `target-${name}` },
		pending: new Map(),
		kindTag: "headless",
		backend: "worker",
		activateForScreenshot: false,
		ownsTarget: true,
		ownerSessionId: "owner-a",
		persist: false,
		lastActivityAt: T0,
		frozen: false,
		worker: {
			mode: "worker",
			send(msg: WorkerInbound) {
				sent.push(msg);
				if (msg.type === "run") {
					const pending = tab.pending.get(msg.id);
					tab.pending.delete(msg.id);
					pending?.resolve({ displays: [], returnValue: "ok", screenshots: [] });
				}
				if (msg.type === "close") {
					closed.push(name);
					// The real worker answers asynchronously; the supervisor subscribes after sending.
					queueMicrotask(() => {
						for (const handler of handlers) handler({ type: "closed" });
					});
				}
			},
			onMessage: (handler: (msg: WorkerOutbound) => void) => {
				handlers.push(handler);
				return () => undefined;
			},
			onError: () => () => undefined,
			terminate: async () => undefined,
		} as unknown as WorkerTabSession["worker"],
		...overrides,
	};
	return { tab, sent, closed };
}

function session(): ToolSession {
	return { cwd: "/tmp", settings: { get: () => undefined } } as unknown as ToolSession;
}

afterEach(() => {
	cancelAbandonedDeadline();
	restoreClock?.();
	restoreClock = undefined;
	clockNow = T0;
	getTabsMapForTest().clear();
});

/** Fake one-shot timer: records the armed delay; `fire()` runs the callback as the real timer would. */
function fakeTimers(): { delays: number[]; fire(): void; restore(): void; armed(): boolean } {
	const delays: number[] = [];
	let pending: (() => void) | undefined;
	const restore = setAbandonedTimersForTest({
		set: (fn, ms) => {
			delays.push(ms);
			pending = fn;
			return { fake: true } as unknown as NodeJS.Timeout;
		},
		clear: () => {
			pending = undefined;
		},
	});
	return {
		delays,
		fire() {
			const fn = pending;
			pending = undefined;
			fn?.();
		},
		restore,
		armed: () => pending !== undefined,
	};
}

describe("classifyAbandoned — every protection retains", () => {
	const cases: Array<
		[
			string,
			Partial<WorkerTabSession>,
			Partial<TabProtectionProbe> | undefined,
			boolean | undefined,
			AbandonedVerdict,
		]
	> = [
		["adopted user tab", { ownsTarget: false }, {}, false, "not-owned"],
		["persist", { persist: true }, {}, false, "persist"],
		["fresh (idle < 6h)", { lastActivityAt: T0 + SIX_HOURS + 1 }, {}, false, "fresh"],
		["active download", {}, {}, true, "download"],
		["download state unknown", {}, {}, undefined, "download"],
		["login path", {}, { loginPath: true }, false, "login"],
		["password/OTP field", {}, { credentialField: true }, false, "login"],
		["unsaved input", {}, { unsavedInput: true }, false, "unsaved-input"],
		["foreground relay tab", { kindTag: "relay" }, { visible: true }, false, "foreground"],
		["probe failed", {}, undefined, false, "unprovable"],
		["nothing protects", {}, {}, false, "close"],
	];
	for (const [label, overrides, probe, download, expected] of cases) {
		it(label, () => {
			const { tab } = stubTab("t", overrides);
			const verdict = classifyAbandoned(
				tab,
				T0 + SIX_HOURS * 2,
				SIX_HOURS,
				probe ? { ...CLEAR, ...probe } : undefined,
				download,
			);
			expect(verdict).toBe(expected);
		});
	}
	it("an in-flight run is busy, and a visible headless page is not a foreground protection", () => {
		const { tab } = stubTab("t");
		tab.pending.set("run", {} as never);
		expect(classifyAbandoned(tab, T0 + SIX_HOURS * 2, SIX_HOURS, CLEAR, false)).toBe("busy");
		tab.pending.clear();
		expect(classifyAbandoned(tab, T0 + SIX_HOURS * 2, SIX_HOURS, { ...CLEAR, visible: true }, false)).toBe("close");
	});
});

describe("reapAbandonedTabs — injected clock", () => {
	it("closes an owned tab after six idle hours, retains the protected ones, and never touches adopted tabs", async () => {
		useClock();
		const tabs = getTabsMapForTest();
		const owned = stubTab("owned");
		const adopted = stubTab("adopted", { ownsTarget: false, kindTag: "relay" });
		const login = stubTab("login");
		const other = stubTab("other-owner", { ownerSessionId: "owner-b" });
		for (const { tab } of [owned, adopted, login, other]) tabs.set(tab.name, tab);
		const probes: Record<string, TabProtectionProbe> = { owned: CLEAR, login: { ...CLEAR, credentialField: true } };
		const opts = {
			idleMs: SIX_HOURS,
			ownerId: "owner-a",
			probe: async (tab: WorkerTabSession) => probes[tab.name] ?? CLEAR,
			downloads: () => false,
		};

		clockNow = T0 + SIX_HOURS - 1;
		expect((await reapAbandonedTabs(opts)).closed).toEqual([]);
		expect(tabs.has("owned")).toBe(true);

		clockNow = T0 + SIX_HOURS;
		const result = await reapAbandonedTabs(opts);
		expect(result.closed).toEqual(["owned"]);
		expect(result.retained).toEqual({ login: "login" });
		expect(tabs.has("owned")).toBe(false);
		expect(owned.closed).toEqual(["owned"]);
		expect(tabs.has("adopted")).toBe(true);
		expect(tabs.has("login")).toBe(true);
		// Another session's tab is outside this owner's sweep entirely.
		expect(tabs.has("other-owner")).toBe(true);
		expect(adopted.closed).toEqual([]);
	});

	it("a meaningful run resets the six-hour clock; a probe failure retains", async () => {
		useClock();
		const tabs = getTabsMapForTest();
		const { tab } = stubTab("busy-then-idle");
		tabs.set(tab.name, tab);
		clockNow = T0 + SIX_HOURS - 60_000;
		await runInTab(tab.name, {
			code: "return 1",
			timeoutMs: 1_000,
			session: session(),
			automation: {
				surface: "browser",
				tier: "read",
				action: "browser.tab.observe",
				target: "https://example.test",
				consequential: false,
				raw: false,
				summary: "observe",
			},
		});
		clockNow = T0 + SIX_HOURS + 1;
		const opts = { idleMs: SIX_HOURS, ownerId: "owner-a", probe: async () => CLEAR, downloads: () => false };
		expect((await reapAbandonedTabs(opts)).retained).toEqual({ "busy-then-idle": "fresh" });
		clockNow = T0 + SIX_HOURS * 2;
		const failing = {
			...opts,
			probe: async () => ({ loginPath: true, credentialField: true, unsavedInput: true, visible: true }),
		};
		expect((await reapAbandonedTabs(failing)).retained).toEqual({ "busy-then-idle": "login" });
		expect(tabs.has(tab.name)).toBe(true);
	});
});

describe("orphanDecisionFor — inherited (crashed-owner) targets", () => {
	const browser = { targets: () => [] } as unknown as Parameters<typeof orphanDecisionFor>[0];
	/** Browser whose PAGE7 answers the protection probe with the given page state. */
	const probing = (state: Partial<Record<"loginPath" | "credentialField" | "unsavedInput" | "visible", boolean>>) =>
		({
			targets: () => [
				{
					_targetId: "PAGE7",
					createCDPSession: async () => ({
						send: async () => ({
							result: {
								value: {
									loginPath: false,
									credentialField: false,
									unsavedInput: false,
									visible: false,
									...state,
								},
							},
						}),
						detach: async () => undefined,
					}),
				},
			],
		}) as unknown as Parameters<typeof orphanDecisionFor>[0];
	const record = (persist: boolean, marker?: string) => ({
		targetId: "PAGE7",
		record: {
			targetId: "PAGE7",
			name: "x",
			channel: "c",
			persist,
			createdAt: T0,
			lastMeaningfulActivityAt: T0,
			generation: "g",
			marker,
		},
	});
	it("headless: closes a non-persistent record and a legacy id-only record (#10022), retains persist until idle and probe pass", async () => {
		useClock();
		const decide = orphanDecisionFor(browser, { idleMs: SIX_HOURS, kind: "headless" });
		expect(await decide(record(false))).toBe("close");
		expect(await decide({ targetId: "LEGACY" })).toBe("close");
		expect(await decide(record(true))).toBe("retain");
		clockNow = T0 + SIX_HOURS;
		// Target not found in browser.targets() → probe fails safe → retain.
		expect(await decide(record(true))).toBe("retain");
		expect(await orphanDecisionFor(probing({}), { idleMs: SIX_HOURS, kind: "headless" })(record(true))).toBe("close");
	});
	it("relay: a matched marker never closes immediately — idle window, dirty form, login and foreground all retain (review F4)", async () => {
		useClock();
		const live = new Map([["PAGE7", "uuid-live"]]);
		const fresh = orphanDecisionFor(probing({}), { idleMs: SIX_HOURS, kind: "relay", liveMarkers: live });
		expect(await fresh(record(false, "uuid-live"))).toBe("retain");
		expect(await fresh({ targetId: "PAGE7" })).toBe("retain"); // legacy proof is headless-only
		clockNow = T0 + SIX_HOURS;
		for (const protection of [
			{ unsavedInput: true },
			{ credentialField: true },
			{ loginPath: true },
			{ visible: true },
		]) {
			const decide = orphanDecisionFor(probing(protection), { idleMs: SIX_HOURS, kind: "relay", liveMarkers: live });
			expect(await decide(record(false, "uuid-live"))).toBe("retain");
		}
		expect(
			await orphanDecisionFor(browser, { idleMs: SIX_HOURS, kind: "relay", liveMarkers: live })(
				record(false, "uuid-live"),
			),
		).toBe("retain"); // unprovable
		const clean = orphanDecisionFor(probing({}), { idleMs: SIX_HOURS, kind: "relay", liveMarkers: live });
		expect(await clean(record(false, "uuid-live"))).toBe("close");
		expect(await clean(record(true, "uuid-live"))).toBe("close");
	});
	it("relay records need a matching live marker: unmarked retains, mismatch retains, gone discards", async () => {
		useClock();
		clockNow = T0 + SIX_HOURS;
		const decide = orphanDecisionFor(probing({}), {
			idleMs: SIX_HOURS,
			kind: "relay",
			liveMarkers: new Map([["PAGE7", "uuid-live"]]),
		});
		expect(await decide(record(false))).toBe("retain");
		expect(await decide(record(false, "uuid-other"))).toBe("retain");
		expect(await decide(record(false, "uuid-live"))).toBe("close");
		const gone = orphanDecisionFor(browser, { idleMs: SIX_HOURS, kind: "relay", liveMarkers: new Map() });
		expect(await gone(record(false, "uuid-live"))).toBe("discard");
	});
});

describe("release keeps the durable record until the target is confirmed gone (review F3)", () => {
	const roots: string[] = [];
	afterEach(async () => {
		resetOrphanRegistryForTest();
		for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
	});
	/** Owned tab on a shared daemon whose worker never confirms `close`, so release falls back to `Target.closeTarget`. */
	async function recordedTab(name: string, closeSucceeds: boolean) {
		const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-release-record-"));
		roots.push(runtimeDir);
		const scope = { runtimeDir, daemonName: "omp.browser.headless" };
		const { tab } = stubTab(name);
		const mute = { ...tab.worker, send: () => undefined } as unknown as WorkerTabSession["worker"];
		tab.worker = mute;
		tab.browser = {
			...tab.browser,
			sharedDaemon: { name: scope.daemonName, runtimeDir, profileDir: "/dev/null", generation: "g" },
			browser: {
				connected: true,
				targets: () => [],
				target: () => ({
					createCDPSession: async () => ({
						send: async (method: string) =>
							method === "Target.closeTarget"
								? { success: closeSucceeds }
								: { targetInfos: closeSucceeds ? [] : [{ targetId: tab.targetId }] },
						detach: async () => undefined,
					}),
				}),
			},
		} as unknown as WorkerTabSession["browser"];
		await recordSharedTarget(scope, {
			targetId: tab.targetId,
			name,
			channel: "c",
			persist: false,
			createdAt: T0,
			lastMeaningfulActivityAt: T0,
			generation: "g",
		});
		getTabsMapForTest().set(name, tab);
		return { tab, scope };
	}
	it("forgets the record after a confirmed Page.close and keeps it when the target is still there", async () => {
		const ok = await recordedTab("closes", true);
		await releaseTab("closes", { kill: false, timeoutMs: 1_000 });
		expect(ownedSharedTargets(ok.scope)).toEqual([]);

		const stuck = await recordedTab("survives", false);
		await releaseTab("survives", { kill: false, timeoutMs: 1_000 });
		expect(getTabsMapForTest().has("survives")).toBe(false);
		expect(ownedSharedTargets(stuck.scope).map(r => r.targetId)).toEqual([stuck.tab.targetId]);
	});
});

describe("approve-once binding (review N2)", () => {
	afterEach(() => {
		getTabsMapForTest().clear();
	});
	it("reuse-time navigation of an adopted tab carries the acquirer's invocation: a once scope for that call admits it, another call is denied", async () => {
		const tabs = getTabsMapForTest();
		const { tab, sent } = stubTab("adopted-reuse", { ownsTarget: false, kindTag: "connected" });
		tabs.set(tab.name, tab);
		const s = session();
		const reopen = (invocationId: string) =>
			acquireTab(tab.name, tab.browser, {
				url: "https://example.test/next",
				timeoutMs: 1_000,
				session: s,
				invocationId,
			});
		// No scope at all: steering the adopted tab is a mutation → denied, nothing dispatched.
		await expect(reopen("call-1")).rejects.toThrow(/^AUTOMATION_DENIED: .*browser\.tab\.goto/);
		expect(sent.filter(m => m.type === "run")).toHaveLength(0);
		grantAutomationScope(s, {
			surface: "browser",
			targets: ["https://example.test"],
			actions: ["browser.tab.goto"],
			consequential: false,
			once: true,
			invocationId: "call-1",
		});
		// A different invocation cannot spend the once approval.
		await expect(reopen("call-2")).rejects.toThrow(/^AUTOMATION_DENIED: /);
		expect(sent.filter(m => m.type === "run")).toHaveLength(0);
		const reused = await reopen("call-1");
		expect(reused.created).toBe(false);
		const runs = sent.filter(m => m.type === "run");
		expect(runs).toHaveLength(1);
		expect(runs[0]?.type === "run" && runs[0].code).toContain('tab.goto("https://example.test/next"');
	});
	it("exported runInTab forwards invocationId to the gate", async () => {
		const tabs = getTabsMapForTest();
		const { tab, sent } = stubTab("run-once");
		tabs.set(tab.name, tab);
		const s = session();
		const click = {
			surface: "browser" as const,
			tier: "mutate" as const,
			action: "browser.tab.click",
			target: "https://example.test",
			consequential: false,
			raw: false,
			summary: "click",
		};
		grantAutomationScope(s, {
			surface: "browser",
			targets: ["https://example.test"],
			actions: ["browser.tab.click"],
			consequential: false,
			once: true,
			invocationId: "call-9",
		});
		await expect(
			runInTab(tab.name, { code: "x", timeoutMs: 1_000, session: s, automation: click, invocationId: "call-8" }),
		).rejects.toThrow(/^AUTOMATION_DENIED: /);
		await expect(runInTab(tab.name, { code: "x", timeoutMs: 1_000, session: s, automation: click })).rejects.toThrow(
			/^AUTOMATION_DENIED: /,
		);
		await runInTab(tab.name, { code: "x", timeoutMs: 1_000, session: s, automation: click, invocationId: "call-9" });
		expect(sent.filter(m => m.type === "run")).toHaveLength(1);
	});
});

describe("dispatch permission gate", () => {
	it("denies tab.run (raw) and type without a scope, allows observe, and allows type once the user grants an exact scope", async () => {
		const tabs = getTabsMapForTest();
		const { tab, sent } = stubTab("gated");
		tabs.set(tab.name, tab);
		const s = session();
		const base = { surface: "browser" as const, target: "https://example.test", consequential: false };

		await expect(runInTab(tab.name, { code: "await tab.click('#x')", timeoutMs: 1_000, session: s })).rejects.toThrow(
			/^AUTOMATION_DENIED: /,
		);
		await expect(
			runInTab(tab.name, {
				code: "x",
				timeoutMs: 1_000,
				session: s,
				automation: { ...base, tier: "mutate", action: "browser.tab.type", raw: false, summary: "type" },
			}),
		).rejects.toThrow(/AUTOMATION_DENIED: .*browser\.tab\.type/);
		expect(sent.filter(m => m.type === "run")).toHaveLength(0);
		expect(tab.pending.size).toBe(0);

		await runInTab(tab.name, {
			code: "x",
			timeoutMs: 1_000,
			session: s,
			automation: { ...base, tier: "read", action: "browser.tab.observe", raw: false, summary: "observe" },
		});
		expect(sent.filter(m => m.type === "run")).toHaveLength(1);

		grantAutomationScope(s, {
			surface: "browser",
			targets: ["https://example.test"],
			actions: ["browser.tab.type"],
			consequential: false,
		});
		await runInTab(tab.name, {
			code: "x",
			timeoutMs: 1_000,
			session: s,
			automation: { ...base, tier: "mutate", action: "browser.tab.type", raw: false, summary: "type" },
		});
		expect(sent.filter(m => m.type === "run")).toHaveLength(2);
		// The scope does not cover raw access or another origin.
		await expect(runInTab(tab.name, { code: "x", timeoutMs: 1_000, session: s })).rejects.toThrow(
			/AUTOMATION_DENIED/,
		);
		await expect(
			runInTab(tab.name, {
				code: "x",
				timeoutMs: 1_000,
				session: s,
				automation: {
					...base,
					target: "https://other.test",
					tier: "mutate",
					action: "browser.tab.type",
					raw: false,
					summary: "type",
				},
			}),
		).rejects.toThrow(/AUTOMATION_DENIED/);
		// A raw grant bound to the exact source admits that source only: the
		// supervisor fingerprints the very string the worker will execute, so
		// a one-byte change is a different, ungranted action; an ordinary
		// `browser.tab.run` action name without a raw capability grants nothing.
		grantAutomationScope(s, {
			surface: "browser",
			targets: ["https://example.test"],
			actions: ["browser.tab.run"],
			consequential: false,
			codeFingerprints: [fingerprintAutomationCode("return 1")],
		});
		await runInTab(tab.name, { code: "return 1", timeoutMs: 1_000, session: s });
		expect(sent.filter(m => m.type === "run")).toHaveLength(3);
		await expect(runInTab(tab.name, { code: "return 2", timeoutMs: 1_000, session: s })).rejects.toThrow(
			/AUTOMATION_DENIED/,
		);
		expect(sent.filter(m => m.type === "run")).toHaveLength(3);
	});

	it("a raw descriptor can never be downgraded below mutate", async () => {
		const tabs = getTabsMapForTest();
		const { tab, sent } = stubTab("raw");
		tabs.set(tab.name, tab);
		await expect(
			runInTab(tab.name, {
				code: "x",
				timeoutMs: 1_000,
				session: session(),
				automation: {
					surface: "browser",
					tier: "read",
					action: "browser.tab.evaluate",
					target: "https://example.test",
					consequential: false,
					raw: true,
					summary: "evaluate",
				},
			}),
		).rejects.toThrow(/AUTOMATION_DENIED/);
		expect(sent).toHaveLength(0);
	});
});

describe("abandoned deadline timer — closes without any later turn or tool call", () => {
	it("arms for the earliest owned expiry, fires the full reap path, closes the idle tab and re-arms for the survivor", async () => {
		useClock();
		const timers = fakeTimers();
		try {
			const tabs = getTabsMapForTest();
			const idle = stubTab("idle", { lastActivityAt: T0 - 3_600_000 });
			const later = stubTab("later", { lastActivityAt: T0 });
			const adopted = stubTab("adopted", {
				ownsTarget: false,
				kindTag: "relay",
				lastActivityAt: T0 - SIX_HOURS * 3,
			});
			const persist = stubTab("persist", { persist: true, lastActivityAt: T0 - SIX_HOURS * 3 });
			for (const { tab } of [idle, later, adopted, persist]) tabs.set(tab.name, tab);
			// Adopted and persist tabs never produce a deadline.
			expect(earliestAbandonedInMs(SIX_HOURS)).toBe(SIX_HOURS - 3_600_000);
			armAbandonedDeadline({ idleMs: SIX_HOURS, probe: async () => CLEAR, downloads: () => false });
			expect(hasAbandonedDeadlineForTest()).toBe(true);
			expect(timers.delays).toEqual([SIX_HOURS - 3_600_000]);

			// Time passes with NO turn, open, or tool call; the timer fires.
			clockNow = T0 + SIX_HOURS - 3_600_000;
			timers.fire();
			await Bun.sleep(5);
			expect(tabs.has("idle")).toBe(false);
			expect(idle.closed).toEqual(["idle"]);
			expect(tabs.has("later")).toBe(true);
			expect(tabs.has("adopted")).toBe(true);
			expect(tabs.has("persist")).toBe(true);
			// Re-armed for the survivor's own deadline (one hour later).
			expect(timers.armed()).toBe(true);
			expect(timers.delays.at(-1)).toBe(3_600_000);
		} finally {
			timers.restore();
		}
	});

	it("a protected tab is retained by the timer path and rechecked on the retry cadence; activity re-arms", async () => {
		useClock();
		const timers = fakeTimers();
		try {
			const tabs = getTabsMapForTest();
			const login = stubTab("login", { lastActivityAt: T0 - SIX_HOURS * 2 });
			tabs.set(login.tab.name, login.tab);
			armAbandonedDeadline({
				idleMs: SIX_HOURS,
				probe: async () => ({ ...CLEAR, credentialField: true }),
				downloads: () => false,
			});
			// Already due: the arm schedules a retry-cadence recheck, not an immediate close.
			expect(timers.delays).toEqual([15 * 60_000]);
			timers.fire();
			await Bun.sleep(5);
			expect(tabs.has("login")).toBe(true);
			expect(login.closed).toEqual([]);
			expect(timers.armed()).toBe(true);

			// A meaningful run pushes the deadline out to a full window from now.
			clockNow = T0;
			await runInTab(login.tab.name, {
				code: "x",
				timeoutMs: 1_000,
				session: session(),
				automation: {
					surface: "browser",
					tier: "read",
					action: "browser.tab.observe",
					target: "https://example.test",
					consequential: false,
					raw: false,
					summary: "observe",
				},
			});
			expect(timers.delays.at(-1)).toBe(SIX_HOURS);
			// Cancel disarms; a later sweep completion must not resurrect it.
			cancelAbandonedDeadline();
			expect(hasAbandonedDeadlineForTest()).toBe(false);
			expect(timers.armed()).toBe(false);
		} finally {
			timers.restore();
		}
	});
});
