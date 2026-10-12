/**
 * HTTP + WebSocket server for the browser relay.
 *
 * Impersonates Chrome's CDP discovery endpoint so the omp browser tool (and
 * any puppeteer client) can connect with a plain `browserURL`:
 * - `GET /json/version` → 200 with `webSocketDebuggerUrl` once the bound extension said hello (plus
 *   `OMP-Relay-Protocol`, `OMP-Profile-Binding`, `OMP-Profile-Fingerprint`, `OMP-Browser-Generation`), 503 with a
 *   {@link RelayUnavailableInfo} body before that (`waitForRelayExtension` decides from it whether polling is
 *   worthwhile). Both name this server's `ompRelayInstance`, which tells a restarted relay apart.
 * - `GET /omp/binding` → profile-binding diagnostics for the pinning tool (the connected install id is exposed
 *   only while unbound).
 * - `GET /json` / `/json/list` → attachable page targets (debugging aid).
 * - `WS /cdp` → downstream CDP clients (puppeteer); an omp tab worker adds `?claim=<targetId>` for the tab it drives.
 * - `WS /ext` → extension links of other browsers, forwarded by their own native hosts (`native-host.ts`); the
 *   browser whose host runs this server links in-process through {@link RelayServer.bridge}.
 * - `POST /omp/extensions/recheck`, `POST /omp/relay/restart` → install-sync and upgrade hooks for the omp CLI.
 *
 * Binds loopback only: anything that can reach this port can drive the
 * user's logged-in browser. Same-OS-user tampering with the binding file or
 * `/omp/binding` is outside that claim.
 */
import { macOSFrontApp } from "@oh-my-pi/pi-natives";
import { parseFlag } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { type ProfileBindingInfo, RelayBridge, type RelayUnavailableReason } from "./bridge";
import { extensionIdForPath, installedRelayExtensionStamp } from "./extension-files";
import { readRelayInstalls, registeredRelayExtensionIds, syncRelayInstalls } from "./installs";
import { RELAY_PROTOCOL_VERSION, RELAY_RECHECK_PATH, RELAY_RESTART_PATH } from "./protocol";

/** Options for {@link startRelayServer}. */
export interface RelayServerOptions {
	/** Port to listen on; 0 picks a free one (see {@link RelayServer.port}). */
	port: number;
	/** Accept the browser only over its chat native messaging port. */
	chatOnly?: boolean;
	/**
	 * A `POST /omp/relay/restart` from omp `version`; `idleOnly` asks only when no CDP client is connected. Returns
	 * whether the server is going away; absent, every restart is refused.
	 */
	onRestart?(request: { version: string; idleOnly: boolean }): boolean;
	/** Group tabs the agent actively drives under one per-window Chrome tab group (default on); `false` disables. */
	group?: boolean | { title: string; color: string };
	/** Override the shared extension install registry, for isolated relays. */
	installRegistryFile?: string;
	/**
	 * Binding file naming the one extension install this relay serves; default `~/.omp/browser-relay/binding.json`,
	 * `null` disables the binding. Ignored with `chatOnly`: a side-panel relay is never pinned.
	 */
	bindingPath?: string | null;
	log?: (message: string, data?: Record<string, unknown>) => void;
}

/** `chrome-extension://<id>` → `<id>`; anything else → undefined. */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;

/** Body of the 503 `/json/version` answer while the relay is not ready. */
export interface RelayUnavailableInfo {
	/** Version of the OMP binary serving this relay. */
	ompRelayVersion: string;
	/** Random id of this server, fixed for its life. */
	ompRelayInstance: string;
	error: string;
	/** Downstream CDP clients connected to this relay. */
	ompRelayCdpClients: number;
	/** Protocol this relay speaks; relays without the field (stock/legacy builds) are protocol 1. */
	relayProtocol: number;
	/** Why readiness is missing; absent when no browser has connected. */
	reason?: RelayUnavailableReason;
	profileBinding: ProfileBindingInfo;
	/** With `reason: "profile-mismatch"`: the bound install was connected earlier in this server's lifetime, so it may revive. */
	boundSeen?: boolean;
}

/** A running relay server. */
export interface RelayServer {
	bridge: RelayBridge;
	port: number;
	stop(): void;
}

interface SocketData {
	role: "cdp" | "ext";
	connId?: number;
	/** The Chrome extension id an `ext` upgrade's `Origin` named. */
	extensionId?: string;
	/** The target a connecting omp tab worker drives (`/cdp?claim=`). */
	claim?: string;
}

type RelayWebSocket = Bun.ServerWebSocket<SocketData>;

const WS_KEEPALIVE_MS = 30_000;
/** Screenshots travel base64-encoded through both websocket legs. */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
/** Default appearance of the omp tab group. */
const DEFAULT_GROUP = { title: "omp", color: "cyan" } as const;
/** True when `raw` can serve as the authority of a `ws://` URL: no whitespace,
 *  slashes, userinfo, fragments, or control characters, and URL-parseable. */
function isWsAuthority(raw: string): boolean {
	if (/[\s/\\@#?]|[\x00-\x1f]/.test(raw)) return false;
	try {
		return new URL(`ws://${raw}`).host.length > 0;
	} catch {
		return false;
	}
}

/** Start the relay server on 127.0.0.1. Throws if the port is taken. */
export function startRelayServer(opts: RelayServerOptions): RelayServer {
	const log = opts.log ?? (() => {});
	const group =
		opts.group === false ? null : opts.group === true || opts.group === undefined ? DEFAULT_GROUP : opts.group;
	const bridge = new RelayBridge({
		log,
		group,
		// A chat-only relay serves the user's own side panel, not an agent-driven profile: nothing to pin.
		bindingPath: opts.chatOnly ? null : opts.bindingPath,
		async installedStamp(extensionId) {
			if (opts.chatOnly) return null;
			const installs = await readRelayInstalls({
				registryFile: opts.installRegistryFile,
			});
			const install = installs.find(row => !row.missing && extensionIdForPath(row.dir) === extensionId);
			return install ? installedRelayExtensionStamp(install.dir) : null;
		},
		async updateExtension(extensionId) {
			if (opts.chatOnly) return false;
			// Only a folder omp manages can be rewritten; Chrome named it by its path, so its id says which.
			const ours = await registeredRelayExtensionIds({
				registryFile: opts.installRegistryFile,
			});
			if (!ours.includes(extensionId)) {
				log("connected extension is not a registered install; not updating it", { extensionId });
				return false;
			}
			const results = await syncRelayInstalls({
				mode: "relay",
				registryFile: opts.installRegistryFile,
			});
			let current = false;
			let failed = false;
			for (const result of results) {
				if (result.status === "failed") {
					failed = true;
					log("extension install sync failed", result);
				} else if (result.status !== "missing" && result.ompVersion === VERSION) {
					current = true;
				}
			}
			return current && !failed;
		},
	});
	const sockets = new Set<RelayWebSocket>();
	const instance = crypto.randomUUID();
	// Only macOS can hand the front app back; elsewhere the relay never reads it.
	if (process.platform === "darwin" && parseFlag(process.env.PI_BROWSER_RELAY_KEEP_FRONT, true)) {
		bridge.keepFrontAppWith(macOSFrontApp);
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: opts.port,
		fetch(req, srv): Response | undefined {
			const fallback = `127.0.0.1:${srv.port}`;
			const rawHost = req.headers.get("host")?.trim();
			const host = rawHost && isWsAuthority(rawHost) ? rawHost : fallback;
			const requestUrl =
				rawHost && rawHost !== host && req.url.startsWith(`http://${rawHost}`)
					? req.url.slice(`http://${rawHost}`.length)
					: req.url;
			const url = new URL(requestUrl, `http://${fallback}`);
			const path = url.pathname.replace(/\/+$/, "") || "/";
			if (path === "/cdp") {
				// Browsers set Origin on websocket upgrades; native CDP clients
				// don't. Reject any Origin so a web page can't drive the relay.
				if (req.headers.get("origin")) return new Response("Forbidden", { status: 403 });
				const data: SocketData = {
					role: "cdp",
					claim: url.searchParams.get("claim") ?? undefined,
				};
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("websocket upgrade required", { status: 426 });
			}
			if (path === "/ext" && !opts.chatOnly) {
				const origin = req.headers.get("origin");
				if (origin && !origin.startsWith("chrome-extension://")) {
					return new Response("Forbidden", { status: 403 });
				}
				const data: SocketData = {
					role: "ext",
					extensionId: origin?.match(EXTENSION_ORIGIN)?.[1],
				};
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("websocket upgrade required", { status: 426 });
			}
			if (path === RELAY_RECHECK_PATH) {
				if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
				// Like `/cdp`: browsers send Origin, the omp CLI does not; a web page must not trigger reloads.
				if (req.headers.get("origin")) return new Response("Forbidden", { status: 403 });
				bridge.recheckExtensions();
				return new Response(null, { status: 204 });
			}
			if (path === RELAY_RESTART_PATH) {
				if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
				if (req.headers.get("origin")) return new Response("Forbidden", { status: 403 });
				const restarting =
					opts.onRestart?.({
						version: url.searchParams.get("version") ?? "",
						idleOnly: url.searchParams.get("idle") === "1",
					}) ?? false;
				return new Response(null, { status: restarting ? 202 : 409 });
			}
			if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
			if (path === "/json/version") {
				bridge.refreshBinding();
				if (!bridge.ready) {
					const info: RelayUnavailableInfo = {
						ompRelayVersion: VERSION,
						ompRelayInstance: instance,
						...bridge.unavailable(),
						ompRelayCdpClients: bridge.cdpClientCount,
						relayProtocol: RELAY_PROTOCOL_VERSION,
					};
					return Response.json(info, { status: 503 });
				}
				return Response.json({
					...bridge.versionInfo(`ws://${host}/cdp`),
					ompRelayInstance: instance,
				});
			}
			if (path === "/omp/binding") {
				bridge.refreshBinding();
				return Response.json(bridge.bindingInfo());
			}
			if (path === "/json" || path === "/json/list") {
				return Response.json(bridge.listTargets());
			}
			return new Response("Not found", { status: 404 });
		},
		websocket: {
			maxPayloadLength: MAX_PAYLOAD_BYTES,
			// Disabled: Bun caps idleTimeout at 255s, and the keepalive pings
			// below already detect dead peers via the websocket close path.
			idleTimeout: 0,
			open(ws: RelayWebSocket): void {
				sockets.add(ws);
				if (ws.data.role === "ext") {
					bridge.extConnected(ws, ws.data.extensionId);
				} else {
					ws.data.connId = bridge.cdpConnected(ws, ws.data.claim);
				}
			},
			message(ws: RelayWebSocket, message: string | Buffer): void {
				const text = typeof message === "string" ? message : new TextDecoder().decode(message);
				if (ws.data.role === "ext") {
					bridge.extMessage(ws, text);
				} else if (ws.data.connId !== undefined) {
					bridge.cdpMessage(ws.data.connId, text);
				}
			},
			close(ws: RelayWebSocket): void {
				sockets.delete(ws);
				if (ws.data.role === "ext") {
					bridge.extClosed(ws);
				} else if (ws.data.connId !== undefined) {
					bridge.cdpClosed(ws.data.connId);
				}
			},
		},
	});

	// Puppeteer connections go silent while the agent is idle; protocol-level
	// pings count as activity and keep them under the idle timeout.
	const keepalive = setInterval(() => {
		for (const ws of sockets) ws.ping();
	}, WS_KEEPALIVE_MS);
	keepalive.unref();

	const port = server.port ?? opts.port;
	log("relay listening", { port });
	return {
		bridge,
		port,
		stop() {
			clearInterval(keepalive);
			server.stop(true);
		},
	};
}
