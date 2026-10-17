import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initLocalDir, openLedger, type LedgerEngine, type Receipt } from "@actledger/core";
import { startServer, type ServeHandle, type ServeOptions } from "../src/serve/server.js";
import { rotateLoginToken } from "../src/serve/token.js";

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

async function boot(policy: string, extra?: { approver?: string; serve?: Partial<ServeOptions> }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-serve-"));
  dirs.push(dir);
  initLocalDir(dir, { policyYaml: policy });
  const handle = await startServer({ dir, port: 0, pollMs: 0, approver: extra?.approver, ...extra?.serve });
  handles.push(handle);
  expect(handle.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
  return { dir, handle };
}

function loginPath(handle: ServeHandle): string {
  return handle.loginUrl.slice(handle.origin.length);
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
  it("hides tasks until login creates a session", async () => {
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
    expect(again.status).toBe(303);

    const page = await request(handle.port, "GET", "/", { headers: { cookie: `actledger_session=${session}` } });
    expect(page.status).toBe(200);
    expect(page.body).toContain(created.task.id);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(String(page.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(String(page.headers["content-security-policy"])).toContain("script-src 'self'");
    expect(String(page.headers["content-security-policy"])).toContain("connect-src 'self'");
    expect(page.body).toContain('<script src="/assets/console.js"></script>');
    expect(page.body).not.toMatch(/<script(?![^>]*\ssrc="\/assets\/console\.js")/);

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
      if (!("origin" in item.headers) && !("sec-fetch-site" in item.headers)) {
        expect(response.body).toContain("origin_rejected");
      }
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
      body: form({ ...fields, reason: "not now" }),
    });
    expect(rejected.status).toBe(303);
    expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("rejected");
  });

  it("keeps the login token across restarts and repeated logins", async () => {
    const { dir, handle } = await boot(openPolicy);
    const file = path.join(dir, "serve.token");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["v", "token", "generation", "createdAt"]);
    expect(parsed.v).toBe(1);
    expect(parsed.generation).toBe(1);
    expect(parsed.token).toBe(new URL(handle.loginUrl).searchParams.get("token"));
    const first = await request(handle.port, "GET", loginPath(handle));
    const second = await request(handle.port, "GET", loginPath(handle));
    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    const left = cookieValue(first.headers);
    const right = cookieValue(second.headers);
    expect(left).not.toBe(right);
    expect((await request(handle.port, "GET", "/", { headers: { cookie: `actledger_session=${left}` } })).status).toBe(200);
    expect((await request(handle.port, "GET", "/", { headers: { cookie: `actledger_session=${right}` } })).status).toBe(200);
    const kept = handle.loginUrl;
    const port = handle.port;
    await handle.close();
    handles.pop();
    const restarted = await startServer({ dir, port, pollMs: 0 });
    handles.push(restarted);
    expect(restarted.loginUrl).toBe(kept);
    expect((await request(restarted.port, "GET", loginPath(restarted))).status).toBe(303);
  });

  it("invalidates old tokens and sessions when the token file is rotated", async () => {
    const { dir, handle } = await boot(openPolicy);
    const session = await login(handle);
    const previousUrl = handle.loginUrl;
    rotateLoginToken(handle.tokenFile!, { now: () => new Date(), log: () => {} });
    const rotated = JSON.parse(fs.readFileSync(handle.tokenFile!, "utf8")) as { token: string; generation: number };
    expect(rotated.generation).toBe(2);
    expect((await request(handle.port, "GET", "/", { headers: { cookie: `actledger_session=${session}` } })).status).toBe(401);
    expect((await request(handle.port, "GET", loginPath(handle))).status).toBe(401);
    expect((await request(handle.port, "GET", `/login?token=${rotated.token}`)).status).toBe(303);
    await handle.close();
    handles.pop();
    const again = await startServer({ dir, port: 0, pollMs: 0, rotateToken: true });
    handles.push(again);
    expect(again.tokenGeneration).toBe(3);
    expect(again.loginUrl).not.toBe(previousUrl);
    expect(new URL(again.loginUrl).searchParams.get("token")).not.toBe(rotated.token);
    expect((await request(again.port, "GET", `/login?token=${rotated.token}`)).status).toBe(401);
  });

  it("burns an in-memory token when one-time login is requested", async () => {
    const { dir, handle } = await boot(openPolicy, { serve: { loginMode: "one-time" } });
    expect(handle.tokenFile).toBeNull();
    expect(fs.existsSync(path.join(dir, "serve.token"))).toBe(false);
    expect((await request(handle.port, "GET", loginPath(handle))).status).toBe(303);
    expect((await request(handle.port, "GET", loginPath(handle))).status).toBe(401);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "actl-serve-"));
    dirs.push(other);
    initLocalDir(other, { policyYaml: openPolicy });
    await expect(startServer({ dir: other, port: 0, pollMs: 0, loginMode: "one-time", rotateToken: true })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fs.existsSync(path.join(other, "serve.token"))).toBe(false);
  });

  it("tightens a loose token file without logging the token", async () => {
    const { dir, handle } = await boot(openPolicy);
    const file = handle.tokenFile!;
    const token = new URL(handle.loginUrl).searchParams.get("token") ?? "";
    await handle.close();
    handles.pop();
    fs.chmodSync(file, 0o644);
    const lines: string[] = [];
    const again = await startServer({ dir, port: 0, pollMs: 0, log: (line) => lines.push(line) });
    handles.push(again);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(lines.some((line) => line.includes("tightened permissions"))).toBe(true);
    expect(lines.join("\n")).not.toContain(token);
    await again.close();
    handles.pop();
    const secret = "SECRET_TOKEN_BYTES_SHOULD_NOT_LEAK";
    fs.writeFileSync(file, `{not json ${secret}\n`);
    try {
      await startServer({ dir, port: 0, pollMs: 0 });
      throw new Error("expected a bad token file to be rejected");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_request" });
      expect(error instanceof Error ? error.message : "").not.toContain(secret);
    }
  });

  it("opens the login URL with no Origin header", async () => {
    const { handle } = await boot(openPolicy);
    const response = await request(handle.port, "GET", loginPath(handle), { headers: {} });
    expect(response.status).toBe(303);
  });

  it("approves a Safari post that has no Origin but is same-origin", async () => {
    const { dir, handle } = await boot(openPolicy);
    const created = createTask(dir);
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers: { cookie } });
    const approved = await request(handle.port, "POST", `/tasks/${created.task.id}/approve`, {
      headers: { cookie, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf: field(detail.body, "csrf"), presented_hash: field(detail.body, "presented_hash") }),
    });
    expect(approved.status).toBe(303);
    const receipt = withLedger(dir, (engine) => {
      expect(engine.getTask(created.task.id)?.state).toBe("approved");
      return engine.exportReceipts().find((item) => item.transition?.to === "approved") as Receipt;
    });
    expect((receipt.body.approval as { channel?: string }).channel).toBe("web");
  });

  it("rejects a post with no Origin, site, or Referer", async () => {
    const { dir, handle } = await boot(openPolicy);
    const created = createTask(dir);
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers: { cookie } });
    const before = withLedger(dir, (engine) => engine.exportReceipts().length);
    const response = await request(handle.port, "POST", `/tasks/${created.task.id}/approve`, {
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf: field(detail.body, "csrf"), presented_hash: field(detail.body, "presented_hash") }),
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("origin_rejected");
    expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("pending_approval");
    expect(withLedger(dir, (engine) => engine.exportReceipts().length)).toBe(before);
  });

  it("approves a post whose Referer is this server when Origin is missing", async () => {
    const { dir, handle } = await boot(openPolicy);
    const created = createTask(dir);
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers: { cookie } });
    const approved = await request(handle.port, "POST", `/tasks/${created.task.id}/approve`, {
      headers: {
        cookie,
        referer: `${handle.origin}/tasks/${created.task.id}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ csrf: field(detail.body, "csrf"), presented_hash: field(detail.body, "presented_hash") }),
    });
    expect(approved.status).toBe(303);
    expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("approved");
  });

  it("rejects a foreign Origin even when the other browser headers look local", async () => {
    const { dir, handle } = await boot(openPolicy);
    const created = createTask(dir);
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers: { cookie } });
    const response = await request(handle.port, "POST", `/tasks/${created.task.id}/approve`, {
      headers: {
        cookie,
        origin: "http://evil.example",
        referer: `${handle.origin}/tasks/${created.task.id}`,
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ csrf: field(detail.body, "csrf"), presented_hash: field(detail.body, "presented_hash") }),
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("origin_rejected");
    expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("pending_approval");
  });

  it("accepts only the safe missing-Origin combinations", async () => {
    const { dir, handle } = await boot(openPolicy);
    const created = createTask(dir);
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers: { cookie } });
    const csrf = field(detail.body, "csrf");
    const presented = field(detail.body, "presented_hash");
    const before = withLedger(dir, (engine) => engine.exportReceipts().length);
    const target = `/tasks/${created.task.id}/approve`;
    const type = "application/x-www-form-urlencoded";
    const failures: Array<{ headers: Record<string, string>; body: string; status: number; code?: string }> = [
      {
        headers: { cookie, "sec-fetch-site": "cross-site", "content-type": type },
        body: form({ csrf, presented_hash: presented }),
        status: 403,
        code: "fetch_site_rejected",
      },
      {
        headers: { cookie, referer: "http://evil.example/x", "content-type": type },
        body: form({ csrf, presented_hash: presented }),
        status: 403,
        code: "origin_rejected",
      },
      {
        headers: { cookie, "sec-fetch-site": "same-origin", referer: "http://evil.example/x", "content-type": type },
        body: form({ csrf, presented_hash: presented }),
        status: 403,
        code: "origin_rejected",
      },
      {
        headers: { cookie, "sec-fetch-site": "same-origin", "content-type": type },
        body: form({ csrf: "wrong-csrf", presented_hash: presented }),
        status: 403,
        code: "csrf_failed",
      },
      {
        headers: { "sec-fetch-site": "same-origin", "content-type": type },
        body: form({ csrf, presented_hash: presented }),
        status: 401,
      },
    ];
    for (const item of failures) {
      const response = await request(handle.port, "POST", target, { headers: item.headers, body: item.body });
      expect(response.status).toBe(item.status);
      if (item.code) expect(response.body).toContain(item.code);
      expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("pending_approval");
      expect(withLedger(dir, (engine) => engine.exportReceipts().length)).toBe(before);
    }
    const approved = await request(handle.port, "POST", target, {
      headers: { cookie, origin: "null", "sec-fetch-site": "same-origin", "content-type": type },
      body: form({ csrf, presented_hash: presented }),
    });
    expect(approved.status).toBe(303);
    expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("approved");
  });

  it("logs out a same-origin post that has no Origin", async () => {
    const { handle } = await boot(openPolicy);
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const page = await request(handle.port, "GET", "/", { headers: { cookie } });
    const response = await request(handle.port, "POST", "/logout", {
      headers: { cookie, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf: field(page.body, "csrf") }),
    });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/login-ended");
    expect((await request(handle.port, "GET", "/", { headers: { cookie } })).status).toBe(401);
  });

  it("serves the task list as JSON", async () => {
    const { dir, handle } = await boot(openPolicy);
    const first = createTask(dir);
    const anonymous = await request(handle.port, "GET", "/api/tasks");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toBe("unauthorized");
    expect(anonymous.body).not.toContain(first.task.id);
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const pending = await request(handle.port, "GET", "/api/tasks", { headers: { cookie } });
    expect(pending.status).toBe(200);
    expect(String(pending.headers["content-type"])).toMatch(/^application\/json/);
    const body = JSON.parse(pending.body) as { tasks: Array<Record<string, unknown>> };
    expect(Object.keys(body.tasks[0] ?? {})).toEqual([
      "id",
      "state",
      "action",
      "principalId",
      "createdAt",
      "updatedAt",
      "expiresAt",
      "expired",
      "decided",
      "intent",
      "args",
    ]);
    expect(body.tasks[0]?.id).toBe(first.task.id);
    expect(String(body.tasks[0]?.args)).toContain("a@b.c");
    expect(pending.body).not.toContain("payload-should-stay-hidden");
    const second = createTask(dir, "later-intent", "later-body");
    const detail = await request(handle.port, "GET", `/tasks/${first.task.id}`, { headers: { cookie } });
    const approved = await request(handle.port, "POST", `/tasks/${first.task.id}/approve`, {
      headers: { cookie, origin: handle.origin, "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf: field(detail.body, "csrf"), presented_hash: field(detail.body, "presented_hash") }),
    });
    expect(approved.status).toBe(303);
    const stillPending = JSON.parse(
      (await request(handle.port, "GET", "/api/tasks?state=pending", { headers: { cookie } })).body,
    ) as { tasks: Array<{ id: string }> };
    expect(stillPending.tasks.map((task) => task.id)).not.toContain(first.task.id);
    const recent = JSON.parse(
      (await request(handle.port, "GET", "/api/tasks?state=recent", { headers: { cookie } })).body,
    ) as { tasks: Array<{ id: string; decided: boolean; state: string }> };
    expect(recent.tasks).toContainEqual(expect.objectContaining({ id: first.task.id, decided: true, state: "approved" }));
    const all = JSON.parse(
      (await request(handle.port, "GET", "/api/tasks?state=all", { headers: { cookie } })).body,
    ) as { tasks: Array<{ id: string; createdAt: string }> };
    const ids = all.tasks.map((task) => task.id);
    expect(ids).toEqual(expect.arrayContaining([first.task.id, second.task.id]));
    const newer = all.tasks.findIndex((task) => task.id === second.task.id);
    const older = all.tasks.findIndex((task) => task.id === first.task.id);
    expect(all.tasks[newer]?.createdAt >= (all.tasks[older]?.createdAt ?? "")).toBe(true);
    expect(newer).toBeLessThan(older);
    const bogus = await request(handle.port, "GET", "/api/tasks?state=bogus", { headers: { cookie } });
    expect(bogus.status).toBe(400);
    expect((JSON.parse(bogus.body) as { error?: string }).error).toBe("invalid_request");
  });

  it("renders list tabs and the polling script", async () => {
    const { handle } = await boot(openPolicy);
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const recent = await request(handle.port, "GET", "/?tab=recent", { headers: { cookie } });
    expect(recent.status).toBe(200);
    expect(recent.body).toContain("Recent decisions");
    expect(recent.body).toContain('data-tab="recent"');
    expect(recent.body).toContain('aria-current="page"');
    expect((await request(handle.port, "GET", "/?tab=bogus", { headers: { cookie } })).status).toBe(400);
    const script = await request(handle.port, "GET", "/assets/console.js", { headers: { cookie } });
    expect(script.status).toBe(200);
    expect(String(script.headers["content-type"])).toMatch(/^text\/javascript/);
    expect(script.body).toContain("/api/tasks");
    expect(script.body).toContain("3000");
    expect(script.body).not.toContain("innerHTML");
    expect((await request(handle.port, "GET", "/assets/console.js")).status).toBe(401);
  });

  it("requires a reason to reject from the page", async () => {
    const { dir, handle } = await boot(openPolicy);
    const created = createTask(dir);
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers: { cookie } });
    const headers = { cookie, origin: handle.origin, "content-type": "application/x-www-form-urlencoded" };
    const fields = { csrf: field(detail.body, "csrf"), presented_hash: field(detail.body, "presented_hash") };
    const before = withLedger(dir, (engine) => engine.exportReceipts().length);
    for (const body of [form(fields), form({ ...fields, reason: "   " })]) {
      const response = await request(handle.port, "POST", `/tasks/${created.task.id}/reject`, { headers, body });
      expect(response.status).toBe(400);
      expect(response.body).toContain("reason_required");
      expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("pending_approval");
      expect(withLedger(dir, (engine) => engine.exportReceipts().length)).toBe(before);
    }
    const rejected = await request(handle.port, "POST", `/tasks/${created.task.id}/reject`, {
      headers,
      body: form({ ...fields, reason: "no" }),
    });
    expect(rejected.status).toBe(303);
    expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("rejected");
  });

  it("shows the approval timeline and the payload being approved", async () => {
    const { dir, handle } = await boot(openPolicy);
    const pending = createTask(dir);
    const approvedTask = createTask(dir, "approve-me", "approve-body");
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const waiting = await request(handle.port, "GET", `/tasks/${pending.task.id}`, { headers: { cookie } });
    expect(waiting.body).toContain("You are approving");
    expect(waiting.body).toContain(`presented_hash <code>${pending.task.payloadHash}</code>`);
    expect(waiting.body).toContain("a@b.c");
    const detail = await request(handle.port, "GET", `/tasks/${approvedTask.task.id}`, { headers: { cookie } });
    const approved = await request(handle.port, "POST", `/tasks/${approvedTask.task.id}/approve`, {
      headers: { cookie, origin: handle.origin, "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf: field(detail.body, "csrf"), presented_hash: field(detail.body, "presented_hash") }),
    });
    expect(approved.status).toBe(303);
    const page = await request(handle.port, "GET", `/tasks/${approvedTask.task.id}`, { headers: { cookie } });
    expect(page.body).toContain("Timeline");
    expect(page.body).toContain("requested");
    expect(page.body).toContain("pending approval");
    expect(page.body).toContain("approved");
    expect(page.body).toContain("channel web");
    expect(page.body).toContain("assurance app_asserted");
    expect(page.body).toContain("by u_1");
    expect(page.body).toContain("Decision");
  });

  it("explains why a higher assurance cannot be approved on the page", async () => {
    const { dir, handle } = await boot(highAssurancePolicy);
    const created = createTask(dir);
    const session = await login(handle);
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, {
      headers: { cookie: `actledger_session=${session}` },
    });
    expect(detail.body).toContain("channel_verified");
    expect(detail.body).toContain("actledger approve");
    expect(detail.body).toContain("verified channel");
    expect(detail.body).toContain('<button type="submit" disabled>Approve</button>');
  });
});
