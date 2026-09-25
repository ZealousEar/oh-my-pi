import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { type AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";

const OWNER = "Main";
const WARN_MS = 1_000;

interface Notice {
	jobId: string;
	text: string;
	job: AsyncJob;
}

/** Manager with an owner notice route; `notices` collects every emitted warning. */
function setup(noProgressWarnMs = WARN_MS) {
	const manager = new AsyncJobManager({});
	const notices: Notice[] = [];
	manager.registerNoticeSink(
		OWNER,
		(jobId, text, job) => {
			notices.push({ jobId, text, job });
		},
		{ noProgressWarnMs },
	);
	return { manager, notices };
}

/** Let the sink's microtask hop settle after a timer fires. */
async function settle(): Promise<void> {
	await scheduler.yield();
	await scheduler.yield();
}

describe("AsyncJobManager no-progress notice", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("warns exactly once for a silent running job, after the threshold", async () => {
		const { manager, notices } = setup();
		const gate = Promise.withResolvers<string>();
		const jobId = manager.register("bash", "sleep forever", () => gate.promise, {
			ownerId: OWNER,
			timeoutMs: 300_000,
		});

		vi.advanceTimersByTime(WARN_MS - 1);
		await settle();
		expect(notices).toHaveLength(0);

		vi.advanceTimersByTime(1);
		await settle();
		expect(notices).toHaveLength(1);
		expect(notices[0].jobId).toBe(jobId);
		expect(notices[0].job.status).toBe("running");
		expect(notices[0].text).toContain(`bash job ${jobId} (sleep forever)`);
		expect(notices[0].text).toContain("no progress for 1s");
		expect(notices[0].text).toContain("times out after 300s");
		expect(notices[0].text).toContain(`ids:["${jobId}"]`);

		// Silence past a second threshold never re-warns.
		vi.advanceTimersByTime(WARN_MS * 5);
		await settle();
		expect(notices).toHaveLength(1);

		gate.resolve("done");
		await manager.waitForAll();
		await manager.dispose({ timeoutMs: 0 });
	});

	test("progress before the threshold defers the warning and quotes the output tail", async () => {
		const { manager, notices } = setup();
		const gate = Promise.withResolvers<string>();
		let report: ((text: string) => Promise<void>) | undefined;
		manager.register(
			"bash",
			"chatty",
			({ reportProgress }) => {
				report = reportProgress;
				return gate.promise;
			},
			{ ownerId: OWNER },
		);

		vi.advanceTimersByTime(WARN_MS - 100);
		await report?.("line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n");
		vi.advanceTimersByTime(WARN_MS - 100);
		await settle();
		expect(notices).toHaveLength(0);

		vi.advanceTimersByTime(100);
		await settle();
		expect(notices).toHaveLength(1);
		expect(notices[0].text).toContain("no progress for 1s");
		expect(notices[0].text).toContain("line 2\nline 3\nline 4\nline 5\nline 6");
		expect(notices[0].text).not.toContain("line 1");
		expect(notices[0].text).toContain("no timeout");

		gate.resolve("done");
		await manager.waitForAll();
		await manager.dispose({ timeoutMs: 0 });
	});

	test("repeating the same progress text does not reset the timer", async () => {
		const { manager, notices } = setup();
		const gate = Promise.withResolvers<string>();
		let report: ((text: string) => Promise<void>) | undefined;
		manager.register(
			"task",
			"idle subagent",
			({ reportProgress }) => {
				report = reportProgress;
				return gate.promise;
			},
			{ ownerId: OWNER },
		);

		await report?.("waiting");
		vi.advanceTimersByTime(WARN_MS / 2);
		await report?.("waiting");
		vi.advanceTimersByTime(WARN_MS / 2);
		await settle();
		expect(notices).toHaveLength(1);

		gate.resolve("done");
		await manager.waitForAll();
		await manager.dispose({ timeoutMs: 0 });
	});

	test("completion, failure, and cancellation before the threshold yield no notice", async () => {
		const { manager, notices } = setup();
		manager.register("bash", "quick", async () => "ok", { ownerId: OWNER });
		manager.register(
			"bash",
			"broken",
			async () => {
				throw new Error("boom");
			},
			{ ownerId: OWNER },
		);
		const gate = Promise.withResolvers<string>();
		const cancelled = manager.register("bash", "cancelled", () => gate.promise, { ownerId: OWNER });
		await settle();
		expect(manager.cancel(cancelled)).toBe(true);

		vi.advanceTimersByTime(WARN_MS * 2);
		await settle();
		expect(notices).toHaveLength(0);

		gate.resolve("late");
		await manager.waitForAll();
		await manager.dispose({ timeoutMs: 0 });
	});

	test("0 disables the watchdog", async () => {
		const { manager, notices } = setup(0);
		const gate = Promise.withResolvers<string>();
		manager.register("bash", "silent", () => gate.promise, { ownerId: OWNER });

		vi.advanceTimersByTime(60 * 60 * 1000);
		await settle();
		expect(notices).toHaveLength(0);

		gate.resolve("done");
		await manager.waitForAll();
		await manager.dispose({ timeoutMs: 0 });
	});

	test("a queued job's silence is measured from markRunning", async () => {
		const { manager, notices } = setup();
		const gate = Promise.withResolvers<string>();
		let start: (() => void) | undefined;
		manager.register(
			"task",
			"parked",
			({ markRunning }) => {
				start = markRunning;
				return gate.promise;
			},
			{ ownerId: OWNER, queued: true },
		);

		vi.advanceTimersByTime(WARN_MS * 3);
		await settle();
		expect(notices).toHaveLength(0);

		start?.();
		vi.advanceTimersByTime(WARN_MS);
		await settle();
		expect(notices).toHaveLength(1);

		gate.resolve("done");
		await manager.waitForAll();
		await manager.dispose({ timeoutMs: 0 });
	});

	test("jobs without a registered owner route are never warned", async () => {
		const { manager, notices } = setup();
		const gate = Promise.withResolvers<string>();
		manager.register("bash", "orphan", () => gate.promise, { ownerId: "Other" });
		manager.register("bash", "unowned", () => gate.promise);

		vi.advanceTimersByTime(WARN_MS * 2);
		await settle();
		expect(notices).toHaveLength(0);

		gate.resolve("done");
		await manager.waitForAll();
		await manager.dispose({ timeoutMs: 0 });
	});
});
