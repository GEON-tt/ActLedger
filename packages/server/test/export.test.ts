import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openLedger, verifyJsonl, type KeySet } from "@actledger/core";
import { CredentialStore } from "../src/store.js";
import { ledgerDir, serverDbPath } from "../src/data.js";
import { totpCode } from "../src/totp.js";
import { addUser, agentKey, api, auditKey, boot, cleanup, field, form, login, request, tempData } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const cli = path.join(root, "packages/cli/src/main.ts");

afterEach(async () => {
  await cleanup();
});

async function executed(data: string): Promise<{ port: number; audit: string }> {
  const user = await addUser(data, "alice", "u_1");
  const key = agentKey(data, "agent-1", ["u_1"]);
  const audit = auditKey(data);
  const { handle, clock } = await boot(data);
  const created = await api(handle.port, "POST", "/v1/tasks", key, {
    principalId: "u_1",
    action: { type: "email.send" },
    payload: { action: "email.send", args: { to: "bob@example.com" } },
  });
  const id = created.json.task.id as string;
  const logged = await login(handle.port, "alice", user.password, totpCode(user.secret, clock.now));
  const page = await request(handle.port, "GET", `/tasks/${id}`, { headers: { cookie: logged.cookie ?? "" } });
  await request(handle.port, "POST", `/tasks/${id}/approve`, {
    headers: {
      cookie: logged.cookie ?? "",
      origin: `http://127.0.0.1:${handle.port}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form({ csrf: field(page.body, "csrf"), presented_hash: field(page.body, "presented_hash") }),
  });
  const claimed = await api(handle.port, "POST", `/v1/tasks/${id}/claim`, key, {});
  const completed = await api(handle.port, "POST", `/v1/tasks/${id}/complete`, key, {
    executedPayload: claimed.json.approvedPayload,
  });
  expect(completed.status).toBe(200);
  return { port: handle.port, audit };
}

describe("export", () => {
  it("publishes keys that verify the receipt export", async () => {
    const data = tempData();
    const { port, audit } = await executed(data);
    const keysRes = await api(port, "GET", "/v1/keys", null);
    expect(keysRes.status).toBe(200);
    const exported = await request(port, "GET", "/v1/export", { headers: { authorization: `Bearer ${audit}` } });
    expect(exported.status).toBe(200);
    expect(String(exported.headers["content-type"])).toMatch(/^application\/x-ndjson/);
    const report = verifyJsonl(exported.body, keysRes.json as KeySet);
    expect(report.ok).toBe(true);
    const engine = openLedger({ dir: ledgerDir(data) });
    try {
      expect(report.stats.count).toBe(engine.exportReceipts().length);
    } finally {
      engine.close();
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-verify-"));
    const receipts = path.join(dir, "receipts.jsonl");
    const keys = path.join(dir, "keys.json");
    fs.writeFileSync(receipts, exported.body);
    fs.writeFileSync(keys, `${JSON.stringify(keysRes.json, null, 2)}\n`);
    const verified = spawnSync(process.execPath, [tsx, cli, "verify", receipts, "--keys", keys], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
    });
    expect(verified.status).toBe(0);
    expect(verified.stdout.startsWith("OK ")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lets an approver session export the same chain", async () => {
    const data = tempData();
    const user = await addUser(data, "alice", "u_1");
    const audit = auditKey(data);
    const { handle, clock } = await boot(data);
    const withKey = await request(handle.port, "GET", "/v1/export", { headers: { authorization: `Bearer ${audit}` } });
    const logged = await login(handle.port, "alice", user.password, totpCode(user.secret, clock.now));
    const withCookie = await request(handle.port, "GET", "/v1/export", { headers: { cookie: logged.cookie ?? "" } });
    expect(withCookie.status).toBe(200);
    expect(withCookie.body).toBe(withKey.body);
  });

  it("rejects the wrong caller and a bad range", async () => {
    const data = tempData();
    const key = agentKey(data, "agent-1", ["u_1"]);
    const audit = auditKey(data);
    const { handle } = await boot(data);
    await api(handle.port, "POST", "/v1/tasks", key, {
      principalId: "u_1",
      action: { type: "email.send" },
      payload: { action: "email.send", args: { to: "bob@example.com" } },
    });
    expect((await api(handle.port, "GET", "/v1/export", key)).status).toBe(403);
    expect((await api(handle.port, "GET", "/v1/export", key)).json.code).toBe("forbidden");
    expect((await api(handle.port, "GET", "/v1/export", null)).status).toBe(401);
    expect((await api(handle.port, "GET", "/v1/export?from=0", audit)).status).toBe(400);
    expect((await api(handle.port, "GET", "/v1/export?from=x", audit)).status).toBe(400);
    const admin = CredentialStore.open(serverDbPath(data));
    try {
      const row = admin.listKeys("audit")[0];
      admin.revokeKey(row?.id ?? "", "audit");
    } finally {
      admin.close();
    }
    expect((await api(handle.port, "GET", "/v1/export", audit)).status).toBe(401);
    const fresh = auditKey(data);
    const ranged = await request(handle.port, "GET", "/v1/export?from=2&to=3", {
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(ranged.status).toBe(200);
    const lines = ranged.body.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}").seq).toBe(2);
    expect(JSON.parse(lines[1] ?? "{}").seq).toBe(3);
  });
});
