// Integration test — real timers are required (ts-no-test-timers exception): this spawns the
// actual cross-process daemon broker driving real child processes. The contract under test is
// that a named service's lifetime deadline terminates a real child through the broker's stop
// path; fake timers cannot control the OS process-exit promise or the unix-socket RPC the
// broker relies on.
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { type DaemonBrokerStartOptions, startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import * as brokerClients from "../../src/launch/client";
import { type DaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
} from "../../src/launch/protocol";
import { serviceLogs, serviceStatus, startService } from "../../src/launch/services";
import type { ToolSession } from "../../src/tools";
import { type DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";

const LIFETIME_MS = 1_000;
const RESTART_BACKOFF_BASE_MS = 100;

interface EmbeddedBroker {
	finished: Promise<void>;
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** Start the in-process broker and wait until it accepts connections (see service-completion-ownership). */
async function startBroker(
	projectDir: string,
	runtimeDir: string,
	options: DaemonBrokerStartOptions = {},
): Promise<EmbeddedBroker> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ ...options, onListening: () => listening.resolve(true) });
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	const claimed = await Promise.race([listening.promise, finished.then(() => false)]);
	if (!claimed) throw new Error("In-process daemon broker did not claim its scope");
	return { finished };
}

async function describeDaemon(client: DaemonBrokerClient, name: string): Promise<DaemonSnapshot> {
	const described = await client.request({ op: "describe", name });
	if (described.op !== "describe") throw new Error(`unexpected result: ${described.op}`);
	return described.daemon;
}

async function waitForTerminal(client: DaemonBrokerClient, name: string, deadlineMs: number): Promise<DaemonSnapshot> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const daemon = await describeDaemon(client, name);
		if (daemon.state === "exited" || daemon.state === "failed") return daemon;
		await Bun.sleep(25);
	}
	throw new Error(`daemon ${name} never settled`);
}

interface Harness {
	client: DaemonBrokerClient;
	projectDir: string;
	[Symbol.asyncDispose](): Promise<void>;
}

async function harness(tempDir: TempDir, options: DaemonBrokerStartOptions = {}): Promise<Harness> {
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const previousTitle = process.title;
	// Create the client (writes broker.token) before starting the broker, which reads that token.
	const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	const broker = await startBroker(projectDir, runtimeDir, options);
	vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
	return {
		client,
		projectDir,
		async [Symbol.asyncDispose]() {
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			process.title = previousTitle;
		},
	};
}

/**
 * Defends the bounded-run contract for named services: `lifetime` is a real
 * total wall-clock deadline (not the readiness timeout) that the broker
 * enforces by stopping the process tree, that survives automatic restarts
 * without renewing, and whose reason is visible in the service status and log.
 */
describe("service lifetime", () => {
	it("stops a finite service when its lifetime elapses, delivers the completion, and reports why", async () => {
		using tempDir = TempDir.createSync("@omp-service-lifetime-");
		await using run = await harness(tempDir);
		const { client, projectDir } = run;
		const completions: DaemonCompletionNotification[] = [];
		const delivered = Promise.withResolvers<void>();
		const session: ToolSession = {
			cwd: projectDir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			getSessionId: () => "lifetime-session",
			queueLaunchCompletion: notification => {
				completions.push(notification);
				delivered.resolve();
				return Promise.resolve();
			},
		};
		const name = "finite-sleep";
		const startedAt = Date.now();
		// Would run far past the lifetime on its own; pty:false so the child is a plain process tree.
		const started = await startService(session, {
			name,
			command: "echo started; sleep 30",
			pty: false,
			lifetime: LIFETIME_MS / 1_000,
		});
		expect(started.daemon.state).toBe("running");
		expect(started.readyTimedOut).toBe(false);
		// The running snapshot carries the absolute deadline so `proc://` can show time left.
		expect(started.daemon.deadlineAt).toBeGreaterThanOrEqual(startedAt + LIFETIME_MS);
		expect(started.daemon.deadlineAt).toBeLessThanOrEqual(Date.now() + LIFETIME_MS);
		expect(serviceStatus(started.daemon)).toContain("lifetime left");

		const settled = await waitForTerminal(client, name, LIFETIME_MS + 5_000);
		expect(settled.state).toBe("exited");
		expect(settled.pid).toBeUndefined();
		expect(settled.exitReason).toBe("lifetime of 1s expired");
		expect((settled.exitedAt ?? 0) - startedAt).toBeGreaterThanOrEqual(LIFETIME_MS - 50);
		const status = serviceStatus(settled);
		expect(status).toContain("lifetime of 1s expired");
		expect(status).not.toContain("lifetime left");

		const log = await serviceLogs(session, name);
		expect(log).toContain("started");
		expect(log).toContain("[lifetime of 1s expired; stopping]");

		// A harness-initiated stop is still a completion the owner never asked for.
		await delivered.promise;
		expect(completions.map(({ daemon }) => [daemon.name, daemon.state, daemon.exitReason])).toEqual([
			[name, "exited", "lifetime of 1s expired"],
		]);
	}, 20_000);

	it("counts the lifetime across automatic restarts instead of per launch", async () => {
		using tempDir = TempDir.createSync("@omp-service-lifetime-restart-");
		await using run = await harness(tempDir, { restartBackoffBaseMs: RESTART_BACKOFF_BASE_MS });
		const { client, projectDir } = run;
		const name = "crash-loop";
		const started = await client.request({
			op: "start",
			spec: {
				name,
				// Exits immediately; restart:"always" would relaunch it forever without a lifetime.
				application: process.execPath,
				args: ["-e", "process.exit(0)"],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "always",
				persist: false,
				detached: false,
				lifetimeMs: LIFETIME_MS,
			},
		});
		if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);

		const settled = await waitForTerminal(client, name, LIFETIME_MS + 5_000);
		expect(settled.state).toBe("exited");
		expect(settled.exitReason).toBe("lifetime of 1s expired");
		// Each relaunch reused the original deadline: the loop was cut short, not renewed.
		expect(settled.restartCount).toBeGreaterThan(0);

		// Nothing resurrects it after the deadline.
		await Bun.sleep(RESTART_BACKOFF_BASE_MS * 4);
		const later = await describeDaemon(client, name);
		expect(later.state).toBe("exited");
		expect(later.restartCount).toBe(settled.restartCount);
	}, 20_000);
});
