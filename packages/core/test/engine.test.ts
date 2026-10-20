import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commit, GENESIS_HASH, jcs, sha256Hex } from "../src/canonical";
import { signerFromPem, type Signer } from "../src/crypto";
import { LedgerError } from "../src/errors";
import { initLocalDir, openLedger, type LedgerEngine } from "../src/engine";
import { effectiveChannels } from "../src/policy/evaluate";
import { normalizePayload, payloadHash, type Payload } from "../src/payload";
import { buildReceipt, receiptHash, unsignedReceipt, type Receipt, type UnsignedReceipt } from "../src/receipts";
import { RECEIPT_V01, SECRETS_V } from "../src/secrets";
import { SqliteStore } from "../src/store/sqlite";
import { verifyReceiptChain } from "../src/verify";

const dirs: string[] = [];

function setup(policy?: string, clock?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-"));
  dirs.push(dir);
  initLocalDir(dir, policy ? { policyYaml: policy } : undefined);
  let now = clock ?? Date.now();
  const engine = openLedger({ dir, now: () => new Date(now) });
  return {
    dir,
    engine,
    advance(ms: number) {
      now += ms;
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function email(extra: Partial<Payload> = {}): Payload {
  return {
    action: "email.send",
    args: { to: ["bob@clienta.com"], subject: "Re: 报价" },
    content: { content_type: "text/plain", text: "hello" },
    ...extra,
  };
}

function requestEmail(engine: LedgerEngine, key = "k1") {
  return engine.request({
    principalId: "u_1",
    agentId: "mail-agent",
    intent: "回复邮件",
    action: { type: "email.send", attrs: { recipient_domain: "clienta.com" } },
    payload: email(),
    idempotencyKey: key,
  });
}

function approveSend(engine: LedgerEngine, taskId: string, presentedHash: string) {
  return engine.approve(taskId, {
    approverPrincipalId: "u_1",
    assurance: "channel_verified",
    presentedHash,
  });
}

function idempotencyResponses(dir: string): string {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "ledger.db"));
  try {
    const rows = db.prepare("SELECT response_json FROM idempotency").all() as Array<{ response_json: string }>;
    return rows.map((row) => row.response_json).join("\n");
  } finally {
    db.close();
  }
}

function withApprovalAssurance(dir: string, receipt: Receipt, assurance: string): Receipt {
  const app = JSON.parse(fs.readFileSync(path.join(dir, "app.json"), "utf8")) as { signingKid: string };
  const pem = fs.readFileSync(path.join(dir, "keys", "ed25519.pem"), "utf8");
  const signer = signerFromPem(app.signingKid, pem);
  const unsigned = unsignedReceipt(structuredClone(receipt));
  const approval = unsigned.body.approval;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    throw new Error("approved receipt has no approval body");
  }
  (approval as Record<string, unknown>).assurance = assurance;
  const { v: _version, ...rest } = unsigned;
  return buildReceipt(rest, signer);
}

function signerFor(dir: string): Signer {
  const app = JSON.parse(fs.readFileSync(path.join(dir, "app.json"), "utf8")) as { signingKid: string };
  return signerFromPem(app.signingKid, fs.readFileSync(path.join(dir, "keys", "ed25519.pem"), "utf8"));
}

function resignFrom(dir: string, receipts: Receipt[], index: number, mutate: (body: Record<string, unknown>) => void): Receipt[] {
  const signer = signerFor(dir);
  const next = structuredClone(receipts);
  mutate(next[index].body);
  let prev = next[index].prev_hash;
  for (let i = index; i < next.length; i++) {
    const unsigned = unsignedReceipt(next[i]);
    const { v: _version, ...rest } = unsigned;
    const rebuilt = buildReceipt({ ...rest, prev_hash: prev }, signer);
    next[i] = rebuilt;
    prev = rebuilt.hash;
  }
  return next;
}

function withVersion(dir: string, receipt: Receipt, version: Receipt["v"]): Receipt {
  const signer = signerFor(dir);
  const unsigned = unsignedReceipt(structuredClone(receipt));
  unsigned.v = version;
  const hash = receiptHash(unsigned);
  return { ...unsigned, hash, sig: { alg: "Ed25519", kid: signer.kid, value: signer.sign(hash) } };
}

function dumpPlainTables(dir: string): string {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "ledger.db"));
  try {
    return ["tasks", "approvals", "violations", "idempotency"]
      .map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()))
      .join("\n");
  } finally {
    db.close();
  }
}

describe("engine", () => {
  it("approves, claims once, completes, and verifies the chain", () => {
    const { engine } = setup();
    const created = requestEmail(engine);
    expect(created.task.state).toBe("pending_approval");
    expect(created.receipts).toHaveLength(2);
    expect(created.task.integrationMode).toBe("recorded");

    expect(() =>
      engine.approve(created.task.id, {
        approverPrincipalId: "u_1",
        assurance: "app_asserted",
        presentedHash: created.task.payloadHash,
        channel: "cli",
      }),
    ).toThrowError(expect.objectContaining({ code: "assurance_insufficient" }));

    const approved = engine.approve(created.task.id, {
      approverPrincipalId: "u_1",
      assurance: "channel_verified",
      presentedHash: created.task.payloadHash,
      channel: "cli",
      simulated: true,
    });
    expect(approved.task.state).toBe("approved");

    const claimed = engine.claim(created.task.id);
    expect(claimed.task.state).toBe("executing");
    expect(claimed.approvedPayload.args).toEqual(email().args);
    expect(() => engine.claim(created.task.id)).toThrowError(expect.objectContaining({ code: "already_claimed" }));

    const done = engine.complete(created.task.id, {
      executedPayload: claimed.approvedPayload,
      externalProofs: [{ type: "email_msgid", value: "<id@mail>" }],
    });
    expect(done.task.state).toBe("executed");
    expect(done.contentMatch).toBe(true);
    expect(done.receipt.body.evidence_assurance).toBe("E2");
    expect(JSON.stringify(done.receipt)).not.toContain("<id@mail>");

    const report = verifyReceiptChain(engine.exportReceipts(), engine.publicKeys());
    expect(report.ok).toBe(true);
    expect(report.failure).toBeUndefined();
  });

  it("rejects, revokes, and allows a read", () => {
    const { engine } = setup();
    const pending = requestEmail(engine, "reject");
    const rejected = engine.reject(pending.task.id, {
      approverPrincipalId: "u_1",
      assurance: "app_asserted",
      presentedHash: pending.task.payloadHash,
      reason: "no",
    });
    expect(rejected.task.state).toBe("rejected");
    expect(rejected.receipt.body.reason).toBe("rejected_by_user");
    expect(rejected.receipt.body.note_commit).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(rejected.receipt)).not.toContain('"no"');

    const other = requestEmail(engine, "revoke");
    engine.approve(other.task.id, {
      approverPrincipalId: "u_1",
      assurance: "channel_verified",
      presentedHash: other.task.payloadHash,
    });
    expect(engine.revoke(other.task.id, { actor: { type: "user", id: "u_1" } }).task.state).toBe("revoked");
    expect(() => engine.claim(other.task.id)).toThrowError(expect.objectContaining({ code: "invalid_transition" }));

    const drafted = engine.request({
      principalId: "u_1",
      action: { type: "email.read" },
      payload: { action: "email.read", args: {} },
    });
    expect(drafted.task.state).toBe("approved");
    expect(drafted.task.decision.ruleId).toBe("read-allow");
  });

  it("expires pending approvals and moves a claimed task to unknown", () => {
    const { engine, advance } = setup();
    const pending = engine.request({
      principalId: "u_1",
      action: { type: "email.send" },
      payload: email(),
      expiresIn: 30,
      idempotencyKey: "exp",
    });
    advance(31_000);
    expect(engine.sweep().expired).toEqual([pending.task.id]);
    expect(engine.getTask(pending.task.id)?.state).toBe("expired");
    expect(() =>
      engine.approve(pending.task.id, {
        approverPrincipalId: "u_1",
        assurance: "channel_verified",
        presentedHash: pending.task.payloadHash,
      }),
    ).toThrowError(expect.objectContaining({ code: "task_expired" }));

    const live = requestEmail(engine, "live");
    engine.approve(live.task.id, {
      approverPrincipalId: "u_1",
      assurance: "channel_verified",
      presentedHash: live.task.payloadHash,
    });
    const claimed = engine.claim(live.task.id);
    advance(16 * 60_000);
    expect(engine.sweep().unknown).toEqual([claimed.task.id]);
    expect(engine.getTask(claimed.task.id)?.state).toBe("unknown");
    expect(() => requestEmail(engine, "live")).toThrowError(expect.objectContaining({ code: "unresolved_unknown" }));

    const reconciled = engine.reconcile(claimed.task.id, {
      outcome: "executed",
      executedPayload: claimed.approvedPayload,
      note: "smtp log shows it was sent",
    });
    expect(reconciled.task.state).toBe("executed");
  });

  it("fails closed on content mismatch and allows a whitelisted drift in warn mode", () => {
    const { engine } = setup();
    const created = requestEmail(engine, "mismatch");
    engine.approve(created.task.id, {
      approverPrincipalId: "u_1",
      assurance: "channel_verified",
      presentedHash: created.task.payloadHash,
    });
    engine.claim(created.task.id);
    expect(() =>
      engine.complete(created.task.id, {
        executedPayload: { ...email(), args: { to: ["other@x.com"], subject: "changed" } },
      }),
    ).toThrowError(expect.objectContaining({ code: "content_mismatch" }));
    expect(engine.getTask(created.task.id)?.state).toBe("failed");

    const warnDir = setup(`
version: 1
defaults:
  content_mode: warn
  unknown_action: allow
actions:
  email.send: { level: send }
rules:
  - id: send
    match: { action: email.send }
    effect: allow
`);
    const allowed = warnDir.engine.request({
      principalId: "u_1",
      action: { type: "email.send" },
      payload: { ...email(), allowed_drift: ["args.signature"] },
    });
    const run = warnDir.engine.claim(allowed.task.id);
    const drifted = {
      ...run.approvedPayload,
      args: { ...run.approvedPayload.args, signature: "—— Alice" },
    };
    const done = warnDir.engine.complete(allowed.task.id, { executedPayload: drifted });
    expect(done.task.state).toBe("executed");
    expect(done.contentMatch).toBe(true);
    expect(done.receipt.body.drift_applied).toEqual(["args.signature"]);
    warnDir.engine.close();
  });

  it("denies a prod delete at night and requires step-up during the day", () => {
    const night = setup(undefined, Date.parse("2026-10-13T21:30:00.000Z"));
    const denied = night.engine.request({
      principalId: "u_1",
      action: { type: "db.delete", attrs: { env: "prod" } },
      payload: { action: "db.delete", args: { table: "orders" } },
    });
    expect(denied.task.state).toBe("rejected");
    expect(denied.task.decision.ruleId).toBe("deny-prod-delete-at-night");
    night.engine.close();

    const day = setup(undefined, Date.parse("2026-10-13T10:00:00.000Z"));
    const pending = day.engine.request({
      principalId: "u_1",
      action: { type: "db.delete", attrs: { env: "prod" } },
      payload: { action: "db.delete", args: { table: "orders" } },
    });
    expect(pending.task.decision.stepUp).toBe("webauthn");
    expect(() =>
      day.engine.approve(pending.task.id, {
        approverPrincipalId: "u_1",
        assurance: "user_signed",
        presentedHash: pending.task.payloadHash,
      }),
    ).toThrowError(expect.objectContaining({ code: "step_up_required" }));
    const approved = day.engine.approve(pending.task.id, {
      approverPrincipalId: "u_1",
      assurance: "user_signed",
      presentedHash: pending.task.payloadHash,
      stepUp: true,
      simulated: false,
    });
    expect(approved.task.state).toBe("approved");
    const auth = (approved.receipt.body.approval as { auth?: { step_up?: string; simulated?: boolean } }).auth;
    expect(auth?.step_up).toBe("webauthn");
    expect(auth?.simulated).toBe(true);
    day.engine.close();
  });

  it("records draft_only as drafted instead of rejected", () => {
    const { engine } = setup(`
version: 1
defaults:
  unknown_action: require_approval
actions:
  email.send: { level: draft }
rules:
  - id: drafts
    match: { level: draft }
    effect: draft_only
`);
    const drafted = engine.request({
      principalId: "u_1",
      action: { type: "email.send" },
      payload: email(),
    });
    expect(drafted.task.state).toBe("drafted");
    expect(drafted.task.decision.result).toBe("draft_only");
    expect(() => engine.claim(drafted.task.id)).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
    engine.close();
  });

  it("replays an identical idempotency key and conflicts on a different body", () => {
    const { engine } = setup();
    const first = requestEmail(engine, "same");
    const again = requestEmail(engine, "same");
    expect(again.task.id).toBe(first.task.id);
    expect(() =>
      engine.request({
        principalId: "u_1",
        action: { type: "email.send", attrs: { recipient_domain: "other.com" } },
        payload: email(),
        idempotencyKey: "same",
      }),
    ).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
  });

  it("rejects a presented hash mismatch and an approver mismatch", () => {
    const { engine } = setup();
    const created = requestEmail(engine, "hash");
    expect(() =>
      engine.approve(created.task.id, {
        approverPrincipalId: "u_1",
        assurance: "channel_verified",
        presentedHash: "sha256:dead",
      }),
    ).toThrowError(expect.objectContaining({ code: "presented_hash_mismatch" }));
    expect(() =>
      engine.approve(created.task.id, {
        approverPrincipalId: "someone-else",
        assurance: "channel_verified",
        presentedHash: created.task.payloadHash,
      }),
    ).toThrowError(expect.objectContaining({ code: "approver_mismatch" }));
  });

  it("keeps the chain append-only and detects tampering", () => {
    const { dir, engine } = setup();
    const created = engine.request({
      principalId: "u_1",
      action: { type: "calendar.create" },
      payload: { action: "calendar.create", args: { title: "standup" } },
    });
    engine.claim(created.task.id);
    engine.complete(created.task.id, {
      executedPayload: { action: "calendar.create", args: { title: "standup" } },
    });
    const original = engine.exportReceipts();
    const keys = engine.publicKeys();
    expect(verifyReceiptChain(original, keys).ok).toBe(true);

    const gapped = [original[0], ...original.slice(2)];
    expect(verifyReceiptChain(gapped, keys).failure?.step).toBe("chain");

    const mutated = structuredClone(original);
    mutated[1].body = { ...mutated[1].body, tampered: true };
    expect(verifyReceiptChain(mutated, keys).failure?.step).toBe("hash");

    engine.reportViolation({ actionType: "shell.exec", description: "ran outside the ledger", agentId: "mail-agent" });
    const withViolation = verifyReceiptChain(engine.exportReceipts(), keys);
    expect(withViolation.ok).toBe(true);
    expect(withViolation.stats.violations).toBe(1);

    engine.close();
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(path.join(dir, "ledger.db"));
    expect(() => db.prepare("UPDATE receipts SET hash = 'x' WHERE seq = 1").run()).toThrow(/append-only/);
    db.close();
  });

  it("does not publish a second policy receipt when reopened", () => {
    const { dir, engine } = setup();
    const before = engine.exportReceipts().length;
    engine.close();
    const again = openLedger({ dir });
    expect(again.exportReceipts().length).toBe(before);
    again.close();
  });

  it("makes a shredded payload unreadable", () => {
    const { engine } = setup();
    const created = engine.request({
      principalId: "u_1",
      action: { type: "calendar.create" },
      payload: { action: "calendar.create", args: { title: "secret" } },
    });
    engine.shredPrincipal("u_1");
    expect(() => engine.claim(created.task.id)).toThrowError(expect.objectContaining({ code: "not_found" }));
  });

  it("rejects an assurance that is not a user assurance before ranking it", () => {
    const { engine } = setup();
    const created = requestEmail(engine, "bad-assurance");
    for (const assurance of ["policy", "notarand"]) {
      expect(() =>
        engine.approve(created.task.id, {
          approverPrincipalId: "u_1",
          assurance: assurance as "app_asserted",
          presentedHash: created.task.payloadHash,
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_request", status: 400 }));
    }
    expect(() =>
      engine.reject(created.task.id, {
        approverPrincipalId: "u_1",
        assurance: "policy" as "app_asserted",
        presentedHash: created.task.payloadHash,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_request", status: 400 }));
    expect(engine.getTask(created.task.id)?.state).toBe("pending_approval");
    engine.close();
  });

  it("fails verification when an approved receipt's assurance misses min_assurance", () => {
    const allowed = setup();
    allowed.engine.request({
      principalId: "u_1",
      action: { type: "calendar.create" },
      payload: { action: "calendar.create", args: { title: "standup" } },
    });
    expect(verifyReceiptChain(allowed.engine.exportReceipts(), allowed.engine.publicKeys()).ok).toBe(true);
    allowed.engine.close();

    const { dir, engine } = setup();
    const created = requestEmail(engine, "verify-assurance");
    engine.approve(created.task.id, {
      approverPrincipalId: "u_1",
      assurance: "channel_verified",
      presentedHash: created.task.payloadHash,
    });
    const receipts = engine.exportReceipts();
    const keys = engine.publicKeys();
    expect(verifyReceiptChain(receipts, keys).ok).toBe(true);
    const approved = receipts.find((receipt) => receipt.transition?.to === "approved");
    expect(approved).toBeTruthy();
    for (const assurance of ["app_asserted", "policy", "notarand"]) {
      const tampered = receipts.map((receipt) =>
        receipt.id === approved?.id ? withApprovalAssurance(dir, receipt, assurance) : receipt,
      );
      const report = verifyReceiptChain(tampered, keys);
      expect(report.ok).toBe(false);
      expect(report.failure?.step).toBe("semantics");
    }
    engine.close();
  });

  it("does not keep claim payloads in the idempotency row", () => {
    const { dir, engine } = setup();
    const marker = "draft-body-7f3c";
    const proof = "proof-value-9aa1";
    const created = engine.request({
      principalId: "u_1",
      action: { type: "email.send" },
      payload: {
        ...email(),
        args: { ...email().args, note: marker },
        content: { content_type: "text/plain", text: marker },
      },
      idempotencyKey: "req-marker",
    });
    approveSend(engine, created.task.id, created.task.payloadHash);
    const claimed = engine.claim(created.task.id, { idempotencyKey: "claim-marker" });
    expect(claimed.approvedPayload.content?.text).toBe(marker);
    const replay = engine.claim(created.task.id, { idempotencyKey: "claim-marker" });
    expect(replay.approvedPayload).toEqual(claimed.approvedPayload);
    expect(replay.task.id).toBe(claimed.task.id);
    engine.complete(created.task.id, {
      executedPayload: claimed.approvedPayload,
      externalProofs: [{ type: "email_msgid", value: proof }],
      idempotencyKey: "complete-marker",
    });
    engine.close();
    const stored = idempotencyResponses(dir);
    expect(stored).not.toContain(marker);
    expect(stored).not.toContain(proof);
    const again = openLedger({ dir });
    again.shredPrincipal("u_1");
    expect(() => again.claim(created.task.id, { idempotencyKey: "claim-marker" })).toThrowError(
      expect.objectContaining({ code: "not_found", message: "content deleted" }),
    );
    again.close();
  });

  it("scopes mutation idempotency keys to the task", () => {
    const { engine } = setup();
    const first = requestEmail(engine, "fail-a");
    const second = requestEmail(engine, "fail-b");
    approveSend(engine, first.task.id, first.task.payloadHash);
    approveSend(engine, second.task.id, second.task.payloadHash);
    engine.claim(first.task.id);
    engine.claim(second.task.id);
    const error = { code: "smtp_down", message: "connection reset" };
    const failedA = engine.fail(first.task.id, { error, idempotencyKey: "shared-fail" });
    const failedB = engine.fail(second.task.id, { error, idempotencyKey: "shared-fail" });
    expect(failedA.task.id).toBe(first.task.id);
    expect(failedB.task.id).toBe(second.task.id);
    expect(engine.getTask(second.task.id)?.state).toBe("failed");
    const replay = engine.fail(first.task.id, { error, idempotencyKey: "shared-fail" });
    expect(replay.task.id).toBe(first.task.id);
    expect(replay.receipt.id).toBe(failedA.receipt.id);
    engine.close();
  });

  it("expires a claim deadline and a pending rejection without a sweep", () => {
    const claimClock = setup();
    const live = claimClock.engine.request({
      principalId: "u_1",
      action: { type: "calendar.create" },
      payload: { action: "calendar.create", args: { title: "standup" } },
    });
    expect(live.task.state).toBe("approved");
    claimClock.advance(24 * 60 * 60 * 1000 + 1);
    expect(() => claimClock.engine.claim(live.task.id)).toThrowError(
      expect.objectContaining({ code: "task_expired", status: 410 }),
    );
    expect(claimClock.engine.getTask(live.task.id)?.state).toBe("expired");
    claimClock.engine.close();

    const rejectClock = setup();
    const pending = rejectClock.engine.request({
      principalId: "u_1",
      action: { type: "email.send" },
      payload: email(),
      expiresIn: 30,
    });
    rejectClock.advance(30_001);
    expect(() =>
      rejectClock.engine.reject(pending.task.id, {
        approverPrincipalId: "u_1",
        assurance: "app_asserted",
        presentedHash: pending.task.payloadHash,
      }),
    ).toThrowError(expect.objectContaining({ code: "task_expired", status: 410 }));
    expect(rejectClock.engine.getTask(pending.task.id)?.state).toBe("expired");
    rejectClock.engine.close();
  });

  it("rejects expiresIn outside a positive week and drift paths that erase a subtree", () => {
    const { engine } = setup();
    const week = 7 * 24 * 60 * 60;
    for (const expiresIn of [0, -1, 1.5, week + 1]) {
      expect(() =>
        engine.request({
          principalId: "u_1",
          action: { type: "calendar.create" },
          payload: { action: "calendar.create", args: { title: "standup" } },
          expiresIn,
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    }
    const bounded = engine.request({
      principalId: "u_1",
      action: { type: "calendar.create" },
      payload: { action: "calendar.create", args: { title: "standup" } },
      expiresIn: week,
    });
    expect(bounded.task.state).toBe("approved");

    expect(() =>
      engine.request({
        principalId: "u_1",
        action: { type: "email.send" },
        payload: { ...email(), allowed_drift: ["args", "content"] },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_request", status: 400 }));

    const created = engine.request({
      principalId: "u_1",
      action: { type: "email.send" },
      payload: { ...email(), allowed_drift: ["args.signature"] },
      idempotencyKey: "drift-recipient",
    });
    approveSend(engine, created.task.id, created.task.payloadHash);
    engine.claim(created.task.id);
    expect(() =>
      engine.complete(created.task.id, {
        executedPayload: {
          ...email(),
          args: { to: ["other@x.com"], subject: "Re: 报价", signature: "—— Alice" },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "content_mismatch" }));
    expect(engine.getTask(created.task.id)?.state).toBe("failed");
    engine.close();
  });

  it("keeps using a loaded policy when policy.yaml later fails to parse", () => {
    const { dir, engine } = setup();
    const created = engine.request({
      principalId: "u_1",
      action: { type: "calendar.create" },
      payload: { action: "calendar.create", args: { title: "standup" } },
    });
    engine.claim(created.task.id);
    fs.writeFileSync(path.join(dir, "policy.yaml"), "version: [\n");
    const done = engine.complete(created.task.id, {
      executedPayload: { action: "calendar.create", args: { title: "standup" } },
    });
    expect(done.task.state).toBe("executed");
    engine.close();
    fs.rmSync(path.join(dir, "policy.yaml"));
    expect(() => openLedger({ dir })).toThrowError(expect.objectContaining({ code: "policy_invalid" }));
  });

  it("turns on secure_delete for sqlite connections", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "probe.db"), randomBytes(32));
    const row = store.raw().prepare("PRAGMA secure_delete").get() as { secure_delete: number };
    expect(row.secure_delete).toBe(1);
    store.close();
  });

  it("keeps plaintext out of receipts and the plaintext tables", () => {
    const { dir, engine, advance } = setup();
    const marks = {
      intent: "marker-intent-9f3a",
      error: "marker-error-9f3b",
      reject: "marker-reject-9f3c",
      revoke: "marker-revoke-9f3d",
      reconcile: "marker-reconcile-9f3e",
      violation: "marker-violation-9f3f",
      payload: "marker-payload-9f40",
    };
    const payload = {
      ...email(),
      content: { content_type: "text/plain", text: marks.payload },
    };
    const rejected = engine.request({
      principalId: "u_1",
      intent: marks.intent,
      action: { type: "email.send" },
      payload,
      idempotencyKey: "plain-reject",
    });
    engine.reject(rejected.task.id, {
      approverPrincipalId: "u_1",
      assurance: "app_asserted",
      presentedHash: rejected.task.payloadHash,
      note: marks.reject,
      idempotencyKey: "plain-reject-note",
    });
    const revoked = requestEmail(engine, "plain-revoke");
    approveSend(engine, revoked.task.id, revoked.task.payloadHash);
    engine.revoke(revoked.task.id, { actor: { type: "user", id: "u_1" }, note: marks.revoke, idempotencyKey: "plain-revoke-note" });
    const failed = requestEmail(engine, "plain-fail");
    approveSend(engine, failed.task.id, failed.task.payloadHash);
    engine.claim(failed.task.id);
    engine.fail(failed.task.id, { error: { code: "smtp_down", message: marks.error }, idempotencyKey: "plain-fail-note" });
    const timed = requestEmail(engine, "plain-reconcile");
    approveSend(engine, timed.task.id, timed.task.payloadHash);
    engine.claim(timed.task.id);
    advance(16 * 60_000);
    engine.sweep();
    engine.reconcile(timed.task.id, { outcome: "failed", note: marks.reconcile });
    engine.reportViolation({ actionType: "shell.exec", description: marks.violation, principalId: "u_1" });
    const exported = JSON.stringify(engine.exportReceipts());
    engine.close();
    const stored = dumpPlainTables(dir);
    for (const mark of Object.values(marks)) {
      expect(exported).not.toContain(mark);
      expect(stored).not.toContain(mark);
    }
    expect(exported).not.toContain(sha256Hex(jcs(normalizePayload(payload))));
  });

  it("uses a per-task salt for payload commitments", () => {
    const { engine } = setup();
    const payload = { action: "calendar.create", args: { title: "standup" } };
    const first = engine.request({
      principalId: "u_1",
      action: { type: "calendar.create" },
      payload,
      idempotencyKey: "salt-a",
    });
    const second = engine.request({
      principalId: "u_1",
      action: { type: "calendar.create" },
      payload,
      idempotencyKey: "salt-b",
    });
    expect(first.task.payloadHash.startsWith("hmac-sha256:")).toBe(true);
    expect(first.task.payloadHash).not.toBe(second.task.payloadHash);
    const run = engine.claim(first.task.id);
    const done = engine.complete(first.task.id, { executedPayload: run.approvedPayload });
    const executed = done.receipt.body;
    expect(executed.approved_payload_hash).toBe(first.task.payloadHash);
    expect(executed.executed_hash).toBe(first.task.payloadHash);
    expect(executed.content_match).toBe(true);
    const approved = engine.exportReceipts().find((receipt) => receipt.task_id === first.task.id && receipt.transition?.to === "approved");
    const presented = (approved?.body.approval as { presented_hash?: string } | undefined)?.presented_hash;
    expect(presented).toBe(first.task.payloadHash);
    expect(String(presented).startsWith("hmac-sha256:")).toBe(true);

    const drifted = engine.request({
      principalId: "u_1",
      action: { type: "email.send" },
      payload: { ...email(), allowed_drift: ["args.signature"] },
      idempotencyKey: "salt-drift",
    });
    approveSend(engine, drifted.task.id, drifted.task.payloadHash);
    const claimed = engine.claim(drifted.task.id);
    const finished = engine.complete(drifted.task.id, {
      executedPayload: {
        ...claimed.approvedPayload,
        args: { ...claimed.approvedPayload.args, signature: "—— Alice" },
      },
    });
    expect(finished.receipt.body.executed_hash).not.toBe(finished.receipt.body.approved_payload_hash);
    expect(finished.contentMatch).toBe(true);
    expect(finished.receipt.body.drift_applied).toEqual(["args.signature"]);
    engine.close();
  });

  it("fails plaintext and commitment checks on a re-signed 0.2 receipt", () => {
    const { dir, engine } = setup();
    const created = engine.request({
      principalId: "u_1",
      action: { type: "email.send" },
      payload: { ...email(), allowed_drift: ["args.signature"] },
      idempotencyKey: "tamper",
    });
    approveSend(engine, created.task.id, created.task.payloadHash);
    const claimed = engine.claim(created.task.id);
    engine.complete(created.task.id, {
      executedPayload: {
        ...claimed.approvedPayload,
        args: { ...claimed.approvedPayload.args, signature: "—— Alice" },
      },
    });
    const receipts = engine.exportReceipts();
    const keys = engine.publicKeys();
    const last = receipts.length - 1;
    const approvedIndex = receipts.findIndex((receipt) => receipt.transition?.to === "approved" && receipt.task_id === created.task.id);
    expect(verifyReceiptChain(receipts, keys).ok).toBe(true);
    expect(
      verifyReceiptChain(resignFrom(dir, receipts, last, (body) => {
        const initiator = body.initiator as Record<string, unknown>;
        initiator.intent = "visible";
      }), keys).failure?.step,
    ).toBe("plaintext");
    expect(
      verifyReceiptChain(resignFrom(dir, receipts, last, (body) => {
        body.error = { code: "smtp_down", message: "visible" };
      }), keys).failure?.step,
    ).toBe("plaintext");
    expect(
      verifyReceiptChain(resignFrom(dir, receipts, last, (body) => {
        body.reason = "because I said so";
      }), keys).failure?.step,
    ).toBe("plaintext");
    expect(
      verifyReceiptChain(resignFrom(dir, receipts, approvedIndex, (body) => {
        const approval = body.approval as Record<string, unknown>;
        approval.presented_hash = `hmac-sha256:${"ab".repeat(32)}`;
      }), keys).failure?.step,
    ).toBe("commitments");
    expect(
      verifyReceiptChain(resignFrom(dir, receipts, last, (body) => {
        body.executed_hash = body.approved_payload_hash;
      }), keys).failure?.step,
    ).toBe("commitments");
    expect(() => engine.fail(created.task.id, { error: { code: "Bad Code", message: "x" } })).toThrowError(
      expect.objectContaining({ code: "invalid_request", status: 400 }),
    );
    engine.close();
  });

  it("rejects a task that mixes receipt 0.1 and 0.2", () => {
    const { dir, engine } = setup();
    const created = engine.request({
      principalId: "u_1",
      action: { type: "calendar.create" },
      payload: { action: "calendar.create", args: { title: "standup" } },
    });
    engine.claim(created.task.id);
    engine.complete(created.task.id, {
      executedPayload: { action: "calendar.create", args: { title: "standup" } },
    });
    const receipts = engine.exportReceipts();
    const keys = engine.publicKeys();
    const mixed = receipts.map((receipt, index) =>
      index === receipts.length - 1 ? withVersion(dir, receipt, RECEIPT_V01) : receipt,
    );
    expect(verifyReceiptChain(mixed, keys).ok).toBe(false);
    engine.close();
  });

  it("refuses schema 1 while a task is still open and opens once every task is terminal", () => {
    const open = setup();
    open.engine.request({
      principalId: "u_1",
      action: { type: "email.send" },
      payload: email(),
    });
    open.engine.close();
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const pendingDb = new DatabaseSync(path.join(open.dir, "ledger.db"));
    pendingDb.prepare("UPDATE meta SET value = '1' WHERE key = 'schema'").run();
    pendingDb.close();
    expect(() => openLedger({ dir: open.dir })).toThrowError(
      expect.objectContaining({ code: "invalid_request", status: 400, message: "ledger.db uses schema 1 and has 1 unfinished task(s). Finish them with the ActLedger version that created them, or run actledger init in a new directory." }),
    );

    const done = setup();
    const created = done.engine.request({
      principalId: "u_1",
      action: { type: "calendar.create" },
      payload: { action: "calendar.create", args: { title: "standup" } },
    });
    done.engine.claim(created.task.id);
    done.engine.complete(created.task.id, {
      executedPayload: { action: "calendar.create", args: { title: "standup" } },
    });
    done.engine.close();
    const terminalDb = new DatabaseSync(path.join(done.dir, "ledger.db"));
    terminalDb.prepare("UPDATE meta SET value = '1' WHERE key = 'schema'").run();
    terminalDb.close();
    const reopened = openLedger({ dir: done.dir });
    expect(reopened.listTasks()[0]?.state).toBe("executed");
    reopened.close();
  });

  it("stores an idempotency digest instead of a bare request hash", () => {
    const { dir, engine } = setup();
    const input = {
      principalId: "u_1",
      intent: "digest",
      action: { type: "calendar.create" },
      payload: { action: "calendar.create", args: { title: "standup" } },
      idempotencyKey: "digest-1",
    };
    const first = engine.request(input);
    const again = engine.request(input);
    expect(again.task.id).toBe(first.task.id);
    engine.close();
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(path.join(dir, "ledger.db"));
    const row = db.prepare("SELECT request_hash FROM idempotency").get() as { request_hash: string };
    db.close();
    const canon = {
      principalId: input.principalId,
      agentId: null,
      intent: input.intent,
      action: JSON.parse(JSON.stringify(input.action)) as unknown,
      payload: normalizePayload(input.payload),
      expiresIn: null,
      metadata: null,
    };
    expect(row.request_hash).not.toBe(sha256Hex(jcs(canon)));
  });

  it("still verifies after shred, and sweep can finish the task without the salt", () => {
    const { engine, advance } = setup();
    const payload = { action: "calendar.create", args: { title: "secret" } };
    const created = engine.request({
      principalId: "u_1",
      intent: "secret intent",
      action: { type: "calendar.create" },
      payload,
    });
    const hash = created.task.payloadHash;
    engine.shredPrincipal("u_1");
    expect(verifyReceiptChain(engine.exportReceipts(), engine.publicKeys()).ok).toBe(true);
    const secrets = engine.exportSecrets();
    expect(secrets.find((entry) => entry.kind === "task" && entry.task_id === created.task.id)).toMatchObject({
      shredded: true,
    });
    expect(() => engine.taskIntent(created.task.id)).toThrowError(
      expect.objectContaining({ code: "not_found", message: "content deleted" }),
    );
    expect(() => engine.claim(created.task.id)).toThrowError(
      expect.objectContaining({ code: "not_found", message: "content deleted" }),
    );
    advance(24 * 60 * 60 * 1000 + 1);
    expect(engine.sweep().expired).toContain(created.task.id);
    expect(commit(randomBytes(32), normalizePayload(payload))).not.toBe(hash);
    engine.close();
  });

  it("requires step-up only when the condition matches, and verify catches a forged step-up", () => {
    const { dir, engine } = setup(`
version: 1
defaults:
  unknown_action: require_approval
  approval:
    min_assurance: app_asserted
actions:
  order.place: { level: spend }
rules:
  - id: order
    match: { action: order.place }
    effect: require_approval
    approval:
      min_assurance: app_asserted
      step_up: { when: { amount.value: { gt: 50000 } }, method: sms_otp }
`);
    const big = engine.request({
      principalId: "u_1",
      action: { type: "order.place", amount: { value: 60000, currency: "CNY" } },
      payload: { action: "order.place", args: { sku: "x" } },
    });
    expect(big.task.decision.stepUp).toBe("sms_otp");
    expect(() =>
      engine.approve(big.task.id, {
        approverPrincipalId: "u_1",
        assurance: "app_asserted",
        presentedHash: big.task.payloadHash,
      }),
    ).toThrowError(expect.objectContaining({ code: "step_up_required" }));
    const small = engine.request({
      principalId: "u_1",
      action: { type: "order.place", amount: { value: 10000, currency: "CNY" } },
      payload: { action: "order.place", args: { sku: "y" } },
    });
    expect(small.task.decision.stepUp).toBeNull();
    const approved = engine.approve(small.task.id, {
      approverPrincipalId: "u_1",
      assurance: "app_asserted",
      presentedHash: small.task.payloadHash,
    });
    const auth = (approved.receipt.body.approval as { auth?: { step_up?: string | null } }).auth;
    expect(auth?.step_up).toBeNull();
    const stepped = engine.approve(big.task.id, {
      approverPrincipalId: "u_1",
      assurance: "app_asserted",
      presentedHash: big.task.payloadHash,
      stepUp: true,
    });
    expect((stepped.receipt.body.approval as { auth?: { simulated?: boolean } }).auth?.simulated).toBe(true);
    const receipts = engine.exportReceipts();
    const keys = engine.publicKeys();
    const index = receipts.findIndex((receipt) => receipt.id === stepped.receipt.id);
    expect(
      verifyReceiptChain(resignFrom(dir, receipts, index, (body) => {
        const approval = body.approval as { auth: { step_up: string | null; simulated: boolean } };
        approval.auth.step_up = null;
      }), keys).ok,
    ).toBe(false);
    expect(
      verifyReceiptChain(resignFrom(dir, receipts, index, (body) => {
        const approval = body.approval as { auth: { simulated: boolean } };
        approval.auth.simulated = false;
      }), keys).ok,
    ).toBe(false);
    engine.close();
  });

  it("replays reject and revoke receipts with their enumerated reason", () => {
    const { engine } = setup();
    const pending = requestEmail(engine, "idem-reject-task");
    const rejected = engine.reject(pending.task.id, {
      approverPrincipalId: "u_1",
      assurance: "app_asserted",
      presentedHash: pending.task.payloadHash,
      reason: "no",
      idempotencyKey: "idem-reject",
    });
    const rejectedAgain = engine.reject(pending.task.id, {
      approverPrincipalId: "u_1",
      assurance: "app_asserted",
      presentedHash: pending.task.payloadHash,
      reason: "no",
      idempotencyKey: "idem-reject",
    });
    expect(rejectedAgain.receipt).toEqual(rejected.receipt);

    const live = requestEmail(engine, "idem-revoke-task");
    approveSend(engine, live.task.id, live.task.payloadHash);
    const revoked = engine.revoke(live.task.id, {
      actor: { type: "user", id: "u_1" },
      note: "stop",
      idempotencyKey: "idem-revoke",
    });
    const revokedAgain = engine.revoke(live.task.id, {
      actor: { type: "user", id: "u_1" },
      note: "stop",
      idempotencyKey: "idem-revoke",
    });
    expect(revokedAgain.receipt).toEqual(revoked.receipt);

    const keys = engine.publicKeys();
    const receipts = engine.exportReceipts().map((receipt) => {
      if (receipt.id === rejected.receipt.id) return rejectedAgain.receipt;
      if (receipt.id === revoked.receipt.id) return revokedAgain.receipt;
      return receipt;
    });
    expect(verifyReceiptChain(receipts, keys).ok).toBe(true);
    engine.close();
  });

  it("rejects a re-signed 0.2 receipt whose error is not an object", () => {
    const { dir, engine } = setup();
    const created = engine.request({
      principalId: "u_1",
      action: { type: "calendar.create" },
      payload: { action: "calendar.create", args: { title: "standup" } },
    });
    engine.claim(created.task.id);
    engine.complete(created.task.id, {
      executedPayload: { action: "calendar.create", args: { title: "standup" } },
    });
    const receipts = engine.exportReceipts();
    const tampered = resignFrom(dir, receipts, receipts.length - 1, (body) => {
      body.error = "visible";
    });
    const report = verifyReceiptChain(tampered, engine.publicKeys());
    expect(report.ok).toBe(false);
    expect(report.failure?.step).toMatch(/^(plaintext|structure)$/);
    engine.close();
  });

  it("verifies schema-1 secrets that have no executed payload and an untyped proof", () => {
    const { dir, engine } = setup();
    const signer = signerFor(dir);
    const keys = engine.publicKeys();
    engine.close();
    const payload: Payload = { action: "calendar.create", args: { title: "standup" } };
    const hash = payloadHash(payload);
    const proofSalt = Buffer.alloc(32, 4);
    const proofValue = "<id@mail>";
    const proofCommit = commit(proofSalt, proofValue);
    const taskId = "tsk_legacy";
    const shared = {
      kind: "task.transition",
      initiator: { principal_id: "u_1", agent_id: "mail-agent", intent: "create standup" },
      action: { type: "calendar.create", level: "write", blast_radius: "self", reversible: true },
      policy: { rule_id: "calendar-allow", policy_version: 1, ladder_level: 0 },
      integration: { mode: "recorded", coverage: "none", coverage_version: 1 },
      payload_hash: hash,
    };
    const steps: Array<{ from: string | null; to: string; actor: Receipt["actor"]; extra: Record<string, unknown> }> = [
      { from: null, to: "prepared", actor: { type: "agent", id: "mail-agent" }, extra: {} },
      {
        from: "prepared",
        to: "approved",
        actor: { type: "policy", id: "calendar-allow" },
        extra: {
          approval: {
            approver: "policy:calendar-allow",
            assurance: "policy",
            decided_at: "2026-10-13T08:00:00.000Z",
            presented_hash: hash,
          },
          approved_payload_hash: hash,
        },
      },
      {
        from: "approved",
        to: "executing",
        actor: { type: "agent", id: "mail-agent" },
        extra: { approved_payload_hash: hash },
      },
      {
        from: "executing",
        to: "executed",
        actor: { type: "agent", id: "mail-agent" },
        extra: {
          approved_payload_hash: hash,
          executed_hash: hash,
          drift_applied: [],
          content_match: true,
          mismatch: false,
          evidence_assurance: "E2",
          external_proofs: [{ type: "email_msgid", commit: proofCommit }],
        },
      },
    ];
    let prev = GENESIS_HASH;
    const receipts: Receipt[] = steps.map((step, index) => {
      const unsigned: UnsignedReceipt = {
        v: RECEIPT_V01,
        id: `rcp_legacy_${index + 1}`,
        app_id: "app_legacy",
        seq: index + 1,
        prev_hash: prev,
        task_id: taskId,
        transition: { from: step.from, to: step.to },
        actor: step.actor,
        body: { ...shared, ...step.extra },
        evidence: [],
        issued_at: `2026-10-13T08:00:0${index}.000Z`,
      };
      const hashValue = receiptHash(unsigned);
      const receipt: Receipt = {
        ...unsigned,
        hash: hashValue,
        sig: { alg: "Ed25519", kid: signer.kid, value: signer.sign(hashValue) },
      };
      prev = hashValue;
      return receipt;
    });
    const report = verifyReceiptChain(receipts, keys, {
      secrets: [
        {
          v: SECRETS_V,
          kind: "task",
          task_id: taskId,
          principal_id: "u_1",
          payload_salt: null,
          intent: "create standup",
          payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
          approved_payload: null,
          executed_payload: null,
          proofs: [{ index: 0, salt: proofSalt.toString("base64url"), value: proofValue }],
        },
      ],
    });
    expect(report.ok, report.failure?.reason).toBe(true);
  });

  it("refuses to open a policy that puts approval on an allow rule", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-"));
    dirs.push(dir);
    expect(() =>
      initLocalDir(dir, {
        policyYaml: `
version: 1
rules:
  - id: r
    match: { action: email.send }
    effect: allow
    approval: { step_up: webauthn }
`,
      }),
    ).toThrowError(expect.objectContaining({ code: "policy_invalid", status: 422 }));
  });

  it("declares a process coverage overlay without publishing a new policy", () => {
    const { dir, engine } = setup();
    const before = engine.policyInfo();
    const policyFile = path.join(dir, "policy.yaml");
    const policyHash = sha256Hex(fs.readFileSync(policyFile, "utf8"));
    const declared = engine.setCoverageOverlay([{ action: "email.send", mode: "enforced", via: "mcp-proxy" }]);
    expect(declared?.task_id).toBeNull();
    expect(declared?.transition).toBeNull();
    expect(declared?.body.kind).toBe("coverage.declared");
    expect(declared?.body.entries).toEqual([{ action: "email.send", mode: "enforced", via: "mcp-proxy" }]);
    expect(engine.setCoverageOverlay([{ action: "email.send", mode: "enforced", via: "mcp-proxy" }])).toBeNull();

    const created = requestEmail(engine);
    expect(created.task.integrationMode).toBe("enforced");
    expect(created.task.coverageVia).toBe("mcp-proxy");
    expect(created.receipts[0]?.body.integration).toMatchObject({ mode: "enforced", via: "mcp-proxy" });
    expect(engine.policyInfo().version).toBe(before.version);
    expect(sha256Hex(fs.readFileSync(policyFile, "utf8"))).toBe(policyHash);
    const published = engine.exportReceipts().filter((receipt) => receipt.body.kind === "policy.published");
    expect(published).toHaveLength(1);

    const cleared = engine.setCoverageOverlay([]);
    expect(cleared?.body.kind).toBe("coverage.declared");
    expect(cleared?.body.entries).toEqual([]);
    const afterClear = requestEmail(engine, "k-cleared");
    expect(afterClear.task.integrationMode).toBe("recorded");
    expect(afterClear.task.coverageVia).toBe("cli-demo");
    engine.close();

    const other = openLedger({ dir });
    expect(other.policyInfo().version).toBe(before.version);
    expect(other.exportReceipts().filter((receipt) => receipt.body.kind === "policy.published")).toHaveLength(1);
    const plain = requestEmail(other, "k-other");
    expect(plain.task.integrationMode).toBe("recorded");
    expect(plain.task.coverageVia).toBe("cli-demo");
    const report = verifyReceiptChain(other.exportReceipts(), other.publicKeys(), { secrets: other.exportSecrets() });
    expect(report.ok, report.failure?.reason).toBe(true);
    other.close();
  });

  it("rejects a coverage overlay entry without via", () => {
    const { engine } = setup();
    expect(() => engine.setCoverageOverlay([{ action: "email.send", mode: "enforced" }])).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
  });
});

const cliOnlyPolicy = `
version: 1
defaults:
  unknown_action: require_approval
  approval: { channels: [cli], timeout: 15m, min_assurance: app_asserted }
actions:
  email.send: { level: write }
`;

const omittedChannelsPolicy = `
version: 1
defaults:
  unknown_action: require_approval
  approval:
    timeout: 15m
    min_assurance: app_asserted
actions:
  email.send: { level: write }
`;

const webPolicy = `
version: 1
defaults:
  unknown_action: require_approval
  approval: { channels: [cli, web], timeout: 15m, min_assurance: app_asserted }
actions:
  email.send: { level: write }
`;

const webOnlyRulePolicy = `
version: 1
defaults:
  unknown_action: require_approval
  approval:
    channels: [cli]
    timeout: 15m
    min_assurance: app_asserted
actions:
  email.send: { level: write }
rules:
  - id: web-only
    match: { action: email.send }
    effect: require_approval
    approval:
      channels: [web]
`;

describe("approval channels", () => {
  it("rejects web when the task only allows cli, then accepts cli", () => {
    const { engine } = setup(cliOnlyPolicy);
    try {
      const created = requestEmail(engine, "channels-cli");
      const before = engine.exportReceipts().length;
      expect(() =>
        engine.approve(created.task.id, {
          approverPrincipalId: "u_1",
          channel: "web",
          assurance: "app_asserted",
          presentedHash: created.task.payloadHash,
        }),
      ).toThrowError(expect.objectContaining({ code: "channel_not_allowed", status: 403 }));
      expect(engine.exportReceipts().length).toBe(before);
      expect(engine.getTask(created.task.id)?.state).toBe("pending_approval");
      expect(
        engine.approve(created.task.id, {
          approverPrincipalId: "u_1",
          channel: "cli",
          assurance: "app_asserted",
          presentedHash: created.task.payloadHash,
        }).task.state,
      ).toBe("approved");
    } finally {
      engine.close();
    }
  });

  it("treats an omitted channel list as cli only", () => {
    const { engine } = setup(omittedChannelsPolicy);
    try {
      const created = requestEmail(engine, "channels-omit");
      expect(created.task.decision.channels).toEqual([]);
      expect(() =>
        engine.approve(created.task.id, {
          approverPrincipalId: "u_1",
          channel: "web",
          assurance: "app_asserted",
          presentedHash: created.task.payloadHash,
        }),
      ).toThrowError(expect.objectContaining({ code: "channel_not_allowed", status: 403 }));
      expect(
        engine.approve(created.task.id, {
          approverPrincipalId: "u_1",
          assurance: "app_asserted",
          presentedHash: created.task.payloadHash,
        }).task.state,
      ).toBe("approved");
    } finally {
      engine.close();
    }
  });

  it("records a web approval as app_asserted", () => {
    const { engine } = setup(webPolicy);
    try {
      const created = requestEmail(engine, "channels-web");
      const approved = engine.approve(created.task.id, {
        approverPrincipalId: "u_1",
        channel: "web",
        assurance: "app_asserted",
        presentedHash: created.task.payloadHash,
        simulated: false,
      });
      const approval = approved.receipt.body.approval as {
        channel?: string;
        assurance?: string;
        auth?: { method?: string; simulated?: boolean };
      };
      expect(approval.channel).toBe("web");
      expect(approval.auth?.method).toBe("web");
      expect(approval.assurance).toBe("app_asserted");
      expect(approval.auth?.simulated).toBe(false);
    } finally {
      engine.close();
    }
  });

  it("lets a rule replace the default channel list", () => {
    const { engine } = setup(webOnlyRulePolicy);
    try {
      const created = requestEmail(engine, "channels-rule");
      expect(created.task.decision.channels).toEqual(["web"]);
      expect(() =>
        engine.approve(created.task.id, {
          approverPrincipalId: "u_1",
          channel: "cli",
          assurance: "app_asserted",
          presentedHash: created.task.payloadHash,
        }),
      ).toThrowError(expect.objectContaining({ code: "channel_not_allowed", status: 403 }));
      expect(
        engine.approve(created.task.id, {
          approverPrincipalId: "u_1",
          channel: "web",
          assurance: "app_asserted",
          presentedHash: created.task.payloadHash,
        }).task.state,
      ).toBe("approved");
    } finally {
      engine.close();
    }
  });

  it("rejects a web rejection when the task only allows cli", () => {
    const { engine } = setup(cliOnlyPolicy);
    try {
      const created = requestEmail(engine, "channels-reject");
      const before = engine.exportReceipts().length;
      expect(() =>
        engine.reject(created.task.id, {
          approverPrincipalId: "u_1",
          channel: "web",
          assurance: "app_asserted",
          presentedHash: created.task.payloadHash,
        }),
      ).toThrowError(expect.objectContaining({ code: "channel_not_allowed", status: 403 }));
      expect(engine.exportReceipts().length).toBe(before);
      expect(engine.getTask(created.task.id)?.state).toBe("pending_approval");
    } finally {
      engine.close();
    }
  });

  it("maps an empty or missing channel list to cli", () => {
    expect(effectiveChannels({ channels: [] })).toEqual(["cli"]);
    expect(effectiveChannels({} as never)).toEqual(["cli"]);
  });
});

describe("task receipts", () => {
  it("returns one task's receipts in chain order and does not write", () => {
    const { engine } = setup();
    try {
      const approved = requestEmail(engine, "receipts-a");
      const pending = requestEmail(engine, "receipts-b");
      approveSend(engine, approved.task.id, approved.task.payloadHash);
      const head = engine.chainHead();
      const count = engine.exportReceipts().length;
      const listed = engine.listTaskReceipts(approved.task.id);
      expect(listed).toEqual(engine.exportReceipts().filter((receipt) => receipt.task_id === approved.task.id));
      expect(listed.map((receipt) => receipt.seq)).toEqual([...listed.map((receipt) => receipt.seq)].sort((a, b) => a - b));
      expect(listed.map((receipt) => receipt.transition?.to)).toEqual(["prepared", "pending_approval", "approved"]);
      expect(engine.listTaskReceipts("tsk_missing")).toEqual([]);
      expect(engine.chainHead()).toEqual(head);
      expect(engine.exportReceipts().length).toBe(count);
      expect(engine.getTask(pending.task.id)?.state).toBe("pending_approval");
    } finally {
      engine.close();
    }
  });
});
