import http from "node:http";
import path from "node:path";
import { effectiveChannels, formatTimestamp, LedgerError, openLedger, type TaskView } from "@actledger/core";
import {
  allowedHosts,
  allowedOrigins,
  clearSessionCookie,
  hostAllowed,
  parseCookies,
  sessionCookie,
  SessionStore,
  type LoginSource,
} from "./auth.js";
import { isLoopbackUrl, loadChannelsConfig } from "./channels.js";
import { CONSOLE_JS } from "./console-js.js";
import {
  renderDetail,
  renderError,
  renderLink,
  renderLinkStatus,
  renderList,
  renderLoginEnded,
  renderResult,
  type LinkPage,
  type TaskPage,
} from "./html.js";
import { pickLocale, type Locale } from "./i18n.js";
import { LinkNonces, loadOrCreateLinkKey, UsedLinks, verifyLink } from "./links.js";
import { defaultHttpPost, Notifier, type HttpPost } from "./notifier.js";
import {
  defaultTokenFile,
  FileLoginSource,
  loadOrCreateLoginToken,
  loginUrl,
  MemoryLoginSource,
  rotateLoginToken,
} from "./token.js";
import {
  detailPage as buildDetailPage,
  listRow,
  shownIntent,
  shownPayload,
  tabCounts,
  tabTasks,
  taskJson,
  taskTab,
} from "./views.js";
import {
  HttpFail,
  TASK_ID,
  assertBrowser,
  assertCsrf,
  readForm,
  redirect,
  requiredNote,
  send,
  sendHtml,
  sendJson,
  sendText,
} from "./web.js";

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
  loginMode?: "persistent" | "one-time";
  tokenFile?: string;
  rotateToken?: boolean;
}

export interface ServeHandle {
  port: number;
  origin: string;
  loginUrl: string;
  loginMode: "persistent" | "one-time";
  tokenFile: string | null;
  tokenGeneration: number | null;
  publicUrl: string;
  notifier: Notifier;
  close(): Promise<void>;
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
    const loginMode = opts.loginMode ?? "persistent";
    if (loginMode === "one-time" && opts.rotateToken) {
      throw new LedgerError("invalid_request", "--rotate-token cannot be combined with --one-time-login", 400);
    }
    let source: LoginSource;
    let tokenFile: string | null = null;
    let tokenGeneration: number | null = null;
    if (loginMode === "one-time") {
      source = new MemoryLoginSource();
    } else {
      const file = opts.tokenFile ? path.resolve(opts.tokenFile) : defaultTokenFile(dir);
      const record = opts.rotateToken
        ? rotateLoginToken(file, { now, log })
        : loadOrCreateLoginToken(file, { now, log });
      source = new FileLoginSource(file, record, log);
      tokenFile = file;
      tokenGeneration = record.generation;
    }
    const config = loadChannelsConfig(dir, { env });
    const linkKey = loadOrCreateLinkKey(dir);
    const used = UsedLinks.open(path.join(dir, "link-used.jsonl"), Math.floor(now().getTime() / 1000));
    const sessions = new SessionStore(now, source);
    const nonces = new LinkNonces();
    let hosts = new Set<string>();
    let origins = new Set<string>();
    let origin = "";
    let publicUrl = "";
    let boundPort = opts.port ?? 4319;

    server = http.createServer((req, res) => {
      const ctx: { locale: Locale } = { locale: "en" };
      void route(req, res, ctx).catch((error: unknown) => {
        if (res.headersSent) return;
        if (error instanceof LedgerError) {
          sendHtml(res, error.status, renderError(ctx.locale, error.code, error.message));
          return;
        }
        if (error instanceof HttpFail) {
          sendFail(res, error, ctx.locale);
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

    async function route(req: http.IncomingMessage, res: http.ServerResponse, ctx: { locale: Locale }): Promise<void> {
      if (!hostAllowed(req.headers.host, hosts)) {
        throw new HttpFail(421, "misdirected_request", "misdirected request", true);
      }
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
      const picked = pickLocale(req.headers, method === "GET" ? url : null);
      ctx.locale = picked.locale;
      const locale = picked.locale;
      if (picked.setCookie) res.setHeader("Set-Cookie", picked.setCookie);
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
        sendHtml(res, 200, renderLoginEnded(locale));
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
          linkGet(url, id, res, locale);
          return;
        }
        if (method === "POST") {
          await linkPost(req, id, res, locale);
          return;
        }
        if (!session) throw new HttpFail(401, "unauthorized", "unauthorized", true);
        throw new HttpFail(405, "method_not_allowed", "method not allowed", true);
      }

      if (
        pathname === "/" ||
        pathname === "/logout" ||
        pathname === "/api/tasks" ||
        pathname === "/assets/console.js" ||
        taskMatch ||
        actionMatch
      ) {
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
          const tab = taskTab(url.searchParams.get("tab"));
          if (!tab) throw new HttpFail(400, "invalid_request", "tab must be pending, recent or all");
          sendHtml(
            res,
            200,
            renderList(locale, {
              tab,
              rows: tabTasks(engine.listTasks(), tab).map((task) => listRow(engine, task, now())),
              csrf: session.csrf,
              counts: tabCounts(engine.listTasks()),
              now: formatTimestamp(now()),
            }),
          );
          return;
        }
        if (pathname === "/api/tasks" && method === "GET") {
          const state = taskTab(url.searchParams.get("state"));
          if (!state) {
            sendJson(res, 400, { error: "invalid_request", message: "state must be pending, recent or all" });
            return;
          }
          sendJson(res, 200, {
            tab: state,
            now: formatTimestamp(now()),
            tasks: tabTasks(engine.listTasks(), state).map((task) => taskJson(engine, task, now())),
          });
          return;
        }
        if (pathname === "/api/tasks") throw new HttpFail(405, "method_not_allowed", "method not allowed", true);
        if (pathname === "/assets/console.js" && method === "GET") {
          send(res, 200, CONSOLE_JS, "text/javascript; charset=utf-8");
          return;
        }
        if (pathname === "/assets/console.js") {
          throw new HttpFail(405, "method_not_allowed", "method not allowed", true);
        }
        if (pathname === "/logout" && method === "POST") {
          await logout(req, session.csrf, sessionId, res);
          return;
        }
        if (taskMatch && method === "GET") {
          sendHtml(res, 200, renderDetail(locale, detailPage(taskMatch[1] ?? "", session.csrf, locale), formatTimestamp(now())));
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

    function detailPage(id: string, csrf: string, locale: Locale): TaskPage {
      const task = engine.getTask(id);
      if (!task) throw new HttpFail(404, "not_found", "task not found");
      return buildDetailPage(engine, task, { csrf, locale, at: now(), approver: opts.approver });
    }

    function linkGet(url: URL, id: string, res: http.ServerResponse, locale: Locale): void {
      const task = engine.getTask(id);
      if (!task) {
        sendHtml(res, 404, renderLinkStatus(locale, id, null));
        return;
      }
      const sig = url.searchParams.get("sig") ?? "";
      const exp = parseExp(url.searchParams.get("exp") ?? undefined);
      assertLink(task, sig, exp);
      if (task.state !== "pending_approval") {
        sendHtml(res, 200, renderLinkStatus(locale, task.id, task.state));
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
      sendHtml(res, 200, renderLink(locale, page));
    }

    async function linkPost(req: http.IncomingMessage, id: string, res: http.ServerResponse, locale: Locale): Promise<void> {
      const form = await readForm(req);
      const task = engine.getTask(id);
      if (!task) throw new HttpFail(404, "not_found", "task not found");
      const sig = form.get("sig") ?? "";
      const exp = parseExp(form.get("exp"));
      assertLink(task, sig, exp);
      assertBrowser(req, origins);
      const presented = form.get("presented_hash") ?? "";
      if (!presented) throw new HttpFail(400, "invalid_request", "missing presented_hash");
      const decision = form.get("decision");
      if (decision !== "approve" && decision !== "reject") {
        throw new HttpFail(400, "invalid_request", "decision must be approve or reject");
      }
      const note = decision === "reject" ? requiredNote(form) : undefined;
      if (!nonces.take(form.get("nonce") ?? "", task.id, sig, now().getTime())) {
        throw new HttpFail(403, "nonce_failed", "nonce failed");
      }
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
        sendHtml(res, 200, renderResult(locale, result.task.id, result.task.state, result.receipt.hash));
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
      sendHtml(res, 200, renderResult(locale, result.task.id, result.task.state, result.receipt.hash));
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
      const note = action === "reject" ? requiredNote(form) : undefined;
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
          note,
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
      loginUrl: loginUrl(origin, source.current().token),
      loginMode,
      tokenFile,
      tokenGeneration,
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


function parseExp(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const exp = Number(value);
  if (!Number.isSafeInteger(exp)) return null;
  return exp;
}


function sendFail(res: http.ServerResponse, error: HttpFail, locale: Locale): void {
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
  sendHtml(res, error.status, renderError(locale, error.code, error.message));
}

