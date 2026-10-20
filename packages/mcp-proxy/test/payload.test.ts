import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../src/config";
import { fingerprint, mappingFor, payloadToArguments, toolCallToRequest } from "../src/payload";

function config(partial: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    name: "fixture",
    ledger: "/tmp/ledger",
    principal: "local-user",
    agentId: "mcp-proxy:fixture",
    upstream: { command: "node", args: [], cwd: "/tmp", envPassthrough: [] },
    approval: { waitMs: 300 },
    checkTaskTool: "check_task",
    unmapped: "tool_name",
    tools: {
      send_email: {
        action: "email.send",
        content: { field: "body", content_type: "text/plain" },
        attrsFrom: { recipient_domain: "to_domain", count: "n", ok: "flag", skip: "obj" },
        allowedDrift: ["content.text"],
      },
    },
    ...partial,
  };
}

describe("payload", () => {
  it("round-trips tool arguments through content extraction", () => {
    const cfg = config();
    const args = { to: "a@b.c", subject: "s", body: "hello", n: 2 };
    const request = toolCallToRequest(cfg, "send_email", args);
    const mapping = mappingFor(cfg, "send_email");
    expect(mapping).not.toBeNull();
    expect(payloadToArguments(mapping!, request.payload)).toEqual(args);
    expect(request.payload.content).toEqual({ content_type: "text/plain", text: "hello" });
    expect(request.payload.args).not.toHaveProperty("body");
    expect(request.intent).toBe("MCP tool call send_email");
    expect(request.action.attrs).toMatchObject({
      mcp_server: "fixture",
      mcp_tool: "send_email",
      count: 2,
    });
    expect(request.action.attrs).not.toHaveProperty("recipient_domain");
  });

  it("leaves a non-string content field in args and copies only scalar attrs", () => {
    const cfg = config();
    const request = toolCallToRequest(cfg, "send_email", {
      body: { raw: true },
      to_domain: "x.com",
      n: 2,
      flag: false,
      obj: { a: 1 },
    });
    expect(request.payload.content).toBeUndefined();
    expect(request.payload.args.body).toEqual({ raw: true });
    expect(request.action.attrs).toEqual({
      mcp_server: "fixture",
      mcp_tool: "send_email",
      recipient_domain: "x.com",
      count: 2,
      ok: false,
    });
  });

  it("uses the tool name when the tool is unmapped", () => {
    const cfg = config({ tools: {}, unmapped: "tool_name" });
    expect(mappingFor(cfg, "custom")?.action).toBe("custom");
    expect(toolCallToRequest(cfg, "custom", { a: 1 }).action.type).toBe("custom");
    expect(mappingFor(config({ tools: {}, unmapped: "hide" }), "custom")).toBeNull();
  });

  it("fingerprints arguments independent of key order", () => {
    const left = fingerprint("fixture", "echo", { b: 1, a: { z: 2, y: 1 } });
    const right = fingerprint("fixture", "echo", { a: { y: 1, z: 2 }, b: 1 });
    expect(left).toBe(right);
    expect(fingerprint("fixture", "echo", { a: 1 })).not.toBe(fingerprint("fixture", "echo", { a: 2 }));
  });
});
