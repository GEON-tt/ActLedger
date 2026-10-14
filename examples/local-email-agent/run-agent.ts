import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, CursorAgentError } from "@cursor/sdk";
import { Ledger } from "@actledger/sdk";
import { sendReply } from "./agent";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".agent-run");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const cli = path.join(root, "packages/cli/src/main.ts");
const policy = path.join(path.dirname(fileURLToPath(import.meta.url)), "policy.yaml");

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

function actledger(args: string[]) {
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

fs.rmSync(dir, { recursive: true, force: true });
const init = actledger(["init", "--policy", policy]);
if (init.status !== 0) {
  process.stderr.write(init.stderr);
  process.exit(init.status ?? 1);
}

const ledger = new Ledger({ mode: "local", dir });
const seen = new Set<string>();
const approver = setInterval(() => {
  const listed = actledger(["tasks", "--state", "pending_approval", "--json"]);
  if (listed.status !== 0 || !listed.stdout.trim()) return;
  const tasks = JSON.parse(listed.stdout) as Array<{ id: string; intent: string | null }>;
  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    process.stderr.write(`\npending ${task.id} ${task.intent ?? ""}\n`);
    const approved = actledger(["approve", task.id, "--assurance", "channel_verified"]);
    process.stderr.write(approved.stderr);
    process.stdout.write(approved.stdout);
  }
}, 400);

const prompt = [
  "Send one email and then stop.",
  "Call the send_email tool exactly once with:",
  "to=bob@clienta.com, subject=Re: 报价, body=报价如下：1000 元。",
  "The tool waits until the email is approved. When it returns, report the receipt id.",
  "Do not use any other tool.",
].join(" ");

try {
  await using agent = await Agent.create({
    apiKey,
    model: { id: "composer-2.5" },
    tools: ["mcp"],
    local: {
      cwd: root,
      settingSources: [],
      customTools: {
        send_email: {
          description: "Send an email for the user. Blocks until they approve it in the ledger, then returns a receipt.",
          inputSchema: {
            type: "object",
            properties: {
              to: { type: "string", description: "Recipient email address" },
              subject: { type: "string" },
              body: { type: "string" },
            },
            required: ["to", "subject", "body"],
          },
          async execute(args) {
            const to = String(args.to ?? "");
            const subject = String(args.subject ?? "");
            const body = String(args.body ?? "");
            const result = await sendReply(
              ledger,
              {
                userId: "u_1",
                messageId: `agent-${Date.now()}`,
                to: [to],
                subject,
                body,
              },
              { timeoutMs: 120_000 },
            );
            return JSON.stringify(result);
          },
        },
      },
    },
  });

  const run = await agent.send(prompt);
  process.stderr.write(`agent ${agent.agentId} run ${run.id}\n`);
  for await (const event of run.stream()) {
    if (event.type === "assistant") {
      for (const block of event.message.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
    } else if (event.type === "tool_call") {
      process.stderr.write(`\ntool ${event.name} ${event.status}\n`);
    } else if (event.type === "status") {
      process.stderr.write(`status ${event.status}\n`);
    }
  }
  const result = await run.wait();
  process.stdout.write("\n");
  process.stderr.write(`run status ${result.status}\n`);
  if (result.status === "error") process.exitCode = 2;
} catch (error) {
  if (error instanceof CursorAgentError) {
    process.stderr.write(`startup failed: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  clearInterval(approver);
  ledger.close();
}

const exported = actledger(["export"]);
const file = path.join(dir, "receipts.jsonl");
fs.writeFileSync(file, exported.stdout);
const verified = actledger(["verify", file, "--keys", path.join(dir, "keys.json"), "--json"]);
process.stdout.write(verified.stdout);
if (verified.status !== 0) {
  process.stderr.write(verified.stderr);
  process.exitCode = verified.status ?? 1;
}
