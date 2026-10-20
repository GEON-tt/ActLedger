import { createHash, randomBytes } from "node:crypto";

export const AGENT_KEY_PREFIX = "alk_";
export const AUDIT_KEY_PREFIX = "ala_";
const KEY_RE = /^al[ka]_[A-Za-z0-9_-]{43}$/;

export function newApiKey(kind: "agent" | "audit"): string {
  const prefix = kind === "agent" ? AGENT_KEY_PREFIX : AUDIT_KEY_PREFIX;
  return prefix + randomBytes(32).toString("base64url");
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** "Bearer <token>" (scheme case-insensitive, exactly one space-separated token). */
export function bearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || !/^Bearer \S+$/i.test(raw)) return null;
  const token = raw.slice(raw.indexOf(" ") + 1);
  if (!KEY_RE.test(token)) return null;
  return token;
}
