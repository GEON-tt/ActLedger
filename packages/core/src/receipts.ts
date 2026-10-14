import { jcs, sha256Prefixed } from "./canonical.js";
import type { Signer } from "./crypto.js";
import { normalizePayload, type Payload } from "./payload.js";
import { RECEIPT_V01, RECEIPT_V02 } from "./secrets.js";

export { RECEIPT_V01, RECEIPT_V02 };

export interface Actor {
  type: "agent" | "user" | "policy" | "system";
  id: string;
}

export interface EvidenceRef {
  type: string;
  sha256: string;
  uri?: string;
  size?: number;
  mime?: string;
  captured_at?: string;
}

export interface Receipt {
  v: typeof RECEIPT_V01 | typeof RECEIPT_V02;
  id: string;
  app_id: string;
  seq: number;
  prev_hash: string;
  task_id: string | null;
  transition: { from: string | null; to: string } | null;
  actor: Actor;
  body: Record<string, unknown>;
  evidence: EvidenceRef[];
  issued_at: string;
  hash: string;
  sig: { alg: "Ed25519"; kid: string; value: string };
}

export interface UnsignedReceipt {
  v: typeof RECEIPT_V01 | typeof RECEIPT_V02;
  id: string;
  app_id: string;
  seq: number;
  prev_hash: string;
  task_id: string | null;
  transition: { from: string | null; to: string } | null;
  actor: Actor;
  body: Record<string, unknown>;
  evidence: EvidenceRef[];
  issued_at: string;
}

export function unsignedReceipt(receipt: Receipt): UnsignedReceipt {
  return {
    v: receipt.v,
    id: receipt.id,
    app_id: receipt.app_id,
    seq: receipt.seq,
    prev_hash: receipt.prev_hash,
    task_id: receipt.task_id,
    transition: receipt.transition,
    actor: receipt.actor,
    body: receipt.body,
    evidence: receipt.evidence,
    issued_at: receipt.issued_at,
  };
}

export function receiptHash(unsigned: UnsignedReceipt): string {
  return sha256Prefixed(jcs(unsigned));
}

export function buildReceipt(
  unsigned: Omit<UnsignedReceipt, "v">,
  signer: Signer,
): Receipt {
  const body: UnsignedReceipt = { v: RECEIPT_V02, ...unsigned };
  const hash = receiptHash(body);
  return {
    ...body,
    hash,
    sig: { alg: "Ed25519", kid: signer.kid, value: signer.sign(hash) },
  };
}

/** `sha256` keeps its old name. For 0.2 it stores an `hmac-sha256:` commitment; the prefix selects the algorithm. */
export function payloadEvidence(payload: Payload, commitment: string): EvidenceRef {
  const encoded = jcs(normalizePayload(payload));
  return {
    type: "payload",
    sha256: commitment,
    mime: "application/json",
    size: Buffer.byteLength(encoded, "utf8"),
  };
}
