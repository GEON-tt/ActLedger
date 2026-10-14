import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openLedger, verifyReceiptChain, type Payload, type Receipt } from "@actledger/core";
import { initLocal } from "@actledger/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadProxyConfig, resolveConfig } from "../src/config";
import type { CliArgs } from "../src/args";
import { createProxy } from "../src/proxy";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureDir = path.join(root, "packages/mcp-proxy/test/fixtures");
const policyYaml = fs.readFileSync(path.join(fixtureDir, "policy.yaml"), "utf8");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const fakeUpstream = path.join(fixtureDir, "fake-upstream.ts");

export function setupLedger(policy = policyYaml): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-proxy-"));
  initLocal(dir, policy);
  return dir;
}

export function approve(dir: string, id: string, edited?: Payload): void {
  const engine = openLedger({ dir });
  try {
    const task = engine.getTask(id);
    if (!task) throw new Error(`task ${id} not found`);
    engine.approve(id, {
      approverPrincipalId: task.principalId,
      channel: "cli",
      assurance: "app_asserted",
      presentedHash: task.payloadHash,
      editedPayload: edited ?? null,
      simulated: false,
    });
  } finally {
    engine.close();
  }
}

export function reject(dir: string, id: string): void {
  const engine = openLedger({ dir });
  try {
    const task = engine.getTask(id);
    if (!task) throw new Error(`task ${id} not found`);
    engine.reject(id, {
      approverPrincipalId: task.principalId,
      channel: "cli",
      assurance: "app_asserted",
      presentedHash: task.payloadHash,
      note: "no",
      simulated: false,
    });
  } finally {
    engine.close();
  }
}

export function readLog(logFile: string): Array<{ tool: string; args: Record<string, unknown> }> {
  if (!fs.existsSync(logFile)) return [];
  const text = fs.readFileSync(logFile, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line) as { tool: string; args: Record<string, unknown> });
}

export function exportAndVerify(dir: string): { receipts: Receipt[]; ok: boolean; reason?: string } {
  const engine = openLedger({ dir });
  try {
    const receipts = engine.exportReceipts();
    const report = verifyReceiptChain(receipts, engine.publicKeys(), { secrets: engine.exportSecrets() });
    return { receipts, ok: report.ok, reason: report.failure?.reason };
  } finally {
    engine.close();
  }
}

export async function startProxy(
  dir: string,
  overrides?: { upstreamArgs?: string[]; approvalWait?: number },
): Promise<{
  client: Client;
  dir: string;
  logFile: string;
  close: () => Promise<void>;
}> {
  const logFile = path.join(dir, "upstream.log");
  const previous = process.env.FAKE_UPSTREAM_LOG;
  process.env.FAKE_UPSTREAM_LOG = logFile;
  const restoreEnv = () => {
    if (previous === undefined) delete process.env.FAKE_UPSTREAM_LOG;
    else process.env.FAKE_UPSTREAM_LOG = previous;
  };
  const file = loadProxyConfig(path.join(fixtureDir, "proxy.config.yaml"));
  const cli: CliArgs = {
    help: false,
    ledger: dir,
    command: [process.execPath, tsx, fakeUpstream, ...(overrides?.upstreamArgs ?? [])],
    ...(overrides?.approvalWait !== undefined ? { approvalWait: overrides.approvalWait } : {}),
  };
  let proxy: Awaited<ReturnType<typeof createProxy>>;
  try {
    proxy = await createProxy({ config: resolveConfig(cli, file) });
  } catch (error) {
    restoreEnv();
    throw error;
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "proxy-test", version: "0.0.0" });
  await Promise.all([proxy.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    dir,
    logFile,
    async close() {
      restoreEnv();
      await client.close().catch(() => undefined);
      await proxy.close();
    },
  };
}

export function taskOf(dir: string, id: string) {
  const engine = openLedger({ dir });
  try {
    return engine.getTask(id);
  } finally {
    engine.close();
  }
}

export function listTaskIds(dir: string): string[] {
  const engine = openLedger({ dir });
  try {
    return engine.listTasks().map((task) => task.id);
  } finally {
    engine.close();
  }
}

export function payloadOf(dir: string, id: string): Payload {
  const engine = openLedger({ dir });
  try {
    return engine.taskPayload(id);
  } finally {
    engine.close();
  }
}

export function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content ?? [])
    .map((block) => (block.type === "text" ? block.text ?? "" : ""))
    .join("\n");
}

export function asCallResult(result: unknown): CallToolResult {
  return result as CallToolResult;
}

export function runMain(args: string[]): { status: number | null; stderr: string; stdout: string } {
  const main = path.join(root, "packages/mcp-proxy/src/main.ts");
  const result = spawnSync(process.execPath, [tsx, main, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  });
  return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}
