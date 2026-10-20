import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const TASK_ID = "actledger/task_id";
export const TASK_STATE = "actledger/state";

type TaskRef = { id: string; state: string };

function textBlock(text: string): CallToolResult["content"][number] {
  return { type: "text", text };
}

export function textResult(text: string, isError: boolean, task?: TaskRef): CallToolResult {
  const result: CallToolResult = {
    content: [textBlock(text)],
    isError,
  };
  if (task) result._meta = { [TASK_ID]: task.id, [TASK_STATE]: task.state };
  return result;
}

export function withTask(result: CallToolResult, task: TaskRef): CallToolResult {
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), [TASK_ID]: task.id, [TASK_STATE]: task.state },
  };
}

export function submitted(taskId: string, action: string, checkTaskTool: string): CallToolResult {
  return textResult(
    `Submitted for approval as task ${taskId}. The action ${action} has not run. After a person approves it, call ${checkTaskTool} with task_id ${taskId}.`,
    false,
    { id: taskId, state: "pending_approval" },
  );
}

export function stillPending(taskId: string, checkTaskTool: string): CallToolResult {
  return textResult(
    `Task ${taskId} is still waiting for approval and has not run. Call ${checkTaskTool} again after it is approved.`,
    false,
    { id: taskId, state: "pending_approval" },
  );
}

export function humanRejected(taskId: string, action: string): CallToolResult {
  return textResult(
    `Approval was rejected for task ${taskId}. The action ${action} was not executed. Do not retry the same action unless the user asks you to.`,
    true,
    { id: taskId, state: "rejected" },
  );
}

export function policyDenied(taskId: string, ruleId: string): CallToolResult {
  return textResult(`Policy denies this action (task ${taskId}, rule ${ruleId}). It was not executed.`, true, {
    id: taskId,
    state: "rejected",
  });
}

export function draftedOnly(taskId: string): CallToolResult {
  return textResult(`Policy only allows a draft for this action (task ${taskId}). It was not executed.`, true, { id: taskId, state: "drafted" });
}

export function expiredTask(taskId: string): CallToolResult {
  return textResult(`Task ${taskId} expired. It was not executed.`, true, { id: taskId, state: "expired" });
}

export function revokedTask(taskId: string): CallToolResult {
  return textResult(`Task ${taskId} was revoked. It was not executed.`, true, { id: taskId, state: "revoked" });
}

export function upstreamToolError(taskId: string, upstream: CallToolResult): CallToolResult {
  return withTask(
    {
      ...upstream,
      isError: true,
      content: [textBlock(`The upstream tool returned an error. Task ${taskId} is recorded as failed.`), ...upstream.content],
    },
    { id: taskId, state: "failed" },
  );
}

export function upstreamRpcError(taskId: string, message: string): CallToolResult {
  return textResult(`The upstream call failed: ${message}. Task ${taskId} is recorded as failed.`, true, {
    id: taskId,
    state: "failed",
  });
}

export function executionUnknown(taskId: string): CallToolResult {
  return textResult(
    `Execution timed out for task ${taskId}. The outcome is unknown and the action may have run. Do not retry; a person needs to reconcile it.`,
    true,
    { id: taskId, state: "executing" },
  );
}

export function upstreamDisconnected(taskId: string): CallToolResult {
  return textResult(
    `The upstream connection dropped during task ${taskId}. The outcome is unknown; the task becomes unknown when its execution deadline passes. Do not retry; a person needs to reconcile it.`,
    true,
    { id: taskId, state: "executing" },
  );
}

export function upstreamUnavailable(): CallToolResult {
  return textResult("The upstream MCP server is unavailable. No action was submitted.", true);
}

export function approvedButUnavailable(taskId: string, checkTaskTool: string): CallToolResult {
  return textResult(
    `Task ${taskId} is approved, but the upstream server is unavailable, so it has not run. Call ${checkTaskTool} again later, before the claim deadline.`,
    true,
    { id: taskId, state: "approved" },
  );
}

export function ledgerUnavailable(): CallToolResult {
  return textResult("The ledger is unavailable, so the call is treated as denied. It was not executed.", true);
}

export function alreadyExecuted(taskId: string, state: string): CallToolResult {
  return textResult(`Task ${taskId} already ran (${state}). Its result was returned the first time.`, false, {
    id: taskId,
    state,
  });
}

export function alreadyClaimed(taskId: string, checkTaskTool: string, state: string): CallToolResult {
  return textResult(`Task ${taskId} is running or has already run. Call ${checkTaskTool} again later.`, false, {
    id: taskId,
    state,
  });
}

export function contentMismatch(taskId: string): CallToolResult {
  return textResult(`The executed content does not match what was approved. Task ${taskId} is recorded as failed.`, true, { id: taskId, state: "failed" });
}

export function unknownTool(name: string): CallToolResult {
  return textResult(`Unknown tool ${name}.`, true);
}

export function wrongProxy(): CallToolResult {
  return textResult("This task does not belong to this proxy.", true);
}

export function inconsistentTool(taskId: string, state: string): CallToolResult {
  return textResult(`The tool for task ${taskId} does not match the approved action. It was not executed.`, true, { id: taskId, state });
}

export function succeeded(upstream: CallToolResult, taskId: string): CallToolResult {
  return withTask({ ...upstream, isError: false }, { id: taskId, state: "executed" });
}

export function clip(message: string): string {
  return message.slice(0, 500);
}

export function firstText(result: CallToolResult): string {
  for (const block of result.content) {
    if (block.type === "text" && "text" in block && typeof block.text === "string") return clip(block.text);
  }
  return "upstream tool error";
}
