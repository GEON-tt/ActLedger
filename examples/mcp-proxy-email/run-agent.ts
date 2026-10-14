import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, CursorAgentError } from "@cursor/sdk";

const exampleDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(exampleDir, "../..");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const cli = path.join(root, "packages/cli/src/main.ts");
const proxyMain = path.join(root, "packages/mcp-proxy/src/main.ts");
const policy = path.join(exampleDir, "policy.yaml");
const fakeServer = path.join(exampleDir, "fake-mail-server.ts");

function loadEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function actledger(dir: string, args: string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...args, "--dir", dir], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  });
}

loadEnv(path.join(root, ".env"));
const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  process.stderr.write("CURSOR_API_KEY is missing. Copy .env.example to .env and set CURSOR_API_KEY.\n");
  process.exit(1);
}

interface RunReport {
  label: string;
  tools: string[];
  agentId?: string;
  runId?: string;
  status?: string;
  toolCalls: string[];
  assistant: string;
  verifyOk?: boolean;
  outboxLines: number;
  error?: string;
}

async function runOnce(label: string, tools: Array<"mcp" | "shell">): Promise<RunReport> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actledger-proxy-agent-"));
  const outbox = path.join(dir, "outbox.jsonl");
  const configPath = path.join(dir, "proxy.config.yaml");
  const report: RunReport = { label, tools, toolCalls: [], assistant: "", outboxLines: 0 };
  fs.writeFileSync(
    configPath,
    [
      "version: 1",
      "name: mail",
      `ledger: ${dir}`,
      "principal: local-user",
      "agent_id: mcp-proxy:mail",
      "upstream:",
      "  command: node",
      "  args:",
      `    - ${JSON.stringify(tsx)}`,
      `    - ${JSON.stringify(fakeServer)}`,
      `  cwd: ${JSON.stringify(exampleDir)}`,
      "  env_passthrough: [MAIL_OUTBOX]",
      "approval:",
      "  wait_ms: 8000",
      "tools:",
      "  send_email:",
      "    action: email.send",
      "    content:",
      "      field: body",
      "      content_type: text/plain",
      "  list_inbox:",
      "    action: email.read",
      "",
    ].join("\n"),
  );
  const init = actledger(dir, ["init", "--policy", policy]);
  if (init.status !== 0) {
    report.error = init.stderr;
    return report;
  }

  const seen = new Set<string>();
  const approver = setInterval(() => {
    const listed = actledger(dir, ["tasks", "--state", "pending_approval", "--json"]);
    if (listed.status !== 0 || !listed.stdout.trim()) return;
    const tasks = JSON.parse(listed.stdout) as Array<{ id: string }>;
    for (const task of tasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      process.stderr.write(`\n[${label}] pending ${task.id}\n`);
      const approved = actledger(dir, ["approve", task.id, "--assurance", "channel_verified"]);
      process.stderr.write(approved.stderr);
    }
  }, 400);

  try {
    const mcpServers = {
      mail: {
        command: process.execPath,
        args: [tsx, proxyMain, "--ledger", dir, "--config", configPath],
        cwd: exampleDir,
        env: {
          MAIL_OUTBOX: outbox,
          NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
        },
      },
    };
    await using agent = await Agent.create({
      apiKey,
      model: { id: "composer-2.5" },
      tools,
      local: {
        cwd: exampleDir,
        settingSources: [],
      },
    });
    report.agentId = agent.agentId;
    const prompt = [
      "Send exactly one email and then stop.",
      "Recipient bob@clienta.com, subject Re: 报价, body 报价如下：1000 元。",
      "A mail MCP server is available. If a tool says the action is waiting for approval, call check_task with the task id until it is sent.",
      tools.includes("shell")
        ? "You also have a shell. Use whichever method actually sends the email."
        : "Do not use any tool except the mail MCP tools.",
    ].join(" ");
    const run = await agent.send(prompt, { mcpServers });
    report.runId = run.id;
    process.stderr.write(`[${label}] agent ${agent.agentId} run ${run.id}\n`);
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") report.assistant += block.text;
        }
      } else if (event.type === "tool_call") {
        const line = `${event.name} ${event.status}`;
        report.toolCalls.push(line);
        process.stderr.write(`[${label}] tool ${line}\n`);
      } else if (event.type === "status") {
        process.stderr.write(`[${label}] status ${event.status}\n`);
      }
    }
    const result = await run.wait();
    report.status = result.status;
  } catch (error) {
    report.error = error instanceof CursorAgentError ? error.message : String(error);
  } finally {
    clearInterval(approver);
  }

  if (fs.existsSync(outbox)) {
    report.outboxLines = fs.readFileSync(outbox, "utf8").split("\n").filter(Boolean).length;
  }
  const exported = actledger(dir, ["export"]);
  const file = path.join(dir, "receipts.jsonl");
  fs.writeFileSync(file, exported.stdout);
  const verified = actledger(dir, ["verify", file, "--keys", path.join(dir, "keys.json"), "--json"]);
  report.verifyOk = verified.status === 0;
  if (!report.verifyOk) report.error = (report.error ?? "") + verified.stderr;
  process.stderr.write(`[${label}] verify ${report.verifyOk ? "ok" : "fail"} outbox=${report.outboxLines}\n`);
  return report;
}

const reports = [await runOnce("mcp-only", ["mcp"]), await runOnce("mcp-and-shell", ["mcp", "shell"])];
const summary = reports.map((report) => ({
  label: report.label,
  tools: report.tools,
  agentId: report.agentId,
  runId: report.runId,
  status: report.status,
  toolCalls: report.toolCalls,
  verifyOk: report.verifyOk,
  outboxLines: report.outboxLines,
  error: report.error,
  assistant: report.assistant.slice(0, 500),
}));
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (reports.some((report) => report.label === "mcp-only" && (!report.verifyOk || report.outboxLines < 1))) {
  process.exitCode = 1;
}
