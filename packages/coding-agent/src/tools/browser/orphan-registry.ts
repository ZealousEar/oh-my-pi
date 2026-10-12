/**
 * Durable ownership registry for page targets OMP created in browsers that
 * outlive a single omp process: the machine-global agent Chromium
 * (`omp.browser.headless`/`omp.browser.headed`) and relay-driven Chrome
 * (`new_tab` targets on `omp.browser.relay`).
 *
 * Tab lifecycle is otherwise tracked only in the creating process's memory
 * (`tab-supervisor`'s `tabs` map). When a session ends abnormally (crash,
 * SIGKILL, cleanup timeout) that map dies with it and the pages it opened stay
 * open forever (issue #10022). This module records, atomically on disk under
 * the browser's machine-global runtime dir, which OS process created each target together with
 * the metadata a reaper needs: creator session and channel, logical tab name,
 * `persist`, creation time, last MEANINGFUL activity (tool-driven actions only
 * — websocket keepalives, freeze/unfreeze and passive reloads never count),
 * and the browser generation the target id belongs to. Each owner file is a
 * PID lease refreshed by a heartbeat while the process holds targets.
 *
 * Ownership is authoritative in the safe direction:
 * - only targets with a record are ever closed by a reaper — an adopted user
 *   tab has no record and cannot be reached from here;
 * - a live owner PID's targets are never touched by another process;
 * - a dead owner (`ESRCH`) is reaped only after a grace window;
 * - a record from another browser generation is discarded, never acted on;
 * - torn, malformed or metadata-less records fail SAFE: legacy `string[]`
 *   target lists still prove OMP creation (crash reap applies) but carry no
 *   activity clock, so the idle reaper retains them.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isPidAlive, logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { Browser, CDPSession, Connection } from "puppeteer-core";
import { browserConnection } from "./launch";

/** Identifies one browser's target registry. */
export interface SharedTargetScope {
	/** Machine-global runtime directory the registry lives under (`browser-agent` or `browser-relay`). */
	runtimeDir: string;
	/** Registry name: the shared Chromium's daemon unit key (`omp.browser.headless`) or {@link RELAY_TARGETS_NAME}. */
	daemonName: string;
}

/**
 * Registry name of relay-driven Chrome's owned tabs. The relay is served by the extension's native host, not a
 * daemon unit; the name is the on-disk namespace of its records.
 */
export const RELAY_TARGETS_NAME = "omp.browser.relay";

/** Durable per-target metadata; everything a reaper needs after the creating process is gone. */
export interface SharedTargetRecord {
	targetId: string;
	/** Logical tab name the creator used (`main`, `omp-architecture-image`, ...). */
	name: string;
	/** Creating session id when the acquirer identified itself. */
	ownerSessionId?: string;
	/** OMP channel/profile of the creator (`OMP_PROFILE`, `default` when unset). */
	channel: string;
	/** Creator opted the tab out of idle reaping. */
	persist: boolean;
	createdAt: number;
	/** Last tool-driven action (create, reuse, run start/end). Never refreshed by keepalives or freeze/unfreeze. */
	lastMeaningfulActivityAt: number;
	/** Browser launch identity the target id is valid in. */
	generation: string;
	/** Relay tabs: extension-minted per-tab UUID; a live tab must carry the same marker before it is closed. */
	marker?: string;
}

/** On-disk ownership record: one file per owning omp process (a PID lease). */
interface OwnershipFile {
	version?: 2;
	pid: number;
	/** Heartbeat: refreshed on every write and by the lease timer while targets are held. */
	updatedAt: number;
	/** v2: full records. Legacy files carry `string[]` target ids with no metadata. */
	targets: Array<SharedTargetRecord | string>;
}

/**
 * Reap only records whose owner has been dead AND untouched for this long.
 * The PID probe is already authoritative; the grace window is a conservative
 * guard against clock skew and PID reuse races, and keeps a just-crashed
 * process's very fresh records around briefly in case it is being restarted.
 */
const DEFAULT_GRACE_MS = 15_000;
/** Lease heartbeat cadence while this process holds any recorded target. */
const HEARTBEAT_MS = 60_000;

/** Re-send cadence and overall budget of {@link closeSharedTargetUntilGone}. */
const RECLOSE_INTERVAL_MS = 2_000;
const RECLOSE_BUDGET_MS = 30_000;
/** Per-target budget of {@link retryUnclosedSharedTargets}, so a sweep over many targets stays bounded. */
const RETRY_CLOSE_BUDGET_MS = 5_000;

/**
 * In-process records of targets this process created, keyed by registry dir then target id. A bare id is an
 * id-only claim (web-search pages): it proves OMP created the target, so crash reap applies, but carries no
 * activity clock, so the idle reaper retains it — the same contract as a legacy on-disk `string[]` entry.
 */
const ownedByDir = new Map<string, Map<string, SharedTargetRecord | string>>();
/** Owned targets whose close this process could not confirm, keyed by registry dir. */
const unclosedByDir = new Map<string, Set<string>>();
/** In-flight {@link retryUnclosedSharedTargets} run per registry dir. */
const unclosedRetries = new Map<string, Promise<number>>();
/** Per-registry-dir write serialization so concurrent record/forget can't tear the file. */
const writeChains = new Map<string, Promise<void>>();
/** Unref'd heartbeat timers per registry dir. */
const heartbeats = new Map<string, NodeJS.Timeout>();

function registryDir(scope: SharedTargetScope): string {
	return path.join(scope.runtimeDir, `${scope.daemonName}.targets`);
}

/** Serialize a write against others for the same registry dir. */
function chain(dir: string, task: () => Promise<void>): Promise<void> {
	const prev = writeChains.get(dir) ?? Promise.resolve();
	const next = prev.then(task, task);
	writeChains.set(
		dir,
		next.catch(() => undefined),
	);
	return next;
}

/** Atomic JSON write: temp file beside the destination, then rename. */
async function writeAtomic(file: string, record: OwnershipFile): Promise<void> {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		await Bun.write(tmp, JSON.stringify(record));
		await fs.rename(tmp, file);
	} catch (error) {
		await fs.rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
}

/** Persist (or, when empty, remove) this process's ownership file for a registry dir. */
async function flush(dir: string): Promise<void> {
	const owned = ownedByDir.get(dir);
	const file = path.join(dir, `${process.pid}.json`);
	if (!owned || owned.size === 0) {
		stopHeartbeat(dir);
		await fs.rm(file, { force: true }).catch(() => undefined);
		return;
	}
	await fs.mkdir(dir, { recursive: true });
	await writeAtomic(file, { version: 2, pid: process.pid, updatedAt: Date.now(), targets: [...owned.values()] });
	startHeartbeat(dir);
}

function startHeartbeat(dir: string): void {
	if (heartbeats.has(dir)) return;
	const timer = setInterval(() => {
		void chain(dir, () => flush(dir)).catch(() => undefined);
	}, HEARTBEAT_MS);
	timer.unref();
	heartbeats.set(dir, timer);
}

function stopHeartbeat(dir: string): void {
	const timer = heartbeats.get(dir);
	if (timer === undefined) return;
	heartbeats.delete(dir);
	clearInterval(timer);
}

function persistQuietly(dir: string, what: string): Promise<void> {
	return chain(dir, () => flush(dir)).catch(err =>
		logger.debug(`Failed to ${what} shared-browser target ownership`, {
			error: err instanceof Error ? err.message : String(err),
		}),
	);
}

/**
 * Record that this process created a target in the given browser, with its lifecycle metadata, or as a bare
 * target id when the creator has none to give (an id-only claim; see {@link ownedByDir}).
 */
export async function recordSharedTarget(scope: SharedTargetScope, record: SharedTargetRecord | string): Promise<void> {
	const dir = registryDir(scope);
	let owned = ownedByDir.get(dir);
	if (!owned) {
		owned = new Map();
		ownedByDir.set(dir, owned);
	}
	owned.set(typeof record === "string" ? record : record.targetId, record);
	await persistQuietly(dir, "record");
}

/**
 * Refresh durable lifecycle fields of an owned target. Only tool-driven
 * activity may pass `lastMeaningfulActivityAt`; `persist` follows the
 * creator's later decision. Unknown targets are ignored.
 */
export async function touchSharedTarget(
	scope: SharedTargetScope,
	targetId: string,
	patch: Partial<Pick<SharedTargetRecord, "lastMeaningfulActivityAt" | "persist" | "marker">>,
): Promise<void> {
	const dir = registryDir(scope);
	const record = ownedByDir.get(dir)?.get(targetId);
	if (!record || typeof record === "string") return;
	Object.assign(record, patch);
	await persistQuietly(dir, "update");
}

/** Drop `targetId` from this process's ownership file (closed the normal way). */
export async function forgetSharedTarget(scope: SharedTargetScope, targetId: string): Promise<void> {
	const dir = registryDir(scope);
	unclosedByDir.get(dir)?.delete(targetId);
	const owned = ownedByDir.get(dir);
	if (!owned?.delete(targetId)) return;
	await persistQuietly(dir, "update");
}

/**
 * Drop every target this process still claims in `scope`. For when the whole
 * shared browser is confirmed gone — the daemon reported its browser unit in a
 * terminal state after a stop — which takes the targets that could not be
 * closed with it; the records are dead weight that would otherwise be
 * rewritten on every later write until this process exits. Only call this on
 * that confirmation: while the browser lives, the records are the only handle
 * a later reap has on its orphaned targets.
 */
export async function forgetSharedTargets(scope: SharedTargetScope): Promise<void> {
	const dir = registryDir(scope);
	unclosedByDir.delete(dir);
	const owned = ownedByDir.get(dir);
	if (!owned || owned.size === 0) return;
	owned.clear();
	await chain(dir, () => flush(dir)).catch(err =>
		logger.debug("Failed to clear shared-browser target ownership", {
			error: err instanceof Error ? err.message : String(err),
		}),
	);
}

/** Options for {@link collectOrphanTargets}; the defaults hit the real registry, the seams are for tests. */
export interface CollectOrphanOptions {
	/** Wall clock; injectable for deterministic grace-window tests. */
	now?: () => number;
	/** PID liveness probe; injectable so tests need no real subprocesses. */
	isAlive?: (pid: number) => boolean;
	/** Grace window in ms before a dead owner's records are eligible. */
	graceMs?: number;
}

/** One orphaned target with whatever metadata its record carried (undefined for legacy id-only records). */
export interface OrphanTarget {
	targetId: string;
	record?: SharedTargetRecord;
}

/** Targets belonging to one dead process, kept grouped so partial failures remain retryable. */
export interface OrphanOwner {
	file: string;
	pid: number;
	updatedAt: number;
	targets: OrphanTarget[];
}

/** Orphan-scan result grouped by durable ownership file. */
export interface OrphanScan {
	owners: OrphanOwner[];
}

function parseTargets(raw: unknown[]): OrphanTarget[] {
	const out: OrphanTarget[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			out.push({ targetId: entry });
			continue;
		}
		if (entry === null || typeof entry !== "object") continue;
		const record = entry as Partial<SharedTargetRecord>;
		if (typeof record.targetId !== "string") continue;
		// A record missing its clock or generation is not trustworthy metadata:
		// keep the id (OMP created it) but strip the metadata so the idle path
		// retains it and the generation check discards nothing by accident.
		if (
			typeof record.lastMeaningfulActivityAt !== "number" ||
			typeof record.generation !== "string" ||
			typeof record.createdAt !== "number"
		) {
			out.push({ targetId: record.targetId });
			continue;
		}
		out.push({
			targetId: record.targetId,
			record: {
				targetId: record.targetId,
				name: typeof record.name === "string" ? record.name : "",
				ownerSessionId: typeof record.ownerSessionId === "string" ? record.ownerSessionId : undefined,
				channel: typeof record.channel === "string" ? record.channel : "unknown",
				persist: record.persist === true,
				createdAt: record.createdAt,
				lastMeaningfulActivityAt: record.lastMeaningfulActivityAt,
				generation: record.generation,
				marker: typeof record.marker === "string" ? record.marker : undefined,
			},
		});
	}
	return out;
}

/**
 * Scan a registry dir for targets whose owning process is gone. Returns one
 * entry per dead owner so a reaper can retain only targets whose CDP closure
 * was not confirmed. This process's own file and every live-owner file are
 * left untouched.
 */
export async function collectOrphanTargets(
	scope: SharedTargetScope,
	opts: CollectOrphanOptions = {},
): Promise<OrphanScan> {
	const now = opts.now ?? Date.now;
	const isAlive = opts.isAlive ?? isPidAlive;
	const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
	const dir = registryDir(scope);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return { owners: [] };
		throw err;
	}
	const owners: OrphanOwner[] = [];
	const nowMs = now();
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const file = path.join(dir, entry);
		let record: OwnershipFile;
		try {
			record = (await Bun.file(file).json()) as OwnershipFile;
		} catch {
			continue; // torn or malformed file; a live owner will rewrite it
		}
		if (typeof record?.pid !== "number" || !Array.isArray(record.targets)) continue;
		if (record.pid === process.pid) continue; // our own file
		if (isAlive(record.pid)) continue; // owner still running
		if (nowMs - (record.updatedAt ?? 0) < graceMs) continue; // conservative grace
		owners.push({ file, pid: record.pid, updatedAt: record.updatedAt, targets: parseTargets(record.targets) });
	}
	return { owners };
}

/** In-process view of the targets this process currently owns in a scope with full records (for the owner's own reaper). */
export function ownedSharedTargets(scope: SharedTargetScope): readonly SharedTargetRecord[] {
	const owned = ownedByDir.get(registryDir(scope))?.values() ?? [];
	return [...owned].filter((record): record is SharedTargetRecord => typeof record !== "string");
}

/**
 * How long {@link closeCdpTarget} waits by default for Chromium to destroy a target whose close it accepted.
 * Past it the close counts as unconfirmed, as a failed one does.
 */
const CLOSE_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Close a page target by id on the browser's root connection. Returns true only
 * when CDP reports the target destroyed or confirms it no longer exists; a
 * dropped connection or transient protocol failure returns false so durable
 * ownership remains available for a later retry. Never throws.
 *
 * A browser-target session per call would race: overlapping ones make puppeteer
 * lose the browser target (puppeteer#15750). Puppeteer enables target discovery
 * on the root connection when it connects, so `Target.targetDestroyed` arrives there.
 *
 * `Target.closeTarget` answers `success` once Chromium has started closing the
 * page, not once it is gone: the target stays listed until its renderer has
 * unloaded it. Its `Target.targetDestroyed` confirms the close instead, as it
 * does for Puppeteer's own `page.close()`.
 *
 * A caller that bounds the whole close MUST pass a `confirmTimeoutMs` well below
 * its budget, so a missed `targetDestroyed` still leaves time for the
 * `Target.getTargets` absence check to decide the result.
 */
export async function closeCdpTarget(
	browser: Browser,
	targetId: string,
	confirmTimeoutMs = CLOSE_CONFIRM_TIMEOUT_MS,
): Promise<boolean> {
	let connection: Connection;
	try {
		connection = browserConnection(browser);
	} catch {
		return false;
	}
	const destroyed = Promise.withResolvers<boolean>();
	const onDestroyed = (event: { targetId: string }): void => {
		if (event.targetId === targetId) destroyed.resolve(true);
	};
	connection.on("Target.targetDestroyed", onDestroyed);
	let timer: NodeJS.Timeout | undefined;
	try {
		try {
			const result = await connection.send("Target.closeTarget", { targetId });
			if (result.success) {
				timer = setTimeout(() => destroyed.resolve(false), confirmTimeoutMs);
				if (await destroyed.promise) return true;
			}
		} catch {
			// A concurrent reaper or the page itself may already have closed the
			// target. Confirm absence before treating the cleanup as complete.
		}
		try {
			const { targetInfos } = await connection.send("Target.getTargets");
			return !targetInfos.some(info => info.targetId === targetId);
		} catch {
			return false;
		}
	} finally {
		clearTimeout(timer);
		connection.off("Target.targetDestroyed", onDestroyed);
	}
}

/**
 * {@link closeCdpTarget} for the omp relay, over a channel that answers browser-level `Target.*`
 * commands. The relay's `Target.getTargets` lists only tabs it can drive right now, not those of a
 * disconnected browser or with a dismissed debugger, so absence is read from `Target.getTargetInfo`:
 * it looks the id up among every tab the extensions reported, and answers an unknown id with the
 * browser target.
 */
export async function closeRelayTarget(channel: Pick<CDPSession, "send">, targetId: string): Promise<boolean> {
	try {
		const result = await channel.send("Target.closeTarget", { targetId });
		if (result.success) return true;
	} catch {
		// Closed already (the worker's own close), or the extension cannot answer.
	}
	try {
		const { targetInfo } = await channel.send("Target.getTargetInfo", { targetId });
		return targetInfo.targetId !== targetId;
	} catch {
		return false;
	}
}

/** Bounds of {@link closeSharedTargetUntilGone}. */
interface CloseUntilGoneOptions {
	/** Give up (returning false) after this long; default 30 s. */
	budgetMs?: number;
	/** Re-send interval while the target is still listed; default 2 s. */
	intervalMs?: number;
}

/**
 * Confirms a web search page's close like {@link closeCdpTarget} (#16680). Chromium can answer
 * `success: true` and keep the page, so the close is re-sent every `intervalMs` while the target
 * is listed. Returns false once `budgetMs` elapses or the connection drops; never throws.
 */
export async function closeSharedTargetUntilGone(
	browser: Browser,
	targetId: string,
	opts: CloseUntilGoneOptions = {},
): Promise<boolean> {
	const intervalMs = opts.intervalMs ?? RECLOSE_INTERVAL_MS;
	const stop = AbortSignal.timeout(opts.budgetMs ?? RECLOSE_BUDGET_MS);
	let connection: Connection;
	try {
		connection = browserConnection(browser);
	} catch {
		return false;
	}
	const destroyed = Promise.withResolvers<true>();
	const onDestroyed = (event: { targetId: string }): void => {
		if (event.targetId === targetId) destroyed.resolve(true);
	};
	connection.on("Target.targetDestroyed", onDestroyed);
	try {
		// A closed connection rejects every send at once; stop rather than spin to the budget.
		while (!stop.aborted && browser.connected) {
			const round = AbortSignal.any([stop, AbortSignal.timeout(intervalMs)]);
			// Sent outright, not under `round`: a stalled Chromium outlasts rounds, and a skipped send never closes.
			// The reply proves nothing: success can leave the page open; an error may mean it went.
			void connection.send("Target.closeTarget", { targetId }).catch(() => {});
			// Answered after the close, so it also settles a target already gone, or one whose event was missed.
			const unlisted = connection.send("Target.getTargets").then(
				reply => (reply.targetInfos.some(info => info.targetId === targetId) ? destroyed.promise : true),
				() => (browser.connected ? destroyed.promise : false),
			);
			if (await untilAborted(round, Promise.race([destroyed.promise, unlisted])).catch(() => false)) return true;
		}
		return false;
	} finally {
		connection.off("Target.targetDestroyed", onDestroyed);
	}
}

/** Mark a target whose close went unconfirmed for retry while this process lives; the reaper skips live owners. */
export function markSharedTargetUnclosed(scope: SharedTargetScope, targetId: string): void {
	const dir = registryDir(scope);
	let unclosed = unclosedByDir.get(dir);
	if (!unclosed) {
		unclosed = new Set();
		unclosedByDir.set(dir, unclosed);
	}
	unclosed.add(targetId);
}

/**
 * Retry the closes marked for `scope`, forgetting confirmed ones.
 * Returns the count closed; never throws. Concurrent calls for a scope share one run.
 */
export function retryUnclosedSharedTargets(browser: Browser, scope: SharedTargetScope): Promise<number> {
	const dir = registryDir(scope);
	const inFlight = unclosedRetries.get(dir);
	if (inFlight) return inFlight;
	const run = retryUnclosed(browser, scope, dir);
	unclosedRetries.set(dir, run);
	void run.finally(() => {
		if (unclosedRetries.get(dir) === run) unclosedRetries.delete(dir);
	});
	return run;
}

async function retryUnclosed(browser: Browser, scope: SharedTargetScope, dir: string): Promise<number> {
	const pending = unclosedByDir.get(dir);
	if (!pending || pending.size === 0) return 0;
	let closed = 0;
	// Iterate live, not a snapshot: overlapping searches share this run, so ids they mark mid-sweep
	// must be tried too. Set iteration reaches entries added during it and skips forgotten ones.
	for (const targetId of pending) {
		const gone = await closeSharedTargetUntilGone(browser, targetId, { budgetMs: RETRY_CLOSE_BUDGET_MS });
		if (!gone) {
			logger.debug("Shared-browser target still open after retried close", { targetId });
			continue;
		}
		closed++;
		await forgetSharedTarget(scope, targetId);
	}
	if (closed > 0) logger.debug("Closed lingering shared-browser targets", { count: closed, daemon: scope.daemonName });
	return closed;
}

/** Atomically retain unresolved targets, or remove an ownership file once all are resolved. */
async function updateOwnershipFile(owner: OrphanOwner, retained: OrphanTarget[]): Promise<void> {
	if (retained.length === 0) {
		await fs.rm(owner.file, { force: true });
		return;
	}
	await writeAtomic(owner.file, {
		version: 2,
		pid: owner.pid,
		updatedAt: owner.updatedAt,
		targets: retained.map(target => target.record ?? target.targetId),
	});
}

/** How a reaper decides what to do with one dead owner's target. */
export type OrphanDecision = "close" | "retain" | "discard";

/** Seams for {@link reapOrphanSharedTargets}; production uses the real clock and closes everything eligible. */
export interface ReapOrphanOptions extends CollectOrphanOptions {
	/** Current browser generation; records from another generation are discarded without touching any target. */
	generation?: string;
	/**
	 * Per-target policy hook (default: close). Lets the supervisor apply the
	 * same page-level protections (login page, unsaved input, download,
	 * foreground tab) to targets inherited from a crashed owner as to its own.
	 */
	decide?: (target: OrphanTarget) => Promise<OrphanDecision> | OrphanDecision;
	/** Close primitive; injectable so tests need no browser. */
	close?: (targetId: string) => Promise<boolean>;
}

/**
 * Reap targets whose owning omp process is gone — cleanup transfers to
 * whichever live process attaches next. Each owner file is removed only after
 * every target is resolved (closed, absent, or discarded as stale
 * generation); partial failures atomically retain the unresolved records for
 * the next attempt. Failures are logged, never thrown, so cleanup cannot block
 * browser open.
 */
export async function reapOrphanSharedTargets(
	browser: Browser | undefined,
	scope: SharedTargetScope,
	opts: ReapOrphanOptions = {},
): Promise<number> {
	let scan: OrphanScan;
	try {
		scan = await collectOrphanTargets(scope, opts);
	} catch (err) {
		logger.debug("Failed to scan shared-browser target registry", {
			error: err instanceof Error ? err.message : String(err),
		});
		return 0;
	}
	const close = opts.close ?? (browser ? (targetId: string) => closeCdpTarget(browser, targetId) : undefined);
	if (!close) return 0;
	let closed = 0;
	for (const owner of scan.owners) {
		const retained: OrphanTarget[] = [];
		for (const target of owner.targets) {
			if (opts.generation !== undefined && target.record && target.record.generation !== opts.generation) {
				// Stale generation: the id can name nothing (or, worse, be
				// recycled); drop the record without any CDP call.
				continue;
			}
			const decision = opts.decide ? await opts.decide(target) : "close";
			if (decision === "discard") continue;
			if (decision === "retain") {
				retained.push(target);
				continue;
			}
			if (await close(target.targetId)) {
				closed++;
			} else {
				retained.push(target);
				logger.debug("Retaining orphaned shared-browser target for retry", {
					targetId: target.targetId,
					ownerPid: owner.pid,
				});
			}
		}
		if (retained.length === owner.targets.length) continue;
		try {
			await updateOwnershipFile(owner, retained);
		} catch (err) {
			logger.debug("Failed to update shared-browser ownership after reap", {
				ownerPid: owner.pid,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (closed > 0) logger.debug("Reaped orphaned shared-browser targets", { count: closed, daemon: scope.daemonName });
	return closed;
}

/** Test-only reset of the in-process ownership state. */
export function resetOrphanRegistryForTest(): void {
	ownedByDir.clear();
	unclosedByDir.clear();
	unclosedRetries.clear();
	writeChains.clear();
	for (const timer of heartbeats.values()) clearInterval(timer);
	heartbeats.clear();
}
