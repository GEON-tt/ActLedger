import { describe, expect, it } from "vitest";
import { LedgerError } from "../src/errors";
import { loadPolicy } from "../src/policy/load";
import { evaluate } from "../src/policy/evaluate";
import { assuranceRank } from "../src/policy/schema";

const policyYaml = `
version: 1
defaults:
  unknown_action: require_approval
  timezone: UTC
  content_mode: strict
  approval:
    min_assurance: app_asserted
    timeout: 15m
  claim_deadline: 24h
  execution_timeout: 15m
coverage:
  - { action: "email.*", mode: enforced, via: mcp-proxy }
actions:
  email.read: { level: read }
  email.send: { level: send, blast_radius: others, reversible: false }
  order.place: { level: spend }
  db.delete: { level: delete }
rules:
  - id: small-order
    match: { action: order.place, amount.value: { lte: 5000 }, amount.currency: CNY }
    effect: allow
  - id: order-approve
    match: { action: order.place }
    effect: require_approval
    approval:
      step_up: { when: { amount.value: { gt: 50000 } }, method: sms_otp }
  - id: internal
    match: { action: email.send, attrs.recipient_domain: { in: ["mycorp.com"] }, grant.ladder_level: { gte: 3 } }
    effect: allow
  - id: external
    match: { action: email.send }
    effect: require_approval
  - id: night-delete
    match: { action: db.delete, attrs.env: prod, time.hour: { not_between: [9, 20] } }
    effect: deny
  - id: day-delete
    match: { action: db.delete, attrs.env: prod }
    effect: require_approval
    approval: { step_up: webauthn, allow_edit: false }
`;

describe("policy", () => {
  const loaded = loadPolicy(policyYaml);

  it("lets the first matching rule win and elevates high-risk assurance", () => {
    const small = evaluate(loaded, {
      type: "order.place",
      amount: { value: 5000, currency: "CNY" },
    }, { hour: 12, policyVersion: 1 });
    expect(small.result).toBe("allow");
    expect(small.ruleId).toBe("small-order");

    const big = evaluate(loaded, {
      type: "order.place",
      amount: { value: 60000, currency: "CNY" },
    }, { hour: 12, policyVersion: 1 });
    expect(big.result).toBe("require_approval");
    expect(big.stepUp).toBe("sms_otp");
    expect(big.minAssurance).toBe("channel_verified");
  });

  it("does not compare amounts across currencies", () => {
    const decision = evaluate(loaded, {
      type: "order.place",
      amount: { value: 100, currency: "USD" },
    }, { hour: 12, policyVersion: 1 });
    expect(decision.ruleId).toBe("order-approve");
  });

  it("matches glob coverage and grant level", () => {
    const external = evaluate(loaded, {
      type: "email.send",
      attrs: { recipient_domain: "client.com" },
    }, { hour: 12, policyVersion: 3 });
    expect(external.ruleId).toBe("external");
    expect(external.integrationMode).toBe("enforced");
    expect(external.coverageVia).toBe("mcp-proxy");
    expect(external.minAssurance).toBe("channel_verified");

    const blocked = evaluate(loaded, {
      type: "email.send",
      attrs: { recipient_domain: "mycorp.com" },
    }, { hour: 12, grantLevel: 0, policyVersion: 3 });
    expect(blocked.ruleId).toBe("external");

    const allowed = evaluate(loaded, {
      type: "email.send",
      attrs: { recipient_domain: "mycorp.com" },
    }, { hour: 12, grantLevel: 3, policyVersion: 3 });
    expect(allowed.ruleId).toBe("internal");
    expect(allowed.result).toBe("allow");
  });

  it("denies prod deletes outside working hours", () => {
    const night = evaluate(loaded, { type: "db.delete", attrs: { env: "prod" } }, { hour: 21, policyVersion: 1 });
    expect(night.result).toBe("deny");
    const day = evaluate(loaded, { type: "db.delete", attrs: { env: "prod" } }, { hour: 10, policyVersion: 1 });
    expect(day.result).toBe("require_approval");
    expect(day.stepUp).toBe("webauthn");
    expect(day.allowEdit).toBe(false);
  });

  it("falls through to the default for unknown actions", () => {
    const decision = evaluate(loaded, { type: "slack.post" }, { hour: 1, policyVersion: 1 });
    expect(decision.result).toBe("require_approval");
    expect(decision.ruleId).toBe("default:require_approval");
    expect(decision.coverageMatched).toBe(false);
    expect(decision.integrationMode).toBe("recorded");
  });

  it("warns when a high-risk action is not covered", () => {
    expect(loaded.warnings.map((warning) => warning.action).sort()).toEqual(["db.delete", "order.place"]);
  });

  it("ranks an unknown assurance below every known value", () => {
    expect(assuranceRank("policy")).toBe(0);
    expect(assuranceRank("app_asserted")).toBe(1);
    expect(assuranceRank("channel_verified")).toBe(2);
    expect(assuranceRank("user_signed")).toBe(3);
    expect(assuranceRank("not-a-real-assurance")).toBe(-1);
  });

  it("rejects a policy that uses a float", () => {
    expect(() => loadPolicy("version: 1\nrules:\n  - id: x\n    match: { amount.value: { lte: 1.5 } }\n    effect: allow\n")).toThrow(
      LedgerError,
    );
  });

  it("inherits defaults.approval and lets a rule override or clear step_up", () => {
    const loaded = loadPolicy(`
version: 1
defaults:
  unknown_action: require_approval
  approval:
    step_up: sms_otp
    min_assurance: channel_verified
    timeout: 15m
rules:
  - id: bare
    match: { action: notes.write }
    effect: require_approval
  - id: override
    match: { action: notes.send }
    effect: require_approval
    approval:
      step_up: webauthn
  - id: off
    match: { action: notes.off }
    effect: require_approval
    approval:
      step_up: null
  - id: timeout-only
    match: { action: notes.timeout }
    effect: require_approval
    approval:
      timeout: 5m
`);
    const bare = evaluate(loaded, { type: "notes.write" }, { hour: 12, policyVersion: 1 });
    expect(bare.stepUp).toBe("sms_otp");
    expect(bare.minAssurance).toBe("channel_verified");
    const unknown = evaluate(loaded, { type: "slack.post" }, { hour: 12, policyVersion: 1 });
    expect(unknown.result).toBe("require_approval");
    expect(unknown.stepUp).toBe("sms_otp");
    expect(evaluate(loaded, { type: "notes.send" }, { hour: 12, policyVersion: 1 }).stepUp).toBe("webauthn");
    const cleared = evaluate(loaded, { type: "notes.off" }, { hour: 12, policyVersion: 1 });
    expect(cleared.stepUp).toBeNull();
    expect(cleared.minAssurance).toBe("channel_verified");
    const timeoutOnly = evaluate(loaded, { type: "notes.timeout" }, { hour: 12, policyVersion: 1 });
    expect(timeoutOnly.stepUp).toBe("sms_otp");
    expect(timeoutOnly.minAssurance).toBe("channel_verified");
    expect(timeoutOnly.approvalTimeoutMs).toBe(5 * 60 * 1000);
  });

  it("keeps a higher default assurance on high-risk actions", () => {
    const loaded = loadPolicy(`
version: 1
defaults:
  approval:
    min_assurance: user_signed
actions:
  email.send: { level: send }
rules:
  - id: send
    match: { action: email.send }
    effect: require_approval
`);
    expect(evaluate(loaded, { type: "email.send" }, { hour: 12, policyVersion: 1 }).minAssurance).toBe("user_signed");
  });

  it("rejects approval blocks on allow, deny, and draft_only", () => {
    for (const effect of ["allow", "deny", "draft_only"]) {
      expect(() =>
        loadPolicy(`
version: 1
rules:
  - id: r
    match: { action: email.send }
    effect: ${effect}
    approval: { step_up: webauthn }
`),
      ).toThrowError(expect.objectContaining({ code: "policy_invalid", status: 422 }));
    }
    expect(() =>
      loadPolicy(`
version: 1
defaults:
  unknown_action: allow
  approval:
    step_up: sms_otp
`),
    ).not.toThrow();
  });
});
