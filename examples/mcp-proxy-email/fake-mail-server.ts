#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";

const tools: Tool[] = [
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
    name: "list_inbox",
    description: "List the inbox",
    inputSchema: { type: "object", properties: {} },
  },
];

const server = new Server({ name: "fake-mail", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  if (request.params.name === "list_inbox") {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify([{ id: "m_1", from: "ada@example.com", subject: "hello" }]),
        },
      ],
    };
  }
  if (request.params.name !== "send_email") {
    throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${request.params.name}`);
  }
  const outbox = process.env.MAIL_OUTBOX;
  if (!outbox) {
    return { isError: true, content: [{ type: "text" as const, text: "MAIL_OUTBOX is not set" }] };
  }
  const id = randomBytes(4).toString("hex");
  const record = {
    to: args.to ?? null,
    subject: args.subject ?? null,
    body: args.body ?? null,
  };
  fs.appendFileSync(outbox, `${JSON.stringify(record)}\n`);
  return {
    content: [{ type: "text" as const, text: `sent ${id}` }],
    structuredContent: { _proofs: [{ type: "email_msgid", value: id }] },
    isError: false,
  };
});

await server.connect(new StdioServerTransport());
