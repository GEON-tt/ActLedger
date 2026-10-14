import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger, createToolGate } from "@actledger/sdk";
import { createOpenAIAgentsLedger, ledgerTool, resolveInterruptions } from "@actledger/openai-agents";

if (!process.env.OPENAI_API_KEY) {
  process.stdout.write(
    "skip: set OPENAI_API_KEY to run this example against a real model. Keyless proof: pnpm exec vitest run packages/openai-agents/test/adapter.test.ts\n",
  );
  process.exit(0);
}

const { Agent, run, setTracingDisabled } = await import("@openai/agents");
const { z } = await import("zod");

setTracingDisabled(true);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const cli = path.join(root, "packages/cli/src/main.ts");
const policy = path.join(root, "examples/openai-agents/policy.yaml");

function cliRun(args: string[]): string {
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-openai-"));
cliRun(["init", "--dir", dir, "--policy", policy]);
process.stdout.write(`ledger: ${dir}\n`);

const ledger = new Ledger({ mode: "local", dir });
const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
const binding = createOpenAIAgentsLedger({ gate, ledger });
const sendEmail = ledgerTool(
  {
    name: "send_email",
    description: "Send an email",
    parameters: z.object({ to: z.string(), body: z.string() }),
    execute: async ({ to }) => `sent to ${to}`,
  },
  binding,
);
const modelName = process.env.OPENAI_DEFAULT_MODEL;
const agent = new Agent({
  name: "mailer",
  instructions: "You send email only by calling send_email. After it returns, say done.",
  ...(modelName ? { model: modelName } : {}),
  tools: [sendEmail],
});

let output = "";
try {
  let result = await run(
    agent,
    "Call the send_email tool now with to bob@example.com and body ready. Do not do anything else first.",
    { maxTurns: 4 },
  );
  const deadline = Date.now() + 5 * 60_000;
  let hinted = false;
  while (result.interruptions.length > 0) {
    const resolved = await resolveInterruptions(result, binding);
    if (resolved.pending.length > 0) {
      if (!hinted) {
        process.stdout.write(`${resolved.pending.map((item) => item.approveHint).join("\n")}\n`);
        hinted = true;
      }
      if (Date.now() >= deadline) {
        process.stdout.write("still pending, giving up\n");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    result = await run(agent, result.state, { maxTurns: 4 });
  }
  output = `${result.finalOutput ?? ""}`;
} finally {
  await binding.abandon();
  ledger.close();
}
process.stdout.write(`${output}\n`);
process.stdout.write(cliRun(["tasks", "--dir", dir]));
