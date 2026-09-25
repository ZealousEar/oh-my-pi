import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import {
	automationDeniedError,
	automationScopeFromDenied,
	decideAutomationAction,
	fingerprintAutomationCode,
	fingerprintAutomationValue,
	getAutomationScopes,
	grantAutomationScope,
	revokeAutomationScope,
	type AutomationAction,
	withAutomationLease,
} from "@oh-my-pi/pi-coding-agent/tools/automation-policy";

function action(overrides: Partial<AutomationAction> = {}): AutomationAction {
	return {
		surface: "browser",
		tier: "mutate",
		action: "browser.tab.type",
		target: "https://example.test",
		consequential: false,
		raw: false,
		summary: "Type into the current page",
		...overrides,
	};
}

describe("automation permission policy", () => {
	it("allows observation and owned navigation but denies adopted navigation, mutation, and raw execution", () => {
		const now = 10_000;
		expect(decideAutomationAction(action({ tier: "read" }), { scopes: [], now }).verdict).toBe("allow");
		for (const method of ["goto", "scroll", "scrollIntoView", "focus", "hover"]) {
			const navigation = action({ tier: "navigate", action: `browser.tab.${method}` });
			expect(
				decideAutomationAction({ ...navigation, ownsTarget: true }, { scopes: [], now }).verdict,
				`${method} on an owned tab`,
			).toBe("allow");
			expect(
				decideAutomationAction({ ...navigation, ownsTarget: false }, { scopes: [], now }).verdict,
				`${method} on an adopted tab`,
			).toBe("deny");
		}
		expect(decideAutomationAction(action(), { scopes: [], now }).verdict).toBe("deny");
		expect(
			decideAutomationAction(action({ action: "browser.tab.run", raw: true }), { scopes: [], now }).verdict,
		).toBe("deny");
	});

	it("binds interactive scope to exact surface, target, action, consequence, value, and expiry", () => {
		const session = {};
		const now = 20_000;
		const fingerprint = fingerprintAutomationValue("secret value");
		const granted = grantAutomationScope(
			session,
			{
				surface: "browser",
				targets: ["https://example.test"],
				actions: ["browser.tab.type"],
				consequential: false,
				valueFingerprints: [fingerprint],
				ttlMs: 500,
			},
			now,
		);
		const scopes = getAutomationScopes(session, now);
		expect(decideAutomationAction(action({ valueFingerprint: fingerprint }), { scopes, now }).verdict).toBe("allow");
		expect(
			decideAutomationAction(action({ target: "https://other.test", valueFingerprint: fingerprint }), {
				scopes,
				now,
			}).verdict,
		).toBe("deny");
		expect(
			decideAutomationAction(action({ action: "browser.tab.click", valueFingerprint: fingerprint }), { scopes, now })
				.verdict,
		).toBe("deny");
		expect(
			decideAutomationAction(action({ valueFingerprint: fingerprintAutomationValue("changed") }), { scopes, now })
				.verdict,
		).toBe("deny");
		expect(
			decideAutomationAction(action({ valueFingerprint: fingerprint, consequential: true }), { scopes, now })
				.verdict,
		).toBe("deny");
		expect(
			decideAutomationAction(action({ valueFingerprint: fingerprint }), { scopes, now: now + 500 }).verdict,
		).toBe("deny");
		expect(revokeAutomationScope(session, granted.id)).toBe(true);
		expect(getAutomationScopes(session, now)).toHaveLength(0);
	});

	it("binds approve-once scopes to the exact invocation while a concurrent invocation is in flight", () => {
		const session = {};
		const now = 25_000;
		grantAutomationScope(
			session,
			{
				surface: "browser",
				targets: ["https://example.test"],
				actions: ["browser.tab.type"],
				consequential: false,
				once: true,
				invocationId: "approved-call",
			},
			now,
		);
		const scopes = getAutomationScopes(session, now);
		expect(decideAutomationAction(action({ invocationId: "approved-call" }), { scopes, now }).verdict).toBe("allow");
		expect(decideAutomationAction(action({ invocationId: "concurrent-call" }), { scopes, now }).verdict).toBe("deny");
	});

	it("requires an explicit whole-browser or exact-code capability for raw actions", () => {
		const now = 30_000;
		const codeFingerprint = fingerprintAutomationCode("return document.title");
		const raw = action({ action: "browser.tab.run", raw: true, codeFingerprint });
		expect(codeFingerprint).toHaveLength(64);
		const unscoped = decideAutomationAction(raw, { scopes: [], now });
		if (unscoped.verdict !== "deny") throw new Error("expected raw denial");
		expect(unscoped.reason).toContain("whole browser identity");
		expect(unscoped.reason).toContain("not only https://example.test");
		expect(unscoped.needsScope.codeFingerprints).toEqual([codeFingerprint]);

		const wildcardSession = {};
		grantAutomationScope(
			wildcardSession,
			{
				surface: "browser",
				targets: ["https://example.test"],
				actions: ["*"],
				consequential: true,
				rawAccess: "broad",
			},
			now,
		);
		expect(decideAutomationAction(raw, { scopes: getAutomationScopes(wildcardSession, now), now }).verdict).toBe(
			"deny",
		);

		const ordinarySession = {};
		grantAutomationScope(
			ordinarySession,
			{
				surface: "browser",
				targets: ["https://example.test"],
				actions: ["browser.tab.run"],
				consequential: true,
			},
			now,
		);
		expect(decideAutomationAction(raw, { scopes: getAutomationScopes(ordinarySession, now), now }).verdict).toBe(
			"deny",
		);

		const exactCodeSession = {};
		grantAutomationScope(
			exactCodeSession,
			{
				surface: "browser",
				targets: ["https://initial.example"],
				actions: ["browser.tab.run"],
				consequential: true,
				codeFingerprints: [codeFingerprint],
			},
			now,
		);
		const exactScopes = getAutomationScopes(exactCodeSession, now);
		expect(decideAutomationAction(raw, { scopes: exactScopes, now }).verdict).toBe("allow");
		expect(
			decideAutomationAction(action({ ...raw, codeFingerprint: fingerprintAutomationCode("changed") }), {
				scopes: exactScopes,
				now,
			}).verdict,
		).toBe("deny");
		const broadSession = {};
		grantAutomationScope(
			broadSession,
			{
				surface: "browser",
				targets: ["https://initial.example"],
				actions: ["browser.tab.run"],
				consequential: true,
				rawAccess: "broad",
			},
			now,
		);
		expect(
			decideAutomationAction(action({ ...raw, target: "https://other.example" }), {
				scopes: getAutomationScopes(broadSession, now),
				now,
			}).verdict,
		).toBe("allow");
	});

	it("loads exact pre-authorized grants only from the user-global settings layer", () => {
		const configured = [
			{ targets: ["https://example.test"], actions: ["browser.tab.click"], task: "fixture login" },
			{ targets: ["https://*.test"], actions: ["browser.tab.click"] },
			{ targets: ["https://expired.test"], actions: ["browser.tab.click"], ttlMinutes: 0 },
		];
		const session = {
			settings: {
				get: () => configured,
				getGlobalSettings: () => ({ "browser.permissions.grants": configured }),
			},
		};
		const scopes = getAutomationScopes(session, 40_000);
		expect(scopes.map(scope => scope.targets[0])).toEqual(["https://example.test"]);
		expect(decideAutomationAction(action({ action: "browser.tab.click" }), { scopes, now: 40_000 }).verdict).toBe(
			"allow",
		);
	});

	it("ignores a grant present only in the project settings layer even when merged get exposes it", () => {
		const projectGrant = [{ targets: ["https://example.test"], actions: ["browser.tab.click"] }];
		const session = {
			settings: {
				get: () => projectGrant,
				getGlobalSettings: () => ({}),
				getProjectSettings: () => ({ "browser.permissions.grants": projectGrant }),
			},
		};
		expect(getAutomationScopes(session, 41_000)).toEqual([]);
	});

	it("accepts the lifecycle's exact about:blank and file targets without accepting wildcards", () => {
		const session = {};
		expect(() =>
			grantAutomationScope(session, {
				surface: "browser",
				targets: ["about:blank", "file:"],
				actions: ["browser.tab.run"],
				consequential: false,
			}),
		).not.toThrow();
	});

	it("uses a parseable denial contract without including the typed value", () => {
		const typed = "never print this value";
		const verdict = decideAutomationAction(action({ valueFingerprint: fingerprintAutomationValue(typed) }), {
			scopes: [],
			now: 50_000,
		});
		if (verdict.verdict !== "deny") throw new Error("expected denial");
		const error = automationDeniedError(verdict);
		expect(error.message.startsWith("AUTOMATION_DENIED:")).toBe(true);
		expect(error.message).not.toContain(typed);
		expect(automationScopeFromDenied(error)).toEqual(verdict.needsScope);
	});

	it("refuses overlap across processes and reclaims a killed holder's desktop lease", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "automation-lease-"));
		const leaseFile = path.join(root, "desktop");
		const readyFile = path.join(root, "ready");
		const fixture = path.join(import.meta.dir, "../fixtures/automation-lease-holder.ts");
		const child = Bun.spawn([process.execPath, fixture, leaseFile, readyFile], {
			cwd: path.join(import.meta.dir, "../.."),
			stdout: "ignore",
			stderr: "pipe",
		});
		try {
			for (let attempt = 0; attempt < 100; attempt++) {
				if (await Bun.file(readyFile).exists()) break;
				if (child.exitCode !== null) {
					throw new Error(`lease holder exited early: ${await new Response(child.stderr).text()}`);
				}
				await Bun.sleep(20);
			}
			expect(await Bun.file(readyFile).exists()).toBe(true);
			await expect(withAutomationLease({}, async () => undefined, undefined, leaseFile)).rejects.toThrow(
				`AUTOMATION_BUSY: desktop held by pid ${child.pid} since `,
			);

			child.kill("SIGKILL");
			await child.exited;
			await expect(withAutomationLease({}, async () => "reclaimed", undefined, leaseFile)).resolves.toBe(
				"reclaimed",
			);

			const abort = new AbortController();
			let started: (() => void) | undefined;
			const running = new Promise<void>(resolve => {
				started = resolve;
			});
			const held = withAutomationLease(
				{},
				async () => {
					started?.();
					await new Promise<void>(resolve =>
						abort.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
				},
				abort.signal,
				leaseFile,
			);
			await running;
			abort.abort();
			await held;
			await expect(withAutomationLease({}, async () => "after-abort", undefined, leaseFile)).resolves.toBe(
				"after-abort",
			);
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("requires an explicit app-wide capability for desktop control of browser applications", () => {
		const now = 60_000;
		const session = {};
		grantAutomationScope(
			session,
			{
				surface: "computer",
				targets: ["Google Chrome"],
				actions: ["computer.click"],
				consequential: false,
			},
			now,
		);
		const chromeClick = action({
			surface: "computer",
			action: "computer.click",
			target: "Google Chrome",
			summary: "Click in Chrome",
		});
		const denied = decideAutomationAction(chromeClick, { scopes: getAutomationScopes(session, now), now });
		expect(denied.verdict).toBe("deny");
		if (denied.verdict !== "deny") throw new Error("expected browser-app denial");
		expect(denied.needsScope.browserAppAccess).toBe("broad");
		grantAutomationScope(
			session,
			{
				surface: "computer",
				targets: ["Google Chrome"],
				actions: ["computer.click"],
				consequential: false,
				browserAppAccess: "broad",
			},
			now,
		);
		expect(decideAutomationAction(chromeClick, { scopes: getAutomationScopes(session, now), now }).verdict).toBe(
			"allow",
		);
	});

	it("requires an explicit desktop-wide capability for root coordinate and keyboard input", () => {
		const now = 65_000;
		const session = {};
		grantAutomationScope(
			session,
			{
				surface: "computer",
				targets: ["Code"],
				actions: ["computer.click"],
				consequential: false,
			},
			now,
		);
		const rootClick = action({
			surface: "computer",
			action: "computer.click",
			target: "desktop",
			summary: "Click desktop coordinates",
			desktopWide: true,
		});
		const denied = decideAutomationAction(rootClick, { scopes: getAutomationScopes(session, now), now });
		expect(denied.verdict).toBe("deny");
		if (denied.verdict !== "deny") throw new Error("expected desktop-wide denial");
		expect(denied.needsScope).toMatchObject({ targets: ["desktop"], desktopAccess: "broad" });
		grantAutomationScope(
			session,
			{
				surface: "computer",
				targets: ["desktop"],
				actions: ["computer.click"],
				consequential: false,
				desktopAccess: "broad",
			},
			now,
		);
		expect(decideAutomationAction(rootClick, { scopes: getAutomationScopes(session, now), now }).verdict).toBe(
			"allow",
		);
	});

	it("rejects wildcard targets at the only session-scope grant boundary", () => {
		expect(() =>
			grantAutomationScope(
				{},
				{
					surface: "browser",
					targets: ["https://*.example.test"],
					actions: ["browser.tab.click"],
					consequential: false,
				},
			),
		).toThrow(/wildcards are not allowed/);
	});
});
