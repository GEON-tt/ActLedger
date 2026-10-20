import { assuranceRank, LedgerError, type Payload, type Receipt, type RequestInput, type State } from "@actledger/core";
import { ApprovalExpired, ApprovalRejected, ApprovalRevoked } from "./errors.js";
import type { Ledger, Run, TaskHandle } from "./ledger.js";

export type ToolGateMode = "wait" | "defer";

/** Return value of map(): the action and payload this tool call records in the ledger. */
export interface ToolGateMapping {
  /** A string is shorthand for { type: action }. */
  action: string | RequestInput["action"];
  /** When omitted, the default payload is { action: <type>, args: <input, or { input } when input is not a plain object> }. */
  payload?: Payload;
  intent?: string;
  idempotencyKey?: string;
  /** Only used when the ledger is unavailable and onUnavailable === "allow_read_only". */
  readOnly?: boolean;
  expiresIn?: number;
  metadata?: Record<string, unknown>;
}

export interface ToolGateOptions<I = Record<string, unknown>> {
  ledger: Ledger;
  principal: string | ((toolName: string, input: I) => string);
  agentId?: string;
  map?: (toolName: string, input: I) => ToolGateMapping;
  mode: ToolGateMode;
  /** Wait mode only. Defaults to the TaskHandle.wait default (15 minutes). */
  timeoutMs?: number;
  /** Wait mode only. Defaults to ledger.pollMs (200 local, 1000 remote). guard passes 20 locally. */
  pollMs?: number;
}

export type ToolGateDenyReason =
  | "rejected"
  | "policy_denied"
  | "drafted"
  | "expired"
  | "revoked"
  | "timeout";

export interface ToolGateAllow {
  kind: "allow";
  /** null when degraded; do not call methods on it then. after(null, …) is a no-op. */
  run: Run | null;
  taskId: string | null;
  /** The payload the tool should execute (the approver may have edited it). Equals the requested payload when degraded. */
  approvedPayload: Payload;
  degraded: boolean;
}

export interface ToolGateDeny {
  kind: "deny";
  taskId: string;
  reason: ToolGateDenyReason;
  /** Human-readable, for example "task tsk_x was rejected". Equals cause.message. */
  message: string;
  /** The task's ledger state at decision time. "pending_approval" on timeout. */
  state: State;
  /** The error the old guard threw in the same case; guard throws it as is. */
  cause: ApprovalRejected | ApprovalExpired | ApprovalRevoked | LedgerError;
}

export interface ToolGatePending {
  kind: "pending";
  taskId: string;
  approveHint: string;
}

export type ToolGateDecision = ToolGateAllow | ToolGateDeny | ToolGatePending;

export type ToolGateOutcome =
  | {
      result: unknown;
      /** Defaults to run.approvedPayload. */
      executedPayload?: Payload;
      externalProofs?: Array<{ type: string; value: unknown }>;
      /** Optional: stored as the result of complete, in the secrets plaintext area, never in the receipt. The tool's raw return value is not stored automatically. */
      record?: Record<string, unknown>;
    }
  | {
      error: unknown;
      /** Defaults to "tool_error". */
      code?: string;
      retryable?: boolean;
    };

export interface ToolGate<I = Record<string, unknown>> {
  readonly mode: ToolGateMode;
  before(toolName: string, input: I): Promise<ToolGateDecision>;
  after(run: Run | null, outcome: ToolGateOutcome): Promise<Receipt | null>;
  resume(taskId: string): Promise<ToolGateDecision>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultPayload(actionType: string, input: unknown): Payload {
  const args = isPlainObject(input) ? input : { input };
  return { action: actionType, args };
}

export function defaultToolMapping(toolName: string, input: unknown): ToolGateMapping {
  const type = `tool.${toolName}`;
  return { action: { type }, payload: defaultPayload(type, input) };
}

/** The parts of a task decision that change the approve command. Pass `handle.decision`. */
export interface ApproveRequirements {
  minAssurance?: string | null;
  stepUp?: string | null;
}

/** `actledger approve` with the flags the task needs. The CLI marks `--assurance` above app_asserted and `--step-up` as simulated. `dir` is not quoted. */
export function approveCommandLine(taskId: string, dir: string | null, requirements?: ApproveRequirements | null): string {
  let line = `actledger approve ${taskId}`;
  if (dir) line += ` --dir ${dir}`;
  const min = requirements?.minAssurance;
  if (min && assuranceRank(min) > assuranceRank("app_asserted")) line += ` --assurance ${min}`;
  if (requirements?.stepUp) line += " --step-up";
  return line;
}

export function approveHint(taskId: string, dir: string | null, requirements?: ApproveRequirements | null): string {
  const flag = dir ? ` --dir ${dir}` : "";
  return `Task ${taskId} is waiting for approval. Approve: ${approveCommandLine(taskId, dir, requirements)}  Reject: actledger reject ${taskId}${flag} --note "<reason>"`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "tool call failed";
}

function denyFromWaitError(error: unknown): ToolGateDeny | null {
  if (error instanceof ApprovalRejected) {
    const reason = error.task.decision.result === "deny" ? "policy_denied" : "rejected";
    return {
      kind: "deny",
      taskId: error.task.id,
      reason,
      message: error.message,
      state: "rejected",
      cause: error,
    };
  }
  if (error instanceof ApprovalExpired) {
    const task = error.task;
    if (!task) return null;
    const reason = task.state === "pending_approval" ? "timeout" : "expired";
    return {
      kind: "deny",
      taskId: task.id,
      reason,
      message: error.message,
      state: task.state,
      cause: error,
    };
  }
  if (error instanceof ApprovalRevoked) {
    return {
      kind: "deny",
      taskId: error.task.id,
      reason: "revoked",
      message: error.message,
      state: error.task.state,
      cause: error,
    };
  }
  return null;
}

class ToolGateImpl<I> implements ToolGate<I> {
  readonly mode: ToolGateMode;

  constructor(private readonly opts: ToolGateOptions<I>) {
    this.mode = opts.mode;
  }

  private resolve(toolName: string, input: I): {
    action: RequestInput["action"];
    payload: Payload;
    intent?: string;
    idempotencyKey?: string;
    readOnly: boolean;
    expiresIn?: number;
    metadata?: Record<string, unknown>;
    principalId: string;
  } {
    const mapping = (this.opts.map ?? defaultToolMapping)(toolName, input);
    const action = typeof mapping.action === "string" ? { type: mapping.action } : mapping.action;
    const payload = mapping.payload ?? defaultPayload(action.type, input);
    if (payload.action !== action.type) payload.action = action.type;
    const principalId =
      typeof this.opts.principal === "string" ? this.opts.principal : this.opts.principal(toolName, input);
    return {
      action,
      payload,
      intent: mapping.intent,
      idempotencyKey: mapping.idempotencyKey,
      readOnly: mapping.readOnly ?? false,
      expiresIn: mapping.expiresIn,
      metadata: mapping.metadata,
      principalId,
    };
  }

  private async settle(handle: TaskHandle): Promise<ToolGateDecision> {
    switch (handle.state) {
      case "approved": {
        const run = await handle.claim();
        return {
          kind: "allow",
          run,
          taskId: run.taskId,
          approvedPayload: run.approvedPayload,
          degraded: false,
        };
      }
      case "pending_approval":
        return {
          kind: "pending",
          taskId: handle.id,
          approveHint: this.opts.ledger.approveHint(handle.id, handle.decision),
        };
      case "rejected": {
        const reason = handle.decision.result === "deny" ? "policy_denied" : "rejected";
        const cause = new ApprovalRejected(handle);
        return {
          kind: "deny",
          taskId: handle.id,
          reason,
          message: cause.message,
          state: "rejected",
          cause,
        };
      }
      case "expired": {
        const cause = new ApprovalExpired(handle);
        return {
          kind: "deny",
          taskId: handle.id,
          reason: "expired",
          message: cause.message,
          state: "expired",
          cause,
        };
      }
      case "revoked": {
        const cause = new ApprovalRevoked(handle);
        return {
          kind: "deny",
          taskId: handle.id,
          reason: "revoked",
          message: cause.message,
          state: "revoked",
          cause,
        };
      }
      case "drafted": {
        const cause = new LedgerError("invalid_transition", `task ${handle.id} is drafted, not approved`, 409);
        return {
          kind: "deny",
          taskId: handle.id,
          reason: "drafted",
          message: cause.message,
          state: "drafted",
          cause,
        };
      }
      case "prepared":
      case "executing":
      case "executed":
      case "failed":
      case "unknown":
        throw new LedgerError("invalid_transition", `task ${handle.id} is ${handle.state}, not approved`, 409);
      default: {
        const state: string = handle.state;
        throw new LedgerError("invalid_transition", `task ${handle.id} is ${state}, not approved`, 409);
      }
    }
  }

  async before(toolName: string, input: I): Promise<ToolGateDecision> {
    const resolved = this.resolve(toolName, input);
    const task = await this.opts.ledger.request({
      principalId: resolved.principalId,
      agentId: this.opts.agentId,
      intent: resolved.intent,
      action: resolved.action,
      payload: resolved.payload,
      idempotencyKey: resolved.idempotencyKey,
      readOnly: resolved.readOnly,
      expiresIn: resolved.expiresIn,
      metadata: resolved.metadata,
    });
    if (task.degraded) {
      return {
        kind: "allow",
        run: null,
        taskId: null,
        approvedPayload: resolved.payload,
        degraded: true,
      };
    }
    if (this.mode === "defer") return this.settle(task);
    let done: TaskHandle;
    try {
      done = await task.wait({ timeoutMs: this.opts.timeoutMs, pollMs: this.opts.pollMs ?? this.opts.ledger.pollMs });
    } catch (error) {
      const denied = denyFromWaitError(error);
      if (denied) return denied;
      throw error;
    }
    return this.settle(done);
  }

  async after(run: Run | null, outcome: ToolGateOutcome): Promise<Receipt | null> {
    if (run === null) return null;
    if ("error" in outcome) {
      const error: { code: string; message: string; retryable?: boolean } = {
        code: outcome.code ?? "tool_error",
        message: errorMessage(outcome.error),
      };
      if (outcome.retryable !== undefined) error.retryable = outcome.retryable;
      await run.fail({ error });
      return null;
    }
    return run.complete({
      executedPayload: outcome.executedPayload ?? run.approvedPayload,
      ...(outcome.externalProofs !== undefined ? { externalProofs: outcome.externalProofs } : {}),
      ...(outcome.record !== undefined ? { result: outcome.record } : {}),
    });
  }

  async resume(taskId: string): Promise<ToolGateDecision> {
    this.opts.ledger.sweep();
    const handle = await this.opts.ledger.getTask(taskId);
    if (!handle) throw new LedgerError("not_found", `task ${taskId} not found`, 404);
    return this.settle(handle);
  }
}

export function createToolGate<I = Record<string, unknown>>(opts: ToolGateOptions<I>): ToolGate<I> {
  return new ToolGateImpl(opts);
}
