import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { initLocalDir } from "@actledger/core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const cli = path.join(root, "packages/cli/src/main.ts");
const dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

function run(args: string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  });
}

interface RpcSession {
  request(id: number, method: string, params: unknown): Promise<Record<string, unknown>>;
  send(text: string): void;
  nextLine(): Promise<string>;
  closeStdin(): void;
  child: ChildProcessWithoutNullStreams;
}

function startRpc(dir: string): RpcSession {
  const child = spawn(process.execPath, [tsx, cli, "rpc", "--dir", dir], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let index = buf.indexOf("\n");
    while (index >= 0) {
      const line = buf.slice(0, index);
      buf = buf.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
      index = buf.indexOf("\n");
    }
  });
  function nextLine(): Promise<string> {
    const queued = lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for rpc output")), 15_000);
      waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }
  return {
    child,
    nextLine,
    send(text: string) {
      child.stdin.write(text);
    },
    async request(id, method, params) {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return JSON.parse(await nextLine()) as Record<string, unknown>;
    },
    closeStdin() {
      child.stdin.end();
    },
  };
}

function exitCode(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("rpc", () => {
  it("speaks hello, request, approve, and claim", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-rpc-"));
    dirs.push(dir);
    initLocalDir(dir);
    const rpc = startRpc(dir);
    const hello = await rpc.request(1, "hello", {});
    expect(hello.ok).toBe(true);
    expect((hello.result as { protocol?: string }).protocol).toBe("actledger.rpc/1");

    const created = await rpc.request(2, "request", {
      principalId: "u_1",
      action: { type: "email.send" },
      payload: { action: "email.send", args: { to: ["a@b.c"] } },
      intent: "send",
    });
    expect(created.ok).toBe(true);
    const task = (created.result as { task: { id: string; state: string } }).task;
    expect(task.state).toBe("pending_approval");
    const fetched = await rpc.request(3, "get_task", { id: task.id });
    expect((fetched.result as { task: { id: string } }).task.id).toBe(task.id);

    const approved = run(["approve", task.id, "--dir", dir, "--assurance", "channel_verified"]);
    expect(approved.status, approved.stderr).toBe(0);
    const after = await rpc.request(4, "get_task", { id: task.id });
    expect((after.result as { task: { state: string } }).task.state).toBe("approved");
    const claim = await rpc.request(5, "claim", { id: task.id, idempotencyKey: "claim-1" });
    expect(claim.ok).toBe(true);
    const again = await rpc.request(6, "claim", { id: task.id, idempotencyKey: "claim-2" });
    expect(again.ok).toBe(false);
    expect((again.error as { code?: string }).code).toBe("already_claimed");
  });

  it("keeps serving after invalid json and rejects unknown methods", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-rpc-"));
    dirs.push(dir);
    initLocalDir(dir);
    const rpc = startRpc(dir);
    const pending = rpc.nextLine();
    rpc.send("not-json\n");
    const bad = JSON.parse(await pending) as { id: unknown; ok: boolean; error?: { code?: string } };
    expect(bad.id).toBeNull();
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("invalid_request");
    const hello = await rpc.request(2, "hello", {});
    expect(hello.ok).toBe(true);
    const missing = await rpc.request(3, "nope", {});
    expect(missing.ok).toBe(false);
    expect((missing.error as { code?: string }).code).toBe("method_not_found");
    expect((missing.error as { status?: number }).status).toBe(404);
  });

  it("reports not_found and exits 1 when the directory is not initialized", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-rpc-"));
    dirs.push(dir);
    const rpc = startRpc(dir);
    const message = JSON.parse(await rpc.nextLine()) as { id: unknown; ok: boolean; error?: { code?: string } };
    expect(message.id).toBeNull();
    expect(message.ok).toBe(false);
    expect(message.error?.code).toBe("not_found");
    expect(await exitCode(rpc.child)).toBe(1);
  });

  it("exits 0 when stdin closes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-rpc-"));
    dirs.push(dir);
    initLocalDir(dir);
    const rpc = startRpc(dir);
    const hello = await rpc.request(1, "hello", {});
    expect(hello.ok).toBe(true);
    rpc.closeStdin();
    expect(await exitCode(rpc.child)).toBe(0);
  });
});
