[English](../en/tool-gate.md) | [简体中文](tool-gate.md)

# 工具闸门

ToolGate 给没有专门适配器的 agent 框架用。框架在调用工具前调一次，工具返回后再调一次。

## 两个挂点

`before(toolName, input)` 在工具执行前。它向账本请求任务，应用策略决定，允许时认领任务。

`after(run, outcome)` 在工具返回或抛错后。有结果就 `complete`，有错误就 `fail`。ToolGate 不调用工具。框架自己调用。

## 三种结果

`before` 和 `resume` 返回三种结果之一。审批层面的结局是结果，不是异常。`LedgerError`、`LedgerUnavailable`、`ContentMismatch` 仍然抛出。

| 账本状态 | 结果 | reason |
| --- | --- | --- |
| `approved` | `allow`。任务已认领。用 `approvedPayload` 执行，然后调 `after`。 | |
| `pending_approval` | wait：阻塞到任务离开 pending。本地计时器到了返回 `deny`。defer 和 `resume`：`pending` | 等待计时器触发时是 `timeout`。账本里的任务仍是 `pending_approval`。 |
| `rejected`，且 `decision.result` 为 `deny` | `deny`。不要执行工具。 | `policy_denied` |
| `rejected`，其它决定 | `deny` | `rejected` |
| `expired` | `deny` | `expired` |
| `revoked` | `deny` | `revoked` |
| `drafted` | `deny` | `drafted` |
| `prepared`、`executing`、`executed`、`failed`、`unknown` | 抛 `LedgerError`（`invalid_transition`，409）。这是幂等重放，不是审批结论。 | |
| 账本不可用，`onUnavailable` 为 `allow_read_only`，且这次调用是只读 | `allow`，`run` 为 null，`degraded` 为 true。`after(null, …)` 什么都不写。`resume` 不走这条路径。 | |

`deny.cause` 是 `ledger.guard` 在同一情形会抛的那个异常。`deny.message` 等于 `cause.message`。`deny.state` 是账本状态（`timeout` 时为 `pending_approval`）。

`pending` 只在 defer 模式出现，任务仍在等待时 `resume` 也会返回它。`approveHint` 里有任务 id 和 `actledger approve <id>`。`Ledger.dir` 有值时还会带 `--dir`。任务的 `decision.minAssurance` 高于 `app_asserted` 时，批准命令末尾带 `--assurance <minAssurance>`；`decision.stepUp` 有值时还带 `--step-up`；CLI 会把这两种都标为 simulated。拒绝命令带 `--note "<reason>"`，因为 `actledger reject` 必须写理由。`approveCommandLine(taskId, dir, decision)` 只返回批准命令。自定义 transport 的 `dir` 是 null，hint 就不带 `--dir`。目录路径含空格时不加引号。需要的话自己加引号。命令形式与 LangGraph 的 hint 相同。

## wait 与 defer

`wait` 在 `before` 里阻塞，直到任务离开 `pending_approval`，或到达 `timeoutMs`（默认 15 分钟，与 `TaskHandle.wait` 相同）。本地超时返回 reason 为 `timeout` 的 `deny`。账本里的任务仍是 `pending_approval`。之后可以 `resume`。

`defer` 在策略要求审批时立刻返回 `pending`。框架自己能中断和恢复时用它，例如 LangGraph interrupt 或作业队列。

`pollMs`（默认 200）是 wait 的轮询间隔。`guard` 传入 20。

## 恢复

`resume(taskId)` 先 sweep，再读任务，返回同样的三种结果。它不阻塞。任务仍是 pending 时再调一次，还是 `pending`。

`approved` 会认领任务并返回 `allow`。同一个任务只能认领一次。之后对已认领、已执行或其它非预期状态再 `resume`，会抛 `LedgerError`，code 为 `invalid_transition`。

找不到 id 时抛 `LedgerError`（`not_found`，404）。

## 没有适配器时

```text
decision = gate.before(tool_name, input)

if decision.kind == "allow":
    try:
        output = run_tool(tool_name, decision.approved_payload.args)
    except error:
        gate.after(decision.run, error=error)
        raise
    gate.after(decision.run, result=output)
    return output

if decision.kind == "pending":
    # defer 模式：把 task id 交还给框架，等审批后再调用 gate.resume(task_id)
    return framework.suspend(task_id=decision.task_id, hint=decision.approve_hint)

if decision.kind == "deny":
    # 不执行工具
    return tool_error(decision.reason, decision.message)
```

defer 然后 resume，使用默认映射：

```ts
import { createToolGate, Ledger } from "@actledger/sdk";

const ledger = new Ledger({ mode: "local", dir: ".actledger" });
const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });

const decision = await gate.before("send_email", { to: "a@b.c", subject: "hi" });
if (decision.kind === "pending") {
  console.log(decision.approveHint);
  const again = await gate.resume(decision.taskId);
  if (again.kind === "allow" && again.run) {
    await gate.after(again.run, { result: { delivered: true } });
  }
}
ledger.close();
```

Python 的 wait 模式，同样使用默认映射。策略允许 `tool.search` 时，`before` 返回 `allow`。策略要求审批时，`before` 会阻塞。

```python
from actledger import Ledger
from actledger.gate import ToolGate

with Ledger(dir=".actledger") as ledger:
    gate = ToolGate(ledger, principal="u_1", mode="wait")
    decision = gate.before("search", {"q": "x"})
    if decision.kind == "allow" and decision.run is not None:
        gate.after(decision.run, result={"hits": 1})
```

Claude Agent SDK 的挂载方式见[框架集成](integrations.md)。

OpenAI Agents SDK 的挂载使用 defer 模式。见[框架集成](integrations.md#openai-agents-sdk)。

## 只记录，不强制

ToolGate 跑在 agent 进程里，是 recorded 接入。审批和回执覆盖经过它的调用。模型仍可能用 shell、通用 HTTP 客户端或浏览器绕过。强制路径是 [MCP 代理](mcp-proxy.md)。见[保证边界](guarantees.md)。

## guard

`ledger.guard` 建立在 wait 模式的 ToolGate 上。行为不变：遇到 `deny` 会抛 `cause`，ToolGate 自己返回结果、不抛这个异常。包住的函数抛错时，`guard` 不调用 `fail`。这是原有行为。直接使用 ToolGate 时，工具抛错应调用 `after(run, error=...)`。

## 接口速查

默认映射：动作类型 `tool.<toolName>`（名字原样拼接），载荷 `{ action, args }`。input 不是普通对象时，记成 `args: { input }`。自定义 `map` 可以省略 `payload`，这时默认载荷使用映射后的动作类型。`payload.action` 和动作类型不一致时，ToolGate 会原地改写 `payload.action`。

```ts
const gate = createToolGate({
  ledger,
  principal: "u_1", // 或 (toolName, input) => string
  agentId: "agent-1", // 可选
  mode: "wait", // 或 "defer"
  timeoutMs: 15 * 60_000, // 仅 wait
  pollMs: 200, // 仅 wait
  map: (toolName, input) => ({ action: `tool.${toolName}` }),
});

const decision = await gate.before(toolName, input);
const receipt = await gate.after(run, { result }); // 或 { error, code, retryable }
const again = await gate.resume(taskId);
```

`after` 在结果路径返回回执。错误路径和 run 为 null 时返回 null。工具的原始返回值不会写入账本，除非传入 `record`。`record` 随 `complete` 存下，不进回执。结果路径上的 strict 比对失败会先让任务失败，再抛 `ContentMismatch`。

```python
gate = ToolGate(
    ledger,
    principal="u_1",  # 或 (tool_name, input) -> str
    mode="wait",  # 或 "defer"
    agent_id=None,
    timeout=900,  # 秒；None 则用 900。仅 wait
    poll_interval=0.2,  # guard 传入 0.02
    map=None,  # (tool_name, input) -> ToolMapping 或 snake_case dict
)
decision = gate.before(tool_name, input)
gate.after(run, result=output)  # result=None 是合法结果
gate.after(run, error=error, code="tool_error", retryable=None)
gate.resume(task_id)

await gate.async_before(tool_name, input)
await gate.async_after(run, result=output)
await gate.async_resume(task_id)
```

`async_before`、`async_after`、`async_resume` 用 `asyncio.to_thread` 跑同步方法。`principal` 和 `map` 在那个工作线程里执行。wait 模式下，`async_before` 会占住该线程，直到审批结束或超时。必须传 `result=` 或 `error=`。两个都不传会抛 `TypeError`。
