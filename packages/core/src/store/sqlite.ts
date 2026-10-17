import { createHmac } from "node:crypto";
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from "node:sqlite";
import { GENESIS_HASH } from "../canonical.js";
import { decryptAesGcm, encryptAesGcm, randomKey } from "../crypto.js";
import { LedgerError } from "../errors.js";
import type { Receipt } from "../receipts.js";
import { TERMINAL_STATES, type State } from "../states.js";
import type {
  ApprovalRecord,
  IdempotencyRecord,
  LedgerStore,
  PolicyRow,
  TaskRecord,
} from "./types.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chain_heads (
  app_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  app_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  PRIMARY KEY (app_id, seq)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  agent_id TEXT,
  intent TEXT,
  intent_commit TEXT,
  action_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  approved_payload_hash TEXT,
  payload_secret_id TEXT NOT NULL,
  approved_payload_secret_id TEXT,
  integration_mode TEXT NOT NULL,
  coverage_via TEXT,
  coverage_matched INTEGER NOT NULL,
  state TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  approval_id TEXT,
  claimed_at TEXT,
  execution_deadline TEXT,
  claim_deadline TEXT,
  executed_hash TEXT,
  result_json TEXT,
  error_json TEXT,
  content_match INTEGER,
  mismatch INTEGER NOT NULL DEFAULT 0,
  compensates TEXT,
  expires_at TEXT,
  idempotency_key TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (app_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  approver_principal_id TEXT NOT NULL,
  channel TEXT,
  decision TEXT NOT NULL,
  presented_hash TEXT NOT NULL,
  edited_payload_hash TEXT,
  method TEXT NOT NULL,
  step_up INTEGER NOT NULL,
  simulated INTEGER NOT NULL,
  assurance TEXT NOT NULL,
  reason TEXT,
  note_commit TEXT,
  decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  app_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, scope_key)
);
CREATE TABLE IF NOT EXISTS principal_keys (
  app_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  PRIMARY KEY (app_id, principal_id)
);
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policies (
  version INTEGER PRIMARY KEY,
  hash TEXT NOT NULL,
  yaml TEXT NOT NULL,
  document_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS violations (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(app_id, state);
CREATE INDEX IF NOT EXISTS idx_receipts_task ON receipts(task_id);
CREATE TRIGGER IF NOT EXISTS receipts_no_update
BEFORE UPDATE ON receipts
BEGIN
  SELECT RAISE(ABORT, 'receipts are append-only');
END;
CREATE TRIGGER IF NOT EXISTS receipts_no_delete
BEFORE DELETE ON receipts
BEGIN
  SELECT RAISE(ABORT, 'receipts are append-only');
END;
`;

function asRow(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return value == null ? null : String(value);
}

function bool(value: unknown): boolean {
  return value === 1 || value === true;
}

function jsonOrNull(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  return JSON.parse(value) as T;
}

export class SqliteStore implements LedgerStore {
  private readonly db: SqliteDatabase;
  /** Schema value observed before this process promotes a legacy database. */
  private schemaAtOpen: string | null = null;

  constructor(
    filename: string,
    private readonly masterKey: Buffer,
  ) {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA secure_delete = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Add 0.2 columns and remember whether this file was still schema 1.
   * Promoting 1 → 2 is deferred to `promoteSchema` so openLedger can refuse
   * unfinished tasks first.
   */
  private migrate(): void {
    const row = asRow(this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get());
    const version = row ? String(row.value) : null;
    this.schemaAtOpen = version;
    if (!this.hasColumn("tasks", "intent_commit")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN intent_commit TEXT");
    }
    if (!this.hasColumn("approvals", "note_commit")) {
      this.db.exec("ALTER TABLE approvals ADD COLUMN note_commit TEXT");
    }
    if (version === null) {
      this.db.prepare("INSERT INTO meta(key, value) VALUES ('schema', '2')").run();
      this.schemaAtOpen = "2";
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((row) => asRow(row)?.name === column);
  }

  /** Non-terminal tasks that a schema-1 file still has open. Zero when the file was never schema 1. */
  legacyOpenTasks(appId: string): number {
    if (this.schemaAtOpen !== "1") return 0;
    const terminals = [...TERMINAL_STATES];
    const placeholders = terminals.map(() => "?").join(", ");
    const row = asRow(
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE app_id = ? AND state NOT IN (${placeholders})`)
        .get(appId, ...terminals),
    );
    return Number(row?.n ?? 0);
  }

  promoteSchema(): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES ('schema', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run();
    this.schemaAtOpen = "2";
  }

  /** Plaintext left in the schema-1 `tasks.intent` column. New writes store NULL there. */
  legacyIntent(taskId: string): string | null {
    const row = asRow(this.db.prepare("SELECT intent FROM tasks WHERE id = ?").get(taskId));
    return text(row?.intent);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The statement may have already rolled the transaction back.
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  ensureChainHead(appId: string, genesisHash: string = GENESIS_HASH): void {
    this.db
      .prepare("INSERT OR IGNORE INTO chain_heads(app_id, seq, hash) VALUES (?, 0, ?)")
      .run(appId, genesisHash);
  }

  allocateSeq(appId: string): { seq: number; prevHash: string } {
    const row = asRow(this.db.prepare("SELECT seq, hash FROM chain_heads WHERE app_id = ?").get(appId));
    if (!row) throw new LedgerError("ledger_unavailable", `missing chain head for ${appId}`, 503);
    return { seq: Number(row.seq) + 1, prevHash: String(row.hash) };
  }

  insertReceipt(receipt: Receipt): void {
    this.db
      .prepare(
        `INSERT INTO receipts(app_id, seq, id, task_id, prev_hash, hash, receipt_json, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.app_id,
        receipt.seq,
        receipt.id,
        receipt.task_id,
        receipt.prev_hash,
        receipt.hash,
        JSON.stringify(receipt),
        receipt.issued_at,
      );
    const info = this.db
      .prepare("UPDATE chain_heads SET seq = ?, hash = ? WHERE app_id = ? AND seq = ?")
      .run(receipt.seq, receipt.hash, receipt.app_id, receipt.seq - 1);
    if (Number(info.changes) !== 1) {
      throw new LedgerError("invalid_transition", "chain head moved during receipt write", 409);
    }
  }

  listReceipts(appId: string, fromSeq?: number, toSeq?: number): Receipt[] {
    const rows = this.db
      .prepare(
        `SELECT receipt_json FROM receipts
         WHERE app_id = ? AND seq >= ? AND seq <= ?
         ORDER BY seq ASC`,
      )
      .all(appId, fromSeq ?? 1, toSeq ?? Number.MAX_SAFE_INTEGER);
    return rows.map((row) => JSON.parse(String(asRow(row)?.receipt_json)) as Receipt);
  }

  listTaskReceipts(appId: string, taskId: string): Receipt[] {
    const rows = this.db
      .prepare(`SELECT receipt_json FROM receipts WHERE app_id = ? AND task_id = ? ORDER BY seq ASC`)
      .all(appId, taskId);
    return rows.map((row) => JSON.parse(String(asRow(row)?.receipt_json)) as Receipt);
  }

  getReceipt(appId: string, id: string): Receipt | null {
    const row = asRow(
      this.db.prepare("SELECT receipt_json FROM receipts WHERE app_id = ? AND id = ?").get(appId, id),
    );
    if (!row) return null;
    return JSON.parse(String(row.receipt_json)) as Receipt;
  }

  chainHead(appId: string): { seq: number; hash: string } | null {
    const row = asRow(this.db.prepare("SELECT seq, hash FROM chain_heads WHERE app_id = ?").get(appId));
    if (!row) return null;
    return { seq: Number(row.seq), hash: String(row.hash) };
  }

  insertTask(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks(
           id, app_id, principal_id, agent_id, intent, intent_commit, action_json, payload_hash,
           approved_payload_hash, payload_secret_id, approved_payload_secret_id, integration_mode,
           coverage_via, coverage_matched, state, decision_json, approval_id, claimed_at, execution_deadline,
           claim_deadline, executed_hash, result_json, error_json, content_match, mismatch, compensates,
           expires_at, idempotency_key, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...taskParams(task));
  }

  updateTask(id: string, fromState: State, patch: Partial<TaskRecord> & { state: State }): boolean {
    const current = this.getTaskById(id);
    if (!current || current.state !== fromState) return false;
    const next: TaskRecord = { ...current, ...patch };
    const info = this.db
      .prepare(
        `UPDATE tasks SET
           principal_id=?, agent_id=?, intent=?, intent_commit=?, action_json=?, payload_hash=?,
           approved_payload_hash=?, payload_secret_id=?, approved_payload_secret_id=?, integration_mode=?,
           coverage_via=?, coverage_matched=?, state=?, decision_json=?, approval_id=?, claimed_at=?,
           execution_deadline=?, claim_deadline=?, executed_hash=?, result_json=?, error_json=?,
           content_match=?, mismatch=?, compensates=?, expires_at=?, idempotency_key=?, metadata_json=?,
           updated_at=?
         WHERE id=? AND state=?`,
      )
      .run(
        next.principalId,
        next.agentId,
        null,
        next.intentCommit,
        JSON.stringify(next.action),
        next.payloadHash,
        next.approvedPayloadHash,
        next.payloadSecretId,
        next.approvedPayloadSecretId,
        next.integrationMode,
        next.coverageVia,
        next.coverageMatched ? 1 : 0,
        next.state,
        JSON.stringify(next.decision),
        next.approvalId,
        next.claimedAt,
        next.executionDeadline,
        next.claimDeadline,
        next.executedHash,
        null,
        jsonOrNull(next.error),
        next.contentMatch == null ? null : next.contentMatch ? 1 : 0,
        next.mismatch ? 1 : 0,
        next.compensates,
        next.expiresAt,
        next.idempotencyKey,
        jsonOrNull(next.metadata),
        next.updatedAt,
        id,
        fromState,
      );
    return Number(info.changes) === 1;
  }

  getTask(appId: string, id: string): TaskRecord | null {
    const task = this.getTaskById(id);
    if (!task || task.appId !== appId) return null;
    return task;
  }

  findTaskByIdempotency(appId: string, key: string): TaskRecord | null {
    const row = asRow(
      this.db.prepare("SELECT * FROM tasks WHERE app_id = ? AND idempotency_key = ?").get(appId, key),
    );
    return row ? rowToTask(row) : null;
  }

  listTasks(appId: string, state?: State): TaskRecord[] {
    const rows = state
      ? this.db.prepare("SELECT * FROM tasks WHERE app_id = ? AND state = ? ORDER BY created_at ASC").all(appId, state)
      : this.db.prepare("SELECT * FROM tasks WHERE app_id = ? ORDER BY created_at ASC").all(appId);
    return rows.map((row) => rowToTask(asRow(row)!));
  }

  insertApproval(approval: ApprovalRecord): void {
    this.db
      .prepare(
        `INSERT INTO approvals(
           id, app_id, task_id, approver_principal_id, channel, decision, presented_hash,
           edited_payload_hash, method, step_up, simulated, assurance, reason, note_commit, decided_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.appId,
        approval.taskId,
        approval.approverPrincipalId,
        approval.channel,
        approval.decision,
        approval.presentedHash,
        approval.editedPayloadHash,
        approval.method,
        approval.stepUp ? 1 : 0,
        approval.simulated ? 1 : 0,
        approval.assurance,
        approval.reason,
        approval.noteCommit,
        approval.decidedAt,
      );
  }

  getIdempotency(appId: string, scopeKey: string): IdempotencyRecord | null {
    const row = asRow(
      this.db
        .prepare("SELECT request_hash, response_json FROM idempotency WHERE app_id = ? AND scope_key = ?")
        .get(appId, scopeKey),
    );
    if (!row) return null;
    return { requestHash: String(row.request_hash), responseJson: String(row.response_json) };
  }

  insertIdempotency(
    appId: string,
    scopeKey: string,
    requestHash: string,
    responseJson: string,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO idempotency(app_id, scope_key, request_hash, response_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(appId, scopeKey, requestHash, responseJson, createdAt);
  }

  putSecret(input: {
    id: string;
    appId: string;
    principalId: string;
    taskId: string | null;
    kind: string;
    plaintext: unknown;
    createdAt: string;
  }): void {
    const key = this.ensurePrincipalKey(input.appId, input.principalId);
    const encrypted = encryptAesGcm(key, Buffer.from(JSON.stringify(input.plaintext), "utf8"));
    this.db
      .prepare(
        `INSERT INTO secrets(id, app_id, principal_id, task_id, kind, nonce, ciphertext, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.appId,
        input.principalId,
        input.taskId,
        input.kind,
        encrypted.nonce,
        encrypted.ciphertext,
        input.createdAt,
      );
  }

  listSecrets(
    appId: string,
    taskId: string,
  ): Array<{ id: string; kind: string; createdAt: string; plaintext: unknown | null }> {
    const rows = this.db
      .prepare(
        `SELECT * FROM secrets WHERE app_id = ? AND task_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(appId, taskId);
    return rows.map((row) => this.secretView(asRow(row)!));
  }

  listSecretsByKind(
    appId: string,
    kind: string,
  ): Array<{ id: string; kind: string; createdAt: string; plaintext: unknown | null }> {
    const rows = this.db
      .prepare(`SELECT * FROM secrets WHERE app_id = ? AND kind = ? ORDER BY created_at ASC, id ASC`)
      .all(appId, kind);
    return rows.map((row) => this.secretView(asRow(row)!));
  }

  idempotencyDigest(text: string): string {
    const key = createHmac("sha256", this.masterKey).update("actledger/idempotency").digest();
    return createHmac("sha256", key).update(text, "utf8").digest("hex");
  }

  getSecret(appId: string, id: string): unknown {
    const row = asRow(this.db.prepare("SELECT * FROM secrets WHERE app_id = ? AND id = ?").get(appId, id));
    if (!row) throw new LedgerError("not_found", `secret ${id} not found`, 404);
    const key = this.readPrincipalKey(String(row.app_id), String(row.principal_id));
    if (!key) {
      throw new LedgerError("not_found", "content deleted", 404);
    }
    const plain = decryptAesGcm(key, String(row.nonce), String(row.ciphertext));
    return JSON.parse(plain.toString("utf8")) as unknown;
  }

  shredPrincipal(appId: string, principalId: string): void {
    this.db.prepare("DELETE FROM principal_keys WHERE app_id = ? AND principal_id = ?").run(appId, principalId);
  }

  latestPolicy(): PolicyRow | null {
    const row = asRow(this.db.prepare("SELECT version, hash, yaml, created_at FROM policies ORDER BY version DESC LIMIT 1").get());
    if (!row) return null;
    return {
      version: Number(row.version),
      hash: String(row.hash),
      yaml: String(row.yaml),
      createdAt: String(row.created_at),
    };
  }

  insertPolicy(row: PolicyRow & { documentJson: string }): void {
    this.db
      .prepare("INSERT INTO policies(version, hash, yaml, document_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(row.version, row.hash, row.yaml, row.documentJson, row.createdAt);
  }

  insertViolation(row: { id: string; appId: string; receiptId: string; payloadJson: string; createdAt: string }): void {
    this.db
      .prepare("INSERT INTO violations(id, app_id, receipt_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, row.appId, row.receiptId, row.payloadJson, row.createdAt);
  }

  /** Exposed for the append-only regression test. */
  raw(): SqliteDatabase {
    return this.db;
  }

  private getTaskById(id: string): TaskRecord | null {
    const row = asRow(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
    return row ? rowToTask(row) : null;
  }

  private secretView(row: Record<string, unknown>): {
    id: string;
    kind: string;
    createdAt: string;
    plaintext: unknown | null;
  } {
    return {
      id: String(row.id),
      kind: String(row.kind),
      createdAt: String(row.created_at),
      plaintext: this.decryptSecret(row),
    };
  }

  private decryptSecret(row: Record<string, unknown>): unknown | null {
    const key = this.readPrincipalKey(String(row.app_id), String(row.principal_id));
    if (!key) return null;
    try {
      const plain = decryptAesGcm(key, String(row.nonce), String(row.ciphertext));
      return JSON.parse(plain.toString("utf8")) as unknown;
    } catch {
      return null;
    }
  }

  private readPrincipalKey(appId: string, principalId: string): Buffer | null {
    const row = asRow(
      this.db
        .prepare("SELECT nonce, ciphertext FROM principal_keys WHERE app_id = ? AND principal_id = ?")
        .get(appId, principalId),
    );
    if (!row) return null;
    return decryptAesGcm(this.masterKey, String(row.nonce), String(row.ciphertext));
  }

  private ensurePrincipalKey(appId: string, principalId: string): Buffer {
    const existing = this.readPrincipalKey(appId, principalId);
    if (existing) return existing;
    const key = randomKey();
    const encrypted = encryptAesGcm(this.masterKey, key);
    this.db
      .prepare("INSERT INTO principal_keys(app_id, principal_id, nonce, ciphertext) VALUES (?, ?, ?, ?)")
      .run(appId, principalId, encrypted.nonce, encrypted.ciphertext);
    return key;
  }
}

function taskParams(task: TaskRecord): SQLInputValue[] {
  return [
    task.id,
    task.appId,
    task.principalId,
    task.agentId,
    null,
    task.intentCommit,
    JSON.stringify(task.action),
    task.payloadHash,
    task.approvedPayloadHash,
    task.payloadSecretId,
    task.approvedPayloadSecretId,
    task.integrationMode,
    task.coverageVia,
    task.coverageMatched ? 1 : 0,
    task.state,
    JSON.stringify(task.decision),
    task.approvalId,
    task.claimedAt,
    task.executionDeadline,
    task.claimDeadline,
    task.executedHash,
    null,
    jsonOrNull(task.error),
    task.contentMatch == null ? null : task.contentMatch ? 1 : 0,
    task.mismatch ? 1 : 0,
    task.compensates,
    task.expiresAt,
    task.idempotencyKey,
    jsonOrNull(task.metadata),
    task.createdAt,
    task.updatedAt,
  ];
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    appId: String(row.app_id),
    principalId: String(row.principal_id),
    agentId: text(row.agent_id),
    intentCommit: text(row.intent_commit),
    action: parseJson(row.action_json) as TaskRecord["action"],
    payloadHash: String(row.payload_hash),
    approvedPayloadHash: text(row.approved_payload_hash),
    payloadSecretId: String(row.payload_secret_id),
    approvedPayloadSecretId: text(row.approved_payload_secret_id),
    integrationMode: row.integration_mode === "enforced" ? "enforced" : "recorded",
    coverageVia: text(row.coverage_via),
    coverageMatched: bool(row.coverage_matched),
    state: String(row.state) as State,
    decision: parseJson(row.decision_json) as TaskRecord["decision"],
    approvalId: text(row.approval_id),
    claimedAt: text(row.claimed_at),
    executionDeadline: text(row.execution_deadline),
    claimDeadline: text(row.claim_deadline),
    executedHash: text(row.executed_hash),
    result: parseJson(row.result_json),
    error: parseJson(row.error_json),
    contentMatch: row.content_match == null ? null : bool(row.content_match),
    mismatch: bool(row.mismatch),
    compensates: text(row.compensates),
    expiresAt: text(row.expires_at),
    idempotencyKey: text(row.idempotency_key),
    metadata: parseJson(row.metadata_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
