[English](../../en/scenarios/openai-agents.md) | [简体中文](openai-agents.md)

# OpenAI Agents SDK

## 放在哪里

`@actledger/openai-agents` 是**记录式**接入（[保证边界](../guarantees.md)）。它使用 defer 模式的 ToolGate。`needsApproval` 询问账本，pending 任务变成 SDK 的原生 interruption，`resolveInterruptions` 读账本并在 SDK 状态里批准或拒绝这次中断，包装后的 `execute` 在工具运行前一刻认领任务，然后完成或失败。没有包住的工具，以及来自 `mcpServers` 的工具，不会进入账本。

## 最小代码

取自 [`examples/chat-approval/providers/openai.ts`](../../../examples/chat-approval/providers/openai.ts) 和 [`examples/openai-agents/run.ts`](../../../examples/openai-agents/run.ts)。

```ts
import { Agent, run, setTracingDisabled } from "@openai/agents";
import { createOpenAIAgentsLedger, ledgerTool, resolveInterruptions } from "@actledger/openai-agents";
import { createToolGate, Ledger } from "@actledger/sdk";
import { z } from "zod";

setTracingDisabled(true);
const ledger = new Ledger({ mode: "local", dir: ".actledger" });
const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
const binding = createOpenAIAgentsLedger({ gate, ledger });

const agent = new Agent({
  name: "notes",
  instructions: "You send notes only by calling send_note.",
  tools: [
    ledgerTool(
      {
        name: "send_note",
        description: "Send a note to the team",
        parameters: z.object({ text: z.string() }),
        execute: async ({ text }) => `sent: ${text}`,
      },
      binding,
    ),
  ],
});

try {
  let result = await run(agent, "Send a note: standup moved to 3pm", { maxTurns: 6 });
  const deadline = Date.now() + 15 * 60_000;
  while (result.interruptions.length > 0) {
    const resolved = await resolveInterruptions(result, binding);
    if (resolved.pending.length > 0) {
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    result = await run(agent, result.state, { maxTurns: 6 });
  }
  console.log(result.finalOutput);
} finally {
  await binding.abandon();
  ledger.close();
}
```

适配器只接受 defer 模式。等待由你的循环来做：上面的例子每秒试一次，最多 15 分钟，和 demo 相同。`resolved.pending[i].approveHint` 里含有 `actledger approve <id>`。

不传 `model` 时使用 SDK 的默认模型。demo 会读取可选的 `OPENAI_DEFAULT_MODEL`。

把 `binding.abandon()` 放在 `finally` 里。

`examples/openai-agents` 需要 `OPENAI_API_KEY`。没有 key 时，脚本打印跳过说明并以 0 退出。不需要 key 的证明是 `pnpm exec vitest run packages/openai-agents/test/adapter.test.ts`。demo 使用 `ACTLEDGER_DEMO_PROVIDER=openai`。

包装已有工具（`withLedger` 或 `withLedgerAgent`）、在另一个进程里恢复，以及 Python 版适配器，见[框架集成](../integrations.md#openai-agents-sdk)。

## 策略

`actledger init` 会把默认策略写到 `.actledger/policy.yaml`（[源码](../../../packages/core/src/default-policy.ts)）。不改这个文件时，经过闸门的工具调用是 `tool.<name>`，它不在 `actions` 里，没有规则匹配，于是走 `defaults.unknown_action: require_approval`：任务等待批准（rule id `default:require_approval`），保证等级 `app_asserted`，可以从 `cli` 或 `web` 批。请在这个文件上改，不要另写一份。策略文件整份生效；`defaults` 里省略的键回落到引擎值，其中 `approval.channels` 的回落值是空列表，也就是只有 CLI。

把这个工具加在已有的 `actions:` 键下面：

```yaml
actions:
  # existing entries stay
  tool.send_note:
    level: write
```

`level` 设成 `send`、`spend` 或 `delete` 会把最低保证抬到 `channel_verified`（[evaluate.ts](../../../packages/core/src/policy/evaluate.ts)）。`examples/openai-agents/policy.yaml` 把 `tool.send_email` 声明为 `level: send`，所以那个示例需要 `channel_verified`。审批台上的 Approve 是禁用的。CLI 要加 `--assurance channel_verified`（回执标为 simulated），或者在审批台写理由拒绝。

## 下一步

- [OpenAI Agents SDK](../integrations.md#openai-agents-sdk)
- [examples/openai-agents](../../../examples/openai-agents/README.zh-CN.md)
- [审批台](approval-console.md)
