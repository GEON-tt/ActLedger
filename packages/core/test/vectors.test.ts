import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commit } from "../src/canonical";
import type { KeySet } from "../src/crypto";
import { parseSecretsJsonl } from "../src/secrets";
import { verifyJsonl } from "../src/verify";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../spec/test-vectors");

function read(name: string): string {
  return fs.readFileSync(path.join(dir, name), "utf8");
}

function keys(): KeySet {
  return JSON.parse(read("keys.json")) as KeySet;
}

describe("receipt 0.1 vector", () => {
  it("verifies and warns about plaintext instead of failing", () => {
    const report = verifyJsonl(read("receipts-chain-0.1.jsonl"), keys());
    expect(report.ok).toBe(true);
    expect(report.failure).toBeUndefined();
    expect(report.warnings[0]?.code).toBe("v01_plaintext");
    expect(report.stats.byVersion["actledger.receipt/0.1"]).toBe(5);
    expect(report.stats.count).toBe(5);
    expect(report.stats.byMode.recorded).toBeGreaterThan(0);
  });
});

describe("receipt 0.2 vector", () => {
  it("verifies without secrets and again with the secrets file", () => {
    const text = read("receipts-chain-0.2.jsonl");
    const plain = verifyJsonl(text, keys());
    expect(plain.ok).toBe(true);
    const report = verifyJsonl(text, keys(), { secrets: parseSecretsJsonl(read("secrets-0.2.jsonl")) });
    expect(report.ok).toBe(true);
    expect(report.stats.secrets?.checked).toBeGreaterThan(0);
    expect(report.stats.secrets?.shredded).toBeGreaterThanOrEqual(1);
  });

  it("rejects a tampered executed payload or intent", () => {
    const text = read("receipts-chain-0.2.jsonl");
    const entries = parseSecretsJsonl(read("secrets-0.2.jsonl"));
    const executed = structuredClone(entries);
    const task = executed.find((entry) => entry.kind === "task" && entry.executed_payload && !entry.shredded);
    expect(task && task.kind === "task").toBe(true);
    if (task?.kind === "task" && task.executed_payload && typeof task.executed_payload === "object") {
      const args = (task.executed_payload as { args?: Record<string, unknown> }).args;
      if (args && typeof args.title === "string") args.title = `${args.title}x`;
      else if (args && typeof args.subject === "string") args.subject = `${args.subject}x`;
    }
    expect(verifyJsonl(text, keys(), { secrets: executed }).failure?.step).toBe("secrets");

    const intent = structuredClone(entries);
    const named = intent.find((entry) => entry.kind === "task" && typeof entry.intent === "string" && !entry.shredded);
    expect(named && named.kind === "task").toBe(true);
    if (named?.kind === "task" && typeof named.intent === "string") named.intent = `${named.intent}x`;
    expect(verifyJsonl(text, keys(), { secrets: intent }).failure?.step).toBe("secrets");
  });
});

describe("commitment vectors", () => {
  it("recomputes the fixed hmac cases", () => {
    const file = JSON.parse(read("commitments.json")) as {
      salt_hex: string;
      cases: Array<{ value: unknown; commit: string }>;
    };
    const salt = Buffer.from(file.salt_hex, "hex");
    expect(file.cases.length).toBeGreaterThanOrEqual(3);
    for (const item of file.cases) expect(commit(salt, item.value)).toBe(item.commit);
  });
});
