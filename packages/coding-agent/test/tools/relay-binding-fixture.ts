/**
 * Relay profile-binding fixtures shared by the relay tests: a relay only
 * becomes ready for the extension install named in its binding file, so
 * every test that expects readiness binds a temp file to the install id its
 * fake extension reports.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RelayBinding } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/binding";

/** Install id every fake extension reports unless a test says otherwise. */
export const TEST_INSTALL_ID = "11111111-2222-4333-8444-555555555555";

/** Hello fields a compatible (0.2.0) fake extension must send. */
export const TEST_HELLO_IDENTITY = { extensionVersion: "0.2.0", installId: TEST_INSTALL_ID } as const;

/** Write `binding.json` (bound to `installId`) into a fresh temp dir and return its path. */
export async function writeRelayBindingFixture(installId: string = TEST_INSTALL_ID): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-binding-"));
	const bindingPath = path.join(dir, "binding.json");
	await bindRelayFixture(bindingPath, installId);
	return bindingPath;
}

/** (Re)bind an existing fixture path to `installId`. */
export async function bindRelayFixture(bindingPath: string, installId: string): Promise<void> {
	const binding: RelayBinding = { installId, boundAt: new Date().toISOString(), note: "test fixture" };
	await Bun.write(bindingPath, JSON.stringify(binding));
}

/** Remove the binding file (relay becomes unbound) and its temp dir when `removeDir`. */
export async function removeRelayBindingFixture(bindingPath: string, removeDir = true): Promise<void> {
	await fs.rm(removeDir ? path.dirname(bindingPath) : bindingPath, { recursive: true, force: true });
}
