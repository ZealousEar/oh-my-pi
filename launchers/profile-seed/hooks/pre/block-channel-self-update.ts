import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

// Channel guard (installed per channel profile by the launcher-isolation wave,
// 2026-09-19). ADVISORY layer: the structural protections are the immutable
// wrappers/targets (chflags uchg) and the wrappers' own `update` refusal. This
// hook only stops an agent from launching the self-updater or a global install
// in the first place. There is NO in-session bypass: pinned channels are updated
// only through the runbook's versioned-pin path (unlock, install.sh, re-lock).
// Mirrors ~/.omp/agent/hooks/pre/block-omp-self-update.ts (legacy default profile),
// which keeps its own OMP_ALLOW_SELF_UPDATE override for the legacy build.

// A shell token never spans a command separator.
const TOK = String.raw`[^\s;&|()]`;
const ASSIGN = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|${TOK}*)[ \t]+)*`;
// Wrapper options may take an operand (`env -u FOO`, `sudo -u root`, `exec -a name`).
const WRAPPERS = String.raw`(?:(?:command|exec|sudo|env)[ \t]+(?:-{1,2}${TOK}+(?:[ \t]+[^-\s;&|()]${TOK}*)?[ \t]+)*${ASSIGN})*`;
const AT_COMMAND = String.raw`(?:^|[\n;&|(]|&&|\|\|)[ \t]*${ASSIGN}${WRAPPERS}`;
const OPTS = String.raw`(?:-{1,2}${TOK}+(?:[ \t]+[^-\s;&|()]${TOK}*)?[ \t]+)*`;
const EXE = String.raw`(?:` +
	String.raw`omp(?:d|dev)?|` + // channel wrappers by name
	String.raw`${TOK}*/omp(?:d|dev)?|` + // any path ending in /omp, /ompd, /ompdev (incl. /opt/homebrew/bin/omp)
	String.raw`${TOK}*/\.omp-channels/${TOK}+|${TOK}*/\.omp-custom/${TOK}+|${TOK}*/omp-\d+\.\d+\.\d+${TOK}*|` + // pinned/legacy binaries
	String.raw`(?:${TOK}*/)?bun[ \t]+(?:-{1,2}${TOK}+[ \t]+)*${TOK}*/src/cli\.ts|` + // source entry
	String.raw`${TOK}*/scripts/omp` + // repo dev launcher
	String.raw`)`;
const UPDATE = String.raw`(?:update|upgrade|self-update)\b`;
const BANNED: Array<[RegExp, string]> = [
	[new RegExp(AT_COMMAND + EXE + String.raw`[ \t]+` + OPTS + UPDATE), "omp's self-updater would target the PATH-resolved `omp` (the pinned stock wrapper)"],
	[new RegExp(String.raw`(?:spawn|spawnSync|exec\w*)\s*\(\s*\[?\s*["'](?:omp(?:d|dev)?|\S*/omp\S*)["']\s*,\s*["']` + UPDATE), "programmatic spawn of the self-updater"],
	[new RegExp(AT_COMMAND + String.raw`brew[ \t]+(?:upgrade|install|reinstall|link)[ \t]+(?:-{1,2}\S+[ \t]+)*omp\b`), "Homebrew would relink /opt/homebrew/bin/omp"],
	[new RegExp(AT_COMMAND + String.raw`(?:bun|npm|pnpm|yarn)[ \t]+(?:add|install|i)[ \t]+(?:-{1,2}\S+[ \t]+)*(?:-g|--global)[ \t]+(?:\S+[ \t]+)*omp\b`), "a global package install would shadow the channel wrappers"],
];
const EXEC_TOOLS: Record<string, true> = { bash: true, hub: true, eval: true };

function subjectOf(toolName: string, input: Record<string, unknown>): string {
	const parts: string[] = [];
	if (typeof input.command === "string") parts.push(input.command);
	if (typeof input.code === "string") parts.push(input.code);
	if (typeof input.text === "string") parts.push(input.text);
	if (toolName === "hub" && typeof input.application === "string") {
		// hub start: application + argv is one command line.
		const args = Array.isArray(input.args) ? input.args.filter((a): a is string => typeof a === "string") : [];
		parts.push([input.application, ...args].join(" "));
	}
	return parts.join("\n");
}

export default function hook(pi: HookAPI): void {
	pi.on("tool_call", async (event) => {
		if (!EXEC_TOOLS[event.toolName]) return;
		const input = event.input as Record<string, unknown> | undefined;
		if (!input) return;
		const subject = subjectOf(event.toolName, input);
		if (!subject) return;
		const match = BANNED.find(([pattern]) => pattern.test(subject));
		if (!match) return;
		return {
			block: true,
			reason:
				`BLOCKED: ${match[1]}. Channel executables are pinned (omp = stock v18.2.6, ompd = frozen fork, ` +
				`ompdev = source checkout) and immutable; there is no in-session override. Bump or rebuild a channel ` +
				`through the runbook (~/.omp/implementation-2026-09-18/launchers/RUNBOOK.md) and check \`omp-channels\`.`,
		};
	});
}
