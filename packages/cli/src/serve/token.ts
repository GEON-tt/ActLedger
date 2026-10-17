import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatTimestamp, LedgerError, sha256Hex } from "@actledger/core";
import type { LoginSource } from "./auth.js";

export interface TokenRecord {
  v: 1;
  token: string;
  generation: number;
  createdAt: string;
}

export interface TokenFileOptions {
  now: () => Date;
  log: (line: string) => void;
}

export interface LoginCredential {
  token: string;
  generation: number;
  digest: string;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_KEYS = ["v", "token", "generation", "createdAt"] as const;

export function defaultTokenFile(dir: string): string {
  return path.join(path.resolve(dir), "serve.token");
}

export function loginUrl(origin: string, token: string): string {
  return `${origin}/login?token=${token}`;
}

export function loadOrCreateLoginToken(file: string, opts: TokenFileOptions): TokenRecord {
  assertParent(file);
  try {
    return readTokenFile(file, opts.log);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
    return createToken(file, mint(1, opts), opts.log);
  }
}

export function rotateLoginToken(file: string, opts: TokenFileOptions): TokenRecord {
  assertParent(file);
  let generation = 1;
  try {
    generation = readTokenFile(file, opts.log).generation + 1;
  } catch (error) {
    if (errno(error) === "ENOENT" || (error instanceof LedgerError && error.code === "invalid_request")) {
      generation = 1;
    } else {
      throw error;
    }
  }
  const record = mint(generation, opts);
  replaceToken(file, record);
  opts.log(`login token rotated (generation ${generation}); older login URLs and sessions no longer work`);
  return record;
}

export class FileLoginSource implements LoginSource {
  readonly oneTime = false;
  private warned = false;
  private cache: { ino: number; mtimeMs: number; size: number; credential: LoginCredential };

  constructor(
    private readonly file: string,
    initial: TokenRecord,
    private readonly log: (line: string) => void,
  ) {
    const st = fs.statSync(file);
    this.cache = { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, credential: toCredential(initial) };
  }

  current(): LoginCredential {
    try {
      const st = fs.statSync(this.file);
      if (st.ino !== this.cache.ino || st.mtimeMs !== this.cache.mtimeMs || st.size !== this.cache.size) {
        const record = readTokenFile(this.file, this.log);
        const fresh = fs.statSync(this.file);
        this.cache = {
          ino: fresh.ino,
          mtimeMs: fresh.mtimeMs,
          size: fresh.size,
          credential: toCredential(record),
        };
        this.warned = false;
      }
      return this.cache.credential;
    } catch {
      if (!this.warned) {
        this.warned = true;
        this.log(`warning: ${this.file} is unreadable; using the last loaded login token`);
      }
      return this.cache.credential;
    }
  }
}

export class MemoryLoginSource implements LoginSource {
  readonly oneTime = true;
  private readonly credential: LoginCredential;

  constructor() {
    const token = randomBytes(32).toString("base64url");
    this.credential = { token, generation: 0, digest: sha256Hex(token) };
  }

  current(): LoginCredential {
    return this.credential;
  }
}

function mint(generation: number, opts: TokenFileOptions): TokenRecord {
  return {
    v: 1,
    token: randomBytes(32).toString("base64url"),
    generation,
    createdAt: formatTimestamp(opts.now()),
  };
}

function toCredential(record: TokenRecord): LoginCredential {
  return { token: record.token, generation: record.generation, digest: sha256Hex(record.token) };
}

function assertParent(file: string): void {
  const parent = path.dirname(file);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new LedgerError("invalid_request", `token file directory ${parent} does not exist`, 400);
  }
}

function readTokenFile(file: string, log: (line: string) => void): TokenRecord {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new LedgerError("invalid_request", `${file} must be a regular file`, 400);
  if ((st.mode & 0o077) !== 0) {
    fs.chmodSync(file, 0o600);
    log(`tightened permissions on ${file} to 0600`);
  }
  const text = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidToken(file);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalidToken(file);
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== TOKEN_KEYS.length || TOKEN_KEYS.some((key) => !keys.includes(key))) throw invalidToken(file);
  if (record.v !== 1) throw invalidToken(file);
  if (typeof record.token !== "string" || !TOKEN_RE.test(record.token)) throw invalidToken(file);
  if (typeof record.generation !== "number" || !Number.isSafeInteger(record.generation) || record.generation < 1) {
    throw invalidToken(file);
  }
  if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) throw invalidToken(file);
  return { v: 1, token: record.token, generation: record.generation, createdAt: record.createdAt };
}

function invalidToken(file: string): LedgerError {
  return new LedgerError("invalid_request", `${file}: invalid token file; run actledger serve --rotate-token`, 400);
}

function serialize(record: TokenRecord): string {
  return `{"v":1,"token":${JSON.stringify(record.token)},"generation":${record.generation},"createdAt":${JSON.stringify(record.createdAt)}}\n`;
}

function tmpPath(file: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

function createToken(file: string, record: TokenRecord, log: (line: string) => void): TokenRecord {
  const tmp = tmpPath(file);
  fs.writeFileSync(tmp, serialize(record), { flag: "wx", mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
  } catch (error) {
    fs.unlinkSync(tmp);
    if (errno(error) === "EEXIST") return readTokenFile(file, log);
    throw error;
  }
  fs.unlinkSync(tmp);
  fs.chmodSync(file, 0o600);
  return record;
}

function replaceToken(file: string, record: TokenRecord): void {
  const tmp = tmpPath(file);
  fs.writeFileSync(tmp, serialize(record), { flag: "wx", mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The rename already failed; surface that error.
    }
    throw error;
  }
  fs.chmodSync(file, 0o600);
}

function errno(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
