import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const exampleDir = path.join(root, "examples/mcp-proxy-email");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const cli = path.join(root, "packages/cli/src/main.ts");
const proxyMain = path.join(root, "packages/mcp-proxy/src/main.ts");
const policy = path.join(exampleDir, "policy.yaml");
const config = path.join(exampleDir, "proxy.config.yaml");
const dirs: string[] = [];

function run(args: string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...getDefaultEnvironment(), NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  });
}

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" && "text" in block ? block.text : "")).join("\n");
}

function taskIdOf(result: CallToolResult): string {
  const id = textOf(result).match(/tsk_[0-9A-HJKMNP-TV-Z]+/)?.[0];
  if (!id) throw new Error(textOf(result));
  return id;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("mcp proxy email", () => {
  it("approves through the CLI and executes the approved payload", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-mcp-mail-"));
    dirs.push(dir);
    const outbox = path.join(dir, "outbox.jsonl");
    const init = run(["init", "--dir", dir, "--policy", policy]);
    expect(init.status, init.stderr).toBe(0);

    let stderr = "";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsx, proxyMain, "--ledger", dir, "--config", config, "--approval-wait", "300"],
      cwd: root,
      stderr: "pipe",
      env: {
        ...getDefaultEnvironment(),
        MAIL_OUTBOX: outbox,
        NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
      },
    });
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    const client = new Client({ name: "mcp-proxy-email-e2e", version: "0.0.0" });
    const pid = () => transport.pid;
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["send_email", "check_task"]));

      const firstArgs = { to: "bob@clienta.com", subject: "Re: 报价", body: "Bob 你好" };
      const pending = (await client.callTool({ name: "send_email", arguments: firstArgs })) as CallToolResult;
      expect(textOf(pending)).toMatch(/tsk_\w+/);
      expect(fs.existsSync(outbox) ? fs.readFileSync(outbox, "utf8").trim() : "").toBe("");
      const firstId = taskIdOf(pending);
      const listedTasks = run(["tasks", "--dir", dir, "--state", "pending_approval", "--json"]);
      expect(listedTasks.status, listedTasks.stderr).toBe(0);
      expect(listedTasks.stdout).toContain(firstId);

      const approved = run(["approve", firstId, "--dir", dir, "--assurance", "channel_verified"]);
      expect(approved.status, approved.stderr).toBe(0);
      const done = (await client.callTool({ name: "check_task", arguments: { task_id: firstId } })) as CallToolResult;
      expect(textOf(done)).toContain("sent");
      const lines = fs.readFileSync(outbox, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject(firstArgs);

      const secondArgs = { to: "ada@example.com", subject: "下一封", body: "第二封正文" };
      const second = (await client.callTool({ name: "send_email", arguments: secondArgs })) as CallToolResult;
      const secondId = taskIdOf(second);
      const approvedAgain = run(["approve", secondId, "--dir", dir, "--assurance", "channel_verified"]);
      expect(approvedAgain.status, approvedAgain.stderr).toBe(0);
      const repeated = (await client.callTool({ name: "send_email", arguments: secondArgs })) as CallToolResult;
      expect(textOf(repeated)).toContain("sent");
      const after = fs.readFileSync(outbox, "utf8").trim().split("\n");
      expect(after).toHaveLength(2);
      expect(JSON.parse(after[1] ?? "{}")).toMatchObject(secondArgs);

      const exported = run(["export", "--dir", dir]);
      expect(exported.status, exported.stderr).toBe(0);
      expect(exported.stdout).toContain("coverage.declared");
      expect(exported.stdout).toContain('"mode":"enforced"');
      const file = path.join(dir, "receipts.jsonl");
      fs.writeFileSync(file, exported.stdout);
      const verified = run(["verify", file, "--keys", path.join(dir, "keys.json")]);
      expect(verified.status, `${verified.stderr}\n${stderr}`).toBe(0);
    } finally {
      const child = pid();
      await client.close().catch(() => undefined);
      if (child) {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          try {
            process.kill(child, 0);
            await new Promise((resolve) => setTimeout(resolve, 50));
          } catch {
            break;
          }
        }
        try {
          process.kill(child, 0);
          throw new Error(`proxy process ${child} is still running\n${stderr}`);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("proxy process")) throw error;
        }
      }
    }
  }, 40_000);
});
