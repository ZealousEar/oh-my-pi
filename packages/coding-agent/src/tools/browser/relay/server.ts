/**
 * HTTP + WebSocket server for the browser relay.
 *
 * Impersonates Chrome's CDP discovery endpoint so the omp browser tool (and
 * any puppeteer client) can connect with a plain `browserURL`:
 * - `GET /json/version` → 200 with `webSocketDebuggerUrl` once the bound
 *   extension is connected (plus `OMP-Relay-Protocol`, `OMP-Profile-Binding`,
 *   `OMP-Profile-Fingerprint`, `OMP-Browser-Generation`, `OMP-Extension-Version`),
 *   503 with a {@link RelayUnavailableInfo} body before that
 *   (`waitForRelayExtension` decides from it whether polling is worthwhile).
 * - `GET /omp/binding` → profile-binding diagnostics for the pinning tool
 *   (the connected install id is exposed only while unbound).
 * - `GET /json` / `/json/list` → attachable page targets (debugging aid).
 * - `WS /cdp` → downstream CDP clients (puppeteer).
 * - `WS /ext` → the Chrome extension (token-gated when configured).
 *
 * Binds loopback only: anything that can reach this port can drive the
 * user's logged-in browser. Same-OS-user tampering with the binding file or
 * `/omp/binding` is outside that claim.
 */
import { type ProfileBindingInfo, RelayBridge, type RelayUnavailableReason } from "./bridge";
import { RELAY_PROTOCOL_VERSION } from "./protocol";

/** Options for {@link startRelayServer}. */
export interface RelayServerOptions {
	/** Port to listen on; 0 picks a free one (see {@link RelayServer.port}). */
	port: number;
	/** Shared secret the extension must present as `?token=`; unset disables the check. */
	token?: string;
	/** Group tabs the agent actively drives under one per-window Chrome tab group (default on); `false` disables. */
	group?: boolean | { title: string; color: string };
	/** Binding file naming the one extension install this relay serves; default `~/.omp/browser-relay/binding.json`. */
	bindingPath?: string;
	log?: (message: string, data?: Record<string, unknown>) => void;
}

/** Body of the 503 `/json/version` answer while the relay is not ready. */
export interface RelayUnavailableInfo {
	error: string;
	/** An extension completed the hello handshake at least once in this server's lifetime. */
	extensionSeen: boolean;
	/** Milliseconds this server has been listening. */
	uptimeMs: number;
	/** Protocol this relay speaks; relays without the field (stock/legacy builds) are protocol 1. */
	relayProtocol: number;
	/** Why readiness is missing; absent when no extension has connected. */
	reason?: RelayUnavailableReason;
	/** Present while the connected extension is older than this relay requires. */
	extensionIncompatible?: { version: string; required: string };
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
	const bridge = new RelayBridge({ log, group, bindingPath: opts.bindingPath });
	const sockets = new Set<RelayWebSocket>();
	const startedAt = Date.now();

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
				const data: SocketData = { role: "cdp" };
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("websocket upgrade required", { status: 426 });
			}
			if (path === "/ext") {
				const origin = req.headers.get("origin");
				if (origin && !origin.startsWith("chrome-extension://")) {
					return new Response("Forbidden", { status: 403 });
				}
				if (opts.token && url.searchParams.get("token") !== opts.token) {
					return new Response("Unauthorized", { status: 401 });
				}
				const data: SocketData = { role: "ext" };
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("websocket upgrade required", { status: 426 });
			}
			if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
			if (path === "/json/version") {
				bridge.refreshBinding();
				if (!bridge.ready) {
					const info: RelayUnavailableInfo = {
						...bridge.unavailable(),
						extensionSeen: bridge.extensionSeen,
						uptimeMs: Date.now() - startedAt,
						relayProtocol: RELAY_PROTOCOL_VERSION,
					};
					return Response.json(info, { status: 503 });
				}
				return Response.json(bridge.versionInfo(`ws://${host}/cdp`));
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
					bridge.extConnected(ws);
				} else {
					ws.data.connId = bridge.cdpConnected(ws);
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
