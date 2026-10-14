[English](https://github.com/GEON-tt/ActLedger/blob/main/packages/claude-agent-sdk/README.md) | [简体中文](#简体中文)

# @actledger/claude-agent-sdk

Mount a wait-mode ToolGate on the Claude Agent SDK. `npm install @actledger/claude-agent-sdk @anthropic-ai/claude-agent-sdk`

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeAgentAdapter } from "@actledger/claude-agent-sdk";
import { Ledger, createToolGate } from "@actledger/sdk";

const ledger = new Ledger({ mode: "local", dir: ".actledger" });
const gate = createToolGate({ ledger, principal: "u_1", mode: "wait" });
const adapter = createClaudeAgentAdapter({ gate });
for await (const message of query({
  prompt: "Search the inbox",
  options: adapter.options({ permissionMode: "default" }),
})) {
  console.log(message);
}
```

Recorded, not enforced: tools the SDK auto-allows never reach `canUseTool`. Guide: <https://github.com/GEON-tt/ActLedger/blob/main/docs/en/integrations.md>.

## 简体中文

把 wait 模式的工具闸门挂到 Claude Agent SDK。`npm install @actledger/claude-agent-sdk @anthropic-ai/claude-agent-sdk`

只记录，不强制：SDK 自动放行的工具不会进 `canUseTool`。说明：<https://github.com/GEON-tt/ActLedger/blob/main/docs/zh-CN/integrations.md>。
