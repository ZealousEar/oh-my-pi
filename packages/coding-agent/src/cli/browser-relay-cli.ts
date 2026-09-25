/**
 * `omp browser-relay` implementation: serve the local CDP relay and install
 * its Chrome extension. Standalone CLI command — console output here is
 * intentional user-facing output.
 */
import * as path from "node:path";
import { getBrowserRelayDir } from "@oh-my-pi/pi-utils";
import { probeCdpResponse } from "../tools/browser/attach";
import { defaultRelayBindingPath } from "../tools/browser/relay/binding";
import { RELAY_DAEMON_NAME } from "../tools/browser/relay/daemon";
import backgroundJs from "../tools/browser/relay/extension-assets/background.js.txt" with { type: "text" };
import licenseText from "../tools/browser/relay/extension-assets/LICENSE.txt" with { type: "text" };
import manifestJson from "../tools/browser/relay/extension-assets/manifest.json.txt" with { type: "text" };
import optionsHtml from "../tools/browser/relay/extension-assets/options.html.txt" with { type: "text" };
import optionsJs from "../tools/browser/relay/extension-assets/options.js.txt" with { type: "text" };
import thirdPartyNotices from "../tools/browser/relay/extension-assets/THIRD-PARTY-NOTICES.txt" with { type: "text" };
import { DEFAULT_RELAY_URL } from "../tools/browser/relay/kind";
import { relayProtocolOf } from "../tools/browser/relay/probe";
import { RELAY_PROTOCOL_VERSION } from "../tools/browser/relay/protocol";
import { type RelayServer, startRelayServer } from "../tools/browser/relay/server";

export const BROWSER_RELAY_ACTIONS = ["serve", "install"] as const;
export type BrowserRelayAction = (typeof BROWSER_RELAY_ACTIONS)[number];

export interface BrowserRelayCommandArgs {
	action: BrowserRelayAction;
	port: number;
	token?: string;
	/** Install target directory; defaults to the canonical ~/.omp/browser-relay/extension. */
	dir?: string;
	/** Gather tabs the agent actively drives into an 'omp' Chrome tab group (default true). */
	group?: boolean;
	/** Keep retrying the bind while an older/foreign relay owns the port (launchd KeepAlive jobs). */
	supervised?: boolean;
	verbose?: boolean;
}

const EXTENSION_FILES: Record<string, string> = {
	"background.js": backgroundJs,
	LICENSE: licenseText,
	"manifest.json": manifestJson,
	"options.html": optionsHtml,
	"options.js": optionsJs,
	"THIRD-PARTY-NOTICES.txt": thirdPartyNotices,
};

/** Default port of the relay endpoint (kept in sync with DEFAULT_RELAY_URL). */
export const DEFAULT_RELAY_PORT = Number(new URL(DEFAULT_RELAY_URL).port);
/** Supervised serve: how long to wait between bind attempts while a foreign relay owns the port. */
const SUPERVISED_RETRY_MS = 2_000;
const PROBE_TIMEOUT_MS = 1_500;

/** Canonical unpacked-extension directory (profile-independent; Chrome derives the extension id from it). */
export function canonicalExtensionDir(): string {
	return path.join(getBrowserRelayDir(), "extension");
}

export async function runBrowserRelayCommand(args: BrowserRelayCommandArgs): Promise<void> {
	if (args.action === "install") {
		await runInstall(args.dir);
		return;
	}
	await runServe(args);
}

async function runInstall(dirOverride: string | undefined): Promise<void> {
	const canonical = canonicalExtensionDir();
	const dir = dirOverride ? path.resolve(dirOverride) : canonical;
	try {
		for (const name in EXTENSION_FILES) {
			await Bun.write(path.join(dir, name), EXTENSION_FILES[name]!);
		}
	} catch (err) {
		if (dir === canonical && isLockedDirError(err)) {
			console.error(
				`canonical extension dir ${canonical} is locked (chflags uchg); use omp-relay-share install to replace it atomically.`,
			);
			process.exit(1);
		}
		throw err;
	}
	console.log(`Installed the OMP Browser Relay extension to ${dir}`);
	if (dir !== canonical) {
		console.log(`  (canonical location shared by every omp profile: ${canonical})`);
	}
	console.log("");
	console.log("Finish setup in Chrome:");
	console.log("  1. Open chrome://extensions and enable Developer mode.");
	console.log(`  2. Click "Load unpacked" and select: ${dir}`);
	console.log("     (already loaded from this path? click its reload button instead — the id must not change)");
	console.log("  3. Enable the mode:  omp config set browser.relay true");
	console.log(
		`  4. Bind the relay to this Chrome profile once it connects (binding file: ${defaultRelayBindingPath()}).`,
	);
	console.log("");
	console.log("omp starts the relay automatically when the browser prelude needs it;");
	console.log("run `omp browser-relay` yourself only for --token or --no-group.");
	console.log("The extension badge shows 'on' once it reaches a relay.");
}

/** Result of one {@link bindRelayPort} call. */
export type RelayBindOutcome =
	/** This process owns the port. */
	| { kind: "bound"; relay: RelayServer }
	/** A relay speaking the same or a newer protocol already owns the port: nothing to do. */
	| { kind: "already-running"; protocol: number }
	/** The port is owned by an older omp relay (`protocol` 1) or something that is not a relay (`protocol` null). */
	| { kind: "foreign"; protocol: number | null };

export interface BindRelayPortOptions {
	token?: string;
	group?: boolean;
	bindingPath?: string;
	log?: (message: string, data?: Record<string, unknown>) => void;
	/** Retry the bind until it succeeds instead of reporting who owns the port. */
	supervised?: boolean;
	/** Supervised: called once per wait with the current owner's protocol (null = not a relay) before the first retry. */
	onOccupied?: (protocol: number | null) => void;
	/** Milliseconds between supervised retries. */
	retryMs?: number;
	/** Supervised: stop waiting and report the current owner. */
	signal?: AbortSignal;
}

/**
 * Bind the relay port, classifying whoever already owns it. The port is
 * machine-global while relays can be started by any project's broker, any
 * launchd job, or by hand: losing the bind to a same-or-newer relay is
 * success; losing it to an older/foreign owner is a diagnosis. A supervised
 * serve (launchd KeepAlive) instead waits for ANY owner to exit — exiting 0
 * would just make launchd respawn it in a loop — and takes the port over the
 * moment it does.
 */
export async function bindRelayPort(port: number, opts: BindRelayPortOptions = {}): Promise<RelayBindOutcome> {
	let announced = false;
	for (;;) {
		try {
			const relay = startRelayServer({
				port,
				token: opts.token,
				group: opts.group !== false,
				bindingPath: opts.bindingPath,
				log: opts.log,
			});
			return { kind: "bound", relay };
		} catch (err) {
			if (!(err instanceof Error && "code" in err && err.code === "EADDRINUSE")) throw err;
		}
		const protocol = relayProtocolOf(
			await probeCdpResponse(`http://127.0.0.1:${port}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS }),
		);
		const current = protocol !== null && protocol >= RELAY_PROTOCOL_VERSION;
		if (!opts.supervised) return current ? { kind: "already-running", protocol } : { kind: "foreign", protocol };
		if (!announced) {
			announced = true;
			opts.onOccupied?.(protocol);
		}
		if (opts.signal?.aborted) return current ? { kind: "already-running", protocol } : { kind: "foreign", protocol };
		await Bun.sleep(opts.retryMs ?? SUPERVISED_RETRY_MS);
	}
}

function describeForeign(port: number, protocol: number | null): string {
	if (protocol === null) return `Port ${port} is in use by something that is not an omp browser relay.`;
	return `port ${port} is owned by an older/foreign omp browser relay (protocol ${protocol}): stop it with \`omp ps --global browser-relay stop ${RELAY_DAEMON_NAME}\` (a --supervised serve takes the port over when it exits).`;
}

/** EPERM/EACCES from writing into a `chflags uchg` (or otherwise read-only) directory. */
function isLockedDirError(err: unknown): boolean {
	return err instanceof Error && "code" in err && (err.code === "EPERM" || err.code === "EACCES");
}

async function runServe(args: BrowserRelayCommandArgs): Promise<void> {
	const log = args.verbose
		? (message: string, data?: Record<string, unknown>) => {
				console.error(`[relay] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);
			}
		: undefined;
	// While waiting for the port (supervised), a signal just ends the wait.
	const controller = new AbortController();
	const abortWait = () => controller.abort();
	process.once("SIGINT", abortWait);
	process.once("SIGTERM", abortWait);
	const outcome = await bindRelayPort(args.port, {
		token: args.token,
		group: args.group,
		log,
		supervised: args.supervised === true,
		signal: controller.signal,
		onOccupied: protocol => {
			const owner =
				protocol !== null && protocol >= RELAY_PROTOCOL_VERSION
					? `port ${args.port} is owned by another omp browser relay (protocol ${protocol}).`
					: describeForeign(args.port, protocol);
			console.error(`${owner} Retrying every ${SUPERVISED_RETRY_MS / 1000}s until it exits.`);
		},
	});
	process.off("SIGINT", abortWait);
	process.off("SIGTERM", abortWait);
	if (controller.signal.aborted) process.exit(0);
	if (outcome.kind === "already-running") {
		console.log(
			`omp browser relay already running on http://127.0.0.1:${args.port} (protocol ${outcome.protocol}); nothing to do.`,
		);
		return;
	}
	if (outcome.kind === "foreign") {
		console.error(describeForeign(args.port, outcome.protocol));
		process.exit(1);
	}
	const relay = outcome.relay;
	const shutdown = () => {
		relay.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	console.log(`omp browser relay listening on http://127.0.0.1:${args.port}`);
	console.log(`  protocol            ${RELAY_PROTOCOL_VERSION}`);
	console.log(`  extension endpoint  ws://127.0.0.1:${args.port}/ext${args.token ? "?token=***" : ""}`);
	console.log(`  profile binding     ${defaultRelayBindingPath()}`);
	if (args.port === DEFAULT_RELAY_PORT) {
		console.log("  enable with         omp config set browser.relay true");
	} else {
		console.log(
			`  enable with         omp config set browser.relay true && omp config set browser.relayUrl http://127.0.0.1:${args.port}`,
		);
	}
	console.log("Waiting for the OMP Browser Relay extension to connect (omp browser-relay install)...");

	let announced = false;
	// Lives until process.exit in `shutdown`.
	setInterval(() => {
		relay.bridge.refreshBinding();
		if (relay.bridge.ready && !announced) {
			announced = true;
			console.log("Extension connected. The omp browser prelude can now drive your tabs.");
		} else if (!relay.bridge.ready && announced) {
			announced = false;
			console.log("Extension disconnected or unbound; waiting for it to reconnect...");
		}
	}, 500);
	// Serve runs until SIGINT/SIGTERM; keep the process alive.
	await new Promise<never>(() => {});
}
