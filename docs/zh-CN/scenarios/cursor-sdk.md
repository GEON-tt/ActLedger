[English](../../en/scenarios/cursor-sdk.md) | [简体中文](cursor-sdk.md)

# Cursor SDK

## 放在哪里

Cursor SDK 和[你自己的循环](own-loop.md)是同一种**记录式**接入（[保证边界](../guarantees.md)）。它在本地跑一个 agent（demo 里是 `grok-4.7`），并调用你放进 `customTools` 的函数。每个自定义工具的 `execute` 调用自己循环里的 `callTool`，所以闸门在 `execute` 里面阻塞，直到有人做出决定。你没有包住的工具不在账本里。demo 传入 `tools: ["mcp"]` 和 `settingSources: []`，并告诉模型不要用 shell；这句话不是强制。

## 最小代码

取自 [`examples/chat-approval/providers/cursor.ts`](../../../examples/chat-approval/providers/cursor.ts)。`callTool` 是[你自己的循环](own-loop.md)那一页上的函数。需要 `CURSOR_API_KEY`。`@cursor/sdk`（`^1.0.37`）是示例的依赖，不是任何 ActLedger 包的依赖。

```ts
import { Agent, type SDKCustomTool, type SDKJsonValue } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) throw new Error("set CURSOR_API_KEY");

const customTools: Record<string, SDKCustomTool> = {
  send_note: {
    description:
      "Send a note to the team. Blocks until a person approves it in the ActLedger console; only then is the note written.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Note text, at most 2000 characters" } },
      required: ["text"],
      additionalProperties: false,
    } as Record<string, SDKJsonValue>,
    execute: async (args) => {
      const result = await callTool("send_note", args);
      return result.ok ? result.output : { content: [{ type: "text", text: result.output }], isError: true };
    },
  },
};

const agent = await Agent.create({
  apiKey,
  model: { id: "grok-4.7" },
  tools: ["mcp"],
  local: { cwd: process.cwd(), settingSources: [], customTools },
});
try {
  const run = await agent.send("Send a note: standup moved to 3pm");
  for await (const event of run.stream()) {
    if (event.type === "assistant") {
      for (const block of event.message.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
    }
  }
  await run.wait();
} finally {
  await agent[Symbol.asyncDispose]();
}
```

源码里的 `cwd` 是示例目录，`list_notes` 和 `send_note` 都在 `NOTE_TOOL_NAMES` 的循环里生成，并且会在 prompt 前面拼上中文系统指令。

被拒绝或超时时，`execute` 返回 `isError: true` 的文本，模型能看到 reason 和任务 id。

用 `ACTLEDGER_DEMO_PROVIDER=cursor CURSOR_API_KEY=… pnpm demo` 跑 demo。key 也可以写在 `examples/chat-approval/.env`（已被 gitignore，不要提交）。手工检查步骤在[手动验证 → Cursor](../../../examples/chat-approval/README.zh-CN.md#cursor)。CI 不调用 Cursor，只做 typecheck。

## 策略

`actledger init` 会把默认策略写到 `.actledger/policy.yaml`（[源码](../../../packages/core/src/default-policy.ts)）。不改这个文件时，经过闸门的工具调用是 `tool.<name>`，它不在 `actions` 里，没有规则匹配，于是走 `defaults.unknown_action: require_approval`：任务等待批准（rule id `default:require_approval`），保证等级 `app_asserted`，可以从 `cli` 或 `web` 批。请在这个文件上改，不要另写一份。策略文件整份生效；`defaults` 里省略的键回落到引擎值，其中 `approval.channels` 的回落值是空列表，也就是只有 CLI。

把只读工具和写入工具加在文件里已有的 `actions:` 键下面。效果和 demo 一样：`list_notes` 放行，`send_note` 等待批准。

```yaml
actions:
  # existing entries stay
  tool.list_notes:
    level: read   # the default read-allow rule now allows it
  tool.send_note:
    level: write  # no rule matches, so it still waits for approval
```

`level` 设成 `send`、`spend` 或 `delete` 会把最低保证抬到 `channel_verified`（[evaluate.ts](../../../packages/core/src/policy/evaluate.ts)）。审批台无法批准。见[审批台](approval-console.md)。如果确实要高风险级别，又要在审批台批准，就在该动作的规则上写 `approval: { min_assurance: app_asserted }`。这是有意降低门槛，要在规则里写清楚。高风险级别没有 coverage glob 时，加载会告警 `uncovered_high_risk`。

```yaml
coverage:
  # existing entries stay
  - action: tool.*
    mode: recorded
    via: my-agent
```

coverage 只是写在回执上的声明。没有 glob 匹配时，`integrationMode` 仍然记为 `recorded`。

## 下一步

- [你自己的 agent 循环](own-loop.md)
- [examples/chat-approval](../../../examples/chat-approval/README.zh-CN.md)
- [审批台](approval-console.md)
