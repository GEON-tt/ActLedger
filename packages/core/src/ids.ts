import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 26-char ULID (Crockford base32). */
export function ulid(time = Date.now()): string {
  let t = time;
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(10);
  let buffer = 0;
  let bits = 0;
  let rand = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += CROCKFORD[(buffer >> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  return timePart + rand;
}

export function newId(prefix: string, time = Date.now()): string {
  return `${prefix}_${ulid(time)}`;
}

export type IdFactory = (prefix: string) => string;

export function defaultIdFactory(now: () => Date = () => new Date()): IdFactory {
  return (prefix) => newId(prefix, now().getTime());
}
