import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initLocalDir, openLedger } from "@actledger/core";
import { Ledger, createToolGate } from "@actledger/sdk";
import { createClaudeAgentAdapter } from "../src/index";

const key = process.env.ANTHROPIC_API_KEY;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const echoPolicy = `
version: 1
defaults:
  unknown_action: require_approval
  content_mode: strict
  approval:
    channels: [cli]
    timeout: 15m
    allow_edit: true
    min_assurance: app_asserted
actions:
  tool.mcp__ledger__echo: { level: read }
rules:
  - id: echo-allow
    match: { action: tool.mcp__ledger__echo }
    effect: allow
`;

describe.skipIf(!key)("claude agent sdk smoke (real model)", () => {
  it("records an in-process MCP tool call through canUseTool and PostToolUse", async () => {
    const { createSdkMcpServer, query, tool } = await import("@anthropic-ai/claude-agent-sdk");
    const { z } = await import("zod");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-claude-smoke-"));
    dirs.push(dir);
    initLocalDir(dir, { policyYaml: echoPolicy });
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "wait" });
      const adapter = createClaudeAgentAdapter({ gate });
      const echo = tool("echo", "Echo text", { text: z.string() }, async ({ text }) => ({
        content: [{ type: "text" as const, text }],
      }));
      const server = createSdkMcpServer({ name: "ledger", tools: [echo] });
      for await (const _message of query({
        prompt: "Call the mcp__ledger__echo tool with text 'hi', then stop.",
        options: adapter.options({
          mcpServers: { ledger: server },
          maxTurns: 3,
          permissionMode: "default",
        }),
      })) {
        // Drain the stream. The ledger assertion below is the check.
      }
      const engine = openLedger({ dir });
      try {
        const tasks = engine.listTasks();
        expect(tasks.some((task) => task.action.type === "tool.mcp__ledger__echo" && task.state === "executed")).toBe(
          true,
        );
      } finally {
        engine.close();
      }
    } finally {
      ledger.close();
    }
  }, 120_000);
});
