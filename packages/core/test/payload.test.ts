import { describe, expect, it } from "vitest";
import { compareWithDrift, payloadHash, type Payload } from "../src/payload";

const approved: Payload = {
  action: "email.send",
  args: { to: ["bob@x.com"], subject: "Re: 报价" },
  content: { content_type: "text/plain", text: "hello" },
  allowed_drift: ["args.signature"],
};

describe("payload drift", () => {
  it("matches when only a whitelisted path changes", () => {
    const executed: Payload = {
      ...approved,
      args: { ...approved.args, signature: "—— Alice" },
    };
    const comparison = compareWithDrift(approved, executed);
    expect(comparison.match).toBe(true);
    expect(comparison.driftApplied).toEqual(["args.signature"]);
    expect(payloadHash(executed)).not.toBe(payloadHash(approved));
  });

  it("does not match when a non-whitelisted path changes", () => {
    const executed: Payload = {
      ...approved,
      args: { ...approved.args, subject: "different" },
    };
    expect(compareWithDrift(approved, executed).match).toBe(false);
  });

  it("rejects unsafe drift paths", () => {
    expect(() =>
      compareWithDrift({ action: "a", args: {}, allowed_drift: ["__proto__.x"] }, { action: "a", args: {} }),
    ).toThrow(/drift path/);
  });

  it("rejects drift paths that can erase a whole subtree", () => {
    for (const drift of ["args", "content", "action", "args."]) {
      expect(() =>
        compareWithDrift({ action: "a", args: { to: "bob" }, allowed_drift: [drift] }, { action: "a", args: {} }),
      ).toThrow(/drift path/);
    }
  });

  it("still allows a nested content path", () => {
    const base: Payload = {
      action: "a",
      args: {},
      content: { content_type: "text/plain", text: "a" },
      allowed_drift: ["content.text"],
    };
    const executed: Payload = { ...base, content: { content_type: "text/plain", text: "b" } };
    expect(compareWithDrift(base, executed).match).toBe(true);
  });
});
