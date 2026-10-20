import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openLedger } from "@actledger/core";
import { denyMessage } from "@actledger/claude-agent-sdk";
import { Ledger, createToolGate, type ToolGateDecision, type ToolGatePending } from "@actledger/sdk";
import { approveInstructions } from "../hint";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const cli = path.join(root, "packages/cli/src/main.ts");
const policy = path.join(root, "examples/claude-agent/policy.yaml");
const dirs: string[] = [];

function run(args: string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  });
}

/** "actledger approve …" → argv for the CLI. Temp dirs have no spaces, which the hint does not quote. */
function argvOf(command: string): string[] {
  const parts = command.trim().split(/\s+/);
  const start = parts.indexOf("actledger");
  expect(start).toBeGreaterThanOrEqual(0);
  return parts.slice(start + 1);
}

function approveFromHint(hint: string): string {
  const match = /Approve: (actledger approve .+?)  Reject: /.exec(hint);
  if (!match?.[1]) throw new Error(hint);
  return match[1];
}

function initDir(policyFile: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-hint-"));
  dirs.push(dir);
  expect(dir).not.toMatch(/\s/);
  const init = run(["init", "--dir", dir, "--policy", policyFile]);
  expect(init.status, init.stderr).toBe(0);
  return dir;
}

function asPending(decision: ToolGateDecision): ToolGatePending {
  if (decision.kind !== "pending") throw new Error(`expected pending, got ${decision.kind}`);
  return decision;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tool = "mcp__ledger__send_note";
const input = { text: "done" };

describe("claude-agent approve hint", () => {
  it("the hint in the adapter's pending message approves the task", async () => {
    const dir = initDir(policy);
    const ledger = new Ledger({ mode: "local", dir });
    let command = "";
    let taskId = "";
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
      const pending = asPending(await gate.before(tool, input));
      taskId = pending.taskId;
      const task = await ledger.getTask(pending.taskId);
      expect(task?.decision.minAssurance).toBe("app_asserted");
      expect(task?.decision.channels).toContain("web");
      const message = denyMessage(tool, pending);
      expect(message).toContain(pending.approveHint);
      command = approveFromHint(message);
      expect(command).toBe(`actledger approve ${pending.taskId} --dir ${ledger.dir}`);
    } finally {
      ledger.close();
    }
    const result = run(argvOf(command));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${taskId} approved`);
    const again = new Ledger({ mode: "local", dir });
    try {
      expect((await again.getTask(taskId))?.state).toBe("approved");
    } finally {
      again.close();
    }
  });

  it("the line run.ts prints approves the task", async () => {
    const dir = initDir(policy);
    const ledger = new Ledger({ mode: "local", dir });
    let printed = "";
    let taskId = "";
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
      const pending = asPending(await gate.before(tool, input));
      taskId = pending.taskId;
      printed = approveInstructions(dir).split(" && ")[1]?.replace("<task id>", pending.taskId) ?? "";
      expect(printed).toMatch(/^pnpm actledger approve /);
    } finally {
      ledger.close();
    }
    const result = run(argvOf(printed));
    expect(result.status, result.stderr).toBe(0);
    const again = new Ledger({ mode: "local", dir });
    try {
      expect((await again.getTask(taskId))?.state).toBe("approved");
    } finally {
      again.close();
    }
  });

  it("a send-level copy gets --assurance and still approves", async () => {
    const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-hint-policy-"));
    dirs.push(copyDir);
    const copy = path.join(copyDir, "policy.yaml");
    fs.writeFileSync(copy, fs.readFileSync(policy, "utf8").replace("level: write", "level: send"));
    const dir = initDir(copy);
    const ledger = new Ledger({ mode: "local", dir });
    let command = "";
    let taskId = "";
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
      const pending = asPending(await gate.before(tool, input));
      taskId = pending.taskId;
      command = approveFromHint(pending.approveHint);
      expect(command.endsWith(" --assurance channel_verified")).toBe(true);
    } finally {
      ledger.close();
    }
    const result = run(argvOf(command));
    expect(result.status, result.stderr).toBe(0);
    const again = new Ledger({ mode: "local", dir });
    try {
      expect((await again.getTask(taskId))?.state).toBe("approved");
    } finally {
      again.close();
    }
    const engine = openLedger({ dir });
    try {
      const receipt = engine.exportReceipts().find((item) => item.transition?.to === "approved");
      const approval = receipt?.body.approval as { assurance?: string; auth?: { simulated?: boolean } } | undefined;
      expect(approval?.assurance).toBe("channel_verified");
      expect(approval?.auth?.simulated).toBe(true);
    } finally {
      engine.close();
    }
    const second = new Ledger({ mode: "local", dir });
    let bare = "";
    try {
      const gate2 = createToolGate({ ledger: second, principal: "u_1", mode: "defer" });
      const pending2 = asPending(await gate2.before(tool, input));
      bare = approveFromHint(pending2.approveHint).replace(/ --assurance channel_verified$/, "");
    } finally {
      second.close();
    }
    const denied = run(argvOf(bare));
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain("assurance_insufficient");
  });
});
