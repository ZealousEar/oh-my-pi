/**
 * Automation action policy — the single authority for browser (relay, headless,
 * connected, spawned) and desktop (computer / Cua) actions.
 *
 * Read-only by default. Observation is always allowed; ordinary navigation is
 * allowed only on an OMP-owned tab. Ordinary mutation grants bind exact surface, target, and action.
 * Raw code is never target-confined: it requires a separate whole-browser/
 * whole-desktop capability or a fingerprint of the exact dispatched source.
 * Desktop control of a browser app is app-wide and requires its own explicit
 * broad acknowledgement. Nothing else grants: Jev/TypeSafe judgments select
 * candidates, they never authorize; `tools.approvalMode: yolo` does not apply.
 *
 * Browser/desktop hosts import {@link decideAutomationAction} /
 * {@link AutomationAction} and call it before every dispatch; the eval prelude
 * seam (`invokeEvalPrelude`) turns an {@link AutomationDeniedError} into the
 * exact-scope approval prompt. Exported names and signatures are the contract.
 */
import { rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireFileLock, type FileLockHandle, getGlobalDaemonRuntimeDir } from "@oh-my-pi/pi-utils";

export type AutomationSurface = "browser" | "computer";

/**
 * read      — observe/ARIA/extract/screenshot/status/list; never changes page or desktop state.
 * navigate  — open/goto/back/forward/reload/scroll/focus/activate/close of an OMP-OWNED tab.
 * mutate    — anything that can change remote or local state: click/type/fill/press/select/
 *             drag/upload/download/keyboard/mouse/clipboard-write, raw run/evaluate/CDP,
 *             desktop input, closing a tab OMP does not own.
 */
export type AutomationTier = "read" | "navigate" | "mutate";

export interface AutomationAction {
	surface: AutomationSurface;
	tier: AutomationTier;
	/** Stable verb id: `browser.tab.type`, `browser.tab.run`, `browser.cdp`, `computer.click`, ... */
	action: string;
	/**
	 * Browser: exact origin `scheme://host[:port]` of the page the action targets
	 * (`about:blank` for none). Computer: app bundle id or window title owner.
	 */
	target: string;
	/** Consequential per the task candidate classifiers (submit/buy/pay/send/delete/account/security). */
	consequential: boolean;
	/** Arbitrary code/CDP/desktop-helper access (`tab.run`, `evaluate`, raw Puppeteer, `computer.run`). Always `mutate`. */
	raw: boolean;
	/** Human-readable summary for prompts and audit logs. MUST NOT contain secrets or typed values. */
	summary: string;
	/** Fingerprint of the value being entered (sha256 prefix) so a changed value needs fresh approval; never the value. */
	valueFingerprint?: string;
	/** Fingerprint of the exact arbitrary source dispatched by a raw action. */
	codeFingerprint?: string;
	/** Browser tab ownership at dispatch time. Only an authoritative `true` may receive the navigation allowance. */
	ownsTarget?: boolean;
	/** Eval-prelude invocation identity. Interactive once scopes bind to this exact invocation. */
	invocationId?: string;
	/** Root desktop input is machine-wide rather than confined to the focused application. */
	desktopWide?: boolean;
}

export interface AutomationScope {
	id: string;
	surface: AutomationSurface;
	/** Exact targets for ordinary actions. Raw capability fields are intentionally not target-confined. No wildcards. */
	targets: readonly string[];
	/** Verb ids or `"*"` (all non-raw verbs). `raw` verbs must be listed explicitly. */
	actions: readonly string[];
	/** Whether consequential actions are covered. */
	consequential: boolean;
	/** Whether `valueFingerprint`-bearing actions are bound to specific fingerprints (undefined = any value). */
	valueFingerprints?: readonly string[];
	/** Explicit capability for raw code over the entire browser identity or desktop, never one target. */
	rawAccess?: "broad";
	/** Exact arbitrary source fingerprints allowed across the entire browser identity or desktop. */
	codeFingerprints?: readonly string[];
	/** Explicit acknowledgement that desktop control of a browser application is app-wide, not site-confined. */
	browserAppAccess?: "broad";
	/** Explicit acknowledgement that root mouse/keyboard input can reach any desktop application. */
	desktopAccess?: "broad";
	/** Epoch ms; expired scopes never authorize. */
	expiresAt: number;
	grantedAt: number;
	/** Only users grant scopes. */
	grantedBy: "user";
	/** Free-form owner task description for the audit trail. */
	task?: string;
	/** Interactive "Approve once" scopes are removed by the prelude after its one retry. */
	once?: boolean;
	/** Eval-prelude invocation that an interactive once scope may authorize. */
	invocationId?: string;
}

export type AutomationVerdict =
	| { verdict: "allow"; reason: string; scopeId?: string }
	| {
			verdict: "deny";
			reason: string;
			needsScope: Omit<AutomationScope, "id" | "grantedAt" | "grantedBy" | "expiresAt">;
	  };

export interface AutomationPolicyContext {
	scopes: readonly AutomationScope[];
	now: number;
}

/** Default lifetime of an interactively granted scope. */
export const DEFAULT_SCOPE_TTL_MS = 60 * 60_000;

/** Settings shape accepted by `browser.permissions.grants` and `computer.permissions.grants`. */
export interface AutomationConfiguredGrant {
	targets: readonly string[];
	actions: readonly string[];
	consequential?: boolean;
	ttlMinutes?: number;
	task?: string;
	valueFingerprints?: readonly string[];
	rawAccess?: "broad";
	codeFingerprints?: readonly string[];
	browserAppAccess?: "broad";
	desktopAccess?: "broad";
}

/** Input accepted by {@link grantAutomationScope}; identity and timestamps are minted here. */
export type AutomationScopeGrant = Omit<AutomationScope, "id" | "grantedAt" | "grantedBy" | "expiresAt"> & {
	expiresAt?: number;
	ttlMs?: number;
};

interface SessionScopes {
	interactive: Map<string, AutomationScope>;
	configuredSince: number;
}

const SESSION_SCOPES = new WeakMap<object, SessionScopes>();

function sessionScopes(session: object, now: number): SessionScopes {
	let state = SESSION_SCOPES.get(session);
	if (!state) {
		state = { interactive: new Map(), configuredSince: now };
		SESSION_SCOPES.set(session, state);
	}
	return state;
}

function exactTarget(surface: AutomationSurface, target: unknown): target is string {
	if (typeof target !== "string" || target.length === 0 || target.includes("*")) return false;
	if (surface === "computer" || target === "about:blank" || target === "file:") return true;
	try {
		const url = new URL(target);
		return url.origin !== "null" && url.origin === target;
	} catch {
		return false;
	}
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return strings.length === value.length ? strings : undefined;
}

function rawSetting(layer: unknown, path: string): unknown {
	if (layer === null || typeof layer !== "object" || Array.isArray(layer)) return undefined;
	const root = layer as Record<string, unknown>;
	if (Object.hasOwn(root, path)) return root[path];
	let current: unknown = root;
	for (const segment of path.split(".")) {
		if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
		const record = current as Record<string, unknown>;
		if (!Object.hasOwn(record, segment)) return undefined;
		current = record[segment];
	}
	return current;
}

function configuredScopes(
	session: object,
	surface: AutomationSurface,
	state: SessionScopes,
	now: number,
): AutomationScope[] {
	const candidate = session as { settings?: unknown };
	const settings = candidate.settings;
	if (settings === null || typeof settings !== "object") return [];
	const trustedAccessor = Reflect.get(settings, "getTrustedCapabilitySettings");
	const globalAccessor = Reflect.get(settings, "getGlobalSettings");
	const accessor = typeof trustedAccessor === "function" ? trustedAccessor : globalAccessor;
	if (typeof accessor !== "function") return [];
	// Capability settings deliberately exclude project layers. Explicit CLI
	// overlays and runtime overrides are trusted user input and are included by
	// Settings#getTrustedCapabilitySettings.
	const trustedSettings = Reflect.apply(accessor, settings, []) as unknown;
	const configured = rawSetting(trustedSettings, `${surface}.permissions.grants`);
	if (!Array.isArray(configured)) return [];
	const scopes: AutomationScope[] = [];
	for (const [index, entry] of configured.entries()) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const grant = entry as Record<string, unknown>;
		const targets = stringList(grant.targets);
		const actions = stringList(grant.actions);
		if (!targets || !actions || !targets.every(target => exactTarget(surface, target))) continue;
		const configuredTtl = grant.ttlMinutes;
		if (
			configuredTtl !== undefined &&
			(typeof configuredTtl !== "number" || !Number.isFinite(configuredTtl) || configuredTtl <= 0)
		) {
			continue;
		}
		const ttlMinutes = typeof configuredTtl === "number" ? configuredTtl : undefined;
		const expiresAt =
			ttlMinutes === undefined ? Number.MAX_SAFE_INTEGER : state.configuredSince + ttlMinutes * 60_000;
		if (expiresAt <= now) continue;
		const valueFingerprints = stringList(grant.valueFingerprints);
		const codeFingerprints = stringList(grant.codeFingerprints);
		scopes.push({
			id: `settings:${surface}:${index}`,
			surface,
			targets,
			actions,
			consequential: grant.consequential === true,
			expiresAt,
			grantedAt: state.configuredSince,
			grantedBy: "user",
			...(valueFingerprints ? { valueFingerprints } : {}),
			...(codeFingerprints ? { codeFingerprints } : {}),
			...(grant.rawAccess === "broad" ? { rawAccess: "broad" as const } : {}),
			...(grant.browserAppAccess === "broad" ? { browserAppAccess: "broad" as const } : {}),
			...(grant.desktopAccess === "broad" ? { desktopAccess: "broad" as const } : {}),
			...(typeof grant.task === "string" && grant.task.length > 0 ? { task: grant.task } : {}),
		});
	}
	return scopes;
}

/**
 * Return the live scope set for a session. Expired interactive grants are
 * reaped here; configured grants are re-read so profile/project reloads apply
 * without restarting the process.
 */
export function getAutomationScopes(session: object, now = Date.now()): readonly AutomationScope[] {
	const state = sessionScopes(session, now);
	for (const [id, scope] of state.interactive) {
		if (scope.expiresAt <= now) state.interactive.delete(id);
	}
	return [
		...state.interactive.values(),
		...configuredScopes(session, "browser", state, now),
		...configuredScopes(session, "computer", state, now),
	];
}

/** Mint an exact, session-local user scope. Invalid/wildcard targets fail closed. */
export function grantAutomationScope(session: object, grant: AutomationScopeGrant, now = Date.now()): AutomationScope {
	if (grant.targets.length === 0 || !grant.targets.every(target => exactTarget(grant.surface, target))) {
		throw new Error("Automation scopes require non-empty exact targets; wildcards are not allowed.");
	}
	if (grant.actions.length === 0 || grant.actions.some(action => typeof action !== "string" || action.length === 0)) {
		throw new Error("Automation scopes require at least one explicit action.");
	}
	if (grant.once && (typeof grant.invocationId !== "string" || grant.invocationId.length === 0)) {
		throw new Error("Approve-once automation scopes require an exact invocation id.");
	}
	const expiresAt = grant.expiresAt ?? now + (grant.ttlMs ?? DEFAULT_SCOPE_TTL_MS);
	if (!Number.isFinite(expiresAt) || expiresAt <= now)
		throw new Error("Automation scope expiry must be in the future.");
	const scope: AutomationScope = {
		id: crypto.randomUUID(),
		surface: grant.surface,
		targets: [...grant.targets],
		actions: [...grant.actions],
		consequential: grant.consequential,
		expiresAt,
		grantedAt: now,
		grantedBy: "user",
		...(grant.valueFingerprints ? { valueFingerprints: [...grant.valueFingerprints] } : {}),
		...(grant.codeFingerprints ? { codeFingerprints: [...grant.codeFingerprints] } : {}),
		...(grant.rawAccess ? { rawAccess: grant.rawAccess } : {}),
		...(grant.browserAppAccess ? { browserAppAccess: grant.browserAppAccess } : {}),
		...(grant.desktopAccess ? { desktopAccess: grant.desktopAccess } : {}),
		...(grant.invocationId ? { invocationId: grant.invocationId } : {}),
		...(grant.task ? { task: grant.task } : {}),
		...(grant.once ? { once: true } : {}),
	};
	sessionScopes(session, now).interactive.set(scope.id, scope);
	return scope;
}

/** Revoke one interactive scope. Configured grants are revoked by editing settings. */
export function revokeAutomationScope(session: object, id: string): boolean {
	return SESSION_SCOPES.get(session)?.interactive.delete(id) ?? false;
}

/** Stable, non-secret binding for typed values. */
export function fingerprintAutomationValue(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 16);
}

/** Full SHA-256 binding for arbitrary source that acts as an executable capability. */
export function fingerprintAutomationCode(source: string): string {
	return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

/** Error contract consumed by the eval prelude approval/retry boundary. */
export class AutomationDeniedError extends Error {
	readonly needsScope: Extract<AutomationVerdict, { verdict: "deny" }>["needsScope"];

	constructor(verdict: Extract<AutomationVerdict, { verdict: "deny" }>) {
		super(`AUTOMATION_DENIED: ${verdict.reason}; needsScope=${JSON.stringify(verdict.needsScope)}`);
		this.name = "AutomationDeniedError";
		this.needsScope = verdict.needsScope;
	}
}

export function automationDeniedError(verdict: Extract<AutomationVerdict, { verdict: "deny" }>): AutomationDeniedError {
	return new AutomationDeniedError(verdict);
}

type AutomationDenialCleanup = () => void | Promise<void>;
const AUTOMATION_DENIAL_CLEANUPS = new WeakMap<object, Set<AutomationDenialCleanup>>();

/**
 * Keep a resource alive across the outer eval approval/retry boundary, then
 * release it when that decision and any approved retry have settled.
 */
export function deferAutomationDenialCleanup(error: unknown, cleanup: AutomationDenialCleanup): boolean {
	if ((typeof error !== "object" && typeof error !== "function") || error === null) return false;
	if (automationScopeFromDenied(error) === undefined) return false;
	const key = error as object;
	const cleanups = AUTOMATION_DENIAL_CLEANUPS.get(key) ?? new Set<AutomationDenialCleanup>();
	cleanups.add(cleanup);
	AUTOMATION_DENIAL_CLEANUPS.set(key, cleanups);
	return true;
}

/** Settle resource cleanups attached to the denial that triggered approval. */
export async function settleAutomationDenialCleanup(error: unknown): Promise<void> {
	if ((typeof error !== "object" && typeof error !== "function") || error === null) return;
	const key = error as object;
	const cleanups = AUTOMATION_DENIAL_CLEANUPS.get(key);
	if (!cleanups) return;
	AUTOMATION_DENIAL_CLEANUPS.delete(key);
	await Promise.allSettled([...cleanups].map(cleanup => cleanup()));
}

export function automationScopeFromDenied(
	error: unknown,
): Extract<AutomationVerdict, { verdict: "deny" }>["needsScope"] | undefined {
	if (error instanceof AutomationDeniedError) return error.needsScope;
	if (!(error instanceof Error) || !error.message.startsWith("AUTOMATION_DENIED:")) return undefined;
	const marker = "needsScope=";
	const start = error.message.indexOf(marker);
	if (start < 0) return undefined;
	try {
		const parsed = JSON.parse(error.message.slice(start + marker.length)) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const record = parsed as Record<string, unknown>;
		const targets = stringList(record.targets);
		const actions = stringList(record.actions);
		if (
			(record.surface !== "browser" && record.surface !== "computer") ||
			!targets ||
			!actions ||
			typeof record.consequential !== "boolean"
		) {
			return undefined;
		}
		const valueFingerprints = stringList(record.valueFingerprints);
		const codeFingerprints = stringList(record.codeFingerprints);
		return {
			surface: record.surface,
			targets,
			actions,
			consequential: record.consequential,
			...(valueFingerprints ? { valueFingerprints } : {}),
			...(codeFingerprints ? { codeFingerprints } : {}),
			...(record.rawAccess === "broad" ? { rawAccess: "broad" as const } : {}),
			...(record.browserAppAccess === "broad" ? { browserAppAccess: "broad" as const } : {}),
			...(record.desktopAccess === "broad" ? { desktopAccess: "broad" as const } : {}),
			...(typeof record.task === "string" ? { task: record.task } : {}),
		};
	} catch {
		return undefined;
	}
}

interface DesktopLeaseHolder {
	pid: number;
	startedAt: string;
}

function desktopLeaseFile(): string {
	return path.join(getGlobalDaemonRuntimeDir("automation"), "desktop-input");
}

async function readDesktopLeaseHolder(holderFile: string): Promise<DesktopLeaseHolder | undefined> {
	try {
		const value = (await Bun.file(holderFile).json()) as unknown;
		if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || typeof record.startedAt !== "string") {
			return undefined;
		}
		return { pid: record.pid, startedAt: record.startedAt };
	} catch {
		return undefined;
	}
}

/**
 * Hold the machine-global desktop-input lease. Acquisition never queues:
 * another process or session receives an actionable busy refusal immediately.
 * The native lock is kernel-released on process death; the holder record is
 * diagnostic only and a successor overwrites records left by dead processes.
 */
export async function withAutomationLease<T>(
	_session: object,
	run: () => Promise<T>,
	signal?: AbortSignal,
	leaseFile = desktopLeaseFile(),
): Promise<T> {
	signal?.throwIfAborted();
	await fs.mkdir(path.dirname(leaseFile), { recursive: true, mode: 0o700 });
	let lock: FileLockHandle;
	try {
		lock = await acquireFileLock(leaseFile, { retries: 1, retryDelayMs: 0 });
	} catch {
		const holder = await readDesktopLeaseHolder(`${leaseFile}.holder.json`);
		throw new Error(
			`AUTOMATION_BUSY: desktop held by pid ${holder?.pid ?? 0} since ${holder?.startedAt ?? "unknown"}`,
		);
	}
	const holderFile = `${leaseFile}.holder.json`;
	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		try {
			rmSync(holderFile, { force: true });
		} catch {
			// Diagnostic metadata must never retain the native lock.
		} finally {
			lock.release();
		}
	};
	const onAbort = (): void => release();
	try {
		const holder: DesktopLeaseHolder = { pid: process.pid, startedAt: new Date().toISOString() };
		await Bun.write(holderFile, JSON.stringify(holder));
		signal?.addEventListener("abort", onAbort, { once: true });
		signal?.throwIfAborted();
		return await run();
	} finally {
		signal?.removeEventListener("abort", onAbort);
		release();
	}
}

function isBrowserDesktopApp(target: string): boolean {
	return /\b(?:chrome|chromium|safari|firefox|edge|brave|arc|opera|vivaldi)\b/i.test(target);
}

function scopeCovers(scope: AutomationScope, action: AutomationAction, now: number): boolean {
	if (scope.surface !== action.surface) return false;
	if (scope.expiresAt <= now) return false;
	if (scope.once && scope.invocationId !== action.invocationId) return false;
	const actionListed = scope.actions.includes(action.action);
	if (action.raw) {
		if (!actionListed) return false;
		const exactCode =
			action.codeFingerprint !== undefined && scope.codeFingerprints?.includes(action.codeFingerprint) === true;
		if (scope.rawAccess !== "broad" && !exactCode) return false;
	} else {
		if (!scope.targets.includes(action.target)) return false;
		if (!(actionListed || scope.actions.includes("*"))) return false;
	}
	if (action.surface === "computer" && isBrowserDesktopApp(action.target) && scope.browserAppAccess !== "broad") {
		return false;
	}
	if (action.surface === "computer" && action.desktopWide && scope.desktopAccess !== "broad") return false;
	if (action.consequential && !scope.consequential) return false;
	if (
		action.valueFingerprint &&
		scope.valueFingerprints &&
		!scope.valueFingerprints.includes(action.valueFingerprint)
	) {
		return false;
	}
	return true;
}

/**
 * Decide an action. Pure and synchronous so callers can gate immediately before
 * dispatch (after any judge/candidate selection) with the freshest scope set.
 */
export function decideAutomationAction(action: AutomationAction, ctx: AutomationPolicyContext): AutomationVerdict {
	if (action.tier === "read") return { verdict: "allow", reason: "read-only observation" };
	if (action.tier === "navigate" && action.ownsTarget === true && !action.raw && !action.consequential) {
		return { verdict: "allow", reason: "navigation of an OMP-owned tab" };
	}
	const scope = ctx.scopes.find(candidate => scopeCovers(candidate, action, ctx.now));
	if (scope) return { verdict: "allow", reason: `scope ${scope.id}`, scopeId: scope.id };
	const browserAppWide = action.surface === "computer" && isBrowserDesktopApp(action.target);
	const desktopWide = action.surface === "computer" && action.desktopWide === true;
	const rawBoundary = action.raw
		? `; arbitrary code can control the whole ${action.surface === "browser" ? "browser identity" : "desktop"}, not only ${action.target}`
		: "";
	const browserAppBoundary = browserAppWide
		? `; desktop control of ${action.target} is app-wide and not confined to its active site`
		: "";
	const desktopBoundary = desktopWide
		? "; root mouse/keyboard input can reach the entire desktop, not only the focused application"
		: "";
	return {
		verdict: "deny",
		reason: `${action.surface} ${action.action} is a ${action.raw ? "raw " : ""}${action.consequential ? "consequential " : ""}mutation with no matching user-granted capability${rawBoundary}${browserAppBoundary}${desktopBoundary}`,
		needsScope: {
			surface: action.surface,
			targets: [action.target],
			actions: [action.action],
			consequential: action.consequential,
			valueFingerprints: action.valueFingerprint ? [action.valueFingerprint] : undefined,
			...(action.raw
				? action.codeFingerprint
					? { codeFingerprints: [action.codeFingerprint] }
					: { rawAccess: "broad" as const }
				: {}),
			...(browserAppWide ? { browserAppAccess: "broad" as const } : {}),
			...(desktopWide ? { desktopAccess: "broad" as const } : {}),
		},
	};
}
