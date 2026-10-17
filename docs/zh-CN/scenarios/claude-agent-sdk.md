[English](../../en/scenarios/claude-agent-sdk.md) | [简体中文](claude-agent-sdk.md)

# Claude Agent SDK

## 放在哪里

`@actledger/claude-agent-sdk` 是**记录式**接入（[保证边界](../guarantees.md)）。它把 wait 模式的 ToolGate 挂成 `canUseTool`，在 `PostToolUse` 里完成任务，在 `PostToolUseFailure` 里把任务标成失败。列在 `allowedTools` 里的工具，或被 `bypassPermissions` 放行的工具，不会进入 `canUseTool`，也不在账本里。闸门必须是 wait 模式；defer 会抛错。

## 最小代码

取自 [`examples/chat-approval/providers/claude.ts`](../../../examples/chat-approval/providers/claude.ts) 和 [`examples/claude-agent/run.ts`](../../../examples/claude-agent/run.ts)。

```ts
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeAgentAdapter } from "@actledger/claude-agent-sdk";
import { createToolGate, Ledger } from "@actledger/sdk";
import { z } from "zod";

const ledger = new Ledger({ mode: "local", dir: ".actledger" });
const gate = createToolGate({ ledger, principal: "u_1", mode: "wait", timeoutMs: 15 * 60_000 });
const adapter = createClaudeAgentAdapter({ gate });

const server = createSdkMcpServer({
  name: "notes",
  tools: [
    tool("send_note", "Send a note to the team", { text: z.string() }, async ({ text }) => ({
      content: [{ type: "text" as const, text: `sent: ${text}` }],
    })),
  ],
});

try {
  for await (const message of query({
    prompt: "Send a note: standup moved to 3pm",
    options: adapter.options({
      tools: [],
      mcpServers: { notes: server },
      strictMcpConfig: true,
      settingSources: [],
      maxTurns: 6,
      permissionMode: "default",
    }),
  })) {
    if (message.type === "result") console.log(message.subtype);
  }
} finally {
  await adapter.abandon();
  ledger.close();
}
```

工具函数体里不要再调用闸门或 `callTool`。适配器已经在 `canUseTool` 里开了任务，再调一次会开第二个任务。

没有 `map` 时，action type 是 `tool.mcp__<server>__<tool>`。上面的例子是 `tool.mcp__notes__send_note`。demo 用 `noteMapping` 去掉了这个前缀。

`adapter.options()` 合并进你已经传入的 options。已经设置了 `canUseTool` 或 `permissionPromptToolName` 时会抛错。

`adapter.abandon()` 把仍在等 post 钩子的 run 以 `abandoned` 失败掉，所以放在 `finally` 里。

`examples/claude-agent` 需要 `ANTHROPIC_API_KEY`。没有 key 时，脚本打印跳过说明并以 0 退出。不需要 key 的证明是 `pnpm exec vitest run packages/claude-agent-sdk/test/adapter.test.ts`。demo 使用 `ACTLEDGER_DEMO_PROVIDER=claude`，并接受 `ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN` 或 `ACTLEDGER_DEMO_CLAUDE_LOGIN=1`。

Python 版适配器见[框架集成](../integrations.md#claude-agent-sdk)。

## 策略

`actledger init` 会把默认策略写到 `.actledger/policy.yaml`（[源码](../../../packages/core/src/default-policy.ts)）。不改这个文件时，经过闸门的工具调用是 `tool.<name>`，它不在 `actions` 里，没有规则匹配，于是走 `defaults.unknown_action: require_approval`：任务等待批准（rule id `default:require_approval`），保证等级 `app_asserted`，可以从 `cli` 或 `web` 批。请在这个文件上改，不要另写一份。策略文件整份生效；`defaults` 里省略的键回落到引擎值，其中 `approval.channels` 的回落值是空列表，也就是只有 CLI。

上面的例子要加在已有的 `actions:` 键下面：

```yaml
actions:
  # existing entries stay
  tool.mcp__notes__send_note:
    level: write
```

`level` 设成 `send`、`spend` 或 `delete` 会把最低保证抬到 `channel_verified`（[evaluate.ts](../../../packages/core/src/policy/evaluate.ts)）。`examples/claude-agent/policy.yaml` 把 `tool.mcp__ledger__send_note` 声明为 `level: send`，所以那个示例的任务需要 `channel_verified`。审批台上的 Approve 是禁用的，脚本打印的 `actledger approve <id> --dir …` 也会得到 `assurance_insufficient`。要批准，加上 `--assurance channel_verified`（回执标为 simulated），或在审批台写理由拒绝。

## 下一步

- [Claude Agent SDK](../integrations.md#claude-agent-sdk)
- [examples/claude-agent](../../../examples/claude-agent/README.zh-CN.md)
- [审批台](approval-console.md)
