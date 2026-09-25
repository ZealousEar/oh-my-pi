// Integration test — real timers are required (ts-no-test-timers exception): this spawns the
// actual cross-process daemon broker driving real child processes. The contract under test is
// that the broker's lifetime deadline terminates a real child through the stop path; fake timers
// cannot control the OS process-exit promise or the unix-socket RPC the broker relies on.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerStartOptions, startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import { type DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/hub";

const LIFETIME_MS = 1_000;
const RESTART_BACKOFF_BASE_MS = 100;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string, options: DaemonBrokerStartOptions = {}): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment(options);
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
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
	broker: Promise<void>;
	projectDir: string;
	[Symbol.asyncDispose](): Promise<void>;
}

async function harness(tempDir: TempDir, options: DaemonBrokerStartOptions = {}): Promise<Harness> {
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const previousTitle = process.title;
	// Create the client (writes broker.token) before starting the broker, which reads that token.
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	const broker = startBroker(projectDir, runtimeDir, options);
	return {
		client,
		broker,
		projectDir,
		async [Symbol.asyncDispose]() {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		},
	};
}

describe("daemon broker lifetime", () => {
	it("stops a finite run when its lifetime elapses and reports why", async () => {
		using tempDir = TempDir.createSync("@omp-launch-lifetime-");
		await using run = await harness(tempDir);
		const { client, projectDir } = run;
		const name = "finite-sleep";
		const startedAt = Date.now();
		const started = await client.request({
			op: "start",
			spec: {
				name,
				// Would run far past the lifetime on its own.
				application: process.execPath,
				args: ["-e", "setTimeout(() => {}, 30000)"],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
				lifetimeMs: LIFETIME_MS,
			},
		});
		if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);
		expect(started.daemon.state).toBe("running");
		// The running snapshot carries the absolute deadline so `ps` can show time left.
		expect(started.daemon.deadlineAt).toBeGreaterThanOrEqual(startedAt + LIFETIME_MS);
		expect(started.daemon.deadlineAt).toBeLessThanOrEqual(Date.now() + LIFETIME_MS);

		const settled = await waitForTerminal(client, name, LIFETIME_MS + 5_000);
		expect(settled.state).toBe("exited");
		expect(settled.pid).toBeUndefined();
		expect(settled.exitReason).toBe("lifetime of 1s expired");
		expect((settled.exitedAt ?? 0) - startedAt).toBeGreaterThanOrEqual(LIFETIME_MS - 50);

		const logs = await client.request({ op: "logs", name, lines: 20, head: false, follow: false, timeoutMs: 1_000 });
		if (logs.op !== "logs") throw new Error(`unexpected result: ${logs.op}`);
		expect(logs.text).toContain("[lifetime of 1s expired; stopping]");
	}, 20_000);

	it("counts the lifetime across automatic restarts instead of per launch", async () => {
		using tempDir = TempDir.createSync("@omp-launch-lifetime-restart-");
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
