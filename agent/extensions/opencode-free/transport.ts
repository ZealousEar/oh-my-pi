import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { ClientConnection, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

export const FREE_MODELS = {
  deepseek: "opencode/deepseek-v4.1-flash-free",
  glm: "opencode/glm-5.3-flash-free",
} as const;
export type FreeModel = keyof typeof FREE_MODELS;
export const RUN_TIMEOUT_MS = 300_000;

const RUNTIME_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"];

export function createOpenCodeEnvironment(source: NodeJS.ProcessEnv, model: FreeModel): NodeJS.ProcessEnv {
  if (!Object.hasOwn(FREE_MODELS, model)) throw new Error("Choose deepseek or glm.");
  const env: NodeJS.ProcessEnv = {};
  for (const name of RUNTIME_ENV) if (source[name] !== undefined) env[name] = source[name];
  const modelId = FREE_MODELS[model];
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    model: modelId,
    small_model: modelId,
    default_agent: "build",
    enabled_providers: ["opencode"],
    provider: { opencode: { whitelist: [modelId.slice("opencode/".length)] } },
    autoupdate: false,
    share: "disabled",
    // Keep real native tools available, but require an explicit decision for every action.
    permission: "ask",
    agent: Object.fromEntries(["build", "general", "explore", "compaction", "summary", "title"].map(name => [name, { model: modelId }])),
  });
  return env;
}

export interface OpenCodeRunOptions {
  model: FreeModel;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  onUpdate(notification: SessionNotification): void;
  onPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<boolean>;
  timeoutMs?: number;
}

export interface OpenCodeResult {
  sessionId: string;
  modelId: string;
  text: string;
  stopReason: string;
}

/** Only single-action decisions are supported; missing options and failed UI requests deny. */
export async function decidePermission(
  request: RequestPermissionRequest,
  signal: AbortSignal,
  ask: OpenCodeRunOptions["onPermission"],
): Promise<RequestPermissionResponse> {
  const allow = request.options.find(option => option.kind === "allow_once");
  const deny = request.options.find(option => option.kind === "reject_once");
  if (signal.aborted || !allow) return { outcome: { outcome: "cancelled" } };
  let approved = false;
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<false>(resolve => {
      onAbort = () => resolve(false);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) resolve(false);
    });
    approved = await Promise.race([ask(request, signal), cancelled]) === true && !signal.aborted;
  } catch {
    approved = false;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) return { outcome: { outcome: "cancelled" } };
  const option = approved ? allow : deny;
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
}

/** A finite interactive ACP subprocess. Its stdin is a protocol pipe, never inherited. */
export async function runOpenCode(options: OpenCodeRunOptions): Promise<OpenCodeResult> {
  options.signal.throwIfAborted();
  const env = createOpenCodeEnvironment(process.env, options.model);
  const modelId = FREE_MODELS[options.model];
  const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("OpenCode run requires a positive finite deadline.");
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const deadline = setTimeout(() => lifetime.abort(new Error(`OpenCode delegation exceeded ${timeoutMs / 1000}s.`)), timeoutMs);
  const child = spawn("opencode", ["acp", "--pure", "--cwd", options.cwd], {
    cwd: options.cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let sessionId: string | undefined;
  let connection: ClientConnection | undefined;
  let text = "";
  let finishing = false;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
  child.on("error", error => lifetime.abort(new Error(`Cannot start OpenCode: ${error.message}`)));
  child.on("exit", (code, reason) => {
    if (!finishing) lifetime.abort(new Error(`OpenCode exited before completion (${reason ?? code}).${stderr ? `\n${stderr}` : ""}`));
  });
  const killGroup = (sig: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(sig);
      else process.kill(-child.pid, sig);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  let rejectInterrupted!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  const abort = () => rejectInterrupted(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const app = client()
      .onRequest("session/request_permission", ({ params: request }) => {
        if (request.sessionId !== sessionId) return { outcome: { outcome: "cancelled" as const } };
        return decidePermission(request, signal, options.onPermission);
      })
      .onNotification("session/update", ({ params: notification }) => {
        if (notification.sessionId !== sessionId) return;
        const update = notification.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") text += update.content.text;
        try { options.onUpdate(notification); } catch (error) { lifetime.abort(error); }
      });
    connection = app.connect(ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ));
    const requestOptions = { cancellationSignal: signal };
    await Promise.race([connection.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "omp-opencode-free", version: "1" },
      clientCapabilities: {},
    }, requestOptions), interrupted]);
    const session = await Promise.race([connection.agent.request("session/new", { cwd: options.cwd, mcpServers: [] }, requestOptions), interrupted]);
    sessionId = session.sessionId;
    // Do not assume a global/default model: select the exact free model in the native session.
    const modelOption = session.configOptions?.find(option => option.category === "model" || option.id === "model");
    if (!modelOption) throw new Error("OpenCode did not advertise session model selection; refusing an unverified default.");
    const selection = await Promise.race([connection.agent.request("session/set_config_option", { sessionId, configId: modelOption.id, value: modelId }, requestOptions), interrupted]);
    if (!selection.configOptions.some(option => option.id === modelOption.id && option.currentValue === modelId)) {
      throw new Error("OpenCode did not confirm the requested free model; refusing to run.");
    }
    const response = await Promise.race([connection.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: options.prompt }],
    }, requestOptions), interrupted]);
    signal.throwIfAborted();
    if (response.stopReason !== "end_turn") throw new Error(`OpenCode stopped with ${response.stopReason}; task not confirmed complete.`);
    return { sessionId, modelId, text, stopReason: response.stopReason };
  } catch (error) {
    const cause = signal.aborted ? signal.reason : error;
    throw cause instanceof Error ? cause : new Error(String(cause));
  } finally {
    finishing = true;
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
    if (sessionId && connection) {
      // Ask the native agent to abort its tools before stopping the process tree.
      // Closing the SDK connection bounds cleanup even if the agent never responds.
      const cleanupDeadline = setTimeout(() => connection?.close(new Error("OpenCode cleanup deadline.")), 1000);
      try {
        await connection.agent.notify("session/cancel", { sessionId });
        await connection.agent.request("session/close", { sessionId });
      } catch {
        // The process-group stop below is still required after transport failure.
      } finally {
        clearTimeout(cleanupDeadline);
      }
    }
    connection?.close();
    child.stdin.end();
    killGroup("SIGTERM");
    const force = setTimeout(() => killGroup("SIGKILL"), 1000);
    let grace!: NodeJS.Timeout;
    // Kill descendants even when the ACP parent already exited (its group may survive).
    await Promise.race([closed, new Promise<void>(resolve => { grace = setTimeout(resolve, 1100); })]);
    clearTimeout(grace);
    killGroup("SIGKILL");
    clearTimeout(force);
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
