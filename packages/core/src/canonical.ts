import { createHash, createHmac } from "node:crypto";
import { LedgerError } from "./errors.js";

function compareUtf16(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * JSON Canonicalization Scheme (RFC 8785) for the protocol subset:
 * objects, arrays, strings, booleans, null, and safe integers.
 * Floats and non-safe integers are rejected.
 */
export function jcs(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new LedgerError(
        "non_canonical_number",
        `${path} is not a safe integer`,
        400,
      );
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") {
    throw new LedgerError("non_canonical_number", `${path} is a bigint`, 400);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(",")}]`;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (
      value instanceof Date ||
      value instanceof Map ||
      value instanceof Set ||
      (proto !== Object.prototype && proto !== null)
    ) {
      throw new LedgerError("invalid_request", `${path} is not JSON-serializable`, 400);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf16);
    const parts: string[] = [];
    for (const key of keys) {
      const child = record[key];
      if (child === undefined) {
        throw new LedgerError("invalid_request", `${path}.${key} is undefined`, 400);
      }
      parts.push(`${JSON.stringify(key)}:${serialize(child, `${path}.${key}`)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new LedgerError("invalid_request", `${path} is not JSON-serializable`, 400);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256Prefixed(text: string): string {
  return `sha256:${sha256Hex(text)}`;
}

/** Salted commitment. Salt stays with the ciphertext, never in the receipt. */
export function commit(salt: Buffer, value: unknown): string {
  const mac = createHmac("sha256", salt).update(jcs(value), "utf8").digest("hex");
  return `hmac-sha256:${mac}`;
}

export const GENESIS_HASH = `sha256:${"0".repeat(64)}`;
