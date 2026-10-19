import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { STATES, initLocalDir, openLedger, type LedgerEngine } from "@actledger/core";
import { CONSOLE_JS } from "../src/serve/console-js.js";
import { STATUS_TONE, TOKENS_CSS } from "../src/serve/html.js";
import { loadOrCreateLinkKey, signLink } from "../src/serve/links.js";
import { startServer, type ServeHandle, type ServeOptions } from "../src/serve/server.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
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

const CONSOLE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

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

function cookieHeader(headers: http.IncomingHttpHeaders): string {
  const raw = headers["set-cookie"];
  return Array.isArray(raw) ? raw.join("\n") : (raw ?? "");
}

function cookieValue(headers: http.IncomingHttpHeaders): string {
  const match = /actledger_session=([^;]*)/.exec(cookieHeader(headers));
  if (!match) throw new Error(`missing session cookie in ${cookieHeader(headers)}`);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-ui-"));
  dirs.push(dir);
  initLocalDir(dir, { policyYaml: policy });
  const handle = await startServer({ dir, port: 0, pollMs: 0, approver: extra?.approver, ...extra?.serve });
  handles.push(handle);
  expect(handle.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
  return { dir, handle };
}

async function login(handle: ServeHandle): Promise<string> {
  const url = new URL(handle.loginUrl);
  const response = await request(handle.port, "GET", `${url.pathname}${url.search}`);
  expect(response.status).toBe(303);
  return cookieValue(response.headers);
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

function expectSelfContained(body: string, consolePage: boolean): void {
  expect(body).not.toMatch(/\b(?:src|href|action|xmlns(?::\w+)?|poster|srcset)\s*=\s*["']?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i);
  expect(body).not.toMatch(/url\(|@import|@font-face/i);
  expect(body).not.toMatch(/<(?:img|link|iframe|object|embed)\b/i);
  expect(body).not.toMatch(/\son[a-z]+\s*=/i);
  if (consolePage) expect(body).not.toMatch(/<script(?![^>]*\ssrc="\/assets\/console\.js")/);
}

describe("approval console locale and layout", () => {
  it("renders zh-CN from Accept-Language without setting a language cookie", async () => {
    const { dir, handle } = await boot(openPolicy);
    const created = createTask(dir);
    const session = await login(handle);
    const headers = { cookie: `actledger_session=${session}`, "accept-language": "zh-CN" };
    const home = await request(handle.port, "GET", "/", { headers });
    expect(home.status).toBe(200);
    expect(home.body).toContain('<html lang="zh-CN">');
    expect(home.body).toContain("待审批");
    expect(home.body).toContain('data-locale="zh-CN"');
    expect(cookieHeader(home.headers)).not.toContain("actledger_lang");
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers });
    expect(detail.body).toContain("你正在批准");
    expect(detail.body).toContain("<button type=\"submit\">批准</button>");
    expect(detail.body).toContain(`presented_hash <code>${created.task.payloadHash}</code>`);
  });

  it("lets ?lang override Accept-Language and persist in the language cookie", async () => {
    const { handle } = await boot(openPolicy);
    const session = await login(handle);
    const sessionCookie = `actledger_session=${session}`;
    const forced = await request(handle.port, "GET", "/?lang=en", {
      headers: { cookie: sessionCookie, "accept-language": "zh-CN" },
    });
    expect(forced.status).toBe(200);
    expect(forced.headers.location).toBeUndefined();
    const forcedCookies = cookieHeader(forced.headers);
    expect(forcedCookies).toContain("actledger_lang=en");
    expect(forcedCookies).toContain("HttpOnly");
    expect(forcedCookies).toContain("SameSite=Strict");
    expect(forcedCookies).toContain("Path=/");
    expect(forced.body).toContain('<html lang="en">');
    expect(forced.body).toContain("Pending approvals");
    const kept = await request(handle.port, "GET", "/", {
      headers: { cookie: `${sessionCookie}; actledger_lang=en`, "accept-language": "zh-CN" },
    });
    expect(kept.body).toContain('<html lang="en">');
    expect(kept.body).toContain("Pending approvals");
    const toZh = await request(handle.port, "GET", "/?lang=zh-CN", { headers: { cookie: sessionCookie } });
    expect(cookieHeader(toZh.headers)).toContain("actledger_lang=zh-CN");
    const zh = await request(handle.port, "GET", "/", {
      headers: { cookie: `${sessionCookie}; actledger_lang=zh-CN` },
    });
    expect(zh.body).toContain('<html lang="zh-CN">');
    expect(zh.body).toContain("待审批");
  });

  it("does not let lang change authorization, redirects, or posts", async () => {
    const { dir, handle } = await boot(openPolicy);
    const anon = await request(handle.port, "GET", "/?lang=zh-CN");
    expect(anon.status).toBe(401);
    expect(anon.body).toBe("unauthorized");
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const ignored = await request(handle.port, "GET", "/?lang=fr", { headers: { cookie } });
    expect(ignored.status).toBe(200);
    expect(ignored.body).toContain('<html lang="en">');
    expect(cookieHeader(ignored.headers)).not.toContain("actledger_lang");
    const created = createTask(dir);
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers: { cookie } });
    const rejected = await request(handle.port, "POST", `/tasks/${created.task.id}/reject?lang=zh-CN`, {
      headers: { cookie, origin: handle.origin, "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf: field(detail.body, "csrf"), presented_hash: field(detail.body, "presented_hash") }),
    });
    expect(rejected.status).toBe(400);
    expect(cookieHeader(rejected.headers)).not.toContain("actledger_lang");
    expect(withLedger(dir, (engine) => engine.getTask(created.task.id)?.state)).toBe("pending_approval");
    const url = new URL(handle.loginUrl);
    url.searchParams.set("lang", "zh-CN");
    const loggedIn = await request(handle.port, "GET", `${url.pathname}${url.search}`);
    expect(loggedIn.status).toBe(303);
    expect(loggedIn.headers.location).toBe("/");
    const cookies = cookieHeader(loggedIn.headers);
    expect(cookies).toContain("actledger_session=");
    expect(cookies).toContain("actledger_lang=zh-CN");
  });

  it("renders the logged-out page in both languages", async () => {
    const { handle } = await boot(openPolicy);
    const page = await request(handle.port, "GET", "/login-ended");
    expect(page.status).toBe(200);
    expect(String(page.headers["content-type"])).toMatch(/^text\/html/);
    expect(page.body).toContain("You are logged out");
    const zh = await request(handle.port, "GET", "/login-ended", { headers: { "accept-language": "zh-CN" } });
    expect(zh.body).toContain("已退出登录");
  });

  it("does not reference external resources", async () => {
    const { dir, handle } = await boot(openPolicy);
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const headers = { cookie };
    const empty = await request(handle.port, "GET", "/", { headers });
    const created = createTask(dir);
    const listed = await request(handle.port, "GET", "/", { headers });
    const pending = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers });
    const exp = Math.floor(Date.now() / 1000) + 600;
    const link = await request(handle.port, "GET", signedPath(dir, created.task, exp));
    const approved = await request(handle.port, "POST", `/tasks/${created.task.id}/approve`, {
      headers: { cookie, origin: handle.origin, "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf: field(pending.body, "csrf"), presented_hash: field(pending.body, "presented_hash") }),
    });
    expect(approved.status).toBe(303);
    const decidedDetail = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers });
    const decidedLink = await request(handle.port, "GET", signedPath(dir, created.task, exp));
    const second = createTask(dir, "second-intent", "second-body");
    const secondExp = Math.floor(Date.now() / 1000) + 600;
    const secondLink = await request(handle.port, "GET", signedPath(dir, second.task, secondExp));
    const result = await request(handle.port, "POST", `/t/${second.task.id}`, {
      headers: { origin: handle.origin, "content-type": "application/x-www-form-urlencoded" },
      body: form({
        sig: field(secondLink.body, "sig"),
        exp: field(secondLink.body, "exp"),
        nonce: field(secondLink.body, "nonce"),
        presented_hash: field(secondLink.body, "presented_hash"),
        decision: "approve",
      }),
    });
    expect(result.status).toBe(200);
    const third = createTask(dir, "third-intent", "third-body");
    const thirdDetail = await request(handle.port, "GET", `/tasks/${third.task.id}`, { headers });
    const error = await request(handle.port, "POST", `/tasks/${third.task.id}/reject`, {
      headers: { cookie, origin: handle.origin, "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf: field(thirdDetail.body, "csrf"), presented_hash: field(thirdDetail.body, "presented_hash") }),
    });
    expect(error.status).toBe(400);
    const loggedOut = await request(handle.port, "GET", "/login-ended");
    const chat = fs.readFileSync(path.join(root, "examples/chat-approval/chat.html"), "utf8");
    for (const body of [
      empty.body,
      listed.body,
      pending.body,
      decidedDetail.body,
      link.body,
      decidedLink.body,
      result.body,
      error.body,
      loggedOut.body,
    ]) {
      expectSelfContained(body, true);
    }
    expectSelfContained(chat, false);
  });

  it("keeps the console CSP exact on HTML and the script", async () => {
    const { dir, handle } = await boot(openPolicy);
    const created = createTask(dir);
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const headers = { cookie };
    const list = await request(handle.port, "GET", "/", { headers });
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers });
    const missing = await request(handle.port, "POST", `/tasks/${created.task.id}/reject`, {
      headers: { cookie, origin: handle.origin, "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf: field(detail.body, "csrf"), presented_hash: field(detail.body, "presented_hash") }),
    });
    const ended = await request(handle.port, "GET", "/login-ended");
    const script = await request(handle.port, "GET", "/assets/console.js", { headers });
    for (const response of [list, detail, missing, ended, script]) {
      expect(response.headers["content-security-policy"]).toBe(CONSOLE_CSP);
    }
  });

  it("loads console.js on the detail page and not on a link page", async () => {
    const { dir, handle } = await boot(openPolicy);
    const created = createTask(dir);
    const session = await login(handle);
    const headers = { cookie: `actledger_session=${session}` };
    const list = await request(handle.port, "GET", "/", { headers });
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers });
    const link = await request(handle.port, "GET", signedPath(dir, created.task, Math.floor(Date.now() / 1000) + 600));
    expect(detail.body).toContain('<script src="/assets/console.js"></script>');
    expect(detail.body).toContain('data-page="detail"');
    expect(detail.body).toContain('id="i18n"');
    expect(detail.body).toContain('data-copied="Copied"');
    expect(list.body).toContain('data-page="list"');
    expect(link.body).not.toContain("/assets/console.js");
  });

  it("counts the visible rows and toggles the empty state", async () => {
    const { dir, handle } = await boot(openPolicy);
    const session = await login(handle);
    const headers = { cookie: `actledger_session=${session}` };
    const empty = await request(handle.port, "GET", "/", { headers });
    expect(empty.body).toContain('data-count-for="pending">0<');
    expect(empty.body).toMatch(/<div class="empty" id="empty-state">/);
    expect(empty.body).toMatch(/<table class="tasks" id="task-table" hidden>/);
    createTask(dir);
    createTask(dir, "later-intent", "later-body");
    const filled = await request(handle.port, "GET", "/", { headers });
    expect(filled.body).toContain('data-count-for="pending">2<');
    expect(filled.body).not.toMatch(/<table class="tasks" id="task-table" hidden>/);
    expect(filled.body).toMatch(/<div class="empty" id="empty-state" hidden>/);
  });

  it("shares the design tokens with the chat page", () => {
    const chat = fs.readFileSync(path.join(root, "examples/chat-approval/chat.html"), "utf8");
    const start = chat.indexOf("/* actledger-tokens:start */");
    const end = chat.indexOf("/* actledger-tokens:end */");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(chat.slice(start, end + "/* actledger-tokens:end */".length)).toBe(TOKENS_CSS.trim());
  });

  it("covers every task state and keeps console.js free of markup strings", async () => {
    const { handle } = await boot(openPolicy);
    const session = await login(handle);
    const list = await request(handle.port, "GET", "/", { headers: { cookie: `actledger_session=${session}` } });
    expect(list.body).toContain(TOKENS_CSS);
    expect(STATES.every((state) => state in STATUS_TONE)).toBe(true);
    expect(Object.keys(STATUS_TONE)).toHaveLength(STATES.length);
    expect(CONSOLE_JS).toContain(JSON.stringify(STATUS_TONE));
    for (const forbidden of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "eval(",
      "new Function",
      "Session ended",
      "Update failed",
      "No tasks",
      "已超时",
    ]) {
      expect(CONSOLE_JS).not.toContain(forbidden);
    }
    expect(CONSOLE_JS).toContain("setInterval(tick, 3000)");
    expect(CONSOLE_JS).toContain("/api/tasks?state=");
    expect(CONSOLE_JS).toContain("replaceChildren");
    expect(CONSOLE_JS).toContain("data-count-for");
  });

  it("translates the timeline and still keeps the English wording", async () => {
    const { dir, handle } = await boot(openPolicy);
    const created = createTask(dir);
    const session = await login(handle);
    const cookie = `actledger_session=${session}`;
    const detail = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers: { cookie } });
    const approved = await request(handle.port, "POST", `/tasks/${created.task.id}/approve`, {
      headers: { cookie, origin: handle.origin, "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf: field(detail.body, "csrf"), presented_hash: field(detail.body, "presented_hash") }),
    });
    expect(approved.status).toBe(303);
    const zh = await request(handle.port, "GET", `/tasks/${created.task.id}`, {
      headers: { cookie, "accept-language": "zh-CN" },
    });
    expect(zh.body).toContain("时间线");
    expect(zh.body).toContain("已请求");
    expect(zh.body).toContain("等待审批");
    expect(zh.body).toContain("审批人 u_1 · 渠道 web · 确认级别 app_asserted");
    expect(zh.body).toContain("决定");
    const en = await request(handle.port, "GET", `/tasks/${created.task.id}`, { headers: { cookie } });
    expect(en.body).toContain("Timeline");
    expect(en.body).toContain("requested");
    expect(en.body).toContain("pending approval");
    expect(en.body).toContain("approved");
    expect(en.body).toContain("channel web");
    expect(en.body).toContain("assurance app_asserted");
    expect(en.body).toContain("by u_1");
    expect(en.body).toContain("Decision");
  });
});
