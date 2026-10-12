/**
 * Fake `herdr` control plane for pane-backend tests.
 *
 * The fake is a real executable written to a temp directory and handed to the
 * CLI wrapper through its `binPath` seam, so no test mutates the process PATH
 * and no test depends on a HerdR install being present. It records every argv
 * it was called with and answers each subcommand from a canned scenario.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** One canned answer, keyed by `"<group> <subcommand>"` (e.g. `"agent start"`). */
export interface FakeHerdrResponse {
	stdout?: string;
	stderr?: string;
	code?: number;
	/** Delay before answering, so a test can abort mid-call. */
	sleepMs?: number;
	/** Side effect standing in for the child writing its result artifact. */
	writeFile?: { path: string; content: string };
}

export interface FakeHerdr {
	/** Directory holding the fake `herdr`; pass as `binPath`. */
	dir: string;
	/** Absolute path of the fake executable. */
	bin: string;
	/** Every recorded invocation, session flags included. */
	calls(): string[][];
	/** `"<group> <subcommand>"` of each invocation, session flags stripped. */
	keys(): string[];
	/** Resolves once the fake has been entered for `key` (before it answers or sleeps). */
	waitForCall(key: string): Promise<void>;
	cleanup(): void;
}

const RUNNER = `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const dir = process.env.FAKE_HERDR_DIR;
const argv = process.argv.slice(2);
appendFileSync(path.join(dir, "argv.log"), JSON.stringify(argv) + "\\n");
writeFileSync(path.join(dir, "entered-" + process.pid), "");
const scenario = JSON.parse(readFileSync(path.join(dir, "scenario.json"), "utf8"));
const args = argv[0] === "--session" ? argv.slice(2) : argv;
const entry = scenario[args.slice(0, 2).join(" ")] ?? scenario[args[0] ?? ""];
if (!entry) {
	process.stderr.write("usage: herdr " + args.slice(0, 2).join(" ") + "\\n");
	process.exit(2);
}
if (entry.sleepMs) {
	const { promise, resolve } = Promise.withResolvers();
	setTimeout(resolve, entry.sleepMs);
	await promise;
}
if (entry.writeFile) {
	mkdirSync(path.dirname(entry.writeFile.path), { recursive: true });
	writeFileSync(entry.writeFile.path, entry.writeFile.content);
}
if (entry.stdout) process.stdout.write(entry.stdout + "\\n");
if (entry.stderr) process.stderr.write(entry.stderr + "\\n");
process.exit(entry.code ?? 0);
`;

/** Write a fake `herdr` answering `scenario`. */
export function createFakeHerdr(scenario: Record<string, FakeHerdrResponse>): FakeHerdr {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fake-herdr-"));
	const bin = path.join(dir, "herdr");
	fs.writeFileSync(path.join(dir, "runner.mjs"), RUNNER);
	fs.writeFileSync(path.join(dir, "scenario.json"), JSON.stringify(scenario));
	fs.writeFileSync(bin, `#!/bin/sh\nFAKE_HERDR_DIR="${dir}" exec "${process.execPath}" "${dir}/runner.mjs" "$@"\n`);
	fs.chmodSync(bin, 0o755);
	const read = (): string[][] => {
		let log = "";
		try {
			log = fs.readFileSync(path.join(dir, "argv.log"), "utf8");
		} catch {
			return [];
		}
		return log
			.split("\n")
			.filter(line => line.trim())
			.map(line => JSON.parse(line) as string[]);
	};
	const keys = (): string[] =>
		read().map(argv => {
			const args = argv[0] === "--session" ? argv.slice(2) : argv;
			return args.slice(0, 2).join(" ");
		});
	const watchers = new Set<fs.FSWatcher>();
	return {
		dir,
		bin,
		calls: read,
		keys,
		waitForCall: key => {
			// The runner logs its argv and creates a fresh `entered-*` marker before
			// it sleeps or answers. Watching the directory therefore observes the
			// subcommand being entered even on watchers that only report entry
			// creation (kqueue), never appends to an existing file.
			const { promise, resolve } = Promise.withResolvers<void>();
			if (keys().includes(key)) {
				resolve();
				return promise;
			}
			const watcher = fs.watch(dir, () => {
				if (!keys().includes(key)) return;
				watcher.close();
				watchers.delete(watcher);
				resolve();
			});
			watchers.add(watcher);
			return promise;
		},
		cleanup: () => {
			for (const watcher of watchers) watcher.close();
			watchers.clear();
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** `herdr status` output of a running server. */
export function runningStatus(socket = "/tmp/fake-herdr/herdr.sock"): string {
	return `client:\n  version: 0.8.2\n\nserver:\n  status: running\n  socket: ${socket}\n`;
}

/** `herdr integration status` output with the omp row installed. */
export const OMP_INTEGRATION_INSTALLED =
	"pi: not installed (/x/pi)\nomp: current (v8) (/x/.omp/agent/extensions/herdr-omp-agent-state.ts)\n";

/** A minimal successful envelope. */
export function envelope(result: unknown): string {
	return JSON.stringify({ id: "cli:test", result });
}

/** A herdr error envelope with its documented code. */
export function errorEnvelope(code: string, message: string): string {
	return JSON.stringify({ error: { code, message }, id: "cli:test" });
}
