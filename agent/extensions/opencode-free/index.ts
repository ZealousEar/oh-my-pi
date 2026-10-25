import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { FREE_MODELS, RUN_TIMEOUT_MS, runOpenCode, type FreeModel, type OpenCodeResult } from "./transport.ts";

const HELP = "/opencode-free deepseek <task> | glm <task> | cancel\nRuns real OpenCode in this workspace with a fresh session, a 5-minute deadline and explicit tool approvals. Ctrl-C cancels. Native tools/history, not omp model roles; not an OS sandbox. No paid fallback.";
const WIDGET = "opencode-free";

function permissionDetails(request: RequestPermissionRequest, cwd: string): string {
  const call = request.toolCall;
  const details = [`Workspace: ${cwd}`, call.title ?? call.toolCallId];
  if (call.rawInput !== undefined) details.push(JSON.stringify(call.rawInput, null, 2));
  for (const location of call.locations ?? []) details.push(`${location.path}${location.line ? `:${location.line}` : ""}`);
  for (const content of call.content ?? []) {
    if (content.type === "diff") details.push(`${content.path}\n--- before\n${content.oldText ?? ""}\n+++ after\n${content.newText}`);
    else if (content.type === "content" && content.content.type === "text") details.push(content.content.text);
  }
  details.push("Approve this action once? OpenCode will execute it with your user permissions.");
  return details.join("\n\n");
}

export default function (pi: ExtensionAPI) {
  let active: AbortController | undefined;
  let activeRun: Promise<OpenCodeResult> | undefined;
  const cancel = (reason: string) => active?.abort(new Error(reason));
  pi.on("session_switch", async () => {
    cancel("Delegation cancelled: omp session changed.");
    await activeRun?.catch(() => {});
  });
  pi.on("session_shutdown", async () => {
    cancel("Delegation cancelled: omp is shutting down.");
    await activeRun?.catch(() => {});
  });

  pi.registerCommand("opencode-free", {
    description: "Delegate to real OpenCode: deepseek/glm free models, explicit approvals, Ctrl-C cancels",
    getArgumentCompletions(prefix) {
      if (prefix.includes(" ")) return null;
      return ["deepseek", "glm", "cancel", "help"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
      if (!match || match[1] === "help") { ctx.ui.notify(HELP, "info"); return; }
      if (match[1] === "cancel") {
        if (active) cancel("Delegation cancelled by user.");
        else ctx.ui.notify("No OpenCode delegation is running.", "info");
        return;
      }
      if (!Object.hasOwn(FREE_MODELS, match[1]) || !match[2]?.trim()) { ctx.ui.notify(HELP, "error"); return; }
      if (active) { ctx.ui.notify("An OpenCode delegation is already running. Cancel it before starting another.", "warning"); return; }
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for the omp turn to finish before delegating.", "warning"); return; }
      const model = match[1] as FreeModel;
      const controller = new AbortController();
      active = controller;
      const chunks: string[] = [];
      const tools = new Map<string, { title: string; status: string }>();
      let toolSummary = "";
      let tail = "";
      let unsubscribe: (() => void) | undefined;
      try {
        if (ctx.hasUI && typeof ctx.ui.onTerminalInput === "function") {
          unsubscribe = ctx.ui.onTerminalInput(data => {
            if (data === "\u0003") { controller.abort(new Error("Delegation cancelled by Ctrl-C.")); return { consume: true }; }
            return undefined;
          });
        }
        ctx.ui.setStatus(WIDGET, `OpenCode ${model} · 5m deadline · Ctrl-C cancels`);
        ctx.ui.setWidget(WIDGET, [`Starting ${FREE_MODELS[model]} in ${ctx.cwd}`]);
        activeRun = runOpenCode({
          model,
          cwd: ctx.cwd,
          prompt: match[2].trim(),
          signal: controller.signal,
          timeoutMs: RUN_TIMEOUT_MS,
          onUpdate({ update }) {
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
              chunks.push(update.content.text);
              tail = (tail + update.content.text).slice(-4000);
              ctx.ui.setWidget(WIDGET, [`OpenCode ${model}`, ...tail.split(/\r?\n/).slice(-12)]);
            } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
              const previous = tools.get(update.toolCallId);
              tools.set(update.toolCallId, { title: update.title ?? previous?.title ?? update.toolCallId, status: update.status ?? previous?.status ?? "pending" });
              toolSummary = `\n\nNative tools:\n${[...tools.values()].map(tool => `${tool.title}: ${tool.status}`).join("\n")}`;
              ctx.ui.setStatus(WIDGET, `OpenCode ${model} · ${update.status ?? "tool"} · ${update.title ?? update.toolCallId} · Ctrl-C cancels`);
            }
          },
          async onPermission(request, signal) {
            if (!ctx.hasUI || signal.aborted) return false;
            return await ctx.ui.confirm("OpenCode tool approval — once only", permissionDetails(request, ctx.cwd), { signal }) === true && !signal.aborted;
          },
        });
        const result = await activeRun;
        pi.sendMessage({
          customType: "opencode-free", display: true, details: result,
          content: `OpenCode delegation · ${result.modelId}\nSession: ${result.sessionId} · ${result.stopReason}\n\n${result.text || "(No text response.)"}${toolSummary}`,
        }, { triggerTurn: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const partial = chunks.join("");
        pi.sendMessage({
          customType: "opencode-free", display: true,
          details: { modelId: FREE_MODELS[model], error: message, partial },
          content: `OpenCode delegation did not complete · ${FREE_MODELS[model]}\n${message}${partial ? `\n\nPartial output:\n${partial}` : ""}${toolSummary}`,
        }, { triggerTurn: false });
      } finally {
        unsubscribe?.();
        ctx.ui.setStatus(WIDGET, undefined);
        ctx.ui.setWidget(WIDGET, undefined);
        if (active === controller) { active = undefined; activeRun = undefined; }
      }
    },
  });
}
