import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeAgentAdapter } from "@actledger/claude-agent-sdk";
import { Ledger, createToolGate } from "@actledger/sdk";

if (!process.env.ANTHROPIC_API_KEY) {
  process.stdout.write(
    "skip: set ANTHROPIC_API_KEY to run this example against a real model. Keyless proof: pnpm exec vitest run packages/claude-agent-sdk/test/adapter.test.ts\n",
  );
  process.exit(0);
}

const { createSdkMcpServer, query, tool } = await import("@anthropic-ai/claude-agent-sdk");
const { z } = await import("zod");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const cli = path.join(root, "packages/cli/src/main.ts");
const policy = path.join(root, "examples/claude-agent/policy.yaml");

function run(args: string[]): string {
  const result = spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-claude-"));
run(["init", "--dir", dir, "--policy", policy]);
process.stdout.write(`ledger: ${dir}\n`);
process.stdout.write(
  `approve from another terminal: pnpm actledger tasks --dir ${dir} --state pending_approval && pnpm actledger approve <task id> --dir ${dir}\n`,
);

const ledger = new Ledger({ mode: "local", dir });
const gate = createToolGate({ ledger, principal: "u_1", mode: "wait", timeoutMs: 5 * 60_000 });
const adapter = createClaudeAgentAdapter({ gate });
const echo = tool("echo", "Echo text", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text" as const, text }],
}));
const sendNote = tool("send_note", "Send a note", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text" as const, text }],
}));
const server = createSdkMcpServer({ name: "ledger", tools: [echo, sendNote] });

try {
  for await (const message of query({
    prompt: "Call mcp__ledger__echo with text 'hi', then call mcp__ledger__send_note with text 'done', then stop.",
    options: adapter.options({
      maxTurns: 4,
      permissionMode: "default",
      mcpServers: { ledger: server },
    }),
  })) {
    if (message.type === "result") {
      const text = message.subtype === "success" ? message.result : message.subtype;
      process.stdout.write(`${message.subtype}: ${text}\n`);
    }
  }
} finally {
  await adapter.abandon();
  ledger.close();
}

process.stdout.write(run(["tasks", "--dir", dir]));
