import { afterEach, describe, expect, it } from "vitest";
import { verifyJsonl, type KeySet, type Receipt } from "@actledger/core";
import { Ledger, LedgerUnavailable, createToolGate, type Ledger as LedgerType } from "@actledger/sdk";
import { CredentialStore } from "../src/store.js";
import { serverDbPath } from "../src/data.js";
import type { ServerHandle } from "../src/server.js";
import { totpCode } from "../src/totp.js";
import {
  addUser,
  agentKey,
  approveViaConsole,
  auditKey,
  boot,
  cleanup,
  login,
  rejectViaConsole,
  request,
  tempData,
} from "./helpers.js";

let ledger: LedgerType | undefined;

afterEach(async () => {
  await ledger?.close();
  ledger = undefined;
  await cleanup();
});

function openRemote(origin: string, apiKey: string): LedgerType {
  ledger = new Ledger({ mode: "remote", url: origin, apiKey });
  return ledger;
}

function emailGate(origin: string, apiKey: string, mode: "wait" | "defer") {
  return createToolGate({
    ledger: openRemote(origin, apiKey),
    mode,
    principal: "u_1",
    agentId: "remote-agent",
    pollMs: 50,
    timeoutMs: 15_000,
    map: (_name, input) => ({
      action: { type: "email.send" },
      payload: { action: "email.send", args: input },
    }),
  });
}

async function session(port: number, password: string, secret: string): Promise<string> {
  const logged = await login(port, "alice", password, totpCode(secret, new Date()));
  if (!logged.cookie) throw new Error(`login ${logged.status}`);
  return logged.cookie;
}

async function waitPending(port: number, cookie: string): Promise<string> {
  const started = Date.now();
  for (;;) {
    const res = await request(port, "GET", "/api/tasks?state=pending", { headers: { cookie } });
    const body = JSON.parse(res.body) as { tasks?: Array<{ id: string }> };
    const id = body.tasks?.[0]?.id;
    if (id) return id;
    if (Date.now() - started > 5_000) throw new Error(`no pending task: ${res.status} ${res.body}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function bootRemote(): Promise<{ handle: ServerHandle; password: string; secret: string; key: string; audit: string; data: string }> {
  const data = tempData();
  const user = await addUser(data, "alice", "u_1");
  const key = agentKey(data, "remote-agent", ["u_1"]);
  const audit = auditKey(data);
  const { handle } = await boot(data, { now: () => new Date() });
  return { handle, password: user.password, secret: user.secret, key, audit, data };
}

describe("remote ledger against the server", () => {
  it("waits, approves in the console, completes, and verifies the export", async () => {
    const { handle, password, secret, key, audit } = await bootRemote();
    const cookie = await session(handle.port, password, secret);
    const gate = emailGate(handle.origin, key, "wait");
    const pending = gate.before("email.send", { to: "bob@example.com" });
    const id = await waitPending(handle.port, cookie);
    await approveViaConsole(handle.port, cookie, id);
    const decision = await pending;
    expect(decision.kind).toBe("allow");
    if (decision.kind !== "allow" || !decision.run) throw new Error("expected an approved run");
    expect(decision.approvedPayload).toMatchObject({ action: "email.send", args: { to: "bob@example.com" } });
    const receipt = await gate.after(decision.run, { result: { sent: true } });
    expect(receipt?.hash).toMatch(/^sha256:/);

    const keysRes = await request(handle.port, "GET", "/v1/keys");
    expect(keysRes.status).toBe(200);
    const exported = await request(handle.port, "GET", "/v1/export", {
      headers: { authorization: `Bearer ${audit}` },
    });
    expect(exported.status).toBe(200);
    const report = verifyJsonl(exported.body, JSON.parse(keysRes.body) as KeySet);
    expect(report.ok).toBe(true);
    const approved = exported.body
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Receipt)
      .find((item) => item.transition?.to === "approved");
    expect((approved?.body.approval as { channel?: string } | undefined)?.channel).toBe("web");
  });

  it("defers, shows the console hint, and resumes a rejection", async () => {
    const { handle, password, secret, key } = await bootRemote();
    const cookie = await session(handle.port, password, secret);
    const gate = emailGate(handle.origin, key, "defer");
    const decision = await gate.before("email.send", { to: "bob@example.com" });
    expect(decision.kind).toBe("pending");
    if (decision.kind !== "pending") throw new Error("expected pending");
    expect(decision.approveHint).toContain(`${handle.origin}/tasks/${decision.taskId}`);
    await rejectViaConsole(handle.port, cookie, decision.taskId, "not this week");
    const resumed = await gate.resume(decision.taskId);
    expect(resumed.kind).toBe("deny");
    if (resumed.kind !== "deny") throw new Error("expected deny");
    expect(resumed.reason).toBe("rejected");
  });

  it("runs a guarded function after console approval", async () => {
    const { handle, password, secret, key } = await bootRemote();
    const cookie = await session(handle.port, password, secret);
    const current = openRemote(handle.origin, key);
    const send = current.guard(
      {
        action: "email.send",
        agentId: "remote-agent",
        principal: () => "u_1",
        payload: () => ({ action: "email.send", args: { to: "bob@example.com" } }),
        timeoutMs: 15_000,
      },
      async () => "sent",
    );
    const running = send(undefined as never);
    const id = await waitPending(handle.port, cookie);
    await approveViaConsole(handle.port, cookie, id);
    await expect(running).resolves.toBe("sent");
  });

  it("enforces principal, agent, and key revocation", async () => {
    const { handle, key, data } = await bootRemote();
    const current = openRemote(handle.origin, key);
    await expect(
      current.request({
        principalId: "u_2",
        action: { type: "email.send" },
        payload: { action: "email.send", args: { to: "bob@example.com" } },
      }),
    ).rejects.toMatchObject({ code: "principal_not_allowed", status: 403 });
    await expect(
      current.request({
        principalId: "u_1",
        agentId: "other-agent",
        action: { type: "email.send" },
        payload: { action: "email.send", args: { to: "bob@example.com" } },
      }),
    ).rejects.toMatchObject({ code: "agent_mismatch", status: 403 });

    const store = CredentialStore.open(serverDbPath(data));
    try {
      const row = store.listKeys("agent").find((item) => item.agentId === "remote-agent" && !item.revokedAt);
      if (!row) throw new Error("missing agent key");
      store.revokeKey(row.id, "agent");
    } finally {
      store.close();
    }
    await expect(
      current.request({
        principalId: "u_1",
        action: { type: "email.read" },
        payload: { action: "email.read", args: {} },
      }),
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("reports the server as unavailable after it closes", async () => {
    const { handle, key } = await bootRemote();
    const current = openRemote(handle.origin, key);
    await handle.close();
    await expect(current.getTask("tsk_missing")).rejects.toBeInstanceOf(LedgerUnavailable);
  });
});
