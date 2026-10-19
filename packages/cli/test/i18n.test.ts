import { describe, expect, it } from "vitest";
import {
  EN,
  ZH_CN,
  langCookie,
  parseAcceptLanguage,
  pickLocale,
  t,
  type MessageKey,
} from "../src/serve/i18n.js";

describe("parseAcceptLanguage", () => {
  it("maps tags and quality values onto the shipped locales", () => {
    expect(parseAcceptLanguage(undefined)).toBeNull();
    expect(parseAcceptLanguage("")).toBeNull();
    for (const header of ["zh-CN", "zh", "zh-Hans", "zh-Hans-CN", "zh-TW", "zh-HK"]) {
      expect(parseAcceptLanguage(header)).toBe("zh-CN");
    }
    expect(parseAcceptLanguage("en-US,en;q=0.9")).toBe("en");
    expect(parseAcceptLanguage("fr-FR, zh;q=0.5")).toBe("zh-CN");
    expect(parseAcceptLanguage("en;q=0.4, zh-CN;q=0.8")).toBe("zh-CN");
    expect(parseAcceptLanguage("fr")).toBeNull();
    expect(parseAcceptLanguage("zh;q=0")).toBeNull();
    expect(parseAcceptLanguage("*")).toBe("en");
    expect(parseAcceptLanguage("zh;q=abc, en")).toBe("en");
    expect(parseAcceptLanguage(";;,,q=")).toBeNull();
    expect(() => parseAcceptLanguage(`${"a,".repeat(400)}zh`)).not.toThrow();
  });
});

describe("pickLocale", () => {
  it("prefers a recognized lang query, then the cookie, then Accept-Language", () => {
    expect(pickLocale({}, null)).toEqual({ locale: "en" });

    const zh = pickLocale({}, new URL("http://127.0.0.1/?lang=zh-CN"));
    expect(zh.locale).toBe("zh-CN");
    expect(zh.setCookie).toBe("actledger_lang=zh-CN; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000");
    expect(langCookie("zh-CN")).toBe(zh.setCookie);

    const short = pickLocale({}, new URL("http://127.0.0.1/?lang=zh"));
    expect(short.locale).toBe("zh-CN");
    expect(short.setCookie).toContain("actledger_lang=zh-CN");

    expect(pickLocale({}, new URL("http://127.0.0.1/?lang=EN")).locale).toBe("en");

    const ignored = pickLocale({ "accept-language": "zh-CN" }, new URL("http://127.0.0.1/?lang=fr"));
    expect(ignored).toEqual({ locale: "zh-CN" });
    expect(ignored.setCookie).toBeUndefined();

    expect(
      pickLocale({ cookie: "actledger_lang=zh-CN", "accept-language": "en" }, new URL("http://127.0.0.1/")),
    ).toEqual({ locale: "zh-CN" });
    expect(pickLocale({ cookie: "actledger_lang=zh", "accept-language": "en" }, null).locale).toBe("en");
    expect(pickLocale({ cookie: "actledger_lang=<script>" }, null).locale).toBe("en");
    expect(pickLocale({ "accept-language": "en" }, null)).toEqual({ locale: "en" });
  });
});

describe("t", () => {
  it("interpolates known placeholders and keeps missing ones", () => {
    expect(t("en", "hint.assurance", { min: "channel_verified", id: "tsk_1" })).toBe(
      "Approve is disabled: this action needs channel_verified assurance, and this page can only record app_asserted. Approve it with the CLI (actledger approve tsk_1 --assurance channel_verified) or a verified channel. You can still reject it here with a reason.",
    );
    expect(t("en", "tl.rule")).toBe("rule {rule}");
    expect(Object.keys(EN).sort()).toEqual(Object.keys(ZH_CN).sort());
    for (const key of Object.keys(EN) as MessageKey[]) {
      expect(EN[key].length).toBeGreaterThan(0);
      expect(ZH_CN[key].length).toBeGreaterThan(0);
    }
  });

  it("keeps the English strings existing tests and docs assert", () => {
    expect(t("en", "list.sessionEnded")).toBe(
      "Session ended. Run actledger serve --print-login and open the URL again.",
    );
    expect(t("en", "list.updateFailed")).toBe("Update failed; retrying.");
    expect(t("en", "list.title.pending")).toBe("Pending approvals");
    expect(t("en", "list.title.recent")).toBe("Recent decisions");
    expect(t("en", "list.title.all")).toBe("All tasks");
    expect(t("en", "detail.approving")).toBe("You are approving");
    expect(t("en", "detail.approve")).toBe("Approve");
    expect(t("en", "detail.timeline")).toBe("Timeline");
    expect(t("en", "detail.decision")).toBe("Decision");
    expect(t("en", "tl.requested")).toBe("requested");
    expect(t("en", "tl.pending")).toBe("pending approval");
    expect(t("en", "tl.approvedPolicy")).toBe("approved by policy");
    expect(t("en", "tl.approved")).toBe("approved");
    expect(t("en", "tl.deniedPolicy")).toBe("denied by policy");
    expect(t("en", "tl.rejected")).toBe("rejected");
    expect(t("en", "tl.drafted")).toBe("drafted");
    expect(t("en", "tl.claimed")).toBe("claimed");
    expect(t("en", "tl.completed")).toBe("completed");
    expect(t("en", "tl.failed")).toBe("failed");
    expect(t("en", "tl.unknown")).toBe("unknown");
    expect(t("en", "tl.expired")).toBe("expired");
    expect(t("en", "tl.revoked")).toBe("revoked");
    expect(t("en", "tl.rule", { rule: "r1" })).toBe("rule r1");
    expect(t("en", "tl.approval", { approver: "u_1", channel: "web", assurance: "app_asserted" })).toBe(
      "by u_1 · channel web · assurance app_asserted",
    );
    expect(t("en", "tl.simulated")).toBe(" · simulated");
    expect(t("en", "tl.reasonRecorded")).toBe(" · reason recorded");
    expect(t("en", "tl.reason", { reason: "because" })).toBe("reason because");
    expect(t("en", "tl.error", { code: "boom" })).toBe("error boom");
    expect(t("en", "hint.channel")).toContain("策略不允许网页审批");
    expect(t("zh-CN", "hint.channel")).toContain("策略不允许网页审批");
    expect(t("en", "hint.stepUp", { stepUp: "pin", id: "tsk_1" })).toBe(
      "Approve is disabled: this action needs step-up pin, which this page cannot collect. Use the CLI (actledger approve tsk_1 --step-up).",
    );
  });
});
