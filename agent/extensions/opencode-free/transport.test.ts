import { describe, expect, test } from "bun:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { createOpenCodeEnvironment, decidePermission, FREE_MODELS } from "./transport.ts";

const request: RequestPermissionRequest = {
  sessionId: "session",
  toolCall: { toolCallId: "write", title: "Write a file" },
  options: [
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "once", name: "Once", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
};

describe("delegated credential and billing boundaries", () => {
  test("does not inherit trading keys, unrelated credentials or caller OpenCode overrides", () => {
    const env = createOpenCodeEnvironment({
      PATH: "/bin", HOME: "/home/user", LANG: "en_US.UTF-8",
      TRADING_PRIVATE_KEY: "must-not-cross", HYPERLIQUID_SECRET: "must-not-cross",
      AWS_SESSION_TOKEN: "must-not-cross", OPENAI_API_KEY: "must-not-cross",
      OPENCODE_API_KEY: "must-not-cross", PI_CONFIG_FILES: "/untrusted",
      OPENCODE_CONFIG_CONTENT: '{"model":"paid/model","permission":"allow"}',
    }, "deepseek");
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "OPENCODE_CONFIG_CONTENT", "PATH"]);
    expect(env.PATH).toBe("/bin");
    const config = z.object({
      permission: z.string(),
      model: z.string(),
      small_model: z.string(),
      agent: z.record(z.string(), z.object({ model: z.string() })),
    }).parse(JSON.parse(env.OPENCODE_CONFIG_CONTENT!));
    expect(config.permission).toBe("ask");
    expect(config.model).toBe(FREE_MODELS.deepseek);
    expect(config.small_model).toBe(FREE_MODELS.deepseek);
    expect(Object.values(config.agent).every(agent => agent.model === FREE_MODELS.deepseek)).toBe(true);
  });

  test("rejects an unknown model instead of using a default or paid endpoint", () => {
    // Deliberately cross the compile-time boundary to exercise runtime rejection.
    const unsupported = "paid" as keyof typeof FREE_MODELS;
    expect(() => createOpenCodeEnvironment({}, unsupported)).toThrow("Choose deepseek or glm");
  });
});

describe("native tool approval boundary", () => {
  test("explicit approval can select only allow-once, never always", async () => {
    const decision = await decidePermission(request, new AbortController().signal, async () => true);
    expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
  });

  test("a denied or failed approval cannot authorize the tool", async () => {
    for (const ask of [async () => false, async (): Promise<boolean> => { throw new Error("UI unavailable"); }]) {
      expect(await decidePermission(request, new AbortController().signal, ask)).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    }
  });

  test("a native request offering only permanent grants fails closed", async () => {
    const permanent = { ...request, options: request.options.filter(option => option.kind === "allow_always") };
    expect(await decidePermission(permanent, new AbortController().signal, async () => true)).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("cancellation wins over an approval arriving after cancellation", async () => {
    const abort = new AbortController();
    let approve!: (value: boolean) => void;
    const decision = decidePermission(request, abort.signal, () => new Promise<boolean>(resolve => { approve = resolve; }));
    abort.abort();
    approve(true);
    expect(await decision).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
