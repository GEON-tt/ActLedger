import { describe, expect, it } from "vitest";
import { loadProvider, resolveProviderName } from "../providers/index.js";

describe("provider selection", () => {
  it("defaults to fake when nothing is set", () => {
    expect(resolveProviderName({})).toEqual({ name: "fake", suggestion: null });
  });

  it("suggests cursor without printing the key", () => {
    const secret = "sk-secret-should-not-print";
    const resolved = resolveProviderName({ CURSOR_API_KEY: secret });
    expect(resolved.name).toBe("fake");
    expect(resolved.suggestion).toContain("CURSOR_API_KEY");
    expect(resolved.suggestion).toContain("ACTLEDGER_DEMO_PROVIDER=cursor");
    expect(resolved.suggestion).not.toContain(secret);
  });

  it("suggests openai when that key is the first one set", () => {
    const resolved = resolveProviderName({ OPENAI_API_KEY: "x".repeat(20) });
    expect(resolved.suggestion).toContain("ACTLEDGER_DEMO_PROVIDER=openai");
  });

  it("uses an explicit provider name", () => {
    expect(resolveProviderName({ ACTLEDGER_DEMO_PROVIDER: "claude" }).name).toBe("claude");
  });

  it("rejects an unknown provider name", () => {
    expect(() => resolveProviderName({ ACTLEDGER_DEMO_PROVIDER: "gpt" })).toThrow(/must be one of/);
  });

  it("refuses real providers that have no key, before loading their SDKs", async () => {
    await expect(loadProvider("cursor", {})).rejects.toThrow(/CURSOR_API_KEY/);
    await expect(loadProvider("claude", {})).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(loadProvider("openai", {})).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("loads the fake provider", async () => {
    const provider = await loadProvider("fake", {});
    expect(provider.name).toBe("fake");
    await provider.close();
  });
});
