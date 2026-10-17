import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { jcs, initLocalDir, openLedger, type Receipt } from "@actledger/core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const cli = path.join(root, "packages/cli/src/main.ts");
const dirs: string[] = [];

function run(args: string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const stepUpPolicy = `
version: 1
defaults:
  unknown_action: require_approval
  content_mode: strict
actions:
  email.send: { level: send }
rules:
  - id: send
    match: { action: email.send }
    effect: require_approval
    approval:
      min_assurance: app_asserted
      step_up: webauthn
`;

describe("cli", () => {
  it("rejects an unknown --assurance", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-cli-"));
    dirs.push(dir);
    initLocalDir(dir);
    for (const assurance of ["policy", "notarand"]) {
      const result = run(["approve", "tsk_missing", "--dir", dir, "--assurance", assurance]);
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("invalid_request");
    }
  });

  it("prints the payload and marks --step-up as simulated", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-cli-"));
    dirs.push(dir);
    initLocalDir(dir, { policyYaml: stepUpPolicy });
    const payload = {
      action: "email.send",
      args: { to: ["a@b.c"] },
      content: { content_type: "text/plain", text: "visible-body" },
    };
    const engine = openLedger({ dir });
    const created = engine.request({
      principalId: "u_1",
      intent: "reply to bob",
      action: { type: "email.send" },
      payload,
    });
    engine.close();

    const approved = run([
      "approve",
      created.task.id,
      "--dir",
      dir,
      "--assurance",
      "app_asserted",
      "--step-up",
    ]);
    expect(approved.status, approved.stderr).toBe(0);
    expect(approved.stderr).toContain("action: email.send");
    expect(approved.stderr).toContain("intent: reply to bob");
    expect(approved.stderr).toContain(`payload_hash: ${created.task.payloadHash}`);
    expect(approved.stderr).toContain(jcs(payload));

    const again = openLedger({ dir });
    const receipt = again.exportReceipts().find((item) => item.transition?.to === "approved") as Receipt | undefined;
    const approval = receipt?.body.approval as { assurance?: string; auth?: { simulated?: boolean; step_up?: string | null } };
    expect(approval?.assurance).toBe("app_asserted");
    expect(approval?.auth?.simulated).toBe(true);
    expect(approval?.auth?.step_up).toBe("webauthn");
    again.close();
  });

  it("writes export --secrets as mode 0600 and verifies them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-cli-"));
    dirs.push(dir);
    initLocalDir(dir);
    const engine = openLedger({ dir });
    engine.request({
      principalId: "u_1",
      intent: "reply to bob",
      action: { type: "calendar.create" },
      payload: { action: "calendar.create", args: { title: "standup" } },
    });
    engine.close();
    const secrets = path.join(dir, "secrets.jsonl");
    const receipts = path.join(dir, "receipts.jsonl");
    const exported = run(["export", "--dir", dir, "--secrets", secrets]);
    expect(exported.status, exported.stderr).toBe(0);
    expect(exported.stderr).toContain("secrets 文件含解密原文");
    expect(fs.statSync(secrets).mode & 0o777).toBe(0o600);
    fs.writeFileSync(receipts, exported.stdout);
    const again = run(["export", "--dir", dir, "--secrets", secrets]);
    expect(again.status, again.stderr).not.toBe(0);
    const verified = run(["verify", receipts, "--keys", path.join(dir, "keys.json"), "--secrets", secrets]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain("secrets=");
  });

  it("requires a note to reject", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-cli-"));
    dirs.push(dir);
    initLocalDir(dir);
    const engine = openLedger({ dir });
    const created = engine.request({
      principalId: "u_1",
      intent: "reply",
      action: { type: "email.send" },
      payload: { action: "email.send", args: { to: ["a@b.c"] } },
    });
    const before = engine.exportReceipts().length;
    const id = created.task.id;
    engine.close();
    const missing = run(["reject", id, "--dir", dir]);
    expect(missing.status, missing.stderr).not.toBe(0);
    expect(missing.stderr).toContain("reason_required");
    const blank = run(["reject", id, "--dir", dir, "--note", "  "]);
    expect(blank.status, blank.stderr).not.toBe(0);
    expect(blank.stderr).toContain("reason_required");
    const again = openLedger({ dir });
    expect(again.getTask(id)?.state).toBe("pending_approval");
    expect(again.exportReceipts().length).toBe(before);
    again.close();
    const rejected = run(["reject", id, "--dir", dir, "--note", "no"]);
    expect(rejected.status, rejected.stderr).toBe(0);
    const done = openLedger({ dir });
    expect(done.getTask(id)?.state).toBe("rejected");
    done.close();
  });

  it("prints the login URL without starting the server", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-cli-"));
    dirs.push(dir);
    initLocalDir(dir);
    const first = run(["serve", "--print-login", "--dir", dir]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/^http:\/\/127\.0\.0\.1:4319\/login\?token=[A-Za-z0-9_-]{43}\n$/);
    expect(fs.statSync(path.join(dir, "serve.token")).mode & 0o777).toBe(0o600);
    const second = run(["serve", "--print-login", "--dir", dir]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    const ported = run(["serve", "--print-login", "--dir", dir, "--port", "5001"]);
    expect(ported.status, ported.stderr).toBe(0);
    expect(ported.stdout).toMatch(/^http:\/\/127\.0\.0\.1:5001\/login\?token=[A-Za-z0-9_-]{43}\n$/);
    expect(new URL(ported.stdout.trim()).searchParams.get("token")).toBe(new URL(first.stdout.trim()).searchParams.get("token"));
    const rotated = run(["serve", "--rotate-token", "--print-login", "--dir", dir]);
    expect(rotated.status, rotated.stderr).toBe(0);
    expect(rotated.stdout).not.toBe(first.stdout);
    expect((JSON.parse(fs.readFileSync(path.join(dir, "serve.token"), "utf8")) as { generation: number }).generation).toBe(2);
    const mixed = run(["serve", "--print-login", "--one-time-login", "--dir", dir]);
    expect(mixed.status).not.toBe(0);
    expect(mixed.stderr).toContain("invalid_request");
    const approver = run(["serve", "--print-login", "--approver", "u_1", "--dir", dir]);
    expect(approver.status).not.toBe(0);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "actl-cli-"));
    dirs.push(empty);
    const missing = run(["serve", "--print-login", "--dir", empty]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("not_found");
    expect(fs.existsSync(path.join(empty, "serve.token"))).toBe(false);
  });
});
