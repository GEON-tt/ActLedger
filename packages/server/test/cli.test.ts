import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type ServerHandle } from "../src/server.js";
import { renderQr } from "../src/qr.js";
import { totpCode } from "../src/totp.js";
import { api, login } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const main = path.join(root, "packages/server/src/main.ts");
const dirs: string[] = [];
const handles: ServerHandle[] = [];

function run(args: string[], input?: string) {
  return spawnSync(process.execPath, [tsx, main, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    input,
    env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  });
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-cli-"));
  dirs.push(dir);
  return dir;
}

describe("actledger-server", () => {
  it("initializes a data directory once", () => {
    const data = tmp();
    const created = run(["init", "--data", data]);
    expect(created.status).toBe(0);
    expect(created.stdout).toContain("initialized");
    expect(fs.existsSync(path.join(data, "ledger", "app.json"))).toBe(true);
    expect(fs.existsSync(path.join(data, "server.db"))).toBe(true);
    const again = run(["init", "--data", data]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already initialized");
  });

  it("adds a user from stdin and can skip the qr code", () => {
    const data = tmp();
    run(["init", "--data", data]);
    const added = run(["user", "add", "alice", "--principal", "u_1", "--data", data, "--password-stdin", "--json"], "correct horse battery\n");
    expect(added.status).toBe(0);
    const json = JSON.parse(added.stdout) as { otpauthUrl: string; secret: string };
    expect(json.otpauthUrl.startsWith("otpauth://totp/ActLedger:alice?")).toBe(true);
    expect(json.secret).toMatch(/^[A-Z2-7]{32}$/);
    const text = run(["user", "add", "carol", "--principal", "u_2", "--data", data, "--password-stdin", "--no-qr"], "correct horse battery\n");
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("otpauth://");
    expect(text.stdout).toContain("secret: ");
  });

  it("reports a taken principal, a short password, and a missing terminal", () => {
    const data = tmp();
    run(["init", "--data", data]);
    run(["user", "add", "alice", "--principal", "u_1", "--data", data, "--password-stdin"], "correct horse battery\n");
    const taken = run(["user", "add", "bob", "--principal", "u_1", "--data", data, "--password-stdin"], "correct horse battery\n");
    expect(taken.status).toBe(1);
    expect(taken.stderr).toContain("principal_taken");
    const short = run(["user", "add", "cara", "--principal", "u_3", "--data", data, "--password-stdin"], "short\n");
    expect(short.status).toBe(1);
    expect(short.stderr).toContain("password must be 12 to 256 characters");
    const noTty = run(["user", "add", "dana", "--principal", "u_4", "--data", data]);
    expect(noTty.status).toBe(1);
    expect(noTty.stderr).toContain("--password-stdin");
  });

  it("creates an agent key and does not list the secret", () => {
    const data = tmp();
    run(["init", "--data", data]);
    const created = run(["agent-key", "create", "--agent", "agent-1", "--principal", "u_1", "--data", data, "--json"]);
    expect(created.status).toBe(0);
    const json = JSON.parse(created.stdout) as { id: string; key: string };
    expect(json.key.startsWith("alk_")).toBe(true);
    const listed = run(["agent-key", "list", "--data", data, "--json"]);
    expect(listed.stdout).toContain(json.id);
    expect(listed.stdout).not.toContain(json.key);
  });

  it("creates an audit key", () => {
    const data = tmp();
    run(["init", "--data", data]);
    const created = run(["audit-key", "create", "--data", data, "--json"]);
    expect(created.status).toBe(0);
    expect((JSON.parse(created.stdout) as { key: string }).key.startsWith("ala_")).toBe(true);
  });

  it("serves the keys and drops access when they are revoked or totp is reset", async () => {
    const data = tmp();
    expect(run(["init", "--data", data]).status).toBe(0);
    const user = run(["user", "add", "alice", "--principal", "u_1", "--data", data, "--password-stdin", "--json"], "correct horse battery\n");
    const secret = (JSON.parse(user.stdout) as { secret: string }).secret;
    const agent = JSON.parse(run(["agent-key", "create", "--agent", "agent-1", "--principal", "u_1", "--data", data, "--json"]).stdout) as {
      id: string;
      key: string;
    };
    const audit = (JSON.parse(run(["audit-key", "create", "--data", data, "--json"]).stdout) as { key: string }).key;
    const handle = await startServer({ data, port: 0, sweepMs: 0 });
    handles.push(handle);
    expect((await api(handle.port, "POST", "/v1/tasks", agent.key, {
      principalId: "u_1",
      action: { type: "email.send" },
      payload: { action: "email.send", args: { to: "bob@example.com" } },
    })).status).toBe(200);
    expect((await api(handle.port, "GET", "/v1/export", audit)).status).toBe(200);
    const logged = await login(handle.port, "alice", "correct horse battery", totpCode(secret, new Date()));
    expect(logged.status).toBe(303);

    const revoked = run(["agent-key", "revoke", agent.id, "--data", data]);
    expect(revoked.stdout).toBe(`revoked ${agent.id}\n`);
    expect((await api(handle.port, "POST", "/v1/tasks", agent.key, {
      principalId: "u_1",
      action: { type: "email.send" },
      payload: { action: "email.send", args: { to: "bob@example.com" } },
    })).status).toBe(401);

    const reset = run(["user", "reset-totp", "alice", "--data", data, "--json"]);
    expect(reset.status).toBe(0);
    expect((JSON.parse(reset.stdout) as { secret: string }).secret).toMatch(/^[A-Z2-7]{32}$/);
    expect((await api(handle.port, "GET", "/api/tasks", null, undefined, { cookie: logged.cookie ?? "" })).status).toBe(401);
  });

  it("prints help", () => {
    const help = run(["help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("actledger-server serve");
  });

  it("renders a qr code when the module is installed", () => {
    const qr = renderQr("otpauth://totp/x?secret=A");
    expect(qr === null || (typeof qr === "string" && qr.length > 0)).toBe(true);
  });
});
