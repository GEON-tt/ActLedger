import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { jcs, sha256Prefixed, commit } from "./canonical.js";
import { generateEd25519, randomKey, signerFromPem, type KeySet, type Signer } from "./crypto.js";
import { DEFAULT_POLICY } from "./default-policy.js";
import { LedgerError } from "./errors.js";
import { defaultIdFactory, type IdFactory } from "./ids.js";
import { hourInTimeZone, formatTimestamp, parseTimestamp } from "./time.js";
import { evaluate, type ActionRequest, type Decision } from "./policy/evaluate.js";
import { loadPolicy, type LoadedPolicy } from "./policy/load.js";
import { assuranceRank, coverageSchema, isUserAssurance, type CoverageEntry, type UserAssurance } from "./policy/schema.js";
import {
  compareWithDrift,
  normalizePayload,
  type Payload,
} from "./payload.js";
import { ERROR_CODE_RE, newSalt, payloadCommit, RECEIPT_V01, RECEIPT_V02, SECRETS_V, textCommit, type SecretsEntry } from "./secrets.js";
import { buildReceipt, payloadEvidence, type Actor, type EvidenceRef, type Receipt } from "./receipts.js";
import { assertTransition, type State } from "./states.js";
import { SqliteStore } from "./store/sqlite.js";
import type { ResolvedAction, StoredTaskError, TaskError, TaskRecord } from "./store/types.js";

export interface AppFile {
  id: string;
  name: string;
  apiKey: string;
  signingKid: string;
  timezone: string;
  createdAt: string;
}

export interface RequestInput {
  principalId: string;
  agentId?: string;
  intent?: string;
  action: ActionRequest;
  payload: Payload;
  expiresIn?: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalInput {
  approverPrincipalId: string;
  channel?: string;
  assurance: UserAssurance;
  presentedHash: string;
  editedPayload?: Payload | null;
  stepUp?: boolean;
  simulated?: boolean;
  /** Free-text note. `reason` is accepted as an alias and is never copied into the receipt. */
  note?: string;
  reason?: string;
  idempotencyKey?: string;
}

export interface TaskView {
  id: string;
  appId: string;
  principalId: string;
  agentId: string | null;
  intentCommit: string | null;
  action: ResolvedAction;
  payloadHash: string;
  approvedPayloadHash: string | null;
  integrationMode: "recorded" | "enforced";
  coverageVia: string | null;
  coverageMatched: boolean;
  state: State;
  decision: Decision;
  approvalId: string | null;
  claimedAt: string | null;
  executionDeadline: string | null;
  claimDeadline: string | null;
  executedHash: string | null;
  contentMatch: boolean | null;
  mismatch: boolean;
  error: StoredTaskError | null;
  expiresAt: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequestResult {
  task: TaskView;
  receipts: Receipt[];
}

export interface ClaimResult {
  task: TaskView;
  approvedPayload: Payload;
  approvedPayloadHash: string;
  executionDeadline: string;
  receipt: Receipt;
}

export interface CompleteInput {
  executedPayload: Payload;
  externalProofs?: Array<{ type: string; value: unknown }>;
  result?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface CompleteResult {
  task: TaskView;
  contentMatch: boolean;
  receipt: Receipt;
}

export interface MutationResult {
  task: TaskView;
  receipt: Receipt;
}

export interface FailInput {
  error: TaskError;
  partial?: boolean;
  idempotencyKey?: string;
}

export interface ReconcileInput {
  outcome: "executed" | "failed";
  executedPayload?: Payload;
  externalProofs?: Array<{ type: string; value: unknown }>;
  note?: string;
}

export interface ViolationInput {
  principalId?: string;
  agentId?: string;
  actionType: string;
  description: string;
}

export interface SweepResult {
  expired: string[];
  unknown: string[];
}

export interface EngineOptions {
  dir: string;
  now?: () => Date;
  newId?: IdFactory;
  coverageOverlay?: CoverageEntry[];
}

const AGENT = "local-agent";

function readJson<T>(file: string): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    throw new LedgerError("not_found", `missing ${file}`, 404);
  }
}

function defined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function omit(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

const IDEMPOTENCY_DROP = new Set([
  "approvedPayload",
  "executedPayload",
  "editedPayload",
  "plaintext",
  "externalProofs",
  "text",
  "intent",
  "note",
  "reason",
  "message",
]);

function redactIdempotency(value: unknown): unknown {
  return stripIdempotency(JSON.parse(JSON.stringify(value)) as unknown);
}

function isReceiptRecord(record: Record<string, unknown>): boolean {
  return record.v === RECEIPT_V01 || record.v === RECEIPT_V02;
}

function stripIdempotency(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripIdempotency);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  // Receipt reasons are enums. Leave the signed receipt intact.
  if (isReceiptRecord(record)) return record;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (IDEMPOTENCY_DROP.has(key)) continue;
    if (key === "value" && typeof record.type === "string" && !("alg" in record)) continue;
    if ((key === "args" || key === "content" || key === "allowed_drift") && "action" in record) continue;
    out[key] = stripIdempotency(child);
  }
  return out;
}

const MAX_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

function effectToState(effect: Decision["result"]): State {
  switch (effect) {
    case "allow":
      return "approved";
    case "require_approval":
      return "pending_approval";
    case "deny":
      return "rejected";
    case "draft_only":
      return "drafted";
  }
}

function actionBody(action: ResolvedAction): Record<string, unknown> {
  return omit({
    type: action.type,
    level: action.level,
    resource: action.resource,
    blast_radius: action.blastRadius,
    reversible: action.reversible,
    amount: action.amount,
    attrs: Object.keys(action.attrs).length > 0 ? action.attrs : undefined,
  });
}

export function toView(task: TaskRecord): TaskView {
  return {
    id: task.id,
    appId: task.appId,
    principalId: task.principalId,
    agentId: task.agentId,
    intentCommit: task.intentCommit,
    action: task.action,
    payloadHash: task.payloadHash,
    approvedPayloadHash: task.approvedPayloadHash,
    integrationMode: task.integrationMode,
    coverageVia: task.coverageVia,
    coverageMatched: task.coverageMatched,
    state: task.state,
    decision: task.decision,
    approvalId: task.approvalId,
    claimedAt: task.claimedAt,
    executionDeadline: task.executionDeadline,
    claimDeadline: task.claimDeadline,
    executedHash: task.executedHash,
    contentMatch: task.contentMatch,
    mismatch: task.mismatch,
    error: task.error,
    expiresAt: task.expiresAt,
    idempotencyKey: task.idempotencyKey,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export class LedgerEngine {
  readonly appId: string;
  private policy: LoadedPolicy | null = null;
  private policyVersion = 0;
  private policyHash = "";
  private overlay: CoverageEntry[] = [];
  private overlayHash: string | null = null;

  constructor(
    private readonly dir: string,
    private readonly app: AppFile,
    private readonly keys: KeySet,
    private readonly signer: Signer,
    private readonly store: SqliteStore,
    private readonly now: () => Date,
    private readonly ids: IdFactory,
  ) {
    this.appId = app.id;
  }

  close(): void {
    this.store.close();
  }

  request(input: RequestInput): RequestResult {
    return this.tx(() => {
      this.syncPolicy();
      if (input.idempotencyKey) {
        const previous = this.store.findTaskByIdempotency(this.appId, input.idempotencyKey);
        if (previous?.state === "unknown") {
          throw new LedgerError(
            "unresolved_unknown",
            `task ${previous.id} is unknown and must be reconciled before retrying`,
            409,
          );
        }
      }
      return this.withIdempotency("request", input.idempotencyKey, this.requestCanon(input), () =>
        this.createTask(input),
      );
    });
  }

  getTask(id: string): TaskView | null {
    const task = this.store.getTask(this.appId, id);
    return task ? toView(task) : null;
  }

  taskPayload(taskId: string): Payload {
    return this.readPayload(this.must(taskId));
  }

  /** Decrypted intent for CLI display. Throws `not_found` after the principal is shredded. */
  taskIntent(taskId: string): string | null {
    return this.taskSecret(this.must(taskId)).intent;
  }

  listTasks(filter?: { state?: State }): TaskView[] {
    return this.store.listTasks(this.appId, filter?.state).map(toView);
  }

  approve(taskId: string, input: ApprovalInput): MutationResult {
    const outcome = this.tx(() => {
      this.syncPolicy();
      return this.withIdempotency("approve", input.idempotencyKey, defined(input), () => {
        const task = this.must(taskId);
        if (
          task.state === "pending_approval" &&
          task.expiresAt &&
          this.now().getTime() > parseTimestamp(task.expiresAt).getTime()
        ) {
          const moved = this.transition(task, "expired", systemActor(), { reason: "approval_timeout" }, {});
          return { expired: true as const, task: toView(moved.task), receipt: moved.receipt };
        }
        const moved = this.applyApproval(task, input, "approve");
        return { expired: false as const, task: toView(moved.task), receipt: moved.receipt };
      }, taskId);
    });
    if (outcome.expired) throw new LedgerError("task_expired", `task ${taskId} has expired`, 410);
    return { task: outcome.task, receipt: outcome.receipt };
  }

  reject(taskId: string, input: ApprovalInput): MutationResult {
    const outcome = this.tx(() => {
      this.syncPolicy();
      return this.withIdempotency(
        "reject",
        input.idempotencyKey,
        defined(input),
        () => {
          const task = this.must(taskId);
          if (
            task.state === "pending_approval" &&
            task.expiresAt &&
            this.now().getTime() > parseTimestamp(task.expiresAt).getTime()
          ) {
            const moved = this.transition(task, "expired", systemActor(), { reason: "approval_timeout" }, {});
            return { expired: true as const, task: toView(moved.task), receipt: moved.receipt };
          }
          const moved = this.applyApproval(task, input, "reject");
          return { expired: false as const, task: toView(moved.task), receipt: moved.receipt };
        },
        taskId,
      );
    });
    if (outcome.expired) throw new LedgerError("task_expired", `task ${taskId} has expired`, 410);
    return { task: outcome.task, receipt: outcome.receipt };
  }

  claim(taskId: string, opts?: { idempotencyKey?: string; agentId?: string }): ClaimResult {
    const outcome = this.tx(() => {
      this.syncPolicy();
      return this.withIdempotency(
        "claim",
        opts?.idempotencyKey,
        { taskId, agentId: opts?.agentId ?? null },
        () => {
          const task = this.must(taskId);
          if (task.state === "expired") {
            throw new LedgerError("task_expired", `task ${taskId} has expired`, 410);
          }
          if (
            task.state === "approved" &&
            task.claimDeadline &&
            this.now().getTime() > parseTimestamp(task.claimDeadline).getTime()
          ) {
            const moved = this.transition(task, "expired", systemActor(), { reason: "claim_deadline" }, {});
            return { expired: true as const, task: toView(moved.task), receipt: moved.receipt };
          }
          if (task.state !== "approved") {
            if (task.claimedAt) throw new LedgerError("already_claimed", `task ${taskId} is already claimed`, 409);
            throw new LedgerError("invalid_transition", `task ${taskId} is in state ${task.state}`, 409);
          }
          const approvedPayload = this.readPayload(task);
          const approvedPayloadHash = task.approvedPayloadHash ?? task.payloadHash;
          const executionDeadline = formatTimestamp(
            new Date(this.now().getTime() + task.decision.executionTimeoutMs),
          );
          const claimedAt = formatTimestamp(this.now());
          const moved = this.transition(
            task,
            "executing",
            { type: "agent", id: opts?.agentId ?? task.agentId ?? AGENT },
            { approved_payload_hash: approvedPayloadHash },
            { claimedAt, executionDeadline },
          );
          return {
            expired: false as const,
            task: toView(moved.task),
            approvedPayload,
            approvedPayloadHash,
            executionDeadline,
            receipt: moved.receipt,
          };
        },
        taskId,
      );
    });
    if (outcome.expired) throw new LedgerError("task_expired", `task ${taskId} has expired`, 410);
    return {
      task: outcome.task,
      approvedPayload: outcome.approvedPayload,
      approvedPayloadHash: outcome.approvedPayloadHash,
      executionDeadline: outcome.executionDeadline,
      receipt: outcome.receipt,
    };
  }

  complete(taskId: string, input: CompleteInput): CompleteResult {
    const outcome = this.tx(() => {
      this.syncPolicy();
      return this.withIdempotency(
        "complete",
        input.idempotencyKey,
        defined(input),
        () => this.finish(taskId, input, "agent"),
        taskId,
      );
    });
    if (outcome.strictMismatch) {
      throw new LedgerError(
        "content_mismatch",
        "executed payload does not match the approved payload",
        422,
        { task: outcome.task, receipt: outcome.receipt },
      );
    }
    return { task: outcome.task, contentMatch: outcome.contentMatch, receipt: outcome.receipt };
  }

  fail(taskId: string, input: FailInput): MutationResult {
    return this.tx(() => {
      this.syncPolicy();
      return this.withIdempotency("fail", input.idempotencyKey, defined(input), () => {
        if (!ERROR_CODE_RE.test(input.error.code)) {
          throw new LedgerError("invalid_request", "error.code must match /^[a-z0-9_.]{1,64}$/", 400);
        }
        jcs(input.error);
        const task = this.mustExecuting(taskId);
        const salt = this.taskSalt(task);
        const stored = storedError(input.error.code, textCommit(salt, input.error.message), input.error.retryable);
        this.putPlain(task.principalId, task.id, "error", { code: input.error.code, message: input.error.message });
        const moved = this.transition(
          task,
          "failed",
          { type: "agent", id: task.agentId ?? AGENT },
          { error: stored, partial: input.partial ?? false },
          { error: stored, contentMatch: null, mismatch: false },
        );
        return { task: toView(moved.task), receipt: moved.receipt };
      }, taskId);
    });
  }

  revoke(taskId: string, input: { actor: Actor; reason?: string; note?: string; idempotencyKey?: string }): MutationResult {
    return this.tx(() => {
      this.syncPolicy();
      return this.withIdempotency("revoke", input.idempotencyKey, defined(input), () => {
        const task = this.must(taskId);
        if (task.state !== "pending_approval" && task.state !== "approved") {
          throw new LedgerError(
            "invalid_transition",
            `task ${taskId} is in state ${task.state} and can no longer be revoked`,
            409,
          );
        }
        const note = input.note ?? input.reason;
        const extra: Record<string, unknown> = { reason: "revoked" };
        if (note) extra.note_commit = this.storeNote(task, "revoke", note);
        const moved = this.transition(task, "revoked", input.actor, extra, {});
        return { task: toView(moved.task), receipt: moved.receipt };
      }, taskId);
    });
  }

  reconcile(taskId: string, input: ReconcileInput): MutationResult | CompleteResult {
    if (input.outcome === "executed" && !input.executedPayload) {
      throw new LedgerError("invalid_request", "executedPayload is required to reconcile as executed", 400);
    }
    const outcome = this.tx(() => {
      this.syncPolicy();
      const task = this.must(taskId);
      if (task.state !== "unknown") {
        throw new LedgerError("invalid_transition", `task ${taskId} is in state ${task.state}`, 409);
      }
      if (input.outcome === "failed") {
        const salt = this.taskSalt(task);
        const message = input.note ?? "not executed";
        const stored = storedError("reconciled", textCommit(salt, message));
        this.putPlain(task.principalId, task.id, "error", { code: "reconciled", message });
        const extra: Record<string, unknown> = {
          reason: "reconciled_not_executed",
          error: stored,
        };
        if (input.note) extra.note_commit = this.storeNote(task, "reconcile", input.note, salt);
        const moved = this.transition(task, "failed", systemActor("reconcile"), extra, { error: stored });
        return { kind: "failed" as const, task: toView(moved.task), receipt: moved.receipt };
      }
      const finished = this.finish(
        taskId,
        {
          executedPayload: input.executedPayload!,
          externalProofs: input.externalProofs,
          result: { reconciled: true },
        },
        "system",
        input.note,
      );
      return { kind: "executed" as const, ...finished };
    });
    if (outcome.kind === "executed" && outcome.strictMismatch) {
      throw new LedgerError(
        "content_mismatch",
        "executed payload does not match the approved payload",
        422,
        { task: outcome.task, receipt: outcome.receipt },
      );
    }
    return { task: outcome.task, receipt: outcome.receipt, ...(outcome.kind === "executed" ? { contentMatch: outcome.contentMatch } : {}) };
  }

  reportViolation(input: ViolationInput): Receipt {
    return this.tx(() => {
      this.syncPolicy();
      if (!input.actionType || !input.description) {
        throw new LedgerError("invalid_request", "actionType and description are required", 400);
      }
      const salt = newSalt();
      const receipt = this.appendReceipt({
        taskId: null,
        transition: null,
        actor: { type: "agent", id: input.agentId ?? AGENT },
        body: omit({
          kind: "violation",
          action_type: input.actionType,
          description_commit: textCommit(salt, input.description),
          principal_id: input.principalId,
          agent_id: input.agentId,
        }),
        evidence: [],
      });
      this.putPlain(input.principalId ?? `app:${this.appId}`, null, "violation", {
        salt: salt.toString("base64url"),
        description: input.description,
        receipt_id: receipt.id,
      });
      this.store.insertViolation({
        id: this.ids("vio"),
        appId: this.appId,
        receiptId: receipt.id,
        payloadJson: JSON.stringify({
          principalId: input.principalId ?? null,
          agentId: input.agentId ?? null,
          actionType: input.actionType,
        }),
        createdAt: formatTimestamp(this.now()),
      });
      return receipt;
    });
  }

  sweep(): SweepResult {
    return this.tx(() => {
      this.syncPolicy();
      const expired: string[] = [];
      const unknown: string[] = [];
      const now = this.now().getTime();
      for (const task of this.store.listTasks(this.appId)) {
        if (task.state === "pending_approval" && task.expiresAt && now > parseTimestamp(task.expiresAt).getTime()) {
          this.transition(task, "expired", systemActor(), { reason: "approval_timeout" }, {});
          expired.push(task.id);
        } else if (
          task.state === "approved" &&
          task.claimDeadline &&
          now > parseTimestamp(task.claimDeadline).getTime()
        ) {
          this.transition(task, "expired", systemActor(), { reason: "claim_deadline" }, {});
          expired.push(task.id);
        } else if (
          task.state === "executing" &&
          task.executionDeadline &&
          now > parseTimestamp(task.executionDeadline).getTime()
        ) {
          this.transition(task, "unknown", systemActor(), { reason: "execution_timeout" }, {});
          unknown.push(task.id);
        }
      }
      return { expired, unknown };
    });
  }

  exportReceipts(fromSeq?: number, toSeq?: number): Receipt[] {
    return this.store.listReceipts(this.appId, fromSeq, toSeq);
  }

  exportSecrets(fromSeq?: number, toSeq?: number): SecretsEntry[] {
    const receipts = this.store.listReceipts(this.appId, fromSeq, toSeq);
    const taskIds: string[] = [];
    const seen = new Set<string>();
    for (const receipt of receipts) {
      if (!receipt.task_id || seen.has(receipt.task_id)) continue;
      seen.add(receipt.task_id);
      taskIds.push(receipt.task_id);
    }
    const entries: SecretsEntry[] = [];
    for (const taskId of taskIds) {
      const task = this.store.getTask(this.appId, taskId);
      if (!task) continue;
      entries.push(this.taskSecretsEntry(task));
    }
    const inRange = new Set(
      receipts.filter((receipt) => receipt.body.kind === "violation").map((receipt) => receipt.id),
    );
    for (const row of this.store.listSecretsByKind(this.appId, "violation")) {
      const plain = row.plaintext;
      if (!plain || typeof plain !== "object" || Array.isArray(plain)) continue;
      const record = plain as { salt?: unknown; description?: unknown; receipt_id?: unknown };
      if (typeof record.receipt_id !== "string" || !inRange.has(record.receipt_id)) continue;
      if (typeof record.salt !== "string" || typeof record.description !== "string") continue;
      entries.push({
        v: SECRETS_V,
        kind: "violation",
        receipt_id: record.receipt_id,
        salt: record.salt,
        description: record.description,
      });
    }
    return entries;
  }

  chainHead(): { seq: number; hash: string } | null {
    return this.store.chainHead(this.appId);
  }

  publicKeys(): KeySet {
    return this.keys;
  }

  policyInfo(): { version: number; hash: string; warnings: LoadedPolicy["warnings"] } {
    return this.tx(() => {
      this.syncPolicy();
      return {
        version: this.policyVersion,
        hash: this.policyHash,
        warnings: this.policy?.warnings ?? [],
      };
    });
  }

  setCoverageOverlay(entries: CoverageEntry[]): Receipt | null {
    const normalized = entries.map((entry, index) => {
      const parsed = coverageSchema.safeParse(entry);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new LedgerError(
          "invalid_request",
          `coverage overlay [${index}]: ${issue?.message ?? "invalid"}`,
          400,
        );
      }
      if (!parsed.data.via) {
        throw new LedgerError("invalid_request", `coverage overlay [${index}]: via is required`, 400);
      }
      return { action: parsed.data.action, mode: parsed.data.mode, via: parsed.data.via };
    });
    const hash = sha256Prefixed(jcs(normalized));
    if (hash === this.overlayHash) return null;
    return this.tx(() => {
      this.syncPolicy();
      if (hash === this.overlayHash) return null;
      this.overlay = normalized;
      this.overlayHash = hash;
      return this.appendReceipt({
        taskId: null,
        transition: null,
        actor: systemActor(),
        body: {
          kind: "coverage.declared",
          scope: "process",
          policy_version: this.policyVersion,
          policy_hash: this.policyHash,
          overlay_hash: hash,
          entries: normalized,
        },
        evidence: [],
      });
    });
  }

  simulate(action: ActionRequest): { decision: Decision; state: State } {
    return this.tx(() => {
      this.syncPolicy();
      const decision = this.decide(action);
      return { decision, state: effectToState(decision.result) };
    });
  }

  getReceipt(id: string): Receipt | null {
    return this.store.getReceipt(this.appId, id);
  }

  shredPrincipal(principalId: string): void {
    this.store.shredPrincipal(this.appId, principalId);
  }

  syncPolicy(): void {
    const policyPath = path.join(this.dir, "policy.yaml");
    if (!fs.existsSync(policyPath)) {
      if (this.policy) return;
      throw new LedgerError("policy_invalid", `missing ${policyPath}`, 422);
    }
    const yamlText = fs.readFileSync(policyPath, "utf8");
    const hash = sha256Prefixed(yamlText);
    if (this.policy && hash === this.policyHash) return;
    try {
      const latest = this.store.latestPolicy();
      if (latest && latest.hash === hash) {
        this.policy = loadPolicy(yamlText);
        this.policyVersion = latest.version;
        this.policyHash = hash;
        return;
      }
      const loaded = loadPolicy(yamlText);
      const version = (latest?.version ?? 0) + 1;
      this.store.insertPolicy({
        version,
        hash,
        yaml: yamlText,
        documentJson: JSON.stringify(loaded.doc),
        createdAt: formatTimestamp(this.now()),
      });
      this.policy = loaded;
      this.policyVersion = version;
      this.policyHash = hash;
      this.appendReceipt({
        taskId: null,
        transition: null,
        actor: systemActor(),
        body: {
          kind: "policy.published",
          policy_version: version,
          policy_hash: hash,
          warnings: loaded.warnings,
        },
        evidence: [],
      });
    } catch (error) {
      if (this.policy && error instanceof LedgerError && error.code === "policy_invalid") return;
      throw error;
    }
  }

  private createTask(input: RequestInput): RequestResult {
    this.assertRequest(input);
    const decision = this.decide(input.action);
    const now = this.now();
    const createdAt = formatTimestamp(now);
    const id = this.ids("tsk");
    const salt = newSalt();
    const normalized = normalizePayload(input.payload);
    const hash = payloadCommit(salt, input.payload);
    const intentCommit = input.intent != null ? textCommit(salt, input.intent) : null;
    const secretId = this.ids("sec");
    this.store.putSecret({
      id: secretId,
      appId: this.appId,
      principalId: input.principalId,
      taskId: id,
      kind: "task",
      plaintext: {
        v: 1,
        salt: salt.toString("base64url"),
        intent: input.intent ?? null,
        payload: normalized,
      },
      createdAt,
    });
    const timeoutMs = input.expiresIn != null ? input.expiresIn * 1000 : decision.approvalTimeoutMs;
    const target = effectToState(decision.result);
    const approvedNow = target === "approved";
    const task: TaskRecord = {
      id,
      appId: this.appId,
      principalId: input.principalId,
      agentId: input.agentId ?? AGENT,
      intentCommit,
      action: {
        type: input.action.type,
        level: decision.level,
        resource: input.action.resource ?? null,
        blastRadius: decision.blastRadius,
        reversible: decision.reversible,
        amount: input.action.amount ?? null,
        attrs: input.action.attrs ?? {},
      },
      payloadHash: hash,
      approvedPayloadHash: approvedNow ? hash : null,
      payloadSecretId: secretId,
      approvedPayloadSecretId: null,
      integrationMode: decision.integrationMode,
      coverageVia: decision.coverageVia,
      coverageMatched: decision.coverageMatched,
      state: "prepared",
      decision,
      approvalId: null,
      claimedAt: null,
      executionDeadline: null,
      claimDeadline: approvedNow
        ? formatTimestamp(new Date(now.getTime() + decision.claimDeadlineMs))
        : null,
      executedHash: null,
      result: null,
      error: null,
      contentMatch: null,
      mismatch: false,
      compensates: null,
      expiresAt: formatTimestamp(new Date(now.getTime() + timeoutMs)),
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: input.metadata ?? null,
      createdAt,
      updatedAt: createdAt,
    };
    this.store.insertTask(task);
    const opened = this.appendReceipt({
      taskId: id,
      transition: { from: null, to: "prepared" },
      actor: { type: "agent", id: task.agentId ?? AGENT },
      body: this.contextBody(task, {}),
      evidence: [payloadEvidence(input.payload, hash)],
    });
    const extra: Record<string, unknown> = {};
    if (decision.result === "allow") {
      extra.approval = {
        approver: `policy:${decision.ruleId}`,
        assurance: "policy",
        decided_at: createdAt,
        presented_hash: hash,
      };
      extra.approved_payload_hash = hash;
    }
    if (decision.result === "deny") extra.reason = "denied_by_policy";
    if (decision.result === "draft_only") extra.reason = "draft_only";
    const moved = this.transition(task, target, { type: "policy", id: decision.ruleId }, extra, {});
    return { task: toView(moved.task), receipts: [opened, moved.receipt] };
  }

  private applyApproval(task: TaskRecord, input: ApprovalInput, decision: "approve" | "reject"): {
    task: TaskRecord;
    receipt: Receipt;
  } {
    if (task.state === "expired") {
      throw new LedgerError("task_expired", `task ${task.id} has expired`, 410);
    }
    if (task.state !== "pending_approval") {
      throw new LedgerError("invalid_transition", `task ${task.id} is in state ${task.state}`, 409);
    }
    if (input.presentedHash !== task.payloadHash) {
      throw new LedgerError(
        "presented_hash_mismatch",
        "presented_hash does not match the payload shown for approval",
        412,
      );
    }
    if (input.approverPrincipalId !== task.principalId) {
      throw new LedgerError("approver_mismatch", "approver does not match the task principal", 403);
    }
    if (!isUserAssurance(input.assurance)) {
      throw new LedgerError("invalid_request", `unknown assurance ${String(input.assurance)}`, 400);
    }
    if (decision === "approve") {
      if (task.decision.minAssurance && assuranceRank(input.assurance) < assuranceRank(task.decision.minAssurance)) {
        throw new LedgerError(
          "assurance_insufficient",
          `need ${task.decision.minAssurance}, got ${input.assurance}`,
          403,
        );
      }
      if (task.decision.stepUp && !input.stepUp) {
        throw new LedgerError("step_up_required", `step-up ${task.decision.stepUp} is required`, 403);
      }
    }
    let approvedHash = task.payloadHash;
    let approvedSecret: string | null = null;
    if (decision === "approve" && input.editedPayload) {
      if (!task.decision.allowEdit) {
        throw new LedgerError("invalid_request", "this rule does not allow editing before approval", 400);
      }
      if (input.editedPayload.action !== task.action.type) {
        throw new LedgerError("invalid_request", "edited payload action does not match the task", 400);
      }
      approvedHash = payloadCommit(this.taskSalt(task), input.editedPayload);
      approvedSecret = this.ids("sec");
      this.store.putSecret({
        id: approvedSecret,
        appId: this.appId,
        principalId: task.principalId,
        taskId: task.id,
        kind: "approved_payload",
        plaintext: normalizePayload(input.editedPayload),
        createdAt: formatTimestamp(this.now()),
      });
    }
    const note = decision === "reject" ? input.note ?? input.reason : undefined;
    const noteCommit = note ? this.storeNote(task, "reject", note) : null;
    const decidedAt = formatTimestamp(this.now());
    const approvalId = this.ids("apr");
    // No channel authenticator exists in this round, so a claimed step-up cannot be a real assertion.
    const simulated = Boolean(input.stepUp) || Boolean(input.simulated);
    this.store.insertApproval({
      id: approvalId,
      appId: this.appId,
      taskId: task.id,
      approverPrincipalId: input.approverPrincipalId,
      channel: input.channel ?? "cli",
      decision,
      presentedHash: input.presentedHash,
      editedPayloadHash: approvedSecret ? approvedHash : null,
      method: input.channel ?? "cli",
      stepUp: Boolean(input.stepUp),
      simulated,
      assurance: input.assurance,
      reason: decision === "reject" ? "rejected_by_user" : null,
      noteCommit,
      decidedAt,
    });
    const claimDeadline =
      decision === "approve"
        ? formatTimestamp(new Date(this.now().getTime() + task.decision.claimDeadlineMs))
        : null;
    return this.transition(
      task,
      decision === "approve" ? "approved" : "rejected",
      { type: "user", id: input.approverPrincipalId },
      {
        approval: omit({
          approval_id: approvalId,
          approver: input.approverPrincipalId,
          channel: input.channel ?? "cli",
          auth: {
            method: input.channel ?? "cli",
            step_up: input.stepUp ? task.decision.stepUp : null,
            simulated,
          },
          assurance: input.assurance,
          decided_at: decidedAt,
          presented_hash: input.presentedHash,
          edited_payload_hash: approvedSecret ? approvedHash : undefined,
        }),
        approved_payload_hash: decision === "approve" ? approvedHash : undefined,
        reason: decision === "reject" ? "rejected_by_user" : undefined,
        note_commit: noteCommit ?? undefined,
      },
      decision === "approve"
        ? {
            state: "approved",
            approvalId,
            approvedPayloadHash: approvedHash,
            approvedPayloadSecretId: approvedSecret,
            claimDeadline,
          }
        : { state: "rejected", approvalId },
    );
  }

  private finish(
    taskId: string,
    input: CompleteInput,
    actorKind: "agent" | "system",
    note?: string,
  ): { strictMismatch: boolean; contentMatch: boolean; task: TaskView; receipt: Receipt } {
    const task = this.mustExecuting(taskId);
    const approved = this.readPayload(task);
    const comparison = compareWithDrift(approved, input.executedPayload);
    const salt = this.taskSalt(task);
    const executedHash = payloadCommit(salt, input.executedPayload);
    if (input.result) jcs(input.result);
    this.putPlain(task.principalId, task.id, "executed_payload", {
      payload: normalizePayload(input.executedPayload),
      result: input.result ?? null,
    });
    const proofs = this.proofCommits(task, input.externalProofs);
    const noteCommit = actorKind === "system" && note ? this.storeNote(task, "reconcile", note, salt) : undefined;
    const body: Record<string, unknown> = {
      approved_payload_hash: task.approvedPayloadHash ?? task.payloadHash,
      executed_hash: executedHash,
      drift_applied: comparison.driftApplied,
      content_match: comparison.match,
      mismatch: !comparison.match,
      evidence_assurance: proofs.length > 0 ? "E2" : "E1",
      external_proofs: proofs,
      ...(actorKind === "system" ? { reconciled: true } : {}),
      ...(noteCommit ? { note_commit: noteCommit } : {}),
    };
    if (!comparison.match && task.decision.contentMode === "strict") {
      const message = "executed payload does not match the approved payload";
      const stored = storedError("content_mismatch", textCommit(salt, message));
      this.putPlain(task.principalId, task.id, "error", { code: "content_mismatch", message });
      const moved = this.transition(
        task,
        "failed",
        actorKind === "agent" ? { type: "agent", id: task.agentId ?? AGENT } : systemActor("reconcile"),
        { ...body, error: stored },
        {
          state: "failed",
          executedHash,
          contentMatch: false,
          mismatch: true,
          error: stored,
        },
      );
      return { strictMismatch: true, contentMatch: false, task: toView(moved.task), receipt: moved.receipt };
    }
    const moved = this.transition(
      task,
      "executed",
      actorKind === "agent" ? { type: "agent", id: task.agentId ?? AGENT } : systemActor("reconcile"),
      body,
      {
        state: "executed",
        executedHash,
        contentMatch: comparison.match,
        mismatch: !comparison.match,
      },
    );
    return {
      strictMismatch: false,
      contentMatch: comparison.match,
      task: toView(moved.task),
      receipt: moved.receipt,
    };
  }

  private mustExecuting(taskId: string): TaskRecord {
    const task = this.must(taskId);
    if (task.state !== "executing" && task.state !== "unknown") {
      throw new LedgerError("invalid_transition", `task ${taskId} is in state ${task.state}`, 409);
    }
    return task;
  }

  private proofCommits(
    task: TaskRecord,
    proofs: Array<{ type: string; value: unknown }> | undefined,
  ): Array<{ type: string; commit: string }> {
    const out: Array<{ type: string; commit: string }> = [];
    for (const [index, proof] of (proofs ?? []).entries()) {
      const salt = randomBytes(32);
      const id = this.ids("sec");
      this.store.putSecret({
        id,
        appId: this.appId,
        principalId: task.principalId,
        taskId: task.id,
        kind: "proof",
        plaintext: { salt: salt.toString("base64url"), value: proof.value, type: proof.type, index },
        createdAt: formatTimestamp(this.now()),
      });
      out.push({ type: proof.type, commit: commit(salt, proof.value) });
    }
    return out;
  }

  private readPayload(task: TaskRecord): Payload {
    if (task.approvedPayloadSecretId) {
      return this.store.getSecret(this.appId, task.approvedPayloadSecretId) as Payload;
    }
    return this.taskSecret(task).payload;
  }

  private taskSalt(task: TaskRecord): Buffer {
    return this.taskSecret(task).salt;
  }

  private taskSecret(task: TaskRecord): { salt: Buffer; intent: string | null; payload: Payload } {
    const plain = this.store.getSecret(this.appId, task.payloadSecretId);
    if (
      !plain ||
      typeof plain !== "object" ||
      Array.isArray(plain) ||
      typeof (plain as { salt?: unknown }).salt !== "string" ||
      !("payload" in plain)
    ) {
      throw new LedgerError("invalid_transition", "task secret has no salt", 409);
    }
    const record = plain as { salt: string; intent?: string | null; payload: Payload };
    return {
      salt: Buffer.from(record.salt, "base64url"),
      intent: record.intent ?? null,
      payload: record.payload,
    };
  }

  private storeNote(task: TaskRecord, field: "reject" | "revoke" | "reconcile", text: string, salt?: Buffer): string {
    const key = salt ?? this.taskSalt(task);
    this.putPlain(task.principalId, task.id, "note", { field, text });
    return textCommit(key, text);
  }

  private putPlain(principalId: string, taskId: string | null, kind: string, plaintext: unknown): void {
    this.store.putSecret({
      id: this.ids("sec"),
      appId: this.appId,
      principalId,
      taskId,
      kind,
      plaintext,
      createdAt: formatTimestamp(this.now()),
    });
  }

  private taskSecretsEntry(task: TaskRecord): SecretsEntry {
    const rows = this.store.listSecrets(this.appId, task.id);
    if (rows.length === 0 || rows.every((row) => row.plaintext == null)) {
      return {
        v: SECRETS_V,
        kind: "task",
        task_id: task.id,
        principal_id: task.principalId,
        shredded: true,
      };
    }
    const taskRow = rows.find((row) => row.kind === "task" || row.kind === "payload");
    const notes = { reject: null as string | null, revoke: null as string | null, reconcile: null as string | null };
    for (const row of rows) {
      if (row.kind !== "note" || !row.plaintext || typeof row.plaintext !== "object" || Array.isArray(row.plaintext)) {
        continue;
      }
      const note = row.plaintext as { field?: unknown; text?: unknown };
      if (
        (note.field === "reject" || note.field === "revoke" || note.field === "reconcile") &&
        typeof note.text === "string"
      ) {
        notes[note.field] = note.text;
      }
    }
    const approved = lastPlain(rows, "approved_payload");
    const executed = lastPlain(rows, "executed_payload");
    const executedRecord =
      executed && typeof executed === "object" && !Array.isArray(executed)
        ? (executed as { payload?: Record<string, unknown> | null; result?: unknown })
        : null;
    const error = lastPlain(rows, "error");
    const proofs = rows.flatMap((row, index) => {
      if (row.kind !== "proof" || !row.plaintext || typeof row.plaintext !== "object" || Array.isArray(row.plaintext)) {
        return [];
      }
      const proof = row.plaintext as { salt?: unknown; value?: unknown; type?: unknown; index?: unknown };
      if (typeof proof.salt !== "string") return [];
      return [
        {
          index: typeof proof.index === "number" ? proof.index : index,
          ...(typeof proof.type === "string" ? { type: proof.type } : {}),
          salt: proof.salt,
          value: proof.value ?? null,
        },
      ];
    });
    proofs.sort((a, b) => a.index - b.index);
    const envelope = asTaskEnvelope(taskRow?.plaintext);
    const legacyPayload =
      !envelope && taskRow?.plaintext && typeof taskRow.plaintext === "object" && !Array.isArray(taskRow.plaintext)
        ? (taskRow.plaintext as Record<string, unknown>)
        : null;
    return {
      v: SECRETS_V,
      kind: "task",
      task_id: task.id,
      principal_id: task.principalId,
      payload_salt: envelope ? envelope.salt : null,
      intent: envelope ? envelope.intent : this.store.legacyIntent(task.id),
      payload: envelope ? envelope.payload : legacyPayload,
      approved_payload:
        approved && typeof approved === "object" && !Array.isArray(approved)
          ? (approved as Record<string, unknown>)
          : null,
      executed_payload: executedRecord?.payload ?? null,
      result: executedRecord?.result ?? null,
      error:
        error && typeof error === "object" && !Array.isArray(error)
          ? (error as { code: string; message: string })
          : null,
      notes,
      proofs,
    };
  }

  private decide(action: ActionRequest): Decision {
    if (!this.policy) throw new LedgerError("policy_invalid", "policy is not loaded", 422);
    const policy = this.overlay.length
      ? {
          ...this.policy,
          doc: {
            ...this.policy.doc,
            coverage: [...this.overlay, ...(this.policy.doc.coverage ?? [])],
          },
        }
      : this.policy;
    return evaluate(policy, action, {
      hour: hourInTimeZone(this.now(), policy.defaults.timezone),
      grantLevel: 0,
      policyVersion: this.policyVersion,
    });
  }

  private assertRequest(input: RequestInput): void {
    if (input.expiresIn != null) {
      if (!Number.isSafeInteger(input.expiresIn) || input.expiresIn < 1 || input.expiresIn > MAX_EXPIRES_IN_SECONDS) {
        throw new LedgerError("invalid_request", "expiresIn must be a positive integer of at most 7 days", 400);
      }
    }
    if (!input.principalId) throw new LedgerError("invalid_request", "principalId is required", 400);
    if (!input.action?.type) throw new LedgerError("invalid_request", "action.type is required", 400);
    if (input.payload.action !== input.action.type) {
      throw new LedgerError("invalid_request", "payload.action must equal action.type", 400);
    }
    if (input.action.amount) {
      if (!Number.isSafeInteger(input.action.amount.value)) {
        throw new LedgerError("non_canonical_number", "amount.value must be an integer in minor units", 400);
      }
      if (!/^[A-Z]{3}$/.test(input.action.amount.currency)) {
        throw new LedgerError("invalid_request", "amount.currency must be a 3-letter code", 400);
      }
    }
    jcs(defined(input.action));
    normalizePayload(input.payload);
    if (input.metadata) jcs(input.metadata);
  }

  private requestCanon(input: RequestInput): unknown {
    this.assertRequest(input);
    return {
      principalId: input.principalId,
      agentId: input.agentId ?? null,
      intent: input.intent ?? null,
      action: defined(input.action),
      payload: normalizePayload(input.payload),
      expiresIn: input.expiresIn ?? null,
      metadata: input.metadata ?? null,
    };
  }

  private transition(
    task: TaskRecord,
    to: State,
    actor: Actor,
    extra: Record<string, unknown>,
    patch: Partial<TaskRecord>,
  ): { task: TaskRecord; receipt: Receipt } {
    assertTransition(task.state, to);
    const updatedAt = formatTimestamp(this.now());
    const ok = this.store.updateTask(task.id, task.state, { ...patch, state: to, updatedAt });
    if (!ok) {
      const fresh = this.store.getTask(this.appId, task.id);
      if (fresh?.claimedAt && to === "executing") {
        throw new LedgerError("already_claimed", `task ${task.id} is already claimed`, 409);
      }
      throw new LedgerError("invalid_transition", `task ${task.id} is in state ${fresh?.state ?? "missing"}`, 409);
    }
    const next = this.store.getTask(this.appId, task.id);
    if (!next) throw new LedgerError("not_found", task.id, 404);
    const receipt = this.appendReceipt({
      taskId: task.id,
      transition: { from: task.state, to },
      actor,
      body: this.contextBody(next, extra),
      evidence: [],
    });
    return { task: next, receipt };
  }

  private contextBody(task: TaskRecord, extra: Record<string, unknown>): Record<string, unknown> {
    return {
      kind: "task.transition",
      initiator: omit({
        principal_id: task.principalId,
        agent_id: task.agentId,
        intent_commit: task.intentCommit,
      }),
      action: actionBody(task.action),
      policy: omit({
        rule_id: task.decision.ruleId,
        policy_version: task.decision.policyVersion,
        ladder_level: task.decision.ladderLevel,
        min_assurance: task.decision.minAssurance,
        step_up: task.decision.stepUp,
      }),
      integration: omit({
        mode: task.integrationMode,
        via: task.coverageVia,
        coverage: task.coverageMatched ? "matched" : "none",
        coverage_version: task.decision.policyVersion,
      }),
      payload_hash: task.payloadHash,
      ...omit(extra),
    };
  }

  private appendReceipt(input: {
    taskId: string | null;
    transition: { from: string | null; to: string } | null;
    actor: Actor;
    body: Record<string, unknown>;
    evidence: EvidenceRef[];
  }): Receipt {
    const { seq, prevHash } = this.store.allocateSeq(this.appId);
    const receipt = buildReceipt(
      {
        id: this.ids("rcp"),
        app_id: this.appId,
        seq,
        prev_hash: prevHash,
        task_id: input.taskId,
        transition: input.transition,
        actor: input.actor,
        body: input.body,
        evidence: input.evidence,
        issued_at: formatTimestamp(this.now()),
      },
      this.signer,
    );
    this.store.insertReceipt(receipt);
    return receipt;
  }

  private materialize<T>(scope: string, stored: T): T {
    if (scope !== "claim" || !stored || typeof stored !== "object") return stored;
    const record = stored as { expired?: boolean; task?: { id?: string } };
    if (record.expired || !record.task?.id) return stored;
    const task = this.must(record.task.id);
    return { ...(stored as Record<string, unknown>), approvedPayload: this.readPayload(task) } as T;
  }

  private withIdempotency<T>(
    scope: string,
    key: string | undefined,
    request: unknown,
    fn: () => T,
    taskId?: string,
  ): T {
    if (!key) return fn();
    const scopeKey = taskId ? `${scope}:${taskId}:${key}` : `${scope}:${key}`;
    const hash = this.store.idempotencyDigest(jcs(request));
    const existing = this.store.getIdempotency(this.appId, scopeKey);
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new LedgerError("idempotency_conflict", `idempotency key ${key} was reused with a different body`, 409);
      }
      return this.materialize(scope, JSON.parse(existing.responseJson) as T);
    }
    const result = fn();
    this.store.insertIdempotency(
      this.appId,
      scopeKey,
      hash,
      JSON.stringify(redactIdempotency(result)),
      formatTimestamp(this.now()),
    );
    return result;
  }

  private must(id: string): TaskRecord {
    const task = this.store.getTask(this.appId, id);
    if (!task) throw new LedgerError("not_found", `task ${id} not found`, 404);
    return task;
  }

  private tx<T>(fn: () => T): T {
    return this.store.transaction(fn);
  }
}

function systemActor(id = "actledger"): Actor {
  return { type: "system", id };
}

function storedError(code: string, messageCommit: string, retryable?: boolean): StoredTaskError {
  const error: StoredTaskError = { code, message_commit: messageCommit };
  if (retryable !== undefined) error.retryable = retryable;
  return error;
}

function asTaskEnvelope(
  value: unknown,
): { salt: string; intent: string | null; payload: Record<string, unknown> } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.salt !== "string" || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    return null;
  }
  return {
    salt: record.salt,
    intent: typeof record.intent === "string" ? record.intent : null,
    payload: record.payload as Record<string, unknown>,
  };
}

function lastPlain(
  rows: Array<{ kind: string; plaintext: unknown | null }>,
  kind: string,
): unknown | null {
  const matches = rows.filter((row) => row.kind === kind && row.plaintext != null);
  return matches.length > 0 ? matches[matches.length - 1].plaintext : null;
}

export function openLedger(opts: EngineOptions): LedgerEngine {
  const dir = path.resolve(opts.dir);
  const app = readJson<AppFile>(path.join(dir, "app.json"));
  const keys = readJson<KeySet>(path.join(dir, "keys.json"));
  const pem = fs.readFileSync(path.join(dir, "keys", "ed25519.pem"), "utf8");
  const master = fs.readFileSync(path.join(dir, "keys", "master.key"));
  const now = opts.now ?? (() => new Date());
  const store = new SqliteStore(path.join(dir, "ledger.db"), master);
  const unfinished = store.legacyOpenTasks(app.id);
  if (unfinished > 0) {
    store.close();
    throw new LedgerError("invalid_request", "请用旧版本完成这些任务，或重新 init", 400);
  }
  store.promoteSchema();
  store.ensureChainHead(app.id);
  const engine = new LedgerEngine(dir, app, keys, signerFromPem(app.signingKid, pem), store, now, opts.newId ?? defaultIdFactory(now));
  try {
    store.transaction(() => engine.syncPolicy());
    if (opts.coverageOverlay) engine.setCoverageOverlay(opts.coverageOverlay);
  } catch (error) {
    store.close();
    throw error;
  }
  return engine;
}

export function initLocalDir(
  dir: string,
  opts?: { policyYaml?: string },
): { appId: string; apiKey: string; warnings: LoadedPolicy["warnings"] } {
  const abs = path.resolve(dir);
  if (fs.existsSync(path.join(abs, "app.json"))) {
    throw new LedgerError("invalid_request", `${abs} is already initialized`, 400);
  }
  fs.mkdirSync(path.join(abs, "keys"), { recursive: true });
  const { publicKeyRaw, privatePem } = generateEd25519();
  const createdAt = formatTimestamp(new Date());
  const appId = defaultIdFactory()("app");
  const year = new Date().getUTCFullYear();
  const kid = `${appId}#k${year}a`;
  const apiKey = `sk_test_${randomBytes(24).toString("base64url")}`;
  fs.writeFileSync(path.join(abs, "keys", "ed25519.pem"), privatePem, { mode: 0o600 });
  fs.writeFileSync(path.join(abs, "keys", "master.key"), randomKey(), { mode: 0o600 });
  const keys: KeySet = {
    keys: [
      {
        kid,
        alg: "Ed25519",
        public_key: publicKeyRaw.toString("base64url"),
        created_at: createdAt,
        retired_at: null,
      },
    ],
  };
  fs.writeFileSync(path.join(abs, "keys.json"), `${JSON.stringify(keys, null, 2)}\n`);
  const app: AppFile = { id: appId, name: "local", apiKey, signingKid: kid, timezone: "UTC", createdAt };
  fs.writeFileSync(path.join(abs, "app.json"), `${JSON.stringify(app, null, 2)}\n`);
  fs.writeFileSync(path.join(abs, "policy.yaml"), opts?.policyYaml ?? DEFAULT_POLICY);
  const engine = openLedger({ dir: abs });
  const warnings = engine.policyInfo().warnings;
  engine.close();
  return { appId, apiKey, warnings };
}
