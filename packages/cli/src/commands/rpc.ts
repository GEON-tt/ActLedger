import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  LedgerError,
  openLedger,
  type CoverageEntry,
  type LedgerEngine,
  type Payload,
  type RequestInput,
} from "@actledger/core";

interface RpcErrorBody {
  code: string;
  message: string;
  status: number;
  details: Record<string, unknown>;
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorBody(error: unknown): RpcErrorBody {
  if (error instanceof LedgerError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      details: error.details ?? {},
    };
  }
  return { code: "internal", message: String(error), status: 500, details: {} };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requireId(params: Record<string, unknown>): string {
  const id = params.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new LedgerError("invalid_request", "id is required", 400);
  }
  return id;
}

function cliVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = fs.readFileSync(path.join(here, "../../package.json"), "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

export function rpcCommand(opts: { dir: string }): void {
  const dir = path.resolve(opts.dir);
  let engine: LedgerEngine;
  try {
    engine = openLedger({ dir });
  } catch (error) {
    writeMessage({ id: null, ok: false, error: errorBody(error) });
    process.exit(1);
  }
  const version = cliVersion();
  let closed = false;
  const shutdown = (code: number): void => {
    if (closed) return;
    closed = true;
    try {
      engine.close();
    } catch {
      // The store may already be closed.
    }
    process.exit(code);
  };

  const dispatch = (method: string, params: Record<string, unknown>): unknown => {
    switch (method) {
      case "hello":
        return { protocol: "actledger.rpc/1", appId: engine.appId, dir, version };
      case "request":
        return engine.request(params as unknown as RequestInput);
      case "get_task":
        return { task: engine.getTask(requireId(params)) };
      case "claim": {
        const taskId = requireId(params);
        return engine.claim(taskId, {
          idempotencyKey: typeof params.idempotencyKey === "string" ? params.idempotencyKey : undefined,
          agentId: typeof params.agentId === "string" ? params.agentId : undefined,
        });
      }
      case "complete": {
        const taskId = requireId(params);
        return engine.complete(taskId, {
          executedPayload: params.executedPayload as Payload,
          externalProofs: params.externalProofs as Array<{ type: string; value: unknown }> | undefined,
          result: asRecord(params.result) ?? undefined,
          idempotencyKey: typeof params.idempotencyKey === "string" ? params.idempotencyKey : undefined,
        });
      }
      case "fail": {
        const taskId = requireId(params);
        const error = asRecord(params.error);
        const stored: { code: string; message: string; retryable?: boolean } = {
          code: typeof error?.code === "string" ? error.code : "",
          message: typeof error?.message === "string" ? error.message : "",
        };
        if (typeof error?.retryable === "boolean") stored.retryable = error.retryable;
        return engine.fail(taskId, {
          error: stored,
          partial: typeof params.partial === "boolean" ? params.partial : undefined,
          idempotencyKey: typeof params.idempotencyKey === "string" ? params.idempotencyKey : undefined,
        });
      }
      case "revoke": {
        const taskId = requireId(params);
        const task = engine.getTask(taskId);
        return engine.revoke(taskId, {
          actor: { type: "agent", id: task?.agentId ?? "local-agent" },
          reason: typeof params.reason === "string" ? params.reason : undefined,
          idempotencyKey: typeof params.idempotencyKey === "string" ? params.idempotencyKey : undefined,
        });
      }
      case "sweep":
        return engine.sweep();
      case "set_coverage_overlay":
        return { receipt: engine.setCoverageOverlay((params.entries ?? []) as CoverageEntry[]) };
      case "shutdown":
        return {};
      default:
        throw new LedgerError("method_not_found", `unknown method ${method}`, 404);
    }
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let id: unknown = null;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        writeMessage({
          id: null,
          ok: false,
          error: { code: "invalid_request", message: "invalid json", status: 400, details: {} },
        });
        return;
      }
      const message = asRecord(parsed);
      if (!message || typeof message.method !== "string") {
        writeMessage({
          id: null,
          ok: false,
          error: { code: "invalid_request", message: "method is required", status: 400, details: {} },
        });
        return;
      }
      id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
      const params = asRecord(message.params) ?? {};
      const result = dispatch(message.method, params);
      writeMessage({ id, ok: true, result });
      if (message.method === "shutdown") shutdown(0);
    } catch (error) {
      writeMessage({ id, ok: false, error: errorBody(error) });
    }
  });
  rl.on("close", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}
