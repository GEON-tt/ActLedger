import http from "node:http";
import path from "node:path";
import {
  assuranceRank,
  effectiveChannels,
  formatTimestamp,
  LedgerError,
  openLedger,
  type LedgerEngine,
  type Receipt,
  type TaskView,
} from "@actledger/core";
import {
  allowedHosts,
  allowedOrigins,
  checkBrowserPost,
  clearSessionCookie,
  hostAllowed,
  parseCookies,
  safeEqual,
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
  statusTone,
  type DecisionInfo,
  type LinkPage,
  type ListRow,
  type TaskPage,
  type TimelineRow,
} from "./html.js";
import { pickLocale, t, type Locale } from "./i18n.js";
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

const TASK_ID = /^tsk_[0-9A-Za-z_]{1,64}$/;
const BODY_LIMIT = 16 * 1024;

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

type TaskTab = "pending" | "recent" | "all";

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
              rows: tabTasks(tab).map(listRow),
              csrf: session.csrf,
              counts: tabCounts(),
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
          sendJson(res, 200, { tab: state, now: formatTimestamp(now()), tasks: tabTasks(state).map(taskJson) });
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

    function tabTasks(tab: TaskTab): TaskView[] {
      if (tab === "pending") return engine.listTasks({ state: "pending_approval" });
      if (tab === "recent") {
        return engine
          .listTasks()
          .filter((task) => task.approvalId !== null)
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
          .slice(0, 50);
      }
      return engine.listTasks().reverse().slice(0, 200);
    }

    function tabCounts(): Record<TaskTab, number> {
      const all = engine.listTasks();
      return {
        pending: all.filter((task) => task.state === "pending_approval").length,
        recent: Math.min(50, all.filter((task) => task.approvalId !== null).length),
        all: Math.min(200, all.length),
      };
    }

    function listRow(task: TaskView): ListRow {
      return {
        id: task.id,
        type: task.action.type,
        level: task.action.level ?? "",
        state: task.state,
        principalId: task.principalId,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        expiresAt: task.expiresAt ?? "",
        expired: isExpired(task.expiresAt, now()),
        intent: clip(shownIntent(engine, task.id, "(unavailable)"), 120),
        args: shownArgs(engine, task.id, false),
      };
    }

    function taskJson(task: TaskView) {
      const row = listRow(task);
      return {
        id: row.id,
        state: row.state,
        action: { type: task.action.type, level: task.action.level, resource: task.action.resource },
        principalId: row.principalId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        expiresAt: task.expiresAt,
        expired: isExpired(task.expiresAt, now()),
        decided: task.approvalId !== null,
        intent: row.intent,
        args: row.args,
      };
    }

    function detailPage(id: string, csrf: string, locale: Locale): TaskPage {
      const task = engine.getTask(id);
      if (!task) throw new HttpFail(404, "not_found", "task not found");
      const gate = approvalGate(task, opts.approver, locale);
      let rows: TimelineRow[] = [];
      let decided: DecisionInfo | null = null;
      try {
        const receipts = engine.listTaskReceipts(task.id);
        rows = timeline(receipts, locale);
        decided = decisionInfo(receipts);
      } catch {
        rows = [];
        decided = null;
      }
      return {
        id: task.id,
        state: task.state,
        principalId: task.principalId,
        agentId: task.agentId ?? "",
        createdAt: task.createdAt,
        expiresAt: task.expiresAt ?? "",
        expired: isExpired(task.expiresAt, now()),
        level: task.action.level ?? "",
        actionType: task.action.type,
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
        args: shownArgs(engine, task.id, true),
        allowEdit: task.decision.allowEdit,
        approvedPayloadEdited: task.approvedPayloadHash !== null && task.approvedPayloadHash !== task.payloadHash,
        approvedPayloadHash: task.approvedPayloadHash ?? "",
        decisionInfo: decided,
        timeline: rows,
      };
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

function taskTab(value: string | null): TaskTab | null {
  if (value === null) return "pending";
  if (value === "pending" || value === "recent" || value === "all") return value;
  return null;
}

function approvalGate(
  task: TaskView,
  approver: string | undefined,
  locale: Locale,
): { hints: string[]; approveDisabled: boolean; rejectDisabled: boolean } {
  const hints: string[] = [];
  let approveDisabled = false;
  let rejectDisabled = false;
  if (!effectiveChannels(task.decision).includes("web")) {
    hints.push(t(locale, "hint.channel"));
    approveDisabled = true;
    rejectDisabled = true;
  }
  if (task.decision.minAssurance && assuranceRank(task.decision.minAssurance) > assuranceRank("app_asserted")) {
    const min = task.decision.minAssurance;
    hints.push(t(locale, "hint.assurance", { min, id: task.id }));
    approveDisabled = true;
  }
  if (task.decision.stepUp) {
    hints.push(t(locale, "hint.stepUp", { stepUp: task.decision.stepUp, id: task.id }));
    approveDisabled = true;
  }
  if (approver && approver !== task.principalId) {
    hints.push(t(locale, "hint.approver"));
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

function shownArgs(engine: LedgerEngine, id: string, pretty: boolean): string {
  try {
    const args = engine.taskPayload(id).args;
    const text = pretty ? JSON.stringify(args, null, 2) : JSON.stringify(args);
    if (typeof text !== "string") return "(unavailable)";
    return pretty ? text : clip(text, 120);
  } catch {
    return "(unavailable)";
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function isExpired(expiresAt: string | null, at: Date): boolean {
  if (!expiresAt) return false;
  return at.getTime() > new Date(expiresAt).getTime();
}

function timeline(receipts: Receipt[], locale: Locale): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const receipt of receipts) {
    if (!receipt.transition) continue;
    const to = receipt.transition.to;
    const from = receipt.transition.from;
    const body = receipt.body;
    let label = to;
    let detail = "";
    if (to === "prepared" && from === null) {
      label = t(locale, "tl.requested");
    } else if (to === "pending_approval") {
      label = t(locale, "tl.pending");
      detail = t(locale, "tl.rule", { rule: policyRule(body) });
    } else if (to === "approved" && receipt.actor.type === "policy") {
      label = t(locale, "tl.approvedPolicy");
      detail = t(locale, "tl.rule", { rule: receipt.actor.id });
    } else if (to === "approved") {
      label = t(locale, "tl.approved");
      detail = approvalDetail(body, locale);
    } else if (to === "rejected" && receipt.actor.type === "policy") {
      label = t(locale, "tl.deniedPolicy");
      detail = t(locale, "tl.reason", { reason: textField(body.reason) ?? "" });
    } else if (to === "rejected") {
      label = t(locale, "tl.rejected");
      detail = approvalDetail(body, locale);
      if (typeof body.note_commit === "string") detail += t(locale, "tl.reasonRecorded");
    } else if (to === "drafted") {
      label = t(locale, "tl.drafted");
    } else if (to === "executing") {
      label = t(locale, "tl.claimed");
    } else if (to === "executed") {
      label = t(locale, "tl.completed");
    } else if (to === "failed") {
      label = t(locale, "tl.failed");
      const code = textField(recordField(body.error)?.code);
      if (code) detail = t(locale, "tl.error", { code });
    } else if (to === "unknown" || to === "expired" || to === "revoked") {
      label = t(locale, to === "unknown" ? "tl.unknown" : to === "expired" ? "tl.expired" : "tl.revoked");
      const reason = textField(body.reason);
      if (reason) detail = t(locale, "tl.reason", { reason });
    }
    rows.push({
      at: receipt.issued_at,
      seq: receipt.seq,
      label,
      actor: `${receipt.actor.type}:${receipt.actor.id}`,
      detail,
      tone: statusTone(to),
    });
  }
  return rows;
}

function decisionInfo(receipts: Receipt[]): DecisionInfo | null {
  for (let i = receipts.length - 1; i >= 0; i--) {
    const receipt = receipts[i];
    if (!receipt?.transition) continue;
    const to = receipt.transition.to;
    if (to !== "approved" && to !== "rejected") continue;
    if (receipt.actor.type !== "user") continue;
    const approval = recordField(receipt.body.approval);
    if (!approval) continue;
    const auth = recordField(approval.auth);
    return {
      decision: to === "approved" ? "approved" : "rejected",
      approver: textField(approval.approver) ?? "",
      channel: textField(approval.channel) ?? "",
      assurance: textField(approval.assurance) ?? "",
      simulated: auth?.simulated === true,
      decidedAt: textField(approval.decided_at) ?? "",
      noteRecorded: typeof receipt.body.note_commit === "string",
    };
  }
  return null;
}

function approvalDetail(body: Record<string, unknown>, locale: Locale): string {
  const approval = recordField(body.approval);
  if (!approval) return "";
  const auth = recordField(approval.auth);
  let detail = t(locale, "tl.approval", {
    approver: textField(approval.approver) ?? "",
    channel: textField(approval.channel) ?? "",
    assurance: textField(approval.assurance) ?? "",
  });
  if (auth?.simulated === true) detail += t(locale, "tl.simulated");
  return detail;
}

function policyRule(body: Record<string, unknown>): string {
  return textField(recordField(body.policy)?.rule_id) ?? "";
}

function textField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recordField(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function assertBrowser(req: http.IncomingMessage, origins: Set<string>): void {
  const verdict = checkBrowserPost(req.headers, origins);
  if (verdict === "origin_rejected") throw new HttpFail(403, "origin_rejected", "origin rejected");
  if (verdict === "fetch_site_rejected") throw new HttpFail(403, "fetch_site_rejected", "cross-site request rejected");
}

function assertCsrf(form: Map<string, string>, csrf: string): void {
  if (!safeEqual(csrf, form.get("csrf") ?? "")) throw new HttpFail(403, "csrf_failed", "csrf failed");
}

function requiredNote(form: Map<string, string>): string {
  const note = (form.get("reason") ?? "").trim();
  if (!note) throw new HttpFail(400, "reason_required", "a rejection needs a reason");
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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string,
  type: string,
  extra?: Record<string, string>,
): void {
  const prior = res.getHeader("Set-Cookie");
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    ...SECURITY_HEADERS,
    ...extra,
  };
  if (prior !== undefined && extra?.["Set-Cookie"]) {
    headers["Set-Cookie"] = [...(Array.isArray(prior) ? prior : [String(prior)]), extra["Set-Cookie"]];
  }
  res.writeHead(status, headers);
  res.end(body);
}
