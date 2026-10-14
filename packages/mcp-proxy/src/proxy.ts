import fs from "node:fs";
import path from "node:path";
import { LedgerError, loadPolicy, type CoverageEntry } from "@actledger/core";
import {
  ApprovalExpired,
  ApprovalRejected,
  ApprovalRevoked,
  Ledger,
  LedgerUnavailable,
  type TaskHandle,
} from "@actledger/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedConfig } from "./config.js";
import { executeApproved } from "./executor.js";
import * as messages from "./messages.js";
import { fingerprint, toolCallToRequest } from "./payload.js";
import { Upstream } from "./upstream.js";

const RISKY_TOOL = ["shell", "exec", "http", "fetch", "browser"];

export interface ProxyOptions {
  config: ResolvedConfig;
  now?: () => Date;
  upstreamFactory?: (cfg: ResolvedConfig) => Upstream;
}

export async function createProxy(opts: ProxyOptions): Promise<{
  server: Server;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}> {
  const cfg = opts.config;
  const now = opts.now ?? (() => new Date());
  const ledger = new Ledger({ mode: "local", dir: cfg.ledger, now });
  let upstream: Upstream | undefined;
  try {
    const byFingerprint = new Map<string, string>();
    const sessions = new Map<string, { toolName: string; result?: CallToolResult }>();
    let refresh = async (_notify: boolean): Promise<void> => undefined;
    upstream = opts.upstreamFactory
      ? opts.upstreamFactory(cfg)
      : new Upstream({
          command: cfg.upstream.command,
          args: cfg.upstream.args,
          cwd: cfg.upstream.cwd,
          envPassthrough: cfg.upstream.envPassthrough,
          onToolsChanged: () => {
            void refresh(true);
          },
        });
    const server = new Server(
      { name: "actledger-mcp-proxy", version: "0.1.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    const current = upstream;
    await current.connect();
    await current.listTools();

    const exposed = (): Tool[] => {
      const tools = current.cachedTools().filter((tool) => cfg.unmapped !== "hide" || Boolean(cfg.tools[tool.name]));
      return tools.map((tool) => {
        if (!tool.outputSchema) return tool;
        const copy: Tool = { ...tool };
        delete copy.outputSchema;
        return copy;
      });
    };

    const overlayFor = (): CoverageEntry[] => {
      const actions = [
        ...new Set(exposed().map((tool) => cfg.tools[tool.name]?.action ?? tool.name)),
      ].sort();
      return actions.map((action) => ({ action, mode: "enforced" as const, via: "mcp-proxy" }));
    };

    const declareOverlay = () => {
      ledger.setCoverageOverlay(overlayFor());
    };

    const warnCoverage = () => {
      const policy = loadPolicy(fs.readFileSync(path.join(cfg.ledger, "policy.yaml"), "utf8"));
      const known = new Set(Object.keys(policy.doc.actions ?? {}));
      for (const entry of overlayFor()) {
        if (!known.has(entry.action)) {
          process.stderr.write(
            `warning: action ${entry.action} is not in policy actions; defaults.unknown_action will apply\n`,
          );
        }
      }
      for (const tool of current.cachedTools()) {
        const lower = tool.name.toLowerCase();
        if (RISKY_TOOL.some((word) => lower.includes(word))) {
          process.stderr.write(
            `warning: tool ${tool.name} matches shell/exec/http/fetch/browser and can bypass this proxy\n`,
          );
        }
      }
    };

    declareOverlay();
    warnCoverage();
    if (current.cachedTools().some((tool) => tool.name === cfg.checkTaskTool)) {
      throw new LedgerError("invalid_request", `upstream tool conflicts with ${cfg.checkTaskTool}`, 400);
    }

    let refreshing = false;
    refresh = async (notify: boolean) => {
      if (refreshing || !current.alive) return;
      refreshing = true;
      try {
        await current.listTools();
        declareOverlay();
        if (current.cachedTools().some((tool) => tool.name === cfg.checkTaskTool)) {
          process.stderr.write(`warning: upstream tool conflicts with ${cfg.checkTaskTool}\n`);
        }
        if (notify) {
          try {
            await server.sendToolListChanged();
          } catch {
            // The downstream client is not connected yet.
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "tool refresh failed";
        process.stderr.write(`warning: tool refresh failed: ${message}\n`);
      } finally {
        refreshing = false;
      }
    };

    const forget = (taskId: string) => {
      for (const [key, id] of byFingerprint) {
        if (id === taskId) byFingerprint.delete(key);
      }
    };

    const visible = (name: string): boolean => {
      const found = current.cachedTools().some((tool) => tool.name === name);
      if (!found) return false;
      if (cfg.unmapped === "hide" && !cfg.tools[name]) return false;
      return true;
    };

    const runApproved = async (handle: TaskHandle, toolName: string): Promise<CallToolResult> => {
      const result = await executeApproved(
        {
          ledger,
          upstream: current,
          cfg,
          now: () => now().getTime(),
          onExecuting: () => forget(handle.id),
        },
        handle,
        toolName,
      );
      sessions.set(handle.id, { toolName, result });
      return result;
    };

    const terminalResult = (handle: TaskHandle): CallToolResult => {
      const id = handle.id;
      const action = handle.data.action.type;
      forget(id);
      if (handle.state === "rejected") {
        return handle.data.decision.result === "deny"
          ? messages.policyDenied(id, handle.data.decision.ruleId)
          : messages.humanRejected(id, action);
      }
      if (handle.state === "drafted") return messages.draftedOnly(id);
      if (handle.state === "expired") return messages.expiredTask(id);
      if (handle.state === "revoked") return messages.revokedTask(id);
      if (handle.state === "unknown") return messages.executionUnknown(id);
      if (handle.state === "failed") {
        const cached = sessions.get(id)?.result;
        if (cached) return cached;
        if (handle.data.error?.code === "upstream_rpc_error") {
          return messages.upstreamRpcError(id, "upstream call failed");
        }
        return messages.textResult(`上游工具返回错误，任务 ${id} 记为 failed。`, true, { id, state: "failed" });
      }
      if (handle.state === "executed") {
        return sessions.get(id)?.result ?? messages.alreadyExecuted(id, handle.state);
      }
      if (handle.state === "executing") return messages.alreadyClaimed(id, cfg.checkTaskTool, handle.state);
      return messages.textResult(`任务 ${id} 状态为 ${handle.state}，未执行。`, true, { id, state: handle.state });
    };

    const handleCheckTask = async (taskId: string): Promise<CallToolResult> => {
      if (!taskId.startsWith("tsk_")) return messages.textResult("task_id 必须以 tsk_ 开头", true);
      ledger.sweep();
      const handle = await ledger.getTask(taskId);
      if (!handle) return messages.textResult(`未知任务 ${taskId}`, true);
      if (handle.data.action.attrs.mcp_server !== cfg.name) return messages.wrongProxy();
      if (handle.state === "pending_approval") return messages.stillPending(handle.id, cfg.checkTaskTool);
      if (handle.state === "approved") {
        const toolName = handle.data.action.attrs.mcp_tool;
        if (typeof toolName !== "string" || !toolName) {
          return messages.textResult(`任务 ${handle.id} 缺少工具名，未执行。`, true, {
            id: handle.id,
            state: handle.state,
          });
        }
        return runApproved(handle, toolName);
      }
      return terminalResult(handle);
    };

    const rememberPending = (handle: TaskHandle, toolName: string, fp: string) => {
      byFingerprint.set(fp, handle.id);
      sessions.set(handle.id, { toolName });
      return messages.submitted(handle.id, handle.data.action.type, cfg.checkTaskTool);
    };

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          ...exposed(),
          {
            name: cfg.checkTaskTool,
            description: "查询 ActLedger 审批任务；已批准时执行原动作并返回结果。",
            inputSchema: {
              type: "object" as const,
              properties: { task_id: { type: "string", pattern: "^tsk_" } },
              required: ["task_id"],
            },
            annotations: { readOnlyHint: false },
          },
        ],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const name = request.params.name;
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        if (name === cfg.checkTaskTool) {
          const taskId = args.task_id;
          if (typeof taskId !== "string") return messages.textResult("task_id 必须以 tsk_ 开头", true);
          return handleCheckTask(taskId);
        }
        if (!visible(name)) {
          await refresh(true);
          if (!visible(name)) return messages.unknownTool(name);
        }
        if (!current.alive) return messages.upstreamUnavailable();
        let fp: string;
        try {
          fp = fingerprint(cfg.name, name, args);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid arguments";
          return messages.textResult(message, true);
        }
        const existing = byFingerprint.get(fp);
        if (existing) return handleCheckTask(existing);
        let requested: Omit<Parameters<Ledger["request"]>[0], "readOnly">;
        try {
          requested = toolCallToRequest(cfg, name, args);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid tool arguments";
          return messages.textResult(message, true);
        }
        const handle = await ledger.request({ ...requested, readOnly: false });
        if (handle.state === "approved") return runApproved(handle, name);
        if (handle.state !== "pending_approval") return terminalResult(handle);
        try {
          const done = await handle.wait({ timeoutMs: cfg.approval.waitMs, pollMs: 100 });
          if (done.state === "approved") return runApproved(done, name);
          if (done.state === "pending_approval") return rememberPending(done, name, fp);
          return terminalResult(done);
        } catch (error) {
          if (error instanceof ApprovalExpired && error.task?.state === "pending_approval") {
            return rememberPending(error.task, name, fp);
          }
          if (error instanceof ApprovalRejected) return terminalResult(error.task);
          if (error instanceof ApprovalRevoked) return terminalResult(error.task);
          if (error instanceof ApprovalExpired && error.task) return terminalResult(error.task);
          if (error instanceof ApprovalExpired) return messages.expiredTask(handle.id);
          throw error;
        }
      } catch (error) {
        if (error instanceof LedgerUnavailable) return messages.ledgerUnavailable();
        throw error;
      }
    });

    let closed = false;
    return {
      server,
      async connect(transport: Transport) {
        await server.connect(transport);
      },
      async close() {
        if (closed) return;
        closed = true;
        await current.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        ledger.close();
      },
    };
  } catch (error) {
    await upstream?.close().catch(() => undefined);
    ledger.close();
    throw error;
  }
}
