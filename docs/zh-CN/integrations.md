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

## OpenAI Agents SDK

`needsApproval` 用 defer 模式向账本发起请求。需要人审批时，变成 SDK 原生 interruption，工具不执行。`resolveInterruptions` 只读账本（`sweep` 和 `getTask`），然后调用 SDK 的 `state.approve` 或 `state.reject`。execute 包装负责 claim，再执行工具，并 complete 或 fail。工具闸门必须是 defer。wait 模式会抛 `TypeError("openai agents adapter needs a defer-mode ToolGate")`。

适配器不提供 `approve` 或 `reject`。批准走 `actledger approve`、`actledger serve` 或 webhook 链接。`state.approve` 是 SDK 让这次 run 继续的 API，不是账本审批。

### TypeScript

在本仓库里，包通过 workspace 解析。发布之后：

```bash
npm install @actledger/openai-agents @openai/agents zod
```

peer 依赖是 `@openai/agents` `^0.20.0`（`>=0.20.0 <0.21.0`）。本仓测试 `0.20.0`。`zod` `^4` 满足 Agents SDK 的 peer。

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
try {
  while (result.interruptions.length > 0) {
    const resolved = await resolveInterruptions(result, binding);
    if (resolved.pending.length > 0) {
      console.log(resolved.pending.map((item) => item.approveHint).join("\n"));
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    result = await run(agent, result.state);
  }
} finally {
  await binding.abandon();
  ledger.close();
}
```

`ledgerTool` 接管 `needsApproval`。选项里再带它会抛 `TypeError`。

### Python

```bash
pip install "actledger[openai-agents]"
```

extra 是 `openai-agents>=0.23.1,<0.24`。本仓测试 `0.23.1`。直接导入 `actledger.openai_agents`。`actledger` 不会加载它。

```python
import asyncio
from agents import Agent, Runner
from actledger import Ledger
from actledger.gate import ToolGate
from actledger.openai_agents import openai_agents_ledger, resolve_interruptions

async def main() -> None:
    with Ledger(dir=".actledger") as ledger:
        gate = ToolGate(ledger, principal="u_1", mode="defer")
        binding = openai_agents_ledger(gate, ledger)

        @binding.function_tool
        async def send_email(to: str, body: str) -> str:
            """Send an email."""
            return f"sent to {to}"

        agent = Agent(name="mailer", tools=[send_email])
        result = await Runner.run(agent, "Email bob@example.com that the report is ready")
        try:
            while result.interruptions:
                resolved = await resolve_interruptions(result, binding)
                if resolved.pending:
                    await asyncio.sleep(2)
                    continue
                result = await Runner.run(agent, resolved.state)
        finally:
            await binding.abandon()

asyncio.run(main())
```

继续运行时用 `resolved.state`。Python 的 `RunResult` 没有一直活着的 state。`to_state()` 每次返回一个新 state。任务还在 pending 时再调一次 `resolve_interruptions` 没有副作用：这条分支不改 SDK state。

`@binding.function_tool` 接管 `needs_approval`。再传它会抛 `TypeError`。

### 它做什么

```text
模型发出 function_call(callId)
  needsApproval
    这个 callId 已经决定过 -> 返回同样的答案，不再开新任务
    gate.before（defer，不阻塞）
      allow，包括策略自动批准 -> 返回 false（before 里已经 claim）
      pending -> 返回 true，不 claim
      deny 或账本错误 -> 返回 true
  返回 true
    本轮 interruption，工具不执行
    resolveInterruptions 只做 sweep + getTask
      approved -> state.approve（SDK）。pending 记录留着，给 execute 用
      仍是 pending -> 不动 SDK interruption
      rejected、expired、revoked、drafted、不存在或其它 -> state.reject(message)
      之前记下的 deny 或账本错误 -> state.reject(message)
    run(agent, state)
      execute 包装调用一次 gate.resume，然后执行工具
  返回 false
    SDK 本轮直接 invoke
    execute 包装用 needsApproval 里已经 claim 的 run
```

需要人审批时，唯一一次 claim 是 execute 包装里、工具运行前的 `gate.resume`。`resolveInterruptions` 不 claim。策略自动批准时，defer 的 `before()` 在 `needsApproval` 里 claim。execute 包装不再 claim。第二次 claim 会抛 `invalid_transition`。

编辑过的参数：`approvedPayload.args` 是普通对象，且按键排序后的 JSON 和 SDK 输入不同，就把这份 args 交给工具。否则用 SDK 已经解析好的输入。记下的 executed payload 默认是 `approvedPayload`，避免 SDK 补了字段之后在 strict 模式下误报 `ContentMismatch`。

`ledgerTool` 在 `parameters` 有 `parse`（Zod）时，会先解析编辑后的 args。解析失败就把任务标成失败，code 为 `invalid_approved_input`，不执行工具。`withLedger` 和 Python 两种入口把编辑后的 args 做成 JSON 字符串，交给 SDK 自己校验。

`ledgerTool` 在 execute 里拒绝时抛 `ActLedgerToolError`。适配器的 error function 把这句话原样返回。其它异常仍变成 SDK 的默认文本 `An error occurred while running the tool. Please try again.`，除非你自己传了 `errorFunction`。`errorFunction: null` 会让异常继续抛出。Python 直接返回拒绝文本。正常拒绝应走 `state.reject`，模型看到的是 `ActLedger did not allow <工具>: <原因> (task <id>).`。

### 包装已有工具

`withLedger` / `with_ledger` 替换 `needsApproval`，并包住 invoke。工具原来的审批策略丢掉，改由 ActLedger 策略决定。原来 `needsApproval: true` 的工具，现在只在账本要求审批时才 interruption。

Agents SDK 在 `invoke` 里接住异常，换成默认错误字符串。包在 `invoke` 外层看不到原来的异常。`withLedger` 把这个默认字符串当成失败。工具自己有 `errorFunction` 时，传入 `isToolError`。`ledgerTool` 和 `@binding.function_tool` 包的是真实函数，抛出的错误会用原来的消息把任务标成失败，code 为 `tool_error`。Python 的同步工具可能在线程里跑。适配器用 contextvar 持有同一个可变对象，线程里的异常仍能标成失败。模型看到的文本仍由 SDK 决定。

`withLedgerAgent` / `with_ledger_agent` 克隆 agent，包住每个 function 工具。hosted、computer、shell、apply_patch 原样保留，并对每个调用 `onUnsupportedTool`。`mcpServers` 提供的工具不在 `agent.tools` 里，不会被包住。

### 只记录，不强制

这个适配器跑在 agent 进程里，是 `recorded`（记录式）接入。见[保证边界](guarantees.md)。

- 模型可以用 shell、HTTP 客户端或浏览器绕过被记录的工具。
- 没有包住的工具不会进账本。MCP server 上的工具属于这一类。
- `alwaysApprove` 会让后续调用跳过 `needsApproval`。execute 包装会补一次 `before()`。如果结果是 pending，工具不执行，拒绝文本里带 `approveHint`，任务留在 `pending_approval`。
- `complete` 记录的是适配器声明的 executed payload。默认是 `approvedPayload`。
- 适配器不提供批准或拒绝。

### 在另一个进程里恢复

pending 和 deny 记录放在 `store` 里。默认是内存 Map。`Run` 不能序列化，所以自动批准的 run 只活在 `needsApproval` 到 invoke 之间的内存里。

要换进程恢复，传入你自己持久化的 `store`，保存 `state.toString()`，再用 `RunState.fromString` 恢复。TypeScript 恢复后会对同一个 callId 再问一次 `needsApproval`。只要这份 store 还在，适配器就返回上次的答案，不会开第二个任务。新进程如果 store 是空的，会把它当成新调用，再开一个任务。旧任务留在账本里。这一轮不提供持久化实现。

Python 在 `RunState.from_string` 之后不会再调 `needs_approval`。适配器仍然按 callId 做幂等。

### 被丢下的 run

策略自动批准时，claim 发生在 `needsApproval` 里。input guardrail、被取消的兄弟调用、abort 或 `maxTurns` 都可能让 SDK 最终不调用 invoke。run 会停在 `executing`。在 `finally` 里调用 `binding.abandon()`。它把每个还拿着的 run 以 code `abandoned` 标成失败。`inFlight` 是这些 run 的数量。

### TypeScript 和 Python SDK 的差别

Python 的 `RunResult` 没有一直活着的 `state`。`resolve_interruptions` 只调用一次 `to_state()`，并把这个 state 放进返回值。之后一直用 `resolved.state`。

`RunState.fromString` 之后，TypeScript 会再问一次 `needsApproval`。`RunState.from_string` 之后，Python 不会。

Python 用 contextvar 记下工具抛出的异常。SDK 可能把同步函数放到线程里跑；`copy_context` 之后仍是同一个 holder。TypeScript 的 `ledgerTool` 包的是 `execute`，直接看到异常。

TypeScript 的 `ledgerTool` 会对编辑后的 args 做 Zod `parameters.parse`。Python 和 `withLedger` 把编辑后的 JSON 字符串交回 SDK。

### 钉住的版本

| 包 | 范围 | 核对过的版本 |
| --- | --- | --- |
| `@openai/agents` | peer `^0.20.0`（`>=0.20.0 <0.21.0`） | `0.20.0` |
| `zod` | dev `^4.0.0`（`@openai/agents` 的 peer） | 与 Claude 包相同的范围 |
| `openai-agents`（PyPI） | `>=0.23.1,<0.24` | `0.23.1` |

0.x 的 minor 视为可能不兼容，所以上界停在下一个 minor 之前。
