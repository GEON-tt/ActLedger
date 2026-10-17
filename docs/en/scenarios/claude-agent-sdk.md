[English](claude-agent-sdk.md) | [简体中文](../../zh-CN/scenarios/claude-agent-sdk.md)

# Claude Agent SDK

## Where this fits

`@actledger/claude-agent-sdk` is **recorded** integration ([guarantees](../guarantees.md)). It mounts a wait-mode ToolGate as `canUseTool`, completes the task in `PostToolUse`, and fails it in `PostToolUseFailure`. A tool listed in `allowedTools`, or allowed by `bypassPermissions`, never reaches `canUseTool` and is not in the ledger. The gate must be wait mode; defer throws.

## Minimal code

Taken from [`examples/chat-approval/providers/claude.ts`](../../../examples/chat-approval/providers/claude.ts) and [`examples/claude-agent/run.ts`](../../../examples/claude-agent/run.ts).

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

Leave the gate and `callTool` out of the tool function. The adapter already opens a task in `canUseTool`, and a second call opens a second task.

Without `map`, the action type is `tool.mcp__<server>__<tool>`. The snippet above is `tool.mcp__notes__send_note`. The demo uses `noteMapping` and drops that prefix.

`adapter.options()` merges into the options you already pass. It throws when `canUseTool` or `permissionPromptToolName` is already set.

`adapter.abandon()` fails any run that is still waiting for the post hook, with `abandoned`, so it belongs in `finally`.

`examples/claude-agent` needs `ANTHROPIC_API_KEY`. Without the key, the script prints a skip message and exits 0. The keyless proof is `pnpm exec vitest run packages/claude-agent-sdk/test/adapter.test.ts`. The demo uses `ACTLEDGER_DEMO_PROVIDER=claude` and accepts `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or `ACTLEDGER_DEMO_CLAUDE_LOGIN=1`.

The Python adapter is in [integrations](../integrations.md#claude-agent-sdk).

## Policy

`actledger init` writes the default policy to `.actledger/policy.yaml` ([source](../../../packages/core/src/default-policy.ts)). With that file unchanged, a gated tool call is `tool.<name>`, which is not listed under `actions`, so no rule matches and `defaults.unknown_action: require_approval` applies: the task waits for approval (rule id `default:require_approval`), at assurance `app_asserted`, approvable from `cli` or `web`. Edit that file instead of writing a new one. A policy file is used as a whole; keys you leave out of `defaults` fall back to engine values, and the fallback for `approval.channels` is an empty list, which means CLI only.

For the snippet above, add the tool under the existing `actions:` key:

```yaml
actions:
  # existing entries stay
  tool.mcp__notes__send_note:
    level: write
```

A `level` of `send`, `spend`, or `delete` raises the minimum assurance to `channel_verified` ([evaluate.ts](../../../packages/core/src/policy/evaluate.ts)). `examples/claude-agent/policy.yaml` declares `tool.mcp__ledger__send_note` as `level: send`, so that example's tasks need `channel_verified`. Approve on the approval console is disabled, and the `actledger approve <id> --dir …` command the script prints returns `assurance_insufficient`. To approve, add `--assurance channel_verified` (the receipt is marked simulated), or reject it in the console with a reason.

## Next

- [Claude Agent SDK](../integrations.md#claude-agent-sdk)
- [examples/claude-agent](../../../examples/claude-agent/README.md)
- [Approval console](approval-console.md)
