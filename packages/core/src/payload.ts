import { jcs, sha256Prefixed } from "./canonical.js";
import { LedgerError } from "./errors.js";

export interface PayloadContent {
  content_type: string;
  text?: string;
  ref?: string;
  sha256?: string;
}

export interface Payload {
  action: string;
  args: Record<string, unknown>;
  content?: PayloadContent;
  allowed_drift?: string[];
}

const UNSAFE_PATH = new Set(["__proto__", "prototype", "constructor"]);

export function assertSafePath(path: string): void {
  if (!path || path.startsWith(".") || path.endsWith(".")) {
    throw new LedgerError("invalid_request", `invalid drift path ${path}`, 400);
  }
  for (const part of path.split(".")) {
    if (!part || UNSAFE_PATH.has(part)) {
      throw new LedgerError("invalid_request", `invalid drift path ${path}`, 400);
    }
  }
}

export function assertDriftPath(path: string): void {
  assertSafePath(path);
  const parts = path.split(".");
  if (parts.length < 2 || (parts[0] !== "args" && parts[0] !== "content")) {
    throw new LedgerError("invalid_request", `invalid drift path ${path}`, 400);
  }
}

export function normalizePayload(payload: Payload): Record<string, unknown> {
  if (typeof payload.action !== "string" || payload.action.length === 0) {
    throw new LedgerError("invalid_request", "payload.action is required", 400);
  }
  if (!payload.args || typeof payload.args !== "object" || Array.isArray(payload.args)) {
    throw new LedgerError("invalid_request", "payload.args must be an object", 400);
  }
  const out: Record<string, unknown> = {
    action: payload.action,
    args: payload.args,
  };
  if (payload.content !== undefined) out.content = payload.content;
  if (payload.allowed_drift !== undefined) {
    if (!Array.isArray(payload.allowed_drift)) {
      throw new LedgerError("invalid_request", "allowed_drift must be an array", 400);
    }
    for (const path of payload.allowed_drift) {
      if (typeof path !== "string") {
        throw new LedgerError("invalid_request", "allowed_drift entries must be strings", 400);
      }
      assertDriftPath(path);
    }
    out.allowed_drift = payload.allowed_drift;
  }
  // Reject floats and undefined before hashing.
  jcs(out);
  return out;
}

export function payloadHash(payload: Payload): string {
  return sha256Prefixed(jcs(normalizePayload(payload)));
}

interface Found {
  found: boolean;
  value: unknown;
}

function lookup(root: unknown, path: string): Found {
  const parts = path.split(".");
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== "object") return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(current, part)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function sameFound(a: Found, b: Found): boolean {
  if (a.found !== b.found) return false;
  if (!a.found) return true;
  return jcs(a.value) === jcs(b.value);
}

function unset(root: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  let current: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current || typeof current !== "object") return;
    current = (current as Record<string, unknown>)[parts[i]];
  }
  if (current && typeof current === "object") {
    delete (current as Record<string, unknown>)[parts[parts.length - 1]];
  }
}

function stripped(payload: Payload, paths: string[]): Record<string, unknown> {
  const clone = JSON.parse(jcs(normalizePayload(payload))) as Record<string, unknown>;
  delete clone.allowed_drift;
  for (const path of paths) unset(clone, path);
  return clone;
}

export interface DriftComparison {
  match: boolean;
  driftApplied: string[];
}

/**
 * Compare an approved payload with the executed payload.
 * Paths in `allowed_drift` may differ; every other path must match.
 * `allowed_drift` itself is not part of the comparison.
 */
export function compareWithDrift(approved: Payload, executed: Payload): DriftComparison {
  const paths = approved.allowed_drift ?? [];
  for (const path of paths) assertDriftPath(path);
  const driftApplied = paths.filter(
    (path) => !sameFound(lookup(approved, path), lookup(executed, path)),
  );
  const match = jcs(stripped(approved, paths)) === jcs(stripped(executed, paths));
  return { match, driftApplied };
}
