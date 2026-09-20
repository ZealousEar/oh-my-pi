/**
 * Client-side wait for the relay's extension handshake.
 *
 * `/json/version` answers 503 until the bound extension dials in, and the 503
 * body ({@link RelayUnavailableInfo}) says why. That splits the reasons for a
 * 503 that used to look identical:
 * - Extension seen before: Chrome reaped its MV3 service worker; the
 *   extension's 30s keepalive alarm revives it, so waiting one alarm period
 *   pays off.
 * - Extension never seen: an installed extension dials within one alarm
 *   period of the server starting, so once the server has been up that long
 *   nothing is coming and the open fails at once instead of burning the
 *   whole window every call.
 * - Extension refused (too old, from an unbound or a different Chrome
 *   profile, or the binding file is invalid): waiting cannot fix it, so the
 *   verdict is immediate and names the fix.
 *
 * Relay protocol: a 200 body carries `OMP-Relay-Protocol`, a 503 body
 * `relayProtocol`; a relay answering without either (stock 18.2.6, legacy
 * 18.1.10) is protocol 1.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { throwIfAborted } from "../../tool-errors";
import { type CdpProbeResponse, probeCdpResponse } from "../attach";
import type { ProfileBindingInfo, RelayUnavailableReason } from "./bridge";
import type { RelayUnavailableInfo } from "./server";

/**
 * One extension keepalive alarm period (30s, `background.js`) plus the dial
 * and hello. Both the reconnect wait and the "never connected" verdict use it.
 */
const EXTENSION_DIAL_WINDOW_MS = 35_000;
const PROBE_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 150;
/** Protocol of a relay whose `/json/version` answers carry no protocol field. */
export const LEGACY_RELAY_PROTOCOL = 1;

/** Outcome of {@link waitForRelayExtension}. */
export type RelayWaitOutcome =
	/** `/json/version` answered 200: puppeteer can connect. */
	| { kind: "ready"; relayProtocol: number }
	/** Nothing (or something that is not a relay) is serving the endpoint. */
	| { kind: "unreachable" }
	/** The relay is serving but no extension connected within the dial window. */
	| { kind: "no-extension"; relayProtocol: number }
	/** The connected extension is older than the relay requires; waiting cannot help. */
	| { kind: "incompatible-extension"; version: string; required: string; relayProtocol: number }
	/** An extension is connected but the relay has no binding file yet. */
	| { kind: "profile-unbound"; connectedFingerprint?: string; relayProtocol: number }
	/**
	 * The relay is bound to another Chrome profile's install and rejected the one that dialed. Returned at
	 * once when the bound install was never connected; after the dial window when it was (it may revive).
	 */
	| { kind: "profile-mismatch"; boundFingerprint: string; rejectedFingerprint?: string; relayProtocol: number }
	/** The relay's binding file is unreadable or malformed. */
	| { kind: "profile-invalid"; error: string; relayProtocol: number };

/**
 * Relay protocol advertised by a `/json/version` answer: 200 bodies carry
 * `OMP-Relay-Protocol` (string map), 503 bodies `relayProtocol`. Null when
 * the answer is not a relay answer at all (a 2xx that is not a JSON
 * discovery document, or any other status); an opaque 503 counts as a
 * legacy relay, matching how consumers always adopted it.
 */
export function relayProtocolOf(response: CdpProbeResponse | null): number | null {
	if (response === null) return null;
	const ok = response.status >= 200 && response.status < 300;
	if (!ok && response.status !== 503) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(response.body);
	} catch {
		return ok ? null : LEGACY_RELAY_PROTOCOL;
	}
	if (!isRecord(parsed)) return ok ? null : LEGACY_RELAY_PROTOCOL;
	const raw = ok ? parsed["OMP-Relay-Protocol"] : parsed.relayProtocol;
	const value = typeof raw === "string" ? Number(raw) : raw;
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : LEGACY_RELAY_PROTOCOL;
}

const UNAVAILABLE_REASONS: Record<RelayUnavailableReason, true> = {
	"extension-incompatible": true,
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

/** Parse a 503 body; null for a non-relay body (foreign server). Fields a legacy relay omits get protocol-1 defaults. */
function parseUnavailableInfo(body: string): RelayUnavailableInfo | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || typeof parsed.extensionSeen !== "boolean" || typeof parsed.uptimeMs !== "number") {
		return null;
	}
	const info: RelayUnavailableInfo = {
		error: typeof parsed.error === "string" ? parsed.error : "",
		extensionSeen: parsed.extensionSeen,
		uptimeMs: parsed.uptimeMs,
		relayProtocol: relayProtocolOf({ status: 503, body }) ?? LEGACY_RELAY_PROTOCOL,
		profileBinding: parseProfileBinding(parsed.profileBinding) ?? { state: "unbound" },
	};
	if (typeof parsed.reason === "string" && parsed.reason in UNAVAILABLE_REASONS) {
		info.reason = parsed.reason as RelayUnavailableReason;
	}
	if (typeof parsed.boundSeen === "boolean") info.boundSeen = parsed.boundSeen;
	const incompatible = parsed.extensionIncompatible;
	if (
		isRecord(incompatible) &&
		typeof incompatible.version === "string" &&
		typeof incompatible.required === "string"
	) {
		info.extensionIncompatible = { version: incompatible.version, required: incompatible.required };
	}
	return info;
}

/** Immediate verdict for a 503 the relay attributes to something waiting cannot fix; null when waiting is right. */
function refusalOutcome(info: RelayUnavailableInfo): RelayWaitOutcome | null {
	const relayProtocol = info.relayProtocol;
	switch (info.reason) {
		case "extension-incompatible":
			return info.extensionIncompatible
				? { kind: "incompatible-extension", ...info.extensionIncompatible, relayProtocol }
				: null;
		case "profile-unbound":
			return {
				kind: "profile-unbound",
				...(info.profileBinding.state === "unbound" && info.profileBinding.connectedFingerprint
					? { connectedFingerprint: info.profileBinding.connectedFingerprint }
					: {}),
				relayProtocol,
			};
		case "profile-mismatch":
			return info.profileBinding.state === "bound"
				? {
						kind: "profile-mismatch",
						boundFingerprint: info.profileBinding.boundFingerprint,
						...(info.profileBinding.lastRejected
							? { rejectedFingerprint: info.profileBinding.lastRejected.fingerprint }
							: {}),
						relayProtocol,
					}
				: null;
		case "profile-invalid":
			return {
				kind: "profile-invalid",
				error:
					info.error ||
					(info.profileBinding.state === "invalid" ? info.profileBinding.error : "relay binding file is invalid"),
				relayProtocol,
			};
		case undefined:
			return null;
	}
}

/**
 * Poll the relay at `cdpUrl` until its extension is connected. Gives up
 * immediately when nothing serves the endpoint or the relay refuses the
 * extension that dialed, after one dial window when an extension has
 * connected before (service-worker revival), or as soon as the server has
 * been up a full dial window without ever seeing one.
 */
export async function waitForRelayExtension(cdpUrl: string, signal?: AbortSignal): Promise<RelayWaitOutcome> {
	const probeUrl = `${cdpUrl}/json/version`;
	let deadline = Date.now() + EXTENSION_DIAL_WINDOW_MS;
	let deferred: RelayWaitOutcome | null = null;
	for (;;) {
		throwIfAborted(signal);
		const response = await probeCdpResponse(probeUrl, { timeoutMs: PROBE_TIMEOUT_MS, signal });
		throwIfAborted(signal);
		if (response === null) return { kind: "unreachable" };
		if (response.status >= 200 && response.status < 300) {
			return { kind: "ready", relayProtocol: relayProtocolOf(response) ?? LEGACY_RELAY_PROTOCOL };
		}
		if (response.status !== 503) return { kind: "unreachable" };
		const info = parseUnavailableInfo(response.body);
		if (info) {
			const refused = refusalOutcome(info);
			if (refused) {
				// A rejected intruder while the bound install was connected earlier:
				// that install's service worker may revive within the dial window.
				if (refused.kind === "profile-mismatch" && info.boundSeen) deferred = refused;
				else return refused;
			}
			if (!info.extensionSeen) {
				// Never connected: the window is measured from server start, not from now.
				deadline = Math.min(deadline, Date.now() - info.uptimeMs + EXTENSION_DIAL_WINDOW_MS);
			}
		}
		if (Date.now() >= deadline) {
			return deferred ?? { kind: "no-extension", relayProtocol: info?.relayProtocol ?? LEGACY_RELAY_PROTOCOL };
		}
		await Bun.sleep(POLL_INTERVAL_MS);
	}
}
