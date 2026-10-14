import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initLocalDir, openLedger, type LedgerEngine } from "@actledger/core";
import { verifyWebhook } from "@actledger/sdk/webhook";
import { startServer, type ServeHandle } from "../src/serve/server.js";
import type { HttpPost } from "../src/serve/notifier.js";

const dirs: string[] = [];
const handles: ServeHandle[] = [];
const closers: Array<() => Promise<void>> = [];

const policy = `
version: 1
defaults:
  unknown_action: require_approval
  approval: { channels: [cli, web, webhook_link], timeout: 1h, min_assurance: app_asserted }
actions:
  email.send: { level: write }
  calendar.create: { level: write }
rules:
  - id: calendar-allow
    match: { action: calendar.create }
    effect: allow
`;

const secret = "super-secret-value";

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function withLedger<T>(dir: string, fn: (engine: LedgerEngine) => T): T {
  const engine = openLedger({ dir });
  try {
    return fn(engine);
  } finally {
    engine.close();
  }
}

function createEmail(dir: string, intent = "intent-marker-phrase", text = "visible-body") {
  return withLedger(dir, (engine) =>
    engine.request({
      principalId: "u_1",
      intent,
      action: { type: "email.send" },
      payload: {
        action: "email.send",
        args: { to: ["a@b.c"] },
        content: { content_type: "text/plain", text },
      },
    }),
  );
}

function prepare(channelsYaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-notify-"));
  dirs.push(dir);
  initLocalDir(dir, { policyYaml: policy });
  fs.writeFileSync(path.join(dir, "channels.yaml"), channelsYaml);
  return dir;
}

async function listen(): Promise<{
  port: number;
  requests: Array<{ body: string; headers: http.IncomingHttpHeaders }>;
}> {
  const requests: Array<{ body: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ body: Buffer.concat(chunks).toString("utf8"), headers: req.headers });
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("receiver did not bind");
  closers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: address.port, requests };
}

function logLines(dir: string): Array<Record<string, unknown>> {
  const file = path.join(dir, "notify.log");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("webhook notifier", () => {
  it("signs a pending event that verifyWebhook accepts, without the payload by default", async () => {
    const receiver = await listen();
    const dir = prepare(`channels:
  - name: team-webhook
    type: webhook
    url: http://127.0.0.1:${receiver.port}/hook
    secret_env: ACTLEDGER_WEBHOOK_SECRET
    events: [task.pending_approval, task.approved, task.rejected]
`);
    const handle = await startServer({ dir, port: 0, pollMs: 0, env: { ACTLEDGER_WEBHOOK_SECRET: secret } });
    handles.push(handle);
    const created = createEmail(dir);
    await handle.notifier.tick();
    await handle.notifier.flush();
    expect(receiver.requests).toHaveLength(1);
    const raw = receiver.requests[0]?.body ?? "";
    const header = receiver.requests[0]?.headers["actledger-signature"];
    expect(typeof header).toBe("string");
    const event = verifyWebhook(raw, header as string, secret);
    expect(event.type).toBe("task.pending_approval");
    const data = event.data as {
      task_id?: string;
      payload_hash?: string;
      intent_commit?: string;
      approve_url?: string;
    };
    expect(data.task_id).toBe(created.task.id);
    expect(data.payload_hash).toBe(created.task.payloadHash);
    expect(data.intent_commit).toBeTruthy();
    expect(data.approve_url?.startsWith(`${handle.publicUrl}/t/`)).toBe(true);
    expect("payload" in event.data).toBe(false);
    expect("intent" in event.data).toBe(false);
    expect(raw).not.toContain("visible-body");
    expect(raw).not.toContain("intent-marker-phrase");
    const logFile = path.join(dir, "notify.log");
    expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
    const logText = fs.readFileSync(logFile, "utf8");
    expect(logText).not.toContain(secret);
    expect(logText).not.toContain("sig=");
  });

  it("includes payload and intent only when the channel asks for them", async () => {
    const calls: string[] = [];
    const dir = prepare(`channels:
  - name: team-webhook
    type: webhook
    url: http://127.0.0.1:9/hook
    secret_env: ACTLEDGER_WEBHOOK_SECRET
    include_payload: true
`);
    const handle = await startServer({
      dir,
      port: 0,
      pollMs: 0,
      env: { ACTLEDGER_WEBHOOK_SECRET: secret },
      httpPost: async (_url, init) => {
        calls.push(init.body);
        return { status: 200 };
      },
    });
    handles.push(handle);
    const payload = {
      action: "email.send",
      args: { to: ["a@b.c"] },
      content: { content_type: "text/plain", text: "visible-body" },
    };
    withLedger(dir, (engine) =>
      engine.request({
        principalId: "u_1",
        intent: "intent-marker-phrase",
        action: { type: "email.send" },
        payload,
      }),
    );
    await handle.notifier.tick();
    await handle.notifier.flush();
    const event = JSON.parse(calls[0] ?? "{}") as { data?: { payload?: unknown; intent?: unknown } };
    expect(event.data?.payload).toEqual(payload);
    expect(event.data?.intent).toBe("intent-marker-phrase");
  });

  it("skips a channel with no secret and still delivers the others", async () => {
    const urls: string[] = [];
    const dir = prepare(`channels:
  - name: missing
    type: webhook
    url: http://127.0.0.1:9/missing
    secret_env: ACTLEDGER_MISSING_SECRET
  - name: present
    type: webhook
    url: http://127.0.0.1:9/present
    secret_env: ACTLEDGER_WEBHOOK_SECRET
`);
    const handle = await startServer({
      dir,
      port: 0,
      pollMs: 0,
      env: { ACTLEDGER_WEBHOOK_SECRET: secret },
      httpPost: async (url) => {
        urls.push(url);
        return { status: 200 };
      },
    });
    handles.push(handle);
    const skipped = logLines(dir).find((line) => line.outcome === "skipped");
    expect(skipped?.reason).toBe("missing_secret_env");
    createEmail(dir);
    await handle.notifier.tick();
    await handle.notifier.flush();
    expect(urls).toEqual(["http://127.0.0.1:9/present"]);
    expect(fs.readFileSync(path.join(dir, "notify.log"), "utf8")).not.toContain(secret);
  });

  it("retries 503 and keeps one delivery id", async () => {
    const calls: Array<{ id?: string; signature?: string; body: string }> = [];
    let attempt = 0;
    const httpPost: HttpPost = async (_url, init) => {
      attempt += 1;
      calls.push({
        id: init.headers["ActLedger-Delivery"],
        signature: init.headers["ActLedger-Signature"],
        body: init.body,
      });
      return { status: attempt < 3 ? 503 : 200 };
    };
    const dir = prepare(`channels:
  - name: team-webhook
    type: webhook
    url: http://127.0.0.1:9/hook
    secret_env: ACTLEDGER_WEBHOOK_SECRET
`);
    const handle = await startServer({
      dir,
      port: 0,
      pollMs: 0,
      retryBaseMs: 1,
      env: { ACTLEDGER_WEBHOOK_SECRET: secret },
      httpPost,
    });
    handles.push(handle);
    createEmail(dir);
    await handle.notifier.tick();
    await handle.notifier.flush();
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((call) => call.id)).size).toBe(1);
    for (const call of calls) verifyWebhook(call.body, call.signature ?? "", secret);
    const lines = logLines(dir);
    expect(lines.filter((line) => line.outcome === "retry")).toHaveLength(2);
    expect(lines.filter((line) => line.outcome === "delivered")).toHaveLength(1);
  });

  it("records failure after four attempts and does not retry a 400", async () => {
    let failedCalls = 0;
    const failDir = prepare(`channels:
  - name: team-webhook
    type: webhook
    url: http://127.0.0.1:9/hook
    secret_env: ACTLEDGER_WEBHOOK_SECRET
`);
    const failing = await startServer({
      dir: failDir,
      port: 0,
      pollMs: 0,
      retryBaseMs: 1,
      env: { ACTLEDGER_WEBHOOK_SECRET: secret },
      httpPost: async () => {
        failedCalls += 1;
        return { status: 503 };
      },
    });
    handles.push(failing);
    createEmail(failDir);
    await failing.notifier.tick();
    await failing.notifier.flush();
    expect(failedCalls).toBe(4);
    expect(logLines(failDir).filter((line) => line.outcome === "failed")).toHaveLength(1);

    let clientCalls = 0;
    const clientDir = prepare(`channels:
  - name: team-webhook
    type: webhook
    url: http://127.0.0.1:9/hook
    secret_env: ACTLEDGER_WEBHOOK_SECRET
`);
    const client = await startServer({
      dir: clientDir,
      port: 0,
      pollMs: 0,
      retryBaseMs: 1,
      env: { ACTLEDGER_WEBHOOK_SECRET: secret },
      httpPost: async () => {
        clientCalls += 1;
        return { status: 400 };
      },
    });
    handles.push(client);
    createEmail(clientDir);
    await client.notifier.tick();
    await client.notifier.flush();
    expect(clientCalls).toBe(1);
    expect(logLines(clientDir).some((line) => line.outcome === "failed")).toBe(true);
    expect(logLines(clientDir).some((line) => line.outcome === "retry")).toBe(false);
  });

  it("emits approved only for a human decision listed by the channel", async () => {
    const types: string[] = [];
    const dir = prepare(`channels:
  - name: team-webhook
    type: webhook
    url: http://127.0.0.1:9/hook
    secret_env: ACTLEDGER_WEBHOOK_SECRET
    events: [task.approved]
`);
    const handle = await startServer({
      dir,
      port: 0,
      pollMs: 0,
      env: { ACTLEDGER_WEBHOOK_SECRET: secret },
      httpPost: async (_url, init) => {
        types.push(JSON.parse(init.body).type as string);
        return { status: 200 };
      },
    });
    handles.push(handle);
    const created = createEmail(dir);
    await handle.notifier.tick();
    await handle.notifier.flush();
    expect(types).toEqual([]);
    withLedger(dir, (engine) =>
      engine.approve(created.task.id, {
        approverPrincipalId: "u_1",
        channel: "cli",
        assurance: "app_asserted",
        presentedHash: created.task.payloadHash,
      }),
    );
    await handle.notifier.tick();
    await handle.notifier.flush();
    expect(types).toEqual(["task.approved"]);
    withLedger(dir, (engine) =>
      engine.request({
        principalId: "u_1",
        action: { type: "calendar.create" },
        payload: { action: "calendar.create", args: { title: "standup" } },
      }),
    );
    await handle.notifier.tick();
    await handle.notifier.flush();
    expect(types).toEqual(["task.approved"]);
  });

  it("does not send the same pending task again after a restart", async () => {
    const receiver = await listen();
    const dir = prepare(`channels:
  - name: team-webhook
    type: webhook
    url: http://127.0.0.1:${receiver.port}/hook
    secret_env: ACTLEDGER_WEBHOOK_SECRET
`);
    const first = await startServer({ dir, port: 0, pollMs: 0, env: { ACTLEDGER_WEBHOOK_SECRET: secret } });
    handles.push(first);
    createEmail(dir);
    await first.notifier.tick();
    await first.notifier.flush();
    expect(receiver.requests).toHaveLength(1);
    await first.close();
    handles.pop();
    const second = await startServer({ dir, port: 0, pollMs: 0, env: { ACTLEDGER_WEBHOOK_SECRET: secret } });
    handles.push(second);
    await second.notifier.tick();
    await second.notifier.flush();
    expect(receiver.requests).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, "notify-state.json"))).toBe(true);
  });
});
