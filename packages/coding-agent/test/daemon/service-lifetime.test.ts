/**
 * Defends the bounded-run contract for named services: `lifetimeMs` is a real total wall-clock
 * deadline (not the readiness timeout) that the daemon enforces by stopping the process tree,
 * that survives automatic restarts without renewing, and whose reason is visible in the unit
 * snapshot, the service status line, the log, and the owner's completion.
 *
 * Real timers are required: this drives a real daemon process and real children.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { DaemonCompletionEvent, DaemonEvent } from "../../src/daemon/protocol";
import { serviceStatus } from "../../src/launch/services";
import { pidAlive, shProc, TestDaemon, until } from "../fixtures/daemon-proc-harness";

const LIFETIME_MS = 1_000;
const TEST_TIMEOUT_MS = 20_000;

let daemon: TestDaemon | undefined;

afterEach(async () => {
	await daemon?.dispose();
	daemon = undefined;
});

function completionOf(key: string) {
	return (event: DaemonEvent): event is DaemonCompletionEvent => event.ev === "completed" && event.unit.key === key;
}

describe.skipIf(process.platform === "win32")("service lifetime", () => {
	it(
		"stops a finite service when its lifetime elapses, delivers the completion, and reports why",
		async () => {
			const started = await TestDaemon.start();
			daemon = started.daemon;
			const { conn } = started;
			const root = started.daemon.root;
			await conn.request({ op: "subscribe", subscriptionId: "sub-life", owners: ["owner-life"] });
			const startedAt = Date.now();
			const opened = await conn.openProc(
				"finite-sleep",
				{ ...shProc("echo started; exec sleep 30", root), lifetimeMs: LIFETIME_MS },
				{ owner: "owner-life" },
			);
			expect(opened.unit.state).toBe("running");
			// The running snapshot carries the absolute deadline so `proc://` can show time left.
			expect(opened.unit.deadlineAt).toBeGreaterThanOrEqual(startedAt + LIFETIME_MS);
			expect(opened.unit.deadlineAt).toBeLessThanOrEqual(Date.now() + LIFETIME_MS);
			expect(serviceStatus(opened.unit)).toContain("lifetime left");
			const pid = opened.unit.pids[0]!;

			const completion = await conn.event(completionOf("finite-sleep"), "lifetime completion", LIFETIME_MS + 5_000);
			const settled = completion.unit;
			expect(settled.state).toBe("exited");
			expect(settled.pids).toEqual([]);
			expect(settled.exitReason).toBe("lifetime of 1s expired");
			expect((settled.exitedAt ?? 0) - startedAt).toBeGreaterThanOrEqual(LIFETIME_MS - 50);
			expect(pidAlive(pid)).toBe(false);
			const status = serviceStatus(settled);
			expect(status).toContain("lifetime of 1s expired");
			expect(status).not.toContain("lifetime left");

			const logs = await conn.request({
				op: "logs",
				unit: "finite-sleep",
				lines: 100,
				head: false,
				follow: false,
				timeoutMs: 0,
			});
			expect(logs.text).toContain("started");
			expect(logs.text).toContain("[lifetime of 1s expired; stopping]");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"counts the lifetime across automatic restarts instead of per launch",
		async () => {
			const started = await TestDaemon.start();
			daemon = started.daemon;
			const { conn } = started;
			// Exits immediately; restart "always" would relaunch it forever without a lifetime.
			await conn.openProc(
				"crash-loop",
				{ ...shProc("exit 0", started.daemon.root), lifetimeMs: LIFETIME_MS },
				{ policy: { restart: "always" } },
			);

			const settled = await until(
				async () => {
					const unit = await conn.describe("crash-loop");
					return unit.state === "exited" || unit.state === "failed" ? unit : undefined;
				},
				"lifetime to end the restart loop",
				LIFETIME_MS + 5_000,
			);
			expect(settled.state).toBe("exited");
			expect(settled.exitReason).toBe("lifetime of 1s expired");
			// Each relaunch reused the original deadline: the loop was cut short, not renewed.
			expect(settled.restartCount).toBeGreaterThan(0);

			// Nothing resurrects it after the deadline. A real wait past the restart backoff (the daemon
			// is a separate process, so fake timers cannot advance it) proves no relaunch is pending.
			await Bun.sleep(2_500);
			const later = await conn.describe("crash-loop");
			expect(later.state).toBe("exited");
			expect(later.restartCount).toBe(settled.restartCount);
		},
		TEST_TIMEOUT_MS,
	);
});
