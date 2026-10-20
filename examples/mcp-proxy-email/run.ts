import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exampleDir = path.join(root, "examples/mcp-proxy-email");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const cli = path.join(root, "packages/cli/src/main.ts");
const proxyMain = path.join(root, "packages/mcp-proxy/src/main.ts");
const policy = path.join(exampleDir, "policy.yaml");
const config = path.join(exampleDir, "proxy.config.yaml");

function run(args: string[]): void {
  const result = spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...getDefaultEnvironment(), NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-mail-"));
const outbox = path.join(dir, "outbox.jsonl");
run(["init", "--dir", dir, "--policy", policy]);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [tsx, proxyMain, "--ledger", dir, "--config", config],
  cwd: root,
  stderr: "inherit",
  env: {
    ...getDefaultEnvironment(),
    MAIL_OUTBOX: outbox,
    NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
  },
});
const client = new Client({ name: "mail-demo", version: "0.0.0" });
await client.connect(transport);

const listed = await client.listTools();
process.stdout.write(`tools: ${listed.tools.map((tool) => tool.name).join(", ")}\n`);

function textOf(result: CallToolResult): string {
  return result.content
    .map((block) => (block.type === "text" && "text" in block ? block.text : ""))
    .join("\n");
}

const pending = (await client.callTool({
  name: "send_email",
  arguments: { to: "bob@clienta.com", subject: "Re: 报价", body: "Bob 你好" },
})) as CallToolResult;
const text = textOf(pending);
process.stdout.write(`${text}\n`);
const taskId = text.match(/tsk_[0-9A-HJKMNP-TV-Z]+/)?.[0];
if (!taskId) {
  process.stderr.write("no task id in proxy response\n");
  await client.close();
  process.exit(1);
}
process.stdout.write(
  `approve from another terminal: pnpm actledger approve ${taskId} --dir ${dir} --assurance channel_verified\n`,
);

for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const checked = (await client.callTool({ name: "check_task", arguments: { task_id: taskId } })) as CallToolResult;
  const body = textOf(checked);
  if (checked.isError) {
    process.stderr.write(`${body}\n`);
    await client.close();
    process.exit(1);
  }
  if (body.includes("sent ") || checked._meta?.["actledger/state"] === "executed") {
    process.stdout.write(`${body}\n`);
    process.stdout.write(fs.existsSync(outbox) ? fs.readFileSync(outbox, "utf8") : "");
    break;
  }
  process.stderr.write(`${body}\n`);
}

await client.close();
