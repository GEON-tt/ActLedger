import { assuranceRank, LedgerError } from "@actledger/core";
import { LedgerUnavailable } from "./errors.js";
import type {
  ClaimedTask,
  Transport,
} from "./ledger.js";
import type { CompleteResult, CoverageEntry, Payload, Receipt, RequestInput, TaskView } from "@actledger/core";

/** Parts of a decision that the remote console cannot record. */
export interface RemoteApproveRequirements {
  minAssurance?: string | null;
  stepUp?: string | null;
}

/** Resolved remote connection. Construction does not open a socket. */
export interface RemoteOptions {
  url: string;
  apiKey: string;
  requestTimeoutMs: number;
  allowInsecureHttp: boolean;
  fetch: typeof fetch;
}

const RETRY_DELAYS_MS = [200, 600];

const URL_MESSAGE = "remote url must be an http(s) URL without a query or hash";
const USERINFO_MESSAGE = "remote url must not include userinfo";
const INSECURE_MESSAGE =
  "remote url must use https, or http on loopback; pass allowInsecureHttp to allow plaintext http";

export function remoteApproveHint(
  taskId: string,
  consoleUrl: string,
  requirements?: RemoteApproveRequirements | null,
): string {
  const base = `Task ${taskId} is waiting for approval. Approve or reject it in the ActLedger console: ${consoleUrl}/tasks/${taskId}`;
  const min = requirements?.minAssurance;
  const high = typeof min === "string" && min.length > 0 && assuranceRank(min) > assuranceRank("app_asserted");
  const stepUp = Boolean(requirements?.stepUp);
  if (!high && !stepUp) return base;
  const need = high && stepUp ? `${min} and step-up` : high ? String(min) : "step-up";
  return `${base} This task needs ${need}, which the remote console cannot record; ask the server operator.`;
}

export function normalizeRemoteUrl(raw: string, allowInsecureHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new LedgerError("invalid_request", URL_MESSAGE, 400);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.search || parsed.hash || !parsed.hostname) {
    throw new LedgerError("invalid_request", URL_MESSAGE, 400);
  }
  if (parsed.username || parsed.password) {
    throw new LedgerError("invalid_request", USERINFO_MESSAGE, 400);
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (parsed.protocol === "http:" && !loopback && !allowInsecureHttp) {
    throw new LedgerError("invalid_request", INSECURE_MESSAGE, 400);
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

export function resolveRemoteConfig(opts: {
  url?: string;
  apiKey?: string;
  requestTimeoutMs?: number;
  allowInsecureHttp?: boolean;
  fetch?: typeof fetch;
}): RemoteOptions {
  const url = opts.url ?? process.env.ACTLEDGER_URL;
  const apiKey = opts.apiKey ?? process.env.ACTLEDGER_API_KEY;
  if (!url || !apiKey) {
    throw new LedgerError(
      "invalid_request",
      "remote mode needs url and apiKey (or ACTLEDGER_URL and ACTLEDGER_API_KEY)",
      400,
    );
  }
  return {
    url: normalizeRemoteUrl(url, opts.allowInsecureHttp ?? false),
    apiKey,
    requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
    allowInsecureHttp: opts.allowInsecureHttp ?? false,
    fetch: opts.fetch ?? globalThis.fetch,
  };
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function causeText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasIdempotency(value: unknown): boolean {
  return isPlain(value) && typeof value.idempotencyKey === "string" && value.idempotencyKey.length > 0;
}

export class RemoteTransport implements Transport {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RemoteOptions) {
    this.base = opts.url;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.requestTimeoutMs;
    this.fetchImpl = opts.fetch;
  }

  request(input: RequestInput): Promise<{ task: TaskView; receipts: Receipt[] }> {
    return this.send("POST", "/v1/tasks", input, hasIdempotency(input)) as Promise<{
      task: TaskView;
      receipts: Receipt[];
    }>;
  }

  async getTask(id: string): Promise<TaskView | null> {
    const body = await this.send("GET", `/v1/tasks/${encodeURIComponent(id)}`, undefined, true, true);
    if (body === null || !isPlain(body)) return null;
    const task = body.task;
    return isPlain(task) ? (task as unknown as TaskView) : null;
  }

  claim(id: string, opts?: { idempotencyKey?: string }): Promise<ClaimedTask> {
    const body = opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {};
    return this.send("POST", `/v1/tasks/${encodeURIComponent(id)}/claim`, body, hasIdempotency(body)) as Promise<ClaimedTask>;
  }

  complete(
    id: string,
    input: {
      executedPayload: Payload;
      externalProofs?: Array<{ type: string; value: unknown }>;
      result?: Record<string, unknown>;
      idempotencyKey?: string;
    },
  ): Promise<CompleteResult> {
    return this.send(
      "POST",
      `/v1/tasks/${encodeURIComponent(id)}/complete`,
      input,
      hasIdempotency(input),
    ) as Promise<CompleteResult>;
  }

  fail(
    id: string,
    input: { error: { code: string; message: string; retryable?: boolean }; idempotencyKey?: string },
  ): Promise<{ task: TaskView; receipt: Receipt }> {
    return this.send(
      "POST",
      `/v1/tasks/${encodeURIComponent(id)}/fail`,
      input,
      hasIdempotency(input),
    ) as Promise<{ task: TaskView; receipt: Receipt }>;
  }

  revoke(id: string, input: { reason?: string; idempotencyKey?: string }): Promise<{ task: TaskView; receipt: Receipt }> {
    return this.send(
      "POST",
      `/v1/tasks/${encodeURIComponent(id)}/revoke`,
      input,
      hasIdempotency(input),
    ) as Promise<{ task: TaskView; receipt: Receipt }>;
  }

  setCoverageOverlay(_entries: CoverageEntry[]): Promise<Receipt | null> {
    return Promise.reject(
      new LedgerError(
        "remote_unsupported",
        "setCoverageOverlay is not available in remote mode; set coverage in the server policy",
        400,
      ),
    );
  }

  close(): void {}

  private async send(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    retry: boolean,
    missingIsNull = false,
  ): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        };
        let payload: string | undefined;
        if (method === "POST") {
          headers["Content-Type"] = "application/json";
          payload = JSON.stringify(body ?? {});
        }
        const response = await this.fetchImpl(`${this.base}${path}`, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: "manual",
        });
        if ((response.status === 502 || response.status === 503 || response.status === 504) && retry && attempt < RETRY_DELAYS_MS.length) {
          await response.arrayBuffer().catch(() => undefined);
          await delay(RETRY_DELAYS_MS[attempt] ?? 0);
          attempt += 1;
          continue;
        }
        return await interpret(response, missingIsNull);
      } catch (error) {
        if (error instanceof LedgerError || error instanceof LedgerUnavailable) throw error;
        if (retry && attempt < RETRY_DELAYS_MS.length) {
          await delay(RETRY_DELAYS_MS[attempt] ?? 0);
          attempt += 1;
          continue;
        }
        throw new LedgerUnavailable(`ActLedger server unreachable: ${causeText(error)}`);
      }
    }
  }
}

async function interpret(response: Response, missingIsNull: boolean): Promise<unknown> {
  const status = response.status;
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    await response.arrayBuffer().catch(() => undefined);
    throw new LedgerUnavailable(`ActLedger server error ${status}`);
  }
  if (status === 401) {
    await response.arrayBuffer().catch(() => undefined);
    throw new LedgerError(
      "unauthorized",
      "ActLedger server rejected the API key; check ACTLEDGER_API_KEY",
      401,
    );
  }
  const text = await response.text();
  if (missingIsNull && status === 404) return null;
  let parsed: unknown;
  if (text.trim() === "") parsed = undefined;
  else {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  const obj = isPlain(parsed) ? parsed : null;
  if (status >= 200 && status < 300) {
    if (!obj) throw new LedgerUnavailable("ActLedger server returned an invalid response");
    return obj;
  }
  if (obj && obj.code === "ledger_unavailable") {
    const message = typeof obj.message === "string" ? obj.message : "ledger unavailable";
    throw new LedgerUnavailable(message);
  }
  if (obj && typeof obj.code === "string" && typeof obj.message === "string" && status >= 400 && status < 500) {
    const reported = typeof obj.status === "number" ? obj.status : status;
    const details = isPlain(obj.details) ? obj.details : {};
    throw new LedgerError(obj.code, obj.message, reported, details);
  }
  if (status >= 400 && status < 500) {
    throw new LedgerError(`http_${status}`, text.slice(0, 200), status);
  }
  if (obj && typeof obj.code === "string" && typeof obj.message === "string") {
    const reported = typeof obj.status === "number" ? obj.status : status;
    const details = isPlain(obj.details) ? obj.details : {};
    throw new LedgerError(obj.code, obj.message, reported, details);
  }
  throw new LedgerError(`http_${status}`, text.slice(0, 200), status);
}
