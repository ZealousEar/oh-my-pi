/**
 * Durable ownership registry v2 (`orphan-registry`): records carry lifecycle
 * metadata, files are PID leases, and reaping fails SAFE — stale generations
 * are discarded without touching a target, metadata-less records keep the
 * crash-reap semantics of issue #10022 but never satisfy the idle path, and a
 * `decide` hook can retain anything.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectOrphanTargets,
	forgetSharedTarget,
	ownedSharedTargets,
	reapOrphanSharedTargets,
	recordSharedTarget,
	resetOrphanRegistryForTest,
	type SharedTargetRecord,
	type SharedTargetScope,
	touchSharedTarget,
} from "./orphan-registry";

const DAEMON = "omp.browser.headless";
const roots: string[] = [];

async function scope(): Promise<SharedTargetScope> {
	const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lifecycle-registry-"));
	roots.push(runtimeDir);
	return { runtimeDir, daemonName: DAEMON };
}

function record(overrides: Partial<SharedTargetRecord> = {}): SharedTargetRecord {
	return {
		targetId: "T1",
		name: "main",
		ownerSessionId: "session-a",
		channel: "daily-fork",
		persist: false,
		createdAt: 1_000,
		lastMeaningfulActivityAt: 1_000,
		generation: "gen-1",
		...overrides,
	};
}

async function writeOwner(s: SharedTargetScope, pid: number, targets: unknown[], updatedAt = 0): Promise<string> {
	const dir = path.join(s.runtimeDir, `${DAEMON}.targets`);
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${pid}.json`);
	await Bun.write(file, JSON.stringify({ version: 2, pid, updatedAt, targets }));
	return file;
}

const DEAD = () => false;
const FAR_FUTURE = () => 10_000_000_000_000;

afterEach(async () => {
	resetOrphanRegistryForTest();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("orphan-registry v2 — durable metadata", () => {
	it("persists creator, name, persist, clocks and generation atomically and mirrors later touches", async () => {
		const s = await scope();
		await recordSharedTarget(s, record());
		const file = path.join(s.runtimeDir, `${DAEMON}.targets`, `${process.pid}.json`);
		const written = (await Bun.file(file).json()) as { version: number; pid: number; targets: SharedTargetRecord[] };
		expect(written.version).toBe(2);
		expect(written.pid).toBe(process.pid);
		expect(written.targets).toEqual([record()]);
		await touchSharedTarget(s, "T1", { lastMeaningfulActivityAt: 5_000, persist: true });
		const touched = (await Bun.file(file).json()) as { targets: SharedTargetRecord[] };
		expect(touched.targets[0]?.lastMeaningfulActivityAt).toBe(5_000);
		expect(touched.targets[0]?.persist).toBe(true);
		expect(ownedSharedTargets(s).map(t => t.targetId)).toEqual(["T1"]);
		await forgetSharedTarget(s, "T1");
		expect(await Bun.file(file).exists()).toBe(false);
		// No stray temp files from the atomic writes.
		expect((await fs.readdir(path.join(s.runtimeDir, `${DAEMON}.targets`))).filter(f => f.endsWith(".tmp"))).toEqual(
			[],
		);
	});

	it("parses full records, keeps legacy id-only entries, and strips metadata it cannot trust", async () => {
		const s = await scope();
		await writeOwner(s, 4_000_001, [
			record(),
			"LEGACY",
			{ targetId: "NOCLOCK", name: "x", generation: "gen-1" },
			{ notATarget: true },
		]);
		const scan = await collectOrphanTargets(s, { isAlive: DEAD, now: FAR_FUTURE });
		expect(scan.owners).toHaveLength(1);
		const targets = scan.owners[0]!.targets;
		expect(targets.map(t => t.targetId)).toEqual(["T1", "LEGACY", "NOCLOCK"]);
		expect(targets[0]?.record).toEqual(record());
		expect(targets[1]?.record).toBeUndefined();
		expect(targets[2]?.record).toBeUndefined();
	});
});

describe("orphan-registry v2 — reap policy", () => {
	it("discards stale-generation records without any close call and closes current ones", async () => {
		const s = await scope();
		const file = await writeOwner(s, 4_000_002, [
			record({ targetId: "OLD", generation: "gen-0" }),
			record({ targetId: "NEW" }),
		]);
		const closed: string[] = [];
		const count = await reapOrphanSharedTargets(undefined, s, {
			isAlive: DEAD,
			now: FAR_FUTURE,
			generation: "gen-1",
			close: async id => {
				closed.push(id);
				return true;
			},
		});
		expect(closed).toEqual(["NEW"]);
		expect(count).toBe(1);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("keeps retained records durable and removes only resolved ones", async () => {
		const s = await scope();
		const file = await writeOwner(s, 4_000_003, [
			record({ targetId: "KEEP", persist: true }),
			record({ targetId: "GO" }),
			"LEGACY",
		]);
		const closed: string[] = [];
		await reapOrphanSharedTargets(undefined, s, {
			isAlive: DEAD,
			now: FAR_FUTURE,
			generation: "gen-1",
			decide: target => (target.record?.persist ? "retain" : "close"),
			close: async id => {
				closed.push(id);
				return true;
			},
		});
		expect(closed.sort()).toEqual(["GO", "LEGACY"]);
		const left = (await Bun.file(file).json()) as { targets: unknown[] };
		expect(left.targets).toEqual([record({ targetId: "KEEP", persist: true })]);
	});

	it("retains a target whose close failed transiently and closes it on the next reap", async () => {
		const s = await scope();
		const file = await writeOwner(s, 4_000_004, [record({ targetId: "NOW" }), record({ targetId: "LATER" })]);
		const opts = { isAlive: DEAD, now: FAR_FUTURE, generation: "gen-1" };
		const first: string[] = [];
		await reapOrphanSharedTargets(undefined, s, {
			...opts,
			close: async id => {
				first.push(id);
				return id !== "LATER";
			},
		});
		expect(first.sort()).toEqual(["LATER", "NOW"]);
		const afterFirst = (await Bun.file(file).json()) as { targets: unknown[] };
		expect(afterFirst.targets).toEqual([record({ targetId: "LATER" })]);

		const retry: string[] = [];
		await reapOrphanSharedTargets(undefined, s, {
			...opts,
			close: async id => {
				retry.push(id);
				return true;
			},
		});
		expect(retry).toEqual(["LATER"]);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("never touches a live owner's records, this process's own file, or a fresh dead owner inside the grace window", async () => {
		const s = await scope();
		await recordSharedTarget(s, record({ targetId: "MINE" }));
		await writeOwner(s, 4_000_004, [record({ targetId: "LIVE" })], 0);
		await writeOwner(s, 4_000_005, [record({ targetId: "FRESH" })], Date.now());
		const closed: string[] = [];
		await reapOrphanSharedTargets(undefined, s, {
			isAlive: pid => pid === 4_000_004,
			generation: "gen-1",
			close: async id => {
				closed.push(id);
				return true;
			},
		});
		expect(closed).toEqual([]);
	});
});
