import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LedgerError, initLocalDir, openLedger } from "@actledger/core";
import {
  ApprovalExpired,
  ApprovalRejected,
  ContentMismatch,
  Ledger,
  createToolGate,
  defaultToolMapping,
  type ToolGateDecision,
  type Transport,
} from "../src/index";

const dirs: string[] = [];

function localDir(policy?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-gate-"));
  dirs.push(dir);
  initLocalDir(dir, policy ? { policyYaml: policy } : undefined);
  return dir;
}

const gatePolicy = `
version: 1
defaults:
  unknown_action: require_approval
  content_mode: strict
  approval:
    channels: [cli]
    timeout: 15m
    allow_edit: true
    min_assurance: app_asserted
actions:
  tool.search: { level: read }
  tool.send_email: { level: send }
  tool.drop_table: { level: delete }
  tool.draft_post: { level: draft }
rules:
  - id: search-allow
    match: { action: tool.search }
    effect: allow
  - id: drop-deny
    match: { action: tool.drop_table }
    effect: deny
  - id: draft-only
    match: { action: tool.draft_post }
    effect: draft_only
  - id: send-approve
    match: { action: tool.send_email }
    effect: require_approval
`;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function downTransport(): Transport {
  const fail = () => {
    throw new LedgerError("ledger_unavailable", "down", 503);
  };
  return {
    request: fail,
    getTask: fail,
    claim: fail,
    complete: fail,
    fail,
    revoke: fail,
    close() {},
  };
}

async function findPending(dir: string, now?: () => Date) {
  const start = Date.now();
  while (Date.now() - start < 8_000) {
    const engine = openLedger({ dir, now });
    try {
      const task = engine.listTasks({ state: "pending_approval" })[0];
      if (task) return task;
    } finally {
      engine.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no pending task");
}

function approve(
  dir: string,
  task: { id: string; payloadHash: string; principalId: string },
  now?: () => Date,
) {
  const engine = openLedger({ dir, now });
  try {
    engine.approve(task.id, {
      approverPrincipalId: task.principalId,
      assurance: "channel_verified",
      presentedHash: task.payloadHash,
      channel: "cli",
      simulated: true,
    });
  } finally {
    engine.close();
  }
}

function reject(
  dir: string,
  task: { id: string; payloadHash: string; principalId: string },
  now?: () => Date,
) {
  const engine = openLedger({ dir, now });
  try {
    engine.reject(task.id, {
      approverPrincipalId: task.principalId,
      assurance: "app_asserted",
      presentedHash: task.payloadHash,
    });
  } finally {
    engine.close();
  }
}

function asAllow(decision: ToolGateDecision) {
  expect(decision.kind).toBe("allow");
  if (decision.kind !== "allow") throw new Error(`expected allow, got ${decision.kind}`);
  return decision;
}

function asDeny(decision: ToolGateDecision) {
  expect(decision.kind).toBe("deny");
  if (decision.kind !== "deny") throw new Error(`expected deny, got ${decision.kind}`);
  return decision;
}

function asPending(decision: ToolGateDecision) {
  expect(decision.kind).toBe("pending");
  if (decision.kind !== "pending") throw new Error(`expected pending, got ${decision.kind}`);
  return decision;
}

describe("createToolGate", () => {
  it("default map uses tool.<name> and { action, args }", async () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "wait" });
      const decision = asAllow(await gate.before("search", { q: "x" }));
      expect(decision.approvedPayload).toEqual({ action: "tool.search", args: { q: "x" } });
      const stored = await ledger.getTask(decision.taskId ?? "");
      expect(stored?.data.action.type).toBe("tool.search");
      expect(defaultToolMapping("search", "raw").payload?.args).toEqual({ input: "raw" });
    } finally {
      ledger.close();
    }
  });

  it("wait mode allows when policy auto-approves, after() completes", async () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "wait" });
      const decision = asAllow(await gate.before("search", { q: "x" }));
      const receipt = await gate.after(decision.run, { result: { hits: 1 } });
      expect(receipt?.hash.startsWith("sha256:")).toBe(true);
      const stored = await ledger.getTask(decision.taskId ?? "");
      expect(stored?.state).toBe("executed");
    } finally {
      ledger.close();
    }
  });

  it("wait mode allows after another connection approves", async () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({
        ledger,
        principal: "u_1",
        mode: "wait",
        timeoutMs: 15_000,
        pollMs: 20,
      });
      const pending = gate.before("send_email", { to: "a@b.c" });
      const task = await findPending(dir);
      approve(dir, task);
      const decision = asAllow(await pending);
      await gate.after(decision.run, { result: { sent: true } });
      const stored = await ledger.getTask(decision.taskId ?? "");
      expect(stored?.state).toBe("executed");
    } finally {
      ledger.close();
    }
  });

  it("wait mode denies on policy deny", async () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "wait" });
      const decision = asDeny(await gate.before("drop_table", {}));
      expect(decision.reason).toBe("policy_denied");
      expect(decision.state).toBe("rejected");
      expect(decision.cause).toBeInstanceOf(ApprovalRejected);
    } finally {
      ledger.close();
    }
  });

  it("wait mode denies on human reject", async () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({
        ledger,
        principal: "u_1",
        mode: "wait",
        timeoutMs: 15_000,
        pollMs: 20,
      });
      const pending = gate.before("send_email", { to: "a@b.c" });
      const task = await findPending(dir);
      reject(dir, task);
      const decision = asDeny(await pending);
      expect(decision.reason).toBe("rejected");
    } finally {
      ledger.close();
    }
  });

  it("wait mode denies on draft_only", async () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "wait" });
      const decision = asDeny(await gate.before("draft_post", {}));
      expect(decision.reason).toBe("drafted");
      expect(decision.cause).toBeInstanceOf(LedgerError);
      expect((decision.cause as LedgerError).code).toBe("invalid_transition");
    } finally {
      ledger.close();
    }
  });

  it("wait mode timeout returns deny(timeout) and leaves task pending", async () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({
        ledger,
        principal: "u_1",
        mode: "wait",
        timeoutMs: 50,
        pollMs: 10,
      });
      const decision = asDeny(await gate.before("send_email", { to: "a@b.c" }));
      expect(decision.reason).toBe("timeout");
      expect(decision.state).toBe("pending_approval");
      expect(decision.cause).toBeInstanceOf(ApprovalExpired);
      const stored = await ledger.getTask(decision.taskId);
      expect(stored?.state).toBe("pending_approval");
    } finally {
      ledger.close();
    }
  });

  it("defer mode returns pending immediately, resume allows after approval", async () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
      const pending = asPending(await gate.before("send_email", { to: "a@b.c" }));
      expect(pending.approveHint).toContain(pending.taskId);
      expect(pending.approveHint).toContain(`actledger approve ${pending.taskId}`);
      expect(pending.approveHint).toContain("--dir");
      expect(pending.approveHint).toContain(ledger.dir ?? "");
      expect((await gate.resume(pending.taskId)).kind).toBe("pending");
      const stored = await ledger.getTask(pending.taskId);
      if (!stored) throw new Error("missing task");
      approve(dir, stored.data);
      const allowed = asAllow(await gate.resume(pending.taskId));
      await gate.after(allowed.run, { result: { sent: true } });
      expect((await ledger.getTask(pending.taskId))?.state).toBe("executed");
      await expect(gate.resume(pending.taskId)).rejects.toMatchObject({ code: "invalid_transition" });
    } finally {
      ledger.close();
    }
  });

  it("defer mode resume denies on reject / revoke / expire", async () => {
    const dir = localDir(gatePolicy);
    let now = Date.now();
    const ledger = new Ledger({ mode: "local", dir, now: () => new Date(now) });
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
      const rejected = asPending(await gate.before("send_email", { to: "a@b.c" }));
      const rejectedTask = await ledger.getTask(rejected.taskId);
      if (!rejectedTask) throw new Error("missing task");
      reject(dir, rejectedTask.data, () => new Date(now));
      const denied = asDeny(await gate.resume(rejected.taskId));
      expect(denied.reason).toBe("rejected");

      const revoked = asPending(await gate.before("send_email", { to: "b@b.c" }));
      await ledger.revoke(revoked.taskId);
      expect(asDeny(await gate.resume(revoked.taskId)).reason).toBe("revoked");

      const expiring = createToolGate({
        ledger,
        principal: "u_1",
        mode: "defer",
        map: () => ({
          action: "tool.send_email",
          expiresIn: 1,
          payload: { action: "tool.send_email", args: {} },
        }),
      });
      const pending = asPending(await expiring.before("send_email", {}));
      now += 2_000;
      const expired = asDeny(await expiring.resume(pending.taskId));
      expect(expired.reason).toBe("expired");
    } finally {
      ledger.close();
    }
  });

  it("defer mode allow path for auto-approved tool", async () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
      expect((await gate.before("search", { q: "x" })).kind).toBe("allow");
    } finally {
      ledger.close();
    }
  });

  it("after() error path fails the task", async () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "wait" });
      const first = asAllow(await gate.before("search", { q: "a" }));
      await expect(gate.after(first.run, { error: new Error("boom") })).resolves.toBeNull();
      const failed = await ledger.getTask(first.taskId ?? "");
      expect(failed?.state).toBe("failed");
      expect(failed?.data.error?.code).toBe("tool_error");

      const second = asAllow(await gate.before("search", { q: "b" }));
      await gate.after(second.run, { error: new Error("slow"), code: "rate_limited", retryable: true });
      const limited = await ledger.getTask(second.taskId ?? "");
      expect(limited?.data.error).toMatchObject({ code: "rate_limited", retryable: true });
    } finally {
      ledger.close();
    }
  });

  it("after() strict mismatch throws ContentMismatch", async () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "wait" });
      const decision = asAllow(await gate.before("search", { q: "x" }));
      await expect(
        gate.after(decision.run, {
          result: 1,
          executedPayload: { action: "tool.search", args: { q: "other" } },
        }),
      ).rejects.toBeInstanceOf(ContentMismatch);
      const failed = await ledger.getTask(decision.taskId ?? "");
      expect(failed?.state).toBe("failed");
      expect(failed?.data.error?.code).toBe("content_mismatch");
    } finally {
      ledger.close();
    }
  });

  it("principal accepts a string or a callback; custom map overrides action", async () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const byString = createToolGate({ ledger, principal: "u_fixed", mode: "wait" });
      const fixed = asAllow(await byString.before("search", { q: "x" }));
      expect((await ledger.getTask(fixed.taskId ?? ""))?.data.principalId).toBe("u_fixed");

      const gate = createToolGate({
        ledger,
        mode: "defer",
        principal: (name) => `u_${name}`,
        map: () => ({ action: "calendar.create", payload: { action: "x", args: {} } }),
      });
      const pending = asPending(await gate.before("search", {}));
      const created = await ledger.getTask(pending.taskId);
      expect(created?.data.principalId).toBe("u_search");
      expect(created?.data.action.type).toBe("calendar.create");
      if (!created) throw new Error("missing task");
      approve(dir, created.data);
      const allowed = asAllow(await gate.resume(pending.taskId));
      expect(allowed.approvedPayload.action).toBe("calendar.create");
    } finally {
      ledger.close();
    }
  });

  it("resume on unknown id throws not_found", async () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
      await expect(gate.resume("tsk_nope")).rejects.toMatchObject({ code: "not_found", status: 404 });
    } finally {
      ledger.close();
    }
  });

  it("degraded read-only allow", async () => {
    const ledger = new Ledger({ transport: downTransport(), onUnavailable: "allow_read_only" });
    try {
      const gate = createToolGate({
        ledger,
        principal: "u_1",
        mode: "wait",
        map: () => ({ action: "email.read", readOnly: true }),
      });
      const decision = asAllow(await gate.before("read", {}));
      expect(decision.degraded).toBe(true);
      expect(decision.run).toBeNull();
      await expect(gate.after(null, { result: 1 })).resolves.toBeNull();
    } finally {
      ledger.close();
    }
  });

  it("Ledger.dir is the resolved local directory and null for a transport", () => {
    const dir = localDir();
    const ledger = new Ledger({ mode: "local", dir });
    expect(ledger.dir).toBe(path.resolve(dir));
    ledger.close();
    const remote = new Ledger({ transport: downTransport() });
    expect(remote.dir).toBeNull();
    remote.close();
  });

  it("guard throws ApprovalRejected on policy deny and LedgerError on draft_only", async () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      let called = false;
      const deny = ledger.guard(
        {
          action: "tool.drop_table",
          principal: () => "u_1",
          payload: () => ({ action: "tool.drop_table", args: {} }),
        },
        async () => {
          called = true;
          return "ran";
        },
      );
      await expect(deny({})).rejects.toBeInstanceOf(ApprovalRejected);
      expect(called).toBe(false);

      const draft = ledger.guard(
        {
          action: "tool.draft_post",
          principal: () => "u_1",
          payload: () => ({ action: "tool.draft_post", args: {} }),
        },
        async () => {
          called = true;
          return "ran";
        },
      );
      await expect(draft({})).rejects.toMatchObject({ code: "invalid_transition" });
      expect(called).toBe(false);
    } finally {
      ledger.close();
    }
  });
});
