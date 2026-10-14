import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commit } from "../packages/core/src/canonical";
import type { IdFactory } from "../packages/core/src/ids";
import { initLocalDir, openLedger, serializeSecrets, type KeySet } from "../packages/core/src/index";
import type { Payload } from "../packages/core/src/payload";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vectorDir = path.join(root, "spec/test-vectors");
const ORIGINAL_KID = "app_01M4TD6HC8V5JKAH1A9XH1WWXW#k2026a";

const emailPayload: Payload = {
  action: "email.send",
  args: { to: ["bob@clienta.com"], subject: "Re: 报价" },
  content: { content_type: "text/plain", text: "hello" },
  allowed_drift: ["args.signature"],
};

function main(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-vec-"));
  try {
    initLocalDir(dir);
    let now = Date.parse("2026-10-13T08:00:00.000Z");
    let n = 0;
    const newId: IdFactory = (prefix) => {
      n += 1;
      return `${prefix}_V02_${String(n).padStart(4, "0")}`;
    };
    const engine = openLedger({
      dir,
      now: () => new Date(now),
      newId,
    });
    try {
      const calendar = engine.request({
        principalId: "u_1",
        agentId: "mail-agent",
        intent: "create standup",
        action: { type: "calendar.create" },
        payload: { action: "calendar.create", args: { title: "standup" } },
      });
      const calendarRun = engine.claim(calendar.task.id);
      engine.complete(calendar.task.id, { executedPayload: calendarRun.approvedPayload });

      const email = engine.request({
        principalId: "u_1",
        agentId: "mail-agent",
        intent: "回复邮件",
        action: { type: "email.send", attrs: { recipient_domain: "clienta.com" } },
        payload: emailPayload,
      });
      const edited: Payload = {
        ...emailPayload,
        args: { ...emailPayload.args, subject: "Re: 报价 v2" },
      };
      engine.approve(email.task.id, {
        approverPrincipalId: "u_1",
        channel: "cli",
        assurance: "channel_verified",
        presentedHash: email.task.payloadHash,
        editedPayload: edited,
        simulated: true,
      });
      const emailRun = engine.claim(email.task.id);
      engine.complete(email.task.id, {
        executedPayload: {
          ...emailRun.approvedPayload,
          args: { ...emailRun.approvedPayload.args, signature: "—— Alice" },
        },
        externalProofs: [{ type: "email_msgid", value: "<id@mail>" }],
      });

      const rejected = engine.request({
        principalId: "u_1",
        agentId: "mail-agent",
        intent: "不要发",
        action: { type: "email.send", attrs: { recipient_domain: "clienta.com" } },
        payload: emailPayload,
      });
      engine.reject(rejected.task.id, {
        approverPrincipalId: "u_1",
        channel: "cli",
        assurance: "app_asserted",
        presentedHash: rejected.task.payloadHash,
        note: "收件人不对",
      });

      const failed = engine.request({
        principalId: "u_1",
        agentId: "mail-agent",
        intent: "发送失败",
        action: { type: "email.send", attrs: { recipient_domain: "clienta.com" } },
        payload: emailPayload,
      });
      engine.approve(failed.task.id, {
        approverPrincipalId: "u_1",
        channel: "cli",
        assurance: "channel_verified",
        presentedHash: failed.task.payloadHash,
        simulated: true,
      });
      engine.claim(failed.task.id);
      engine.fail(failed.task.id, { error: { code: "smtp_down", message: "connection reset" } });

      const timed = engine.request({
        principalId: "u_1",
        agentId: "mail-agent",
        intent: "超时对账",
        action: { type: "email.send", attrs: { recipient_domain: "clienta.com" } },
        payload: emailPayload,
      });
      engine.approve(timed.task.id, {
        approverPrincipalId: "u_1",
        channel: "cli",
        assurance: "channel_verified",
        presentedHash: timed.task.payloadHash,
        simulated: true,
      });
      engine.claim(timed.task.id);
      now += 16 * 60 * 1000;
      engine.sweep();
      engine.reconcile(timed.task.id, { outcome: "failed", note: "not in the smtp log" });

      engine.reportViolation({
        actionType: "shell.exec",
        description: "ran outside the ledger",
        agentId: "mail-agent",
      });

      engine.request({
        principalId: "u_2",
        agentId: "mail-agent",
        intent: "temporary",
        action: { type: "calendar.create" },
        payload: { action: "calendar.create", args: { title: "temp" } },
      });
      engine.shredPrincipal("u_2");

      const receipts = engine.exportReceipts();
      const secrets = engine.exportSecrets();
      fs.writeFileSync(path.join(vectorDir, "receipts-chain-0.2.jsonl"), `${receipts.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`);
      fs.writeFileSync(path.join(vectorDir, "secrets-0.2.jsonl"), serializeSecrets(secrets));
    } finally {
      engine.close();
    }

    const created = JSON.parse(fs.readFileSync(path.join(dir, "keys.json"), "utf8")) as KeySet;
    const existing = JSON.parse(fs.readFileSync(path.join(vectorDir, "keys.json"), "utf8")) as KeySet;
    const kept = existing.keys.filter((key) => key.kid === ORIGINAL_KID);
    const merged: KeySet = { keys: [...kept, ...created.keys] };
    fs.writeFileSync(path.join(vectorDir, "keys.json"), `${JSON.stringify(merged, null, 2)}\n`);
    writeCommitments(path.join(vectorDir, "commitments.json"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeCommitments(file: string): void {
  const saltHex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const salt = Buffer.from(saltHex, "hex");
  const cases = [
    { label: "string", value: "hello" },
    { label: "object", value: { b: 1, a: 2 } },
    { label: "zh", value: "回复邮件" },
    {
      label: "payload",
      value: { action: "calendar.create", args: { title: "standup" } },
    },
  ];
  const document = {
    alg: "hmac-sha256",
    salt_hex: saltHex,
    cases: cases.map((item) => ({ ...item, commit: commit(salt, item.value) })),
  };
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
}

main();
