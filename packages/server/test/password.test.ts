import { describe, expect, it } from "vitest";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "../src/password.js";

describe("password", () => {
  it("hashes with scrypt and verifies the same password", async () => {
    const first = await hashPassword("correct horse battery");
    const second = await hashPassword("correct horse battery");
    expect(first).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(await verifyPassword("correct horse battery", first)).toBe(true);
    expect(await verifyPassword("wrong horse battery", first)).toBe(false);
    expect(await verifyPassword("correct horse battery", "scrypt$1$2")).toBe(false);
    expect(await verifyPassword("correct horse battery", "scrypt$2$8$1$aaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(false);
  });

  it("treats NFC and NFD as the same password", async () => {
    const nfc = `correct horse caf${"\u00e9"}`;
    const nfd = `correct horse cafe${"\u0301"}`;
    const hash = await hashPassword(nfc);
    expect(await verifyPassword(nfd, hash)).toBe(true);
  });

  it("rejects short passwords", () => {
    expect(() => checkPasswordPolicy("short")).toThrow(/12 to 256/);
    expect(() => checkPasswordPolicy("123456789012")).not.toThrow();
  });
});
