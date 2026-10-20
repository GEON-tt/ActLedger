import type http from "node:http";
import { LedgerError, type LedgerEngine, type Payload, type RequestInput } from "@actledger/core";
import {
  HttpFail,
  TASK_ID,
  hostAllowed,
  mediaType,
  parseCookies,
  readBody,
  send,
  sendJson,
  sendText,
} from "@actledger/cli/console";
import { bearerToken } from "./apikey.js";
import type { KeyRow } from "./store.js";
import type { CredentialStore } from "./store.js";
import type { RemoteSessions } from "./sessions.js";
import type { RequestInfo } from "./request.js";

export const API_LIMIT = 1024 * 1024;

const IDEMPOTENCY_RE = /^[\x21-\x7e]{1,128}$/;

export interface ApiContext {
  engine: LedgerEngine;
  store: CredentialStore;
  sessions: RemoteSessions;
  hosts: Set<string>;
  info: RequestInfo;
}

export async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, ctx: ApiContext): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (pathname === "/healthz") {
    if (method !== "GET") throw methodNotAllowed(req, method);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === "/v1/keys") {
    if (method !== "GET") throw methodNotAllowed(req, method);
    sendJson(res, 200, ctx.engine.publicKeys());
    return;
  }
  if (pathname === "/v1/export") {
    if (method !== "GET") throw methodNotAllowed(req, method);
    await exportReceipts(req, res, url, ctx);
    return;
  }
  if (pathname === "/v1/tasks") {
    if (method !== "POST") throw methodNotAllowed(req, method);
    await createTask(req, res, ctx);
    return;
  }

  const match = pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(claim|complete|fail|revoke|approve|reject|reconcile))?$/);
  if (!match) {
    if (method === "POST") req.resume();
    throw new HttpFail(404, "not_found", "not found");
  }
  const id = decodeSegment(match[1] ?? "");
  const action = match[2];
  if (id === null || !TASK_ID.test(id)) {
    if (method === "POST") req.resume();
    throw new HttpFail(404, "not_found", "not found");
  }
  if (!action && method !== "GET") throw methodNotAllowed(req, method);
  if (action && method !== "POST") throw methodNotAllowed(req, method);

  const key = requireKey(req, ctx.store);
  if (key.kind !== "agent" || !key.agentId) {
    req.resume();
    throw new HttpFail(403, "forbidden", "audit keys are read-only");
  }
  if (action === "approve" || action === "reject" || action === "reconcile") {
    req.resume();
    throw new HttpFail(403, "forbidden", "agent keys cannot approve, reject, or reconcile tasks");
  }

  if (!action) {
    const task = ctx.engine.getTask(id);
    if (!task || !owned(task.agentId, task.principalId, key)) {
      throw new HttpFail(404, "not_found", `task ${id} not found`);
    }
    sendJson(res, 200, { task });
    return;
  }

  const task = ctx.engine.getTask(id);
  if (!task || !owned(task.agentId, task.principalId, key)) {
    req.resume();
    throw new HttpFail(404, "not_found", `task ${id} not found`);
  }
  const body = await readJson(req);
  const idempotencyKey = optionalIdempotency(body);
  if (action === "claim") {
    sendJson(res, 200, ctx.engine.claim(id, { idempotencyKey, agentId: key.agentId }));
    return;
  }
  if (action === "complete") {
    if (!isPlain(body.executedPayload)) throw new LedgerError("invalid_request", "executedPayload must be an object", 400);
    if (body.externalProofs !== undefined && !Array.isArray(body.externalProofs)) {
      throw new LedgerError("invalid_request", "externalProofs must be an array", 400);
    }
    if (body.result !== undefined && !isPlain(body.result)) {
      throw new LedgerError("invalid_request", "result must be an object", 400);
    }
    sendJson(
      res,
      200,
      ctx.engine.complete(id, {
        executedPayload: body.executedPayload as unknown as Payload,
        ...(Array.isArray(body.externalProofs)
          ? { externalProofs: body.externalProofs as Array<{ type: string; value: unknown }> }
          : {}),
        ...(isPlain(body.result) ? { result: body.result } : {}),
        idempotencyKey,
      }),
    );
    return;
  }
  if (action === "fail") {
    if (!isPlain(body.error) || typeof body.error.code !== "string" || typeof body.error.message !== "string") {
      throw new LedgerError("invalid_request", "error must be an object with code and message", 400);
    }
    if (body.error.retryable !== undefined && typeof body.error.retryable !== "boolean") {
      throw new LedgerError("invalid_request", "error.retryable must be a boolean", 400);
    }
    if (body.partial !== undefined && typeof body.partial !== "boolean") {
      throw new LedgerError("invalid_request", "partial must be a boolean", 400);
    }
    const error: { code: string; message: string; retryable?: boolean } = {
      code: body.error.code,
      message: body.error.message,
    };
    if (typeof body.error.retryable === "boolean") error.retryable = body.error.retryable;
    sendJson(res, 200, ctx.engine.fail(id, { error, ...(typeof body.partial === "boolean" ? { partial: body.partial } : {}), idempotencyKey }));
    return;
  }
  if (body.reason !== undefined && typeof body.reason !== "string") {
    throw new LedgerError("invalid_request", "reason must be a string", 400);
  }
  sendJson(
    res,
    200,
    ctx.engine.revoke(id, {
      actor: { type: "agent", id: key.agentId },
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      idempotencyKey,
    }),
  );
}

async function createTask(req: http.IncomingMessage, res: http.ServerResponse, ctx: ApiContext): Promise<void> {
  const key = requireKey(req, ctx.store);
  if (key.kind !== "agent" || !key.agentId) {
    req.resume();
    throw new HttpFail(403, "forbidden", "audit keys are read-only");
  }
  const body = await readJson(req);
  if (typeof body.principalId !== "string" || body.principalId.length === 0) {
    throw new LedgerError("invalid_request", "principalId must be a non-empty string", 400);
  }
  if (!isPlain(body.action) || !isPlain(body.payload)) {
    throw new LedgerError("invalid_request", "action and payload must be objects", 400);
  }
  if (body.agentId !== undefined && typeof body.agentId !== "string") {
    throw new LedgerError("invalid_request", "agentId must be a string", 400);
  }
  if (body.intent !== undefined && body.intent !== null && typeof body.intent !== "string") {
    throw new LedgerError("invalid_request", "intent must be a string or null", 400);
  }
  if (body.expiresIn !== undefined && typeof body.expiresIn !== "number") {
    throw new LedgerError("invalid_request", "expiresIn must be a number", 400);
  }
  if (body.metadata !== undefined && !isPlain(body.metadata)) {
    throw new LedgerError("invalid_request", "metadata must be an object", 400);
  }
  if (typeof body.agentId === "string" && body.agentId !== key.agentId) {
    throw new LedgerError("agent_mismatch", "agentId does not match the api key", 403);
  }
  if (!key.principalIds.includes(body.principalId)) {
    throw new LedgerError("principal_not_allowed", `this api key cannot act for principal ${body.principalId}`, 403);
  }
  const input: RequestInput = {
    principalId: body.principalId,
    agentId: key.agentId,
    action: body.action as unknown as RequestInput["action"],
    payload: body.payload as unknown as Payload,
    idempotencyKey: optionalIdempotency(body),
  };
  if (typeof body.intent === "string") input.intent = body.intent;
  if (typeof body.expiresIn === "number") input.expiresIn = body.expiresIn;
  if (isPlain(body.metadata)) input.metadata = body.metadata;
  sendJson(res, 200, ctx.engine.request(input));
}

async function exportReceipts(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<void> {
  if (req.headers.authorization !== undefined) {
    const key = requireKey(req, ctx.store);
    if (key.kind !== "audit") throw new HttpFail(403, "forbidden", "agent keys cannot export the ledger");
  } else {
    if (!hostAllowed(ctx.info.host, ctx.hosts)) {
      throw new HttpFail(421, "misdirected_request", "misdirected request", true);
    }
    const session = ctx.sessions.get(parseCookies(req.headers.cookie).get("actledger_session"));
    if (!session) throw new HttpFail(401, "unauthorized", "unauthorized");
  }
  const from = seqParam(url.searchParams.get("from"));
  const to = seqParam(url.searchParams.get("to"));
  const receipts = ctx.engine.exportReceipts(from, to);
  send(res, 200, receipts.map((receipt) => `${JSON.stringify(receipt)}\n`).join(""), "application/x-ndjson; charset=utf-8");
}

function requireKey(req: http.IncomingMessage, store: CredentialStore): KeyRow {
  const token = bearerToken(req.headers.authorization);
  const row = token ? store.findActiveKey(token) : null;
  if (!row) throw new HttpFail(401, "unauthorized", "missing or invalid api key");
  store.touchKey(row.id);
  return row;
}

function owned(agentId: string | null, principalId: string, key: KeyRow): boolean {
  return agentId === key.agentId && key.principalIds.includes(principalId);
}

function optionalIdempotency(body: Record<string, unknown>): string | undefined {
  if (body.idempotencyKey === undefined) return undefined;
  if (typeof body.idempotencyKey !== "string" || !IDEMPOTENCY_RE.test(body.idempotencyKey)) {
    throw new LedgerError("invalid_request", "idempotencyKey must be 1-128 visible ASCII characters", 400);
  }
  return body.idempotencyKey;
}

function seqParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new LedgerError("invalid_request", "from and to must be integers >= 1", 400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new LedgerError("invalid_request", "from and to must be integers >= 1", 400);
  }
  return parsed;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (mediaType(req.headers["content-type"]) !== "application/json") {
    req.resume();
    throw new HttpFail(415, "unsupported_media_type", "unsupported media type");
  }
  const text = await readBody(req, API_LIMIT);
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LedgerError("invalid_request", "invalid json", 400);
  }
  if (!isPlain(parsed)) throw new LedgerError("invalid_request", "json body must be an object", 400);
  return parsed;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function methodNotAllowed(req: http.IncomingMessage, method: string): HttpFail {
  if (method === "POST") req.resume();
  return new HttpFail(405, "method_not_allowed", "method not allowed");
}

export function sendApiError(res: http.ServerResponse, error: unknown, log: (line: string) => void): void {
  if (res.headersSent) return;
  if (error instanceof HttpFail && error.status === 421) {
    sendText(res, 421, "misdirected request");
    return;
  }
  if (error instanceof HttpFail) {
    const body = { code: error.code, message: error.message, status: error.status, details: {} };
    if (error.status === 401 && error.message === "missing or invalid api key") {
      send(res, 401, JSON.stringify(body), "application/json; charset=utf-8", {
        "WWW-Authenticate": 'Bearer realm="actledger"',
      });
      return;
    }
    sendJson(res, error.status, body);
    return;
  }
  if (error instanceof LedgerError) {
    sendJson(res, error.status, {
      code: error.code,
      message: error.message,
      status: error.status,
      details: error.details ?? {},
    });
    return;
  }
  log(`internal error: ${error instanceof Error ? (error.stack ?? error.message) : "unknown"}`);
  sendJson(res, 500, { code: "internal", message: "internal error", status: 500, details: {} });
}
