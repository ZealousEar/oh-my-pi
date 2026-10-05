/**
 * Local derivation of the bounded action space for one observation.
 *
 * The judge only ever answers with an id from these tables; every executable
 * detail (node, option value, scroll delta) stays here. Heads are built per
 * operation so the operation choice and the target choice can be validated
 * independently, and so an operation with no target is never offered.
 *
 * Shape adapted from jev-ultrafast (MIT) `model.py::action_space`.
 */
import type { JsonValue } from "@oh-my-pi/pi-ai";
import { type ActionCandidate, MAX_CHOICE_OPTIONS, type ObservationIdentity } from "../../../judgment/decision";
import type { TaskActionArgs, TaskControl, TaskOperation, TaskSnapshot } from "./types";

/**
 * Keywords that make an action consequential: money, destruction,
 * transmission, identity, publication, or account state. Matched against the
 * NFKC-normalised, lower-cased name sources of a control (see
 * {@link classifyConsequential}). Matching candidates need explicit
 * `allowConsequential`.
 */
export const CONSEQUENTIAL_LABEL =
	/\b(submit|buy|pay|payment|purchase|checkout|place order|order now|send|delete|remove|confirm|transfer|sign|authorize|approve|accept|agree|unsubscribe|cancel subscription|close account|publish|post|share|upload|save changes|don't save|discard|replace|overwrite|reset|revoke|disconnect|log out|sign out|subscribe|donate|tip|withdraw|deposit)\b/;

/** Reason recorded when a name cannot be read reliably (mixed scripts, confusables). */
export const UNREADABLE_LABEL = "unreadable label";

/**
 * Writing-system families. A name whose letters span more than one family is
 * treated as unreadable: Latin-lookalike letters from another script are the
 * classic way to slip a keyword past an ASCII list. Han/kana/Hangul are one
 * family because Japanese and Korean orthography mix them routinely.
 */
const SCRIPT_FAMILIES: ReadonlyArray<readonly [string, RegExp]> = [
	["latin", /\p{Script=Latin}/u],
	["cyrillic", /\p{Script=Cyrillic}/u],
	["greek", /\p{Script=Greek}/u],
	["armenian", /\p{Script=Armenian}/u],
	["hebrew", /\p{Script=Hebrew}/u],
	["arabic", /\p{Script=Arabic}/u],
	["georgian", /\p{Script=Georgian}/u],
	["ethiopic", /\p{Script=Ethiopic}/u],
	["thai", /\p{Script=Thai}/u],
	[
		"indic",
		/[\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Gujarati}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Gurmukhi}]/u,
	],
	["cjk", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u],
];
/** Latin letters beyond Latin Extended-B (IPA, phonetic small caps, ...) are lookalikes, not orthography. */
const LATIN_ORTHOGRAPHY_END = 0x024f;

/** Map the confusables NFKC leaves alone, drop format characters, unify quotes. */
function normalizeName(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/\p{Cf}/gu, "")
		.replace(/[\u2018\u2019\u02bc`]/g, "'")
		.replace(/\u0131/g, "i")
		.replace(/\u0237/g, "j")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

/** `true` when the letters of a normalised name cannot be read as one writing system. */
function mixedScripts(name: string): boolean {
	const families = new Set<string>();
	for (const char of name) {
		if (!/\p{L}/u.test(char)) continue;
		let family = "other";
		for (const [candidate, pattern] of SCRIPT_FAMILIES) {
			if (pattern.test(char)) {
				family = candidate;
				break;
			}
		}
		const code = char.codePointAt(0) ?? 0;
		if (family === "latin" && code > LATIN_ORTHOGRAPHY_END) family = "other";
		families.add(family);
		if (families.size > 1) return true;
	}
	return false;
}

export interface ConsequenceClassification {
	consequential: boolean;
	/** `matched "<keyword>" in <source>` or {@link UNREADABLE_LABEL}. */
	reason?: string;
}

/**
 * Classify from every name a control carries: accessible name, visible text,
 * `aria-label`, `title`, and for a native select the chosen option. Any one
 * source matching is enough; a name mixing writing systems fails closed.
 */
export function classifyConsequential(sources: Record<string, string | undefined>): ConsequenceClassification {
	for (const source in sources) {
		const raw = sources[source];
		if (!raw) continue;
		const name = normalizeName(raw);
		if (mixedScripts(name)) return { consequential: true, reason: UNREADABLE_LABEL + " (" + source + ")" };
		const match = CONSEQUENTIAL_LABEL.exec(name);
		if (match) return { consequential: true, reason: 'matched "' + match[1] + '" in ' + source };
	}
	return { consequential: false };
}

/** One wheel-scroll step, matching the reference loop's window size. */
export const SCROLL_DELTA = 560;

const CLICK_ROLES = new Set([
	"button",
	"link",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"menuitemradio",
	"menuitemcheckbox",
	"option",
	"gridcell",
	"combobox",
]);
const TEXT_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox"]);
/** State rows sent to the judge; wider than the choice cap so context is honest. */
const ELEMENT_ROW_CAP = 300;

export interface CandidateSet {
	/** Page controls as judgment state: index, role, label, current value/state. */
	elements: JsonValue;
	/** Target candidates per operation. An absent key means the operation has no target. */
	tables: Map<TaskOperation, ActionCandidate<TaskActionArgs>[]>;
	/** `true` when some derived candidate could not be offered. */
	truncated: boolean;
	/** The explicit fallback taken when candidates did not fit. */
	fallback?: string;
}

/** Stable identity for one observation; a candidate from an older revision is stale. */
export function snapshotIdentity(snapshot: TaskSnapshot, scope: string, revision: number): ObservationIdentity {
	return {
		surface: "browser-tab",
		scope,
		revision,
		capturedAt: Date.now(),
		digest: snapshotDigest(snapshot),
	};
}

/**
 * Content digest of what the decision depends on. Geometry is deliberately
 * excluded: an animating page would otherwise force a re-observation every
 * frame, while position is resolved and hit-tested immediately before input.
 */
export function snapshotDigest(snapshot: TaskSnapshot): string {
	const semantics = snapshot.controls.map(control => [
		control.node,
		control.role,
		control.label,
		control.text ?? null,
		control.ariaLabel ?? null,
		control.title ?? null,
		control.value ?? null,
		control.checked ?? null,
		control.selected ?? null,
		control.expanded ?? null,
		control.enabled,
		control.occluded,
	]);
	return Bun.hash(JSON.stringify([snapshot.url, snapshot.title, snapshot.text, semantics])).toString(36);
}

function describeState(control: TaskControl): string {
	const parts: string[] = [];
	if (control.checked !== undefined) parts.push(control.checked ? "checked" : "unchecked");
	if (control.expanded !== undefined) parts.push(control.expanded ? "expanded" : "collapsed");
	if (control.selected !== undefined) parts.push(control.selected ? "selected" : "unselected");
	if (control.multiline) parts.push("multiline");
	if (!control.enabled) parts.push("disabled");
	if (control.occluded) parts.push("covered");
	if (!control.inViewport) parts.push("off-screen");
	return parts.join(",");
}

function candidateFor(
	id: string,
	control: TaskControl,
	operation: TaskOperation,
	option?: { value: string; label: string },
): ActionCandidate<TaskActionArgs> {
	// Every name the control carries, keyed by where it came from.
	const classified = classifyConsequential({
		label: control.label,
		"visible text": control.text,
		"aria-label": control.ariaLabel,
		title: control.title,
		...(option === undefined ? {} : { "option text": option.label }),
	});
	const label = option
		? (control.label || "select") + " -> " + option.label
		: control.label || "(unlabelled " + control.role + ")";
	const rubric = [
		"[" + id + "] " + (option ? "set " + (control.label || "select") + " to " + option.label : label),
		"role=" + control.role,
		// Judges learn whether a field holds something, never what.
		option || control.value === undefined ? "" : control.value.length > 0 ? "filled" : "empty",
		describeState(control) ? "state=" + describeState(control) : "",
		classified.consequential ? "consequential" : "",
	]
		.filter(Boolean)
		.join(" ");
	return {
		id,
		label,
		rubric,
		args: {
			operation,
			node: control.node,
			label,
			role: control.role,
			multiline: control.multiline,
			...(option === undefined ? {} : { value: option.value }),
			consequential: classified.consequential,
			...(classified.reason === undefined ? {} : { consequentialReason: classified.reason }),
		},
	};
}

/**
 * Keep a head inside the documented choice cap. The fallback is explicit and
 * reported: viewport-only windowing first, then a hard slice — never a silent
 * subset.
 */
function windowHead(
	candidates: ActionCandidate<TaskActionArgs>[],
	inViewport: (candidate: ActionCandidate<TaskActionArgs>) => boolean,
): { candidates: ActionCandidate<TaskActionArgs>[]; fallback?: string } {
	if (candidates.length <= MAX_CHOICE_OPTIONS) return { candidates };
	const visible = candidates.filter(inViewport);
	if (visible.length > 0 && visible.length <= MAX_CHOICE_OPTIONS) {
		return {
			candidates: visible,
			fallback:
				"viewport window: " +
				visible.length +
				" of " +
				candidates.length +
				" candidates offered; SCROLL to reach the rest",
		};
	}
	const sliced = (visible.length > 0 ? visible : candidates).slice(0, MAX_CHOICE_OPTIONS);
	return {
		candidates: sliced,
		fallback:
			"document-order window: " +
			sliced.length +
			" of " +
			candidates.length +
			" candidates offered; SCROLL to reach the rest",
	};
}

/**
 * Derive the per-operation target tables and the element rows for one
 * observation. `exclude` withholds candidates the loop has quarantined; a
 * withheld candidate is neither offered nor listed as an operation of its row.
 */
export function deriveCandidates(
	snapshot: TaskSnapshot,
	exclude: (candidate: ActionCandidate<TaskActionArgs>) => boolean = () => false,
): CandidateSet {
	const rows: JsonValue[] = [];
	const click: ActionCandidate<TaskActionArgs>[] = [];
	const type: ActionCandidate<TaskActionArgs>[] = [];
	const select: ActionCandidate<TaskActionArgs>[] = [];
	const viewportIds = new Set<string>();
	let index = 0;
	for (const control of snapshot.controls) {
		// Hidden controls never reach here (the reader drops them). Disabled and
		// covered controls are described but never offered: input would fail.
		const actionable = control.enabled && !control.occluded;
		const id = actionable ? "e" + String(++index) : undefined;
		const operations: string[] = [];
		if (id) {
			if (control.inViewport) viewportIds.add(id);
			if (control.role === "select") {
				const before = select.length;
				for (const [position, option] of (control.options ?? []).entries()) {
					if (option.disabled) continue;
					const optionId = id + "o" + String(position + 1);
					const candidate = candidateFor(optionId, control, "SELECT", option);
					if (exclude(candidate)) continue;
					if (control.inViewport) viewportIds.add(optionId);
					select.push(candidate);
				}
				if (select.length > before) operations.push("SELECT");
			} else {
				if (CLICK_ROLES.has(control.role)) {
					const candidate = candidateFor(id, control, "CLICK");
					if (!exclude(candidate)) {
						click.push(candidate);
						operations.push("CLICK");
					}
				}
				if (TEXT_ROLES.has(control.role)) {
					const candidate = candidateFor(id, control, "TYPE_TEXT");
					if (!exclude(candidate)) {
						type.push(candidate);
						operations.push("TYPE_TEXT");
					}
				}
			}
		}
		if (rows.length < ELEMENT_ROW_CAP) {
			const row: Record<string, JsonValue> = {
				role: control.role,
				label: control.label,
				operations,
			};
			if (id) row.id = id;
			if (control.text !== undefined && control.text !== control.label) row.text = control.text;
			if (control.value !== undefined) row.filled = control.value.length > 0;
			if (control.placeholder !== undefined) row.placeholder = control.placeholder;
			const state = describeState(control);
			if (state) row.state = state;
			if (!id) row.note = control.occluded ? "covered by another element" : "disabled";
			rows.push(row);
		}
	}

	const tables = new Map<TaskOperation, ActionCandidate<TaskActionArgs>[]>();
	const fallbacks: string[] = [];
	const inViewport = (candidate: ActionCandidate<TaskActionArgs>): boolean => viewportIds.has(candidate.id);
	for (const [operation, candidates] of [
		["CLICK", click],
		["TYPE_TEXT", type],
		["SELECT", select],
	] as const) {
		if (candidates.length === 0) continue;
		const windowed = windowHead(candidates, inViewport);
		if (windowed.fallback) fallbacks.push(operation + ": " + windowed.fallback);
		tables.set(operation, windowed.candidates);
	}

	const scroll: ActionCandidate<TaskActionArgs>[] = [];
	if (snapshot.scrollable.down) {
		scroll.push({
			id: "down",
			label: "Scroll down",
			rubric: "Scroll the page down one viewport",
			args: { operation: "SCROLL", label: "Scroll down", deltaY: SCROLL_DELTA },
		});
	}
	if (snapshot.scrollable.up) {
		scroll.push({
			id: "up",
			label: "Scroll up",
			rubric: "Scroll the page up one viewport",
			args: { operation: "SCROLL", label: "Scroll up", deltaY: -SCROLL_DELTA },
		});
	}
	if (scroll.length > 0) tables.set("SCROLL", scroll);

	if (snapshot.omittedControls > 0) {
		fallbacks.push("reader cap: " + snapshot.omittedControls + " further controls were not read");
	}
	return {
		elements: rows,
		tables,
		truncated: fallbacks.length > 0,
		...(fallbacks.length > 0 ? { fallback: fallbacks.join("; ") } : {}),
	};
}
