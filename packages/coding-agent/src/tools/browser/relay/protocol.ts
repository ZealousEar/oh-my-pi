/**
 * Wire protocol between the relay server and the Chrome extension.
 *
 * The extension dials out to `ws://127.0.0.1:<port>/ext` and exchanges JSON
 * messages. The relay drives the extension with numbered RPCs; the extension
 * pushes tab lifecycle and `chrome.debugger` events as they happen.
 *
 * Tab identity (extension 0.2.0): every tab the relay CREATES carries an
 * extension-minted per-tab UUID (`ompMarker`, kept in `chrome.storage.session`
 * so it dies with the Chrome run, exactly like tab ids). Markers — never the
 * group title — identify OMP-owned tabs and the one OMP group per window. A
 * user dragging a marked tab out of its group is a persistent opt-out
 * (`chrome.storage.local`, keyed by marker) that survives relay restarts.
 *
 * Protocol identity: the relay and the extension each speak one integer
 * protocol version. {@link RELAY_PROTOCOL_VERSION} is this relay's; the
 * extension's is derived from the manifest version it reports in `hello`
 * ({@link extensionProtocolOf}): 0.2.0 and later speak 2, a 0.1.0 extension
 * (or one that reports no `extensionVersion` at all) speaks 1. A relay whose
 * `/json/version` answers carry no protocol field (stock 18.2.6 and legacy
 * 18.1.10 builds) is likewise protocol 1. The relay refuses to become ready
 * for an extension older than {@link RELAY_EXTENSION_MIN_VERSION}; relay
 * consumers may refuse relays older than the protocol they require.
 *
 * Profile identity: one relay URL is not one Chrome cookie jar — the same
 * unpacked extension loaded in another Chrome profile dials the same relay.
 * Every extension install therefore mints a durable `installId`
 * (`chrome.storage.local`, per install per Chrome profile) and reports it in
 * `hello`; the relay only becomes ready for the install recorded in its
 * binding file (`~/.omp/browser-relay/binding.json`, read on every hello) and
 * closes any other install with {@link RELAY_CLOSE_PROFILE_MISMATCH}.
 * Same-OS-user tampering (rewriting the binding file or the extension's
 * storage) is outside this protection; it is a profile selector, not a
 * sandbox.
 */

/** Protocol version this relay speaks (advertised as `OMP-Relay-Protocol` / `relayProtocol`). */
export const RELAY_PROTOCOL_VERSION = 2;
/** Oldest extension manifest version this relay accepts. */
export const RELAY_EXTENSION_MIN_VERSION = "0.2.0";

const PROTOCOL_2_MIN_VERSION = [0, 2, 0] as const;

/**
 * Protocol version an extension speaks, from the manifest version it reports:
 * `>= 0.2.0` → 2; anything older, unparseable, or absent (the 0.1.0 extension
 * sent no `extensionVersion`) → 1.
 */
export function extensionProtocolOf(version: string | undefined): number {
	if (version === undefined) return 1;
	const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
	if (!match) return 1;
	const parts = [Number(match[1]), Number(match[2]), Number(match[3] ?? "0")];
	for (let i = 0; i < PROTOCOL_2_MIN_VERSION.length; i++) {
		if (parts[i]! !== PROTOCOL_2_MIN_VERSION[i]) return parts[i]! > PROTOCOL_2_MIN_VERSION[i] ? 2 : 1;
	}
	return 2;
}

/** Websocket close code the relay sends an extension whose install is not the bound one (reason `profile-mismatch`). */
export const RELAY_CLOSE_PROFILE_MISMATCH = 4403;
/** Reserved close code for an unbound relay refusing a dial (reason `profile-unbound`); the relay currently keeps unbound sockets open instead. */
export const RELAY_CLOSE_PROFILE_UNBOUND = 4401;

/** Short public identifier of an install id: sha256 hex prefix, never the id itself. */
export function installFingerprint(installId: string): string {
	return new Bun.CryptoHasher("sha256").update(installId).digest("hex").slice(0, 12);
}

/**
 * `Browser.getVersion.revision` a protocol-2 relay answers over a CDP
 * connection: `omp-relay/2;binding=<state>;fp=<fingerprint>`. Chrome's own
 * value is a source revision string, so no other CDP client is affected.
 */
export function relayRevision(bindingState: string, installId: string | undefined): string {
	return `omp-relay/${RELAY_PROTOCOL_VERSION};binding=${bindingState};fp=${installId ? installFingerprint(installId) : ""}`;
}

/** Parsed `Browser.getVersion.revision` of a relay. */
export interface RelayRevision {
	protocol: number;
	/** Binding state the relay reported (`bound` when it is ready for the install it serves). */
	binding: string;
	/** Fingerprint of the install the connection is served by; empty when none. */
	fingerprint: string;
}

/** Parse a relay revision; null when it is not one (stock/legacy relay or Chrome itself). */
export function parseRelayRevision(revision: unknown): RelayRevision | null {
	if (typeof revision !== "string") return null;
	const match = /^omp-relay\/(\d+)(?:;binding=([^;]*))?(?:;fp=([^;]*))?$/.exec(revision);
	if (!match) return null;
	return { protocol: Number(match[1]), binding: match[2] ?? "", fingerprint: match[3] ?? "" };
}

/** Minimal view of a Chrome tab shared between extension and relay. */
export interface TabSnapshot {
	tabId: number;
	url: string;
	title: string;
	active: boolean;
	windowId: number;
	/** Pinned tabs are never grouped (Chrome would silently unpin them). */
	pinned: boolean;
	/** Chrome tab group id; -1 when ungrouped. */
	groupId: number;
	/** Extension-minted UUID for a tab the relay created; absent on user tabs. */
	ompMarker?: string;
	/** The user pulled this marked tab out of the OMP group; never re-group it. */
	optOut?: boolean;
}

/** RPCs the relay may ask the extension to perform. */
export type RelayRpcRequest =
	| { op: "attach"; tabId: number }
	| { op: "detach"; tabId: number }
	| { op: "send"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	/** `active` false creates the tab in the background (CDP `Target.createTarget` `background`); omitted activates it. The created tab is marked. */
	| { op: "createTab"; url: string; active?: boolean }
	| { op: "removeTab"; tabId: number }
	| { op: "activateTab"; tabId: number }
	/**
	 * Add tabs to the window's single OMP group (found through marked members
	 * or the stored group id, never by title; duplicates are merged). Marked
	 * tabs that opted out and pinned tabs are skipped.
	 */
	| { op: "group"; tabIds: number[]; title: string; color: string }
	/** Ungroup adopted (unmarked) tabs the relay grouped; no-op for tabs it never grouped. */
	| { op: "ungroup"; tabIds: number[] };

/** Reply to the `group` RPC. */
export interface GroupRpcResult {
	/** tabId → groupId for every tab that ended up grouped. */
	grouped: Record<string, number>;
}

/** Messages sent relay → extension. */
export type RelayToExtMessage = ({ t: "rpc"; id: number } & RelayRpcRequest) | { t: "pong" };

/** Messages sent extension → relay. */
export type ExtToRelayMessage =
	| {
			t: "hello";
			userAgent: string;
			browserVersion: string;
			tabs: TabSnapshot[];
			/** Tabs that already have a `chrome.debugger` attachment (relay reconciles after a service-worker restart). */
			attachedTabIds: number[];
			/** Per-Chrome-run UUID (session storage); scopes durable relay tab records. Absent on the 0.1.0 extension. */
			generation?: string;
			/** Extension manifest version, so the relay can tell a legacy install apart. */
			extensionVersion?: string;
			/** Durable per-install UUID (`chrome.storage.local`); the relay binds to exactly one. Absent before 0.2.0. */
			installId?: string;
	  }
	| { t: "cdpEvent"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	| { t: "detached"; tabId: number; reason: string; relayInitiated?: boolean }
	| { t: "tabCreated"; tab: TabSnapshot }
	| { t: "tabUpdated"; tab: TabSnapshot }
	| { t: "tabRemoved"; tabId: number }
	| { t: "rpcResult"; id: number; ok: boolean; result?: unknown; error?: string }
	| { t: "ping" };
