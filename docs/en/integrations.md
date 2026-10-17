[English](integrations.md) | [简体中文](../zh-CN/integrations.md)

# Integrations

ActLedger can sit in front of a tool call in four ways. Three of them run inside the agent process and are recorded integrations. The MCP proxy runs outside it and is enforced for the tools it exposes. See [guarantees](guarantees.md).

## Choosing an integration

| Style | Package | Where it hooks | Gate mode | How a pending call waits | Strength |
| --- | --- | --- | --- | --- | --- |
| Generic tool gate | `@actledger/sdk` `createToolGate`, Python `actledger.gate.ToolGate` | Your code calls `before` ahead of the tool and `after` when it returns | `wait` or `defer` | `wait` blocks in `before` until a decision or `timeoutMs`. `defer` returns `pending`; call `resume(taskId)` later | recorded |
| Claude Agent SDK | `@actledger/claude-agent-sdk`, Python `actledger.claude_agent` | `canUseTool`, `PostToolUse`, `PostToolUseFailure` | `wait` only | `canUseTool` blocks until a decision or the gate timeout, then denies | recorded |
| OpenAI Agents SDK | `@actledger/openai-agents`, Python `actledger.openai_agents` | `needsApproval` plus an execute wrapper | `defer` only | The run stops with a native interruption. `resolveInterruptions` reads the ledger, then you call `run` again | recorded |
| MCP proxy | `@actledger/mcp-proxy` | A stdio proxy between the MCP client and the upstream server. Every `tools/call` | not a tool gate | The call returns the pending task. A later `check_task` claims and forwards | enforced for the tools the proxy exposes |

All four use the same ledger, policy, and receipts. Approval happens out of process in every case: `actledger approve`, `actledger serve`, or a signed webhook link. See [approval](approval.md).

### Recorded

The generic gate and both adapters run in the agent process. Calls that go through them follow the state machine and can be approved and verified. The model can still reach the same service with a shell, an HTTP client, or a browser. A tool that is not wrapped, or that the framework allows without asking (Claude `allowedTools`, OpenAI tools from `mcpServers`), never reaches the ledger. Each adapter section below lists its own gaps.

### Enforced

The MCP proxy holds the only connection to the upstream server, so a call to an exposed tool cannot run until the ledger claims it. Exposed tools are declared with coverage `mode: enforced`, `via: mcp-proxy`. A path that does not go through the proxy is still outside the guarantee. Keep network and credentials isolated yourself. See [MCP proxy](mcp-proxy.md).

### Which one

- A framework with no adapter, or your own loop: the generic gate. See [tool gate](tool-gate.md).
- Claude Agent SDK or OpenAI Agents SDK: the matching adapter below.
- Tools that come from an MCP server: start the server through the MCP proxy and point the framework at the proxy command. That also covers MCP tools the OpenAI adapter does not wrap.
- The adapters and the proxy can run together on one ledger directory.

Runnable examples: [webhook receiver](../../examples/webhook-receiver), [Claude Agent SDK](../../examples/claude-agent), [OpenAI Agents SDK](../../examples/openai-agents), [MCP proxy](../../examples/mcp-proxy-email).

Step-by-step pages: [own loop](scenarios/own-loop.md), [Cursor SDK](scenarios/cursor-sdk.md), [Claude Agent SDK](scenarios/claude-agent-sdk.md), [OpenAI Agents SDK](scenarios/openai-agents.md), [MCP server](scenarios/mcp-server.md), [approval console](scenarios/approval-console.md).

## Claude Agent SDK

`canUseTool` asks the ledger before a tool runs. `PostToolUse` completes the task. `PostToolUseFailure` fails it. The adapter does not mount `PreToolUse`. A `PreToolUse` hook that returns allow skips `canUseTool`, so the two hooks would interfere.

The gate must be wait mode. Defer mode throws `TypeError("claude adapter needs a wait-mode ToolGate")`. The adapter does not expose `approve` or `reject`. Approve with `actledger approve`, `actledger serve`, or a webhook link.

### TypeScript

From this repository the package resolves through the workspace. After publication:

```bash
npm install @actledger/claude-agent-sdk @anthropic-ai/claude-agent-sdk
```

Peer dependency: `@anthropic-ai/claude-agent-sdk` `^0.3.142`. This repo tests `0.3.299`.

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

`adapter.options()` merges into an existing `Options` object. It throws if `canUseTool` or `permissionPromptToolName` is already set. The SDK rejects that combination. User hooks stay in front of the adapter hooks.

### Python

```bash
pip install "actledger[claude]"
```

Extra: `claude-agent-sdk>=0.2.166,<0.3`. The module is not imported by `import actledger`. Use `from actledger.claude_agent import claude_agent_adapter`.

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

The permission callback is async and calls `async_before` / `async_after`, so it does not block the event loop on the ledger's own thread. `async_before` still waits on a worker thread until the task leaves `pending_approval` or the gate timeout fires.

### What it does

| `gate.before` | SDK result | In-flight table |
| --- | --- | --- |
| `allow`, not degraded | `allow`. `updatedInput` is `approvedPayload.args` when that value is a plain object, otherwise the original input. An edited approval is what the tool receives. | stores the run under `toolUseID` |
| `allow`, degraded (`run` is null) | `allow`, `updatedInput` is the original input | not stored |
| `deny` (`rejected`, `policy_denied`, `drafted`, `expired`, `revoked`, `timeout`) | `deny`. The message contains the tool name, the reason, the task id, and the gate message. | — |
| `pending` (wait mode does not return this) | `deny`, and the message includes `approveHint` | — |
| `before()` throws (ledger down, `invalid_transition`, …) | `deny`. The message is `ledger error` plus the exception text. `onError` is called with phase `before`. | — |

| After the tool | Ledger |
| --- | --- |
| `PostToolUse` | `run.complete`. The recorded executed payload defaults to `approvedPayload`, same as `guard`. It is not rebuilt from `tool_input`, because the SDK may fill in default fields and strict mode would report `ContentMismatch`. |
| `PostToolUse` and `tool_response.isError === true` | `run.fail` with code `tool_error`. Override `isToolError` if the SDK uses another shape. |
| `PostToolUseFailure` | `run.fail`. Code is `interrupted` when `is_interrupt` is set, otherwise `tool_error`. |
| post hook for an id that was not tracked | returns `{}` and calls `onUntracked`. Nothing is written. |

A custom `map` whose payload is not `{ args: <tool input> }` must pass its own `toolInput`. The default reads `approvedPayload.args`.

`canUseTool` has no park deadline in the Claude Agent SDK. How long a call waits is the tool gate timeout (`timeoutMs` in TypeScript, default 15 minutes; `timeout` in Python, seconds). On timeout the adapter denies and the task stays `pending_approval`.

`gate.after` errors, including `ContentMismatch`, are passed to `onError` when it is set. The hook then returns `{}`. Without `onError` the exception is rethrown so the SDK reports a hook error. It is not swallowed.

The in-flight table is in memory. If the process exits after allow and before the post hook, the task stays `executing` and later becomes `unknown`. It is not retried as "not executed". That is the same rule as ToolGate. Call `abandon()` when a session ends and a post hook will never arrive. It fails each in-flight run with code `abandoned`.

### Recorded, not enforced

This adapter runs inside the agent process. It is a `recorded` integration. See [guarantees](guarantees.md).

- The model can bypass a recorded tool with a shell, an HTTP client, or a browser.
- `canUseTool` runs only when the SDK would have shown a permission prompt. Calls allowed by `allowedTools` (for example `"Read"` or `"Read(*)"`), `permissionMode: "bypassPermissions"`, edit tools under `"acceptEdits"`, and `permissions.allow` rules in settings execute directly and never reach the ledger. Both SDKs warn when they can see that shadowing: TypeScript emits `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`, Python emits `CanUseToolShadowedWarning`.
- The ledger cannot check that the tool actually ran with `updatedInput`. `complete` records the executed payload the adapter declares.
- The adapter does not expose approve or reject.

### Differences between the TypeScript and Python SDKs

Abort handling exists only in TypeScript. `options.signal` is a real `AbortSignal`. If it aborts before `before` finishes, the adapter returns deny immediately (`aborted`). `gate.before` cannot be cancelled. If it later returns an allow with a run, the adapter fails that run with code `aborted` so the task does not stay `executing`. The Python SDK sets `signal` to `None`. `ToolPermissionContext` and the hook context both mark abort support as not implemented.

In Python, `tool_use_id` is typed as optional. When it is `None`, the adapter still allows or denies, and it does not put the run in the in-flight table, so a later post hook cannot complete it.

Neither adapter returns `null` from the permission callback. TypeScript 0.3.299 allows `null` for an out-of-band response. Returning it by accident leaves the tool blocked with no deadline.

### Pinned versions

| Package | Range | Checked |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | peer `^0.3.142` (`>=0.3.142 <0.4.0`) | `0.3.299` |
| `claude-agent-sdk` (PyPI) | `>=0.2.166,<0.3` | `0.2.166` |

## OpenAI Agents SDK

`needsApproval` asks the ledger in defer mode. A task that needs a person becomes a native interruption, and the tool does not run. `resolveInterruptions` reads the ledger (`sweep` and `getTask` only) and then calls the SDK's `state.approve` or `state.reject`. The execute wrapper claims the task, runs the tool, and completes or fails the run. The gate must be defer. Wait mode throws `TypeError("openai agents adapter needs a defer-mode ToolGate")`.

The adapter does not expose `approve` or `reject`. Approve with `actledger approve`, `actledger serve`, or a webhook link. `state.approve` is the SDK call that lets the run continue. It is not a ledger approval.

### TypeScript

From this repository the package resolves through the workspace. After publication:

```bash
npm install @actledger/openai-agents @openai/agents zod
```

Peer dependency: `@openai/agents` `^0.20.0` (`>=0.20.0 <0.21.0`). This repo tests `0.20.0`. `zod` `^4` satisfies the Agents SDK peer.

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

`ledgerTool` owns `needsApproval`. Passing it throws `TypeError`.

### Python

```bash
pip install "actledger[openai-agents]"
```

The extra is `openai-agents>=0.23.1,<0.24`. This repo tests `0.23.1`. Import `actledger.openai_agents` directly. `actledger` does not load it.

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

Continue with `resolved.state`. `RunResult` has no live state object. `to_state()` returns a new state each time. While the task is still pending, calling `resolve_interruptions` again is safe: that branch does not change the SDK state.

`@binding.function_tool` owns `needs_approval`. Passing it throws `TypeError`.

### What it does

```text
model function_call(callId)
  needsApproval
    already decided for this callId -> return the same answer, do not open another task
    gate.before (defer, does not block)
      allow, including policy auto-approve -> return false (before already claimed)
      pending -> return true, no claim
      deny or ledger error -> return true
  return true
    interruption. The tool does not run.
    resolveInterruptions reads sweep + getTask
      approved -> state.approve (SDK). The pending entry stays for execute.
      still pending -> leave the SDK interruption alone
      rejected, expired, revoked, drafted, missing, or other -> state.reject(message)
      deny or ledger error stored earlier -> state.reject(message)
    run(agent, state)
      execute wrapper calls gate.resume once, then the tool
  return false
    the SDK invokes immediately
    execute wrapper uses the run already claimed inside before
```

When a person has to approve, the only claim is `gate.resume` inside the execute wrapper, immediately before the tool runs. `resolveInterruptions` does not claim. When policy auto-approves, defer `before()` claims inside `needsApproval`. The execute wrapper does not claim again. A second claim throws `invalid_transition`.

Edited arguments: if `approvedPayload.args` is a plain object and its sorted JSON differs from the SDK input, the tool receives those args. Otherwise it receives the SDK's parsed input. The recorded executed payload defaults to `approvedPayload`, so strict mode does not report `ContentMismatch` just because the SDK added fields.

`ledgerTool` re-parses edited args with `parameters.parse` when that method exists (Zod). A parse failure fails the task with code `invalid_approved_input` and does not run the tool. `withLedger` and the Python wrappers pass `JSON.stringify` / `json.dumps` of the edited args and let the SDK validate them.

A refusal inside execute throws `ActLedgerToolError` from `ledgerTool`. The adapter's error function returns that message. Other thrown errors still become the SDK's default text, `An error occurred while running the tool. Please try again.`, unless you passed your own `errorFunction`. Set `errorFunction: null` to let the exception propagate. Python returns the refusal string. Normal denials should go through `state.reject`, which sends `ActLedger did not allow <tool>: <reason> (task <id>).` to the model.

### Wrapping existing tools

`withLedger` / `with_ledger` replaces `needsApproval` and wraps invoke. The tool's previous approval policy is discarded. ActLedger's policy decides. A tool that was `needsApproval: true` now interrupts only when the ledger asks for approval.

The Agents SDK catches exceptions inside `invoke` and turns them into the default error string, so a wrapper around `invoke` cannot see the original exception. `withLedger` treats that default string as failure. If the tool has its own `errorFunction`, pass `isToolError`. `ledgerTool` and `@binding.function_tool` wrap the real function, so a thrown error fails the task with the original message and code `tool_error`. Python sync tools run on a worker thread. The adapter keeps a context-local holder so that exception still fails the task. The model still sees the text the SDK chooses.

`withLedgerAgent` / `with_ledger_agent` clones the agent and wraps every function tool. Hosted, computer, shell, and apply-patch tools are left in place. `onUnsupportedTool` is called for each of them. Tools that arrive from `mcpServers` are not in `agent.tools` and are not wrapped.

### Recorded, not enforced

This adapter runs inside the agent process. It is a `recorded` integration. See [guarantees](guarantees.md).

- The model can bypass a recorded tool with a shell, an HTTP client, or a browser.
- A tool that was not wrapped never reaches the ledger. MCP server tools are in that group.
- `alwaysApprove` makes later calls skip `needsApproval`. The execute wrapper then calls `before()`. If that returns pending, the tool does not run, and the refusal text includes `approveHint`. The task stays `pending_approval`.
- `complete` records the executed payload the adapter declares. The default is `approvedPayload`.
- The adapter does not expose approve or reject.

### Resuming in another process

The pending and deny entries live in `store`. The default store is an in-memory map. `Run` objects are not serializable, so auto-approved runs stay in memory only for the gap between `needsApproval` and invoke.

To resume in another process, pass a store you persist, save `state.toString()`, and restore with `RunState.fromString`. TypeScript calls `needsApproval` again for the same call id after restore. The adapter returns the previous answer and does not open a second task, but only if that store is still there. A new process with an empty store treats the call as new and opens another task. The old task stays in the ledger. This release does not ship a persistent store.

Python does not call `needs_approval` again after `RunState.from_string`. The adapter is still idempotent on the call id.

### Abandoned runs

Policy auto-approve claims inside `needsApproval`. An input guardrail, a cancelled sibling, an abort, or `maxTurns` can stop the SDK from calling invoke. The run stays `executing`. Call `binding.abandon()` in `finally`. It fails each held run with code `abandoned`. `inFlight` is the number of those runs.

### Differences between the TypeScript and Python SDKs

Python `RunResult` has no live `state`. `resolve_interruptions` calls `to_state()` once and returns that state. Keep using `resolved.state`.

After `RunState.fromString`, TypeScript asks `needsApproval` again. After `RunState.from_string`, Python does not.

Python records a thrown tool error through a context variable. The SDK may run a sync function on a thread; the holder object is the same one after `copy_context`. TypeScript `ledgerTool` sees the exception directly because it wraps `execute`.

TypeScript `ledgerTool` runs Zod `parameters.parse` on edited args. Python and `withLedger` hand the edited JSON string back to the SDK.

### Pinned versions

| Package | Range | Checked |
| --- | --- | --- |
| `@openai/agents` | peer `^0.20.0` (`>=0.20.0 <0.21.0`) | `0.20.0` |
| `zod` | dev `^4.0.0` (peer of `@openai/agents`) | same range as the Claude package |
| `openai-agents` (PyPI) | `>=0.23.1,<0.24` | `0.23.1` |

A 0.x minor is treated as incompatible, so the range stops before the next minor.
