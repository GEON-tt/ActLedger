[English](../en/integrations.md) | [简体中文](integrations.md)

# 框架集成

把工具闸门挂到 agent 框架上的适配器。它们都是只记录，不强制。见[保证边界](guarantees.md)。

## Claude Agent SDK

`canUseTool` 在工具运行前问账本。`PostToolUse` 把任务标成已执行。`PostToolUseFailure` 把任务标成失败。适配器不挂 `PreToolUse`。`PreToolUse` 返回 allow 会跳过 `canUseTool`，两个钩子一起挂会互相干扰。

工具闸门必须是 wait 模式。defer 模式会抛 `TypeError("claude adapter needs a wait-mode ToolGate")`。适配器不提供 `approve` 或 `reject`。批准走 `actledger approve`、`actledger serve` 或 webhook 链接。

### TypeScript

在本仓库里，这个包通过 workspace 解析。发布之后：

```bash
npm install @actledger/claude-agent-sdk @anthropic-ai/claude-agent-sdk
```

peer 依赖是 `@anthropic-ai/claude-agent-sdk` `^0.3.142`。本仓库用 `0.3.299` 测过。

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeAgentAdapter } from "@actledger/claude-agent-sdk";
import { Ledger, createToolGate } from "@actledger/sdk";

const ledger = new Ledger({ mode: "local", dir: ".actledger" });
const gate = createToolGate({ ledger, principal: "u_1", mode: "wait" });
const adapter = createClaudeAgentAdapter({ gate });

for await (const message of query({
  prompt: "Search the inbox for receipts",
  options: adapter.options({ maxTurns: 3, permissionMode: "default" }),
})) {
  console.log(message);
}
ledger.close();
```

`adapter.options()` 合并进已有的 `Options`。已经设置了 `canUseTool` 或 `permissionPromptToolName` 时抛错。SDK 本身也拒绝这种组合。用户自己的钩子排在适配器钩子前面。

### Python

```bash
pip install "actledger[claude]"
```

extra 是 `claude-agent-sdk>=0.2.166,<0.3`。`import actledger` 不会加载这个模块。用法是 `from actledger.claude_agent import claude_agent_adapter`。

```python
import asyncio
from claude_agent_sdk import ClaudeAgentOptions, query
from actledger import Ledger
from actledger.claude_agent import claude_agent_adapter
from actledger.gate import ToolGate

async def main() -> None:
    with Ledger(dir=".actledger") as ledger:
        gate = ToolGate(ledger, principal="u_1", mode="wait")
        adapter = claude_agent_adapter(gate)
        options = adapter.options(ClaudeAgentOptions(max_turns=3))
        async for message in query(prompt="Search the inbox for receipts", options=options):
            print(message)

asyncio.run(main())
```

权限回调是 async，内部走 `async_before` / `async_after`，不会在事件循环上直接阻塞。`async_before` 仍会在工作线程里等到任务离开 `pending_approval`，或等到工具闸门超时。

### 它做什么

| `gate.before` | SDK 返回 | in-flight 表 |
| --- | --- | --- |
| `allow`，不是降级 | `allow`。`approvedPayload.args` 是普通对象时，`updatedInput` 用它，否则用原来的 input。审批人改过的参数会交给工具。 | 用 `toolUseID` 记下这次 run |
| `allow`，降级（`run` 为 null） | `allow`，`updatedInput` 是原来的 input | 不记 |
| `deny`（`rejected`、`policy_denied`、`drafted`、`expired`、`revoked`、`timeout`） | `deny`。消息里有工具名、reason、任务 id 和闸门的说明。 | — |
| `pending`（wait 模式不会返回这个） | `deny`，消息里带 `approveHint` | — |
| `before()` 抛异常（账本不可用、`invalid_transition` 等） | `deny`。消息是 `ledger error` 加上异常文本。`onError` 的 phase 是 `before`。失败即拒绝。 | — |

| 工具返回之后 | 账本 |
| --- | --- |
| `PostToolUse` | `run.complete`。记下的 executed payload 默认是 `approvedPayload`，和 `guard` 一样。不从 `tool_input` 重算，因为 SDK 可能给内置工具补默认字段，strict 模式会误报 `ContentMismatch`。 |
| `PostToolUse` 且 `tool_response.isError === true` | `run.fail`，code 为 `tool_error`。SDK 用了别的形状时，覆盖 `isToolError`。 |
| `PostToolUseFailure` | `run.fail`。`is_interrupt` 为真时 code 是 `interrupted`，否则是 `tool_error`。 |
| post 钩子的 id 不在表里 | 返回 `{}`，并调用 `onUntracked`。不写账本。 |

自定义 `map` 的载荷如果不是 `{ args: <工具输入> }`，必须自己传 `toolInput`。默认读的是 `approvedPayload.args`。

Claude Agent SDK 的 `canUseTool` 没有等待上限。一次调用等多久，由工具闸门的超时决定（TypeScript 是 `timeoutMs`，默认 15 分钟；Python 是 `timeout`，单位秒）。超时后适配器拒绝，任务仍是 `pending_approval`。

`gate.after` 抛错（包括 `ContentMismatch`）时，设了 `onError` 就调用它，钩子返回 `{}`。没设就把异常重新抛出，让 SDK 把它当成钩子错误。不会悄悄吞掉。

in-flight 表只在内存里。allow 之后、post 钩子之前进程退出，任务留在 `executing`，之后会变成 `unknown`，不会被当成「没执行」再试一次。这和工具闸门本身一样。会话结束、以后也不会有 post 钩子时，调用 `abandon()`。它把表里每个 run 以 code `abandoned` 标成失败。

### 只记录，不强制

这个适配器跑在 agent 进程里，是 `recorded`（记录式）接入。见[保证边界](guarantees.md)。

- 模型可以用 shell、HTTP 客户端或浏览器绕过被记录的工具。
- `canUseTool` 只在 SDK 原本会弹权限提示时才被调用。被 `allowedTools` 整工具放行（例如 `"Read"`、`"Read(*)"`）的调用、`permissionMode: "bypassPermissions"`、`"acceptEdits"` 下的编辑类工具，以及 settings 里的 `permissions.allow` 规则，都会直接执行，不经过账本。两个 SDK 对能看见的遮蔽会发警告：TypeScript 是 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`，Python 是 `CanUseToolShadowedWarning`。
- 账本无法确认工具真的按 `updatedInput` 执行。`complete` 记录的是适配器声明的 executed payload。
- 适配器不提供批准或拒绝。

### TypeScript 和 Python SDK 的差别

只有 TypeScript 处理中止。`options.signal` 是真正的 `AbortSignal`。`before` 完成前如果中止，适配器立刻返回 deny（`aborted`）。`gate.before` 不能取消。它之后如果返回带 run 的 allow，适配器会用 code `aborted` 把这次 run 标成失败，避免任务停在 `executing`。Python SDK 的 `signal` 恒为 `None`。`ToolPermissionContext` 和钩子上下文都写明还不支持中止。

Python 的 `tool_use_id` 类型是可选的。它为 `None` 时，适配器仍会放行或拒绝，但不会把 run 放进 in-flight 表，后面的 post 钩子也就没法收尾。

两个适配器都不从权限回调返回 `null`。TypeScript 0.3.299 允许 `null` 作为带外响应。无意中返回它会让工具一直卡住，而且没有截止时间。

### 钉住的版本

| 包 | 范围 | 核对过的版本 |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | peer `^0.3.142`（`>=0.3.142 <0.4.0`） | `0.3.299` |
| `claude-agent-sdk`（PyPI） | `>=0.2.166,<0.3` | `0.2.166` |
