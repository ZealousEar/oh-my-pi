/**
 * Local candidate derivation for `computer.task`.
 *
 * Every action the judge may pick is derived here from exactly one
 * {@link DesktopObservation}: ids are positional within that observation, and
 * the executable arguments (ref, AX action name, authorized text) are attached
 * locally. Nothing in this module consults a model.
 *
 * Two bounds matter. Consequential actions are withheld unless the caller
 * passed `allowConsequential`, and the node list is windowed by lexical
 * relevance to the goal before it is ranked by the judge - the window and the
 * total are both reported, so a truncated candidate set is never silent.
 */
import type { ActionCandidate } from "../../../judgment/decision";
import { DIALOG_ROLES } from "./observation";
import type { DesktopActionArgs, DesktopNode, DesktopObservation } from "./types";

/** Roles whose primary interaction is a press/click. */
const ACTIONABLE_ROLES = new Set([
	"button",
	"checkbox",
	"radio",
	"menuitem",
	"menubaritem",
	"link",
	"tab",
	"popupbutton",
	"combobox",
	"listitem",
	"outlineitem",
	"cell",
	"disclosuretriangle",
	"togglebutton",
]);

/** Roles that accept a text value through the accessibility API. */
const EDITABLE_ROLES = new Set(["textfield", "textarea", "searchfield", "combobox", "securetextfield"]);

/** Roles that expose no actionable structure; a window made only of these needs pixels, not AX. */
const VISUAL_ONLY_ROLES = new Set(["image", "canvas", "unknown", "splitter", "statictext", "progressindicator"]);

/**
 * Labels naming an irreversible or externally visible effect. Matched against
 * the node's own label (title, description) anywhere in the window and
 * withheld unless the caller explicitly authorized consequential actions.
 */
const CONSEQUENTIAL_LABEL =
	/\b(send|sends|sending|reply|forward|post|publish|tweet|share|submit|confirm|accept|agree|pay|payment|purchase|buy|checkout|order|subscribe|unsubscribe|transfer|withdraw|delete|remove|erase|trash|discard|destroy|wipe|format|reset|revert|revoke|uninstall|shut\s?down|restart|log\s?out|sign\s?out|quit|close\s+(window|tab|all)|empty\s+(trash|cache|bin)|move\s+to\s+trash|don'?t\s+save|do\s+not\s+save|allow|grant|install|approve|apply\s+changes|save\s+and\s+send)\b/i;

/**
 * Dialog text that turns every committing button of that dialog into a
 * consequential action, whatever the button is called.
 */
const CONSEQUENTIAL_DIALOG_TEXT =
	/\b(delete|remove|erase|trash|discard|unsaved|permanently|cannot\s+be\s+undone|can'?t\s+be\s+undone|lose|lost|replace|overwrite|quit|send|pay|purchase|transfer|revoke|reset|uninstall|sign\s+out|log\s+out|empty)\b/i;

/**
 * Generic confirmation labels that are harmless on a toolbar but commit
 * whatever a sheet/dialog/alert proposes ("Don't Save", "Replace", "OK" on a
 * delete confirmation). Consequential only inside such a container.
 */
const GENERIC_CONFIRM_LABEL =
	/^(ok|okay|yes|yes\s+to\s+all|continue|proceed|done|apply|save|don'?t\s+save|do\s+not\s+save|replace|overwrite|merge|move|delete|remove|empty|close|close\s+tab|revert|revert\s+to\s+saved|unsubscribe|leave|leave\s+page|discard\s+changes|keep|stop|end|finish|go|next|got\s+it)\W*$/i;

/** Labels that dismiss a dialog without committing it; never consequential by position alone. */
const DISMISS_LABEL =
	/^(cancel|dismiss|not\s+now|later|no|no\s+thanks|keep\s+editing|back|go\s+back|close\s+dialog)\W*$/i;

/** Roles whose text describes what a dialog is about to do. */
const TEXT_ROLES: Readonly<Record<string, true>> = { statictext: true, heading: true, text: true };

/** Roles whose value is a secret: never labelled by value, never shown to a model. */
const SECURE_ROLE = /secure|password|passcode/i;

/** Whether a role carries a secret value. */
export function isSecureNode(node: DesktopNode): boolean {
	return SECURE_ROLE.test(node.role) || SECURE_ROLE.test(node.nativeRole);
}

/**
 * NFKC-normalise a label. A label mixing Latin with another letter script, or
 * carrying invisible format characters, can render as one word while reading
 * as another; such labels are treated as consequential rather than trusted.
 */
export function normaliseLabel(label: string): { text: string; confusable: boolean } {
	const normalised = label.normalize("NFKC");
	const latin = /\p{Script=Latin}/u.test(normalised);
	const other = /(?=\p{L})(?!\p{Script=Latin})(?!\p{Script=Common})(?!\p{Script=Inherited})./u.test(normalised);
	const invisible = INVISIBLE_CHARS.test(normalised);
	return { text: normalised.replace(INVISIBLE_CHARS_ALL, ""), confusable: (latin && other) || invisible };
}

/** Format characters and zero-width code points that never belong in a display label. */
const INVISIBLE_CHARS = /[\p{Cf}\u200b-\u200f\u2060-\u2064\ufeff]/u;
const INVISIBLE_CHARS_ALL = /[\p{Cf}\u200b-\u200f\u2060-\u2064\ufeff]/gu;

/** Maximum node-derived candidates shown to the judge in one decision. */
export const MAX_NODE_CANDIDATES = 40;

/** Reserved control candidate ids. */
export const CONTROL_IDS = {
	reobserve: "reobserve",
	wait: "wait",
	done: "done",
	blocked: "blocked",
	abstain: "abstain",
} as const;

export type DesktopCandidate = ActionCandidate<DesktopActionArgs>;

export interface DeriveInput {
	observation: DesktopObservation;
	goal: string;
	values?: Record<string, string>;
	allowConsequential: boolean;
	/** {@link candidateSignature} values already attempted; excluded so an `unknown` outcome cannot be blindly retried. */
	exclude?: ReadonlySet<string>;
}

export interface DerivedCandidates {
	candidates: DesktopCandidate[];
	/** Consequential actions withheld from the judge, by label. */
	gated: string[];
	/** Node-derived candidates offered. */
	shown: number;
	/** Node-derived candidates available before windowing. */
	total: number;
	/** Window exposes no actionable or editable node at all. */
	visualOnly: boolean;
	/** Editable nodes whose text must be resolved by the small-model route at execution time. */
	pendingValues: number;
	/** Editable nodes whose current value already equals the caller value; never offered. */
	satisfied: string[];
}

/** Whether a field already holds the authorized text, ignoring surrounding whitespace and a trailing newline. */
export function alreadyHoldsValue(node: DesktopNode, text: string): boolean {
	if (node.value === undefined) return false;
	return node.value.replace(/\r?\n$/, "").trim() === text.replace(/\r?\n$/, "").trim();
}

/** Display label of a node: title, else description, else its value (never a secret value). */
export function nodeLabel(node: DesktopNode): string {
	const value = isSecureNode(node) ? undefined : node.value?.trim();
	return normaliseLabel(node.title?.trim() || node.description?.trim() || value || node.role).text.slice(0, 120);
}

/**
 * What a window's dialog context looks like for the gate: whether any node
 * sits in a sheet/dialog/alert and what those containers say. The native
 * backend exposes no ancestry, so a dialog role anywhere in the observation
 * marks the whole observation; static text is read only in that case.
 */
export interface DialogContext {
	present: boolean;
	/** Dialog text names a destructive or externally visible effect. */
	destructive: boolean;
}

export function dialogContext(observation: DesktopObservation): DialogContext {
	const present = observation.nodes.some(
		node =>
			Object.hasOwn(DIALOG_ROLES, node.role) ||
			(node.container !== undefined && Object.hasOwn(DIALOG_ROLES, node.container)),
	);
	if (!present) return { present: false, destructive: false };
	const text = observation.nodes
		.filter(node => Object.hasOwn(TEXT_ROLES, node.role))
		.map(node => `${node.title ?? ""} ${node.description ?? ""} ${node.value ?? ""}`)
		.join("\n");
	return {
		present: true,
		destructive: CONSEQUENTIAL_DIALOG_TEXT.test(text) || CONSEQUENTIAL_DIALOG_TEXT.test(observation.window.title),
	};
}

/**
 * Whether a node's action is consequential: its own label names an effect,
 * its label cannot be read at face value, or it commits a dialog (a generic
 * confirm label inside a sheet/dialog/alert, or any non-dismiss button of a
 * dialog whose text is destructive).
 */
export function isConsequentialNode(
	node: DesktopNode,
	context: DialogContext = { present: false, destructive: false },
): boolean {
	const own = normaliseLabel(`${node.title ?? ""} ${node.description ?? ""}`);
	if (own.confusable || CONSEQUENTIAL_LABEL.test(own.text)) return true;
	const inDialog = context.present || (node.container !== undefined && Object.hasOwn(DIALOG_ROLES, node.container));
	if (!inDialog) return false;
	const label = nodeLabel(node);
	if (DISMISS_LABEL.test(label)) return false;
	return GENERIC_CONFIRM_LABEL.test(label) || context.destructive;
}

/** Native AX action names for a press and for scrolling a node into view, when advertised. */
const PRESS_ACTION = /^(ax)?(press|pick|confirm)$/i;
const SCROLL_ACTION = /scrolltovisible/i;

/** Whether a frame lies (at least partly) inside the window rectangle. */
export function frameWithinWindow(node: DesktopNode, observation: DesktopObservation): boolean {
	const frame = node.frame;
	if (!frame) return true;
	const bounds = observation.window.bounds;
	if (bounds.width <= 0 || bounds.height <= 0) return true;
	return (
		frame.x + frame.width > bounds.x &&
		frame.y + frame.height > bounds.y &&
		frame.x < bounds.x + bounds.width &&
		frame.y < bounds.y + bounds.height
	);
}

/** Caller-authorized text for an editable node, matched by title, description, or role. */
export function matchCallerValue(
	node: DesktopNode,
	values: Record<string, string> | undefined,
	editableCount: number,
): { key: string; text: string } | undefined {
	if (!values) return undefined;
	const entries = Object.entries(values);
	if (entries.length === 0) return undefined;
	const labels = [node.title, node.description, node.role]
		.filter((label): label is string => typeof label === "string" && label.trim().length > 0)
		.map(label => label.trim().toLowerCase());
	for (const [key, text] of entries) {
		const needle = key.trim().toLowerCase();
		if (labels.includes(needle)) return { key, text };
	}
	for (const [key, text] of entries) {
		const needle = key.trim().toLowerCase();
		if (labels.some(label => label.includes(needle) || needle.includes(label))) return { key, text };
	}
	// A single authorized value and a single editable field is unambiguous.
	if (entries.length === 1 && editableCount === 1) {
		const [key, text] = entries[0]!;
		return { key, text };
	}
	return undefined;
}

const WORD = /[a-z0-9]+/g;

function tokens(text: string): string[] {
	return text.toLowerCase().match(WORD) ?? [];
}

/**
 * Lexical relevance of a node to the goal: the first pass of the two-pass
 * window-then-rank protocol. Ties keep observation order, so the window is
 * deterministic.
 */
function relevance(node: DesktopNode, goalTokens: ReadonlySet<string>): number {
	let score = 0;
	for (const token of tokens(`${node.title ?? ""} ${node.description ?? ""} ${node.value ?? ""}`)) {
		if (goalTokens.has(token)) score += 2;
	}
	if (node.focused) score += 1;
	return score;
}

/**
 * Stable identity of an action across observations: kind plus the node's role
 * and label. Accessibility refs are registration-scoped — a fresh query hands
 * the same element a new ref — so retry suppression and revalidation key on
 * this instead of the ref.
 */
export function candidateSignature(args: DesktopActionArgs): string {
	return `${args.kind}:${args.role ?? "-"}:${args.title ?? "-"}`;
}

/**
 * Re-locate a candidate's target in a fresh observation: the ref when it still
 * resolves, otherwise the unique node with the same role and label. Ambiguity
 * is stale, never a guess.
 */
export function locateNode(
	observation: DesktopObservation,
	args: DesktopActionArgs,
): { node: DesktopNode } | { reason: string } {
	const byRef = observation.nodes.find(candidate => candidate.ref === args.ref);
	if (byRef) return { node: byRef };
	const matches = observation.nodes.filter(
		candidate => candidate.role === args.role && nodeLabel(candidate) === args.title,
	);
	if (matches.length === 1) return { node: matches[0]! };
	if (matches.length === 0) return { reason: "element is no longer present" };
	return { reason: `${matches.length} elements now match ${args.role} ${JSON.stringify(args.title ?? "")}` };
}

/** Derive the bounded candidate set for one observation. */
export function deriveCandidates(input: DeriveInput): DerivedCandidates {
	const { observation, values, allowConsequential } = input;
	const exclude = input.exclude ?? new Set<string>();
	const goalTokens = new Set([...tokens(input.goal), ...Object.keys(values ?? {}).flatMap(tokens)]);
	const editableCount = observation.nodes.filter(node => EDITABLE_ROLES.has(node.role)).length;
	const context = dialogContext(observation);

	interface Derived {
		order: number;
		score: number;
		candidate: DesktopCandidate;
	}
	const derived: Derived[] = [];
	const gated: string[] = [];
	const satisfied: string[] = [];
	let pendingValues = 0;
	let order = 0;

	for (const node of observation.nodes) {
		const editable = EDITABLE_ROLES.has(node.role);
		const press = node.actions.find(action => PRESS_ACTION.test(action));
		const actionable = ACTIONABLE_ROLES.has(node.role) || press !== undefined;
		if (!editable && !actionable) continue;
		if (!node.enabled) continue;
		const label = nodeLabel(node);
		// A dialog's destructive text gates its committing buttons, not its text fields.
		if (!allowConsequential && isConsequentialNode(node, editable ? undefined : context)) {
			gated.push(label);
			continue;
		}
		const id = `a${order + 1}`;
		order++;
		const offscreen = !frameWithinWindow(node, observation);
		const scroll = node.actions.find(action => SCROLL_ACTION.test(action));
		let args: DesktopActionArgs;
		let text: string;
		if (offscreen && scroll) {
			args = { kind: "scroll-to-visible", ref: node.ref, role: node.role, title: label, axAction: scroll };
			text = `scroll ${node.role} "${label}" into view`;
		} else if (editable) {
			const matched = matchCallerValue(node, values, editableCount);
			if (matched) {
				// An idempotent no-op is not an action: a field that already holds
				// the authorized value is never offered (the loop would otherwise
				// re-dispatch it every time the judge picks it).
				if (alreadyHoldsValue(node, matched.text)) {
					satisfied.push(label);
					continue;
				}
				args = {
					kind: "set-value",
					ref: node.ref,
					role: node.role,
					title: label,
					text: matched.text,
					valueKey: matched.key,
				};
				// Show the authorized value itself: without it the judge cannot tell
				// whether writing this field advances the goal.
				text = `set ${node.role} "${label}" to the caller value "${matched.key}" = ${JSON.stringify(matched.text.slice(0, 80))}`;
			} else {
				args = { kind: "set-value", ref: node.ref, role: node.role, title: label };
				pendingValues++;
				text = `set ${node.role} "${label}" to a value derived from the goal`;
			}
		} else if (press) {
			args = { kind: "press", ref: node.ref, role: node.role, title: label, axAction: press };
			text = `press ${node.role} "${label}"`;
		} else {
			args = { kind: "click", ref: node.ref, role: node.role, title: label };
			text = `click ${node.role} "${label}"`;
		}
		if (exclude.has(candidateSignature(args))) continue;
		derived.push({ order, score: relevance(node, goalTokens), candidate: { id, label: text, args } });
	}

	const total = derived.length;
	derived.sort((left, right) => right.score - left.score || left.order - right.order);
	const windowed = derived.slice(0, MAX_NODE_CANDIDATES).sort((left, right) => left.order - right.order);
	const candidates = windowed.map(entry => entry.candidate);

	const visualOnly =
		total === 0 && observation.nodes.every(node => VISUAL_ONLY_ROLES.has(node.role) || node.actions.length === 0);

	candidates.push(
		{
			id: CONTROL_IDS.reobserve,
			label: "re-read the window's accessibility state before acting",
			args: { kind: "reobserve" },
		},
		{
			id: CONTROL_IDS.wait,
			label: "wait briefly for the window to settle, then re-read it",
			args: { kind: "wait", waitMs: 400 },
		},
		{
			id: CONTROL_IDS.done,
			label: "claim the goal is already satisfied (independently verified afterwards)",
			args: { kind: "done" },
		},
		{
			id: CONTROL_IDS.blocked,
			label: "report that no available action can advance the goal",
			args: { kind: "blocked" },
		},
		{
			id: CONTROL_IDS.abstain,
			label: "abstain: the goal is ambiguous or not exposed by this window",
			args: { kind: "abstain" },
		},
	);

	return { candidates, gated, satisfied, shown: candidates.length - 5, total, visualOnly, pendingValues };
}
