import { describe, expect, it } from "bun:test";
import {
	CUA_DRIVER_APP_PATH,
	CUA_DRIVER_MIN_VERSION,
	CUA_DRIVER_TELEMETRY_ENV,
	type CuaDriverExec,
	type CuaSpawnEnv,
	cuaPermissionModes,
	cuaSpawnEnv,
	describeCuaDriver,
	detectCuaDriver,
	isCuaDriverVersionSupported,
	parseCuaDriverPermissions,
	parseCuaDriverVersion,
} from "@oh-my-pi/pi-coding-agent/tools/computer/cua-driver";

const NOTHING_EXISTS = async (): Promise<boolean> => false;

/** Real `cua-driver status` output (rust/crates/cua-driver/src/serve.rs `run_status_cmd`). */
/** Captured verbatim from cua-driver 0.28.2 on 2026-09-18; the `unavailable` policy line must not read as "stopped". */
const STATUS_RUNNING =
	"Cua Driver daemon is running\n  socket: /Users/x/Library/Caches/cua-driver/cua-driver.sock\n  pid: 81421\n  permission mode: standard (built_in_default)\n  user policy: configured=false, active=false, valid=true\n  managed policy: configured=false, active=false, valid=true\n  authorization host: unavailable (unavailable)\n  capability manifest: configured=false, approved_at_startup=false, valid=true\n";
const STATUS_STOPPED = "Cua Driver daemon is not running\n";

/** Real `cua-driver permissions status --json` payloads (rust/crates/cua-driver/src/cli.rs `run_permissions_status`). */
const PERMISSIONS_GRANTED =
	'{"accessibility":true,"screen_recording":true,"screen_recording_capturable":null,"direct_capture_status":"not_checked","source":{"attribution":"driver-daemon","pid":4242}}';
const PERMISSIONS_NO_DAEMON =
	'{"daemon_running":false,"status":"unknown","reason":"no CuaDriver daemon is running under the driver\'s own identity (com.trycua.driver), so its real TCC status can\'t be read from this process."}';

/** Exec seam answering each probe by its first argument. */
function fakeExec(replies: Record<string, { stdout?: string; stderr?: string; code?: number }>): {
	exec: CuaDriverExec;
	calls: Array<{ args: string[]; timeoutMs: number; env: CuaSpawnEnv }>;
} {
	const calls: Array<{ args: string[]; timeoutMs: number; env: CuaSpawnEnv }> = [];
	const exec: CuaDriverExec = async (_command, args, timeoutMs, env) => {
		calls.push({ args, timeoutMs, env });
		const reply = replies[args[0] ?? ""] ?? {};
		return { stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", code: reply.code ?? 0, killed: false };
	};
	return { exec, calls };
}

describe("cua driver detection", () => {
	it("reports every probed location when the driver is absent and never executes anything", async () => {
		const { exec, calls } = fakeExec({});
		const detection = await detectCuaDriver({
			driverBin: "/opt/explicit/cua-driver",
			env: { CUA_DRIVER_BIN: "/opt/env/cua-driver" },
			exists: NOTHING_EXISTS,
			which: () => null,
			exec,
		});
		expect(detection.installed).toBe(false);
		if (detection.installed) return;
		expect(detection.searched).toEqual([
			"/opt/explicit/cua-driver",
			"/opt/env/cua-driver",
			CUA_DRIVER_APP_PATH,
			"cua-driver (PATH)",
		]);
		expect(calls).toHaveLength(0);
		expect(describeCuaDriver(detection)).toContain("not installed");
	});

	it("prefers the configured binary, bounds every probe, and reports a usable driver from the real probe shapes", async () => {
		const { exec, calls } = fakeExec({
			"--version": { stdout: `cua-driver ${CUA_DRIVER_MIN_VERSION}\n` },
			status: { stdout: STATUS_RUNNING },
			permissions: { stdout: PERMISSIONS_GRANTED },
		});
		const detection = await detectCuaDriver({
			driverBin: "/opt/explicit/cua-driver",
			exists: async path => path === "/opt/explicit/cua-driver",
			which: () => "/usr/local/bin/cua-driver",
			exec,
		});
		expect(detection.installed).toBe(true);
		if (!detection.installed) return;
		expect(detection.path).toBe("/opt/explicit/cua-driver");
		expect(detection.version).toBe(CUA_DRIVER_MIN_VERSION);
		expect(detection.daemonRunning).toBe(true);
		expect(detection.permissions).toEqual({ accessibility: "granted", screenRecording: "granted" });
		expect(detection.modes).toEqual({ observe: true, act: true, screenshot: true });
		expect(detection.usable).toBe(true);
		expect(detection.blockers).toEqual([]);
		expect(detection.remediation).toBeUndefined();
		expect(calls.map(call => call.args)).toEqual([["--version"], ["status"], ["permissions", "status", "--json"]]);
		expect(calls.every(call => call.timeoutMs > 0 && call.timeoutMs <= 5_000)).toBe(true);
	});

	it("opts every probe out of telemetry through the documented per-process override by default", async () => {
		const replies = {
			"--version": { stdout: "cua-driver 0.28.2" },
			status: { stdout: STATUS_RUNNING },
			permissions: { stdout: PERMISSIONS_GRANTED },
		};
		const silent = fakeExec(replies);
		await detectCuaDriver({
			exists: async () => true,
			which: () => null,
			exec: silent.exec,
			env: { HOME: "/tmp/h" },
		});
		expect(silent.calls).toHaveLength(3);
		expect(silent.calls.every(call => call.env[CUA_DRIVER_TELEMETRY_ENV] === "false")).toBe(true);
		expect(silent.calls[0]!.env.HOME).toBe("/tmp/h");

		const deferred = fakeExec(replies);
		await detectCuaDriver({
			exists: async () => true,
			which: () => null,
			exec: deferred.exec,
			env: { HOME: "/tmp/h" },
			telemetry: "driver",
		});
		expect(deferred.calls.every(call => !(CUA_DRIVER_TELEMETRY_ENV in call.env))).toBe(true);
		expect(cuaSpawnEnv("off", {})).toEqual({ [CUA_DRIVER_TELEMETRY_ENV]: "false" });
		expect(cuaSpawnEnv("driver", { KEEP: "1" })).toEqual({ KEEP: "1" });
	});

	it("names each blocker and the driver's own grant flow when the daemon is down and a permission is missing", async () => {
		const { exec } = fakeExec({
			"--version": { stdout: "cua-driver 0.28.2" },
			status: { stderr: STATUS_STOPPED, code: 1 },
			permissions: {
				stdout: '{"accessibility":true,"screen_recording":false,"source":{"attribution":"driver-daemon"}}',
			},
		});
		const detection = await detectCuaDriver({ exists: async () => true, which: () => null, exec });
		expect(detection.installed).toBe(true);
		if (!detection.installed) return;
		expect(detection.path).toBe(CUA_DRIVER_APP_PATH);
		expect(detection.daemonRunning).toBe(false);
		expect(detection.permissions).toEqual({ accessibility: "granted", screenRecording: "denied" });
		expect(detection.modes).toEqual({ observe: true, act: false, screenshot: false });
		expect(detection.usable).toBe(false);
		expect(detection.blockers).toEqual([
			"driver daemon is not running (this agent never starts it)",
			"driver lacks macOS Screen Recording permission",
		]);
		expect(detection.remediation).toContain("open -n -g -a CuaDriver --args serve");
		expect(detection.remediation).toContain("cua-driver permissions grant");
		expect(detection.remediation).toContain("Screen & System Audio Recording");
		expect(detection.remediation).not.toContain("Privacy & Security > Accessibility");
		expect(describeCuaDriver(detection)).toContain("unusable");
	});

	it("reports unknown grants, never granted, when no daemon answers for the driver's identity", async () => {
		const { exec } = fakeExec({
			"--version": { stdout: "cua-driver 0.28.2" },
			status: { stderr: STATUS_STOPPED, code: 1 },
			permissions: { stdout: PERMISSIONS_NO_DAEMON },
		});
		const detection = await detectCuaDriver({ exists: async () => true, which: () => null, exec });
		expect(detection.installed).toBe(true);
		if (!detection.installed) return;
		expect(detection.permissions).toEqual({ accessibility: "unknown", screenRecording: "unknown" });
		expect(detection.modes).toEqual({ observe: false, act: false, screenshot: false });
		expect(detection.blockers).toContain(
			"driver's macOS Accessibility permission is unknown (no daemon answered under the driver's identity)",
		);
		expect(detection.blockers.join(" ")).not.toContain("lacks");
	});

	it("parses the documented text form of permissions status in either line order", () => {
		expect(parseCuaDriverPermissions("Accessibility:    ✅ granted\nScreen Recording: ❌ not granted\n")).toEqual({
			accessibility: "granted",
			screenRecording: "denied",
		});
		expect(parseCuaDriverPermissions("✅ Accessibility: granted.\n✅ Screen Recording: granted.\n")).toEqual({
			accessibility: "granted",
			screenRecording: "granted",
		});
		expect(
			parseCuaDriverPermissions(
				"Accessibility:    ❓ unknown\nScreen Recording: ❓ unknown\nNo CuaDriver daemon is running",
			),
		).toEqual({
			accessibility: "unknown",
			screenRecording: "unknown",
		});
	});

	it("treats unreadable probe output as unknown instead of granted", async () => {
		const { exec } = fakeExec({
			"--version": { stdout: "unreleased build" },
			status: { stdout: "???" },
			permissions: { stdout: "not json at all" },
		});
		const detection = await detectCuaDriver({ exists: async () => true, which: () => null, exec });
		expect(detection.installed).toBe(true);
		if (!detection.installed) return;
		expect(detection.version).toBeUndefined();
		expect(detection.daemonRunning).toBe(false);
		expect(detection.permissions).toEqual({ accessibility: "unknown", screenRecording: "unknown" });
		expect(detection.blockers[0]).toContain(`below the required ${CUA_DRIVER_MIN_VERSION}`);
		expect(detection.raw.permissions).toBe("not json at all");
	});

	it("parses versions and compares them against the required minimum", () => {
		expect(parseCuaDriverVersion("cua-driver version 1.2.3-beta.1 (arm64)")).toBe("1.2.3-beta.1");
		expect(parseCuaDriverVersion("no version here")).toBeUndefined();
		expect(isCuaDriverVersionSupported(CUA_DRIVER_MIN_VERSION)).toBe(true);
		expect(isCuaDriverVersionSupported("0.28.1")).toBe(false);
		expect(isCuaDriverVersionSupported("0.23.2")).toBe(false);
		expect(isCuaDriverVersionSupported("0.29.0")).toBe(true);
		expect(isCuaDriverVersionSupported("1.0.0")).toBe(true);
		expect(isCuaDriverVersionSupported(undefined)).toBe(false);
	});

	it("reads permission aliases from nested and flat payloads", () => {
		expect(parseCuaDriverPermissions('{"status":{"ax":"authorized","screenCapture":"restricted"}}')).toEqual({
			accessibility: "granted",
			screenRecording: "denied",
		});
		expect(parseCuaDriverPermissions('{"accessibility":false,"screenRecording":false}')).toEqual({
			accessibility: "denied",
			screenRecording: "denied",
		});
		expect(parseCuaDriverPermissions("[]")).toEqual({ accessibility: "unknown", screenRecording: "unknown" });
		expect(cuaPermissionModes({ accessibility: "granted", screenRecording: "unknown" })).toEqual({
			observe: true,
			act: false,
			screenshot: false,
		});
	});
});
