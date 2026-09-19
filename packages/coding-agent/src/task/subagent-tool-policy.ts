/**
 * Tool allowlist and spawn policy a subagent receives, derived from its agent
 * definition and the parent's depth. Shared by the native in-process executor
 * and the HerdR pane backend so both children run under one contract.
 */
import type { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import { resolveEvalBackends } from "../tools/eval-backends";
import { isReadOnlyAgent } from "./read-only-policy";
import type { AgentDefinition } from "./types";

export interface SubagentToolPolicyOptions {
	agent: AgentDefinition;
	settings: Settings;
	/** Depth of the spawning session; the child runs one level deeper. */
	parentDepth: number;
	/** Restricted sessions must not widen an explicit host tool list with `hub`. */
	restrictToolNames?: boolean;
}

export interface SubagentToolPolicy {
	/** Explicit host tool allowlist, or undefined when the child gets every tool. */
	toolNames: string[] | undefined;
	/** Spawn policy the child session receives: `"*"`, an agent list, or `""` (spawning disabled). */
	spawns: string;
	childDepth: number;
	/** True when the child sits at `task.maxRecursionDepth` and may not spawn. */
	atMaxDepth: boolean;
	/** Configured `task.maxRecursionDepth`; negative disables the cap. */
	maxRecursionDepth: number;
}

/**
 * Normalize an agent's declared tools into the allowlist its session gets:
 * `task` is added when the agent may spawn and removed at maximum depth, `hub`
 * is added for ordinary (non-restricted) sessions, and the `exec` alias expands
 * to the eval/bash backends enabled in settings.
 */
export function resolveSubagentToolPolicy(options: SubagentToolPolicyOptions): SubagentToolPolicy {
	const { agent, settings } = options;
	const maxRecursionDepth = settings.get("task.maxRecursionDepth") ?? 2;
	const childDepth = options.parentDepth + 1;
	const atMaxDepth = maxRecursionDepth >= 0 && childDepth >= maxRecursionDepth;

	let toolNames: string[] | undefined;
	if (agent.tools) {
		toolNames = agent.tools;
		// Auto-include task tool if spawns defined but task not in tools
		if (agent.spawns !== undefined && !toolNames.includes("task") && !atMaxDepth) {
			toolNames = [...toolNames, "task"];
		}
	}
	if (atMaxDepth && toolNames?.includes("task")) {
		toolNames = toolNames.filter(name => name !== "task");
	}
	// Ordinary agents retain the host's always-on collaboration capability.
	// Restricted sessions must not widen their explicit host tool list with hub.
	if (
		toolNames &&
		!options.restrictToolNames &&
		!toolNames.includes("hub") &&
		(!isReadOnlyAgent(agent) || toolNames.includes("task"))
	) {
		toolNames = [...toolNames, "hub"];
	}
	if (toolNames?.includes("exec")) {
		const backends = resolveEvalBackends({ settings } as ToolSession);
		const expanded = toolNames.filter(name => name !== "exec");
		if (backends.python || backends.js) expanded.push("eval");
		expanded.push("bash");
		toolNames = Array.from(new Set(expanded));
	}

	const spawns = atMaxDepth
		? ""
		: agent.spawns === undefined
			? ""
			: agent.spawns === "*"
				? "*"
				: agent.spawns.join(",");

	return { toolNames, spawns, childDepth, atMaxDepth, maxRecursionDepth };
}
