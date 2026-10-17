[English](cursor-sdk.md) | [简体中文](../../zh-CN/scenarios/cursor-sdk.md)

# Cursor SDK

## Where this fits

Cursor SDK is the same **recorded** integration as [your own loop](own-loop.md) ([guarantees](../guarantees.md)). It runs a local agent (`grok-4.7` in the demo) and calls the functions you pass as `customTools`. Each custom tool's `execute` calls the own-loop `callTool`, so the gate blocks inside `execute` until someone decides. Tools the agent has that you did not wrap are outside the ledger. The demo passes `tools: ["mcp"]` and `settingSources: []` and tells the model not to use a shell; that instruction is not enforcement.

## Minimal code

Taken from [`examples/chat-approval/providers/cursor.ts`](../../../examples/chat-approval/providers/cursor.ts). `callTool` is the function on the [own-loop](own-loop.md) page. You need `CURSOR_API_KEY`. `@cursor/sdk` (`^1.0.37`) is a dependency of the example, not of any ActLedger package.

```ts
import { Agent, type SDKCustomTool, type SDKJsonValue } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) throw new Error("set CURSOR_API_KEY");

const customTools: Record<string, SDKCustomTool> = {
  send_note: {
    description:
      "Send a note to the team. Blocks until a person approves it in the ActLedger console; only then is the note written.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Note text, at most 2000 characters" } },
      required: ["text"],
      additionalProperties: false,
    } as Record<string, SDKJsonValue>,
    execute: async (args) => {
      const result = await callTool("send_note", args);
      return result.ok ? result.output : { content: [{ type: "text", text: result.output }], isError: true };
    },
  },
};

const agent = await Agent.create({
  apiKey,
  model: { id: "grok-4.7" },
  tools: ["mcp"],
  local: { cwd: process.cwd(), settingSources: [], customTools },
});
try {
  const run = await agent.send("Send a note: standup moved to 3pm");
  for await (const event of run.stream()) {
    if (event.type === "assistant") {
      for (const block of event.message.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
    }
  }
  await run.wait();
} finally {
  await agent[Symbol.asyncDispose]();
}
```

In the source, `cwd` is the example directory, `list_notes` and `send_note` are both generated in a loop over `NOTE_TOOL_NAMES`, and a Chinese system instruction is prepended to the prompt.

On deny or timeout, `execute` returns text with `isError: true`, so the model sees the reason and the task id.

Run the demo with `ACTLEDGER_DEMO_PROVIDER=cursor CURSOR_API_KEY=… pnpm demo`. The key can also live in `examples/chat-approval/.env` (gitignored; do not commit it). The hand checks are [Manual checks → Cursor](../../../examples/chat-approval/README.md#cursor). CI does not call Cursor. It only typechecks.

## Policy

`actledger init` writes the default policy to `.actledger/policy.yaml` ([source](../../../packages/core/src/default-policy.ts)). With that file unchanged, a gated tool call is `tool.<name>`, which is not listed under `actions`, so no rule matches and `defaults.unknown_action: require_approval` applies: the task waits for approval (rule id `default:require_approval`), at assurance `app_asserted`, approvable from `cli` or `web`. Edit that file instead of writing a new one. A policy file is used as a whole; keys you leave out of `defaults` fall back to engine values, and the fallback for `approval.channels` is an empty list, which means CLI only.

Add the read and write tools under the file's existing `actions:` key. The effect matches the demo: `list_notes` is allowed and `send_note` waits for approval.

```yaml
actions:
  # existing entries stay
  tool.list_notes:
    level: read   # the default read-allow rule now allows it
  tool.send_note:
    level: write  # no rule matches, so it still waits for approval
```

A `level` of `send`, `spend`, or `delete` raises the minimum assurance to `channel_verified` ([evaluate.ts](../../../packages/core/src/policy/evaluate.ts)). The approval console cannot approve that task. See the [approval console](approval-console.md). To keep a high-risk level and still approve it there, write `approval: { min_assurance: app_asserted }` on that action's rule. That lowers the bar on purpose, so say so in the rule. A high-risk level with no coverage glob warns `uncovered_high_risk` when the policy loads.

```yaml
coverage:
  # existing entries stay
  - action: tool.*
    mode: recorded
    via: my-agent
```

Coverage is a declaration written on the receipt. When no glob matches, `integrationMode` is still recorded.

## Next

- [Your own agent loop](own-loop.md)
- [examples/chat-approval](../../../examples/chat-approval/README.md)
- [Approval console](approval-console.md)
