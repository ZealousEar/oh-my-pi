/**
 * Turns one `window.observe()` payload into a {@link DesktopObservation} with a
 * stable identity: a monotonic revision plus a content digest over the fields
 * an action can change. Equal digests mean the window did not meaningfully
 * change, which is what distinguishes an applied action from a no-op and what
 * reconciles an `unknown` outcome.
 */
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { DesktopNode, DesktopObservation, DesktopWindowInfo } from "./types";

/** Surface name every desktop observation identity carries. */
export const DESKTOP_SURFACE = "desktop-window";

/** Upper bound on nodes carried into a judgment state, independent of the native query cap. */
export const MAX_OBSERVED_NODES = 200;

/** Validated `window.observe()` payload; `window` is null once the window is gone. */
export interface RawObservation {
	window: DesktopWindowInfo | null;
	nodes: DesktopNode[];
	/** Nodes the native query returned, before local filtering. */
	nodeCount: number;
	truncated: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseWindow(value: unknown): DesktopWindowInfo | null {
	const source = record(value);
	const bounds = source ? record(source.bounds) : undefined;
	if (!source || !bounds || typeof source.id !== "string") return null;
	return {
		id: source.id,
		app: typeof source.app === "string" ? source.app : "",
		title: typeof source.title === "string" ? source.title : "",
		pid: optionalNumber(source.pid),
		bounds: {
			x: optionalNumber(bounds.x) ?? 0,
			y: optionalNumber(bounds.y) ?? 0,
			width: optionalNumber(bounds.width) ?? 0,
			height: optionalNumber(bounds.height) ?? 0,
		},
		focused: source.focused === true,
	};
}

function parseNode(value: unknown): DesktopNode | undefined {
	const source = record(value);
	if (!source || typeof source.ref !== "string" || typeof source.role !== "string") return undefined;
	const x = optionalNumber(source.x);
	const y = optionalNumber(source.y);
	const width = optionalNumber(source.width);
	const height = optionalNumber(source.height);
	return {
		ref: source.ref,
		role: source.role,
		nativeRole: typeof source.nativeRole === "string" ? source.nativeRole : source.role,
		title: optionalString(source.title),
		description: optionalString(source.description),
		value: optionalString(source.value),
		enabled: source.enabled !== false,
		focused: source.focused === true,
		childCount: optionalNumber(source.childCount) ?? 0,
		frame:
			x !== undefined && y !== undefined && width !== undefined && height !== undefined
				? { x, y, width, height }
				: undefined,
		actions: Array.isArray(source.actions)
			? source.actions.filter((action): action is string => typeof action === "string")
			: [],
	};
}

/** Validate the worker payload; a malformed payload is a hard error, never an empty tree. */
export function parseRawObservation(value: unknown): RawObservation {
	const source = record(value);
	if (!source || !Array.isArray(source.nodes)) {
		throw new ToolError("computer.task: window.observe() returned an unreadable payload");
	}
	const nodes: DesktopNode[] = [];
	for (const entry of source.nodes) {
		const parsed = parseNode(entry);
		if (parsed) nodes.push(parsed);
	}
	return {
		window: parseWindow(source.window),
		nodes,
		nodeCount: optionalNumber(source.nodeCount) ?? nodes.length,
		truncated: source.truncated === true,
	};
}

/**
 * Digest over exactly the node fields an action can change, plus the window
 * title. Window focus is deliberately excluded: a focus flicker between
 * dispatch and re-observation is not an effect of the action.
 */
export function observationDigest(window: DesktopWindowInfo, nodes: readonly DesktopNode[]): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(window.title);
	for (const node of nodes) {
		const frame = node.frame;
		hasher.update(
			`\n${node.role}|${node.title ?? ""}|${node.value ?? ""}|${node.enabled ? 1 : 0}|${node.focused ? 1 : 0}|` +
				`${frame ? `${frame.x},${frame.y},${frame.width},${frame.height}` : ""}`,
		);
	}
	return hasher.digest("hex").slice(0, 32);
}

/** Container roles retained even without a label: they tell the consequential gate a dialog is up. */
export const DIALOG_ROLES: Readonly<Record<string, true>> = {
	sheet: true,
	dialog: true,
	alert: true,
	systemdialog: true,
};

/**
 * Build the observation one candidate list is derived from. Nodes with neither
 * an identity nor an action are dropped (they cannot be described to a judge
 * and cannot be acted on), except sheet/dialog/alert containers, whose mere
 * presence changes what a generic confirm button means.
 */
export function buildObservation(raw: RawObservation, revision: number): DesktopObservation | undefined {
	const window = raw.window;
	if (!window) return undefined;
	const nodes: DesktopNode[] = [];
	let dropped = 0;
	for (const node of raw.nodes) {
		const identified = Boolean(node.title?.trim() || node.description?.trim() || node.value?.trim());
		if (!identified && node.actions.length === 0 && !Object.hasOwn(DIALOG_ROLES, node.role)) continue;
		if (nodes.length >= MAX_OBSERVED_NODES) {
			dropped++;
			continue;
		}
		nodes.push(node);
	}
	return {
		identity: {
			surface: DESKTOP_SURFACE,
			scope: window.id,
			revision,
			capturedAt: Date.now(),
			digest: observationDigest(window, nodes),
		},
		window,
		nodes,
		nodeCount: raw.nodeCount,
		truncated: raw.truncated || dropped > 0,
	};
}
