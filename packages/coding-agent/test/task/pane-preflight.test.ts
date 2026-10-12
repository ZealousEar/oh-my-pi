import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import {
	type PaneBackendConfig,
	type PaneCapabilityProbe,
	preflightPaneBackend,
	readPaneBackendConfig,
	requestPaneBackend,
} from "../../src/task/pane/preflight";
import { createFakeHerdr, type FakeHerdr, OMP_INTEGRATION_INSTALLED, runningStatus } from "./pane-fake-herdr";

const NO_CAPABILITIES: PaneCapabilityProbe = {
	outputSchema: false,
	isolated: false,
	customTools: false,
	nestedSpawn: false,
	mcpProxies: false,
	advisor: false,
	prewalk: false,
	restrictedSession: false,
};

const NATIVE: PaneBackendConfig = {
	backend: "native",
	session: undefined,
	readyTimeoutMs: 30_000,
	promptTimeoutMs: 600_000,
	keepPane: false,
};

const INSIDE_PANE = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" } satisfies NodeJS.ProcessEnv;

/** Agent dir the fixture's `integration status` reports the omp extension under. */
const INSTALLED_AGENT_DIR = "/x/.omp/agent";

let fake: FakeHerdr | undefined;

afterEach(() => {
	fake?.cleanup();
	fake = undefined;
});

function healthyFake(): FakeHerdr {
	return createFakeHerdr({
		status: { stdout: runningStatus("/tmp/omp-next-test/herdr.sock") },
		"integration status": { stdout: OMP_INTEGRATION_INSTALLED },
	});
}

describe("pane backend selection", () => {
	test("native stays the default, and visible:false never asks for a pane", () => {
		expect(requestPaneBackend({ config: NATIVE, env: INSIDE_PANE })).toEqual({ use: false });
		expect(requestPaneBackend({ config: NATIVE, visible: false, env: INSIDE_PANE })).toEqual({ use: false });
	});

	test("visible:true and paneBackend=herdr are strict requests", () => {
		expect(requestPaneBackend({ config: NATIVE, visible: true, env: {} })).toEqual({ use: true, strict: true });
		expect(requestPaneBackend({ config: { ...NATIVE, backend: "herdr" }, env: {} })).toEqual({
			use: true,
			strict: true,
		});
	});

	test("auto uses a pane only when this process really runs inside HerdR", () => {
		const auto: PaneBackendConfig = { ...NATIVE, backend: "auto" };
		expect(requestPaneBackend({ config: auto, env: INSIDE_PANE })).toEqual({ use: true, strict: false });
		expect(requestPaneBackend({ config: auto, env: {} })).toEqual({ use: false });
		// Client-side vars are not pane identity.
		expect(requestPaneBackend({ config: auto, env: { HERDR_SOCKET_PATH: "/tmp/x.sock" } })).toEqual({ use: false });
		// An explicit session is never picked up implicitly by auto.
		expect(requestPaneBackend({ config: { ...auto, session: "omp-tasks" }, env: INSIDE_PANE })).toEqual({
			use: false,
		});
	});

	test("OMP_TASK_HERDR overrides the setting in both directions", () => {
		expect(
			requestPaneBackend({ config: NATIVE, visible: true, env: { ...INSIDE_PANE, OMP_TASK_HERDR: "0" } }),
		).toEqual({ use: false });
		expect(requestPaneBackend({ config: NATIVE, env: { ...INSIDE_PANE, OMP_TASK_HERDR: "1" } })).toEqual({
			use: true,
			strict: false,
		});
	});

	test("settings feed the config block", () => {
		const settings = Settings.isolated({
			"task.paneBackend": "herdr",
			"task.herdr.session": " omp-tasks ",
			"task.herdr.keepPane": true,
		});
		expect(readPaneBackendConfig(settings)).toEqual({
			backend: "herdr",
			session: "omp-tasks",
			readyTimeoutMs: 30_000,
			promptTimeoutMs: 600_000,
			keepPane: true,
		});
		expect(readPaneBackendConfig(Settings.isolated()).session).toBeUndefined();
	});
});

describe("pane backend preflight", () => {
	test("rejects an omp integration installed for a different agent dir than the child uses", async () => {
		fake = createFakeHerdr({
			status: { stdout: runningStatus() },
			"integration status": {
				stdout: "omp: current (v8) (/wrong/agent/extensions/herdr-omp-agent-state.ts)\n",
			},
		});
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-dir-"));
		try {
			const result = await preflightPaneBackend({
				config: { ...NATIVE, backend: "herdr", session: "omp-next-test" },
				cwd: process.cwd(),
				capabilities: NO_CAPABILITIES,
				binPath: fake.dir,
				agentDir,
				env: {},
			});
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.reason).toContain("/wrong/agent/extensions/herdr-omp-agent-state.ts");
			expect(result.reason).toContain(agentDir);
			expect(result.reason).toContain(`PI_CODING_AGENT_DIR=${agentDir} herdr integration install omp`);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("rejects capabilities a pane child cannot honour", async () => {
		fake = healthyFake();
		const result = await preflightPaneBackend({
			config: { ...NATIVE, backend: "herdr", session: "omp-next-test" },
			cwd: process.cwd(),
			capabilities: {
				...NO_CAPABILITIES,
				outputSchema: true,
				isolated: true,
				mcpProxies: true,
				restrictedSession: true,
			},
			binPath: fake.dir,
			agentDir: INSTALLED_AGENT_DIR,
			env: {},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("structured outputSchema");
		expect(result.reason).toContain("isolated worktree");
		expect(result.reason).toContain("parent MCP tools");
		expect(result.reason).toContain("restricted parent session");
		// Nothing was asked of HerdR.
		expect(fake.keys()).toEqual([]);
	});

	test("rejects the user's default session", async () => {
		fake = healthyFake();
		const result = await preflightPaneBackend({
			config: { ...NATIVE, backend: "herdr", session: "default" },
			cwd: process.cwd(),
			capabilities: NO_CAPABILITIES,
			binPath: fake.dir,
			env: {},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("dedicated session");
		expect(fake.keys()).toEqual([]);
	});

	test("rejects an outside-HerdR session with no configured target", async () => {
		fake = healthyFake();
		const result = await preflightPaneBackend({
			config: { ...NATIVE, backend: "herdr" },
			cwd: process.cwd(),
			capabilities: NO_CAPABILITIES,
			binPath: fake.dir,
			env: {},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("task.herdr.session");
	});

	test("reports a missing herdr binary", async () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "omp-no-herdr-"));
		try {
			const result = await preflightPaneBackend({
				config: { ...NATIVE, backend: "herdr", session: "omp-next-test" },
				cwd: process.cwd(),
				capabilities: NO_CAPABILITIES,
				binPath: empty,
				env: {},
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toContain("`herdr` binary is not on PATH");
		} finally {
			fs.rmSync(empty, { recursive: true, force: true });
		}
	});

	test("reports a session whose server is not running", async () => {
		fake = createFakeHerdr({
			status: { stdout: "client:\n  version: 0.8.2\n\nserver:\n  status: not running\n" },
			"integration status": { stdout: OMP_INTEGRATION_INSTALLED },
		});
		const result = await preflightPaneBackend({
			config: { ...NATIVE, backend: "herdr", session: "omp-next-test" },
			cwd: process.cwd(),
			capabilities: NO_CAPABILITIES,
			binPath: fake.dir,
			env: {},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('session "omp-next-test" has no running HerdR server');
	});

	test("reports a missing omp integration", async () => {
		fake = createFakeHerdr({
			status: { stdout: runningStatus() },
			"integration status": { stdout: "omp: not installed (/x/.omp/agent/extensions/herdr-omp-agent-state.ts)\n" },
		});
		const result = await preflightPaneBackend({
			config: { ...NATIVE, backend: "herdr", session: "omp-next-test" },
			cwd: process.cwd(),
			capabilities: NO_CAPABILITIES,
			binPath: fake.dir,
			env: {},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("herdr integration install omp");
	});

	test("falls back to the agent-dir extension when `integration status` is unavailable", async () => {
		fake = createFakeHerdr({ status: { stdout: runningStatus() } });
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-dir-"));
		try {
			const missing = await preflightPaneBackend({
				config: { ...NATIVE, backend: "herdr", session: "omp-next-test" },
				cwd: process.cwd(),
				capabilities: NO_CAPABILITIES,
				binPath: fake.dir,
				agentDir,
				env: {},
			});
			expect(missing.ok).toBe(false);
			if (!missing.ok) expect(missing.reason).toContain("herdr-omp-agent-state.ts");

			fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
			fs.writeFileSync(path.join(agentDir, "extensions", "herdr-omp-agent-state.ts"), "// installed\n");
			const present = await preflightPaneBackend({
				config: { ...NATIVE, backend: "herdr", session: "omp-next-test" },
				cwd: process.cwd(),
				capabilities: NO_CAPABILITIES,
				binPath: fake.dir,
				agentDir,
				env: {},
			});
			expect(present.ok).toBe(true);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("session targeting qualifies every call and records the socket", async () => {
		fake = healthyFake();
		const result = await preflightPaneBackend({
			config: { ...NATIVE, backend: "herdr", session: "omp-next-test" },
			cwd: process.cwd(),
			capabilities: NO_CAPABILITIES,
			binPath: fake.dir,
			agentDir: INSTALLED_AGENT_DIR,
			env: {},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.target).toEqual({ kind: "session", session: "omp-next-test" });
		expect(result.socketPath).toBe("/tmp/omp-next-test/herdr.sock");
		expect(result.cli.argv(["agent", "list"])).toEqual(["--session", "omp-next-test", "agent", "list"]);
		expect(fake.calls()[0]?.slice(0, 3)).toEqual(["--session", "omp-next-test", "status"]);
	});

	test("inside a pane the target is the calling pane and calls carry no session flag", async () => {
		fake = healthyFake();
		const result = await preflightPaneBackend({
			config: { ...NATIVE, backend: "auto" },
			cwd: process.cwd(),
			capabilities: NO_CAPABILITIES,
			binPath: fake.dir,
			agentDir: INSTALLED_AGENT_DIR,
			env: INSIDE_PANE,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.target).toEqual({ kind: "current" });
		expect(result.cli.argv(["agent", "list"])).toEqual(["agent", "list"]);
		expect(fake.calls()[0]).toEqual(["status"]);
	});
});
