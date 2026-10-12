/**
 * Test fixture grants for the browser automation gate.
 *
 * Browser dispatch is read-only by default: raw `tab.run`/`evaluate` and input
 * helpers need an exact user scope (`decideAutomationAction`). Suites whose
 * contract is something else (rejection plumbing, freeze/settle, first-use
 * download, target selection) pre-grant one here so their original assertion
 * stays the subject. This is a fixture grant on the fixture session object —
 * never a policy widening or bypass: production sessions get nothing from it.
 */
import { grantAutomationScope } from "@oh-my-pi/pi-coding-agent/tools/automation-policy";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

/**
 * Every browser verb the tab helpers can emit: `"*"` covers all non-raw
 * mutations (the policy never lets it cover raw verbs, which are listed).
 */
export const BROWSER_MUTATION_ACTIONS: readonly string[] = [
	"*",
	"browser.tab.run",
	"browser.tab.evaluate",
	// `tab.task` steps (driver.ts): mutating operations by kind.
	"browser.task.CLICK",
	"browser.task.TYPE_TEXT",
	"browser.task.SELECT",
];

/** Fixture-only default targets: the blank page every worker starts on plus the loopback origins tests serve from. */
export const FIXTURE_TARGETS: readonly string[] = ["about:blank", "file:"];

/**
 * Grant the fixture session an exact scope for raw/mutating browser verbs on
 * `targets` (default: about:blank/file:, plus any extra loopback origins).
 * Returns the session for chaining.
 */
export function grantBrowserFixtureScope<T extends object>(session: T, extraTargets: readonly string[] = []): T {
	grantAutomationScope(session, {
		surface: "browser",
		targets: [...FIXTURE_TARGETS, ...extraTargets],
		actions: BROWSER_MUTATION_ACTIONS,
		consequential: false,
		// Raw verbs additionally need an explicit raw capability; fixtures run arbitrary code.
		rawAccess: "broad",
		task: "test fixture",
	});
	return session;
}

/** Loopback origins for a `Bun.serve`/`http.Server` fixture: both spellings Chrome may report. `Bun.serve().port` is optional in its typings. */
export function loopbackOrigins(port: number | undefined): string[] {
	if (port === undefined) throw new Error("loopbackOrigins: fixture server has no port");
	return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

/** Minimal fixture ToolSession with the browser scope pre-granted. */
export function grantedToolSession(cwd: string, extraTargets: readonly string[] = []): ToolSession {
	const session = {
		cwd,
		hasUI: false,
		settings: { get: () => undefined },
		getSessionFile: () => null,
	} as unknown as ToolSession;
	return grantBrowserFixtureScope(session, extraTargets);
}
