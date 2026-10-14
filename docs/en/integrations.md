[English](integrations.md) | [简体中文](../zh-CN/integrations.md)

# Integrations

Adapters that mount a ToolGate on an agent framework. All of them are recorded integrations, not enforced. See [guarantees](guarantees.md).

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
