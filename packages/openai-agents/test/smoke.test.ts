import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, run, setTracingDisabled } from "@openai/agents";
import { initLocalDir, openLedger } from "@actledger/core";
import { Ledger, createToolGate } from "@actledger/sdk";
import { createOpenAIAgentsLedger, ledgerTool, resolveInterruptions } from "../src/index";

setTracingDisabled(true);

const key = process.env.OPENAI_API_KEY;
const dirs: string[] = [];

const policy = `
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
  tool.send_email: { level: send }
rules:
  - id: send-approve
    match: { action: tool.send_email }
    effect: require_approval
`;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!key)("openai agents smoke (real model)", () => {
  it("interrupts a real tool call, then executes it after an out-of-band approval", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-openai-smoke-"));
    dirs.push(dir);
    initLocalDir(dir, { policyYaml: policy });
    const ledger = new Ledger({ mode: "local", dir });
    const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
    const binding = createOpenAIAgentsLedger({ gate, ledger });
    const counts = { n: 0 };
    const sendEmail = ledgerTool(
      {
        name: "send_email",
        description: "Send an email",
        parameters: z.object({ to: z.string(), body: z.string() }),
        execute: async () => {
          counts.n += 1;
          return "sent";
        },
      },
      binding,
    );
    const modelName = process.env.OPENAI_DEFAULT_MODEL;
    const agent = new Agent({
      name: "mailer",
      instructions: "You send email only by calling send_email. After it returns, say done.",
      ...(modelName ? { model: modelName } : {}),
      tools: [sendEmail],
    });
    try {
      let result = await run(
        agent,
        "Call the send_email tool now with to bob@example.com and body ready. Do not do anything else first.",
        { maxTurns: 4 },
      );
      expect(result.interruptions.length).toBeGreaterThanOrEqual(1);
      const engine = openLedger({ dir });
      try {
        for (const task of engine.listTasks({ state: "pending_approval" })) {
          engine.approve(task.id, {
            approverPrincipalId: task.principalId,
            assurance: "channel_verified",
            presentedHash: task.payloadHash,
            channel: "cli",
            simulated: true,
          });
        }
      } finally {
        engine.close();
      }
      const resolved = await resolveInterruptions(result, binding);
      expect(resolved.pending).toHaveLength(0);
      expect(resolved.approved.length).toBeGreaterThanOrEqual(1);
      result = await run(agent, result.state, { maxTurns: 4 });
      const tasks = openLedger({ dir });
      try {
        expect(tasks.listTasks().some((task) => task.state === "executed")).toBe(true);
      } finally {
        tasks.close();
      }
      expect(counts.n).toBeGreaterThanOrEqual(1);
      expect(result.interruptions).toHaveLength(0);
    } finally {
      await binding.abandon();
      ledger.close();
    }
  });
});
