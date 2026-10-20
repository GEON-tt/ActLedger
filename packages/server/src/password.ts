import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { LedgerError } from "@actledger/core";

const SCRYPT = { N: 32768, r: 8, p: 1, keyLen: 32, saltLen: 16, maxmem: 64 * 1024 * 1024 } as const;

export function checkPasswordPolicy(password: string): void {
  const length = [...password.normalize("NFC")].length;
  if (length < 12 || length > 256) {
    throw new LedgerError("invalid_request", "password must be 12 to 256 characters", 400);
  }
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLen: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltLen);
  const out = await scryptAsync(password.normalize("NFC"), salt, SCRYPT.keyLen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${out.toString("base64url")}`;
}

function decodeBase64Url(text: string): Buffer | null {
  if (!text || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const decoded = Buffer.from(text, "base64url");
  return decoded.length > 0 ? decoded : null;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 16384 || N > 1_048_576 || (N & (N - 1)) !== 0) return false;
  if (r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = decodeBase64Url(parts[4] ?? "");
  const expected = decodeBase64Url(parts[5] ?? "");
  if (!salt || !expected) return false;
  try {
    const out = await scryptAsync(password.normalize("NFC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT.maxmem,
    });
    if (out.length !== expected.length) return false;
    return timingSafeEqual(out, expected);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

function loadDummy(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  return dummy;
}

/** Hash of a random password, created once on first use. Equalizes unknown-user login time. */
export const DUMMY_HASH: Promise<string> = {
  then(onFulfilled, onRejected) {
    return loadDummy().then(onFulfilled, onRejected);
  },
  catch(onRejected) {
    return loadDummy().catch(onRejected);
  },
  finally(onFinally) {
    return loadDummy().finally(onFinally);
  },
} as Promise<string>;
