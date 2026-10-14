[English](tool-gate.md) | [简体中文](../zh-CN/tool-gate.md)

# Tool gate

ToolGate is the generic hook for an agent framework that has no ActLedger adapter. The framework calls it once before a tool runs, and once after the tool returns.

## Two hook points

`before(toolName, input)` runs before the tool. It requests a ledger task, applies the policy decision, and claims the task when the decision is allow.

`after(run, outcome)` runs after the tool returns or throws. A result calls `complete`. An error calls `fail`. ToolGate does not call the tool. The framework does.

## Three results

`before` and `resume` return one of three results. Approval outcomes are results, not exceptions. `LedgerError`, `LedgerUnavailable`, and `ContentMismatch` still throw.

| Ledger state | Result | reason |
| --- | --- | --- |
| `approved` | `allow`. The task is claimed. Execute `approvedPayload`, then call `after`. | |
| `pending_approval` | wait: block until the task leaves pending. The local timer returns `deny`. defer and `resume`: `pending` | `timeout` when the wait timer fires. The task stays `pending_approval`. |
| `rejected`, `decision.result` is `deny` | `deny`. Do not run the tool. | `policy_denied` |
| `rejected`, any other decision | `deny` | `rejected` |
| `expired` | `deny` | `expired` |
| `revoked` | `deny` | `revoked` |
| `drafted` | `deny` | `drafted` |
| `prepared`, `executing`, `executed`, `failed`, `unknown` | throws `LedgerError` (`invalid_transition`, 409). This is an idempotency replay, not an approval result. | |
| ledger unavailable, `onUnavailable` is `allow_read_only`, and the call is read-only | `allow` with `run` null and `degraded` true. `after(null, …)` does nothing. `resume` does not take this path. | |

`deny.cause` is the exception `ledger.guard` throws for that same case. `deny.message` is `cause.message`. `deny.state` is the ledger state (`pending_approval` for `timeout`).

`pending` is only returned in defer mode, and by `resume` while the task is still waiting. `approveHint` contains the task id and `actledger approve <id>`. When `Ledger.dir` is set, the hint also has `--dir`. A custom transport has `dir` null, so the hint omits `--dir`. A directory path with spaces is not quoted. Quote it yourself. The command matches the LangGraph hint.

## wait and defer

`wait` blocks inside `before` until the task leaves `pending_approval`, or until `timeoutMs` (default 15 minutes, the same default as `TaskHandle.wait`). A local timeout returns `deny` with reason `timeout`. The ledger task is still `pending_approval`. Call `resume` later.

`defer` returns `pending` as soon as the policy asks for approval. Use it when the framework can suspend and resume, such as a LangGraph interrupt or a job queue.

`pollMs` (default 200) is the wait interval. `guard` passes 20.

## resume

`resume(taskId)` sweeps, reads the task, and returns the same three results. It does not block. Calling it again while the task is pending returns `pending` again.

`approved` claims the task and returns `allow`. A task can be claimed once. A later `resume` of a claimed, executed, or otherwise unexpected task throws `LedgerError` with code `invalid_transition`.

A missing id throws `LedgerError` (`not_found`, 404).

## Without an adapter

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
    # defer mode: hand the task id back to the framework, then call gate.resume(task_id)
    return framework.suspend(task_id=decision.task_id, hint=decision.approve_hint)

if decision.kind == "deny":
    # do not run the tool
    return tool_error(decision.reason, decision.message)
```

Defer, then resume, with the default mapping:

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

Wait mode in Python, also with the default mapping. If policy allows `tool.search`, `before` returns `allow`. If policy requires approval, `before` blocks.

```python
from actledger import Ledger
from actledger.gate import ToolGate

with Ledger(dir=".actledger") as ledger:
    gate = ToolGate(ledger, principal="u_1", mode="wait")
    decision = gate.before("search", {"q": "x"})
    if decision.kind == "allow" and decision.run is not None:
        gate.after(decision.run, result={"hits": 1})
```

Claude Agent SDK mounting is documented in [integrations](integrations.md).

OpenAI Agents SDK mounting uses defer mode. See [integrations](integrations.md#openai-agents-sdk).

## Recorded, not enforced

ToolGate runs inside the agent process. It is recorded integration. Approval and receipts cover calls that go through it. The model can still use a shell, a generic HTTP client, or a browser to go around it. The enforced path is the [MCP proxy](mcp-proxy.md). See [guarantees](guarantees.md).

## guard

`ledger.guard` is a wait-mode tool gate. Behavior is unchanged: a `deny` is thrown as `cause`, and ToolGate itself returns the result. `guard` does not call `fail` when the wrapped function throws. That is the existing behavior. When you call ToolGate directly, call `after(run, { error })` if the tool throws.

## API

Default mapping: action type `tool.<toolName>` (the name is copied as given), payload `{ action, args }`. A non-object input is stored as `args: { input }`. A custom `map` may omit `payload`; the default payload then uses the mapped action type. If `payload.action` does not match the action type, ToolGate overwrites `payload.action` in place.

```ts
const gate = createToolGate({
  ledger,
  principal: "u_1", // or (toolName, input) => string
  agentId: "agent-1", // optional
  mode: "wait", // or "defer"
  timeoutMs: 15 * 60_000, // wait only
  pollMs: 200, // wait only
  map: (toolName, input) => ({ action: `tool.${toolName}` }),
});

const decision = await gate.before(toolName, input);
const receipt = await gate.after(run, { result }); // or { error, code, retryable }
const again = await gate.resume(taskId);
```

`after` on the result path returns the receipt. The error path and a null run return null. The tool's return value is not written unless you pass `record`. `record` is stored with `complete` and is not part of the receipt. A strict mismatch on the result path fails the task and throws `ContentMismatch`.

```python
gate = ToolGate(
    ledger,
    principal="u_1",  # or a (tool_name, input) -> str callback
    mode="wait",  # or "defer"
    agent_id=None,
    timeout=900,  # seconds; None uses 900. wait only
    poll_interval=0.2,  # guard passes 0.02
    map=None,  # (tool_name, input) -> ToolMapping or a snake_case dict
)
decision = gate.before(tool_name, input)
gate.after(run, result=output)  # result=None is a real result
gate.after(run, error=error, code="tool_error", retryable=None)
gate.resume(task_id)

await gate.async_before(tool_name, input)
await gate.async_after(run, result=output)
await gate.async_resume(task_id)
```

`async_before`, `async_after`, and `async_resume` run the sync methods with `asyncio.to_thread`. `principal` and `map` run on that worker thread. In wait mode, `async_before` holds the thread until approval finishes or the timeout fires. Pass `result=` or `error=`. Passing neither raises `TypeError`.
