import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LedgerError, sha256Hex } from "@actledger/core";

export const LINK_TTL_SECONDS = 900;
const NONCE_TTL_MS = 10 * 60 * 1000;
const PREFIX = "actledger.link.v1";

export interface LinkClaim {
  appId: string;
  taskId: string;
  payloadHash: string;
  exp: number;
}

export function loadOrCreateLinkKey(dir: string): Buffer {
  const keysDir = path.join(path.resolve(dir), "keys");
  fs.mkdirSync(keysDir, { recursive: true });
  const file = path.join(keysDir, "link-hmac.key");
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      const key = randomBytes(32);
      let offset = 0;
      while (offset < key.length) offset += fs.writeSync(fd, key, offset);
      fs.fchmodSync(fd, 0o600);
      return key;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) {
    process.stderr.write(`warning: ${file} is readable by group or others\n`);
  }
  const key = fs.readFileSync(file);
  if (key.length !== 32) {
    throw new LedgerError("invalid_request", `link key ${file} must be 32 bytes`, 400);
  }
  return key;
}

export function signLink(key: Buffer, claim: LinkClaim): string {
  return createHmac("sha256", key).update(linkMessage(claim)).digest("base64url");
}

export function verifyLink(
  key: Buffer,
  claim: LinkClaim,
  sig: string,
  nowSeconds: number,
): "ok" | "expired" | "bad_signature" {
  if (!Number.isInteger(claim.exp)) return "bad_signature";
  const expected = signLink(key, claim);
  if (!safeEqual(expected, sig)) return "bad_signature";
  if (nowSeconds > claim.exp) return "expired";
  return "ok";
}

export class UsedLinks {
  private constructor(
    private readonly file: string,
    private readonly used: Set<string>,
  ) {}

  static open(file: string, nowSeconds: number): UsedLinks {
    const used = new Set<string>();
    if (!fs.existsSync(file)) return new UsedLinks(file, used);
    const kept: string[] = [];
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: { sig_sha256?: unknown; exp?: unknown };
      try {
        row = JSON.parse(line) as { sig_sha256?: unknown; exp?: unknown };
      } catch {
        throw new LedgerError("invalid_request", `link-used.jsonl: ${file}: invalid json`, 400);
      }
      if (typeof row.sig_sha256 !== "string" || typeof row.exp !== "number") {
        throw new LedgerError("invalid_request", `link-used.jsonl: ${file}: invalid row`, 400);
      }
      if (row.exp < nowSeconds - 3600) continue;
      used.add(row.sig_sha256);
      kept.push(line);
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.length > 0 ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
    return new UsedLinks(file, used);
  }

  has(sig: string): boolean {
    return this.used.has(sha256Hex(sig));
  }

  consume(sig: string, taskId: string, exp: number, usedAt: string): boolean {
    const digest = sha256Hex(sig);
    if (this.used.has(digest)) return false;
    const line = `${JSON.stringify({ sig_sha256: digest, task_id: taskId, exp, used_at: usedAt })}\n`;
    fs.appendFileSync(this.file, line, { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
    this.used.add(digest);
    return true;
  }
}

export class LinkNonces {
  private readonly nonces = new Map<string, { taskId: string; sigHash: string; expiresAt: number }>();

  issue(taskId: string, sig: string, nowMs: number): string {
    this.prune(nowMs);
    const nonce = randomBytes(32).toString("base64url");
    this.nonces.set(nonce, { taskId, sigHash: sha256Hex(sig), expiresAt: nowMs + NONCE_TTL_MS });
    return nonce;
  }

  take(nonce: string, taskId: string, sig: string, nowMs: number): boolean {
    const row = this.nonces.get(nonce);
    if (!row) return false;
    this.nonces.delete(nonce);
    if (nowMs >= row.expiresAt) return false;
    if (row.taskId !== taskId) return false;
    return safeEqual(row.sigHash, sha256Hex(sig));
  }

  private prune(nowMs: number): void {
    for (const [nonce, row] of this.nonces) {
      if (nowMs >= row.expiresAt) this.nonces.delete(nonce);
    }
  }
}

function linkMessage(claim: LinkClaim): string {
  return `${PREFIX}\n${claim.appId}\n${claim.taskId}\n${claim.payloadHash}\n${claim.exp}`;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
