import { LedgerError, openLedger, type Payload } from "@actledger/core";
import { ContentMismatch, Ledger, type TaskHandle } from "@actledger/sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedConfig } from "./config.js";
import * as messages from "./messages.js";
import { canExecuteTool, mappingFor, payloadToArguments } from "./payload.js";
import type { Upstream } from "./upstream.js";

function proofsOf(result: CallToolResult): Array<{ type: string; value: unknown }> | undefined {
  const raw = result.structuredContent?._proofs;
  if (!Array.isArray(raw)) return undefined;
  const proofs: Array<{ type: string; value: unknown }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as { type?: unknown; value?: unknown };
    if (typeof record.type !== "string" || !("value" in record)) continue;
    proofs.push({ type: record.type, value: record.value });
  }
  return proofs.length > 0 ? proofs : undefined;
}

function scheduleSweep(ledger: Ledger, deadline: string): void {
  const delay = Math.max(0, Date.parse(deadline) + 50 - Date.now());
  const timer = setTimeout(() => {
    try {
      ledger.sweep();
    } catch {
      // The execution deadline sweep is best-effort. The next check_task sweeps again.
    }
  }, delay);
  timer.unref();
}

function readApprovedPayload(dir: string, taskId: string): Payload {
  const engine = openLedger({ dir });
  try {
    return engine.taskPayload(taskId);
  } finally {
    engine.close();
  }
}

export async function executeApproved(
  deps: {
    ledger: Ledger;
    upstream: Upstream;
    cfg: ResolvedConfig;
    now: () => number;
    onExecuting?: (taskId: string) => void;
  },
  handle: TaskHandle,
  toolName: string,
): Promise<CallToolResult> {
  const approved = readApprovedPayload(deps.cfg.ledger, handle.id);
  const toolNames = new Set(deps.upstream.cachedTools().map((tool) => tool.name));
  if (
    !canExecuteTool(
      deps.cfg,
      toolName,
      { actionType: handle.data.action.type, agentId: handle.data.agentId },
      approved,
      toolNames,
    )
  ) {
    return messages.inconsistentTool(handle.id, handle.state);
  }
  if (!deps.upstream.alive) return messages.approvedButUnavailable(handle.id, deps.cfg.checkTaskTool);
  deps.onExecuting?.(handle.id);
  let run;
  try {
    run = await handle.claim();
  } catch (error) {
    if (error instanceof LedgerError && error.code === "already_claimed") {
      return messages.alreadyClaimed(handle.id, deps.cfg.checkTaskTool, "executing");
    }
    if (error instanceof LedgerError && error.code === "task_expired") return messages.expiredTask(handle.id);
    throw error;
  }
  const mapping = mappingFor(deps.cfg, toolName) ?? { action: toolName };
  const args = payloadToArguments(mapping, run.approvedPayload);
  const timeoutMs = Math.max(1, Date.parse(run.executionDeadline) - deps.now());
  const outcome = await deps.upstream.callTool(toolName, args, timeoutMs);
  if (outcome.kind === "timeout" || outcome.kind === "unverified") {
    scheduleSweep(deps.ledger, run.executionDeadline);
    return messages.executionUnknown(handle.id);
  }
  if (outcome.kind === "disconnected") {
    scheduleSweep(deps.ledger, run.executionDeadline);
    return messages.upstreamDisconnected(handle.id);
  }
  try {
    if (outcome.kind === "tool_error") {
      await run.fail({ error: { code: "upstream_tool_error", message: messages.firstText(outcome.result) } });
      return messages.upstreamToolError(handle.id, outcome.result);
    }
    if (outcome.kind === "rpc_error") {
      await run.fail({ error: { code: "upstream_rpc_error", message: messages.clip(outcome.message) } });
      return messages.upstreamRpcError(handle.id, messages.clip(outcome.message));
    }
    const externalProofs = proofsOf(outcome.result);
    await run.complete({
      executedPayload: run.approvedPayload satisfies Payload,
      ...(externalProofs ? { externalProofs } : {}),
    });
    return messages.succeeded(outcome.result, handle.id);
  } catch (error) {
    if (error instanceof ContentMismatch) return messages.contentMismatch(handle.id);
    throw error;
  }
}
