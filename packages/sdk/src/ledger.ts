import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  compareWithDrift,
  initLocalDir,
  isTerminal as coreIsTerminal,
  LedgerError,
  openLedger,
  type CompleteResult,
  type CoverageEntry,
  type KeySet,
  type Payload,
  type Receipt,
  type RequestInput,
  type State,
  type TaskView,
} from "@actledger/core";
import {
  ApprovalExpired,
  ApprovalRejected,
  ApprovalRevoked,
  ContentMismatch,
  LedgerUnavailable,
} from "./errors.js";
import { createToolGate } from "./gate.js";

export { LedgerError };
export { verifyWebhook, type WebhookEvent } from "./webhook.js";
export { ApprovalExpired, ApprovalRejected, ApprovalRevoked, ContentMismatch, LedgerUnavailable };

export function isTerminal(state: string): boolean {
  return coreIsTerminal(state as State);
}

type MaybePromise<T> = T | Promise<T>;

export interface ClaimedTask {
  task: TaskView;
  approvedPayload: Payload;
  approvedPayloadHash: string;
  executionDeadline: string;
  receipt: Receipt;
}

export interface Transport {
  request(input: RequestInput): MaybePromise<{ task: TaskView; receipts: Receipt[] }>;
  getTask(id: string): MaybePromise<TaskView | null>;
  claim(id: string, opts?: { idempotencyKey?: string }): MaybePromise<ClaimedTask>;
  complete(
    id: string,
    input: {
      executedPayload: Payload;
      externalProofs?: Array<{ type: string; value: unknown }>;
      result?: Record<string, unknown>;
      idempotencyKey?: string;
    },
  ): MaybePromise<CompleteResult>;
  fail(
    id: string,
    input: { error: { code: string; message: string; retryable?: boolean }; idempotencyKey?: string },
  ): MaybePromise<{ task: TaskView; receipt: Receipt }>;
  revoke(id: string, input: { reason?: string; idempotencyKey?: string }): MaybePromise<{ task: TaskView; receipt: Receipt }>;
  /** May return a promise. The resolved value is ignored. */
  sweep?(): unknown;
  setCoverageOverlay?(entries: CoverageEntry[]): MaybePromise<Receipt | null>;
  close(): MaybePromise<void>;
}

export interface LedgerOptions {
  mode?: "local";
  dir?: string;
  strictContent?: boolean;
  onUnavailable?: "deny" | "allow_read_only";
  now?: () => Date;
  transport?: Transport;
  coverageOverlay?: CoverageEntry[];
}

export interface GuardContext {
  approvedPayload: Payload;
  taskId: string | null;
  degraded: boolean;
}

export interface GuardSpec<A> {
  action: string | ((args: A) => RequestInput["action"]);
  principal: (args: A) => string;
  payload: (args: A) => Payload;
  intent?: (args: A) => string;
  agentId?: string;
  readOnly?: (args: A) => boolean;
  executedPayload?: (args: A, approved: Payload) => Payload;
  timeoutMs?: number;
  idempotencyKey?: (args: A) => string;
}

function uuidv7(time = Date.now()): string {
  const bytes = randomBytes(16);
  bytes[0] = Number((BigInt(time) >> 40n) & 0xffn);
  bytes[1] = Number((BigInt(time) >> 32n) & 0xffn);
  bytes[2] = Number((BigInt(time) >> 24n) & 0xffn);
  bytes[3] = Number((BigInt(time) >> 16n) & 0xffn);
  bytes[4] = Number((BigInt(time) >> 8n) & 0xffn);
  bytes[5] = Number(BigInt(time) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function unavailable(error: unknown): boolean {
  return error instanceof LedgerError && error.code === "ledger_unavailable";
}

export class LocalTransport implements Transport {
  constructor(private readonly engine: ReturnType<typeof openLedger>) {}
  request(input: RequestInput) {
    return this.engine.request(input);
  }
  getTask(id: string) {
    return this.engine.getTask(id);
  }
  claim(id: string, opts?: { idempotencyKey?: string }) {
    return this.engine.claim(id, opts);
  }
  complete(
    id: string,
    input: {
      executedPayload: Payload;
      externalProofs?: Array<{ type: string; value: unknown }>;
      result?: Record<string, unknown>;
      idempotencyKey?: string;
    },
  ) {
    return this.engine.complete(id, input);
  }
  fail(id: string, input: { error: { code: string; message: string; retryable?: boolean }; idempotencyKey?: string }) {
    return this.engine.fail(id, input);
  }
  revoke(id: string, input: { reason?: string; idempotencyKey?: string }) {
    const task = this.engine.getTask(id);
    return this.engine.revoke(id, {
      actor: { type: "agent", id: task?.agentId ?? "local-agent" },
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
  }
  sweep() {
    this.engine.sweep();
  }
  setCoverageOverlay(entries: CoverageEntry[]) {
    return this.engine.setCoverageOverlay(entries);
  }
  close() {
    this.engine.close();
  }
}

export class Run {
  constructor(
    private readonly ledger: Ledger,
    private readonly transport: Transport,
    private readonly claimed: ClaimedTask,
  ) {}

  get taskId(): string {
    return this.claimed.task.id;
  }

  get approvedPayload(): Payload {
    return this.claimed.approvedPayload;
  }

  get executionDeadline(): string {
    return this.claimed.executionDeadline;
  }

  async complete(input: {
    executedPayload: Payload;
    externalProofs?: Array<{ type: string; value: unknown }>;
    result?: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<Receipt> {
    if (this.ledger.strictContent && !compareWithDrift(this.approvedPayload, input.executedPayload).match) {
      await this.fail({
        error: { code: "content_mismatch", message: "executed payload does not match the approved payload" },
      });
      throw new ContentMismatch();
    }
    try {
      const result = await this.transport.complete(this.taskId, {
        ...input,
        idempotencyKey: input.idempotencyKey ?? uuidv7(),
      });
      return result.receipt;
    } catch (error) {
      if (error instanceof LedgerError && error.code === "content_mismatch") throw new ContentMismatch(error.message);
      throw error;
    }
  }

  async fail(input: { error: { code: string; message: string; retryable?: boolean } }): Promise<void> {
    await this.transport.fail(this.taskId, { ...input, idempotencyKey: uuidv7() });
  }
}

export class TaskHandle {
  readonly degraded: boolean;

  constructor(
    private readonly ledger: Ledger,
    private readonly transport: Transport,
    readonly data: TaskView,
    degraded = false,
  ) {
    this.degraded = degraded;
  }

  get id(): string {
    return this.data.id;
  }

  get state(): State {
    return this.data.state;
  }

  get decision() {
    return this.data.decision;
  }

  static degraded(ledger: Ledger, transport: Transport, payloadHash = "sha256:degraded"): TaskHandle {
    const now = new Date().toISOString();
    const data: TaskView = {
      id: "tsk_degraded",
      appId: "degraded",
      principalId: "degraded",
      agentId: null,
      intentCommit: null,
      action: {
        type: "read",
        level: "read",
        resource: null,
        blastRadius: "self",
        reversible: true,
        amount: null,
        attrs: {},
      },
      payloadHash,
      approvedPayloadHash: payloadHash,
      integrationMode: "recorded",
      coverageVia: null,
      coverageMatched: false,
      state: "approved",
      decision: {
        result: "allow",
        ruleId: "degraded",
        policyVersion: 0,
        ladderLevel: 0,
        minAssurance: null,
        integrationMode: "recorded",
        coverageVia: null,
        coverageMatched: false,
        contentMode: "warn",
        allowEdit: false,
        stepUp: null,
        channels: [],
        executionTimeoutMs: 0,
        claimDeadlineMs: 0,
        approvalTimeoutMs: 0,
        promotionHint: null,
        level: "read",
        blastRadius: "self",
        reversible: true,
      },
      approvalId: null,
      claimedAt: null,
      executionDeadline: null,
      claimDeadline: null,
      executedHash: null,
      contentMatch: null,
      mismatch: false,
      error: null,
      expiresAt: null,
      idempotencyKey: null,
      createdAt: now,
      updatedAt: now,
    };
    return new TaskHandle(ledger, transport, data, true);
  }

  async wait(opts?: { timeoutMs?: number; pollMs?: number }): Promise<TaskHandle> {
    if (this.degraded) return this;
    const timeoutMs = opts?.timeoutMs ?? 15 * 60_000;
    const pollMs = opts?.pollMs ?? 200;
    const start = Date.now();
    let current = this.data;
    while (current.state === "pending_approval") {
      await this.transport.sweep?.();
      const next = await this.transport.getTask(this.id);
      if (!next) throw new LedgerError("not_found", `task ${this.id} not found`, 404);
      current = next;
      if (current.state !== "pending_approval") break;
      if (Date.now() - start >= timeoutMs) {
        throw new ApprovalExpired(new TaskHandle(this.ledger, this.transport, current), "wait timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    const handle = new TaskHandle(this.ledger, this.transport, current);
    if (current.state === "rejected") throw new ApprovalRejected(handle);
    if (current.state === "expired") throw new ApprovalExpired(handle);
    if (current.state === "revoked") throw new ApprovalRevoked(handle);
    return handle;
  }

  async claim(): Promise<Run> {
    if (this.degraded) throw new LedgerUnavailable("degraded read-only task cannot be claimed");
    const claimed = await this.transport.claim(this.id, { idempotencyKey: uuidv7() });
    return new Run(this.ledger, this.transport, claimed);
  }
}

export class Ledger {
  readonly strictContent: boolean;
  readonly onUnavailable: "deny" | "allow_read_only";
  readonly dir: string | null;
  private readonly transport: Transport;

  constructor(opts: LedgerOptions) {
    this.strictContent = opts.strictContent ?? true;
    this.onUnavailable = opts.onUnavailable ?? "deny";
    if (opts.transport) {
      this.transport = opts.transport;
      this.dir = null;
    } else if (opts.mode === "local") {
      this.dir = path.resolve(opts.dir ?? ".actledger");
      try {
        this.transport = new LocalTransport(
          openLedger({ dir: opts.dir ?? ".actledger", now: opts.now, coverageOverlay: opts.coverageOverlay }),
        );
      } catch (error) {
        if (error instanceof LedgerError) throw error;
        throw new LedgerUnavailable(error instanceof Error ? error.message : "ledger unavailable");
      }
    } else {
      throw new LedgerError("invalid_request", "pass mode: 'local' or a transport", 400);
    }
  }

  async request(input: RequestInput & { readOnly?: boolean }): Promise<TaskHandle> {
    try {
      const result = await this.transport.request({
        ...input,
        idempotencyKey: input.idempotencyKey ?? uuidv7(),
      });
      return new TaskHandle(this, this.transport, result.task);
    } catch (error) {
      if (unavailable(error) || error instanceof LedgerUnavailable) {
        if (this.onUnavailable === "allow_read_only" && input.readOnly) {
          return TaskHandle.degraded(this, this.transport);
        }
        throw error instanceof LedgerUnavailable ? error : new LedgerUnavailable();
      }
      throw error;
    }
  }

  async getTask(id: string): Promise<TaskHandle | null> {
    try {
      const task = await this.transport.getTask(id);
      return task ? new TaskHandle(this, this.transport, task) : null;
    } catch (error) {
      if ((unavailable(error) || error instanceof LedgerUnavailable) && this.onUnavailable === "allow_read_only") {
        return null;
      }
      if (unavailable(error)) throw new LedgerUnavailable();
      throw error;
    }
  }

  async revoke(id: string, reason?: string): Promise<void> {
    await this.transport.revoke(id, { reason, idempotencyKey: uuidv7() });
  }

  /** Runs the transport sweep. A local transport sweeps synchronously before this returns. */
  sweep(): Promise<void> {
    return Promise.resolve(this.transport.sweep?.()).then(() => undefined);
  }

  setCoverageOverlay(entries: CoverageEntry[]): Promise<void> {
    if (!this.transport.setCoverageOverlay) {
      throw new LedgerError("invalid_request", "transport does not support coverage overlay", 400);
    }
    return Promise.resolve(this.transport.setCoverageOverlay(entries)).then(() => undefined);
  }

  guard<A, R>(spec: GuardSpec<A>, fn: (args: A, ctx: GuardContext) => Promise<R> | R) {
    const gate = createToolGate<A>({
      ledger: this,
      mode: "wait",
      agentId: spec.agentId,
      timeoutMs: spec.timeoutMs,
      pollMs: 20,
      principal: (_tool, args) => spec.principal(args),
      map: (_tool, args) => ({
        action: typeof spec.action === "string" ? { type: spec.action } : spec.action(args),
        payload: spec.payload(args),
        intent: spec.intent?.(args),
        idempotencyKey: spec.idempotencyKey?.(args),
        readOnly: spec.readOnly?.(args) ?? false,
      }),
    });
    const toolName = typeof spec.action === "string" ? spec.action : "guard";
    return async (args: A): Promise<R> => {
      const decision = await gate.before(toolName, args);
      if (decision.kind === "deny") throw decision.cause;
      if (decision.kind === "pending") {
        throw new LedgerError(
          "invalid_transition",
          `task ${decision.taskId} is pending_approval, not approved`,
          409,
        );
      }
      if (decision.degraded || !decision.run) {
        return fn(args, { approvedPayload: decision.approvedPayload, taskId: null, degraded: true });
      }
      const run = decision.run;
      const executed = spec.executedPayload?.(args, run.approvedPayload) ?? run.approvedPayload;
      if (this.strictContent && !compareWithDrift(run.approvedPayload, executed).match) {
        await run.fail({
          error: {
            code: "content_mismatch",
            message: "executed payload does not match the approved payload",
          },
        });
        throw new ContentMismatch();
      }
      const result = await fn(args, {
        approvedPayload: run.approvedPayload,
        taskId: run.taskId,
        degraded: false,
      });
      await gate.after(run, { result, executedPayload: executed });
      return result;
    };
  }

  /** A local transport closes synchronously before this returns. */
  close(): Promise<void> {
    return Promise.resolve(this.transport.close());
  }
}

export function initLocal(dir: string, policyYaml?: string): { appId: string; apiKey: string } {
  return initLocalDir(dir, policyYaml ? { policyYaml } : undefined);
}

export type { Payload, Receipt, TaskView, State, KeySet, RequestInput, CoverageEntry };
