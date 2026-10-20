import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  RunState,
  run,
  setTracingDisabled,
  tool,
  webSearchTool,
  type RunContext,
  type RunResult,
  type RunToolCallOutputItem,
} from "@openai/agents";
import { assistantMessage, functionCall, ScriptedModel } from "@openai/agents/testing";
import { LedgerError, initLocalDir, openLedger, type TaskView } from "@actledger/core";
import { ContentMismatch, Ledger, createToolGate, type Payload, type Transport } from "@actledger/sdk";
import {
  ActLedgerToolError,
  SDK_DEFAULT_TOOL_ERROR,
  createOpenAIAgentsLedger,
  denyMessage,
  ledgerTool,
  resolveInterruptions,
  withLedger,
  withLedgerAgent,
  type OpenAIAgentsLedger,
  type OpenAIAgentsLedgerEntry,
  type OpenAIAgentsLedgerStore,
} from "../src/index";

setTracingDisabled(true);

const dirs: string[] = [];

function localDir(policy?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-openai-"));
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

function approve(
  dir: string,
  task: { id: string; payloadHash: string; principalId: string },
  editedPayload?: Payload,
) {
  const engine = openLedger({ dir });
  try {
    engine.approve(task.id, {
      approverPrincipalId: task.principalId,
      assurance: "channel_verified",
      presentedHash: task.payloadHash,
      channel: "cli",
      simulated: true,
      editedPayload,
    });
  } finally {
    engine.close();
  }
}

function reject(dir: string, task: { id: string; payloadHash: string; principalId: string }) {
  const engine = openLedger({ dir });
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

function listTasks(dir: string): TaskView[] {
  const engine = openLedger({ dir });
  try {
    return engine.listTasks();
  } finally {
    engine.close();
  }
}

function receiptsFor(dir: string, taskId: string) {
  const engine = openLedger({ dir });
  try {
    return engine.exportReceipts().filter((receipt) => receipt.task_id === taskId);
  } finally {
    engine.close();
  }
}

function claimCount(dir: string, taskId: string) {
  return receiptsFor(dir, taskId).filter((receipt) => receipt.transition?.to === "executing").length;
}

function errorText(dir: string, taskId: string) {
  const engine = openLedger({ dir });
  try {
    const entry = engine.exportSecrets().find((item) => item.kind === "task" && item.task_id === taskId);
    return entry && entry.kind === "task" ? entry.error : null;
  } finally {
    engine.close();
  }
}

function toolOutputs(result: RunResult<any, any>): unknown[] {
  return result.newItems
    .filter((item): item is RunToolCallOutputItem => item.type === "tool_call_output_item")
    .map((item) => item.output);
}

function memoryStore() {
  const map = new Map<string, OpenAIAgentsLedgerEntry>();
  const store: OpenAIAgentsLedgerStore = {
    get: (key) => map.get(key),
    set: (key, entry) => {
      map.set(key, entry);
    },
    delete: (key) => {
      map.delete(key);
    },
  };
  return { store, size: () => map.size };
}

function openDefer(opts?: { onError?: OpenAIAgentsLedger extends never ? never : Parameters<typeof createOpenAIAgentsLedger>[0]["onError"]; executedPayload?: Parameters<typeof createOpenAIAgentsLedger>[0]["executedPayload"]; isToolError?: Parameters<typeof createOpenAIAgentsLedger>[0]["isToolError"]; onUnsupportedTool?: Parameters<typeof createOpenAIAgentsLedger>[0]["onUnsupportedTool"]; store?: OpenAIAgentsLedgerStore }) {
  const dir = localDir(gatePolicy);
  const ledger = new Ledger({ mode: "local", dir });
  const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
  const binding = createOpenAIAgentsLedger({
    gate,
    ledger,
    ...(opts?.onError ? { onError: opts.onError } : {}),
    ...(opts?.executedPayload ? { executedPayload: opts.executedPayload } : {}),
    ...(opts?.isToolError ? { isToolError: opts.isToolError } : {}),
    ...(opts?.onUnsupportedTool ? { onUnsupportedTool: opts.onUnsupportedTool } : {}),
    ...(opts?.store ? { store: opts.store } : {}),
  });
  return { dir, ledger, gate, binding };
}

const emailParams = z.object({ to: z.string(), body: z.string() });
const searchParams = z.object({ q: z.string() });

function emailTool(binding: OpenAIAgentsLedger, execute: (input: { to: string; body: string }) => Promise<string> | string) {
  return ledgerTool(
    {
      name: "send_email",
      description: "Send an email",
      parameters: emailParams,
      execute,
    },
    binding,
  );
}

function scripted(tools: ConstructorParameters<typeof Agent>[0]["tools"], calls: ReturnType<typeof functionCall>[], done = true) {
  const steps = [calls, ...(done ? [[assistantMessage("done")]] : [])];
  const model = new ScriptedModel(steps);
  const agent = new Agent({ name: "t", model, tools });
  return { model, agent };
}

describe("@actledger/openai-agents", () => {
  it("rejects a wait-mode gate", () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "wait" });
      expect(() => createOpenAIAgentsLedger({ gate, ledger })).toThrow(TypeError);
      expect(() => createOpenAIAgentsLedger({ gate, ledger })).toThrow(/defer-mode ToolGate/);
    } finally {
      ledger.close();
    }
  });

  it("binding exposes gate, inFlight and abandon, and no approve or reject", () => {
    const { ledger, gate, binding } = openDefer();
    try {
      expect(Object.keys(binding).sort()).toEqual(["abandon", "gate", "inFlight"]);
      expect("approve" in binding).toBe(false);
      expect("reject" in binding).toBe(false);
      expect(binding.gate).toBe(gate);
      expect(binding.inFlight).toBe(0);
      expect(binding.abandon).toBeTypeOf("function");
    } finally {
      ledger.close();
    }
  });

  it("ledgerTool refuses options.needsApproval", () => {
    const { ledger, binding } = openDefer();
    try {
      expect(() =>
        ledgerTool(
          {
            name: "send_email",
            description: "Send an email",
            parameters: emailParams,
            needsApproval: true,
            execute: async () => "sent",
          } as never,
          binding,
        ),
      ).toThrow(/ledgerTool owns needsApproval/);
    } finally {
      ledger.close();
    }
  });

  it("defer pending: run ends with a native interruption and execute does not run", async () => {
    const { dir, ledger, binding } = openDefer();
    const counts = { n: 0 };
    try {
      const send = emailTool(binding, async () => {
        counts.n += 1;
        return "sent";
      });
      const { agent } = scripted([send], [functionCall("send_email", { to: "a@b", body: "hi" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      expect(result.interruptions).toHaveLength(1);
      expect(result.interruptions[0]?.rawItem.type).toBe("function_call");
      if (result.interruptions[0]?.rawItem.type === "function_call") {
        expect(result.interruptions[0].rawItem.callId).toBe("call_1");
      }
      expect(counts.n).toBe(0);
      const tasks = listTasks(dir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.state).toBe("pending_approval");
      expect(claimCount(dir, tasks[0]!.id)).toBe(0);
    } finally {
      ledger.close();
    }
  });

  it("pending stays pending: resolveInterruptions reports pending and leaves the SDK state alone", async () => {
    const { dir, ledger, binding } = openDefer();
    try {
      const send = emailTool(binding, async () => "sent");
      const { agent } = scripted([send], [functionCall("send_email", { to: "a@b", body: "hi" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      const resolved = await resolveInterruptions(result, binding);
      expect(resolved.pending).toHaveLength(1);
      expect(resolved.pending[0]?.approveHint).toContain("actledger approve");
      expect(resolved.pending[0]?.approveHint).toContain("--assurance channel_verified");
      expect(resolved.approved).toHaveLength(0);
      expect(resolved.rejected).toHaveLength(0);
      expect(result.state.getInterruptions()).toHaveLength(1);
      expect(listTasks(dir)[0]?.state).toBe("pending_approval");
    } finally {
      ledger.close();
    }
  });

  it("after external approve: resolve approves, resumed run executes once and the receipt is executed", async () => {
    const { dir, ledger, binding } = openDefer();
    const counts = { n: 0 };
    try {
      const send = emailTool(binding, async () => {
        counts.n += 1;
        return "sent";
      });
      const { agent } = scripted([send], [functionCall("send_email", { to: "a@b", body: "hi" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      const task = listTasks(dir)[0]!;
      approve(dir, task);
      const resolved = await resolveInterruptions(result, binding);
      expect(resolved.approved).toHaveLength(1);
      const resumed = await run(agent, result.state);
      expect(counts.n).toBe(1);
      expect(listTasks(dir)[0]?.state).toBe("executed");
      expect(claimCount(dir, task.id)).toBe(1);
      const receipts = receiptsFor(dir, task.id);
      expect(receipts.at(-1)?.transition?.to).toBe("executed");
      expect(resumed.finalOutput).toBe("done");
    } finally {
      ledger.close();
    }
  });

  it("claim happens in execute, not in resolve", async () => {
    const { dir, ledger, binding } = openDefer();
    try {
      const send = emailTool(binding, async () => "sent");
      const { agent } = scripted([send], [functionCall("send_email", { to: "a@b", body: "hi" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      const task = listTasks(dir)[0]!;
      approve(dir, task);
      await resolveInterruptions(result, binding);
      expect(claimCount(dir, task.id)).toBe(0);
      expect(listTasks(dir)[0]?.state).toBe("approved");
      await run(agent, result.state);
      expect(claimCount(dir, task.id)).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("approved with edited args: execute receives the edited args", async () => {
    const { dir, ledger, binding } = openDefer();
    let seen: { to?: string; body?: string } | undefined;
    try {
      const send = emailTool(binding, async (input) => {
        seen = input;
        return "sent";
      });
      const { agent } = scripted([send], [functionCall("send_email", { to: "a@b", body: "hi" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      const task = listTasks(dir)[0]!;
      approve(dir, task, { action: "tool.send_email", args: { to: "c@d", body: "hi" } });
      await resolveInterruptions(result, binding);
      await run(agent, result.state);
      expect(seen?.to).toBe("c@d");
      expect(seen?.body).toBe("hi");
    } finally {
      ledger.close();
    }
  });

  it("after external reject: resolve rejects, the tool never runs and the model sees the deny message", async () => {
    const { dir, ledger, binding } = openDefer();
    const counts = { n: 0 };
    try {
      const send = emailTool(binding, async () => {
        counts.n += 1;
        return "sent";
      });
      const { agent } = scripted([send], [functionCall("send_email", { to: "a@b", body: "hi" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      const task = listTasks(dir)[0]!;
      reject(dir, task);
      const resolved = await resolveInterruptions(result, binding);
      expect(resolved.rejected).toHaveLength(1);
      expect(resolved.rejected[0]?.reason).toBe("rejected");
      const resumed = await run(agent, result.state);
      expect(counts.n).toBe(0);
      expect(claimCount(dir, task.id)).toBe(0);
      expect(listTasks(dir)[0]?.state).toBe("rejected");
      expect(receiptsFor(dir, task.id).at(-1)?.transition?.to).toBe("rejected");
      expect(toolOutputs(resumed)).toContain(denyMessage("send_email", "rejected", task.id));
    } finally {
      ledger.close();
    }
  });

  it("policy deny: interruption is rejected immediately without a human", async () => {
    const tracked = memoryStore();
    const { dir, ledger, binding } = openDefer({ store: tracked.store });
    const counts = { n: 0 };
    try {
      const drop = ledgerTool(
        {
          name: "drop_table",
          description: "Drop a table",
          parameters: z.object({ name: z.string() }),
          execute: async () => {
            counts.n += 1;
            return "dropped";
          },
        },
        binding,
      );
      const { agent } = scripted([drop], [functionCall("drop_table", { name: "users" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      expect(result.interruptions).toHaveLength(1);
      const resolved = await resolveInterruptions(result, binding);
      expect(resolved.rejected).toHaveLength(1);
      expect(resolved.rejected[0]?.reason).toBe("policy_denied");
      expect(counts.n).toBe(0);
      expect(tracked.size()).toBe(0);
      expect(listTasks(dir)[0]?.state).toBe("rejected");
    } finally {
      ledger.close();
    }
  });

  it("draft_only: interruption is rejected with reason drafted", async () => {
    const { ledger, binding } = openDefer();
    try {
      const draft = ledgerTool(
        {
          name: "draft_post",
          description: "Draft a post",
          parameters: z.object({ text: z.string() }),
          execute: async () => "drafted",
        },
        binding,
      );
      const { agent } = scripted([draft], [functionCall("draft_post", { text: "hi" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      const resolved = await resolveInterruptions(result, binding);
      expect(resolved.rejected).toHaveLength(1);
      expect(resolved.rejected[0]?.reason).toBe("drafted");
    } finally {
      ledger.close();
    }
  });

  it("auto-approved tool: no interruption, claim inside before, execute once, executed", async () => {
    const { dir, ledger, binding } = openDefer();
    const counts = { n: 0 };
    try {
      const search = ledgerTool(
        {
          name: "search",
          description: "Search",
          parameters: searchParams,
          execute: async () => {
            counts.n += 1;
            return "hits";
          },
        },
        binding,
      );
      const { agent } = scripted([search], [functionCall("search", { q: "x" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      expect(result.interruptions).toHaveLength(0);
      expect(counts.n).toBe(1);
      const task = listTasks(dir)[0]!;
      expect(claimCount(dir, task.id)).toBe(1);
      expect(task.state).toBe("executed");
      expect(binding.inFlight).toBe(0);
    } finally {
      ledger.close();
    }
  });

  it("timeoutMs fails the run as cancelled and a later success is not executed", async () => {
    const { dir, ledger, binding } = openDefer();
    let release = () => {};
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const search = ledgerTool(
        {
          name: "search",
          description: "Search",
          parameters: searchParams,
          timeoutMs: 200,
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            release();
            return "hits";
          },
        },
        binding,
      );
      const { agent } = scripted([search], [functionCall("search", { q: "x" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      await finished;
      const deadline = Date.now() + 2000;
      let task = listTasks(dir)[0];
      while (task?.state === "executing" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        task = listTasks(dir)[0];
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      task = listTasks(dir)[0];
      expect(task?.state).toBe("failed");
      expect(task?.error?.code).toBe("cancelled");
      expect(task?.state).not.toBe("executing");
      expect(receiptsFor(dir, task!.id).some((receipt) => receipt.transition?.to === "executed")).toBe(false);
      expect(toolOutputs(result).map(String).join("\n")).toContain("timed out");
      expect(toolOutputs(result).map(String).join("\n")).not.toContain("hits");
    } finally {
      ledger.close();
    }
  });

  it("execute throws: task failed with tool_error and the SDK error text reaches the model", async () => {
    const { dir, ledger, binding } = openDefer();
    try {
      const send = emailTool(binding, async () => {
        throw new Error("smtp down");
      });
      const { agent } = scripted([send], [functionCall("send_email", { to: "a@b", body: "hi" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      const task = listTasks(dir)[0]!;
      approve(dir, task);
      await resolveInterruptions(result, binding);
      const resumed = await run(agent, result.state);
      const failed = listTasks(dir)[0]!;
      expect(failed.state).toBe("failed");
      expect(failed.error?.code).toBe("tool_error");
      expect(errorText(dir, task.id)).toEqual({ code: "tool_error", message: "smtp down" });
      expect(toolOutputs(resumed)).toContain(SDK_DEFAULT_TOOL_ERROR);
      expect(receiptsFor(dir, task.id).some((receipt) => receipt.transition?.to === "executed")).toBe(false);
    } finally {
      ledger.close();
    }
  });

  it("auto-approved execute throws: task failed", async () => {
    const { dir, ledger, binding } = openDefer();
    try {
      const search = ledgerTool(
        {
          name: "search",
          description: "Search",
          parameters: searchParams,
          execute: async () => {
            throw new Error("index down");
          },
        },
        binding,
      );
      const { agent } = scripted([search], [functionCall("search", { q: "x" }, { callId: "call_1" })]);
      await run(agent, "go");
      const task = listTasks(dir)[0]!;
      expect(task.state).toBe("failed");
      expect(task.error?.code).toBe("tool_error");
      expect(errorText(dir, task.id)?.message).toBe("index down");
    } finally {
      ledger.close();
    }
  });

  it("withLedger on an existing tool: success completes, default error string fails", async () => {
    const success = openDefer();
    try {
      const original = tool({
        name: "search",
        description: "Search",
        parameters: searchParams,
        execute: async () => "hits",
      });
      const wrapped = withLedger(original, success.binding);
      const { agent } = scripted([wrapped], [functionCall("search", { q: "x" }, { callId: "call_1" })]);
      await run(agent, "go");
      expect(listTasks(success.dir)[0]?.state).toBe("executed");
    } finally {
      success.ledger.close();
    }

    const failure = openDefer();
    try {
      const original = tool({
        name: "search",
        description: "Search",
        parameters: searchParams,
        execute: async () => {
          throw new Error("boom");
        },
      });
      const wrapped = withLedger(original, failure.binding);
      const { agent } = scripted([wrapped], [functionCall("search", { q: "x" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      const task = listTasks(failure.dir)[0]!;
      expect(task.state).toBe("failed");
      expect(task.error?.code).toBe("tool_error");
      expect(toolOutputs(result)).toContain(SDK_DEFAULT_TOOL_ERROR);
      expect(SDK_DEFAULT_TOOL_ERROR).toBe("An error occurred while running the tool. Please try again.");
    } finally {
      failure.ledger.close();
    }
  });

  it("withLedger with isToolError recognizes a custom errorFunction output", async () => {
    const { dir, ledger, binding } = openDefer({ isToolError: (output) => output === "CUSTOM_FAIL" });
    try {
      const original = tool({
        name: "search",
        description: "Search",
        parameters: searchParams,
        execute: async () => {
          throw new Error("nope");
        },
        errorFunction: () => "CUSTOM_FAIL",
      });
      const wrapped = withLedger(original, binding);
      const { agent } = scripted([wrapped], [functionCall("search", { q: "x" }, { callId: "call_1" })]);
      await run(agent, "go");
      const task = listTasks(dir)[0]!;
      expect(task.state).toBe("failed");
      expect(errorText(dir, task.id)?.message).toBe("CUSTOM_FAIL");
    } finally {
      ledger.close();
    }
  });

  it("withLedgerAgent wraps every function tool and reports the rest", () => {
    const { ledger, binding } = openDefer();
    try {
      const search = tool({
        name: "search",
        description: "Search",
        parameters: searchParams,
        execute: async () => "hits",
      });
      const hosted = webSearchTool();
      const agent = new Agent({ name: "t", tools: [search, hosted] });
      const seen: unknown[] = [];
      const wrappedAgent = withLedgerAgent(agent, createOpenAIAgentsLedger({
        gate: binding.gate,
        ledger,
        onUnsupportedTool: (item) => seen.push(item),
      }));
      const wrappedTool = wrappedAgent.tools[0];
      const originalTool = agent.tools[0];
      expect(wrappedTool?.type).toBe("function");
      expect(originalTool?.type).toBe("function");
      if (wrappedTool?.type === "function" && originalTool?.type === "function") {
        expect(wrappedTool.needsApproval).not.toBe(originalTool.needsApproval);
      }
      expect(agent.tools[0]).toBe(search);
      expect(agent.tools[1]).toBe(hosted);
      expect(seen).toEqual([hosted]);
    } finally {
      ledger.close();
    }
  });

  it("serialized RunState resume does not open a second task", async () => {
    const { dir, ledger, binding } = openDefer();
    const counts = { n: 0 };
    try {
      const send = emailTool(binding, async () => {
        counts.n += 1;
        return "sent";
      });
      const { agent } = scripted([send], [functionCall("send_email", { to: "a@b", body: "hi" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      const task = listTasks(dir)[0]!;
      const restored = await RunState.fromString(agent, result.state.toString());
      approve(dir, task);
      const resolved = await resolveInterruptions(restored, binding);
      await run(agent, resolved.state);
      expect(listTasks(dir)).toHaveLength(1);
      expect(counts.n).toBe(1);
      expect(claimCount(dir, task.id)).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("revoked between resolve and resume: execute does not run", async () => {
    const { dir, ledger, binding } = openDefer();
    const counts = { n: 0 };
    try {
      const send = emailTool(binding, async () => {
        counts.n += 1;
        return "sent";
      });
      const { agent } = scripted([send], [functionCall("send_email", { to: "a@b", body: "hi" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      const task = listTasks(dir)[0]!;
      approve(dir, task);
      await resolveInterruptions(result, binding);
      await ledger.revoke(task.id);
      const resumed = await run(agent, result.state);
      expect(counts.n).toBe(0);
      expect(claimCount(dir, task.id)).toBe(0);
      expect(toolOutputs(resumed).join("\n")).toContain("revoked");
    } finally {
      ledger.close();
    }
  });

  it("ledger error in needsApproval fails closed", async () => {
    const seen: Array<{ phase: string }> = [];
    const tracked = memoryStore();
    const ledger = new Ledger({ transport: downTransport() });
    const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
    const binding = createOpenAIAgentsLedger({
      gate,
      ledger,
      store: tracked.store,
      onError: (_error, context) => seen.push(context),
    });
    const counts = { n: 0 };
    try {
      const send = emailTool(binding, async () => {
        counts.n += 1;
        return "sent";
      });
      const { agent } = scripted([send], [functionCall("send_email", { to: "a@b", body: "hi" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      expect(result.interruptions).toHaveLength(1);
      const resolved = await resolveInterruptions(result, binding);
      expect(resolved.rejected).toHaveLength(1);
      expect(resolved.rejected[0]?.reason).toBe("ledger_error");
      expect(seen[0]?.phase).toBe("before");
      expect(counts.n).toBe(0);
      expect(tracked.size()).toBe(0);
    } finally {
      ledger.close();
    }
  });

  it("after() ContentMismatch goes to onError when set and is rethrown when not", async () => {
    const seen: unknown[] = [];
    const swallowed = openDefer({
      executedPayload: () => ({ action: "tool.search", args: { q: "other" } }),
      onError: (error) => seen.push(error),
    });
    try {
      const search = ledgerTool(
        {
          name: "search",
          description: "Search",
          parameters: searchParams,
          execute: async () => "hits",
        },
        swallowed.binding,
      );
      const { agent } = scripted([search], [functionCall("search", { q: "x" }, { callId: "call_1" })]);
      await run(agent, "go");
      expect(seen[0]).toBeInstanceOf(ContentMismatch);
      expect(listTasks(swallowed.dir)[0]?.error?.code).toBe("content_mismatch");
    } finally {
      swallowed.ledger.close();
    }

    const thrown = openDefer({
      executedPayload: () => ({ action: "tool.search", args: { q: "other" } }),
    });
    try {
      const search = ledgerTool(
        {
          name: "search",
          description: "Search",
          parameters: searchParams,
          errorFunction: null,
          execute: async () => "hits",
        },
        thrown.binding,
      );
      const { agent } = scripted([search], [functionCall("search", { q: "x" }, { callId: "call_1" })]);
      await expect(run(agent, "go")).rejects.toThrow(/ContentMismatch/);
      expect(listTasks(thrown.dir)[0]?.error?.code).toBe("content_mismatch");
    } finally {
      thrown.ledger.close();
    }
  });

  it("abandon fails held auto-approved runs with code abandoned", async () => {
    const { dir, ledger, binding } = openDefer();
    try {
      const search = tool({
        name: "search",
        description: "Search",
        parameters: searchParams,
        execute: async () => "hits",
      });
      const wrapped = withLedger(search, binding);
      await wrapped.needsApproval({} as RunContext, { q: "x" }, "c1");
      expect(binding.inFlight).toBe(1);
      await binding.abandon();
      expect(binding.inFlight).toBe(0);
      const task = listTasks(dir)[0]!;
      expect(task.state).toBe("failed");
      expect(task.error?.code).toBe("abandoned");
    } finally {
      ledger.close();
    }
  });

  it("untracked interruptions are left alone", async () => {
    const { ledger, binding } = openDefer();
    try {
      const native = tool({
        name: "send_email",
        description: "Send an email",
        parameters: emailParams,
        needsApproval: true,
        execute: async () => "sent",
      });
      const { agent } = scripted([native], [functionCall("send_email", { to: "a@b", body: "hi" }, { callId: "call_1" })]);
      const result = await run(agent, "go");
      const resolved = await resolveInterruptions(result, binding);
      expect(resolved.untracked).toHaveLength(1);
      expect(resolved.approved).toHaveLength(0);
      expect(resolved.rejected).toHaveLength(0);
      expect(result.state.getInterruptions()).toHaveLength(1);
      expect(result.state._context.isToolApproved({ toolName: "send_email", callId: "call_1" })).toBeUndefined();
    } finally {
      ledger.close();
    }
  });

  it("invoke without a callId refuses to run", async () => {
    const { ledger, binding } = openDefer();
    const counts = { n: 0 };
    try {
      const search = tool({
        name: "search",
        description: "Search",
        parameters: searchParams,
        execute: async () => {
          counts.n += 1;
          return "hits";
        },
      });
      const wrapped = withLedger(search, binding);
      await expect(wrapped.invoke({} as RunContext, JSON.stringify({ q: "x" }), {})).rejects.toThrow(ActLedgerToolError);
      await expect(wrapped.invoke({} as RunContext, JSON.stringify({ q: "x" }), {})).rejects.toThrow(/no callId/);
      expect(counts.n).toBe(0);
    } finally {
      ledger.close();
    }
  });

  it("denyMessage includes tool name, reason and task id", () => {
    expect(denyMessage("send_email", "rejected", "tsk_1")).toBe(
      "ActLedger did not allow send_email: rejected (task tsk_1).",
    );
    expect(denyMessage("send_email", "ledger_error", null)).toBe(
      "ActLedger did not allow send_email: ledger_error (task null).",
    );
  });
});
