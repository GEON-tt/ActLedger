[English](https://github.com/GEON-tt/ActLedger/blob/main/packages/openai-agents/README.md) | [简体中文](#简体中文)

# @actledger/openai-agents

Mount a defer-mode ToolGate on the OpenAI Agents SDK. `npm install @actledger/openai-agents @openai/agents zod`

```ts
import { Agent, run } from "@openai/agents";
import { z } from "zod";
import { Ledger, createToolGate } from "@actledger/sdk";
import { createOpenAIAgentsLedger, ledgerTool, resolveInterruptions } from "@actledger/openai-agents";

const ledger = new Ledger({ mode: "local", dir: ".actledger" });
const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
const binding = createOpenAIAgentsLedger({ gate, ledger });
const sendEmail = ledgerTool(
  {
    name: "send_email",
    description: "Send an email",
    parameters: z.object({ to: z.string(), body: z.string() }),
    execute: async ({ to }) => `sent to ${to}`,
  },
  binding,
);
const agent = new Agent({ name: "mailer", tools: [sendEmail] });
let result = await run(agent, "Email bob@example.com that the report is ready");
while (result.interruptions.length > 0) {
  const resolved = await resolveInterruptions(result, binding);
  if (resolved.pending.length > 0) break;
  result = await run(agent, result.state);
}
```

`needsApproval` asks the ledger. A pending task is a native interruption. `resolveInterruptions` reads the ledger and calls the SDK's `state.approve` or `state.reject`. The execute wrapper claims once, immediately before the tool runs. Recorded, not enforced: unwrapped tools and MCP server tools never reach the ledger. Guide: <https://github.com/GEON-tt/ActLedger/blob/main/docs/en/integrations.md#openai-agents-sdk>.

## 简体中文

把 defer 模式的工具闸门挂到 OpenAI Agents SDK。`npm install @actledger/openai-agents @openai/agents zod`

`needsApproval` 问账本。pending 任务变成原生 interruption。`resolveInterruptions` 读账本后调用 SDK 的 `state.approve` 或 `state.reject`。execute 包装在工具运行前 claim 一次。只记录，不强制：没包住的工具和 MCP server 工具不会进账本。说明：<https://github.com/GEON-tt/ActLedger/blob/main/docs/zh-CN/integrations.md#openai-agents-sdk>。
