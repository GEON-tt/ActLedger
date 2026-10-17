import type { Decision } from "../policy/evaluate.js";
import type { Payload } from "../payload.js";
import type { Receipt } from "../receipts.js";
import type { State } from "../states.js";

export interface ResolvedAction {
  type: string;
  level: Decision["level"];
  resource: string | null;
  blastRadius: "self" | "others" | "public";
  reversible: boolean;
  amount: { value: number; currency: string } | null;
  attrs: Record<string, unknown>;
}

export interface TaskError {
  code: string;
  message: string;
  retryable?: boolean;
}

/** Error stored on the task row and in receipts. The message itself stays in a secret. */
export interface StoredTaskError {
  code: string;
  message_commit: string;
  retryable?: boolean;
}

export interface TaskRecord {
  id: string;
  appId: string;
  principalId: string;
  agentId: string | null;
  intentCommit: string | null;
  action: ResolvedAction;
  payloadHash: string;
  approvedPayloadHash: string | null;
  payloadSecretId: string;
  approvedPayloadSecretId: string | null;
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
  result: unknown | null;
  error: StoredTaskError | null;
  contentMatch: boolean | null;
  mismatch: boolean;
  compensates: string | null;
  expiresAt: string | null;
  idempotencyKey: string | null;
  metadata: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRecord {
  id: string;
  appId: string;
  taskId: string;
  approverPrincipalId: string;
  channel: string | null;
  decision: "approve" | "reject";
  presentedHash: string;
  editedPayloadHash: string | null;
  method: string;
  stepUp: boolean;
  simulated: boolean;
  assurance: string;
  reason: string | null;
  noteCommit: string | null;
  decidedAt: string;
}

export interface IdempotencyRecord {
  requestHash: string;
  responseJson: string;
}

export interface PolicyRow {
  version: number;
  hash: string;
  yaml: string;
  createdAt: string;
}

export interface LedgerStore {
  transaction<T>(fn: () => T): T;
  close(): void;
  ensureChainHead(appId: string, genesisHash: string): void;
  allocateSeq(appId: string): { seq: number; prevHash: string };
  insertReceipt(receipt: Receipt): void;
  listReceipts(appId: string, fromSeq?: number, toSeq?: number): Receipt[];
  listTaskReceipts(appId: string, taskId: string): Receipt[];
  getReceipt(appId: string, id: string): Receipt | null;
  chainHead(appId: string): { seq: number; hash: string } | null;
  insertTask(task: TaskRecord): void;
  updateTask(id: string, fromState: State, patch: Partial<TaskRecord> & { state: State }): boolean;
  getTask(appId: string, id: string): TaskRecord | null;
  findTaskByIdempotency(appId: string, key: string): TaskRecord | null;
  listTasks(appId: string, state?: State): TaskRecord[];
  insertApproval(approval: ApprovalRecord): void;
  getIdempotency(appId: string, scopeKey: string): IdempotencyRecord | null;
  insertIdempotency(appId: string, scopeKey: string, requestHash: string, responseJson: string, createdAt: string): void;
  putSecret(input: {
    id: string;
    appId: string;
    principalId: string;
    taskId: string | null;
    kind: string;
    plaintext: unknown;
    createdAt: string;
  }): void;
  getSecret(appId: string, id: string): unknown;
  listSecrets(
    appId: string,
    taskId: string,
  ): Array<{ id: string; kind: string; createdAt: string; plaintext: unknown | null }>;
  idempotencyDigest(text: string): string;
  shredPrincipal(appId: string, principalId: string): void;
  latestPolicy(): PolicyRow | null;
  insertPolicy(row: PolicyRow & { documentJson: string }): void;
  insertViolation(row: { id: string; appId: string; receiptId: string; payloadJson: string; createdAt: string }): void;
}
