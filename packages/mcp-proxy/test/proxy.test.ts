import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openLedger } from "@actledger/core";
import { Ledger } from "@actledger/sdk";
import { createProxy } from "../src/proxy";
import { loadProxyConfig, resolveConfig } from "../src/config";
import {
  approve,
  asCallResult,
  exportAndVerify,
  listTaskIds,
  payloadOf,
  readLog,
  reject,
  runMain,
  setupLedger,
  startProxy,
  taskOf,
  textOf,
} from "./helpers";

const sessions: Array<{ close: () => Promise<void>; dir: string }> = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close().catch(() => undefined);
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

async function boot(upstreamArgs?: string[]) {
  const dir = setupLedger();
  const started = await startProxy(dir, upstreamArgs ? { upstreamArgs } : undefined);
  sessions.push({ close: started.close, dir });
  return started;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mcp proxy", () => {
  it("allows a mapped tool and records the execution", async () => {
    const { client, dir, logFile } = await boot();
    const result = asCallResult(await client.callTool({ name: "echo", arguments: { text: "hi" } }));
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe("hi");
    expect(result._meta?.["actledger/state"]).toBe("executed");
    const id = String(result._meta?.["actledger/task_id"]);
    expect(taskOf(dir, id)?.state).toBe("executed");
    expect(readLog(logFile)).toEqual([{ tool: "echo", args: { text: "hi" } }]);
    const verified = exportAndVerify(dir);
    expect(verified.ok, verified.reason).toBe(true);
    expect(verified.receipts.some((receipt) => receipt.body.kind === "coverage.declared")).toBe(true);
  });

  it("returns a pending task and completes it through check_task", async () => {
    const { client, dir, logFile } = await boot();
    const args = { to: "a@b.c", subject: "hi", body: "hello body" };
    const started = Date.now();
    const pending = asCallResult(await client.callTool({ name: "send_email", arguments: args }));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(pending.isError).toBe(false);
    expect(textOf(pending)).toMatch(/已提交审批 tsk_\w+，批准后用 check_task 查询/);
    const id = String(pending._meta?.["actledger/task_id"]);
    expect(taskOf(dir, id)?.state).toBe("pending_approval");
    expect(readLog(logFile)).toHaveLength(0);

    approve(dir, id);
    const done = asCallResult(await client.callTool({ name: "check_task", arguments: { task_id: id } }));
    expect(done.isError).not.toBe(true);
    expect(textOf(done)).toMatch(/sent /);
    expect(taskOf(dir, id)?.state).toBe("executed");
    const log = readLog(logFile);
    expect(log).toHaveLength(1);
    expect(log[0]?.args.body).toBe("hello body");
    const verified = exportAndVerify(dir);
    expect(verified.ok, verified.reason).toBe(true);
  });

  it("reuses the pending task when the same arguments are called again", async () => {
    const { client, dir } = await boot();
    const args = { to: "a@b.c", subject: "same", body: "body" };
    const pending = asCallResult(await client.callTool({ name: "send_email", arguments: args }));
    const id = String(pending._meta?.["actledger/task_id"]);
    approve(dir, id);
    const done = asCallResult(await client.callTool({ name: "send_email", arguments: args }));
    expect(textOf(done)).toMatch(/sent /);
    expect(taskOf(dir, id)?.state).toBe("executed");
    expect(listTaskIds(dir)).toEqual([id]);
  });

  it("executes the payload edited at approval time", async () => {
    const { client, dir, logFile } = await boot();
    const args = { to: "a@b.c", subject: "edit", body: "original" };
    const pending = asCallResult(await client.callTool({ name: "send_email", arguments: args }));
    const id = String(pending._meta?.["actledger/task_id"]);
    const current = payloadOf(dir, id);
    approve(dir, id, {
      ...current,
      content: { content_type: "text/plain", text: "changed" },
    });
    await client.callTool({ name: "check_task", arguments: { task_id: id } });
    expect(readLog(logFile)[0]?.args.body).toBe("changed");
  });

  it("reports a human rejection without calling upstream", async () => {
    const { client, dir, logFile } = await boot();
    const pending = asCallResult(
      await client.callTool({ name: "send_email", arguments: { to: "a@b.c", subject: "no", body: "x" } }),
    );
    const id = String(pending._meta?.["actledger/task_id"]);
    reject(dir, id);
    const result = asCallResult(await client.callTool({ name: "check_task", arguments: { task_id: id } }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("审批被拒绝");
    expect(readLog(logFile)).toHaveLength(0);
  });

  it("rejects a tool the policy denies", async () => {
    const { client, dir, logFile } = await boot();
    const result = asCallResult(await client.callTool({ name: "delete_all", arguments: {} }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("策略禁止");
    const id = String(result._meta?.["actledger/task_id"]);
    expect(taskOf(dir, id)?.state).toBe("rejected");
    expect(readLog(logFile)).toHaveLength(0);
  });

  it("fails the task when the upstream tool returns an error", async () => {
    const { client, dir } = await boot();
    const result = asCallResult(await client.callTool({ name: "boom", arguments: {} }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("boom failed");
    const id = String(result._meta?.["actledger/task_id"]);
    const task = taskOf(dir, id);
    expect(task?.state).toBe("failed");
    expect(task?.error?.code).toBe("upstream_tool_error");
  });

  it("fails the task when the upstream call is an RPC error", async () => {
    const { client, dir } = await boot();
    const result = asCallResult(await client.callTool({ name: "rpc_fail", arguments: {} }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("bad");
    const id = String(result._meta?.["actledger/task_id"]);
    const task = taskOf(dir, id);
    expect(task?.state).toBe("failed");
    expect(task?.error?.code).toBe("upstream_rpc_error");
  });

  it("marks an execution timeout as unknown and ignores the late result", async () => {
    const { client, dir } = await boot();
    const started = Date.now();
    const result = asCallResult(await client.callTool({ name: "slow", arguments: { ms: 3000 } }));
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("结果未知");
    const id = String(result._meta?.["actledger/task_id"]);
    await sleep(1_200);
    expect(taskOf(dir, id)?.state).toBe("unknown");
    await sleep(2_000);
    expect(taskOf(dir, id)?.state).toBe("unknown");
  }, 20_000);

  it("treats an upstream disconnect as unknown and refuses new calls", async () => {
    const { client, dir } = await boot(["--exit-on-call"]);
    const first = asCallResult(await client.callTool({ name: "echo", arguments: { text: "hi" } }));
    expect(first.isError).toBe(true);
    expect(textOf(first)).toContain("上游连接中断");
    const before = listTaskIds(dir);
    expect(before).toHaveLength(1);
    const second = asCallResult(await client.callTool({ name: "echo", arguments: { text: "again" } }));
    expect(second.isError).toBe(true);
    expect(textOf(second)).toBe("上游 MCP 服务器不可用，未提交动作。");
    expect(listTaskIds(dir)).toEqual(before);
  });

  it("declares enforced coverage without rewriting policy.yaml", async () => {
    const dir = setupLedger();
    const policyFile = path.join(dir, "policy.yaml");
    const before = createHash("sha256").update(fs.readFileSync(policyFile)).digest("hex");
    const versionBefore = openLedger({ dir });
    const publishedBefore = versionBefore.policyInfo().version;
    versionBefore.close();
    const started = await startProxy(dir);
    sessions.push({ close: started.close, dir });
    expect(createHash("sha256").update(fs.readFileSync(policyFile)).digest("hex")).toBe(before);

    const pending = asCallResult(
      await started.client.callTool({
        name: "send_email",
        arguments: { to: "a@b.c", subject: "cov", body: "x" },
      }),
    );
    const id = String(pending._meta?.["actledger/task_id"]);
    const verified = exportAndVerify(dir);
    expect(verified.ok, verified.reason).toBe(true);
    const declared = verified.receipts.find((receipt) => receipt.body.kind === "coverage.declared");
    expect(declared?.body.entries).toEqual(
      expect.arrayContaining([{ action: "email.send", mode: "enforced", via: "mcp-proxy" }]),
    );
    const prepared = verified.receipts.find(
      (receipt) => receipt.task_id === id && receipt.transition?.to === "prepared",
    );
    expect(prepared?.body.integration).toMatchObject({ mode: "enforced", via: "mcp-proxy" });

    const other = openLedger({ dir });
    try {
      expect(other.policyInfo().version).toBe(publishedBefore);
      expect(other.exportReceipts().filter((receipt) => receipt.body.kind === "policy.published")).toHaveLength(1);
    } finally {
      other.close();
    }
  });

  it("lists upstream tools without outputSchema plus check_task", async () => {
    const { client } = await boot();
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["echo", "send_email", "delete_all", "boom", "rpc_fail", "slow", "check_task"]));
    expect(listed.tools.find((tool) => tool.name === "echo")?.outputSchema).toBeUndefined();
    expect(listed.tools.find((tool) => tool.name === "check_task")?.inputSchema).toMatchObject({
      required: ["task_id"],
    });
  });

  it("refuses check_task for a task owned by another proxy", async () => {
    const { client, dir, logFile } = await boot();
    const ledger = new Ledger({ mode: "local", dir });
    const foreign = await ledger.request({
      principalId: "local-user",
      agentId: "other",
      action: { type: "demo.echo", attrs: { mcp_server: "someone-else", mcp_tool: "echo" } },
      payload: { action: "demo.echo", args: { text: "x" } },
      readOnly: false,
    });
    ledger.close();
    const result = asCallResult(await client.callTool({ name: "check_task", arguments: { task_id: foreign.id } }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("不属于此代理");
    expect(readLog(logFile)).toHaveLength(0);
  });

  it("does not mark a local output-schema failure as failed", async () => {
    const { client, dir, logFile } = await boot();
    const result = asCallResult(await client.callTool({ name: "schema_miss", arguments: {} }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("结果未知");
    const id = String(result._meta?.["actledger/task_id"]);
    const task = taskOf(dir, id);
    expect(task?.state).not.toBe("failed");
    expect(task?.state).toBe("executing");
    expect(readLog(logFile)).toEqual([{ tool: "schema_miss", args: {} }]);
  });

  it("does not execute an upstream tool named by a forged mcp_tool", async () => {
    const { client, dir, logFile } = await boot();
    const ledger = new Ledger({ mode: "local", dir });
    const foreign = await ledger.request({
      principalId: "local-user",
      agentId: "mcp-proxy:fixture",
      action: { type: "demo.echo", attrs: { mcp_server: "fixture", mcp_tool: "send_email" } },
      payload: { action: "demo.echo", args: { text: "x" } },
      readOnly: false,
    });
    ledger.close();
    const result = asCallResult(await client.callTool({ name: "check_task", arguments: { task_id: foreign.id } }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("未执行");
    expect(readLog(logFile)).toHaveLength(0);
    expect(taskOf(dir, foreign.id)?.state).toBe("approved");
  });

  it("fails to start when policy.yaml is invalid", async () => {
    const dir = setupLedger();
    sessions.push({
      close: async () => undefined,
      dir,
    });
    fs.writeFileSync(path.join(dir, "policy.yaml"), "version: [broken\n");
    const file = loadProxyConfig(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/proxy.config.yaml"));
    const config = resolveConfig(
      { help: false, ledger: dir, command: [process.execPath, "-e", "process.exit(0)"] },
      file,
    );
    await expect(createProxy({ config })).rejects.toMatchObject({ code: "policy_invalid" });
    const child = runMain(["--ledger", dir, "--upstream", "node -e process.exit(0)"]);
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("policy_invalid");
  });
});
