import http from "node:http";
import path from "node:path";
import {
  assuranceRank,
  effectiveChannels,
  formatTimestamp,
  LedgerError,
  openLedger,
  type LedgerEngine,
  type TaskView,
} from "@actledger/core";
import {
  allowedHosts,
  allowedOrigins,
  clearSessionCookie,
  fetchSiteAllowed,
  hostAllowed,
  originAllowed,
  parseCookies,
  safeEqual,
  sessionCookie,
  SessionStore,
} from "./auth.js";
import { isLoopbackUrl, loadChannelsConfig } from "./channels.js";
import {
  renderDetail,
  renderError,
  renderLink,
  renderLinkStatus,
  renderList,
  renderResult,
  type LinkPage,
  type TaskPage,
} from "./html.js";
import { LinkNonces, loadOrCreateLinkKey, UsedLinks, verifyLink } from "./links.js";
import { defaultHttpPost, Notifier, type HttpPost } from "./notifier.js";

const TASK_ID = /^tsk_[0-9A-Za-z_]{1,64}$/;
const BODY_LIMIT = 16 * 1024;

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export interface ServeOptions {
  dir: string;
  port?: number;
  approver?: string;
  now?: () => Date;
  pollMs?: number;
  httpPost?: HttpPost;
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface ServeHandle {
  port: number;
  origin: string;
  loginUrl: string;
  publicUrl: string;
  notifier: Notifier;
  close(): Promise<void>;
}

class HttpFail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly plain = false,
  ) {
    super(message);
  }
}

export async function startServer(opts: ServeOptions): Promise<ServeHandle> {
  const dir = path.resolve(opts.dir);
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const engine = openLedger({ dir, now });
  let server: http.Server | undefined;
  let notifier: Notifier | undefined;
  try {
    const config = loadChannelsConfig(dir, { env });
    const linkKey = loadOrCreateLinkKey(dir);
    const used = UsedLinks.open(path.join(dir, "link-used.jsonl"), Math.floor(now().getTime() / 1000));
    const sessions = new SessionStore(now);
    const nonces = new LinkNonces();
    let hosts = new Set<string>();
    let origins = new Set<string>();
    let origin = "";
    let publicUrl = "";
    let boundPort = opts.port ?? 4319;

    server = http.createServer((req, res) => {
      void route(req, res).catch((error: unknown) => {
        if (res.headersSent) return;
        if (error instanceof LedgerError) {
          sendHtml(res, error.status, renderError(error.code, error.message));
          return;
        }
        if (error instanceof HttpFail) {
          sendFail(res, error);
          return;
        }
        log(`internal error: ${error instanceof Error ? (error.stack ?? error.message) : "unknown"}`);
        sendText(res, 500, "internal error");
      });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1_000;
    server.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          reject(new LedgerError("invalid_request", `port ${opts.port ?? 4319} is in use`, 400));
          return;
        }
        reject(error);
      };
      server!.once("error", onError);
      server!.listen(opts.port ?? 4319, "127.0.0.1", () => {
        server!.off("error", onError);
        const address = server!.address();
        if (!address || typeof address === "string") {
          reject(new Error("server did not bind a tcp port"));
          return;
        }
        boundPort = address.port;
        origin = `http://127.0.0.1:${boundPort}`;
        publicUrl = config.publicUrl ?? origin;
        hosts = allowedHosts(boundPort, publicUrl);
        origins = allowedOrigins(boundPort, publicUrl);
        resolve();
      });
    });

    notifier = new Notifier({
      dir,
      engine,
      config,
      publicUrl,
      linkKey,
      now,
      env,
      httpPost: opts.httpPost ?? defaultHttpPost,
      retryBaseMs: opts.retryBaseMs ?? 1000,
      sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      log,
    });
    notifier.start(opts.pollMs ?? 1000);
    log(`channels: ${config.channels.length}`);
    for (const skipped of config.skipped) {
      log(`skipped channel ${skipped.name}: missing ${skipped.secretEnv}`);
    }
    if (config.publicUrl && !isLoopbackUrl(config.publicUrl)) {
      log(`warning: public_url ${config.publicUrl} is not a loopback address; serve still binds 127.0.0.1`);
    }

    const liveNotifier = notifier;
    const liveServer = server;
    let closing: Promise<void> | null = null;
    const close = (): Promise<void> => {
      if (!closing) {
        closing = (async () => {
          await liveNotifier.stop();
          liveServer.closeAllConnections();
          await new Promise<void>((resolve) => liveServer.close(() => resolve()));
          engine.close();
        })();
      }
      return closing;
    };

    async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      if (!hostAllowed(req.headers.host, hosts)) {
        throw new HttpFail(421, "misdirected_request", "misdirected request", true);
      }
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
      const pathname = url.pathname;
      const sessionId = parseCookies(req.headers.cookie).get("actledger_session");
      const session = sessions.get(sessionId);

      if (pathname === "/login" && method === "GET") {
        const created = sessions.login(url.searchParams.get("token") ?? "");
        if (!created) throw new HttpFail(401, "unauthorized", "unauthorized", true);
        redirect(res, "/", sessionCookie(created.id));
        return;
      }
      if (pathname === "/login-ended" && method === "GET") {
        sendText(res, 200, "login ended");
        return;
      }

      const linkMatch = pathname.match(/^\/t\/([^/]+)$/);
      const actionMatch = pathname.match(/^\/tasks\/([^/]+)\/(approve|reject)$/);
      const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);

      if (linkMatch) {
        const id = linkMatch[1] ?? "";
        if (!TASK_ID.test(id)) {
          if (method === "POST") req.resume();
          if (!session) throw new HttpFail(401, "unauthorized", "unauthorized", true);
          throw new HttpFail(404, "not_found", "not found", true);
        }
        if (method === "GET") {
          linkGet(url, id, res);
          return;
        }
        if (method === "POST") {
          await linkPost(req, id, res);
          return;
        }
        if (!session) throw new HttpFail(401, "unauthorized", "unauthorized", true);
        throw new HttpFail(405, "method_not_allowed", "method not allowed", true);
      }

      if (pathname === "/" || pathname === "/logout" || taskMatch || actionMatch) {
        const id = actionMatch?.[1] ?? taskMatch?.[1];
        if (id !== undefined && !TASK_ID.test(id)) {
          if (method === "POST") req.resume();
          if (!session) throw new HttpFail(401, "unauthorized", "unauthorized", true);
          throw new HttpFail(404, "not_found", "not found", true);
        }
        if (!session) {
          if (method === "POST") req.resume();
          throw new HttpFail(401, "unauthorized", "unauthorized", true);
        }
        if (pathname === "/" && method === "GET") {
          sendHtml(res, 200, renderList(listRows(), session.csrf));
          return;
        }
        if (pathname === "/logout" && method === "POST") {
          await logout(req, session.csrf, sessionId, res);
          return;
        }
        if (taskMatch && method === "GET") {
          sendHtml(res, 200, renderDetail(detailPage(taskMatch[1] ?? "", session.csrf)));
          return;
        }
        if (actionMatch && method === "POST") {
          await decide(req, actionMatch[1] ?? "", actionMatch[2] === "reject" ? "reject" : "approve", session.csrf, res);
          return;
        }
        throw new HttpFail(405, "method_not_allowed", "method not allowed", true);
      }

      if (pathname === "/login" || pathname === "/login-ended") {
        if (!session) throw new HttpFail(401, "unauthorized", "unauthorized", true);
        throw new HttpFail(405, "method_not_allowed", "method not allowed", true);
      }
      if (method === "POST") req.resume();
      if (!session) throw new HttpFail(401, "unauthorized", "unauthorized", true);
      throw new HttpFail(404, "not_found", "not found", true);
    }

    function listRows() {
      return engine.listTasks({ state: "pending_approval" }).map((task) => ({
        id: task.id,
        type: task.action.type,
        level: task.action.level ?? "",
        principalId: task.principalId,
        createdAt: task.createdAt,
        expiresAt: expiresLabel(task.expiresAt, now()),
        intent: clip(shownIntent(engine, task.id, "(unavailable)"), 120),
      }));
    }

    function detailPage(id: string, csrf: string): TaskPage {
      const task = engine.getTask(id);
      if (!task) throw new HttpFail(404, "not_found", "task not found");
      const gate = approvalGate(task, opts.approver);
      return {
        id: task.id,
        state: task.state,
        principalId: task.principalId,
        agentId: task.agentId ?? "",
        createdAt: task.createdAt,
        expiresAt: expiresLabel(task.expiresAt, now()),
        action: JSON.stringify(task.action, null, 2),
        intent: shownIntent(engine, task.id, "(unavailable: shredded)"),
        payload: shownPayload(engine, task.id),
        ruleId: task.decision.ruleId,
        result: task.decision.result,
        minAssurance: task.decision.minAssurance ?? "",
        stepUp: task.decision.stepUp ?? "",
        channels: effectiveChannels(task.decision).join(", "),
        payloadHash: task.payloadHash,
        pending: task.state === "pending_approval",
        hints: gate.hints,
        approveDisabled: gate.approveDisabled,
        rejectDisabled: gate.rejectDisabled,
        csrf,
      };
    }

    function linkGet(url: URL, id: string, res: http.ServerResponse): void {
      const task = engine.getTask(id);
      if (!task) {
        sendHtml(res, 404, renderLinkStatus(id, null));
        return;
      }
      const sig = url.searchParams.get("sig") ?? "";
      const exp = parseExp(url.searchParams.get("exp") ?? undefined);
      assertLink(task, sig, exp);
      if (task.state !== "pending_approval") {
        sendHtml(res, 200, renderLinkStatus(task.id, task.state));
        return;
      }
      const nonce = nonces.issue(task.id, sig, now().getTime());
      const page: LinkPage = {
        id: task.id,
        state: task.state,
        action: JSON.stringify(task.action, null, 2),
        intent: shownIntent(engine, task.id, "(unavailable: shredded)"),
        payload: shownPayload(engine, task.id),
        ruleId: task.decision.ruleId,
        result: task.decision.result,
        minAssurance: task.decision.minAssurance ?? "",
        stepUp: task.decision.stepUp ?? "",
        channels: effectiveChannels(task.decision).join(", "),
        payloadHash: task.payloadHash,
        sig,
        exp: String(exp),
        nonce,
      };
      sendHtml(res, 200, renderLink(page));
    }

    async function linkPost(req: http.IncomingMessage, id: string, res: http.ServerResponse): Promise<void> {
      const form = await readForm(req);
      const task = engine.getTask(id);
      if (!task) throw new HttpFail(404, "not_found", "task not found");
      const sig = form.get("sig") ?? "";
      const exp = parseExp(form.get("exp"));
      assertLink(task, sig, exp);
      assertBrowser(req, origins);
      if (!nonces.take(form.get("nonce") ?? "", task.id, sig, now().getTime())) {
        throw new HttpFail(403, "nonce_failed", "nonce failed");
      }
      const presented = form.get("presented_hash") ?? "";
      if (!presented) throw new HttpFail(400, "invalid_request", "missing presented_hash");
      const decision = form.get("decision");
      if (decision !== "approve" && decision !== "reject") {
        throw new HttpFail(400, "invalid_request", "decision must be approve or reject");
      }
      const note = decision === "reject" ? optionalNote(form) : undefined;
      if (!used.consume(sig, task.id, exp as number, formatTimestamp(now()))) {
        throw new HttpFail(410, "link_used", "this link has already been used");
      }
      if (decision === "approve") {
        const result = engine.approve(id, {
          approverPrincipalId: task.principalId,
          channel: "webhook_link",
          assurance: "app_asserted",
          presentedHash: presented,
          editedPayload: null,
          stepUp: false,
          simulated: false,
        });
        sendHtml(res, 200, renderResult(result.task.id, result.task.state, result.receipt.hash));
        return;
      }
      const result = engine.reject(id, {
        approverPrincipalId: task.principalId,
        channel: "webhook_link",
        assurance: "app_asserted",
        presentedHash: presented,
        note,
        simulated: false,
      });
      sendHtml(res, 200, renderResult(result.task.id, result.task.state, result.receipt.hash));
    }

    function assertLink(task: TaskView, sig: string, exp: number | null): asserts exp is number {
      const verdict =
        exp === null
          ? "bad_signature"
          : verifyLink(
              linkKey,
              { appId: task.appId, taskId: task.id, payloadHash: task.payloadHash, exp },
              sig,
              Math.floor(now().getTime() / 1000),
            );
      if (verdict === "bad_signature") throw new HttpFail(403, "bad_signature", "bad signature");
      if (verdict === "expired") throw new HttpFail(410, "link_expired", "this link has expired");
      if (used.has(sig)) throw new HttpFail(410, "link_used", "this link has already been used");
    }

    async function decide(
      req: http.IncomingMessage,
      id: string,
      action: "approve" | "reject",
      csrf: string,
      res: http.ServerResponse,
    ): Promise<void> {
      const form = await readForm(req);
      assertBrowser(req, origins);
      assertCsrf(form, csrf);
      const presented = form.get("presented_hash") ?? "";
      if (!presented) throw new HttpFail(400, "invalid_request", "missing presented_hash");
      const task = engine.getTask(id);
      if (!task) throw new LedgerError("not_found", `task ${id} not found`, 404);
      const approver = opts.approver ?? task.principalId;
      if (action === "approve") {
        engine.approve(id, {
          approverPrincipalId: approver,
          channel: "web",
          assurance: "app_asserted",
          presentedHash: presented,
          editedPayload: null,
          stepUp: false,
          simulated: false,
        });
      } else {
        engine.reject(id, {
          approverPrincipalId: approver,
          channel: "web",
          assurance: "app_asserted",
          presentedHash: presented,
          note: optionalNote(form),
          simulated: false,
        });
      }
      redirect(res, `/tasks/${id}`);
    }

    async function logout(
      req: http.IncomingMessage,
      csrf: string,
      id: string | undefined,
      res: http.ServerResponse,
    ): Promise<void> {
      const form = await readForm(req);
      assertBrowser(req, origins);
      assertCsrf(form, csrf);
      sessions.destroy(id);
      redirect(res, "/login-ended", clearSessionCookie());
    }

    return {
      port: boundPort,
      origin,
      loginUrl: `${origin}/login?token=${sessions.loginToken}`,
      publicUrl,
      notifier: liveNotifier,
      close,
    };
  } catch (error) {
    if (notifier) await notifier.stop().catch(() => undefined);
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    engine.close();
    throw error;
  }
}

function approvalGate(
  task: TaskView,
  approver?: string,
): { hints: string[]; approveDisabled: boolean; rejectDisabled: boolean } {
  const hints: string[] = [];
  let approveDisabled = false;
  let rejectDisabled = false;
  if (!effectiveChannels(task.decision).includes("web")) {
    hints.push("策略不允许网页审批，请用 `actledger approve`");
    approveDisabled = true;
    rejectDisabled = true;
  }
  if (task.decision.minAssurance && assuranceRank(task.decision.minAssurance) > assuranceRank("app_asserted")) {
    hints.push(`需要 ${task.decision.minAssurance}，网页只能给 \`app_asserted\`；可以拒绝，批准请用 CLI`);
    approveDisabled = true;
  }
  if (task.decision.stepUp) {
    hints.push("需要 step-up，网页不支持");
    approveDisabled = true;
  }
  if (approver && approver !== task.principalId) {
    hints.push("审批人不匹配");
    approveDisabled = true;
    rejectDisabled = true;
  }
  return { hints, approveDisabled, rejectDisabled };
}

function shownIntent(engine: LedgerEngine, id: string, fallback: string): string {
  try {
    return engine.taskIntent(id) ?? "";
  } catch {
    return fallback;
  }
}

function shownPayload(engine: LedgerEngine, id: string): string {
  try {
    return JSON.stringify(engine.taskPayload(id), null, 2);
  } catch {
    return "(unavailable)";
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function expiresLabel(expiresAt: string | null, now: Date): string {
  if (!expiresAt) return "";
  if (now.getTime() > new Date(expiresAt).getTime()) return `${expiresAt} 已超时`;
  return expiresAt;
}

function assertBrowser(req: http.IncomingMessage, origins: Set<string>): void {
  if (!originAllowed(req.headers.origin, origins)) throw new HttpFail(403, "origin_rejected", "origin rejected");
  if (!fetchSiteAllowed(req.headers["sec-fetch-site"])) {
    throw new HttpFail(403, "fetch_site_rejected", "cross-site request rejected");
  }
}

function assertCsrf(form: Map<string, string>, csrf: string): void {
  if (!safeEqual(csrf, form.get("csrf") ?? "")) throw new HttpFail(403, "csrf_failed", "csrf failed");
}

function optionalNote(form: Map<string, string>): string | undefined {
  const raw = form.get("reason");
  if (raw === undefined) return undefined;
  const note = raw.trim();
  if (!note) return undefined;
  if (note.length > 2000) throw new HttpFail(400, "invalid_request", "reason is longer than 2000 characters");
  return note;
}

function parseExp(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const exp = Number(value);
  if (!Number.isSafeInteger(exp)) return null;
  return exp;
}

async function readForm(req: http.IncomingMessage): Promise<Map<string, string>> {
  if (mediaType(req.headers["content-type"]) !== "application/x-www-form-urlencoded") {
    req.resume();
    throw new HttpFail(415, "unsupported_media_type", "unsupported media type", true);
  }
  const body = await readBody(req);
  const params = new URLSearchParams(body);
  const form = new Map<string, string>();
  for (const [key, value] of params) {
    if (!form.has(key)) form.set(key, value);
  }
  return form;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const declared = req.headers["content-length"];
  if (typeof declared === "string" && Number(declared) > BODY_LIMIT) {
    req.resume();
    throw new HttpFail(413, "payload_too_large", "payload too large", true);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new HttpFail(413, "payload_too_large", "payload too large", true);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function mediaType(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  return (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function sendFail(res: http.ServerResponse, error: HttpFail): void {
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
  sendHtml(res, error.status, renderError(error.code, error.message));
}

function redirect(res: http.ServerResponse, location: string, setCookie?: string): void {
  send(res, 303, "", "text/plain; charset=utf-8", {
    Location: location,
    ...(setCookie ? { "Set-Cookie": setCookie } : {}),
  });
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  send(res, status, body, "text/plain; charset=utf-8");
}

function sendHtml(res: http.ServerResponse, status: number, body: string): void {
  send(res, status, body, "text/html; charset=utf-8");
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string,
  type: string,
  extra?: Record<string, string>,
): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(body);
}
