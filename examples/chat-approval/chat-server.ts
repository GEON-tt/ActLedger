import fs from "node:fs";
import http from "node:http";
import {
  openLedger,
  verifyReceiptChain,
  type LedgerEngine,
  type Receipt,
  type State,
} from "@actledger/core";
import type { Ledger } from "@actledger/sdk";
import type { Provider, ProviderName } from "./providers/types.js";
import type { ChatMessage } from "./providers/types.js";
import type { NoteTools, ToolEvent } from "./tools.js";

export type ChatEvent =
  | { type: "turn_start"; turnId: string; provider: ProviderName }
  | { type: "text"; text: string }
  | ToolEvent
  | { type: "turn_summary"; tasks: TaskSummary[]; verify: VerifySummary | null }
  | { type: "error"; message: string }
  | { type: "done"; status: "finished" | "error" };

export interface TaskSummary {
  taskId: string;
  tool: string;
  state: State;
  approver: string | null;
  channel: string | null;
  reasonRecorded: boolean;
  receiptHash: string | null;
  receiptCount: number;
  consoleUrl: string;
}

export interface VerifySummary {
  ok: boolean;
  receipts: number;
  failure: string | null;
  secretsChecked: number | null;
}

export interface PendingTask {
  id: string;
  tool: string;
  createdAt: string;
  expiresAt: string | null;
  consoleUrl: string;
}

export interface TaskSource {
  pending(sinceMs: number | null): Promise<PendingTask[]>;
  summarize(ids: string[]): Promise<TaskSummary[]>;
  verify(): Promise<VerifySummary | null>;
  /** Record a task id this process has seen. A receipt hash comes from a tool_result event. */
  note(id: string, receiptHash?: string | null): void;
  close(): void;
}

export function localTaskSource(ledgerDir: string, consoleUrl: string): TaskSource {
  const engine = openLedger({ dir: ledgerDir });
  return {
    async pending(sinceMs) {
      return engine
        .listTasks({ state: "pending_approval" })
        .filter((task) => {
          if (sinceMs === null) return true;
          const created = Date.parse(task.createdAt);
          return Number.isNaN(created) || created >= sinceMs;
        })
        .map((task) => ({
          id: task.id,
          tool: toolOf(task.action.type),
          createdAt: task.createdAt,
          expiresAt: task.expiresAt,
          consoleUrl: `${consoleUrl}/tasks/${task.id}`,
        }));
    },
    async summarize(ids) {
      return summarizeTasks(engine, ids, consoleUrl);
    },
    async verify() {
      return verifyLedger(engine);
    },
    note() {},
    close() {
      engine.close();
    },
  };
}

export function remoteTaskSource(ledger: Ledger, consoleUrl: string): TaskSource {
  const known = new Set<string>();
  const hashes = new Map<string, string>();
  const request = ledger.request.bind(ledger);
  (ledger as { request: Ledger["request"] }).request = async (input) => {
    const handle = await request(input);
    if (!handle.degraded) known.add(handle.id);
    return handle;
  };
  return {
    async pending(sinceMs) {
      const tasks: PendingTask[] = [];
      for (const id of known) {
        const handle = await ledger.getTask(id);
        if (!handle || handle.state !== "pending_approval") continue;
        const created = Date.parse(handle.data.createdAt);
        if (sinceMs !== null && !Number.isNaN(created) && created < sinceMs) continue;
        tasks.push({
          id: handle.id,
          tool: toolOf(handle.data.action.type),
          createdAt: handle.data.createdAt,
          expiresAt: handle.data.expiresAt,
          consoleUrl: `${consoleUrl}/tasks/${handle.id}`,
        });
      }
      return tasks;
    },
    async summarize(ids) {
      const tasks: TaskSummary[] = [];
      for (const id of ids) {
        const handle = await ledger.getTask(id);
        if (!handle) continue;
        tasks.push({
          taskId: id,
          tool: toolOf(handle.data.action.type),
          state: handle.state,
          approver: null,
          channel: null,
          reasonRecorded: false,
          receiptHash: hashes.get(id) ?? null,
          receiptCount: 0,
          consoleUrl: `${consoleUrl}/tasks/${id}`,
        });
      }
      return tasks;
    },
    async verify() {
      return null;
    },
    note(id, receiptHash) {
      known.add(id);
      if (receiptHash) hashes.set(id, receiptHash);
    },
    close() {},
  };
}

export interface ChatServerOptions {
  port: number;
  source: TaskSource;
  consoleUrl: string;
  mode: "local" | "remote";
  provider: Provider;
  tools: NoteTools;
  log: (line: string) => void;
  /** How often to scan pending tasks during a turn. Default 250. */
  pendingPollMs?: number;
}

export interface ChatServerHandle {
  port: number;
  origin: string;
  close(): Promise<void>;
}

const HTML = fs.readFileSync(new URL("./chat.html", import.meta.url), "utf8");
const BODY_LIMIT = 16 * 1024;
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

const SECURITY = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function headerOne(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.length > 0 ? raw : undefined;
}

function mediaType(value: string | undefined): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function toolOf(actionType: string): string {
  return actionType.startsWith("tool.") ? actionType.slice("tool.".length) : actionType;
}

function sendText(res: http.ServerResponse, status: number, body: string, extra?: Record<string, string>): void {
  res.writeHead(status, {
    ...SECURITY,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readLimited(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const fail = (error: Error) => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error("payload_too_large");
        fail(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => resolve(Buffer.concat(chunks));
    const onError = (error: Error) => fail(error);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

export function summarizeTasks(engine: LedgerEngine, ids: string[], serveOrigin: string): TaskSummary[] {
  const tasks: TaskSummary[] = [];
  for (const id of ids) {
    const task = engine.getTask(id);
    if (!task) continue;
    const receipts = engine.listTaskReceipts(id);
    let approver: string | null = null;
    let channel: string | null = null;
    let reasonRecorded = false;
    for (let index = receipts.length - 1; index >= 0; index -= 1) {
      const receipt: Receipt | undefined = receipts[index];
      const to = receipt?.transition?.to;
      if (to !== "approved" && to !== "rejected") continue;
      const body = receipt?.body ?? {};
      const approval = isRecord(body.approval) ? body.approval : null;
      approver = typeof approval?.approver === "string" ? approval.approver : null;
      channel = typeof approval?.channel === "string" ? approval.channel : null;
      reasonRecorded = typeof body.note_commit === "string";
      break;
    }
    tasks.push({
      taskId: id,
      tool: toolOf(task.action.type),
      state: task.state,
      approver,
      channel,
      reasonRecorded,
      receiptHash: receipts.at(-1)?.hash ?? null,
      receiptCount: receipts.length,
      consoleUrl: `${serveOrigin}/tasks/${id}`,
    });
  }
  return tasks;
}

export function verifyLedger(engine: LedgerEngine): VerifySummary {
  const report = verifyReceiptChain(engine.exportReceipts(), engine.publicKeys(), {
    secrets: engine.exportSecrets(),
  });
  return {
    ok: report.ok,
    receipts: report.stats.count,
    failure: report.failure ? `${report.failure.step}: ${report.failure.reason}` : null,
    secretsChecked: report.stats.secrets?.checked ?? null,
  };
}

export async function startChatServer(opts: ChatServerOptions): Promise<ChatServerHandle> {
  const pendingPollMs = opts.pendingPollMs ?? 250;
  const history: ChatMessage[] = [];
  let busy = false;
  let turnSeq = 0;
  let closing = false;

  const bound = {
    port: 0,
    origin: "",
    hosts: new Set<string>(),
    origins: new Set<string>(),
  };

  function hostAllowed(req: http.IncomingMessage): boolean {
    const host = headerOne(req.headers.host)?.toLowerCase();
    return host !== undefined && bound.hosts.has(host);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (closing) {
      res.destroy();
      return;
    }
    if (!hostAllowed(req)) {
      sendText(res, 421, "misdirected request");
      return;
    }
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    if (pathname === "/") {
      if (method !== "GET") {
        sendText(res, 405, "method not allowed");
        return;
      }
      res.writeHead(200, {
        ...SECURITY,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": CSP,
        "Content-Length": Buffer.byteLength(HTML),
      });
      res.end(HTML);
      return;
    }
    if (pathname === "/config") {
      if (method !== "GET") {
        sendText(res, 405, "method not allowed");
        return;
      }
      sendJson(res, 200, { provider: opts.provider.name, consoleUrl: opts.consoleUrl, mode: opts.mode });
      return;
    }
    if (pathname === "/pending") {
      if (method !== "GET") {
        sendText(res, 405, "method not allowed");
        return;
      }
      sendJson(res, 200, { tasks: await opts.source.pending(null) });
      return;
    }
    if (pathname === "/message") {
      if (method !== "POST") {
        sendText(res, 405, "method not allowed");
        return;
      }
      await handleMessage(req, res);
      return;
    }
    sendText(res, 404, "not found");
  }

  async function handleMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = headerOne(req.headers.origin);
    if (origin !== undefined && !bound.origins.has(origin.toLowerCase())) {
      sendJson(res, 403, { error: "origin_rejected" });
      return;
    }
    const site = headerOne(req.headers["sec-fetch-site"]);
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      sendJson(res, 403, { error: "fetch_site_rejected" });
      return;
    }
    if (mediaType(headerOne(req.headers["content-type"])) !== "application/json") {
      sendJson(res, 415, { error: "unsupported_media_type" });
      req.resume();
      return;
    }
    const declared = Number(headerOne(req.headers["content-length"]) ?? "");
    if (Number.isFinite(declared) && declared > BODY_LIMIT) {
      sendJson(res, 413, { error: "payload_too_large" });
      req.resume();
      return;
    }
    let raw: Buffer;
    try {
      raw = await readLimited(req, BODY_LIMIT);
    } catch (error) {
      if (error instanceof Error && error.message === "payload_too_large") {
        if (!res.headersSent) sendJson(res, 413, { error: "payload_too_large" });
        return;
      }
      throw error;
    }
    let text = "";
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as unknown;
      if (!isRecord(parsed) || typeof parsed.text !== "string") throw new Error("invalid");
      text = parsed.text.trim();
      if (text.length < 1 || text.length > 4000) throw new Error("invalid");
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }
    if (busy) {
      sendJson(res, 409, { error: "busy" });
      return;
    }
    busy = true;
    res.writeHead(200, { ...SECURITY, "Content-Type": "application/x-ndjson; charset=utf-8" });
    const write = (event: ChatEvent) => {
      if (res.destroyed || res.writableEnded) return;
      try {
        res.write(`${JSON.stringify(event)}\n`);
      } catch {
        // The client can go away; the turn still finishes.
      }
    };
    try {
      await runTurn(text, write);
    } finally {
      busy = false;
      if (!res.writableEnded) res.end();
    }
  }

  async function runTurn(text: string, write: (event: ChatEvent) => void): Promise<void> {
    const turnId = `turn_${++turnSeq}`;
    const startedAt = Date.now();
    const seen = new Set<string>();
    const announced = new Set<string>();
    history.push({ role: "user", text });
    while (history.length > 20) history.shift();
    write({ type: "turn_start", turnId, provider: opts.provider.name });
    opts.log(`[chat] ${turnId} ${opts.provider.name}`);

    let stopScan = false;
    const kicks: NodeJS.Timeout[] = [];
    const scanPending = async () => {
      try {
        const tasks = await opts.source.pending(startedAt);
        for (const task of tasks) {
          if (announced.has(task.id)) continue;
          emitTool({ type: "approval_pending", callId: null, taskId: task.id, tool: task.tool });
        }
      } catch {
        // A closed ledger should not fail the turn.
      }
    };
    const kickScan = () => {
      if (!stopScan) void scanPending();
    };
    const emitTool = (event: ToolEvent) => {
      if (event.type === "approval_pending") {
        if (announced.has(event.taskId)) return;
        announced.add(event.taskId);
      }
      const id = event.type === "tool_call" ? null : event.taskId;
      if (id) {
        seen.add(id);
        opts.source.note(id, event.type === "tool_result" ? event.receiptHash : null);
      }
      write(event);
      if (event.type === "tool_call") {
        queueMicrotask(kickScan);
        kicks.push(setTimeout(kickScan, 0));
      }
    };
    const timer = setInterval(() => {
      void scanPending();
    }, pendingPollMs);
    let assistant = "";
    let status: "finished" | "error" = "finished";
    try {
      const result = await opts.provider.runTurn(history.slice(), opts.tools.forTurn(emitTool), (event) => {
        if (event.type === "text") assistant += event.text;
        else status = "error";
        write(event);
      });
      assistant = result.text || assistant;
    } catch (error) {
      status = "error";
      const message = error instanceof Error ? error.message : String(error);
      opts.log(`[chat] ${turnId} error`);
      write({ type: "error", message });
    } finally {
      stopScan = true;
      clearInterval(timer);
      for (const kick of kicks) clearTimeout(kick);
    }
    await scanPending();
    history.push({ role: "assistant", text: assistant });
    while (history.length > 20) history.shift();
    write({
      type: "turn_summary",
      tasks: await opts.source.summarize([...seen]),
      verify: await opts.source.verify(),
    });
    write({ type: "done", status });
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "internal error";
      opts.log(`[chat] request error`);
      if (!res.headersSent) sendText(res, 500, message);
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          reject(new Error(`chat port ${opts.port} is in use; set ACTLEDGER_DEMO_CHAT_PORT`));
          return;
        }
        reject(error);
      };
      server.once("error", onError);
      server.listen(opts.port, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("chat server did not bind a tcp port"));
          return;
        }
        bound.port = address.port;
        bound.origin = `http://127.0.0.1:${address.port}`;
        bound.hosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
        bound.origins = new Set([`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`]);
        resolve();
      });
    });
  } catch (error) {
    opts.source.close();
    server.close();
    throw error;
  }
  server.on("error", () => {
    opts.log("[chat] server error");
  });

  let closed: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (!closed) {
      closing = true;
      closed = new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          try {
            opts.source.close();
          } catch (closeError) {
            if (!error) {
              reject(closeError);
              return;
            }
          }
          if (error) reject(error);
          else resolve();
        });
      });
    }
    return closed;
  };

  return { port: bound.port, origin: bound.origin, close };
}
