import { describe, expect, it } from "vitest";
import { EN, ZH_CN, isMessageKey, t, tv, type MessageKey } from "../src/serve/i18n.js";
import { renderLogin, renderLoginEnded } from "../src/serve/html.js";

describe("console variant", () => {
  it("covers existing keys and falls back when a remote string is absent", () => {
    for (const key of Object.keys(EN)) {
      if (!key.startsWith("remote.")) continue;
      expect(isMessageKey(key.slice("remote.".length))).toBe(true);
    }
    expect(Object.keys(EN).sort()).toEqual(Object.keys(ZH_CN).sort());
    expect(tv("en", "local", "app.footer")).toBe(t("en", "app.footer"));
    expect(tv("en", "remote", "app.footer")).toBe(t("en", "remote.app.footer"));
    expect(tv("en", "remote", "app.name")).toBe("ActLedger");
    for (const key of Object.keys(EN) as MessageKey[]) expect(EN[key].length).toBeGreaterThan(0);
  });

  it("renders the remote login page and keeps the local logged-out page", () => {
    const login = renderLogin("en", { error: null, username: "" });
    expect(login).toContain('name="username"');
    expect(login).toContain('name="password"');
    expect(login).toContain('type="password"');
    expect(login).toContain('name="totp"');
    expect(login).toContain('autocomplete="one-time-code"');
    expect(login).toContain('action="/login"');
    expect(login).not.toContain("<script");
    expect(login).not.toContain("127.0.0.1");

    const failed = renderLogin("zh-CN", { error: "login.failed", username: "<b>" });
    expect(failed).toContain("用户名、密码或动态码不正确。");
    expect(failed).toContain("&lt;b&gt;");

    const remoteEnded = renderLoginEnded("en", "remote");
    expect(remoteEnded).toContain('href="/login"');
    expect(remoteEnded).not.toContain("--print-login");
    expect(renderLoginEnded("en")).toContain("actledger serve --print-login");
  });
});
