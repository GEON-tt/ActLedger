import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { initLocalDir, LedgerError, openLedger } from "@actledger/core";
import {
  ApprovalExpired,
  ApprovalRejected,
  ContentMismatch,
  Ledger,
  LedgerUnavailable,
  verifyWebhook,
  type Transport,
} from "../src/index";

const dirs: string[] = [];

function localDir(policy?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-sdk-"));
  dirs.push(dir);
  initLocalDir(dir, policy ? { policyYaml: policy } : undefined);
  return dir;
}

const warnAllow = `
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
`;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("sdk", () => {
  it("runs a guarded allow-path to completion", async () => {
    const dir = localDir();
    const ledger = new Ledger({ mode: "local", dir });
    const guarded = ledger.guard(
      {
        action: "calendar.create",
        principal: () => "u_1",
        payload: () => ({ action: "calendar.create", args: { title: "standup" } }),
        intent: () => "create standup",
      },
      async (_args, ctx) => {
        expect(ctx.approvedPayload.args.title).toBe("standup");
        return "created";
      },
    );
    await expect(guarded(undefined)).resolves.toBe("created");
    ledger.close();
  });

  it("waits until another connection approves", async () => {
    const dir = localDir();
    let now = Date.now();
    const ledger = new Ledger({ mode: "local", dir, now: () => new Date(now) });
    const task = await ledger.request({
      principalId: "u_1",
      action: { type: "email.send", attrs: { recipient_domain: "clienta.com" } },
      payload: {
        action: "email.send",
        args: { to: ["bob@clienta.com"], subject: "hi" },
        content: { content_type: "text/plain", text: "hi" },
      },
      idempotencyKey: "reply-1",
    });
    const waiting = task.wait({ timeoutMs: 5_000, pollMs: 20 });
    const { openLedger } = await import("@actledger/core");
    const engine = openLedger({ dir, now: () => new Date(now) });
    engine.approve(task.id, {
      approverPrincipalId: "u_1",
      assurance: "channel_verified",
      presentedHash: task.data.payloadHash,
      channel: "cli",
      simulated: true,
    });
    engine.close();
    const done = await waiting;
    expect(done.state).toBe("approved");
    const run = await done.claim();
    const receipt = await run.complete({ executedPayload: run.approvedPayload });
    expect(receipt.hash.startsWith("sha256:")).toBe(true);
    ledger.close();
  });

  it("expires a pending task while waiting", async () => {
    const dir = localDir();
    let now = Date.now();
    const ledger = new Ledger({ mode: "local", dir, now: () => new Date(now) });
    const task = await ledger.request({
      principalId: "u_1",
      action: { type: "email.send" },
      payload: { action: "email.send", args: { to: ["a@b.c"] } },
      expiresIn: 1,
    });
    now += 2_000;
    await expect(task.wait({ timeoutMs: 1_000, pollMs: 10 })).rejects.toBeInstanceOf(ApprovalExpired);
    ledger.close();
  });

  it("rejects locally when strict content does not match", async () => {
    const dir = localDir();
    const ledger = new Ledger({ mode: "local", dir, strictContent: true });
    const created = await ledger.request({
      principalId: "u_1",
      action: { type: "calendar.create" },
      payload: { action: "calendar.create", args: { title: "a" } },
    });
    const done = await created.wait({ timeoutMs: 1000, pollMs: 10 });
    const run = await done.claim();
    await expect(
      run.complete({ executedPayload: { action: "calendar.create", args: { title: "b" } } }),
    ).rejects.toBeInstanceOf(ContentMismatch);
    const after = await ledger.getTask(created.id);
    expect(after?.state).toBe("failed");
    ledger.close();
  });

  it("fails closed when the ledger is unavailable", async () => {
    const down: Transport = {
      request() {
        throw new LedgerError("ledger_unavailable", "down", 503);
      },
      getTask() {
        throw new LedgerError("ledger_unavailable", "down", 503);
      },
      claim() {
        throw new LedgerError("ledger_unavailable", "down", 503);
      },
      complete() {
        throw new LedgerError("ledger_unavailable", "down", 503);
      },
      fail() {
        throw new LedgerError("ledger_unavailable", "down", 503);
      },
      revoke() {
        throw new LedgerError("ledger_unavailable", "down", 503);
      },
      close() {},
    };
    const ledger = new Ledger({ transport: down });
    await expect(
      ledger.request({
        principalId: "u_1",
        action: { type: "email.send" },
        payload: { action: "email.send", args: {} },
      }),
    ).rejects.toBeInstanceOf(LedgerUnavailable);

    const reading = new Ledger({ transport: down, onUnavailable: "allow_read_only" });
    await expect(reading.getTask("tsk_x")).resolves.toBeNull();
    const degraded = await reading.request({
      principalId: "u_1",
      action: { type: "email.read" },
      payload: { action: "email.read", args: {} },
      readOnly: true,
    });
    expect(degraded.degraded).toBe(true);
    await expect(
      reading.request({
        principalId: "u_1",
        action: { type: "email.send" },
        payload: { action: "email.send", args: {} },
      }),
    ).rejects.toBeInstanceOf(LedgerUnavailable);
  });

  it("rejects a user rejection raised from wait", async () => {
    const dir = localDir();
    const ledger = new Ledger({ mode: "local", dir });
    const task = await ledger.request({
      principalId: "u_1",
      action: { type: "email.send" },
      payload: { action: "email.send", args: { to: ["a@b.c"] } },
    });
    const { openLedger } = await import("@actledger/core");
    const engine = openLedger({ dir });
    engine.reject(task.id, {
      approverPrincipalId: "u_1",
      assurance: "app_asserted",
      presentedHash: task.data.payloadHash,
    });
    engine.close();
    await expect(task.wait({ timeoutMs: 1000, pollMs: 10 })).rejects.toBeInstanceOf(ApprovalRejected);
    ledger.close();
  });

  it("refuses a strict guard before calling fn when a warn policy would allow drift", async () => {
    const dir = localDir(warnAllow);
    const ledger = new Ledger({ mode: "local", dir, strictContent: true });
    let called = false;
    const guarded = ledger.guard(
      {
        action: "email.send",
        principal: () => "u_1",
        payload: () => ({
          action: "email.send",
          args: { to: ["a@b.c"], subject: "hi" },
          content: { content_type: "text/plain", text: "hi" },
        }),
        executedPayload: () => ({
          action: "email.send",
          args: { to: ["other@x.com"], subject: "hi" },
          content: { content_type: "text/plain", text: "hi" },
        }),
      },
      async () => {
        called = true;
        return "sent";
      },
    );
    await expect(guarded(undefined)).rejects.toBeInstanceOf(ContentMismatch);
    expect(called).toBe(false);
    ledger.close();
    const engine = openLedger({ dir });
    const task = engine.listTasks()[0];
    expect(task?.decision.contentMode).toBe("warn");
    expect(task?.state).toBe("failed");
    expect(task?.error?.code).toBe("content_mismatch");
    engine.close();
  });

  it("leaves the task executing when the guarded function throws", async () => {
    const dir = localDir();
    const ledger = new Ledger({ mode: "local", dir });
    let called = false;
    const guarded = ledger.guard(
      {
        action: "calendar.create",
        principal: () => "u_1",
        payload: () => ({ action: "calendar.create", args: { title: "standup" } }),
      },
      async () => {
        called = true;
        throw new Error("side effect failed");
      },
    );
    await expect(guarded(undefined)).rejects.toThrow("side effect failed");
    expect(called).toBe(true);
    ledger.close();
    const engine = openLedger({ dir });
    expect(engine.listTasks()[0]?.state).toBe("executing");
    engine.close();
  });

  it("leaves the task executing when complete throws after the function succeeds", async () => {
    const dir = localDir();
    const engine = openLedger({ dir });
    let failCalls = 0;
    let called = false;
    const ledger = new Ledger({
      strictContent: true,
      transport: {
        request: (input) => engine.request(input),
        getTask: (id) => engine.getTask(id),
        claim: (id, opts) => engine.claim(id, opts),
        complete: () => {
          throw new Error("complete failed");
        },
        fail: (id, input) => {
          failCalls += 1;
          return engine.fail(id, input);
        },
        revoke: (id, input) => {
          const task = engine.getTask(id);
          return engine.revoke(id, {
            actor: { type: "agent", id: task?.agentId ?? "local-agent" },
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
          });
        },
        sweep: () => engine.sweep(),
        close: () => engine.close(),
      },
    });
    const guarded = ledger.guard(
      {
        action: "calendar.create",
        principal: () => "u_1",
        payload: () => ({ action: "calendar.create", args: { title: "standup" } }),
      },
      async () => {
        called = true;
        return "created";
      },
    );
    await expect(guarded(undefined)).rejects.toThrow("complete failed");
    expect(called).toBe(true);
    expect(failCalls).toBe(0);
    expect(engine.listTasks()[0]?.state).toBe("executing");
    ledger.close();
  });
});

describe("verifyWebhook", () => {
  it("accepts a fresh signature and rejects a stale or forged one", () => {
    const secret = "whsec";
    const body = JSON.stringify({ id: "evt_1", type: "task.approved", created_at: "2026-10-13T00:00:00.000Z", data: {} });
    const timestamp = "1760000000";
    const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    const header = `t=${timestamp},v1=${sig}`;
    const event = verifyWebhook(body, header, secret, 1760000000 * 1000);
    expect(event.type).toBe("task.approved");
    expect(() => verifyWebhook(body, header, secret, (1760000000 + 301) * 1000)).toThrow(LedgerError);
    expect(() => verifyWebhook(body, `t=${timestamp},v1=${"0".repeat(sig.length)}`, secret, 1760000000 * 1000)).toThrow(
      LedgerError,
    );
  });
});
