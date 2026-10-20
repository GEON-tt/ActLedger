import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedger } from "@actledger/core";
import { CredentialStore } from "../src/store.js";
import { ledgerDir, serverDbPath } from "../src/data.js";
import { startServer, type ServerHandle } from "../src/server.js";
import { totpCode } from "../src/totp.js";
import { addUser, agentKey, api, auditKey, boot, cleanup, field, form, login, request, tempData, track } from "./helpers.js";

let data = "";
let password = "";
let secret = "";
let keyA = "";
let keyB = "";
let audit = "";
let port = 0;
let handle: ServerHandle | undefined;
let clock = { now: new Date("2026-01-05T00:00:00.000Z") };

const email = {
  principalId: "u_1",
  action: { type: "email.send" },
  payload: { action: "email.send", args: { to: "bob@example.com" } },
};

beforeEach(async () => {
  data = tempData();
  const user = await addUser(data, "alice", "u_1");
  password = user.password;
  secret = user.secret;
  keyA = agentKey(data, "agent-1", ["u_1"]);
  keyB = agentKey(data, "agent-2", ["u_1"]);
  audit = auditKey(data);
  const booted = await boot(data);
  handle = booted.handle;
  port = booted.handle.port;
  clock = booted.clock;
});

afterEach(async () => {
  await cleanup();
});

async function approve(id: string): Promise<void> {
  const logged = await login(port, "alice", password, totpCode(secret, clock.now));
  expect(logged.status).toBe(303);
  const page = await request(port, "GET", `/tasks/${id}`, { headers: { cookie: logged.cookie ?? "" } });
  const decided = await request(port, "POST", `/tasks/${id}/approve`, {
    headers: {
      cookie: logged.cookie ?? "",
      origin: `http://127.0.0.1:${port}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form({ csrf: field(page.body, "csrf"), presented_hash: field(page.body, "presented_hash") }),
  });
  expect(decided.status).toBe(303);
}

describe("agent api", () => {
  it("lets an agent submit and execute, and approves only on the console", async () => {
    const created = await api(port, "POST", "/v1/tasks", keyA, email);
    expect(created.status).toBe(200);
    expect(created.json.task.state).toBe("pending_approval");
    expect(created.json.task.agentId).toBe("agent-1");
    const id = created.json.task.id as string;
    const forbidden = await api(port, "POST", `/v1/tasks/${id}/approve`, keyA, {});
    expect(forbidden.status).toBe(403);
    expect(forbidden.json.code).toBe("forbidden");
    expect((await api(port, "POST", `/v1/tasks/${id}/reject`, keyA, {})).status).toBe(403);
    expect((await api(port, "GET", `/v1/tasks/${id}`, keyA)).json.task.state).toBe("pending_approval");

    await approve(id);
    const claimed = await api(port, "POST", `/v1/tasks/${id}/claim`, keyA, {});
    expect(claimed.status).toBe(200);
    expect(claimed.json.approvedPayload.args.to).toBe("bob@example.com");
    const completed = await api(port, "POST", `/v1/tasks/${id}/complete`, keyA, {
      executedPayload: claimed.json.approvedPayload,
    });
    expect(completed.status).toBe(200);
    expect(completed.json.contentMatch).toBe(true);
    expect((await api(port, "GET", `/v1/tasks/${id}`, keyA)).json.task.state).toBe("executed");

    const engine = openLedger({ dir: ledgerDir(data) });
    try {
      const receipts = engine.exportReceipts().filter((receipt) => receipt.task_id === id);
      for (const to of ["prepared", "executing", "executed"]) {
        expect(receipts.find((receipt) => receipt.transition?.to === to)?.actor).toEqual({ type: "agent", id: "agent-1" });
      }
      const approval = receipts.find((receipt) => receipt.transition?.to === "approved")?.body.approval as {
        channel?: string;
        assurance?: string;
        auth?: { simulated?: boolean };
      };
      expect(approval.channel).toBe("web");
      expect(approval.assurance).toBe("app_asserted");
      expect(approval.auth?.simulated).toBe(false);
    } finally {
      engine.close();
    }
  });

  it("rejects a principal the key cannot act for", async () => {
    const before = openLedger({ dir: ledgerDir(data) });
    const count = before.listTasks().length;
    before.close();
    const denied = await api(port, "POST", "/v1/tasks", keyA, { ...email, principalId: "u_2" });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe("principal_not_allowed");
    const after = openLedger({ dir: ledgerDir(data) });
    expect(after.listTasks().length).toBe(count);
    after.close();
  });

  it("requires the agentId to match the key", async () => {
    const mismatch = await api(port, "POST", "/v1/tasks", keyA, { ...email, agentId: "agent-9" });
    expect(mismatch.status).toBe(403);
    expect(mismatch.json.code).toBe("agent_mismatch");
    const matched = await api(port, "POST", "/v1/tasks", keyA, { ...email, agentId: "agent-1" });
    expect(matched.status).toBe(200);
  });

  it("hides another agent's tasks", async () => {
    const created = await api(port, "POST", "/v1/tasks", keyA, email);
    const id = created.json.task.id as string;
    expect((await api(port, "GET", `/v1/tasks/${id}`, keyB)).status).toBe(404);
    expect((await api(port, "POST", `/v1/tasks/${id}/claim`, keyB, {})).status).toBe(404);
    expect((await api(port, "POST", `/v1/tasks/${id}/revoke`, keyB, {})).status).toBe(404);
  });

  it("rejects missing, malformed, and audit credentials", async () => {
    const missing = await api(port, "POST", "/v1/tasks", null, email);
    expect(missing.status).toBe(401);
    expect(String(missing.headers["www-authenticate"])).toContain("Bearer");
    expect((await api(port, "POST", "/v1/tasks", null, email, { authorization: "Bearer garbage" })).status).toBe(401);
    expect((await api(port, "POST", "/v1/tasks", null, email, { authorization: "Basic xxx" })).status).toBe(401);
    const denied = await api(port, "POST", "/v1/tasks", audit, email);
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe("forbidden");
  });

  it("rejects a key as soon as it is revoked", async () => {
    expect((await api(port, "POST", "/v1/tasks", keyA, email)).status).toBe(200);
    const admin = CredentialStore.open(serverDbPath(data));
    try {
      const row = admin.listKeys("agent").find((item) => item.agentId === "agent-1");
      admin.revokeKey(row?.id ?? "", "agent");
    } finally {
      admin.close();
    }
    expect((await api(port, "POST", "/v1/tasks", keyA, email)).status).toBe(401);
  });

  it("fails and revokes through the agent key", async () => {
    const created = await api(port, "POST", "/v1/tasks", keyA, email);
    const id = created.json.task.id as string;
    await approve(id);
    expect((await api(port, "POST", `/v1/tasks/${id}/claim`, keyA, {})).status).toBe(200);
    const failed = await api(port, "POST", `/v1/tasks/${id}/fail`, keyA, {
      error: { code: "smtp_down", message: "no" },
    });
    expect(failed.status).toBe(200);
    expect(failed.json.task.state).toBe("failed");

    const pending = await api(port, "POST", "/v1/tasks", keyA, email);
    const revoked = await api(port, "POST", `/v1/tasks/${pending.json.task.id}/revoke`, keyA, { reason: "stop" });
    expect(revoked.status).toBe(200);
    expect(revoked.json.task.state).toBe("revoked");
    expect(revoked.json.receipt.actor).toEqual({ type: "agent", id: "agent-1" });
  });

  it("returns the mismatch details when the executed payload differs", async () => {
    const created = await api(port, "POST", "/v1/tasks", keyA, email);
    const id = created.json.task.id as string;
    await approve(id);
    const claimed = await api(port, "POST", `/v1/tasks/${id}/claim`, keyA, {});
    const mismatched = await api(port, "POST", `/v1/tasks/${id}/complete`, keyA, {
      executedPayload: { action: "email.send", args: { to: "other@example.com" } },
    });
    expect(mismatched.status).toBe(422);
    expect(mismatched.json.code).toBe("content_mismatch");
    expect(mismatched.json.details.task.state).toBeTruthy();
    expect(claimed.status).toBe(200);
  });

  it("rejects bad bodies and replays an idempotency key", async () => {
    expect((await api(port, "POST", "/v1/tasks", keyA, email, { "content-type": "text/plain" })).status).toBe(415);
    expect((await api(port, "POST", "/v1/tasks", keyA, "{")).status).toBe(400);
    expect((await api(port, "POST", "/v1/tasks", keyA, "[]")).status).toBe(400);
    expect((await api(port, "POST", "/v1/tasks", keyA, "x".repeat(1024 * 1024 + 1))).status).toBe(413);
    expect((await api(port, "POST", "/v1/tasks", keyA, { ...email, idempotencyKey: "k".repeat(129) })).status).toBe(400);
    const key = "idem-key-1";
    const first = await api(port, "POST", "/v1/tasks", keyA, { ...email, idempotencyKey: key });
    const second = await api(port, "POST", "/v1/tasks", keyA, { ...email, idempotencyKey: key });
    expect(second.status).toBe(200);
    expect(second.json.task.id).toBe(first.json.task.id);
  });

  it("forbids reconcile and audit access to tasks", async () => {
    const created = await api(port, "POST", "/v1/tasks", keyA, email);
    const id = created.json.task.id as string;
    const reconcile = await api(port, "POST", `/v1/tasks/${id}/reconcile`, keyA, {});
    expect(reconcile.status).toBe(403);
    expect(reconcile.json.code).toBe("forbidden");
    const read = await api(port, "GET", `/v1/tasks/${id}`, audit);
    expect(read.status).toBe(403);
    expect(read.json.code).toBe("forbidden");
    const claim = await api(port, "POST", `/v1/tasks/${id}/claim`, audit, {});
    expect(claim.status).toBe(403);
    expect(claim.json.code).toBe("forbidden");
  });

  it("returns 404 when the task id encoding is malformed", async () => {
    const apiRes = await request(port, "GET", "/v1/tasks/%zz");
    expect(apiRes.status).toBe(404);
    expect(JSON.parse(apiRes.body).code).toBe("not_found");
    const page = await request(port, "GET", "/tasks/%zz");
    expect(page.status).toBe(404);
    expect(page.body).toContain("not_found");
  });

  it("routes unknown paths and the health check", async () => {
    expect((await api(port, "GET", "/v1/tasks", keyA)).status).toBe(405);
    expect((await api(port, "GET", "/v1/nope", keyA)).status).toBe(404);
    expect((await api(port, "GET", `/v1/tasks/${encodeURIComponent("bad id")}`, keyA)).status).toBe(404);
    const health = await api(port, "GET", "/healthz", null);
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ ok: true });
  });

  it("expires a task from sweep() and from the timer", async () => {
    const created = await api(port, "POST", "/v1/tasks", keyA, { ...email, expiresIn: 60 });
    const id = created.json.task.id as string;
    clock.now = new Date(clock.now.getTime() + 61_000);
    handle?.sweep();
    expect((await api(port, "GET", `/v1/tasks/${id}`, keyA)).json.task.state).toBe("expired");

    const dir = tempData();
    await addUser(dir, "alice", "u_1");
    const key = agentKey(dir, "agent-1", ["u_1"]);
    const live = await startServer({ data: dir, port: 0, sweepMs: 20 });
    track(live);
    const short = await api(live.port, "POST", "/v1/tasks", key, { ...email, expiresIn: 1 });
    expect(short.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect((await api(live.port, "GET", `/v1/tasks/${short.json.task.id}`, key)).json.task.state).toBe("expired");
  });
});
