import { createHmac, timingSafeEqual } from "node:crypto";
import { LedgerError } from "@actledger/core";

export interface WebhookEvent {
  id: string;
  type: string;
  created_at: string;
  data: Record<string, unknown>;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify an ActLedger webhook signature.
 * Header shape: `t=<unix seconds>,v1=<hex hmac>,v1=<hex hmac>`.
 * The signature covers `timestamp + "." + raw body`.
 */
export function verifyWebhook(
  rawBody: Buffer | string,
  header: string,
  secret: string,
  nowMs = Date.now(),
): WebhookEvent {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) {
    throw new LedgerError("unauthenticated", "missing webhook signature", 401);
  }
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) {
    throw new LedgerError("unauthenticated", "invalid webhook timestamp", 401);
  }
  if (Math.abs(nowMs / 1000 - seconds) > 300) {
    throw new LedgerError("unauthenticated", "webhook timestamp is outside the 300s window", 401);
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
  if (!signatures.some((signature) => safeEqual(signature, expected))) {
    throw new LedgerError("unauthenticated", "webhook signature mismatch", 401);
  }
  return JSON.parse(body.toString("utf8")) as WebhookEvent;
}
