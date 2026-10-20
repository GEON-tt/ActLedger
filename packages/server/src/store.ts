import fs from "node:fs";
import { LedgerError, formatTimestamp, newId } from "@actledger/core";
import { hashApiKey, newApiKey } from "./apikey.js";
import { LOGIN_USER_LOCK_MS, LOGIN_USER_MAX_FAILURES } from "./limiter.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PRINCIPAL_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret TEXT NOT NULL,
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'audit')),
  key_hash TEXT NOT NULL UNIQUE,
  agent_id TEXT,
  principals_json TEXT NOT NULL DEFAULT '[]',
  label TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  CHECK ((kind = 'agent' AND agent_id IS NOT NULL) OR (kind = 'audit' AND agent_id IS NULL))
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
`;

export interface UserRow {
  id: string;
  username: string;
  principalId: string;
  passwordHash: string;
  totpSecret: string;
  totpLastStep: number;
  failedLogins: number;
  lockedUntil: string | null;
  sessionEpoch: number;
  createdAt: string;
  updatedAt: string;
}

export interface KeyRow {
  id: string;
  kind: "agent" | "audit";
  agentId: string | null;
  principalIds: string[];
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

type SqlRow = Record<string, unknown>;

function asRow(value: unknown): SqlRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as SqlRow;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  return Number(value ?? 0);
}

function mapUser(row: SqlRow): UserRow {
  return {
    id: String(row.id),
    username: String(row.username),
    principalId: String(row.principal_id),
    passwordHash: String(row.password_hash),
    totpSecret: String(row.totp_secret),
    totpLastStep: num(row.totp_last_step),
    failedLogins: num(row.failed_logins),
    lockedUntil: text(row.locked_until),
    sessionEpoch: num(row.session_epoch),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapKey(row: SqlRow): KeyRow {
  const kind = row.kind === "audit" ? "audit" : "agent";
  let principalIds: string[] = [];
  if (typeof row.principals_json === "string" && row.principals_json.length > 0) {
    const parsed = JSON.parse(row.principals_json) as unknown;
    if (Array.isArray(parsed)) principalIds = parsed.filter((item): item is string => typeof item === "string");
  }
  return {
    id: String(row.id),
    kind,
    agentId: text(row.agent_id),
    principalIds,
    label: text(row.label),
    createdAt: String(row.created_at),
    revokedAt: text(row.revoked_at),
    lastUsedAt: text(row.last_used_at),
  };
}

export class CredentialStore {
  private constructor(
    private readonly db: InstanceType<typeof DatabaseSync>,
    private readonly now: () => Date,
  ) {}

  static open(file: string, now: () => Date = () => new Date()): CredentialStore {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, "", { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    }
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(SCHEMA);
      const row = asRow(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get());
      const version = row ? String(row.value) : "unknown";
      if (version !== "1") {
        throw new LedgerError("invalid_request", `server.db schema ${version} is not supported`, 400);
      }
    } catch (error) {
      db.close();
      throw error;
    }
    return new CredentialStore(db, now);
  }

  close(): void {
    this.db.close();
  }

  addUser(input: { username: string; principalId: string; passwordHash: string; totpSecret: string }): UserRow {
    const username = input.username.toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw new LedgerError("invalid_request", "username must match /^[a-z0-9][a-z0-9._-]{0,63}$/", 400);
    }
    if (!PRINCIPAL_RE.test(input.principalId)) {
      throw new LedgerError("invalid_request", "principalId is invalid", 400);
    }
    if (this.getUserByName(username)) {
      throw new LedgerError("user_exists", `user ${username} already exists`, 409);
    }
    if (asRow(this.db.prepare("SELECT id FROM users WHERE principal_id = ?").get(input.principalId))) {
      throw new LedgerError("principal_taken", `principal ${input.principalId} is already taken`, 409);
    }
    const id = newId("usr", this.now().getTime());
    const ts = formatTimestamp(this.now());
    this.db
      .prepare(
        `INSERT INTO users(
           id, username, principal_id, password_hash, totp_secret, totp_last_step, failed_logins,
           locked_until, session_epoch, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, 0, ?, ?)`,
      )
      .run(id, username, input.principalId, input.passwordHash, input.totpSecret, ts, ts);
    return this.mustUser(id);
  }

  getUserByName(username: string): UserRow | null {
    const row = asRow(this.db.prepare("SELECT * FROM users WHERE username = ?").get(username.toLowerCase()));
    return row ? mapUser(row) : null;
  }

  getUser(id: string): UserRow | null {
    const row = asRow(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id));
    return row ? mapUser(row) : null;
  }

  listUsers(): UserRow[] {
    return this.db
      .prepare("SELECT * FROM users ORDER BY created_at")
      .all()
      .map((item) => mapUser(asRow(item) ?? {}));
  }

  resetTotp(username: string, totpSecret: string): UserRow {
    const user = this.getUserByName(username);
    if (!user) throw new LedgerError("not_found", `user ${username} not found`, 404);
    const ts = formatTimestamp(this.now());
    this.db
      .prepare(
        `UPDATE users
         SET totp_secret = ?, totp_last_step = 0, failed_logins = 0, locked_until = NULL,
             session_epoch = session_epoch + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(totpSecret, ts, user.id);
    return this.mustUser(user.id);
  }

  consumeTotpStep(userId: string, step: number): boolean {
    const info = this.db
      .prepare("UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?")
      .run(step, userId, step);
    return Number(info.changes) === 1;
  }

  /**
   * Reserves one password check. Already-locked accounts return proceed false
   * and must not be verified. The attempt that reaches the lock threshold still
   * proceeds; later attempts are refused until the lock expires.
   */
  reserveLoginAttempt(userId: string): { proceed: boolean; lockedUntil: string | null } {
    const now = this.now();
    const user = this.mustUser(userId);
    if (user.lockedUntil && Date.parse(user.lockedUntil) > now.getTime()) {
      return { proceed: false, lockedUntil: user.lockedUntil };
    }
    const ts = formatTimestamp(now);
    const next = user.failedLogins + 1;
    if (next >= LOGIN_USER_MAX_FAILURES) {
      const until = formatTimestamp(new Date(now.getTime() + LOGIN_USER_LOCK_MS));
      this.db
        .prepare("UPDATE users SET failed_logins = 0, locked_until = ?, updated_at = ? WHERE id = ?")
        .run(until, ts, userId);
      return { proceed: true, lockedUntil: until };
    }
    this.db.prepare("UPDATE users SET failed_logins = ?, updated_at = ? WHERE id = ?").run(next, ts, userId);
    return { proceed: true, lockedUntil: null };
  }

  recordLoginFailure(userId: string): UserRow {
    const user = this.mustUser(userId);
    const ts = formatTimestamp(this.now());
    if (user.failedLogins + 1 >= LOGIN_USER_MAX_FAILURES) {
      const until = formatTimestamp(new Date(this.now().getTime() + LOGIN_USER_LOCK_MS));
      this.db
        .prepare("UPDATE users SET failed_logins = 0, locked_until = ?, updated_at = ? WHERE id = ?")
        .run(until, ts, userId);
    } else {
      this.db
        .prepare("UPDATE users SET failed_logins = ?, updated_at = ? WHERE id = ?")
        .run(user.failedLogins + 1, ts, userId);
    }
    return this.mustUser(userId);
  }

  recordLoginSuccess(userId: string): void {
    this.db
      .prepare("UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?")
      .run(formatTimestamp(this.now()), userId);
  }

  createKey(
    input: { kind: "agent"; agentId: string; principalIds: string[]; label?: string } | { kind: "audit"; label?: string },
  ): { row: KeyRow; key: string } {
    const key = newApiKey(input.kind);
    const id = newId("key", this.now().getTime());
    const ts = formatTimestamp(this.now());
    const label = input.label ?? null;
    if (input.kind === "agent") {
      if (!PRINCIPAL_RE.test(input.agentId)) throw new LedgerError("invalid_request", "agentId is invalid", 400);
      const principalIds = uniquePrincipals(input.principalIds);
      this.db
        .prepare(
          `INSERT INTO api_keys(id, kind, key_hash, agent_id, principals_json, label, created_at)
           VALUES (?, 'agent', ?, ?, ?, ?, ?)`,
        )
        .run(id, hashApiKey(key), input.agentId, JSON.stringify(principalIds), label, ts);
    } else {
      this.db
        .prepare(
          `INSERT INTO api_keys(id, kind, key_hash, agent_id, principals_json, label, created_at)
           VALUES (?, 'audit', ?, NULL, '[]', ?, ?)`,
        )
        .run(id, hashApiKey(key), label, ts);
    }
    return { row: this.mustKey(id), key };
  }

  findActiveKey(key: string): KeyRow | null {
    const row = asRow(
      this.db.prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL").get(hashApiKey(key)),
    );
    return row ? mapKey(row) : null;
  }

  touchKey(id: string): void {
    const now = this.now();
    const cutoff = formatTimestamp(new Date(now.getTime() - 60_000));
    this.db
      .prepare(
        `UPDATE api_keys SET last_used_at = ?
         WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
      )
      .run(formatTimestamp(now), id, cutoff);
  }

  revokeKey(id: string, kind: "agent" | "audit"): KeyRow {
    const row = this.getKey(id);
    if (!row || row.kind !== kind) throw new LedgerError("not_found", `key ${id} not found`, 404);
    if (!row.revokedAt) {
      this.db
        .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(formatTimestamp(this.now()), id);
    }
    return this.mustKey(id);
  }

  listKeys(kind?: "agent" | "audit"): KeyRow[] {
    const rows = kind
      ? this.db.prepare("SELECT * FROM api_keys WHERE kind = ? ORDER BY created_at").all(kind)
      : this.db.prepare("SELECT * FROM api_keys ORDER BY created_at").all();
    return rows.map((item) => mapKey(asRow(item) ?? {}));
  }

  private getKey(id: string): KeyRow | null {
    const row = asRow(this.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id));
    return row ? mapKey(row) : null;
  }

  private mustUser(id: string): UserRow {
    const user = this.getUser(id);
    if (!user) throw new LedgerError("not_found", `user ${id} not found`, 404);
    return user;
  }

  private mustKey(id: string): KeyRow {
    const key = this.getKey(id);
    if (!key) throw new LedgerError("not_found", `key ${id} not found`, 404);
    return key;
  }
}

function uniquePrincipals(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!PRINCIPAL_RE.test(id)) throw new LedgerError("invalid_request", "principalId is invalid", 400);
    out.push(id);
  }
  if (out.length === 0) throw new LedgerError("invalid_request", "agent key requires at least one principal", 400);
  return out;
}
