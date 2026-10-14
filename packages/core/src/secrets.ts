import { randomBytes } from "node:crypto";
import { commit } from "./canonical.js";
import { LedgerError } from "./errors.js";
import { normalizePayload, type Payload } from "./payload.js";

export const RECEIPT_V01 = "actledger.receipt/0.1";
export const RECEIPT_V02 = "actledger.receipt/0.2";
export const SECRETS_V = "actledger.secrets/0.1";
export const ERROR_CODE_RE = /^[a-z0-9_.]{1,64}$/;
export const COMMIT_RE = /^hmac-sha256:[0-9a-f]{64}$/;
export const SHA_RE = /^sha256:[0-9a-f]{64}$/;

/** Enumerated receipt reasons, grouped by the transition target state. */
export const REASONS = {
  rejected: ["rejected_by_user", "denied_by_policy"],
  drafted: ["draft_only"],
  expired: ["approval_timeout", "claim_deadline"],
  unknown: ["execution_timeout"],
  revoked: ["revoked"],
  failed: ["reconciled_not_executed"],
} as const;

export type ReasonState = keyof typeof REASONS;

export function reasonAllowed(to: string, reason: string): boolean {
  const allowed = (REASONS as Record<string, readonly string[]>)[to];
  return Array.isArray(allowed) && allowed.includes(reason);
}

export function newSalt(): Buffer {
  return randomBytes(32);
}

export function payloadCommit(salt: Buffer, payload: Payload): string {
  return commit(salt, normalizePayload(payload));
}

/**
 * Commitment of a string. Intentionally not domain-separated: within one task,
 * identical intent and note text produce the same commitment. That matches the
 * commitment formula; do not add a prefix.
 */
export function textCommit(salt: Buffer, value: string): string {
  return commit(salt, value);
}

export interface ProofSecret {
  index: number;
  /** Absent on schema-1 proofs. Verify then checks only the commitment. */
  type?: string;
  salt: string;
  value: unknown;
}

export interface TaskSecretsEntry {
  v: typeof SECRETS_V;
  kind: "task";
  task_id: string;
  principal_id: string;
  shredded?: boolean;
  payload_salt?: string | null;
  intent?: string | null;
  payload?: Record<string, unknown> | null;
  approved_payload?: Record<string, unknown> | null;
  executed_payload?: Record<string, unknown> | null;
  result?: unknown;
  error?: { code: string; message: string } | null;
  notes?: { reject: string | null; revoke: string | null; reconcile: string | null };
  proofs?: ProofSecret[];
}

export interface ViolationSecretsEntry {
  v: typeof SECRETS_V;
  kind: "violation";
  receipt_id: string;
  salt: string;
  description: string;
}

export type SecretsEntry = TaskSecretsEntry | ViolationSecretsEntry;

export function parseSecretsJsonl(text: string): SecretsEntry[] {
  const entries: SecretsEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const value = JSON.parse(trimmed) as SecretsEntry;
    if (value.v !== SECRETS_V || (value.kind !== "task" && value.kind !== "violation")) {
      throw new LedgerError("invalid_request", "invalid secrets entry", 400);
    }
    entries.push(value);
  }
  return entries;
}

export function serializeSecrets(entries: SecretsEntry[]): string {
  if (entries.length === 0) return "";
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
