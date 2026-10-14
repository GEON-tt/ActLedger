import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger } from "@actledger/sdk";
import { sendReply } from "../agent";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const cli = path.join(root, "packages/cli/src/main.ts");
const policy = path.join(root, "examples/local-email-agent/policy.yaml");
const dirs: string[] = [];

function run(args: string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("local email agent", () => {
  it("approves through the CLI and verifies the exported chain", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-e2e-"));
    dirs.push(dir);
    const init = run(["init", "--dir", dir, "--policy", policy]);
    expect(init.status, init.stderr).toBe(0);

    const ledger = new Ledger({ mode: "local", dir });
    const pending = sendReply(ledger, {
      userId: "u_1",
      messageId: "m_1",
      to: ["bob@clienta.com"],
      subject: "Re: 报价",
      body: "Bob 你好",
    });

    let taskId = "";
    for (let i = 0; i < 40 && !taskId; i++) {
      const listed = run(["tasks", "--dir", dir, "--state", "pending_approval", "--json"]);
      expect(listed.status, listed.stderr).toBe(0);
      const tasks = JSON.parse(listed.stdout) as Array<{ id: string }>;
      taskId = tasks[0]?.id ?? "";
      if (!taskId) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(taskId).not.toBe("");

    const approved = run(["approve", taskId, "--dir", dir, "--assurance", "channel_verified"]);
    expect(approved.status, approved.stderr).toBe(0);

    const result = await pending;
    expect(result.status).toBe("sent");
    ledger.close();

    const exported = run(["export", "--dir", dir]);
    expect(exported.status, exported.stderr).toBe(0);
    const file = path.join(dir, "receipts.jsonl");
    fs.writeFileSync(file, exported.stdout);
    const verified = run(["verify", file, "--keys", path.join(dir, "keys.json"), "--json"]);
    expect(verified.status, verified.stderr).toBe(0);
    const report = JSON.parse(verified.stdout) as { ok: boolean; stats: { count: number } };
    expect(report.ok).toBe(true);
    expect(report.stats.count).toBeGreaterThan(2);

    const show = run(["show", JSON.parse(exported.stdout.trim().split("\n").at(-1)!).id, "--dir", dir]);
    expect(show.status, show.stderr).toBe(0);
    expect(show.stdout).toContain("签名: 有效");
  });
});
