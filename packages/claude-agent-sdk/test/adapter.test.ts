import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionResult,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { LedgerError, initLocalDir, openLedger } from "@actledger/core";
import {
  ContentMismatch,
  Ledger,
  LedgerUnavailable,
  createToolGate,
  type Payload,
  type ToolGateDeny,
  type ToolGatePending,
  type Transport,
} from "@actledger/sdk";
import { createClaudeAgentAdapter, denyMessage, type ClaudeAgentAdapter } from "../src/index";

const dirs: string[] = [];

function localDir(policy?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-claude-"));
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

async function findPending(dir: string) {
  const start = Date.now();
  while (Date.now() - start < 8_000) {
    const engine = openLedger({ dir });
    try {
      const task = engine.listTasks({ state: "pending_approval" })[0];
      if (task) return task;
    } finally {
      engine.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no pending task");
}

function approve(
  dir: string,
  task: { id: string; payloadHash: string; principalId: string },
  now?: () => Date,
  editedPayload?: Payload,
) {
  const engine = openLedger({ dir, now });
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

function listTasks(dir: string) {
  const engine = openLedger({ dir });
  try {
    return engine.listTasks();
  } finally {
    engine.close();
  }
}

function permissionOptions(toolUseID: string, signal = new AbortController().signal) {
  return { signal, toolUseID, requestId: `req_${toolUseID}` } satisfies Parameters<CanUseTool>[2];
}

function postToolUse(
  toolName: string,
  toolUseId: string,
  toolInput: unknown,
  toolResponse: unknown,
): PostToolUseHookInput {
  return {
    hook_event_name: "PostToolUse",
    session_id: "s_1",
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp",
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    tool_use_id: toolUseId,
  };
}

function postToolUseFailure(
  toolName: string,
  toolUseId: string,
  toolInput: unknown,
  error: string,
  isInterrupt?: boolean,
): PostToolUseFailureHookInput {
  return {
    hook_event_name: "PostToolUseFailure",
    session_id: "s_1",
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    error,
    ...(isInterrupt !== undefined ? { is_interrupt: isInterrupt } : {}),
  };
}

const hookOpts = () => ({ signal: new AbortController().signal });

function asAllow(result: PermissionResult | null) {
  expect(result).not.toBeNull();
  if (result === null) throw new Error("expected a permission result");
  expect(result.behavior).toBe("allow");
  if (result.behavior !== "allow") throw new Error(`expected allow, got ${result.behavior}`);
  return result;
}

function asDeny(result: PermissionResult | null) {
  expect(result).not.toBeNull();
  if (result === null) throw new Error("expected a permission result");
  expect(result.behavior).toBe("deny");
  if (result.behavior !== "deny") throw new Error(`expected deny, got ${result.behavior}`);
  return result;
}

function openWait(opts?: { timeoutMs?: number; pollMs?: number }) {
  const dir = localDir(gatePolicy);
  const ledger = new Ledger({ mode: "local", dir });
  const gate = createToolGate({
    ledger,
    principal: "u_1",
    mode: "wait",
    timeoutMs: opts?.timeoutMs ?? 15_000,
    pollMs: opts?.pollMs ?? 20,
  });
  return { dir, ledger, gate };
}

async function runHook(adapter: ClaudeAgentAdapter, input: PostToolUseHookInput | PostToolUseFailureHookInput, id: string) {
  const matchers = input.hook_event_name === "PostToolUse" ? adapter.hooks.PostToolUse : adapter.hooks.PostToolUseFailure;
  const hook = matchers[0]?.hooks[0];
  if (!hook) throw new Error("missing hook");
  return hook(input, id, hookOpts());
}

describe("createClaudeAgentAdapter", () => {
  it("rejects a defer-mode gate", () => {
    const dir = localDir(gatePolicy);
    const ledger = new Ledger({ mode: "local", dir });
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
      expect(() => createClaudeAgentAdapter({ gate })).toThrow(TypeError);
      expect(() => createClaudeAgentAdapter({ gate })).toThrow(/wait-mode ToolGate/);
    } finally {
      ledger.close();
    }
  });

  it("exposes canUseTool, hooks, options, inFlight, abandon and no approve or reject", () => {
    const { ledger, gate } = openWait();
    try {
      const adapter = createClaudeAgentAdapter({ gate });
      expect(Object.keys(adapter).sort()).toEqual(["abandon", "canUseTool", "hooks", "inFlight", "options"]);
      expect("approve" in adapter).toBe(false);
      expect("reject" in adapter).toBe(false);
      const _c: CanUseTool = adapter.canUseTool;
      const _h: Options["hooks"] = adapter.hooks;
      expect(_c).toBe(adapter.canUseTool);
      expect(_h?.PostToolUse?.[0]?.hooks[0]).toBeTypeOf("function");
      expect(_h?.PostToolUseFailure?.[0]?.hooks[0]).toBeTypeOf("function");
      expect(adapter.inFlight).toBe(0);
    } finally {
      ledger.close();
    }
  });

  it("allow: auto-approved tool returns behavior allow with updatedInput from approvedPayload.args", async () => {
    const { ledger, gate } = openWait();
    try {
      const adapter = createClaudeAgentAdapter({ gate });
      const result = asAllow(await adapter.canUseTool("search", { q: "x" }, permissionOptions("tu_search")));
      expect(result.updatedInput).toEqual({ q: "x" });
      expect(adapter.inFlight).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("allow after human approval passes edited args as updatedInput", async () => {
    const { dir, ledger, gate } = openWait();
    try {
      const adapter = createClaudeAgentAdapter({ gate });
      const pending = adapter.canUseTool("send_email", { to: "a@b.c" }, permissionOptions("tu_edit"));
      const task = await findPending(dir);
      approve(dir, task, undefined, { action: "tool.send_email", args: { to: "b@c.d" } });
      const result = asAllow(await pending);
      expect(result.updatedInput).toEqual({ to: "b@c.d" });
    } finally {
      ledger.close();
    }
  });

  it("deny: policy deny returns behavior deny with task id and reason in message", async () => {
    const { ledger, gate } = openWait();
    try {
      const adapter = createClaudeAgentAdapter({ gate });
      const result = asDeny(await adapter.canUseTool("drop_table", {}, permissionOptions("tu_drop")));
      expect(result.message).toContain("tsk_");
      expect(result.message).toContain("policy_denied");
      expect(result.message).toContain("drop_table");
      expect(result.interrupt === undefined || result.interrupt === false).toBe(true);
      expect(adapter.inFlight).toBe(0);
    } finally {
      ledger.close();
    }
  });

  it("deny: human reject while waiting returns deny with reason rejected", async () => {
    const { dir, ledger, gate } = openWait();
    try {
      const adapter = createClaudeAgentAdapter({ gate });
      const pending = adapter.canUseTool("send_email", { to: "a@b.c" }, permissionOptions("tu_reject"));
      const task = await findPending(dir);
      reject(dir, task);
      const result = asDeny(await pending);
      expect(result.message).toContain("rejected");
      expect(result.message).toContain(task.id);
    } finally {
      ledger.close();
    }
  });

  it("deny: wait timeout returns deny with reason timeout", async () => {
    const { dir, ledger, gate } = openWait({ timeoutMs: 200, pollMs: 20 });
    try {
      const adapter = createClaudeAgentAdapter({ gate });
      const result = asDeny(await adapter.canUseTool("send_email", { to: "a@b.c" }, permissionOptions("tu_timeout")));
      expect(result.message).toContain("timeout");
      const task = listTasks(dir).find((item) => item.state === "pending_approval");
      expect(task?.state).toBe("pending_approval");
    } finally {
      ledger.close();
    }
  });

  it("deny: draft_only returns deny with reason drafted", async () => {
    const { ledger, gate } = openWait();
    try {
      const adapter = createClaudeAgentAdapter({ gate });
      const result = asDeny(await adapter.canUseTool("draft_post", {}, permissionOptions("tu_draft")));
      expect(result.message).toContain("drafted");
      expect(result.message).toContain("tsk_");
    } finally {
      ledger.close();
    }
  });

  it("interruptOnDeny sets interrupt: true", async () => {
    const { ledger, gate } = openWait();
    try {
      const adapter = createClaudeAgentAdapter({ gate, interruptOnDeny: true });
      const result = asDeny(await adapter.canUseTool("drop_table", {}, permissionOptions("tu_interrupt")));
      expect(result.interrupt).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("ledger error in before() fails closed with a deny and calls onError", async () => {
    const ledger = new Ledger({ transport: downTransport() });
    try {
      const gate = createToolGate({ ledger, principal: "u_1", mode: "wait" });
      const seen: Array<{ error: unknown; phase: string }> = [];
      const adapter = createClaudeAgentAdapter({
        gate,
        onError(error, context) {
          seen.push({ error, phase: context.phase });
          expect(context.toolName).toBe("search");
          expect(context.toolUseId).toBe("tu_down");
        },
      });
      const result = asDeny(await adapter.canUseTool("search", { q: "x" }, permissionOptions("tu_down")));
      expect(result.message).toContain("ledger error");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.phase).toBe("before");
      expect(seen[0]?.error).toBeInstanceOf(LedgerUnavailable);
      expect(adapter.inFlight).toBe(0);
    } finally {
      ledger.close();
    }
  });

  it("degraded read-only allow returns allow with the original input and tracks nothing", async () => {
    const ledger = new Ledger({ transport: downTransport(), onUnavailable: "allow_read_only" });
    try {
      const gate = createToolGate({
        ledger,
        principal: "u_1",
        mode: "wait",
        map: () => ({ action: "email.read", readOnly: true }),
      });
      const adapter = createClaudeAgentAdapter({ gate });
      const input = { folder: "inbox" };
      const result = asAllow(await adapter.canUseTool("read", input, permissionOptions("tu_degraded")));
      expect(result.updatedInput).toEqual(input);
      expect(adapter.inFlight).toBe(0);
    } finally {
      ledger.close();
    }
  });

  it("after(success): PostToolUse completes the task and returns {}", async () => {
    const { dir, ledger, gate } = openWait();
    try {
      const adapter = createClaudeAgentAdapter({ gate });
      await adapter.canUseTool("search", { q: "x" }, permissionOptions("tu_ok"));
      const output = await runHook(adapter, postToolUse("search", "tu_ok", { q: "x" }, { hits: 1 }), "tu_ok");
      expect(output).toEqual({});
      expect(adapter.inFlight).toBe(0);
      const task = listTasks(dir)[0];
      expect(task?.state).toBe("executed");
    } finally {
      ledger.close();
    }
  });

  it("after(error): PostToolUseFailure fails the task with code tool_error", async () => {
    const { dir, ledger, gate } = openWait();
    try {
      const adapter = createClaudeAgentAdapter({ gate });
      await adapter.canUseTool("search", { q: "x" }, permissionOptions("tu_fail"));
      const output = await runHook(
        adapter,
        postToolUseFailure("search", "tu_fail", { q: "x" }, "boom"),
        "tu_fail",
      );
      expect(output).toEqual({});
      expect(adapter.inFlight).toBe(0);
      const task = listTasks(dir)[0];
      expect(task?.state).toBe("failed");
      expect(task?.error?.code).toBe("tool_error");
    } finally {
      ledger.close();
    }
  });

  it("after(error): PostToolUseFailure with is_interrupt uses code interrupted", async () => {
    const { dir, ledger, gate } = openWait();
    try {
      const adapter = createClaudeAgentAdapter({ gate });
      await adapter.canUseTool("search", { q: "x" }, permissionOptions("tu_int"));
      await runHook(adapter, postToolUseFailure("search", "tu_int", { q: "x" }, "stopped", true), "tu_int");
      const task = listTasks(dir)[0];
      expect(task?.state).toBe("failed");
      expect(task?.error?.code).toBe("interrupted");
    } finally {
      ledger.close();
    }
  });

  it("after(error): PostToolUse with an isError MCP result fails the task", async () => {
    const { dir, ledger, gate } = openWait();
    try {
      const adapter = createClaudeAgentAdapter({ gate });
      await adapter.canUseTool("search", { q: "x" }, permissionOptions("tu_mcp"));
      const response = { isError: true, content: [{ type: "text", text: "nope" }] };
      await runHook(adapter, postToolUse("search", "tu_mcp", { q: "x" }, response), "tu_mcp");
      const task = listTasks(dir)[0];
      expect(task?.state).toBe("failed");
      expect(task?.error?.code).toBe("tool_error");
      const stored = await ledger.getTask(task?.id ?? "");
      expect(stored?.state).toBe("failed");
    } finally {
      ledger.close();
    }
  });

  it("PostToolUse for an untracked tool_use_id is a no-op and calls onUntracked", async () => {
    const { ledger, gate } = openWait();
    try {
      const seen: Array<{ toolName: string; toolUseId: string | undefined }> = [];
      const adapter = createClaudeAgentAdapter({
        gate,
        onUntracked(toolName, toolUseId) {
          seen.push({ toolName, toolUseId });
        },
      });
      const output = await runHook(adapter, postToolUse("Read", "tu_free", {}, "ok"), "tu_free");
      expect(output).toEqual({});
      expect(seen).toEqual([{ toolName: "Read", toolUseId: "tu_free" }]);
      expect(adapter.inFlight).toBe(0);
    } finally {
      ledger.close();
    }
  });

  it("after() ContentMismatch goes to onError when set and is rethrown when not", async () => {
    const { dir, ledger, gate } = openWait();
    try {
      const mismatch = () => ({ action: "tool.search", args: { q: "other" } }) satisfies Payload;
      const seen: unknown[] = [];
      const handled = createClaudeAgentAdapter({
        gate,
        executedPayload: mismatch,
        onError(error, context) {
          seen.push(error);
          expect(context.phase).toBe("after");
        },
      });
      await handled.canUseTool("search", { q: "x" }, permissionOptions("tu_mm1"));
      const output = await runHook(handled, postToolUse("search", "tu_mm1", { q: "x" }, { hits: 1 }), "tu_mm1");
      expect(output).toEqual({});
      expect(seen[0]).toBeInstanceOf(ContentMismatch);
      expect(listTasks(dir).some((task) => task.state === "failed" && task.error?.code === "content_mismatch")).toBe(true);

      const bare = createClaudeAgentAdapter({ gate, executedPayload: mismatch });
      await bare.canUseTool("search", { q: "y" }, permissionOptions("tu_mm2"));
      await expect(runHook(bare, postToolUse("search", "tu_mm2", { q: "y" }, { hits: 1 }), "tu_mm2")).rejects.toBeInstanceOf(
        ContentMismatch,
      );
    } finally {
      ledger.close();
    }
  });

  it("abort before decision returns deny and later fails the claimed run", async () => {
    const { dir, ledger, gate } = openWait();
    try {
      const adapter = createClaudeAgentAdapter({ gate });
      const controller = new AbortController();
      const pending = adapter.canUseTool(
        "send_email",
        { to: "a@b.c" },
        permissionOptions("tu_abort", controller.signal),
      );
      const task = await findPending(dir);
      controller.abort();
      const result = asDeny(await pending);
      expect(result.message).toContain("aborted");
      approve(dir, task);
      const start = Date.now();
      let failed = false;
      while (Date.now() - start < 8_000) {
        const stored = await ledger.getTask(task.id);
        if (stored?.state === "failed" && adapter.inFlight === 0) {
          expect(stored.data.error?.code).toBe("aborted");
          failed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(failed).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("abandon fails every in-flight run with code abandoned", async () => {
    const { dir, ledger, gate } = openWait();
    try {
      const adapter = createClaudeAgentAdapter({ gate });
      await adapter.canUseTool("search", { q: "a" }, permissionOptions("tu_a"));
      await adapter.canUseTool("search", { q: "b" }, permissionOptions("tu_b"));
      expect(adapter.inFlight).toBe(2);
      await adapter.abandon();
      expect(adapter.inFlight).toBe(0);
      const tasks = listTasks(dir);
      expect(tasks).toHaveLength(2);
      expect(tasks.every((task) => task.state === "failed" && task.error?.code === "abandoned")).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("options() merges hooks and refuses an existing canUseTool or permissionPromptToolName", () => {
    const { ledger, gate } = openWait();
    try {
      const adapter = createClaudeAgentAdapter({ gate });
      const userHook: HookCallback = async () => ({});
      const merged = adapter.options({
        maxTurns: 2,
        hooks: { PostToolUse: [{ hooks: [userHook] }] },
      });
      expect(merged.canUseTool).toBe(adapter.canUseTool);
      expect(merged.maxTurns).toBe(2);
      expect(merged.hooks?.PostToolUse).toHaveLength(2);
      expect(merged.hooks?.PostToolUse?.[0]?.hooks[0]).toBe(userHook);
      expect(merged.hooks?.PostToolUse?.[1]).toBe(adapter.hooks.PostToolUse[0]);
      expect(merged.hooks?.PostToolUseFailure).toHaveLength(1);
      const other: CanUseTool = async () => ({ behavior: "deny", message: "no" });
      expect(() => adapter.options({ canUseTool: other })).toThrow(/canUseTool/);
      expect(() => adapter.options({ permissionPromptToolName: "Ask" })).toThrow(/permissionPromptToolName/);
    } finally {
      ledger.close();
    }
  });

  it("denyMessage includes tool name, reason and task id", () => {
    const denied: ToolGateDeny = {
      kind: "deny",
      taskId: "tsk_1",
      reason: "policy_denied",
      message: "task tsk_1 was rejected",
      state: "rejected",
      cause: new LedgerError("invalid_transition", "task tsk_1 was rejected", 409),
    };
    const text = denyMessage("drop_table", denied);
    expect(text).toContain("drop_table");
    expect(text).toContain("policy_denied");
    expect(text).toContain("tsk_1");
    expect(text).toContain("Tell the user this action was not performed.");
    const pending: ToolGatePending = {
      kind: "pending",
      taskId: "tsk_2",
      approveHint: "Task tsk_2 is waiting for approval. Approve: actledger approve tsk_2",
    };
    const hint = denyMessage("send_email", pending);
    expect(hint).toContain("pending");
    expect(hint).toContain("tsk_2");
    expect(hint).toContain(pending.approveHint);
  });
});
