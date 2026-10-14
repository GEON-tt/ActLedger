#!/usr/bin/env node
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const exitAfterList = process.argv.includes("--exit-after-list");
const exitOnCall = process.argv.includes("--exit-on-call");

function logCall(tool: string, args: Record<string, unknown>): void {
  const file = process.env.FAKE_UPSTREAM_LOG;
  if (!file) return;
  fs.appendFileSync(file, `${JSON.stringify({ tool, args })}\n`);
}

const echo: Tool = {
  name: "echo",
  description: "Echo text",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  outputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

const tools: Tool[] = [
  echo,
  {
    name: "send_email",
    description: "Send an email",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "delete_all",
    description: "Delete everything",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "boom",
    description: "Fail as a tool error",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rpc_fail",
    description: "Fail as an RPC error",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "slow",
    description: "Sleep before returning",
    inputSchema: {
      type: "object",
      properties: { ms: { type: "number" } },
    },
  },
  {
    name: "schema_miss",
    description: "Declares an output schema but returns plain text",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

function text(value: string, extra: Partial<CallToolResult> = {}): CallToolResult {
  return { content: [{ type: "text", text: value }], ...extra };
}

const server = new Server({ name: "fake-upstream", version: "0.0.0" }, { capabilities: { tools: { listChanged: true } } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (exitAfterList) setTimeout(() => process.exit(0), 30);
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  if (exitOnCall) {
    logCall(name, args);
    process.exit(0);
  }
  if (name === "echo") {
    const value = typeof args.text === "string" ? args.text : "";
    logCall(name, args);
    return text(value, { isError: false, structuredContent: { text: value } });
  }
  if (name === "send_email") {
    logCall(name, args);
    const id = `m_${Date.now().toString(36)}`;
    return {
      content: [{ type: "text" as const, text: `sent ${id}` }],
      structuredContent: { _proofs: [{ type: "email_msgid", value: id }] },
      isError: false,
    };
  }
  if (name === "delete_all") {
    logCall(name, args);
    return text("deleted");
  }
  if (name === "boom") {
    logCall(name, args);
    return text("boom failed", { isError: true });
  }
  if (name === "rpc_fail") {
    logCall(name, args);
    throw new McpError(ErrorCode.InternalError, "bad");
  }
  if (name === "slow") {
    logCall(name, args);
    const ms = typeof args.ms === "number" ? args.ms : 0;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return text("done");
  }
  if (name === "schema_miss") {
    logCall(name, args);
    return text("ran");
  }
  throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${name}`);
});

await server.connect(new StdioServerTransport());
