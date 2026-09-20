/**
 * CDP façade over `chrome.debugger`.
 *
 * Puppeteer clients (the omp browser tool: one supervisor connection plus one
 * per tab worker) connect to this bridge as if it were Chrome's browser
 * debugging endpoint. Chrome only allows a single debugger attachment per tab,
 * so the bridge owns ONE `chrome.debugger` attachment per tab (via the
 * extension) and multiplexes every downstream connection over it with minted
 * per-connection session ids.
 *
 * Emulated surface (everything else is forwarded to `chrome.debugger`):
 * - the browser target (`/json/version` handshake, `Browser.getVersion`)
 * - the `Target.*` domain, including puppeteer's tab → page auto-attach
 *   hierarchy (see puppeteer-core `cdp/ExtensionTransport.ts`, the reference
 *   implementation for this emulation)
 *
 * Session id namespaces seen by a downstream connection:
 * - minted tab pseudo-sessions (`ST<tab>.<conn>.<n>`) — Target emulation only
 * - minted page pseudo-sessions (`SP<tab>.<conn>.<n>`) — forwarded to the
 *   tab's root debugger session
 * - real child session ids (OOPIFs, workers) — created by Chrome under the
 *   shared root session and passed through verbatim
 */
import { logger } from "@oh-my-pi/pi-utils";
import { defaultRelayBindingPath, type RelayBindingState, readRelayBinding } from "./binding";
import {
	type ExtToRelayMessage,
	extensionProtocolOf,
	installFingerprint,
	RELAY_CLOSE_PROFILE_MISMATCH,
	RELAY_EXTENSION_MIN_VERSION,
	RELAY_PROTOCOL_VERSION,
	relayRevision,
	type RelayRpcRequest,
	type RelayToExtMessage,
	type TabSnapshot,
} from "./protocol";

/** Transport-agnostic websocket surface the bridge writes to. */
export interface RelaySocket {
	send(text: string): void;
	close(code?: number, reason?: string): void;
}

/** Why the last extension hello could not make the relay ready. */
export interface IncompatibleExtension {
	version: string;
	required: string;
	/** `version`: older than {@link RELAY_EXTENSION_MIN_VERSION}; `install-id`: new enough but reported no install id. */
	reason: "version" | "install-id";
}

/** A rejected extension install (bound relay, different install). */
export interface RejectedInstall {
	fingerprint: string;
	/** ISO 8601. */
	at: string;
}

/** Binding view for `/json/version` 503 bodies and `/omp/binding`. */
export type ProfileBindingInfo =
	| { state: "unbound"; connectedFingerprint?: string }
	| { state: "bound"; boundFingerprint: string; lastRejected?: RejectedInstall }
	| { state: "invalid"; error: string };

/** Why `/json/version` answers 503 (absent: no extension has connected). */
export type RelayUnavailableReason =
	| "extension-incompatible"
	| "profile-unbound"
	| "profile-mismatch"
	| "profile-invalid";

/** Mismatch warnings are rate-limited per install id. */
const MISMATCH_LOG_INTERVAL_MS = 60_000;

function invalidBindingError(detail: string): string {
	return `relay binding file is invalid: ${detail}; fix or remove it (omp-relay-share unbind)`;
}

interface CdpCommand {
	id: number;
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
}

/**
 * Per-pseudo-session Runtime domain state.
 * - `default`: never toggled Runtime — still receives the relay's legacy
 *   root-event fan-out, so omp's own patched-puppeteer client (which
 *   pull-acquires contexts and never sends `Runtime.enable`) keeps getting
 *   `Runtime.executionContextCreated`.
 * - `enabled`: ran `Runtime.enable`; gets the existing-context replay.
 * - `disabled`: explicitly ran `Runtime.disable`; silenced until it re-enables.
 */
type RuntimeState = "default" | "enabled" | "disabled";

interface SessionRef {
	kind: "tab" | "page";
	tabId: number;
	runtimeState: RuntimeState;
	/** Context ids already announced to this pseudo-session. */
	readonly runtimeContexts: Set<number>;
	/** In-flight `Runtime.enable` for this session; duplicates await it. */
	runtimeEnabling: Promise<void> | null;
	/** Monotonic ownership token for enable rollback and replay. */
	runtimeEpoch: number;
}

interface TargetInfo {
	targetId: string;
	type: "tab" | "page" | "browser";
	title: string;
	url: string;
	attached: boolean;
	canAccessOpener: boolean;
	/** Relay extension: per-tab UUID of an OMP-created tab. Puppeteer ignores it; the supervisor's reaper reads it. */
	ompMarker?: string;
}

class CdpConnection {
	discover = false;
	autoAttach = false;
	/** Minted pseudo-sessions owned by this connection. */
	readonly sessions = new Map<string, SessionRef>();
	/** Tabs this connection claimed as drive targets (`OMP.claimTarget` / `Target.createTarget`). */
	readonly claims = new Set<number>();

	constructor(
		readonly id: number,
		readonly socket: RelaySocket,
	) {}

	sessionsForTab(tabId: number, kind?: "tab" | "page"): string[] {
		const out: string[] = [];
		for (const [sessionId, ref] of this.sessions) {
			if (ref.tabId === tabId && (!kind || ref.kind === kind)) out.push(sessionId);
		}
		return out;
	}
}

/** Transport replacement is retryable and must not permanently ban a tab. */
class ExtensionReplacedError extends Error {}

class TabState {
	url: string;
	title: string;
	active: boolean;
	windowId: number;
	pinned: boolean;
	/** Chrome tab group id from the last snapshot; -1 when ungrouped. */
	groupId: number;
	/** Whether `chrome.debugger` is currently attached to this tab. */
	attached = false;
	/** Set when attach failed or the user cancelled the debugger; cleared on navigation. */
	banned = false;
	/** Whether targets for this tab were announced to discovering connections. */
	announced = false;
	attaching: Promise<boolean> | null = null;
	/** Relay-initiated detach in flight; reattach serializes behind it. */
	detaching: Promise<void> | null = null;
	/** A successful attach completed after the most recently requested relay detach. */
	reattachedAfterDetach = false;
	/** True after the relay put this tab in the omp group; `ompGroupId` holds that group. */
	grouped = false;
	/** Group RPC in flight — suppresses duplicate requests from load-time tabUpdated bursts. */
	grouping = false;
	ompGroupId: number | undefined;
	/**
	 * User pulled the tab out of the omp group — never re-group it. For a
	 * marked (OMP-created) tab the extension persists this and reports it in
	 * every snapshot; for an adopted tab it lives here for the server lifetime.
	 */
	groupOptOut = false;
	/** Extension-minted UUID: this tab was created by the relay (OMP-owned). Absent on user tabs. */
	marker: string | undefined;
	/** Real Chrome session ids (OOPIF/worker children) living under this tab's root session. */
	readonly realSessions = new Set<string>();
	/** Live execution contexts from the shared root debugger session. */
	readonly runtimeContexts = new Map<number, Record<string, unknown>>();
	/** Whether the shared root Runtime domain has been enabled by the bridge. */
	rootRuntimeEnabled = false;
	rootRuntimeEnabling: Promise<void> | null = null;
	/** Invalidates an in-flight Runtime enable when the debugger detaches. */
	runtimeGeneration = 0;

	constructor(
		readonly tabId: number,
		snap: TabSnapshot,
	) {
		this.url = snap.url;
		this.title = snap.title;
		this.active = snap.active;
		this.windowId = snap.windowId;
		this.pinned = snap.pinned;
		this.groupId = snap.groupId;
		this.marker = snap.ompMarker;
		this.groupOptOut = snap.optOut === true;
	}

	update(snap: TabSnapshot): void {
		this.url = snap.url;
		this.title = snap.title;
		this.active = snap.active;
		this.windowId = snap.windowId;
		this.pinned = snap.pinned;
		this.groupId = snap.groupId;
		if (snap.ompMarker) this.marker = snap.ompMarker;
		// The extension's persisted opt-out is authoritative for marked tabs.
		if (snap.optOut === true) this.groupOptOut = true;
	}
}

/** URLs `chrome.debugger` cannot attach to; hidden from downstream discovery entirely. */
const INELIGIBLE_URL = /^(chrome|devtools|edge|view-source|chrome-extension|chrome-untrusted|chrome-search):/i;

const RPC_TIMEOUT_MS = 20_000;
const CDP_ERROR_METHOD_NOT_FOUND = -32601;
const CDP_ERROR_SERVER = -32000;

function tabTargetId(tabId: number): string {
	return `TAB${tabId}`;
}

function pageTargetId(tabId: number): string {
	return `PAGE${tabId}`;
}

/** Reverse of {@link tabTargetId}/{@link pageTargetId}; null for foreign ids. */
function parseTargetId(targetId: string): { kind: "tab" | "page"; tabId: number } | null {
	const match = /^(TAB|PAGE)(\d+)$/.exec(targetId);
	if (!match) return null;
	return { kind: match[1] === "TAB" ? "tab" : "page", tabId: Number(match[2]) };
}

/**
 * Multiplexing CDP bridge between downstream puppeteer connections and the
 * relay extension. One instance per relay server; all state lives here so an
 * extension service-worker restart only has to re-handshake.
 */
export class RelayBridge {
	#tabs = new Map<number, TabState>();
	#conns = new Map<number, CdpConnection>();
	#connSeq = 0;
	#sessionSeq = 0;
	#rpcSeq = 0;
	/** Extension socket whose hello was accepted (compatible, install not rejected by the binding). */
	#ext: RelaySocket | null = null;
	#extInfo: {
		userAgent: string;
		browserVersion: string;
		generation?: string;
		extensionVersion?: string;
		installId: string;
	} | null = null;
	/** Extension sockets that connected but have not (successfully) said hello; never replace {@link #ext}. */
	#candidates = new Set<RelaySocket>();
	/** Hellos of candidates ignored while unbound (a second install); replayed once {@link #ext} is free. */
	#candidateHellos = new Map<RelaySocket, Extract<ExtToRelayMessage, { t: "hello" }>>();
	#extensionSeen = false;
	/** Sticky until an accepted hello: the last hello this relay could not accept for protocol reasons. */
	#incompatibleExtension: IncompatibleExtension | null = null;
	#bindingPath: string;
	/** Binding file as of the last {@link refreshBinding}/hello. */
	#binding: RelayBindingState = { state: "unbound" };
	#lastRejected: RejectedInstall | null = null;
	/** A rejection happened after the last accepted hello: it is the 503 reason until the bound install says hello again. */
	#rejectionPending = false;
	/** The bound install completed a hello at least once in this server's lifetime. */
	#boundSeen = false;
	#mismatchLogAt = new Map<string, number>();
	#pendingRpc = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
	>();
	/** Real child session id → owning tab, learned from `Target.attachedToTarget` events. */
	#realSessionTabs = new Map<string, number>();
	#log: (message: string, data?: Record<string, unknown>) => void;
	/** Tab-group appearance for driven tabs; null disables grouping. */
	#group: { title: string; color: string } | null;
	/** Tabs awaiting the next group RPC; drained one batch at a time. */
	#groupQueue: TabState[] = [];
	/** True while {@link #drainGroupQueue} runs — group RPCs must never overlap. */
	#groupDraining = false;

	constructor(
		opts: {
			log?: (message: string, data?: Record<string, unknown>) => void;
			/** Group tabs the agent actively drives under one per-window Chrome tab group. */
			group?: { title: string; color: string } | null;
			/** Binding file naming the one extension install this relay serves; default `~/.omp/browser-relay/binding.json`. */
			bindingPath?: string;
		} = {},
	) {
		this.#log = opts.log ?? (() => {});
		this.#group = opts.group ?? null;
		this.#bindingPath = opts.bindingPath ?? defaultRelayBindingPath();
	}

	/** True once a compatible extension from the bound install has completed its hello handshake. */
	get ready(): boolean {
		return this.#ext !== null && this.#extInfo !== null && this.#bindingAccepts(this.#extInfo.installId);
	}

	/** True after the first accepted hello, and stays true: separates a reaped service worker from an absent extension. */
	get extensionSeen(): boolean {
		return this.#extensionSeen;
	}

	/** The last hello this relay refused for protocol reasons; cleared by the next accepted hello. */
	get incompatibleExtension(): IncompatibleExtension | null {
		return this.#incompatibleExtension;
	}

	/**
	 * Re-read the binding file and enforce it against the connected extension
	 * (a bind to another install while one is connected drops that one exactly
	 * like a mismatched hello). Called on every hello and readiness query so
	 * `bind`/`unbind` never need a relay restart.
	 */
	refreshBinding(): void {
		this.#binding = readRelayBinding(this.#bindingPath);
		if (
			this.#ext &&
			this.#extInfo &&
			this.#binding.state === "bound" &&
			this.#binding.binding.installId !== this.#extInfo.installId
		) {
			this.#rejectInstall(this.#ext, this.#extInfo.installId);
		}
	}

	/** Binding as seen by `/json/version` 503 bodies (fingerprints only). */
	profileBinding(): ProfileBindingInfo {
		switch (this.#binding.state) {
			case "invalid":
				return { state: "invalid", error: this.#binding.error };
			case "bound":
				return {
					state: "bound",
					boundFingerprint: installFingerprint(this.#binding.binding.installId),
					...(this.#lastRejected ? { lastRejected: this.#lastRejected } : {}),
				};
			case "unbound":
				return {
					state: "unbound",
					...(this.#ext && this.#extInfo
						? { connectedFingerprint: installFingerprint(this.#extInfo.installId) }
						: {}),
				};
		}
	}

	/**
	 * Payload for `GET /omp/binding` (loopback diagnostics for the pinning
	 * tool). The full install id is exposed only while unbound and connected —
	 * exactly what `bind --from-connected` needs.
	 */
	bindingInfo(): Record<string, unknown> {
		const info: Record<string, unknown> = { ...this.profileBinding() };
		if (this.#ext && this.#extInfo) {
			if (this.#binding.state === "unbound") info.connectedInstallId = this.#extInfo.installId;
			info.connectedFingerprint = installFingerprint(this.#extInfo.installId);
			info.connectedBrowser = { browserVersion: this.#extInfo.browserVersion, userAgent: this.#extInfo.userAgent };
		}
		if (this.#lastRejected) info.lastRejected = this.#lastRejected;
		return info;
	}

	/**
	 * Why `/json/version` answers 503 right now (call after {@link refreshBinding}).
	 * `reason` is absent when simply no extension has connected.
	 */
	unavailable(): {
		reason?: RelayUnavailableReason;
		error: string;
		extensionIncompatible?: { version: string; required: string };
		profileBinding: ProfileBindingInfo;
		/** With `profile-mismatch`: the bound install was connected earlier in this server's lifetime (it may revive). */
		boundSeen?: boolean;
	} {
		const profileBinding = this.profileBinding();
		if (this.#ext && this.#extInfo) {
			const fingerprint = installFingerprint(this.#extInfo.installId);
			if (this.#binding.state === "invalid") {
				return { reason: "profile-invalid", error: invalidBindingError(this.#binding.error), profileBinding };
			}
			return {
				reason: "profile-unbound",
				error: `relay extension from an unbound Chrome profile is connected (install ${fingerprint}); bind it with the launcher runbook (omp-relay-share bind --from-connected) or reload the approved profile's extension`,
				profileBinding,
			};
		}
		if (this.#incompatibleExtension) {
			const { version, required, reason } = this.#incompatibleExtension;
			return {
				reason: "extension-incompatible",
				error:
					reason === "version"
						? `relay extension ${version} is older than this relay requires (${required}); reinstall it (omp browser-relay install) and reload it in chrome://extensions`
						: `relay extension ${version} reported no install id; reinstall it (omp browser-relay install) and reload it in chrome://extensions`,
				extensionIncompatible: { version, required },
				profileBinding,
			};
		}
		if (this.#binding.state === "invalid") {
			return { reason: "profile-invalid", error: invalidBindingError(this.#binding.error), profileBinding };
		}
		if (this.#binding.state === "bound" && this.#lastRejected && this.#rejectionPending) {
			return {
				reason: "profile-mismatch",
				error: `relay extension install ${this.#lastRejected.fingerprint} was rejected: the relay is bound to Chrome profile install ${installFingerprint(this.#binding.binding.installId)}; rebind explicitly (omp-relay-share bind) if the approved profile changed`,
				profileBinding,
				boundSeen: this.#boundSeen,
			};
		}
		return { error: "relay extension is not connected", profileBinding };
	}

	/** Payload for `GET /json/version` (only meaningful while {@link ready}). */
	versionInfo(wsUrl: string): Record<string, string> {
		const ua = this.#extInfo?.userAgent ?? "";
		return {
			Browser: this.#extInfo?.browserVersion ?? "Chrome/unknown",
			"Protocol-Version": "1.3",
			"User-Agent": ua,
			"V8-Version": "",
			"WebKit-Version": "",
			webSocketDebuggerUrl: wsUrl,
			"OMP-Relay-Protocol": String(RELAY_PROTOCOL_VERSION),
			...(this.#extInfo?.generation ? { "OMP-Browser-Generation": this.#extInfo.generation } : {}),
			...(this.#extInfo?.extensionVersion ? { "OMP-Extension-Version": this.#extInfo.extensionVersion } : {}),
			...(this.#extInfo
				? { "OMP-Profile-Binding": "bound", "OMP-Profile-Fingerprint": installFingerprint(this.#extInfo.installId) }
				: {}),
		};
	}

	#bindingAccepts(installId: string): boolean {
		return this.#binding.state === "bound" && this.#binding.binding.installId === installId;
	}

	/** Marker of an OMP-created tab by page/tab target id; undefined for user tabs. */
	markerOf(targetId: string): string | undefined {
		const parsed = parseTargetId(targetId);
		return parsed ? this.#tabs.get(parsed.tabId)?.marker : undefined;
	}

	/** Test probe: current omp group id per tab (undefined when ungrouped). */
	groupStateForTest(): Record<number, number | undefined> {
		const out: Record<number, number | undefined> = {};
		for (const tab of this.#tabs.values()) out[tab.tabId] = tab.grouped ? tab.ompGroupId : undefined;
		return out;
	}

	/** Payload for `GET /json/list` (debugging aid; per-target endpoints are not served). */
	listTargets(): Array<Record<string, string>> {
		const out: Array<Record<string, string>> = [];
		for (const tab of this.#tabs.values()) {
			if (!this.#eligible(tab)) continue;
			out.push({ id: pageTargetId(tab.tabId), type: "page", title: tab.title, url: tab.url });
		}
		return out;
	}

	// ---- extension lifecycle -------------------------------------------------

	#rejectPendingExtensionRpcs(error: Error): void {
		for (const pending of this.#pendingRpc.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pendingRpc.clear();
	}

	/**
	 * A new extension socket connected. It is only a candidate until its hello
	 * is validated: a socket from another Chrome profile must never displace
	 * the bound extension merely by dialing in.
	 */
	extConnected(socket: RelaySocket): void {
		if (socket !== this.#ext) this.#candidates.add(socket);
	}

	extClosed(socket: RelaySocket): void {
		this.#candidates.delete(socket);
		this.#candidateHellos.delete(socket);
		if (this.#ext !== socket) return;
		this.#dropExt();
	}

	/** Forget the accepted extension socket and everything only it could vouch for. */
	#dropExt(): void {
		this.#ext = null;
		this.#extInfo = null;
		this.#rejectPendingExtensionRpcs(new Error("relay extension disconnected"));
		for (const tab of this.#tabs.values()) {
			tab.attached = false;
			tab.attaching = null;
			this.#resetRuntime(tab);
			// Grouping state is unknowable until the next hello (a 0.1.0
			// extension dissolved groups on disconnect; 0.2.0 leaves them and
			// reuses them). Without this reset, the next hello's snapshots
			// could read as the user dragging every tab out (permanent opt-out).
			tab.grouped = false;
			tab.grouping = false;
			tab.ompGroupId = undefined;
		}
		this.#groupQueue.length = 0;
		this.#promoteCandidate();
	}

	/**
	 * With no accepted socket, replay cached hellos of still-open candidates
	 * (installs ignored while unbound), newest first, until one is accepted.
	 * An extension never re-hellos on an open socket, so without this a
	 * `bind` to a waiting install (or the first install disconnecting) would
	 * leave the relay not-ready until Chrome reaped that install's worker.
	 */
	#promoteCandidate(): void {
		while (!this.#ext) {
			const last = Array.from(this.#candidateHellos.entries()).at(-1);
			if (!last) return;
			const [socket, msg] = last;
			this.#candidateHellos.delete(socket);
			// A replay that is itself rejected (bound to a third install) closes
			// that socket and leaves #ext free, so the loop tries the next one.
			this.#onHello(socket, msg);
		}
	}

	extMessage(socket: RelaySocket, raw: string): void {
		const accepted = socket === this.#ext;
		if (!accepted && !this.#candidates.has(socket)) return;
		let msg: ExtToRelayMessage;
		try {
			msg = JSON.parse(raw) as ExtToRelayMessage;
		} catch {
			this.#log("dropping malformed extension message");
			return;
		}
		if (msg.t === "hello") {
			this.#onHello(socket, msg);
			return;
		}
		if (msg.t === "ping") {
			socket.send(JSON.stringify({ t: "pong" } satisfies RelayToExtMessage));
			return;
		}
		// Only the accepted extension drives tab state.
		if (!accepted) return;
		switch (msg.t) {
			case "rpcResult": {
				const pending = this.#pendingRpc.get(msg.id);
				if (!pending) return;
				this.#pendingRpc.delete(msg.id);
				clearTimeout(pending.timer);
				if (msg.ok) pending.resolve(msg.result);
				else pending.reject(new Error(msg.error ?? "extension rpc failed"));
				return;
			}
			case "cdpEvent":
				this.#onCdpEvent(msg.tabId, msg.sessionId, msg.method, msg.params);
				return;
			case "detached":
				this.#onTabDetached(msg.tabId, msg.reason, msg.relayInitiated === true);
				return;
			case "tabCreated":
				this.#onTabUpsert(msg.tab);
				return;
			case "tabUpdated":
				this.#onTabUpsert(msg.tab);
				return;
			case "tabRemoved":
				this.#onTabRemoved(msg.tabId);
				return;
		}
	}

	/** Record a protocol-level refusal; the socket stays open and never receives RPCs. */
	#refuseIncompatible(socket: RelaySocket, incompatible: IncompatibleExtension): void {
		this.#incompatibleExtension = incompatible;
		if (socket === this.#ext) {
			this.#dropExt();
			this.#candidates.add(socket);
		}
		logger.warn("Browser relay refused an incompatible extension", { ...incompatible });
		this.#log("incompatible extension", { ...incompatible });
	}

	/** Close a socket whose install is not the bound one; the bound connection (if any other) is untouched. */
	#rejectInstall(socket: RelaySocket, installId: string): void {
		const fingerprint = installFingerprint(installId);
		const now = Date.now();
		this.#lastRejected = { fingerprint, at: new Date(now).toISOString() };
		this.#rejectionPending = true;
		this.#candidates.delete(socket);
		if (socket === this.#ext) this.#dropExt();
		const boundFingerprint =
			this.#binding.state === "bound" ? installFingerprint(this.#binding.binding.installId) : undefined;
		const lastLogged = this.#mismatchLogAt.get(installId) ?? 0;
		if (now - lastLogged >= MISMATCH_LOG_INTERVAL_MS) {
			this.#mismatchLogAt.set(installId, now);
			logger.warn("Browser relay rejected an extension from an unbound Chrome profile", {
				fingerprint,
				boundFingerprint,
			});
		}
		this.#log("profile mismatch", { fingerprint, boundFingerprint });
		socket.close(RELAY_CLOSE_PROFILE_MISMATCH, "profile-mismatch");
	}

	#onHello(socket: RelaySocket, msg: Extract<ExtToRelayMessage, { t: "hello" }>): void {
		const extensionVersion = typeof msg.extensionVersion === "string" ? msg.extensionVersion : undefined;
		if (extensionProtocolOf(extensionVersion) < RELAY_PROTOCOL_VERSION) {
			this.#refuseIncompatible(socket, {
				version: extensionVersion ?? "0.1.0",
				required: RELAY_EXTENSION_MIN_VERSION,
				reason: "version",
			});
			return;
		}
		const installId = typeof msg.installId === "string" && msg.installId.length > 0 ? msg.installId : undefined;
		if (installId === undefined) {
			this.#refuseIncompatible(socket, {
				version: extensionVersion ?? "0.1.0",
				required: RELAY_EXTENSION_MIN_VERSION,
				reason: "install-id",
			});
			return;
		}
		this.#binding = readRelayBinding(this.#bindingPath);
		if (this.#binding.state === "bound" && this.#binding.binding.installId !== installId) {
			this.#rejectInstall(socket, installId);
			return;
		}
		this.#incompatibleExtension = null;
		this.#candidates.delete(socket);
		this.#candidateHellos.delete(socket);
		if (this.#ext && this.#ext !== socket) {
			if (this.#extInfo && this.#extInfo.installId !== installId) {
				// Unbound relay, two different installs: the first stays connected
				// (it is what `bind --from-connected` binds); the other stays a
				// silent candidate instead of displacing it.
				this.#candidates.add(socket);
				this.#candidateHellos.set(socket, msg);
				this.#log("ignoring hello from a second install while unbound", {
					fingerprint: installFingerprint(installId),
				});
				return;
			}
			// Same install: a restarted service worker replaces its predecessor.
			this.#log("replacing extension socket");
			for (const tab of this.#tabs.values()) this.#resetRuntime(tab);
			this.#rejectPendingExtensionRpcs(new ExtensionReplacedError());
			this.#ext.close();
		}
		this.#ext = socket;
		this.#extInfo = {
			userAgent: msg.userAgent,
			browserVersion: msg.browserVersion,
			generation: typeof msg.generation === "string" && msg.generation.length > 0 ? msg.generation : undefined,
			extensionVersion,
			installId,
		};
		this.#extensionSeen = true;
		if (this.ready) this.#boundSeen = true;
		this.#rejectionPending = false;
		const seen = new Set<number>();
		const attachedNow = new Set(msg.attachedTabIds);
		for (const snap of msg.tabs) {
			seen.add(snap.tabId);
			this.#onTabUpsert(snap, { silent: true });
		}
		for (const tabId of Array.from(this.#tabs.keys())) {
			if (!seen.has(tabId)) this.#onTabRemoved(tabId);
		}
		for (const tab of this.#tabs.values()) {
			const wasAttached = tab.attached;
			tab.attached = attachedNow.has(tab.tabId);
			tab.attaching = null;
			// A service-worker restart can drop attachments while downstream
			// connections still hold sessions: restore them best-effort.
			if (wasAttached && !tab.attached && this.#sessionHolders(tab.tabId).length > 0) {
				void this.#ensureAttached(tab).then(ok => {
					if (!ok) this.#onTabDetached(tab.tabId, "reattach_failed", false);
				});
			}
		}
		this.#syncGrouping();
		this.#log("extension connected", {
			tabs: this.#tabs.size,
			version: msg.browserVersion,
			binding: this.#binding.state,
			ready: this.ready,
		});
	}

	// ---- downstream (puppeteer) lifecycle -------------------------------------

	/** Register a downstream CDP websocket; returns the connection id. */
	cdpConnected(socket: RelaySocket): number {
		const conn = new CdpConnection(++this.#connSeq, socket);
		this.#conns.set(conn.id, conn);
		this.#log("cdp client connected", { conn: conn.id });
		return conn.id;
	}

	cdpClosed(connId: number): void {
		const conn = this.#conns.get(connId);
		if (!conn) return;
		this.#conns.delete(connId);
		const touched = new Set<number>();
		for (const ref of conn.sessions.values()) touched.add(ref.tabId);
		conn.sessions.clear();
		// Tabs this client claimed leave the omp group unless another claimant
		// remains — session holders don't count: the long-lived registry
		// connection holds sessions on every tab without driving any of them.
		for (const tabId of conn.claims) {
			const tab = this.#tabs.get(tabId);
			if (tab) this.#syncTabGrouping(tab);
		}
		conn.claims.clear();
		// Drop the debugger (and its infobar) from tabs nobody drives anymore.
		for (const tabId of touched) this.#detachIfUnheld(tabId);
		this.#log("cdp client closed", { conn: connId });
	}

	cdpMessage(connId: number, raw: string): void {
		const conn = this.#conns.get(connId);
		if (!conn) return;
		let msg: CdpCommand;
		try {
			msg = JSON.parse(raw) as CdpCommand;
		} catch {
			return;
		}
		if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
		void this.#handleCdpCommand(conn, msg).catch(err => {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		});
	}

	// ---- command routing -------------------------------------------------------

	async #handleCdpCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
		const sessionId = msg.sessionId;
		if (!sessionId) {
			await this.#handleBrowserCommand(conn, msg);
			return;
		}
		const ref = conn.sessions.get(sessionId);
		if (ref?.kind === "tab") {
			this.#handleTabSessionCommand(conn, msg, ref);
			return;
		}
		if (ref?.kind === "page") {
			await this.#handlePageSessionCommand(conn, msg, sessionId, ref);
			return;
		}
		const realTab = this.#realSessionTabs.get(sessionId);
		if (realTab !== undefined) {
			await this.#forwardToTab(conn, msg, realTab, sessionId);
			return;
		}
		this.#replyError(conn, msg, `Unknown session id ${sessionId}`);
	}

	async #handlePageSessionCommand(
		conn: CdpConnection,
		msg: CdpCommand,
		sessionId: string,
		ref: SessionRef,
	): Promise<void> {
		if (msg.method === "Runtime.disable") {
			ref.runtimeState = "disabled";
			ref.runtimeEpoch++;
			ref.runtimeContexts.clear();
			// Abandon any in-flight enable's ownership: a later enable starts fresh
			// rather than joining a cycle that predates this disable.
			ref.runtimeEnabling = null;
			this.#reply(conn, msg, {});
			return;
		}
		if (msg.method !== "Runtime.enable") {
			await this.#forwardToTab(conn, msg, ref.tabId, undefined);
			return;
		}
		// A pipelined duplicate must await the in-flight enable, never ack early:
		// the root cycle may still fail, and success must trail the context replay.
		if (ref.runtimeEnabling) {
			await this.#awaitEnable(conn, msg, ref.runtimeEnabling);
			return;
		}
		if (ref.runtimeState === "enabled") {
			this.#reply(conn, msg, {});
			return;
		}
		const enabling = this.#enableSessionRuntime(conn, sessionId, ref);
		ref.runtimeEnabling = enabling;
		try {
			await this.#awaitEnable(conn, msg, enabling);
		} finally {
			if (ref.runtimeEnabling === enabling) ref.runtimeEnabling = null;
		}
	}

	/** Reply to one `Runtime.enable` command with the shared enable's outcome. */
	async #awaitEnable(conn: CdpConnection, msg: CdpCommand, enabling: Promise<void>): Promise<void> {
		try {
			await enabling;
			this.#reply(conn, msg, {});
		} catch (err) {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Drive the shared root `Runtime.enable` for a session and replay the live
	 * contexts to it. Rejects if the root cycle fails so every joined caller
	 * observes the failure instead of a spurious success.
	 */
	async #enableSessionRuntime(conn: CdpConnection, sessionId: string, ref: SessionRef): Promise<void> {
		const prev = ref.runtimeState;
		const epoch = ++ref.runtimeEpoch;
		ref.runtimeState = "enabled";
		const tab = this.#tabs.get(ref.tabId);
		if (!tab) {
			ref.runtimeState = prev;
			throw new Error(`No tab with id ${ref.tabId}`);
		}
		try {
			await this.#ensureRuntimeEnabled(tab);
			// A disable or newer enable may have taken ownership while the root
			// RPC was in flight; only the latest enable may replay or roll back.
			if (conn.sessions.get(sessionId) === ref && ref.runtimeEpoch === epoch && ref.runtimeState === "enabled") {
				this.#replayRuntimeContexts(conn, sessionId, ref, tab);
			}
		} catch (err) {
			if (ref.runtimeEpoch === epoch) {
				ref.runtimeState = prev;
				ref.runtimeContexts.clear();
			}
			throw err;
		}
	}

	async #ensureRuntimeEnabled(tab: TabState): Promise<void> {
		if (tab.rootRuntimeEnabled) return;
		if (tab.rootRuntimeEnabling) return await tab.rootRuntimeEnabling;

		const enabling = this.#cycleRuntime(tab);
		tab.rootRuntimeEnabling = enabling;
		const generation = tab.runtimeGeneration;
		try {
			await enabling;
			if (tab.runtimeGeneration === generation) tab.rootRuntimeEnabled = true;
		} finally {
			if (tab.rootRuntimeEnabling === enabling) tab.rootRuntimeEnabling = null;
		}
	}

	async #cycleRuntime(tab: TabState): Promise<void> {
		await this.#rpc({ op: "send", tabId: tab.tabId, method: "Runtime.disable" });
		await this.#rpc({ op: "send", tabId: tab.tabId, method: "Runtime.enable" });
	}

	#replayRuntimeContexts(conn: CdpConnection, sessionId: string, ref: SessionRef, tab: TabState): void {
		for (const [contextId, params] of tab.runtimeContexts) {
			if (ref.runtimeContexts.has(contextId)) continue;
			ref.runtimeContexts.add(contextId);
			conn.socket.send(JSON.stringify({ sessionId, method: "Runtime.executionContextCreated", params }));
		}
	}

	async #forwardToTab(
		conn: CdpConnection,
		msg: CdpCommand,
		tabId: number,
		realSessionId: string | undefined,
	): Promise<void> {
		// Guard rail: a page session must never take the whole browser down.
		if (msg.method === "Browser.close") {
			this.#reply(conn, msg, {});
			return;
		}
		// Relay-private claim: the omp tab worker marks the page it was spawned
		// to drive. Never forwarded — real Chrome rejects the unknown method.
		if (msg.method === "OMP.claimTarget") {
			this.#claimTab(conn, tabId);
			this.#reply(conn, msg, {});
			return;
		}
		try {
			const result = await this.#rpc({
				op: "send",
				tabId,
				sessionId: realSessionId,
				method: msg.method,
				params: msg.params,
			});
			this.#reply(conn, msg, (result as Record<string, unknown> | undefined) ?? {});
		} catch (err) {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Record `conn` as a driver of the tab and reconcile grouping. Claims are
	 * explicit (worker adoption or tab creation) rather than inferred from
	 * command traffic: target discovery scans every page with the same
	 * commands a driver sends, so inference would sweep all tabs.
	 */
	#claimTab(conn: CdpConnection, tabId: number): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		if (!conn.claims.has(tabId)) {
			conn.claims.add(tabId);
			this.#log("tab claimed", { conn: conn.id, tabId });
		}
		this.#syncTabGrouping(tab);
	}

	/** True while any downstream connection claims the tab as its drive target. */
	#claimed(tabId: number): boolean {
		for (const conn of this.#conns.values()) {
			if (conn.claims.has(tabId)) return true;
		}
		return false;
	}

	/** Tab pseudo-sessions only exist to satisfy puppeteer's Target hierarchy. */
	#handleTabSessionCommand(conn: CdpConnection, msg: CdpCommand, ref: SessionRef): void {
		switch (msg.method) {
			case "Target.setAutoAttach": {
				const tab = this.#tabs.get(ref.tabId);
				if (!tab) {
					this.#replyError(conn, msg, `Tab ${ref.tabId} is gone`);
					return;
				}
				// Emit before replying: puppeteer's TargetManager counts page
				// children attached before the setAutoAttach response resolves.
				const pageSession = this.#mintSession(conn, "page", tab.tabId);
				this.#emit(
					conn,
					"Target.attachedToTarget",
					{
						sessionId: pageSession,
						targetInfo: this.#pageInfo(tab, true),
						waitingForDebugger: false,
					},
					msg.sessionId,
				);
				this.#reply(conn, msg, {});
				return;
			}
			case "Runtime.runIfWaitingForDebugger":
				this.#reply(conn, msg, {});
				return;
			case "Target.detachFromTarget": {
				const child = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
				if (child) this.#releaseSession(conn, child, msg.sessionId);
				this.#reply(conn, msg, {});
				return;
			}
			default:
				this.#replyError(conn, msg, `'${msg.method}' is not supported on a tab target`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	async #handleBrowserCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
		switch (msg.method) {
			case "Browser.getVersion": {
				this.#reply(conn, msg, {
					protocolVersion: "1.3",
					product: this.#extInfo?.browserVersion ?? "Chrome/unknown",
					// Proof bound to THIS connection that a protocol-2 relay answered
					// (an HTTP probe can be answered by a different process than the
					// one puppeteer ended up talking to). Other fields stay Chrome-like.
					revision: relayRevision(this.profileBinding().state, this.#extInfo?.installId),
					userAgent: this.#extInfo?.userAgent ?? "",
					jsVersion: "",
				});
				return;
			}
			case "Target.getBrowserContexts":
				this.#reply(conn, msg, { browserContextIds: [] });
				return;
			case "Target.setDiscoverTargets": {
				conn.discover = true;
				for (const tab of this.#tabs.values()) {
					if (!this.#eligible(tab)) continue;
					tab.announced = true;
					this.#emit(conn, "Target.targetCreated", { targetInfo: this.#tabInfo(tab, tab.attached) });
					this.#emit(conn, "Target.targetCreated", { targetInfo: this.#pageInfo(tab, tab.attached) });
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.getTargets": {
				// Same set `setDiscoverTargets` announces, as a snapshot. The
				// supervisor's crash-transfer sweep reads `ompMarker` from here.
				const targetInfos: TargetInfo[] = [];
				for (const tab of this.#tabs.values()) {
					if (!this.#eligible(tab)) continue;
					targetInfos.push(this.#tabInfo(tab, tab.attached), this.#pageInfo(tab, tab.attached));
				}
				this.#reply(conn, msg, { targetInfos });
				return;
			}
			case "Target.setAutoAttach": {
				conn.autoAttach = true;
				const tabs = [...this.#tabs.values()].filter(tab => this.#eligible(tab));
				await Promise.all(tabs.map(tab => this.#ensureAttached(tab)));
				for (const tab of tabs) {
					if (!tab.attached) {
						// Attach failed (DevTools open, another debugger, …): retract
						// the target so puppeteer's init never waits on it.
						this.#retractTab(tab);
						continue;
					}
					this.#emitTabAttached(conn, tab);
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.attachToTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				const tab = parsed ? this.#tabs.get(parsed.tabId) : undefined;
				if (!parsed || !tab) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				if (!(await this.#ensureAttached(tab))) {
					this.#replyError(conn, msg, `Cannot attach to tab ${tab.tabId} (${tab.url})`);
					return;
				}
				const sessionId = this.#mintSession(conn, parsed.kind, tab.tabId);
				const info = parsed.kind === "tab" ? this.#tabInfo(tab, true) : this.#pageInfo(tab, true);
				this.#emit(conn, "Target.attachedToTarget", { sessionId, targetInfo: info, waitingForDebugger: false });
				this.#reply(conn, msg, { sessionId });
				return;
			}
			case "Target.detachFromTarget": {
				const sessionId = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
				if (sessionId) this.#releaseSession(conn, sessionId, undefined);
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.createTarget": {
				const url =
					typeof msg.params?.url === "string" && msg.params.url.length > 0 ? msg.params.url : "about:blank";
				const background = msg.params?.background === true;
				const result = (await this.#rpc({ op: "createTab", url, active: !background })) as { tab: TabSnapshot };
				this.#onTabUpsert(result.tab);
				// Creating a tab is an explicit act of driving it.
				this.#claimTab(conn, result.tab.tabId);
				this.#reply(conn, msg, { targetId: pageTargetId(result.tab.tabId) });
				return;
			}
			case "Target.closeTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				if (!parsed) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				await this.#rpc({ op: "removeTab", tabId: parsed.tabId });
				this.#reply(conn, msg, { success: true });
				return;
			}
			case "Target.activateTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				if (parsed) await this.#rpc({ op: "activateTab", tabId: parsed.tabId });
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.getTargetInfo": {
				const raw = typeof msg.params?.targetId === "string" ? msg.params.targetId : undefined;
				const parsed = raw ? parseTargetId(raw) : null;
				const tab = parsed ? this.#tabs.get(parsed.tabId) : undefined;
				if (parsed && tab) {
					const info =
						parsed.kind === "tab" ? this.#tabInfo(tab, tab.attached) : this.#pageInfo(tab, tab.attached);
					this.#reply(conn, msg, { targetInfo: info });
					return;
				}
				this.#reply(conn, msg, {
					targetInfo: {
						targetId: "relay-browser",
						type: "browser",
						title: "",
						url: "",
						attached: true,
						canAccessOpener: false,
					} satisfies TargetInfo,
				});
				return;
			}
			case "Browser.close":
				// Never close the user's browser; acknowledge and ignore.
				this.#log("refusing Browser.close from downstream client", { conn: conn.id });
				this.#reply(conn, msg, {});
				return;
			case "Browser.setDownloadBehavior":
				this.#reply(conn, msg, {});
				return;
			case "Target.createBrowserContext":
				this.#replyError(conn, msg, "Browser contexts are not supported by the omp browser relay");
				return;
			default:
				this.#replyError(conn, msg, `'${msg.method}' wasn't found`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	// ---- extension events -------------------------------------------------------

	#onCdpEvent(
		tabId: number,
		sourceSessionId: string | undefined,
		method: string,
		params?: Record<string, unknown>,
	): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		// Track real child sessions so downstream commands can route back.
		if (method === "Target.attachedToTarget") {
			const child = params?.sessionId;
			if (typeof child === "string") {
				tab.realSessions.add(child);
				this.#realSessionTabs.set(child, tabId);
			}
		} else if (method === "Target.detachedFromTarget") {
			const child = params?.sessionId;
			if (typeof child === "string") {
				tab.realSessions.delete(child);
				this.#realSessionTabs.delete(child);
			}
		}
		if (sourceSessionId) {
			// Event from a real child session: pass through verbatim to every
			// connection that observes this tab.
			const payload = JSON.stringify({ sessionId: sourceSessionId, method, params });
			for (const conn of this.#conns.values()) {
				if (conn.sessionsForTab(tabId, "page").length > 0) conn.socket.send(payload);
			}
			return;
		}
		if (method.startsWith("Runtime.")) {
			const createdContext = method === "Runtime.executionContextCreated" ? params?.context : undefined;
			const createdContextId =
				createdContext &&
				typeof createdContext === "object" &&
				"id" in createdContext &&
				typeof createdContext.id === "number"
					? createdContext.id
					: undefined;
			const destroyedContextId =
				method === "Runtime.executionContextDestroyed" && typeof params?.executionContextId === "number"
					? params.executionContextId
					: undefined;
			if (createdContextId !== undefined && params) tab.runtimeContexts.set(createdContextId, params);
			if (destroyedContextId !== undefined) tab.runtimeContexts.delete(destroyedContextId);
			if (method === "Runtime.executionContextsCleared") tab.runtimeContexts.clear();

			for (const conn of this.#conns.values()) {
				for (const [pageSession, ref] of conn.sessions) {
					if (ref.kind !== "page" || ref.tabId !== tabId) continue;
					if (destroyedContextId !== undefined) ref.runtimeContexts.delete(destroyedContextId);
					if (method === "Runtime.executionContextsCleared") ref.runtimeContexts.clear();
					// `default` sessions never enabled Runtime but still get the
					// legacy fan-out; only an explicit `Runtime.disable` silences one.
					if (ref.runtimeState === "disabled") continue;
					if (createdContextId !== undefined) {
						if (ref.runtimeContexts.has(createdContextId)) continue;
						ref.runtimeContexts.add(createdContextId);
					}
					conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params }));
				}
			}
			return;
		}
		// Other root-session events fan out once per minted page session.
		for (const conn of this.#conns.values()) {
			for (const pageSession of conn.sessionsForTab(tabId, "page")) {
				conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params }));
			}
		}
	}

	#onTabDetached(tabId: number, reason: string, relayInitiated: boolean): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		// Explicit source attribution comes from the extension that executed
		// chrome.debugger.detach, so socket replacement cannot confuse this
		// with a user cancellation or mutate an unrelated attach promise.
		if (relayInitiated) {
			// A replacement hello can observe the old attachment before the
			// pending detach completes. Reconcile that stale snapshot unless a
			// later attach has already superseded this detach.
			if (!tab.reattachedAfterDetach) tab.attached = false;
			return;
		}
		this.#log("tab detached", { tabId, reason });
		tab.attached = false;
		tab.attaching = null;
		this.#resetRuntime(tab);
		tab.banned = true;
		// The user dismissed the debugger infobar (or the attach was torn
		// down): release the tab's omp-group membership too.
		this.#syncTabGrouping(tab);
		this.#retractTab(tab);
	}

	#onTabRemoved(tabId: number): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		this.#retractTab(tab);
		this.#tabs.delete(tabId);
		for (const conn of this.#conns.values()) conn.claims.delete(tabId);
	}

	#onTabUpsert(snap: TabSnapshot, opts: { silent?: boolean } = {}): void {
		let tab = this.#tabs.get(snap.tabId);
		if (!tab) {
			tab = new TabState(snap.tabId, snap);
			this.#tabs.set(snap.tabId, tab);
		} else {
			if (tab.url !== snap.url) tab.banned = false;
			// The user dragging an adopted tab out of the omp group is an
			// opt-out; the relay never fights the user over grouping. Marked
			// tabs are judged by the extension (it can tell a user drag from
			// its own duplicate-group merge) and report `optOut` in snapshots.
			if (tab.grouped && tab.ompGroupId !== undefined && snap.groupId !== tab.ompGroupId) {
				tab.grouped = false;
				if (tab.marker === undefined) tab.groupOptOut = true;
				else tab.ompGroupId = undefined;
			}
			tab.update(snap);
		}
		if (opts.silent) return;
		const eligible = this.#eligible(tab);
		this.#syncTabGrouping(tab);
		if (eligible && !tab.announced) {
			tab.announced = true;
			for (const conn of this.#conns.values()) {
				if (!conn.discover) continue;
				this.#emit(conn, "Target.targetCreated", { targetInfo: this.#tabInfo(tab, tab.attached) });
				this.#emit(conn, "Target.targetCreated", { targetInfo: this.#pageInfo(tab, tab.attached) });
			}
			for (const conn of this.#conns.values()) {
				if (!conn.autoAttach) continue;
				void this.#ensureAttached(tab).then(ok => {
					if (ok) this.#emitTabAttached(conn, tab);
				});
			}
			return;
		}
		if (!eligible && tab.announced) {
			this.#retractTab(tab);
			return;
		}
		if (eligible && tab.announced) {
			for (const conn of this.#conns.values()) {
				if (!conn.discover) continue;
				this.#emit(conn, "Target.targetInfoChanged", { targetInfo: this.#tabInfo(tab, tab.attached) });
				this.#emit(conn, "Target.targetInfoChanged", { targetInfo: this.#pageInfo(tab, tab.attached) });
			}
		}
	}

	// ---- tab grouping -----------------------------------------------------------

	/**
	 * A tab belongs in the OMP group when it is OMP-created (marked) or claimed
	 * by a client, controllable, unpinned, not user-opted-out, and not already
	 * in some other (user) group. Marked tabs keep their membership across
	 * claims, connections and relay restarts; adopted tabs are grouped only
	 * while a client drives them.
	 */
	#groupWorthy(tab: TabState): boolean {
		const wanted = tab.marker !== undefined || this.#claimed(tab.tabId);
		if (!wanted || !this.#eligible(tab) || tab.pinned || tab.groupOptOut) return false;
		return tab.grouped || tab.groupId === -1 || (tab.marker !== undefined && tab.ompGroupId === undefined);
	}

	/** Re-group every marked/claimed tab (extension hello / reconnect) — the extension reuses the existing group. */
	#syncGrouping(): void {
		if (!this.#group) return;
		const worthy = [...this.#tabs.values()].filter(tab => this.#groupWorthy(tab) && !tab.grouped && !tab.grouping);
		if (worthy.length > 0) this.#requestGroup(worthy);
	}

	/** Reconcile one tab's group membership after a lifecycle event. */
	#syncTabGrouping(tab: TabState): void {
		if (!this.#group) return;
		if (this.#groupWorthy(tab)) {
			if (!tab.grouped && !tab.grouping) this.#requestGroup([tab]);
			return;
		}
		// Only adopted tabs leave the group when nobody drives them anymore; a
		// marked tab is OMP's and stays grouped until it is closed or the user
		// drags it out.
		if (tab.grouped && tab.marker === undefined) {
			tab.grouped = false;
			tab.ompGroupId = undefined;
			void this.#rpc({ op: "ungroup", tabIds: [tab.tabId] }).catch(() => {});
		}
	}

	/**
	 * Queue tabs for grouping and drain serially. Overlapping group RPCs race
	 * the extension's non-atomic query→create→set-title sequence and mint
	 * duplicate omp groups, so at most one group RPC is ever in flight.
	 */
	#requestGroup(tabs: TabState[]): void {
		if (!this.#group) return;
		for (const tab of tabs) {
			tab.grouping = true;
			this.#groupQueue.push(tab);
		}
		if (!this.#groupDraining) void this.#drainGroupQueue();
	}

	async #drainGroupQueue(): Promise<void> {
		const group = this.#group;
		if (!group) return;
		this.#groupDraining = true;
		try {
			while (this.#groupQueue.length > 0) {
				const batch = this.#groupQueue.splice(0);
				const tabIds = batch.map(tab => tab.tabId);
				try {
					const result = await this.#rpc({ op: "group", tabIds, title: group.title, color: group.color });
					// Extension replies { grouped: { [tabId]: groupId } }; validate per entry.
					const grouped: Record<string, unknown> =
						result &&
						typeof result === "object" &&
						"grouped" in result &&
						result.grouped &&
						typeof result.grouped === "object"
							? (result.grouped as Record<string, unknown>)
							: {};
					for (const tab of batch) {
						const groupId = grouped[String(tab.tabId)];
						if (typeof groupId !== "number") continue;
						tab.grouped = true;
						tab.ompGroupId = groupId;
					}
					this.#log("grouped tabs", { tabIds, grouped });
				} catch (err) {
					this.#log("tab grouping failed", { error: err instanceof Error ? err.message : String(err) });
				} finally {
					for (const tab of batch) tab.grouping = false;
				}
			}
		} finally {
			this.#groupDraining = false;
		}
	}

	/** Tear a tab out of every downstream connection (closed, detached, or now ineligible). */
	#retractTab(tab: TabState): void {
		for (const realSession of tab.realSessions) this.#realSessionTabs.delete(realSession);
		tab.realSessions.clear();
		for (const conn of this.#conns.values()) {
			const tabSessions = conn.sessionsForTab(tab.tabId, "tab");
			for (const pageSession of conn.sessionsForTab(tab.tabId, "page")) {
				conn.sessions.delete(pageSession);
				this.#emit(
					conn,
					"Target.detachedFromTarget",
					{ sessionId: pageSession, targetId: pageTargetId(tab.tabId) },
					tabSessions[0],
				);
			}
			for (const tabSession of tabSessions) {
				conn.sessions.delete(tabSession);
				this.#emit(conn, "Target.detachedFromTarget", { sessionId: tabSession, targetId: tabTargetId(tab.tabId) });
			}
			if (conn.discover && tab.announced) {
				this.#emit(conn, "Target.targetDestroyed", { targetId: pageTargetId(tab.tabId) });
				this.#emit(conn, "Target.targetDestroyed", { targetId: tabTargetId(tab.tabId) });
			}
		}
		tab.announced = false;
	}

	// ---- session + attach bookkeeping --------------------------------------------

	#mintSession(conn: CdpConnection, kind: "tab" | "page", tabId: number): string {
		const sessionId = `S${kind === "tab" ? "T" : "P"}${tabId}.${conn.id}.${++this.#sessionSeq}`;
		conn.sessions.set(sessionId, {
			kind,
			tabId,
			runtimeState: "default",
			runtimeContexts: new Set(),
			runtimeEnabling: null,
			runtimeEpoch: 0,
		});
		return sessionId;
	}

	#releaseSession(conn: CdpConnection, sessionId: string, parentSessionId: string | undefined): void {
		const ref = conn.sessions.get(sessionId);
		if (!ref) return;
		conn.sessions.delete(sessionId);
		const targetId = ref.kind === "tab" ? tabTargetId(ref.tabId) : pageTargetId(ref.tabId);
		this.#emit(conn, "Target.detachedFromTarget", { sessionId, targetId }, parentSessionId);
		// An explicit release of the last session must drop the attachment too,
		// or it outlives every downstream session: the infobar stays up, and
		// dismissing it bans the tab for the rest of the epoch.
		this.#detachIfUnheld(ref.tabId);
	}

	/**
	 * Release the tab's chrome.debugger attachment once no downstream session
	 * holds it. Inert while the long-lived registry connection still holds one.
	 */
	#detachIfUnheld(tabId: number): void {
		if (this.#sessionHolders(tabId).length > 0) return;
		const tab = this.#tabs.get(tabId);
		if (!tab?.attached) return;
		tab.attached = false;
		this.#resetRuntime(tab);
		tab.reattachedAfterDetach = false;
		const done = this.#rpc({ op: "detach", tabId })
			.then(() => {})
			.catch(() => {})
			.finally(() => {
				if (tab.detaching === done) tab.detaching = null;
			});
		tab.detaching = done;
	}

	#resetRuntime(tab: TabState): void {
		tab.runtimeContexts.clear();
		tab.rootRuntimeEnabled = false;
		tab.rootRuntimeEnabling = null;
		tab.runtimeGeneration++;
	}

	/** Connections currently holding any session on a tab. */
	#sessionHolders(tabId: number): CdpConnection[] {
		const out: CdpConnection[] = [];
		for (const conn of this.#conns.values()) {
			if (conn.sessionsForTab(tabId).length > 0) out.push(conn);
		}
		return out;
	}

	#emitTabAttached(conn: CdpConnection, tab: TabState): void {
		if (conn.sessionsForTab(tab.tabId, "tab").length > 0) return;
		const sessionId = this.#mintSession(conn, "tab", tab.tabId);
		this.#emit(conn, "Target.attachedToTarget", {
			sessionId,
			targetInfo: this.#tabInfo(tab, true),
			waitingForDebugger: false,
		});
	}

	async #ensureAttached(tab: TabState): Promise<boolean> {
		// The extension emits the detach echo before resolving the RPC. Awaiting
		// prevents a replacement attach racing either operation.
		while (tab.detaching) await tab.detaching;
		if (tab.attached) return true;
		if (tab.banned || !this.#ext) return false;
		if (tab.attaching) return await tab.attaching;
		const attempt = this.#rpc({ op: "attach", tabId: tab.tabId })
			.then(() => {
				tab.attached = true;
				tab.reattachedAfterDetach = true;
				return true;
			})
			.catch(err => {
				this.#log("attach failed", {
					tabId: tab.tabId,
					url: tab.url,
					error: err instanceof Error ? err.message : String(err),
				});
				if (!(err instanceof ExtensionReplacedError)) tab.banned = true;
				return false;
			})
			.finally(() => {
				tab.attaching = null;
			});
		tab.attaching = attempt;
		return await attempt;
	}

	#eligible(tab: TabState): boolean {
		if (tab.banned) return false;
		if (!tab.url) return true;
		return !INELIGIBLE_URL.test(tab.url);
	}

	#tabInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: tabTargetId(tab.tabId),
			type: "tab",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
			...(tab.marker ? { ompMarker: tab.marker } : {}),
		};
	}

	#pageInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: pageTargetId(tab.tabId),
			type: "page",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
			...(tab.marker ? { ompMarker: tab.marker } : {}),
		};
	}

	// ---- plumbing ---------------------------------------------------------------

	#reply(conn: CdpConnection, msg: CdpCommand, result: Record<string, unknown>): void {
		conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result }));
	}

	#replyError(conn: CdpConnection, msg: CdpCommand, message: string, code = CDP_ERROR_SERVER): void {
		conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, error: { code, message } }));
	}

	#emit(conn: CdpConnection, method: string, params: Record<string, unknown>, sessionId?: string): void {
		conn.socket.send(JSON.stringify({ sessionId, method, params }));
	}

	#rpc(req: RelayRpcRequest, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
		const ext = this.#ext;
		if (!ext) return Promise.reject(new Error("relay extension is not connected"));
		// An unbound (or newly unbound) install may stay connected for `bind
		// --from-connected`, but the relay never drives it.
		if (!this.ready) return Promise.reject(new Error("relay extension is not bound to this relay"));
		const id = ++this.#rpcSeq;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#pendingRpc.delete(id);
			reject(new Error(`extension rpc '${req.op}' timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		this.#pendingRpc.set(id, { resolve, reject, timer });
		ext.send(JSON.stringify({ t: "rpc", id, ...req } satisfies RelayToExtMessage));
		return promise;
	}
}
