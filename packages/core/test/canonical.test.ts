import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commit, jcs, sha256Hex } from "../src/canonical";
import { LedgerError } from "../src/errors";

const vectors = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../spec/test-vectors/jcs.json"),
    "utf8",
  ),
) as Array<{ value: unknown; jcs: string }>;

describe("jcs", () => {
  it("matches the committed vectors", () => {
    for (const vector of vectors) expect(jcs(vector.value)).toBe(vector.jcs);
  });

  it("hashes the canonical form", () => {
    expect(sha256Hex("{}")).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });

  it("rejects dates, maps, sets, and class instances", () => {
    class Box {
      n = 1;
    }
    for (const value of [new Date(), new Map(), new Set(), new Box(), { at: new Date() }]) {
      expect(() => jcs(value)).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    }
    const bare = Object.create(null) as Record<string, unknown>;
    bare.a = 1;
    expect(jcs(bare)).toBe('{"a":1}');
  });

  it("rejects floats", () => {
    expect(() => jcs({ amount: 1.5 })).toThrow(LedgerError);
    try {
      jcs({ amount: 1.5 });
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe("non_canonical_number");
    }
  });
});

describe("commitments", () => {
  it("is stable for the same salt and changes with the salt or value", () => {
    const salt = Buffer.alloc(32, 7);
    const first = commit(salt, "bob@x.com");
    expect(first).toBe(commit(salt, "bob@x.com"));
    expect(first.startsWith("hmac-sha256:")).toBe(true);
    expect(first).not.toBe(commit(salt, "bob@y.com"));
    expect(first).not.toBe(commit(Buffer.alloc(32, 8), "bob@x.com"));
  });
});
