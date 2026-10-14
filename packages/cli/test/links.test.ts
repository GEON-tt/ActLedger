import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initLocalDir, openLedger, type LedgerEngine, type Receipt, type TaskView } from "@actledger/core";
import { loadOrCreateLinkKey, signLink } from "../src/serve/links.js";
import { startServer, type ServeHandle, type ServeOptions } from "../src/serve/server.js";

const dirs: string[] = [];
const handles: ServeHandle[] = [];

const policy = `
version: 1
defaults:
  unknown_action: require_approval
  approval: { channels: [cli, web, webhook_link], timeout: 1h, min_assurance: app_asserted }
actions:
  email.send: { level: write }
`;

const noLinkPolicy = `
version: 1
defaults:
  unknown_action: require_approval
  approval: { channels: [cli, web], timeout: 1h, min_assurance: app_asserted }
actions:
  email.send: { level: write }
`;

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
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
  if (!match?.[1]) throw new Error(`missing ${name} in page`);
  return match[1];
}

function withLedger<T>(dir: string, fn: (engine: LedgerEngine) => T): T {
  const engine = openLedger({ dir });
  try {
    return fn(engine);
  } finally {
    engine.close();
  }
}

function createTask(dir: string, intent = "link-intent", text = "link-body") {
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

async function boot(policyYaml: string, extra?: Partial<ServeOptions> & { capture?: string[] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-link-"));
  dirs.push(dir);
  initLocalDir(dir, { policyYaml });
  fs.writeFileSync(
    path.join(dir, "channels.yaml"),
    `channels:
  - name: team-webhook
    type: webhook
    url: http://127.0.0.1:9/hook
    secret_env: ACTLEDGER_WEBHOOK_SECRET
    events: [task.pending_approval]
`,
  );
  const { capture, ...options } = extra ?? {};
  const handle = await startServer({
    dir,
    port: 0,
    pollMs: 0,
    env: { ACTLEDGER_WEBHOOK_SECRET: "link-secret" },
    httpPost: async (_url, init) => {
      capture?.push(init.body);
      return { status: 200 };
    },
    ...options,
  });
  handles.push(handle);
  expect(handle.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
  return { dir, handle };
}

function signedPath(dir: string, task: { id: string; appId: string; payloadHash: string }, exp: number): string {
  const sig = signLink(loadOrCreateLinkKey(dir), {
    appId: task.appId,
    taskId: task.id,
    payloadHash: task.payloadHash,
    exp,
  });
  return `/t/${task.id}?sig=${sig}&exp=${exp}`;
}

describe("signed approval links", () => {
  it("shows one task from a webhook link and does not approve on GET", async () => {
    const capture: string[] = [];
    const { dir, handle } = await boot(policy, { capture });
    const first = createTask(dir, "first-intent", "first-body");
    await handle.notifier.tick();
    await handle.notifier.flush();
    const event = JSON.parse(capture[0] ?? "{}") as { data?: { approve_url?: string } };
    const approveUrl = event.data?.approve_url ?? "";
    expect(approveUrl.startsWith(`${handle.publicUrl}/t/`)).toBe(true);
    const second = createTask(dir, "second-intent", "second-body");
    const url = new URL(approveUrl);
    const before = withLedger(dir, (engine) => engine.exportReceipts().length);
    const page = await request(handle.port, "GET", `${url.pathname}${url.search}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain(first.task.id);
    expect(page.body).not.toContain(second.task.id);
    expect(page.body).toContain("first-intent");
    expect(withLedger(dir, (engine) => engine.getTask(first.task.id)?.state)).toBe("pending_approval");
    expect(withLedger(dir, (engine) => engine.exportReceipts().length)).toBe(before);

    const flipped = url.searchParams.get("sig")!.slice(0, -1) + (url.searchParams.get("sig")!.endsWith("a") ? "b" : "a");
    const badSig = await request(handle.port, "GET", `/t/${first.task.id}?sig=${flipped}&exp=${url.searchParams.get("exp")}`);
    expect(badSig.status).toBe(403);
    expect(badSig.body).not.toContain("first-body");
    const badExp = await request(
      handle.port,
      "GET",
      `/t/${first.task.id}?sig=${url.searchParams.get("sig")}&exp=${Number(url.searchParams.get("exp")) + 1}`,
    );
    expect(badExp.status).toBe(403);
  });

  it("expires a link 901 seconds after it was signed", async () => {
    let nowMs = Date.now();
    const { dir, handle } = await boot(policy, { now: () => new Date(nowMs) });
    const created = createTask(dir);
    const exp = Math.floor(nowMs / 1000) + 900;
    const ok = await request(handle.port, "GET", signedPath(dir, created.task, exp));
    expect(ok.status).toBe(200);
    nowMs += 901_000;
    const expired = await request(handle.port, "GET", signedPath(dir, created.task, exp));
    expect(expired.status).toBe(410);
    expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("pending_approval");
  });

  it("keeps a link usable when nonce or origin checks fail", async () => {
    const { dir, handle } = await boot(policy);
    const created = createTask(dir);
    const exp = Math.floor(Date.now() / 1000) + 900;
    const linkPath = signedPath(dir, created.task, exp);
    const page = await request(handle.port, "GET", linkPath);
    expect(page.status).toBe(200);
    const sig = field(page.body, "sig");
    const postedExp = field(page.body, "exp");
    const nonce = field(page.body, "nonce");
    const presented = field(page.body, "presented_hash");
    const headers = { origin: handle.origin, "content-type": "application/x-www-form-urlencoded" };
    const noNonce = await request(handle.port, "POST", `/t/${created.task.id}`, {
      headers,
      body: form({ sig, exp: postedExp, presented_hash: presented, decision: "approve" }),
    });
    const wrongNonce = await request(handle.port, "POST", `/t/${created.task.id}`, {
      headers,
      body: form({ sig, exp: postedExp, nonce: "wrong-nonce", presented_hash: presented, decision: "approve" }),
    });
    const noOrigin = await request(handle.port, "POST", `/t/${created.task.id}`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ sig, exp: postedExp, nonce, presented_hash: presented, decision: "approve" }),
    });
    expect(noNonce.status).toBe(403);
    expect(wrongNonce.status).toBe(403);
    expect(noOrigin.status).toBe(403);
    expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("pending_approval");

    const again = await request(handle.port, "GET", linkPath);
    const approved = await request(handle.port, "POST", `/t/${created.task.id}`, {
      headers,
      body: form({
        sig: field(again.body, "sig"),
        exp: field(again.body, "exp"),
        nonce: field(again.body, "nonce"),
        presented_hash: field(again.body, "presented_hash"),
        decision: "approve",
      }),
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toContain(created.task.id);
    const receipt = withLedger(dir, (engine) => {
      expect(engine.getTask(created.task.id)?.state).toBe("approved");
      return engine.exportReceipts().find((item) => item.transition?.to === "approved") as Receipt;
    });
    const approval = receipt.body.approval as { channel?: string; assurance?: string };
    expect(approval.channel).toBe("webhook_link");
    expect(approval.assurance).toBe("app_asserted");
  });

  it("accepts a link once and remembers that across a restart", async () => {
    const { dir, handle } = await boot(policy);
    const created = createTask(dir);
    const exp = Math.floor(Date.now() / 1000) + 900;
    const linkPath = signedPath(dir, created.task, exp);
    const page = await request(handle.port, "GET", linkPath);
    const headers = { origin: handle.origin, "content-type": "application/x-www-form-urlencoded" };
    const sig = field(page.body, "sig");
    const first = await request(handle.port, "POST", `/t/${created.task.id}`, {
      headers,
      body: form({
        sig,
        exp: field(page.body, "exp"),
        nonce: field(page.body, "nonce"),
        presented_hash: field(page.body, "presented_hash"),
        decision: "approve",
      }),
    });
    expect(first.status).toBe(200);
    const usedFile = fs.readFileSync(path.join(dir, "link-used.jsonl"), "utf8");
    expect(usedFile).not.toContain(sig);
    expect(fs.statSync(path.join(dir, "link-used.jsonl")).mode & 0o777).toBe(0o600);
    const second = await request(handle.port, "POST", `/t/${created.task.id}`, {
      headers,
      body: form({
        sig,
        exp: field(page.body, "exp"),
        nonce: "another",
        presented_hash: field(page.body, "presented_hash"),
        decision: "approve",
      }),
    });
    expect(second.status).toBe(410);
    expect(second.body).toContain("link_used");
    const reread = await request(handle.port, "GET", linkPath);
    expect(reread.status).toBe(410);
    expect(reread.body).toContain("link_used");

    await handle.close();
    handles.pop();
    const restarted = await startServer({
      dir,
      port: 0,
      pollMs: 0,
      env: { ACTLEDGER_WEBHOOK_SECRET: "link-secret" },
      httpPost: async () => ({ status: 200 }),
    });
    handles.push(restarted);
    const afterRestart = await request(restarted.port, "GET", linkPath);
    expect(afterRestart.status).toBe(410);
    expect(afterRestart.body).toContain("link_used");
  });

  it("omits approve links unless the policy allows webhook_link", async () => {
    const capture: string[] = [];
    const { dir, handle } = await boot(noLinkPolicy, { capture });
    const created = createTask(dir);
    await handle.notifier.tick();
    await handle.notifier.flush();
    const event = JSON.parse(capture[0] ?? "{}") as { data?: { approve_url?: string | null } };
    expect(event.data?.approve_url).toBeNull();
    const task = created.task as TaskView;
    const exp = Math.floor(Date.now() / 1000) + 900;
    const page = await request(handle.port, "GET", signedPath(dir, task, exp));
    expect(page.status).toBe(200);
    const response = await request(handle.port, "POST", `/t/${task.id}`, {
      headers: { origin: handle.origin, "content-type": "application/x-www-form-urlencoded" },
      body: form({
        sig: field(page.body, "sig"),
        exp: field(page.body, "exp"),
        nonce: field(page.body, "nonce"),
        presented_hash: field(page.body, "presented_hash"),
        decision: "approve",
      }),
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("channel_not_allowed");
    expect(withLedger(dir, (engine) => engine.getTask(task.id)?.state)).toBe("pending_approval");
  });
});
