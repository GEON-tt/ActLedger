import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "@actledger/cli/console";
import { LedgerError } from "@actledger/core";

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const cleaned = text.replace(/ /g, "").replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new LedgerError("invalid_request", "invalid base32", 400);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

export function totpCode(secretB32: string, at: Date): string {
  return hotp(base32Decode(secretB32), totpStep(at), TOTP_DIGITS);
}

export function matchTotp(secretB32: string, code: string, at: Date, window = 1): number | null {
  const normalized = code.replace(/ /g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const secret = base32Decode(secretB32);
  const step = totpStep(at);
  for (let delta = -window; delta <= window; delta++) {
    const candidate = step + delta;
    if (candidate < 0) continue;
    if (safeEqual(hotp(secret, candidate), normalized)) return candidate;
  }
  return null;
}

export function otpauthUrl(input: { secret: string; username: string; issuer?: string }): string {
  const issuer = input.issuer ?? "ActLedger";
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(input.username)}`;
  const query = new URLSearchParams({ secret: input.secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${query.toString()}`;
}
