import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initLocalDir, openLedger, type LedgerEngine, type Receipt } from "@actledger/core";
import { startServer, type ServeHandle } from "../src/serve/server.js";

const dirs: string[] = [];
const handles: ServeHandle[] = [];

const openPolicy = `
version: 1
defaults:
  unknown_action: require_approval
  approval: { channels: [cli, web, webhook_link], timeout: 1h, min_assurance: app_asserted }
actions:
  email.send: { level: write }
`;

const cliOnlyPolicy = `
version: 1
defaults:
  unknown_action: require_approval
  approval: { channels: [cli], timeout: 1h, min_assurance: app_asserted }
actions:
  email.send: { level: write }
`;

const highAssurancePolicy = `
version: 1
defaults:
  unknown_action: require_approval
  approval: { channels: [cli, web, webhook_link], timeout: 1h, min_assurance: channel_verified }
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

function withLedger<T>(dir: string, fn: (engine: LedgerEngine) => T): T {
  const engine = openLedger({ dir });
  try {
    return fn(engine);
  } finally {
    engine.close();
  }
}

function createTask(dir: string, intent = "intent-should-stay-hidden", text = "payload-should-stay-hidden") {
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

async function boot(policy: string, extra?: { approver?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-serve-"));
  dirs.push(dir);
  initLocalDir(dir, { policyYaml: policy });
  const handle = await startServer({ dir, port: 0, pollMs: 0, approver: extra?.approver });
  handles.push(handle);
  expect(handle.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
  return { dir, handle };
}

async function login(handle: ServeHandle): Promise<string> {
  const url = new URL(handle.loginUrl);
  const response = await request(handle.port, "GET", `${url.pathname}${url.search}`);
  expect(response.status).toBe(303);
  const raw = response.headers["set-cookie"];
  const joined = Array.isArray(raw) ? raw.join("\n") : (raw ?? "");
  expect(joined).toContain("HttpOnly");
  expect(joined).toContain("SameSite=Strict");
  expect(joined).toContain("Path=/");
  return cookieValue(response.headers);
}

describe("actledger serve", () => {
  it("hides tasks until a one-time login creates a session", async () => {
    const { dir, handle } = await boot(openPolicy);
    const created = createTask(dir);
    const home = await request(handle.port, "GET", "/");
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`);
    expect(home.status).toBe(401);
    expect(home.body).toBe("unauthorized");
    expect(detail.status).toBe(401);
    expect(detail.body).toBe("unauthorized");
    for (const body of [home.body, detail.body]) {
      expect(body).not.toContain(created.task.id);
      expect(body).not.toContain("intent-should-stay-hidden");
      expect(body).not.toContain("email.send");
    }

    const wrong = await request(handle.port, "GET", "/login?token=nope");
    expect(wrong.status).toBe(401);
    expect(wrong.body).toBe("unauthorized");

    const token = new URL(handle.loginUrl).searchParams.get("token");
    expect(token).toHaveLength(43);
    const session = await login(handle);
    const again = await request(handle.port, "GET", handle.loginUrl.slice(handle.origin.length));
    expect(again.status).toBe(401);

    const page = await request(handle.port, "GET", "/", { headers: { cookie: `actledger_session=${session}` } });
    expect(page.status).toBe(200);
    expect(page.body).toContain(created.task.id);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(String(page.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(page.body).not.toContain("<script");

    const taskPage = await request(handle.port, "GET", `/tasks/${created.task.id}`, {
      headers: { cookie: `actledger_session=${session}` },
    });
    expect(taskPage.status).toBe(200);
    expect(taskPage.body).toContain("intent-should-stay-hidden");
    expect(taskPage.body).toContain("payload-should-stay-hidden");
    expect(taskPage.body).toContain("payload_hash");
    expect(taskPage.body).toContain(created.task.decision.ruleId);
  });

  it("rejects a foreign Host and cross-site approval posts", async () => {
    const { dir, handle } = await boot(openPolicy);
    const created = createTask(dir);
    const evil = await request(handle.port, "GET", "/", { headers: { host: `evil.example:${handle.port}` } });
    expect(evil.status).toBe(421);
    expect(evil.body).toBe("misdirected request");

    const session = await login(handle);
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, {
      headers: { cookie: `actledger_session=${session}` },
    });
    const csrf = field(detail.body, "csrf");
    const presented = field(detail.body, "presented_hash");
    const before = withLedger(dir, (engine) => engine.exportReceipts().length);
    const cookie = `actledger_session=${session}`;
    const target = `/tasks/${created.task.id}/approve`;

    const cases: Array<{ headers: Record<string, string>; body: string }> = [
      {
        headers: { cookie, origin: handle.origin, "content-type": "application/x-www-form-urlencoded" },
        body: form({ presented_hash: presented }),
      },
      {
        headers: { cookie, origin: handle.origin, "content-type": "application/x-www-form-urlencoded" },
        body: form({ csrf: "wrong-csrf", presented_hash: presented }),
      },
      {
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: form({ csrf, presented_hash: presented }),
      },
      {
        headers: {
          cookie,
          origin: "http://evil.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form({ csrf, presented_hash: presented }),
      },
      {
        headers: {
          cookie,
          origin: handle.origin,
          "sec-fetch-site": "cross-site",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form({ csrf, presented_hash: presented }),
      },
    ];
    for (const item of cases) {
      const response = await request(handle.port, "POST", target, item);
      expect(response.status).toBe(403);
      expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("pending_approval");
      expect(withLedger(dir, (engine) => engine.exportReceipts().length)).toBe(before);
    }
    expect(cases).toHaveLength(5);

    const getApprove = await request(handle.port, "GET", target, { headers: { cookie } });
    expect(getApprove.status).toBe(405);
    expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("pending_approval");
  });

  it("approves and rejects from the page on the web channel", async () => {
    const { dir, handle } = await boot(openPolicy);
    const approvedTask = createTask(dir, "approve-me", "approve-body");
    const rejectedTask = createTask(dir, "reject-me", "reject-body");
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;

    const approvePage = await request(handle.port, "GET", `/tasks/${approvedTask.task.id}`, { headers: { cookie } });
    const approved = await request(handle.port, "POST", `/tasks/${approvedTask.task.id}/approve`, {
      headers: { cookie, origin: handle.origin, "content-type": "application/x-www-form-urlencoded" },
      body: form({
        csrf: field(approvePage.body, "csrf"),
        presented_hash: field(approvePage.body, "presented_hash"),
      }),
    });
    expect(approved.status).toBe(303);
    expect(approved.headers.location).toBe(`/tasks/${approvedTask.task.id}`);
    const approval = withLedger(dir, (engine) => {
      expect(engine.getTask(approvedTask.task.id)?.state).toBe("approved");
      return engine.exportReceipts().find((item) => item.transition?.to === "approved") as Receipt;
    });
    const approvalBody = approval.body.approval as {
      channel?: string;
      assurance?: string;
      auth?: { simulated?: boolean };
    };
    expect(approvalBody.channel).toBe("web");
    expect(approvalBody.assurance).toBe("app_asserted");
    expect(approvalBody.auth?.simulated).toBe(false);

    const rejectPage = await request(handle.port, "GET", `/tasks/${rejectedTask.task.id}`, { headers: { cookie } });
    const reason = "please-do-not-copy-this-reason";
    const rejected = await request(handle.port, "POST", `/tasks/${rejectedTask.task.id}/reject`, {
      headers: { cookie, origin: handle.origin, "content-type": "application/x-www-form-urlencoded" },
      body: form({
        csrf: field(rejectPage.body, "csrf"),
        presented_hash: field(rejectPage.body, "presented_hash"),
        reason,
      }),
    });
    expect(rejected.status).toBe(303);
    const rejection = withLedger(dir, (engine) => {
      expect(engine.getTask(rejectedTask.task.id)?.state).toBe("rejected");
      return engine.exportReceipts().find((item) => item.task_id === rejectedTask.task.id && item.transition?.to === "rejected") as Receipt;
    });
    const rejectionBody = rejection.body as { approval?: { channel?: string }; note_commit?: string };
    expect(rejectionBody.approval?.channel).toBe("web");
    expect(rejectionBody.note_commit).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(rejection)).not.toContain(reason);
  });

  it("blocks web approval when the policy only allows cli", async () => {
    const { dir, handle } = await boot(cliOnlyPolicy);
    const created = createTask(dir);
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers: { cookie } });
    expect(detail.body).toContain("disabled");
    expect(detail.body).toContain("策略不允许网页审批");
    const before = withLedger(dir, (engine) => engine.exportReceipts().length);
    const response = await request(handle.port, "POST", `/tasks/${created.task.id}/approve`, {
      headers: { cookie, origin: handle.origin, "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf: field(detail.body, "csrf"), presented_hash: field(detail.body, "presented_hash") }),
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("channel_not_allowed");
    expect(withLedger(dir, (engine) => engine.exportReceipts().length)).toBe(before);
    expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("pending_approval");
  });

  it("rejects an approver that is not the task principal", async () => {
    const { dir, handle } = await boot(openPolicy, { approver: "u_other" });
    const created = createTask(dir);
    const session = await login(handle);
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, {
      headers: { cookie: `actledger_session=${session}` },
    });
    const response = await request(handle.port, "POST", `/tasks/${created.task.id}/approve`, {
      headers: {
        cookie: `actledger_session=${session}`,
        origin: handle.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ csrf: field(detail.body, "csrf"), presented_hash: field(detail.body, "presented_hash") }),
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("approver_mismatch");
    expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("pending_approval");
  });

  it("refuses web approval below min assurance and still allows rejection", async () => {
    const { dir, handle } = await boot(highAssurancePolicy);
    const created = createTask(dir);
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers: { cookie } });
    const headers = { cookie, origin: handle.origin, "content-type": "application/x-www-form-urlencoded" };
    const fields = { csrf: field(detail.body, "csrf"), presented_hash: field(detail.body, "presented_hash") };
    const denied = await request(handle.port, "POST", `/tasks/${created.task.id}/approve`, {
      headers,
      body: form(fields),
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toContain("assurance_insufficient");
    expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("pending_approval");
    const rejected = await request(handle.port, "POST", `/tasks/${created.task.id}/reject`, {
      headers,
      body: form(fields),
    });
    expect(rejected.status).toBe(303);
    expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("rejected");
  });
});
