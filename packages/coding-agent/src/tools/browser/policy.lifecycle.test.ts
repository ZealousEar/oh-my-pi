/**
 * `classifyBrowserDispatch`: the host-side mapping from a `run`/`call` request
 * to a policy descriptor. Raw access is raw regardless of code; chains are
 * classified by their terminal helper; entered values are fingerprinted from
 * the actual value arguments (selector excluded) so a changed value needs a
 * fresh approval.
 */
import { describe, expect, it } from "bun:test";
import { decideAutomationAction, fingerprintAutomationCode, fingerprintAutomationValue } from "../automation-policy";
import { classifyBrowserDispatch } from "../browser";

const URL = "https://app.example.test/path?q=1";
/** Rendered source stand-in; the classifier fingerprints whatever string the caller will dispatch. */
const CODE = "return await tab.observe();";
const OWNED = { ownsTarget: true };
const ADOPTED = { ownsTarget: false, invocationId: "call-7" };

describe("classifyBrowserDispatch", () => {
	it("carries authoritative ownership and the invocation on every shape; navigate verbs on an adopted tab stay navigate for the policy to escalate", () => {
		for (const method of ["goto", "scroll", "scrollIntoView", "focus", "hover"]) {
			const action = classifyBrowserDispatch(
				{ action: "call", chain: [{ method, args: method === "goto" ? [URL] : [] }] },
				URL,
				CODE,
				ADOPTED,
			);
			expect(action).toMatchObject({ tier: "navigate", ownsTarget: false, invocationId: "call-7", raw: false });
			expect(action.summary).toContain("adopted user tab");
			// Review #1: with no scopes the policy denies steering an adopted tab
			// but allows the identical verb on an OMP-owned one.
			expect(decideAutomationAction(action, { scopes: [], now: 0 }).verdict).toBe("deny");
			const owned = classifyBrowserDispatch(
				{ action: "call", chain: [{ method, args: method === "goto" ? [URL] : [] }] },
				URL,
				CODE,
				OWNED,
			);
			expect(decideAutomationAction(owned, { scopes: [], now: 0 }).verdict).toBe("allow");
		}
		expect(classifyBrowserDispatch({ action: "run" }, URL, "x", ADOPTED)).toMatchObject({
			ownsTarget: false,
			invocationId: "call-7",
		});
		expect(
			classifyBrowserDispatch({ action: "call", chain: [{ method: "click", args: ["#a"] }] }, URL, CODE, OWNED),
		).toMatchObject({ ownsTarget: true });
		expect(
			classifyBrowserDispatch({ action: "call", chain: [{ method: "click", args: ["#a"] }] }, URL, CODE, OWNED)
				.invocationId,
		).toBeUndefined();
	});
	it("run and fn are raw mutate no matter what the code says", () => {
		const action = classifyBrowserDispatch({ action: "run", name: "t" }, URL, "return 1", OWNED);
		expect(action).toMatchObject({
			tier: "mutate",
			raw: true,
			action: "browser.tab.run",
			target: "https://app.example.test",
		});
	});
	it("observe/screenshot/url are read; goto targets the destination origin; scroll is navigate", () => {
		expect(
			classifyBrowserDispatch({ action: "call", chain: [{ method: "observe", args: [] }] }, URL, CODE, OWNED),
		).toMatchObject({
			tier: "read",
			raw: false,
			action: "browser.tab.observe",
		});
		expect(
			classifyBrowserDispatch({ action: "call", chain: [{ method: "screenshot", args: [] }] }, URL, CODE, OWNED)
				.tier,
		).toBe("read");
		expect(
			classifyBrowserDispatch(
				{ action: "call", chain: [{ method: "goto", args: ["https://other.test/x"] }] },
				URL,
				CODE,
				OWNED,
			),
		).toMatchObject({ tier: "navigate", target: "https://other.test" });
		expect(
			classifyBrowserDispatch({ action: "call", chain: [{ method: "scroll", args: [0, 100] }] }, URL, CODE, OWNED)
				.tier,
		).toBe("navigate");
	});
	it("evaluate anywhere in the chain is raw", () => {
		expect(
			classifyBrowserDispatch(
				{ action: "call", chain: [{ method: "evaluate", args: ["() => 1"] }] },
				URL,
				CODE,
				OWNED,
			),
		).toMatchObject({ raw: true, tier: "mutate" });
		expect(
			classifyBrowserDispatch(
				{
					action: "call",
					chain: [
						{ method: "id", args: [3] },
						{ method: "evaluate", args: ["el => el.value"] },
					],
				},
				URL,
				CODE,
				OWNED,
			),
		).toMatchObject({ raw: true, tier: "mutate" });
	});
	it("every raw action carries the full-hash fingerprint of the exact source dispatched; non-raw actions carry none", () => {
		const run = classifyBrowserDispatch({ action: "run" }, URL, "await tab.click('#pay')", OWNED);
		expect(run.codeFingerprint).toBe(fingerprintAutomationCode("await tab.click('#pay')"));
		expect(run.codeFingerprint).toHaveLength(64);
		// One byte of difference is a different capability.
		expect(
			classifyBrowserDispatch({ action: "run" }, URL, "await tab.click('#pay');", OWNED).codeFingerprint,
		).not.toBe(run.codeFingerprint);
		const evaluate = classifyBrowserDispatch(
			{ action: "call", chain: [{ method: "evaluate", args: ["() => 1"] }] },
			URL,
			"return await tab.evaluate((() => 1));",
			OWNED,
		);
		expect(evaluate.codeFingerprint).toBe(fingerprintAutomationCode("return await tab.evaluate((() => 1));"));
		expect(
			classifyBrowserDispatch({ action: "call", chain: [{ method: "click", args: ["#go"] }] }, URL, CODE, OWNED)
				.codeFingerprint,
		).toBeUndefined();
	});
	it("type/fill/select fingerprint the entered value, not the selector, on both tab and element shapes", () => {
		const onTab = classifyBrowserDispatch(
			{ action: "call", chain: [{ method: "type", args: ["#email", "secret@example.test"] }] },
			URL,
			CODE,
			OWNED,
		);
		const onElement = classifyBrowserDispatch(
			{
				action: "call",
				chain: [
					{ method: "id", args: [5] },
					{ method: "type", args: ["secret@example.test"] },
				],
			},
			URL,
			CODE,
			OWNED,
		);
		expect(onTab).toMatchObject({ tier: "mutate", raw: false, action: "browser.tab.type" });
		expect(onTab.valueFingerprint).toBe(fingerprintAutomationValue(JSON.stringify(["secret@example.test"])));
		expect(onElement.valueFingerprint).toBe(onTab.valueFingerprint);
		const changed = classifyBrowserDispatch(
			{ action: "call", chain: [{ method: "type", args: ["#email", "other@example.test"] }] },
			URL,
			CODE,
			OWNED,
		);
		expect(changed.valueFingerprint).not.toBe(onTab.valueFingerprint);
		const differentSelectorSameValue = classifyBrowserDispatch(
			{ action: "call", chain: [{ method: "type", args: ["#name", "secret@example.test"] }] },
			URL,
			CODE,
			OWNED,
		);
		expect(differentSelectorSameValue.valueFingerprint).toBe(onTab.valueFingerprint);
		expect(JSON.stringify(onTab)).not.toContain("secret@example.test");
		expect(
			classifyBrowserDispatch({ action: "call", chain: [{ method: "press", args: ["Enter"] }] }, URL, CODE, OWNED)
				.valueFingerprint,
		).toBe(fingerprintAutomationValue(JSON.stringify(["Enter"])));
		expect(
			classifyBrowserDispatch({ action: "call", chain: [{ method: "click", args: ["#go"] }] }, URL, CODE, OWNED)
				.valueFingerprint,
		).toBeUndefined();
	});
	it("file URLs map to the literal file: target and unparseable URLs to about:blank", () => {
		expect(classifyBrowserDispatch({ action: "run" }, "file:///tmp/x.pdf", "x", OWNED).target).toBe("file:");
		expect(classifyBrowserDispatch({ action: "run" }, undefined, "x", OWNED).target).toBe("about:blank");
	});
});
