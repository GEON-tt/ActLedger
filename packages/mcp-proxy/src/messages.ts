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
    `已提交审批 ${taskId}，批准后用 ${checkTaskTool} 查询。动作 ${action} 尚未执行。`,
    false,
    { id: taskId, state: "pending_approval" },
  );
}

export function stillPending(taskId: string, checkTaskTool: string): CallToolResult {
  return textResult(
    `任务 ${taskId} 仍在等待审批，尚未执行。批准后再次调用 ${checkTaskTool}。`,
    false,
    { id: taskId, state: "pending_approval" },
  );
}

export function humanRejected(taskId: string, action: string): CallToolResult {
  return textResult(
    `审批被拒绝：${taskId}，动作 ${action} 未执行。不要重试同一动作，除非用户另有指示。`,
    true,
    { id: taskId, state: "rejected" },
  );
}

export function policyDenied(taskId: string, ruleId: string): CallToolResult {
  return textResult(`策略禁止该动作：${taskId}（规则 ${ruleId}），未执行。`, true, {
    id: taskId,
    state: "rejected",
  });
}

export function draftedOnly(taskId: string): CallToolResult {
  return textResult(`策略只允许生成草稿：${taskId}，未执行。`, true, { id: taskId, state: "drafted" });
}

export function expiredTask(taskId: string): CallToolResult {
  return textResult(`任务 ${taskId} 已过期，未执行。`, true, { id: taskId, state: "expired" });
}

export function revokedTask(taskId: string): CallToolResult {
  return textResult(`任务 ${taskId} 已被撤回，未执行。`, true, { id: taskId, state: "revoked" });
}

export function upstreamToolError(taskId: string, upstream: CallToolResult): CallToolResult {
  return withTask(
    {
      ...upstream,
      isError: true,
      content: [textBlock(`上游工具返回错误，任务 ${taskId} 记为 failed。`), ...upstream.content],
    },
    { id: taskId, state: "failed" },
  );
}

export function upstreamRpcError(taskId: string, message: string): CallToolResult {
  return textResult(`上游调用失败：${message}。任务 ${taskId} 记为 failed。`, true, {
    id: taskId,
    state: "failed",
  });
}

export function executionUnknown(taskId: string): CallToolResult {
  return textResult(
    `执行超时：${taskId} 结果未知（unknown），可能已经执行。不要重试，需人工对账。`,
    true,
    { id: taskId, state: "executing" },
  );
}

export function upstreamDisconnected(taskId: string): CallToolResult {
  return textResult(
    `上游连接中断：${taskId} 结果未知，执行期限到后记为 unknown。不要重试，需人工对账。`,
    true,
    { id: taskId, state: "executing" },
  );
}

export function upstreamUnavailable(): CallToolResult {
  return textResult("上游 MCP 服务器不可用，未提交动作。", true);
}

export function approvedButUnavailable(taskId: string, checkTaskTool: string): CallToolResult {
  return textResult(
    `任务 ${taskId} 已批准，但上游不可用，暂未执行；可稍后再次 ${checkTaskTool}（认领期限前有效）。`,
    true,
    { id: taskId, state: "approved" },
  );
}

export function ledgerUnavailable(): CallToolResult {
  return textResult("账本不可用，按 deny 处理，未执行。", true);
}

export function alreadyExecuted(taskId: string, state: string): CallToolResult {
  return textResult(`任务 ${taskId} 已执行（${state}），结果已在首次执行时返回。`, false, {
    id: taskId,
    state,
  });
}

export function alreadyClaimed(taskId: string, checkTaskTool: string, state: string): CallToolResult {
  return textResult(`任务 ${taskId} 正在执行或已执行，请稍后用 ${checkTaskTool} 查询。`, false, {
    id: taskId,
    state,
  });
}

export function contentMismatch(taskId: string): CallToolResult {
  return textResult(`执行内容与批准不一致，${taskId} 记为 failed`, true, { id: taskId, state: "failed" });
}

export function unknownTool(name: string): CallToolResult {
  return textResult(`未知工具 ${name}`, true);
}

export function wrongProxy(): CallToolResult {
  return textResult("任务不属于此代理", true);
}

export function inconsistentTool(taskId: string, state: string): CallToolResult {
  return textResult(`任务 ${taskId} 的工具与已批准动作不一致，未执行。`, true, { id: taskId, state });
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
