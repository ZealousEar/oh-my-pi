/**
 * Relay ↔ Chrome-profile binding.
 *
 * One relay URL is not one Chrome cookie jar: the same unpacked extension
 * loaded in another Chrome profile (or instance) dials the same relay and
 * would silently replace the approved profile's extension. The binding file
 * (`~/.omp/browser-relay/binding.json`, mode 0600) names the ONE extension
 * install the relay may become ready for; the bridge re-reads it on every
 * hello and every readiness query, so `bind`/`unbind` take effect without a
 * relay restart. Same-OS-user tampering (rewriting this file, the extension's
 * storage, or the loopback `/omp/binding` endpoint) is outside the claim.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getBrowserRelayDir, isEnoent, isRecord } from "@oh-my-pi/pi-utils";

/** On-disk shape of the binding file. */
export interface RelayBinding {
	/** Extension install id (`chrome.storage.local` UUID reported in `hello`). */
	installId: string;
	/** ISO 8601 timestamp of the bind. */
	boundAt: string;
	note?: string;
}

/** Binding as the bridge sees it at one instant. */
export type RelayBindingState =
	| { state: "unbound" }
	| { state: "bound"; binding: RelayBinding }
	| { state: "invalid"; error: string };

/** Default binding file: profile-independent, next to the installed extension. */
export function defaultRelayBindingPath(): string {
	return path.join(getBrowserRelayDir(), "binding.json");
}

/** Read the binding file synchronously (the caller is inside websocket message handling and must not reorder messages). */
export function readRelayBinding(bindingPath: string): RelayBindingState {
	let text: string;
	try {
		text = fs.readFileSync(bindingPath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return { state: "unbound" };
		const message = error instanceof Error ? error.message : String(error);
		return { state: "invalid", error: `cannot read ${bindingPath}: ${message}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { state: "invalid", error: `${bindingPath} is not JSON: ${message}` };
	}
	if (!isRecord(parsed) || typeof parsed.installId !== "string" || parsed.installId.trim().length === 0) {
		return { state: "invalid", error: `${bindingPath} has no installId` };
	}
	if (typeof parsed.boundAt !== "string") {
		return { state: "invalid", error: `${bindingPath} has no boundAt` };
	}
	const binding: RelayBinding = { installId: parsed.installId, boundAt: parsed.boundAt };
	if (typeof parsed.note === "string") binding.note = parsed.note;
	return { state: "bound", binding };
}
