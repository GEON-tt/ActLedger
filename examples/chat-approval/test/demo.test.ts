import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLedger, verifyReceiptChain } from "@actledger/core";
import type { ChatEvent } from "../chat-server.js";
import { startDemo, type DemoHandle } from "../run.js";
import { readNotes } from "../tools.js";
import type { ServeHandle } from "@actledger/cli/serve";

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const NOTE_COMMIT_RE = /^hmac-sha256:[0-9a-f]{64}$/;

let current: { demo: DemoHandle; dataDir: string } | undefined;

afterEach(async () => {
  const running = current;
  current = undefined;
  if (!running) return;
  try {
    await running.demo.close();
  } finally {
    fs.rmSync(running.dataDir, { recursive: true, force: true });
  }
});

function request(
  port: number,
  method: string,
  requestPath: string,
  opts?: { headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path: requestPath, headers: opts?.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.end(opts?.body);
  });
}

function form(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.append(key, value);
  return params.toString();
}

function field(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!match?.[1]) throw new Error(`missing ${name}`);
  return match[1];
}

function cookieValue(headers: http.IncomingHttpHeaders): string {
  const raw = headers["set-cookie"];
  const joined = Array.isArray(raw) ? raw.join("\n") : (raw ?? "");
  const match = /actledger_session=([^;]*)/.exec(joined);
  if (!match) throw new Error(`missing session cookie in ${joined}`);
  return match[1] ?? "";
}

function postMessage(port: number, text: string): Promise<{ status: number; events: ChatEvent[] }> {
  const body = JSON.stringify({ text });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/message",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const events: ChatEvent[] = [];
          if ((res.statusCode ?? 0) === 200) {
            for (const line of raw.split("\n")) {
              if (!line.trim()) continue;
              events.push(JSON.parse(line) as ChatEvent);
            }
          }
          resolve({ status: res.statusCode ?? 0, events });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function waitForPending(chatPort: number, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const res = await request(chatPort, "GET", "/pending");
    const body = JSON.parse(res.body) as {
      tasks: Array<{ id: string; tool: string; createdAt: string; expiresAt: string | null; consoleUrl: string }>;
    };
    const task = body.tasks[0];
    if (task) return task;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for a pending task");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function boot(): Promise<DemoHandle> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-chat-"));
  try {
    const demo = await startDemo({
      dataDir,
      servePort: 0,
      chatPort: 0,
      provider: "fake",
      env: {},
      log: () => {},
      gatePollMs: 250,
    });
    current = { demo, dataDir };
    return demo;
  } catch (error) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}

async function consoleLogin(serve: ServeHandle): Promise<string> {
  const url = new URL(serve.loginUrl);
  const res = await request(serve.port, "GET", `${url.pathname}${url.search}`);
  expect(res.status).toBe(303);
  return `actledger_session=${cookieValue(res.headers)}`;
}

async function decide(
  serve: ServeHandle,
  cookie: string,
  taskId: string,
  action: "approve" | "reject",
  reason?: string,
): Promise<void> {
  const page = await request(serve.port, "GET", `/tasks/${taskId}`, { headers: { cookie } });
  expect(page.status).toBe(200);
  const posted = await request(serve.port, "POST", `/tasks/${taskId}/${action}`, {
    headers: {
      cookie,
      origin: serve.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form({
      csrf: field(page.body, "csrf"),
      presented_hash: field(page.body, "presented_hash"),
      ...(reason ? { reason } : {}),
    }),
  });
  expect(posted.status).toBe(303);
}

describe("chat approval demo", () => {
  it("writes the outbox after an in-process approval and verifies", async () => {
    const demo = await boot();
    const pending = postMessage(demo.chat.port, "帮我发一条笔记：明天下午三点开会");
    pending.catch(() => {});
    const task = await waitForPending(demo.chat.port);
    expect(task.tool).toBe("send_note");
    expect(task.consoleUrl).toBe(`${demo.serve.origin}/tasks/${task.id}`);
    const busy = await postMessage(demo.chat.port, "列出笔记");
    expect(busy.status).toBe(409);

    const cookie = await consoleLogin(demo.serve);
    const started = Date.now();
    await decide(demo.serve, cookie, task.id, "approve");
    const { status, events } = await pending;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(status).toBe(200);
    expect(events.at(-1)).toEqual({ type: "done", status: "finished" });
    for (const event of events) {
      if (event.type === "tool_call" || event.type === "tool_result" || event.type === "approval_pending") {
        expect(["list_notes", "send_note"]).toContain(event.tool);
      }
    }
    expect(JSON.stringify(events)).not.toContain('"mcp"');
    expect(events.some((event) => event.type === "approval_pending" && event.taskId === task.id)).toBe(true);
    const toolResult = events.find((event) => event.type === "tool_result");
    expect(toolResult?.type).toBe("tool_result");
    if (toolResult?.type !== "tool_result") throw new Error("missing tool_result");
    expect(toolResult.ok).toBe(true);
    expect(toolResult.taskId).toBe(task.id);
    expect(toolResult.receiptHash).toMatch(HASH_RE);

    const summary = events.find((event) => event.type === "turn_summary");
    if (summary?.type !== "turn_summary") throw new Error("missing turn_summary");
    expect(summary.tasks[0]).toMatchObject({
      taskId: task.id,
      state: "executed",
      approver: "u_1",
      channel: "web",
      consoleUrl: `${demo.serve.origin}/tasks/${task.id}`,
    });
    expect(summary.tasks[0]?.receiptHash).toMatch(HASH_RE);
    expect(summary.verify.ok).toBe(true);

    const notes = readNotes(demo.outbox);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ text: "明天下午三点开会", taskId: task.id });

    const engine = openLedger({ dir: demo.ledgerDir });
    try {
      const report = verifyReceiptChain(engine.exportReceipts(), engine.publicKeys(), {
        secrets: engine.exportSecrets(),
      });
      expect(report.ok).toBe(true);
    } finally {
      engine.close();
    }
  });

  it("records a rejection reason and does not write the outbox", async () => {
    const demo = await boot();
    const pending = postMessage(demo.chat.port, "帮我发一条笔记：明天下午三点开会");
    pending.catch(() => {});
    const task = await waitForPending(demo.chat.port);
    const cookie = await consoleLogin(demo.serve);
    const reason = "这周不发，下周再说";
    await decide(demo.serve, cookie, task.id, "reject", reason);
    const { events } = await pending;

    const toolResult = events.find((event) => event.type === "tool_result");
    if (toolResult?.type !== "tool_result") throw new Error("missing tool_result");
    expect(toolResult.ok).toBe(false);
    expect(toolResult.reason).toBe("rejected");
    const summary = events.find((event) => event.type === "turn_summary");
    if (summary?.type !== "turn_summary") throw new Error("missing turn_summary");
    expect(summary.tasks[0]).toMatchObject({
      state: "rejected",
      approver: "u_1",
      reasonRecorded: true,
    });
    expect(summary.verify.ok).toBe(true);
    expect(fs.existsSync(demo.outbox)).toBe(false);

    const engine = openLedger({ dir: demo.ledgerDir });
    try {
      expect(engine.getTask(task.id)?.state).toBe("rejected");
      const receipt = engine.listTaskReceipts(task.id).find((item) => item.transition?.to === "rejected");
      expect(receipt?.body.note_commit).toMatch(NOTE_COMMIT_RE);
      expect(JSON.stringify(receipt)).not.toContain(reason);
      const secret = engine.exportSecrets().find((item) => item.kind === "task" && item.task_id === task.id);
      expect(secret && secret.kind === "task" ? secret.notes?.reject : undefined).toBe(reason);
    } finally {
      engine.close();
    }

    const page = await request(demo.serve.port, "GET", `/tasks/${task.id}`, { headers: { cookie } });
    expect(page.body).toContain("reason recorded");
  });

  it("lists notes without creating a pending task", async () => {
    const demo = await boot();
    const { events } = await postMessage(demo.chat.port, "列出笔记");
    const pending = await request(demo.chat.port, "GET", "/pending");
    expect(JSON.parse(pending.body).tasks).toHaveLength(0);
    const engine = openLedger({ dir: demo.ledgerDir });
    try {
      expect(engine.listTasks({ state: "pending_approval" })).toHaveLength(0);
    } finally {
      engine.close();
    }
    expect(events.some((event) => event.type === "approval_pending")).toBe(false);
    const call = events.find((event) => event.type === "tool_call");
    if (call?.type !== "tool_call") throw new Error("missing tool_call");
    expect(call.tool).toBe("list_notes");
    const summary = events.find((event) => event.type === "turn_summary");
    if (summary?.type !== "turn_summary") throw new Error("missing turn_summary");
    expect(summary.tasks[0]).toMatchObject({
      state: "executed",
      approver: "policy:list-notes-allow",
      channel: null,
    });
    expect(fs.existsSync(demo.outbox)).toBe(false);
  });

  it("rejects misdirected and cross-site chat requests", async () => {
    const demo = await boot();
    const evilHost = await request(demo.chat.port, "GET", "/", {
      headers: { host: `evil.example:${demo.chat.port}` },
    });
    expect(evilHost.status).toBe(421);
    expect(evilHost.body).toBe("misdirected request");

    const evilOriginBody = JSON.stringify({ text: "hello" });
    const evilOrigin = await request(demo.chat.port, "POST", "/message", {
      headers: {
        origin: "http://evil.example",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(evilOriginBody)),
      },
      body: evilOriginBody,
    });
    expect(evilOrigin.status).toBe(403);
    expect(evilOrigin.body).toContain("origin_rejected");

    const formPost = await request(demo.chat.port, "POST", "/message", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "text=hi",
    });
    expect(formPost.status).toBe(415);

    const blank = JSON.stringify({ text: "   " });
    const invalid = await request(demo.chat.port, "POST", "/message", {
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(blank)),
      },
      body: blank,
    });
    expect(invalid.status).toBe(400);

    const home = await request(demo.chat.port, "GET", "/");
    expect(home.status).toBe(200);
    expect(String(home.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    expect(home.body).toContain("/message");
    expect(home.body).not.toContain("token=");

    const config = await request(demo.chat.port, "GET", "/config");
    const configBody = JSON.parse(config.body) as { provider: string; serveOrigin: string };
    expect(configBody.serveOrigin).toBe(demo.serve.origin);
    const token = new URL(demo.serve.loginUrl).searchParams.get("token");
    expect(token).toBeTruthy();
    expect(config.body).not.toContain(token ?? "");

    const engine = openLedger({ dir: demo.ledgerDir });
    try {
      expect(engine.listTasks()).toHaveLength(0);
    } finally {
      engine.close();
    }
  });
});
