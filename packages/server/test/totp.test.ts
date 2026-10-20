import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, matchTotp, newTotpSecret, otpauthUrl, totpCode } from "../src/totp.js";

const SHA1_SECRET = "12345678901234567890";
const SHA1_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const TIMES = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];
const EIGHT = ["94287082", "07081804", "14050471", "89005924", "69279037", "65353130"];
const SIX = ["287082", "081804", "050471", "005924", "279037", "353130"];

describe("totp", () => {
  it("matches the RFC 4648 base32 vectors", () => {
    const vectors: Array<[string, string]> = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [text, encoded] of vectors) {
      expect(base32Encode(Buffer.from(text))).toBe(encoded);
      expect(base32Decode(encoded).toString("utf8")).toBe(text);
      expect(base32Decode(encoded.toLowerCase()).toString("utf8")).toBe(text);
      expect(base32Decode(`${encoded}===`).toString("utf8")).toBe(text);
      if (encoded.length >= 4) {
        expect(base32Decode(`${encoded.slice(0, 2)} ${encoded.slice(2)}`).toString("utf8")).toBe(text);
      }
    }
    expect(() => base32Decode("MZ1")).toThrow(/base32/);
  });

  it("matches the RFC 6238 SHA1 vectors", () => {
    const secret = Buffer.from(SHA1_SECRET);
    expect(base32Encode(secret)).toBe(SHA1_B32);
    TIMES.forEach((time, index) => {
      expect(hotp(secret, Math.floor(time / 30), 8)).toBe(EIGHT[index]);
      expect(totpCode(SHA1_B32, new Date(time * 1000))).toBe(SIX[index]);
    });
  });

  it("accepts the current step and one step on either side", () => {
    const at = new Date(59 * 1000);
    const step = Math.floor(59 / 30);
    expect(matchTotp(SHA1_B32, SIX[0] ?? "", at)).toBe(step);
    expect(matchTotp(SHA1_B32, totpCode(SHA1_B32, new Date(0)), at)).toBe(step - 1);
    const ahead = totpCode(SHA1_B32, new Date(60 * 1000));
    expect(matchTotp(SHA1_B32, ahead, at)).toBe(step + 1);
    expect(matchTotp(SHA1_B32, totpCode(SHA1_B32, new Date(90 * 1000)), at)).toBeNull();
    expect(matchTotp(SHA1_B32, "12345", at)).toBeNull();
    expect(matchTotp(SHA1_B32, "abcdef", at)).toBeNull();
    expect(matchTotp(SHA1_B32, "287 082", at)).toBe(step);
  });

  it("builds an otpauth url and a 32 character secret", () => {
    expect(otpauthUrl({ secret: "ABC", username: "alice" })).toBe(
      "otpauth://totp/ActLedger:alice?secret=ABC&issuer=ActLedger&algorithm=SHA1&digits=6&period=30",
    );
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });
});
