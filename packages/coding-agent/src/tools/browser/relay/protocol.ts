/**
 * Wire protocol between the relay server and the Chrome extension.
 *
 * The extension dials out to `ws://127.0.0.1:<port>/ext` and exchanges JSON
 * messages. The relay drives the extension with numbered RPCs; the extension
 * pushes tab lifecycle and `chrome.debugger` events as they happen.
 *
 * Tab identity: every tab the relay CREATES carries an extension-minted per-tab UUID (`ompMarker`, kept in
 * `chrome.storage.session` so it dies with the Chrome run, exactly like tab ids). Markers — never the group title —
 * identify OMP-owned tabs and the one OMP group per window. A user dragging a marked tab out of its group is a
 * persistent opt-out (`chrome.storage.local`, keyed by marker) that survives relay restarts.
 *
 * Protocol identity: the relay speaks one integer protocol version, {@link RELAY_PROTOCOL_VERSION}, advertised as
 * `OMP-Relay-Protocol` / `relayProtocol` on `/json/version` and in `Browser.getVersion.revision`. A relay whose
 * answers carry no protocol field (stock 18.2.6 and legacy 18.1.10 builds) is protocol 1; relay consumers may
 * refuse relays older than the protocol they require.
 *
 * Profile identity: one relay URL is not one Chrome cookie jar — the same unpacked extension loaded in another
 * Chrome profile dials the same relay. Every extension install therefore has a durable `instanceId`
 * (`chrome.storage.local`, per install per Chrome profile, verified readable before the first hello) that it reports
 * in `hello`; the relay only becomes ready for the install recorded in its binding file
 * (`~/.omp/browser-relay/binding.json`, read on every hello) and closes any other install with
 * {@link RELAY_CLOSE_PROFILE_MISMATCH}. Same-OS-user tampering (rewriting the binding file or the extension's
 * storage) is outside this protection; it is a profile selector, not a sandbox.
 */

/** Protocol version this relay speaks (advertised as `OMP-Relay-Protocol` / `relayProtocol`). */
export const RELAY_PROTOCOL_VERSION = 2;

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
	/** Chrome discarded this tab; it reloads when activated. */
	discarded: boolean;
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
	/** `clearForeignFrames`: the tab is one omp drives, so another extension's frames may be emptied past a refusal. */
	| { op: "attach"; tabId: number; clearForeignFrames?: boolean }
	| { op: "detach"; tabId: number }
	| {
			op: "send";
			tabId: number;
			sessionId?: string;
			method: string;
			params?: Record<string, unknown>;
			clearForeignFrames?: boolean;
	  }
	/** `active: false` opens the tab without selecting it (CDP `Target.createTarget` `background`); absent keeps Chrome's default (selected). The created tab is marked. */
	| { op: "createTab"; url: string; active?: boolean }
	| { op: "removeTab"; tabId: number }
	| { op: "activateTab"; tabId: number }
	/**
	 * Add tabs to the window's single OMP group (found through marked members
	 * or the stored group id, never by title; duplicates are merged). Marked
	 * tabs that opted out and pinned tabs are skipped.
	 */
	| { op: "group"; tabIds: number[]; title: string; color: string }
	/** Return adopted (unmarked) tabs to their pre-omp group (or ungroup); no-op for tabs the relay never grouped. */
	| { op: "ungroup"; tabIds: number[] }
	/**
	 * Where Chrome saved the download a driven page reported as `guid` (`Page.downloadWillBegin`), as a
	 * {@link FoundDownload}.
	 */
	| { op: "findDownload"; guid: string }
	/**
	 * Page overlay lifecycle for a tab a CDP client claims ({@link OVERLAY_PROTOCOL_VERSION}). `mount` injects the
	 * overlay host once, before the driver's first input, so later drawing never adds or removes page nodes; `hide`
	 * resolves only after the overlay is invisible on screen (sent before a capture), `show` restores it; `unmount`
	 * removes it when the last claim goes.
	 */
	| { op: "overlay"; tabId: number; action: OverlayAction };

/**
 * Where omp releases a cancelled mouse press, on both axes (`interactions.ts`): off the page, at a point no real
 * pointer reports, so page code and the relay can tell it apart. The relay draws no overlay input there.
 */
export const CANCELLED_RELEASE_POINT = -7919;

/** What a relay `overlay` RPC asks of a tab's page overlay. */
export type OverlayAction = "mount" | "unmount" | "hide" | "show";

/**
 * Input a claiming CDP client dispatched to a tab's root session and Chrome acknowledged, for the overlay to draw.
 * `x`/`y` are main-viewport CSS pixels, exactly as sent to `Input.dispatchMouseEvent`; `key` carries none.
 */
export type OverlayInput =
	| { kind: "move" | "release" | "wheel"; x: number; y: number }
	| {
			kind: "press";
			x: number;
			y: number;
			button: "left" | "middle" | "right" | "back" | "forward" | "none";
			clickCount: number;
	  }
	| { kind: "key" };

/** Side-panel requests the extension forwards to the relay ({@link PANEL_PROTOCOL_VERSION}). */
export type PanelCall =
	/** Live local omp sessions published to the collab registry, as {@link PanelCollabHost}s. */
	| { op: "collabHosts" }
	/** A full-control browser link for the host with `instanceId`, as `{ url: string }`. */
	| { op: "collabLink"; instanceId: string }
	/** Registered extension install folders, as {@link PanelInstall}s. */
	| { op: "installs" };

/** One registered extension install folder as the relay's omp sees it. */
export interface PanelInstall {
	dir: string;
	/** omp version last written there; null when never written by a registry-aware omp. */
	version: string | null;
	/** The folder no longer exists or has no manifest. */
	missing: boolean;
}

/** One local omp session a panel can attach to; the relay's view of a collab registry entry, without links. */
export interface PanelCollabHost {
	instanceId: string;
	generation: number;
	pid: number;
	sessionId: string;
	sessionName: string | null;
	cwd: string;
	model: { provider: string; id: string } | null;
	startedAt: number;
	busy: boolean | null;
	inputRequired: boolean;
	access: "view" | "control";
}

/** Hello capability of an extension that draws the page overlay and answers `overlay` RPCs. */
export const OVERLAY_PROTOCOL_VERSION = 1;

/**
 * Tag name of the page overlay's host element, the only node the overlay ever adds to a page (everything else lives
 * in its closed shadow root). A click's delivery check ignores mutations of this element.
 */
export const OVERLAY_HOST_TAG = "omp-overlay";

/** Hello capability of an extension whose side panel sends {@link PanelCall}s. */
export const PANEL_PROTOCOL_VERSION = 1;

/** The extension's answer to `findDownload`: null when it paired no Chrome download with that report. */
export type FoundDownload = {
	filename: string;
	state: "in_progress" | "interrupted" | "complete";
} | null;

/** Reply to the `group` RPC. */
export interface GroupRpcResult {
	/** tabId → groupId for every tab that ended up grouped. */
	grouped: Record<string, number>;
}

/**
 * Messages sent relay → extension. `reload` asks the extension to run `chrome.runtime.reload()`, which
 * re-reads its files from disk; the relay sends it only after rewriting them (extension self-update).
 */
export type RelayToExtMessage =
	| ({ t: "rpc"; id: number } & RelayRpcRequest)
	| { t: "reload" }
	/** Acknowledged input for a tab whose overlay is mounted; fire-and-forget, never delays the driver. */
	| { t: "input"; tabId: number; input: OverlayInput }
	/** The relay's answer to an extension `call`. */
	| {
			t: "callResult";
			id: number;
			ok: boolean;
			result?: unknown;
			error?: string;
	  };

/** Required capability for safe relay target discovery and auto-attach. */
export const DISCARDED_TABS_PROTOCOL_VERSION = 1;

/** Hello capability of an extension that reloads itself on a relay `reload` message. */
export const EXTENSION_RELOAD_PROTOCOL_VERSION = 1;

/** Chrome's refusal of a debugger request while another extension's frame (a password manager's menu) is in the tab. */
export const FOREIGN_FRAME_REFUSAL = /chrome-extension:\/\/ URL of different extension/i;

/** Another extension's frame the relay extension emptied and hid in a tab omp drives, so Chrome lets omp attach. */
export interface HiddenFrame {
	/** The id in the frame's `chrome-extension://<id>/` URL. */
	extensionId: string;
	/** The page the frame showed: its URL's path, without the query or fragment, which may carry tokens. */
	path: string;
	/** That page's own `<title>`, as the other extension wrote it, cut short. */
	title?: string;
}

/** Whether `value`, read off a socket, is a well-formed `HiddenFrame`. */
export function isHiddenFrame(value: unknown): value is HiddenFrame {
	return (
		typeof value === "object" &&
		value !== null &&
		"extensionId" in value &&
		typeof value.extensionId === "string" &&
		"path" in value &&
		typeof value.path === "string" &&
		(!("title" in value) || value.title === undefined || typeof value.title === "string")
	);
}

/** Hello capability of an extension that answers `findDownload`, advertised only while the browser exposes the `downloads` API. */
export const DOWNLOADS_PROTOCOL_VERSION = 1;
/**
 * Whether a relay or extension reported a well-formed omp release version.
 * Stricter than `Bun.semver.order`, which ranks strings with trailing text;
 * peers supply these and results quote them.
 */
export function isOmpVersion(version: string): boolean {
	return /^(?=.{5,64}$)\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(version);
}

/**
 * Whether a reported omp version is provably older than `than`: unreported ("")
 * is older than anything reported; otherwise both must be omp versions, since
 * anything else has no known age.
 */
export function isOlderOmpVersion(version: string, than: string): boolean {
	if (version === "") return than !== "";
	return isOmpVersion(version) && isOmpVersion(than) && Bun.semver.order(version, than) < 0;
}

/**
 * The extension's service worker script with `ompVersion` and `build` declared above it as `OMP_INSTALL_VERSION` and
 * `OMP_INSTALL_BUILD`, which the extension reports in its hello. The stamp sits in the script, not only the manifest,
 * because after the files change a Chrome restart re-reads manifest.json but keeps running the service worker it
 * registered before. `build` names the exact extension files, so a relay can tell a stale running build apart from
 * its own even when both carry the same omp version (a source checkout between releases).
 */
export function stampRelayExtensionScript(script: string, ompVersion: string, build: string): string {
	return `const OMP_INSTALL_VERSION = ${JSON.stringify(ompVersion)};\nconst OMP_INSTALL_BUILD = ${JSON.stringify(build)};\n${script}`;
}

/** `POST` path on the relay after install folders change: connected extensions reload into the new files once idle. */
export const RELAY_RECHECK_PATH = "/omp/extensions/recheck";

/**
 * `POST` path on the relay asking the native host serving it to exit, so Chrome restarts it from the installed omp.
 * Query: `version` (the asking omp's), `idle=1` to restart only while no CDP client is connected.
 */
export const RELAY_RESTART_PATH = "/omp/relay/restart";

/** What an extension build declares above its `background.js` ({@link stampRelayExtensionScript}). */
export interface RelayExtensionStamp {
	ompVersion: string;
	/** Absent (null) in builds from before build stamps. */
	ompBuild: string | null;
}

/** The stamp declared at the top of an installed `background.js`, or null when the script carries none. */
export function readRelayExtensionStamp(script: string): RelayExtensionStamp | null {
	const match =
		/^const OMP_INSTALL_VERSION = ("(?:[^"\\]|\\.)*");\n(?:const OMP_INSTALL_BUILD = ("(?:[^"\\]|\\.)*");\n)?/.exec(
			script,
		);
	const [, version, build] = match ?? [];
	if (version === undefined) return null;
	const ompVersion: unknown = JSON.parse(version);
	const ompBuild: unknown = build === undefined ? null : JSON.parse(build);
	if (typeof ompVersion !== "string" || (ompBuild !== null && typeof ompBuild !== "string")) return null;
	return { ompVersion, ompBuild };
}

/** The extension's manifest text with `ompVersion` as its `version_name`, which chrome://extensions shows. */
export function stampRelayExtensionManifest(manifestJson: string, ompVersion: string): string {
	return `${JSON.stringify({ ...JSON.parse(manifestJson), version_name: ompVersion }, null, "\t")}\n`;
}

/** Messages sent extension → relay. */
export type ExtToRelayMessage =
	| {
			t: "hello";
			userAgent: string;
			browserVersion: string;
			tabs: TabSnapshot[];
			/** Tabs that already have a `chrome.debugger` attachment (relay reconciles after a service-worker restart). */
			attachedTabIds: number[];
			/** Present when snapshots include Chrome's discarded state. Absent in older extensions. */
			discardedTabsProtocol?: number;
			/**
			 * Durable per-install browser identity (`chrome.storage.local`); the relay namespaces tabs by it, keys its
			 * browser instances by it, and binds to exactly one.
			 */
			instanceId?: string;
			/**
			 * Identity of this browser run (`chrome.storage.session`), new after a browser restart, when Chrome
			 * reuses tab ids: target ids embed it, so an old target id never names a new tab. It also scopes
			 * durable relay tab records (`OMP-Browser-Generation`). Absent on older extensions.
			 */
			browserSession?: string;
			/** The omp version that installed the running script ({@link stampRelayExtensionScript}). Absent on builds without the stamp. */
			ompVersion?: string;
			/** The extension build the running script belongs to ({@link stampRelayExtensionScript}). Absent on older extensions. */
			ompBuild?: string;
			/** {@link EXTENSION_RELOAD_PROTOCOL_VERSION} when the extension reloads itself on `reload`. Absent in older extensions. */
			reloadProtocol?: number;
			/** {@link DOWNLOADS_PROTOCOL_VERSION} when the extension answers `findDownload`. Absent in older extensions, and when a degraded worker runs without the browser's `downloads` API. */
			downloadsProtocol?: number;
			/** {@link OVERLAY_PROTOCOL_VERSION} when the extension draws the page overlay. Absent in older extensions. */
			overlayProtocol?: number;
			/** {@link PANEL_PROTOCOL_VERSION} when the extension's side panel sends calls. Absent in older extensions. */
			panelProtocol?: number;
	  }
	/** A side-panel request; the relay answers with `callResult` on the same socket. */
	| { t: "call"; id: number; call: PanelCall }
	/**
	 * The extension holds work an extension reload would destroy (a panel turn, a worker-owned rpc session, a Teach
	 * recording, a GIF export) or no longer does. Sent on change and right after hello when busy; the relay defers
	 * self-update reloads while it is true and retries when it turns false.
	 */
	| { t: "busy"; busy: boolean }
	| {
			t: "cdpEvent";
			tabId: number;
			sessionId?: string;
			method: string;
			params?: Record<string, unknown>;
	  }
	| { t: "detached"; tabId: number; reason: string; relayInitiated?: boolean }
	| { t: "framesHidden"; tabId: number; frames: HiddenFrame[] }
	| { t: "tabCreated"; tab: TabSnapshot }
	| { t: "tabUpdated"; tab: TabSnapshot }
	| { t: "tabRemoved"; tabId: number }
	| {
			t: "rpcResult";
			id: number;
			ok: boolean;
			result?: unknown;
			error?: string;
	  };

/** Native messaging host name registered by `omp browser-relay install`. */
export const NATIVE_HOST = "sh.omp.browser";

/**
 * Extension → native host. The first message picks what the port is for:
 * - `open`: a chat. The host starts `omp --mode rpc` in `cwd`; then `rpc` carries its stdin lines.
 * - `link`: the browser relay. The host serves the relay for this browser (or joins the one another browser's host
 *   serves); then `relay` carries the extension's relay protocol messages ({@link ExtToRelayMessage} JSON).
 */
export type ToNativeHost =
	| { t: "open"; cwd: string; extensionId: string }
	| { t: "link"; extensionId: string }
	| { t: "rpc"; line: string }
	| { t: "relay"; line: string };

/**
 * Native host → extension. Chat ports get `ready`, `rpc` lines and a final `exit`. Link ports get `linked` once a
 * relay listens for this browser (the extension then says hello), `relay` messages ({@link RelayToExtMessage} JSON),
 * and `unlinked` when that relay went away while the host finds or becomes the next one. Lines over Chrome's 1 MiB
 * host→extension limit arrive as `chunk`s with one `id`, concatenated in `index` order up to the `last` one.
 */
export type FromNativeHost =
	| { t: "ready"; pid: number }
	| { t: "rpc"; line: string }
	| { t: "linked" }
	| { t: "unlinked"; reason: string }
	| { t: "relay"; line: string }
	| { t: "chunk"; relay?: true; id: number; index: number; last: boolean; data: string }
	| { t: "exit"; code: number | null; stderr: string };
