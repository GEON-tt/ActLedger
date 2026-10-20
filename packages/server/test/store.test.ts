import fs from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { formatTimestamp } from "@actledger/core";
import { CredentialStore } from "../src/store.js";
import { serverDbPath } from "../src/data.js";
import { cleanup, tempData } from "./helpers.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

afterEach(async () => {
  await cleanup();
});

describe("credential store", () => {
  it("adds users and rejects duplicates and bad names", () => {
    const data = tempData();
    const store = CredentialStore.open(serverDbPath(data));
    try {
      store.addUser({ username: "Alice", principalId: "u_1", passwordHash: "hash", totpSecret: "SECRET" });
      expect(store.getUserByName("ALICE")?.username).toBe("alice");
      expect(() =>
        store.addUser({ username: "alice", principalId: "u_2", passwordHash: "hash", totpSecret: "SECRET" }),
      ).toThrow(/user_exists|already exists/);
      try {
        store.addUser({ username: "bob", principalId: "u_1", passwordHash: "hash", totpSecret: "SECRET" });
        throw new Error("expected principal_taken");
      } catch (error) {
        expect((error as { code?: string }).code).toBe("principal_taken");
      }
      expect(() =>
        store.addUser({ username: "-bad", principalId: "u_3", passwordHash: "hash", totpSecret: "SECRET" }),
      ).toThrow(/invalid_request|username/);
      try {
        store.addUser({ username: "a b", principalId: "u_4", passwordHash: "hash", totpSecret: "SECRET" });
        throw new Error("expected invalid username");
      } catch (error) {
        expect((error as { code?: string }).code).toBe("invalid_request");
      }
    } finally {
      store.close();
    }
  });

  it("locks an account after five failures and clears it on success", () => {
    let clock = new Date("2026-01-05T00:00:00.000Z");
    const data = tempData();
    const store = CredentialStore.open(serverDbPath(data), () => clock);
    try {
      const user = store.addUser({ username: "alice", principalId: "u_1", passwordHash: "hash", totpSecret: "SECRET" });
      for (let i = 0; i < 4; i++) store.recordLoginFailure(user.id);
      expect(store.getUser(user.id)?.failedLogins).toBe(4);
      const locked = store.recordLoginFailure(user.id);
      expect(locked.failedLogins).toBe(0);
      expect(locked.lockedUntil).toBe(formatTimestamp(new Date(clock.getTime() + 15 * 60_000)));
      store.recordLoginSuccess(user.id);
      const cleared = store.getUser(user.id);
      expect(cleared?.failedLogins).toBe(0);
      expect(cleared?.lockedUntil).toBeNull();
    } finally {
      store.close();
    }
  });

  it("consumes a totp step only when it moves forward", () => {
    const data = tempData();
    const store = CredentialStore.open(serverDbPath(data));
    try {
      const user = store.addUser({ username: "alice", principalId: "u_1", passwordHash: "hash", totpSecret: "SECRET" });
      expect(store.consumeTotpStep(user.id, 10)).toBe(true);
      expect(store.consumeTotpStep(user.id, 10)).toBe(false);
      expect(store.consumeTotpStep(user.id, 9)).toBe(false);
      expect(store.consumeTotpStep(user.id, 11)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("resets totp and bumps the session epoch", () => {
    const data = tempData();
    const store = CredentialStore.open(serverDbPath(data));
    try {
      const user = store.addUser({ username: "alice", principalId: "u_1", passwordHash: "hash", totpSecret: "SECRET" });
      store.consumeTotpStep(user.id, 4);
      const reset = store.resetTotp("alice", "NEWSECRET");
      expect(reset.sessionEpoch).toBe(user.sessionEpoch + 1);
      expect(reset.totpLastStep).toBe(0);
      expect(reset.totpSecret).toBe("NEWSECRET");
    } finally {
      store.close();
    }
  });

  it("stores only the hash of an api key", () => {
    const data = tempData();
    const store = CredentialStore.open(serverDbPath(data));
    let key = "";
    let id = "";
    try {
      const created = store.createKey({ kind: "agent", agentId: "agent-1", principalIds: ["u_1", "u_1"] });
      key = created.key;
      id = created.row.id;
      expect(key).toMatch(/^alk_[A-Za-z0-9_-]{43}$/);
      expect(created.row.principalIds).toEqual(["u_1"]);
      expect(store.findActiveKey(key)?.id).toBe(id);
      const revoked = store.revokeKey(id, "agent");
      expect(revoked.revokedAt).toBeTruthy();
      expect(store.findActiveKey(key)).toBeNull();
      expect(store.revokeKey(id, "agent").id).toBe(id);
      expect(() => store.revokeKey(id, "audit")).toThrow(/not_found|not found/);
      expect(() => store.createKey({ kind: "agent", agentId: "agent-2", principalIds: [] })).toThrow(/invalid_request|principal/);
    } finally {
      store.close();
    }
    const db = new DatabaseSync(serverDbPath(data));
    try {
      const rows = db.prepare("SELECT * FROM api_keys").all() as Array<Record<string, unknown>>;
      const hash = createHash("sha256").update(key, "utf8").digest("hex");
      expect(rows.some((row) => row.key_hash === hash)).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(key);
    } finally {
      db.close();
    }
  });

  it.skipIf(process.platform === "win32")("keeps the data directory private", () => {
    const data = tempData();
    expect(fs.statSync(data).mode & 0o777).toBe(0o700);
    expect(fs.statSync(serverDbPath(data)).mode & 0o777).toBe(0o600);
  });
});
