/**
 * Client side of the browser relay: waiting for it to drive a browser, and asking an outdated one to restart.
 *
 * The relay is served by the omp extension's native host for as long as Chrome runs with the extension
 * (`native-relay.ts`). Nothing on the port therefore means no such browser is running, except right after a
 * restart, while Chrome starts the next host. A 503 means a relay is up and its browser has not said hello yet,
 * which takes moments.
 *
 * The 503 body ({@link RelayUnavailableInfo}) also says when waiting cannot help: the browser that dialed in is
 * from an unbound or a different Chrome profile, or the binding file is invalid. Those verdicts are immediate
 * ({@link RelayWaitOutcome} `profile-*`); {@link relayUnavailableAt} reads the detail that names the fix.
 *
 * Relay protocol: a 200 body carries `OMP-Relay-Protocol`, a 503 body `relayProtocol`; a relay answering without
 * either (stock 18.2.6, legacy 18.1.10) is protocol 1 ({@link relayProtocolOf}).
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { throwIfAborted } from "../../tool-errors";
import { type CdpProbeResponse, probeCdpResponse } from "../attach";
import type { ProfileBindingInfo, RelayUnavailableReason } from "./bridge";
import { DISCARDED_TABS_PROTOCOL_VERSION, isOlderOmpVersion, RELAY_RESTART_PATH } from "./protocol";
import type { RelayUnavailableInfo } from "./server";

/** How long a relay that is up may go without its browser's hello. */
const HELLO_WINDOW_MS = 10_000;
/**
 * How long a restarted relay may take to come back: the extension's reconnect backoff, Chrome starting the next
 * native host, its bind and the hello.
 */
const RESTART_WINDOW_MS = 20_000;
const PROBE_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 150;
/** Protocol of a relay whose `/json/version` answers carry no protocol field. */
export const LEGACY_RELAY_PROTOCOL = 1;

/** Outcome of {@link waitForRelayExtension}. */
export type RelayWaitOutcome =
	/** `/json/version` has the required relay and extension capabilities. */
	| "ready"
	/** Nothing (or something that is not a relay) is serving the endpoint. */
	| "unreachable"
	/** The relay is serving but its browser did not say hello within the hello window. */
	| "no-extension"
	/** An older relay server is still running. */
	| "outdated-relay"
	/** A compatible relay from an older OMP is ready and reports no CDP client connected to it. */
	| "idle-older-relay"
	/** The relay extension is older than the running server. */
	| "outdated-extension"
	/** An extension is connected but the relay has no binding file yet; {@link relayUnavailableAt} names the fix. */
	| "profile-unbound"
	/**
	 * The relay is bound to another Chrome profile's install and rejected the one that dialed. Returned at once when
	 * the bound install was never connected; after the hello window when it was (it may revive).
	 */
	| "profile-mismatch"
	/** The relay's binding file is unreadable or malformed. */
	| "profile-invalid";

/** The OMP version a parsed `/json/version` body (ready or waiting) reports; empty when it reports none. */
export function relayVersionOf(parsed: object): string {
	return "ompRelayVersion" in parsed && typeof parsed.ompRelayVersion === "string" ? parsed.ompRelayVersion : "";
}

/** CDP clients a parsed `/json/version` body (ready or waiting) reports; null for a relay too old to report them. */
export function relayCdpClientsOf(parsed: object): number | null {
	return "ompRelayCdpClients" in parsed && typeof parsed.ompRelayCdpClients === "number"
		? parsed.ompRelayCdpClients
		: null;
}

/** A `/json/version` body (ready or waiting) as an object; null when it is not one. */
function parseVersionBody(body: string): object | null {
	try {
		const parsed: unknown = JSON.parse(body);
		return typeof parsed === "object" && parsed !== null ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Relay protocol advertised by a `/json/version` answer: 200 bodies carry `OMP-Relay-Protocol` (string map), 503
 * bodies `relayProtocol`. Null when the answer is not a relay answer at all (a 2xx that is not a JSON discovery
 * document, or any other status); an opaque 503 counts as a legacy relay, matching how consumers always adopted it.
 */
export function relayProtocolOf(response: CdpProbeResponse | null): number | null {
	if (response === null) return null;
	const ok = response.status >= 200 && response.status < 300;
	if (!ok && response.status !== 503) return null;
	const parsed = parseVersionBody(response.body);
	if (parsed === null) return ok ? null : LEGACY_RELAY_PROTOCOL;
	const raw = ok
		? (parsed as Record<string, unknown>)["OMP-Relay-Protocol"]
		: (parsed as Record<string, unknown>).relayProtocol;
	const value = typeof raw === "string" ? Number(raw) : raw;
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : LEGACY_RELAY_PROTOCOL;
}

/** The id of the relay server answering at `cdpUrl`, ready or waiting; null when none answers. */
async function relayInstanceAt(cdpUrl: string, signal?: AbortSignal): Promise<string | null> {
	const response = await probeCdpResponse(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS, signal });
	if (response === null) return null;
	const parsed = parseVersionBody(response.body);
	return parsed !== null && "ompRelayInstance" in parsed && typeof parsed.ompRelayInstance === "string"
		? parsed.ompRelayInstance
		: "";
}

const UNAVAILABLE_REASONS: Record<RelayUnavailableReason, true> = {
	"profile-unbound": true,
	"profile-mismatch": true,
	"profile-invalid": true,
};

function parseProfileBinding(value: unknown): ProfileBindingInfo | undefined {
	if (!isRecord(value)) return undefined;
	if (value.state === "invalid" && typeof value.error === "string") return { state: "invalid", error: value.error };
	if (value.state === "bound" && typeof value.boundFingerprint === "string") {
		const rejected = value.lastRejected;
		return {
			state: "bound",
			boundFingerprint: value.boundFingerprint,
			...(isRecord(rejected) && typeof rejected.fingerprint === "string" && typeof rejected.at === "string"
				? { lastRejected: { fingerprint: rejected.fingerprint, at: rejected.at } }
				: {}),
		};
	}
	if (value.state === "unbound") {
		return {
			state: "unbound",
			...(typeof value.connectedFingerprint === "string"
				? { connectedFingerprint: value.connectedFingerprint }
				: {}),
		};
	}
	return undefined;
}

/** A 503 body as the client sees it; `ompRelayCdpClients` is read through {@link relayCdpClientsOf} where it matters. */
export type UnavailableInfo = Omit<RelayUnavailableInfo, "ompRelayCdpClients" | "ompRelayInstance">;

/** Parse a 503 body; null for a non-relay body (foreign server). Fields a legacy relay omits get protocol-1 defaults. */
function parseUnavailableInfo(body: string): UnavailableInfo | null {
	const parsed = parseVersionBody(body);
	if (!isRecord(parsed)) return null;
	const info: UnavailableInfo = {
		ompRelayVersion: relayVersionOf(parsed),
		error: typeof parsed.error === "string" ? parsed.error : "",
		relayProtocol: relayProtocolOf({ status: 503, body }) ?? LEGACY_RELAY_PROTOCOL,
		profileBinding: parseProfileBinding(parsed.profileBinding) ?? { state: "unbound" },
	};
	if (typeof parsed.reason === "string" && parsed.reason in UNAVAILABLE_REASONS) {
		info.reason = parsed.reason as RelayUnavailableReason;
	}
	if (typeof parsed.boundSeen === "boolean") info.boundSeen = parsed.boundSeen;
	return info;
}

/**
 * The 503 detail of the relay at `cdpUrl` (reason, the error text that names the fix, the binding): null when it is
 * ready, unreachable or not a relay. Read it after {@link waitForRelayExtension} returned a `profile-*` outcome.
 */
export async function relayUnavailableAt(cdpUrl: string, signal?: AbortSignal): Promise<UnavailableInfo | null> {
	const response = await probeCdpResponse(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS, signal });
	if (response === null || response.status !== 503) return null;
	return parseUnavailableInfo(response.body);
}

/** Immediate verdict for a 503 the relay attributes to the Chrome profile; null when waiting is right. */
function refusalOutcome(info: UnavailableInfo): RelayWaitOutcome | null {
	switch (info.reason) {
		case "profile-unbound":
		case "profile-mismatch":
		case "profile-invalid":
			return info.reason;
		case undefined:
			return null;
	}
}

function readyOutcome(body: string): RelayWaitOutcome {
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("ompRelayDiscardedTabsProtocol" in parsed) ||
			parsed.ompRelayDiscardedTabsProtocol !== String(DISCARDED_TABS_PROTOCOL_VERSION)
		) {
			return "outdated-relay";
		}
		if (
			!("ompExtensionDiscardedTabsProtocol" in parsed) ||
			parsed.ompExtensionDiscardedTabsProtocol !== String(DISCARDED_TABS_PROTOCOL_VERSION)
		) {
			// A relay from another OMP version is the likelier culprit than the extension.
			if (relayVersionOf(parsed) !== VERSION) return "outdated-relay";
			return "outdated-extension";
		}
		if (isOlderOmpVersion(relayVersionOf(parsed), VERSION) && relayCdpClientsOf(parsed) === 0)
			return "idle-older-relay";
		return "ready";
	} catch {
		return "outdated-relay";
	}
}

/**
 * Poll the relay at `cdpUrl` until its browser said hello. Gives up at once when nothing serves the endpoint, unless
 * `restarted` (then it waits for the next host), when the relay refuses the browser's Chrome profile (waiting cannot
 * fix that), and after the hello window when a relay serves without a browser.
 */
export async function waitForRelayExtension(
	cdpUrl: string,
	signal?: AbortSignal,
	options?: { restarted?: boolean },
): Promise<RelayWaitOutcome> {
	const probeUrl = `${cdpUrl}/json/version`;
	const reachableBy = Date.now() + (options?.restarted ? RESTART_WINDOW_MS : 0);
	let helloBy: number | null = null;
	for (;;) {
		throwIfAborted(signal);
		const response = await probeCdpResponse(probeUrl, { timeoutMs: PROBE_TIMEOUT_MS, signal });
		throwIfAborted(signal);
		if (response === null) {
			if (Date.now() >= reachableBy) return "unreachable";
		} else if (response.status >= 200 && response.status < 300) {
			return readyOutcome(response.body);
		} else if (response.status !== 503) {
			return "unreachable";
		} else {
			const info = parseUnavailableInfo(response.body);
			const refused = info ? refusalOutcome(info) : null;
			// A rejected intruder while the bound install was connected earlier: that install's service worker may
			// revive within the hello window, so the verdict waits for it. Every other refusal is final.
			const deferred = refused === "profile-mismatch" && info?.boundSeen ? refused : null;
			if (refused && !deferred) return refused;
			helloBy ??= Date.now() + HELLO_WINDOW_MS;
			if (Date.now() >= helloBy) {
				if (deferred) return deferred;
				// A relay from another version reads as outdated: no browser is behind it to blame instead.
				return info !== null && info.ompRelayVersion !== VERSION ? "outdated-relay" : "no-extension";
			}
		}
		await Bun.sleep(POLL_INTERVAL_MS);
	}
}

/**
 * Ask the native host serving the relay at `cdpUrl` to exit, so Chrome starts the next one from the installed omp;
 * with `idleOnly`, only while no CDP client uses it. Resolves true once the old server stopped answering (the caller
 * then waits with `restarted`). False when it declined (it is not older than this omp, or it is busy) or stayed.
 */
export async function requestRelayRestart(
	cdpUrl: string,
	options: { idleOnly: boolean; signal?: AbortSignal },
): Promise<boolean> {
	const { signal } = options;
	const before = await relayInstanceAt(cdpUrl, signal);
	if (before === null) return false;
	const query = `version=${encodeURIComponent(VERSION)}${options.idleOnly ? "&idle=1" : ""}`;
	try {
		const response = await fetch(`${cdpUrl}${RELAY_RESTART_PATH}?${query}`, { method: "POST", signal });
		if (response.status !== 202) return false;
	} catch {
		throwIfAborted(signal);
		return false;
	}
	const deadline = Date.now() + RESTART_WINDOW_MS;
	while (Date.now() < deadline) {
		await Bun.sleep(POLL_INTERVAL_MS);
		throwIfAborted(signal);
		// Gone, or already replaced by another browser's host: either way the old server stopped.
		if ((await relayInstanceAt(cdpUrl, signal)) !== before) return true;
	}
	return false;
}

/** The steps that replace an out-of-date relay extension. */
export const UPDATE_RELAY_EXTENSION = "Run `omp browser-relay install` and reload the omp extension in Chrome.";

/**
 * Notice for an open through a ready relay where a connected extension was
 * installed by an older omp, or null. The extension still speaks the relay
 * protocol, so the open goes ahead; relay fixes shipped since that install
 * stay inactive until the user reinstalls it. A relay too old to report the
 * extension's version gets no notice: it cannot tell.
 */
export async function relayExtensionNotice(cdpUrl: string, signal?: AbortSignal): Promise<string | null> {
	const response = await probeCdpResponse(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS, signal });
	if (response === null || response.status < 200 || response.status >= 300) return null;
	let installedBy: unknown;
	try {
		const parsed: unknown = JSON.parse(response.body);
		if (typeof parsed !== "object" || parsed === null || !("ompExtensionVersion" in parsed)) return null;
		installedBy = parsed.ompExtensionVersion;
	} catch {
		return null;
	}
	if (typeof installedBy !== "string" || !isOlderOmpVersion(installedBy, VERSION)) return null;
	const origin = installedBy === "" ? "an older omp" : `omp ${installedBy}; this is omp ${VERSION}`;
	return `The omp extension is out of date (installed by ${origin}). ${UPDATE_RELAY_EXTENSION}`;
}
