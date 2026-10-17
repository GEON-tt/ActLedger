[English](openai-agents.md) | [简体中文](../../zh-CN/scenarios/openai-agents.md)

# OpenAI Agents SDK

## Where this fits

`@actledger/openai-agents` is **recorded** integration ([guarantees](../guarantees.md)). It uses a defer-mode ToolGate. `needsApproval` asks the ledger, a pending task becomes a native interruption, `resolveInterruptions` reads the ledger and approves or rejects the interruption in the SDK state, and the wrapped `execute` claims the task right before the tool runs and then completes or fails it. Tools that are not wrapped, and tools that come from `mcpServers`, never reach the ledger.

## Minimal code

Taken from [`examples/chat-approval/providers/openai.ts`](../../../examples/chat-approval/providers/openai.ts) and [`examples/openai-agents/run.ts`](../../../examples/openai-agents/run.ts).

```ts
import { Agent, run, setTracingDisabled } from "@openai/agents";
import { createOpenAIAgentsLedger, ledgerTool, resolveInterruptions } from "@actledger/openai-agents";
import { createToolGate, Ledger } from "@actledger/sdk";
import { z } from "zod";

setTracingDisabled(true);
const ledger = new Ledger({ mode: "local", dir: ".actledger" });
const gate = createToolGate({ ledger, principal: "u_1", mode: "defer" });
const binding = createOpenAIAgentsLedger({ gate, ledger });

const agent = new Agent({
  name: "notes",
  instructions: "You send notes only by calling send_note.",
  tools: [
    ledgerTool(
      {
        name: "send_note",
        description: "Send a note to the team",
        parameters: z.object({ text: z.string() }),
        execute: async ({ text }) => `sent: ${text}`,
      },
      binding,
    ),
  ],
});

try {
  let result = await run(agent, "Send a note: standup moved to 3pm", { maxTurns: 6 });
  const deadline = Date.now() + 15 * 60_000;
  while (result.interruptions.length > 0) {
    const resolved = await resolveInterruptions(result, binding);
    if (resolved.pending.length > 0) {
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    result = await run(agent, result.state, { maxTurns: 6 });
  }
  console.log(result.finalOutput);
} finally {
  await binding.abandon();
  ledger.close();
}
```

The adapter accepts only defer mode. The wait is your loop: the snippet above tries once a second for at most 15 minutes, the same as the demo. `resolved.pending[i].approveHint` contains `actledger approve <id>`.

Omitting `model` uses the SDK's default model. The demo reads the optional `OPENAI_DEFAULT_MODEL`.

Put `binding.abandon()` in `finally`.

`examples/openai-agents` needs `OPENAI_API_KEY`. Without the key, the script prints a skip message and exits 0. The keyless proof is `pnpm exec vitest run packages/openai-agents/test/adapter.test.ts`. The demo uses `ACTLEDGER_DEMO_PROVIDER=openai`.

Wrapping an existing tool (`withLedger` or `withLedgerAgent`), resuming in another process, and the Python adapter are in [integrations](../integrations.md#openai-agents-sdk).

## Policy

`actledger init` writes the default policy to `.actledger/policy.yaml` ([source](../../../packages/core/src/default-policy.ts)). With that file unchanged, a gated tool call is `tool.<name>`, which is not listed under `actions`, so no rule matches and `defaults.unknown_action: require_approval` applies: the task waits for approval (rule id `default:require_approval`), at assurance `app_asserted`, approvable from `cli` or `web`. Edit that file instead of writing a new one. A policy file is used as a whole; keys you leave out of `defaults` fall back to engine values, and the fallback for `approval.channels` is an empty list, which means CLI only.

Add the tool under the existing `actions:` key:

```yaml
actions:
  # existing entries stay
  tool.send_note:
    level: write
```

A `level` of `send`, `spend`, or `delete` raises the minimum assurance to `channel_verified` ([evaluate.ts](../../../packages/core/src/policy/evaluate.ts)). `examples/openai-agents/policy.yaml` declares `tool.send_email` as `level: send`, so that example needs `channel_verified`. Approve on the approval console is disabled. The CLI command needs `--assurance channel_verified` (the receipt is marked simulated), or you reject it in the console with a reason.

## Next

- [OpenAI Agents SDK](../integrations.md#openai-agents-sdk)
- [examples/openai-agents](../../../examples/openai-agents/README.md)
- [Approval console](approval-console.md)
