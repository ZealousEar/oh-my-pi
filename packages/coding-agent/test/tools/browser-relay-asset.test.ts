import { describe, expect, it } from "bun:test";
import * as path from "node:path";

/**
 * The embedded extension asset is generated from `packages/browser-relay/
 * extension/background.ts` by `scripts/build-extension.ts` and committed.
 * Bundling the same entry with the same bundler (from the package root, as
 * the script pins its cwd) must reproduce it byte for byte: a stale asset
 * would ship an extension that does not match the relay it is installed by.
 */
const relayPackage = path.resolve(import.meta.dir, "../../../browser-relay");
const asset = path.resolve(import.meta.dir, "../../src/tools/browser/relay/extension-assets/background.js.txt");

describe("browser relay extension asset", () => {
	it("is the bundle of the extension source", async () => {
		const build = Bun.spawn(
			[process.execPath, "build", "extension/background.ts", "--target=browser", "--sourcemap=none"],
			{ cwd: relayPackage, stdout: "pipe", stderr: "pipe" },
		);
		const [bundle, stderr, exitCode] = await Promise.all([
			new Response(build.stdout).text(),
			new Response(build.stderr).text(),
			build.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(bundle).toBe(await Bun.file(asset).text());
	});
});
