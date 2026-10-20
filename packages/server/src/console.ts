import type http from "node:http";
import { formatTimestamp, LedgerError, type LedgerEngine } from "@actledger/core";
import {
  CONSOLE_JS,
  HttpFail,
  TASK_ID,
  assertBrowser,
  assertCsrf,
  clearSessionCookie,
  detailPage,
  hostAllowed,
  listRow,
  parseCookies,
  pickLocale,
  readForm,
  redirect,
  renderDetail,
  renderError,
  renderList,
  renderLogin,
  renderLoginEnded,
  requiredNote,
  send,
  sendHtml,
  sendJson,
  sendText,
  sessionCookie,
  tabCounts,
  tabTasks,
  taskJson,
  taskTab,
  type Locale,
} from "@actledger/cli/console";
import { DUMMY_HASH, verifyPassword } from "./password.js";
import type { LoginLimiter } from "./limiter.js";
import type { RequestInfo } from "./request.js";
import type { RemoteSessions } from "./sessions.js";
import { matchTotp } from "./totp.js";
import type { CredentialStore } from "./store.js";

export interface ConsoleContext {
  engine: LedgerEngine;
  store: CredentialStore;
  sessions: RemoteSessions;
  limiter: LoginLimiter;
  hosts: Set<string>;
  origins: Set<string>;
  now: () => Date;
  info: RequestInfo;
  localeBox: { locale: Locale };
}

export async function handleConsole(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ConsoleContext,
): Promise<void> {
  if (!hostAllowed(ctx.info.host, ctx.hosts)) {
    sendText(res, 421, "misdirected request");
    return;
  }
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const picked = pickLocale(req.headers, method === "GET" ? url : null);
  ctx.localeBox.locale = picked.locale;
  if (picked.setCookie) res.setHeader("Set-Cookie", picked.setCookie);
  const locale = picked.locale;
  const sessionId = parseCookies(req.headers.cookie).get("actledger_session");
  const session = ctx.sessions.get(sessionId);
  const secure = ctx.info.https;
  const pathname = url.pathname;

  if (pathname === "/login" && method === "GET") {
    if (session) {
      redirect(res, "/");
      return;
    }
    sendHtml(res, 200, renderLogin(locale, { error: null, username: "" }));
    return;
  }
  if (pathname === "/login" && method === "POST") {
    await login(req, res, ctx, locale);
    return;
  }
  if (pathname === "/login-ended" && method === "GET") {
    sendHtml(res, 200, renderLoginEnded(locale, "remote"));
    return;
  }

  const actionMatch = pathname.match(/^\/tasks\/([^/]+)\/(approve|reject)$/);
  const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);

  if (pathname === "/logout" && method === "POST") {
    if (!session) throw new HttpFail(401, "unauthorized", "unauthorized", true);
    const form = await readForm(req);
    assertBrowser(req, ctx.origins);
    assertCsrf(form, session.csrf);
    ctx.sessions.destroy(sessionId);
    redirect(res, "/login-ended", clearSessionCookie({ secure }));
    return;
  }
  if (pathname === "/" && method === "GET") {
    if (!session) {
      redirect(res, "/login");
      return;
    }
    const tasks = mine(ctx.engine, session.principalId);
    const tab = taskTab(url.searchParams.get("tab"));
    if (!tab) throw new HttpFail(400, "invalid_request", "tab must be pending, recent or all");
    const at = ctx.now();
    sendHtml(
      res,
      200,
      renderList(locale, {
        tab,
        rows: tabTasks(tasks, tab).map((task) => listRow(ctx.engine, task, at)),
        csrf: session.csrf,
        counts: tabCounts(tasks),
        now: formatTimestamp(at),
        variant: "remote",
      }),
    );
    return;
  }
  if (pathname === "/api/tasks" && method === "GET") {
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const state = taskTab(url.searchParams.get("state"));
    if (!state) {
      sendJson(res, 400, { error: "invalid_request", message: "state must be pending, recent or all" });
      return;
    }
    const tasks = mine(ctx.engine, session.principalId);
    const at = ctx.now();
    sendJson(res, 200, {
      tab: state,
      now: formatTimestamp(at),
      tasks: tabTasks(tasks, state).map((task) => taskJson(ctx.engine, task, at)),
    });
    return;
  }
  if (pathname === "/assets/console.js" && method === "GET") {
    if (!session) {
      redirect(res, "/login");
      return;
    }
    send(res, 200, CONSOLE_JS, "text/javascript; charset=utf-8");
    return;
  }
  if (taskMatch && method === "GET") {
    const id = decodeSegment(taskMatch[1] ?? "");
    if (id === null) throw new HttpFail(404, "not_found", "not found");
    if (!session) {
      redirect(res, "/login");
      return;
    }
    if (!TASK_ID.test(id)) throw new HttpFail(404, "not_found", "not found");
    const task = ctx.engine.getTask(id);
    if (!task || task.principalId !== session.principalId) {
      throw new HttpFail(404, "not_found", `task ${id} not found`);
    }
    const at = ctx.now();
    sendHtml(
      res,
      200,
      renderDetail(
        locale,
        detailPage(ctx.engine, task, {
          csrf: session.csrf,
          locale,
          at,
          approver: session.principalId,
          variant: "remote",
        }),
        formatTimestamp(at),
        "remote",
      ),
    );
    return;
  }
  if (actionMatch && method === "POST") {
    const id = decodeSegment(actionMatch[1] ?? "");
    if (id === null) {
      req.resume();
      throw new HttpFail(404, "not_found", "not found");
    }
    if (!session) {
      req.resume();
      throw new HttpFail(401, "unauthorized", "unauthorized", true);
    }
    if (!TASK_ID.test(id)) {
      req.resume();
      throw new HttpFail(404, "not_found", "not found");
    }
    await decide(req, res, ctx, id, actionMatch[2] === "reject" ? "reject" : "approve", session.principalId, session.csrf);
    return;
  }

  const known =
    pathname === "/login" ||
    pathname === "/login-ended" ||
    pathname === "/logout" ||
    pathname === "/" ||
    pathname === "/api/tasks" ||
    pathname === "/assets/console.js" ||
    Boolean(taskMatch) ||
    Boolean(actionMatch);
  if (known) {
    if (method === "POST") req.resume();
    if (!session) throw new HttpFail(401, "unauthorized", "unauthorized", true);
    throw new HttpFail(405, "method_not_allowed", "method not allowed");
  }
  if (!session) {
    if (method === "GET") {
      redirect(res, "/login");
      return;
    }
    if (method === "POST") req.resume();
    throw new HttpFail(401, "unauthorized", "unauthorized", true);
  }
  if (method === "POST") req.resume();
  throw new HttpFail(404, "not_found", "not found");
}

async function login(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ConsoleContext,
  locale: Locale,
): Promise<void> {
  const form = await readForm(req);
  assertBrowser(req, ctx.origins);
  const username = (form.get("username") ?? "").trim().toLowerCase();
  const password = form.get("password") ?? "";
  const code = (form.get("totp") ?? "").replace(/\s/g, "");
  const retry = ctx.limiter.blocked(ctx.info.ip);
  if (retry !== null) {
    sendHtml(res, 429, renderLogin(locale, { error: "login.limited", username }), { "Retry-After": String(retry) });
    return;
  }
  // Reserve before the next await so concurrent requests cannot all pass the check.
  ctx.limiter.fail(ctx.info.ip);
  const malformed =
    username.length === 0 ||
    username.length > 64 ||
    password.length === 0 ||
    password.length > 256 ||
    code.length === 0 ||
    code.length > 7;
  if (malformed) {
    sendLoginFailed(res, locale, username);
    return;
  }
  const user = ctx.store.getUserByName(username);
  if (!user) {
    const unknownRetry = ctx.limiter.reserveUnknownUser(username);
    if (unknownRetry !== null) {
      sendHtml(res, 429, renderLogin(locale, { error: "login.limited", username }), {
        "Retry-After": String(unknownRetry),
      });
      return;
    }
    await verifyPassword(password, await DUMMY_HASH);
    sendLoginFailed(res, locale, username);
    return;
  }
  const reserved = ctx.store.reserveLoginAttempt(user.id);
  if (!reserved.proceed) {
    sendHtml(res, 429, renderLogin(locale, { error: "login.limited", username }), {
      "Retry-After": String(retryAfter(reserved.lockedUntil ?? "", ctx.now())),
    });
    return;
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    sendLoginFailed(res, locale, username);
    return;
  }
  const step = matchTotp(user.totpSecret, code, ctx.now());
  if (step === null || !ctx.store.consumeTotpStep(user.id, step)) {
    sendLoginFailed(res, locale, username);
    return;
  }
  ctx.store.recordLoginSuccess(user.id);
  const created = ctx.sessions.create(ctx.store.getUser(user.id) ?? user);
  redirect(res, "/", sessionCookie(created.id, { secure: ctx.info.https }));
}

function sendLoginFailed(res: http.ServerResponse, locale: Locale, username: string): void {
  sendHtml(res, 401, renderLogin(locale, { error: "login.failed", username }));
}

function retryAfter(lockedUntil: string, now: Date): number {
  const ms = Date.parse(lockedUntil) - now.getTime();
  return Math.max(1, Math.ceil(ms / 1000));
}

async function decide(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ConsoleContext,
  id: string,
  action: "approve" | "reject",
  principalId: string,
  csrf: string,
): Promise<void> {
  const form = await readForm(req);
  assertBrowser(req, ctx.origins);
  assertCsrf(form, csrf);
  const presented = form.get("presented_hash") ?? "";
  if (!presented) throw new HttpFail(400, "invalid_request", "missing presented_hash");
  const note = action === "reject" ? requiredNote(form) : undefined;
  const task = ctx.engine.getTask(id);
  if (!task || task.principalId !== principalId) throw new HttpFail(404, "not_found", `task ${id} not found`);
  if (action === "approve") {
    ctx.engine.approve(id, {
      approverPrincipalId: principalId,
      channel: "web",
      assurance: "app_asserted",
      presentedHash: presented,
      editedPayload: null,
      stepUp: false,
      simulated: false,
    });
  } else {
    ctx.engine.reject(id, {
      approverPrincipalId: principalId,
      channel: "web",
      assurance: "app_asserted",
      presentedHash: presented,
      note,
      stepUp: false,
      simulated: false,
    });
  }
  redirect(res, `/tasks/${id}`);
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function mine(engine: LedgerEngine, principalId: string) {
  return engine.listTasks().filter((task) => task.principalId === principalId);
}

export function sendConsoleError(
  res: http.ServerResponse,
  error: unknown,
  locale: Locale,
  log: (line: string) => void,
): void {
  if (res.headersSent) return;
  if (error instanceof HttpFail) {
    if (error.status === 401) {
      sendText(res, 401, "unauthorized");
      return;
    }
    if (error.status === 421) {
      sendText(res, 421, "misdirected request");
      return;
    }
    if (error.plain) {
      sendText(res, error.status, error.message);
      return;
    }
    sendHtml(res, error.status, renderError(locale, error.code, error.message, "remote"));
    return;
  }
  if (error instanceof LedgerError) {
    sendHtml(res, error.status, renderError(locale, error.code, error.message, "remote"));
    return;
  }
  log(`internal error: ${error instanceof Error ? (error.stack ?? error.message) : "unknown"}`);
  sendText(res, 500, "internal error");
}
